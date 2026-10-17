/**
 * Authenticated remote project attach (commands/high-family/remote-project-attach.ts,
 * assistant/remote-project-checkout.ts): the cloud bridge is reachable from the
 * boot config through the router, the setup verbs are source-scoped (never mesh),
 * local-only projects are refused before the bridge, and the target checkout is
 * path-validated, idempotent on retry and truthful about failures — with no child
 * stderr (which may carry helper credentials) ever leaving the process.
 */
import { createHash, createHmac } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
    configDir: '',
    meshes: [] as any[],
    hostRecords: {} as Record<string, { hostDaemonId: string }>,
    git: (_args: string[], _cwd: string): { stdout?: string; error?: any; defer?: Promise<void> } => ({ stdout: '' }),
    python: true,
    gitCalls: [] as { args: string[]; cwd: string; targetDir?: string; timeout?: number; windowsHide?: boolean; fullArgs?: string[] }[],
    pythonCalls: [] as { cmd: string; args: string[]; opts: any }[],
    taskkillCalls: [] as { args: string[]; opts: any }[],
    pins: [] as any[],
    allowedHosts: [] as string[],
    machineSecret: null as string | null,
    renameFailures: 0,
    pinFail: false,
    writeHostRecordFail: false,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
    const real = await importOriginal<typeof import('node:fs/promises')>();
    return {
        ...real,
        rename: async (oldPath: any, newPath: any) => {
            if (state.renameFailures > 0) {
                state.renameFailures--;
                throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
            }
            return real.rename(oldPath, newPath);
        },
    };
});

vi.mock('node:child_process', async (importOriginal) => {
    const real = await importOriginal<typeof import('node:child_process')>();
    return {
        ...real,
        execFile: (cmd: string, args: string[], opts: any, cb: (e: any, out?: any) => void) => {
            if (cmd === 'taskkill') {
                state.taskkillCalls.push({ args, opts });
                cb?.(null, { stdout: '', stderr: '' });
                return { pid: 9999 } as any;
            }
            if (cmd === 'git') {
                const cIdx = args.indexOf('-C');
                const targetDir = cIdx !== -1 ? args[cIdx + 1] : opts?.cwd;
                const gitArgs = cIdx !== -1 ? args.slice(cIdx + 2) : args.slice(6);
                state.gitCalls.push({ args: gitArgs, cwd: opts?.cwd, targetDir, timeout: opts?.timeout, windowsHide: opts?.windowsHide, fullArgs: args });
                const r = state.git(gitArgs, targetDir);
                const reply = () => (r.error ? cb(r.error) : cb(null, { stdout: r.stdout ?? '', stderr: '' }));
                if (r.defer) void r.defer.then(reply);
                else queueMicrotask(reply);
                return { pid: 4242, kill: () => {}, stdout: { on: () => {} }, stderr: { on: () => {} } } as any;
            }
            state.pythonCalls.push({ cmd, args, opts });
            if (state.python) cb(null, { stdout: 'gitpython-ready\n', stderr: '' });
            else cb(Object.assign(new Error('missing'), { code: 1 }));
            return { pid: 4243 } as any;
        },
    };
});
vi.mock('../../src/config/config.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../src/config/config.js')>();
    return {
        ...actual,
        getConfigDir: () => state.configDir,
        loadConfig: () => ({
            ...actual.loadConfig(),
            allowedRemoteProjectHosts: state.allowedHosts,
            machineSecret: state.machineSecret,
        }),
    };
});
vi.mock('../../src/config/mesh-config.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../src/config/mesh-config.js')>()),
    getMesh: (id: string) => state.meshes.find(m => m.id === id),
}));
vi.mock('../../src/config/mesh-config-host-pairing.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../src/config/mesh-config-host-pairing.js')>()),
    setMeshHostPin: (id: string, opts: { hostDaemonId: string; hostNodeId: string }) => {
        if (state.pinFail) return undefined;
        const mesh = state.meshes.find(m => m.id === id);
        if (!mesh) return undefined;
        state.pins.push({ id, ...opts });
        mesh.meshHost = { role: 'host', hostDaemonId: opts.hostDaemonId, hostNodeId: opts.hostNodeId };
        return { mesh, meshHost: mesh.meshHost, applied: true, reason: 'pinned' };
    },
}));
vi.mock('../../src/mesh/mesh-host-memory.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../src/mesh/mesh-host-memory.js')>()),
    readMeshHostRecord: (id: string) => state.hostRecords[id] ?? null,
    writeMeshHostRecord: (id: string, host: string) => {
        if (state.writeHostRecordFail) return false;
        state.hostRecords[id] = { hostDaemonId: host };
        return true;
    },
}));

import { DaemonCommandRouter, getDaemonCommandRegistry } from '../../src/commands/router.js';
import { bootCommandPlane } from '../../src/boot/stages/command-plane.js';
import { remoteProjectHandlers } from '../../src/commands/high-family/remote-project-attach.js';
import { checkoutRemote, githubRemote, managedCheckoutPath } from '../../src/assistant/remote-project-checkout.js';

const SOURCE = 'daemon_mach_source1';
const TARGET = 'daemon_mach_target1';
const REPO = 'github.com/vilmire/batrp';
const URL = `https://${REPO}.git`;
const SECRET_STDERR = 'fatal: Authentication failed for https://ghp_SECRETTOKEN@github.com/vilmire/batrp.git';

function hostMesh(overrides: Record<string, unknown> = {}) {
    return {
        id: 'mesh_batrp', name: 'BATRP', repoIdentity: REPO, repoRemoteUrl: URL,
        nodes: [{ id: 'n1', daemonId: SOURCE, workspace: '/w/batrp' }],
        ...overrides,
    };
}

function routerWith(statusInstanceId: string, bridge?: (meshId: string, targetDaemonId: string) => Promise<any>) {
    const deps: any = {
        commandHandler: {}, cliManager: { adapters: new Map() }, cdpManagers: new Map(),
        providerLoader: { getAll: () => [], resolve: () => null }, instanceManager: {}, detectedIdes: { value: [] },
        sessionRegistry: {}, statusInstanceId, attachRemoteProject: bridge,
    };
    return new DaemonCommandRouter(deps);
}

const ctxFor = (statusInstanceId: string, extra: Record<string, unknown> = {}) => ({ deps: { statusInstanceId, ...extra } } as any);

/** Git that behaves like a reachable private repo whose clone creates the directory. */
function workingGit() {
    state.git = (args, cwd) => {
        if (args[0] === 'ls-remote') return { stdout: 'abc\tHEAD' };
        if (args[0] === 'clone') { mkdirSync(args[args.length - 1], { recursive: true }); return { stdout: '' }; }
        if (args[0] === 'rev-parse') return { stdout: cwd };
        if (args[0] === 'remote') return { stdout: URL };
        return { stdout: '' };
    };
}

beforeEach(() => {
    state.configDir = mkdtempSync(join(tmpdir(), 'adhdev-remote-attach-'));
    state.meshes = [hostMesh()];
    state.hostRecords = {};
    state.python = true;
    state.gitCalls = [];
    state.pins = [];
    state.allowedHosts = [SOURCE];
    state.machineSecret = null;
    state.pinFail = false;
    state.writeHostRecordFail = false;
    workingGit();
});
afterEach(() => {
    rmSync(state.configDir, { recursive: true, force: true });
});

describe('wiring: boot config → router deps → command', () => {
    it('bootCommandPlane hands cfg.mesh.attachRemoteProject to the router (was dead under mesh:)', async () => {
        const bridge = vi.fn(async () => ({ success: true, attached: true }));
        const s4: any = {
            cfg: { statusInstanceId: SOURCE, sessionHost: {}, mesh: { attachRemoteProject: bridge } },
            providerLoader: { getAll: () => [], resolve: () => null }, seqscribe: null, bus: { emit: () => {}, on: () => () => {} },
            cdpManagers: new Map(), cliManager: { adapters: new Map(), input: {} }, instanceManager: {}, sessionRegistry: {},
            detectedIdes: { value: [] }, poller: { start: () => {} }, emitFacts: () => {}, refreshProviderAvailability: async () => {},
            agentStreamManager: null, cdpSetupContext: {},
        };
        const { router } = bootCommandPlane(s4);
        const r: any = await router.execute('attach_remote_project', { meshId: 'mesh_batrp', targetDaemonId: TARGET }, 'ipc');
        expect(bridge).toHaveBeenCalledWith('mesh_batrp', TARGET);
        expect(r).toMatchObject({ success: true, attached: true });
    });

    it('standalone (no bridge) refuses truthfully after validating the project', async () => {
        const r: any = await routerWith(SOURCE).execute('attach_remote_project', { meshId: 'mesh_batrp', targetDaemonId: TARGET }, 'ipc');
        expect(r).toMatchObject({ success: false, code: 'CAPABILITY_NOT_AVAILABLE', stage: 'authentication', attached: false });
    });

    it('setup verbs are source-scoped: owner surfaces for the entry, dedicated project_attach for the steps, never api or mesh', async () => {
        const registry = getDaemonCommandRegistry();
        expect(registry.get('attach_remote_project')?.sources).toEqual(['ipc', 'standalone']);
        for (const step of ['remote_project_prepare', 'remote_project_checkout', 'remote_project_register', 'remote_project_accept']) {
            expect(registry.get(step)?.sources).toEqual(['project_attach']);
        }
        expect(registry.get('assistant_project_attach_remote')?.sources).not.toContain('mesh');
        const bridge = vi.fn();
        const router = routerWith(SOURCE, bridge as any);
        const viaMesh: any = await router.execute('attach_remote_project', { meshId: 'mesh_batrp', targetDaemonId: TARGET }, 'mesh');
        const stepViaIpc: any = await router.execute('remote_project_checkout', { meshId: 'mesh_batrp', targetDaemonId: SOURCE, identity: REPO, url: URL }, 'ipc');
        const stepViaApi: any = await router.execute('remote_project_checkout', { meshId: 'mesh_batrp', targetDaemonId: SOURCE, identity: REPO, url: URL }, 'api');
        expect(viaMesh.success).toBe(false);
        expect(stepViaIpc.success).toBe(false);
        expect(stepViaApi.success).toBe(false);
        expect(bridge).not.toHaveBeenCalled();
        expect(state.gitCalls.some(c => c.args[0] === 'clone')).toBe(false);
    });
});

describe('attach_remote_project (source host)', () => {
    const attach = (args: any, extra: Record<string, unknown> = {}) => remoteProjectHandlers.attach_remote_project(ctxFor(SOURCE, extra), args);

    it('rejects a non-canonical target before anything else', async () => {
        const bridge = vi.fn();
        for (const targetDaemonId of ['MainPC', 'mach_target1', 'daemon_mach_x/../y', '', undefined]) {
            expect(await attach({ meshId: 'mesh_batrp', targetDaemonId }, { attachRemoteProject: bridge })).toMatchObject({ success: false, code: 'INVALID_TARGET' });
        }
        expect(bridge).not.toHaveBeenCalled();
    });

    it('refuses a local-only project — cross-machine attach of local-only stays prohibited', async () => {
        state.meshes = [hostMesh({ repoIdentity: 'local:batrp', repoRemoteUrl: undefined })];
        const bridge = vi.fn();
        expect(await attach({ meshId: 'mesh_batrp', targetDaemonId: TARGET }, { attachRemoteProject: bridge })).toMatchObject({ success: false, code: 'LOCAL_ONLY_PROJECT', stage: 'registration' });
        state.meshes = [hostMesh({ repoRemoteUrl: '/Users/me/batrp' })];
        expect(await attach({ meshId: 'mesh_batrp', targetDaemonId: TARGET }, { attachRemoteProject: bridge })).toMatchObject({ code: 'LOCAL_ONLY_PROJECT' });
        expect(bridge).not.toHaveBeenCalled();
    });

    it('refuses when this daemon is not the project host, or the source origin disagrees', async () => {
        const bridge = vi.fn();
        state.meshes = [hostMesh({ meshHost: { role: 'member', hostDaemonId: 'daemon_mach_other1' } })];
        expect(await attach({ meshId: 'mesh_batrp', targetDaemonId: TARGET }, { attachRemoteProject: bridge })).toMatchObject({ code: 'PROJECT_HOST_REQUIRED' });
        state.meshes = [hostMesh()];
        state.git = () => ({ stdout: 'https://github.com/someone/else.git' });
        expect(await attach({ meshId: 'mesh_batrp', targetDaemonId: TARGET }, { attachRemoteProject: bridge })).toMatchObject({ code: 'REMOTE_IDENTITY_MISMATCH' });
        expect(await attach({ meshId: 'mesh_missing', targetDaemonId: TARGET }, { attachRemoteProject: bridge })).toMatchObject({ code: 'PROJECT_NOT_FOUND' });
        expect(bridge).not.toHaveBeenCalled();
    });
});

describe('remote_project_checkout (target)', () => {
    const checkout = (args: any, self = TARGET) => remoteProjectHandlers.remote_project_checkout(ctxFor(self), { meshId: 'mesh_batrp', targetDaemonId: TARGET, hostDaemonId: SOURCE, identity: REPO, url: URL, ...args });

    it('only the exact selected daemon checks out', async () => {
        expect(await checkout({}, 'daemon_mach_wrong1')).toMatchObject({ success: false, code: 'WRONG_MACHINE', stage: 'target_access' });
        expect(state.gitCalls).toHaveLength(0);
    });

    it('refuses non-GitHub or credential-bearing URLs and identity mismatch', async () => {
        for (const url of ['https://ghp_x@github.com/vilmire/batrp.git', 'file:///etc/passwd', 'https://evil.example/vilmire/batrp.git', 'ext::sh -c id', 'https://github.com/vilmire/../batrp']) {
            expect(await checkout({ url })).toMatchObject({ success: false, code: 'REMOTE_IDENTITY_MISMATCH' });
        }
        expect(await checkout({ identity: 'github.com/vilmire/other' })).toMatchObject({ code: 'REMOTE_IDENTITY_MISMATCH' });
        expect(await checkout({ meshId: '../mesh' })).toMatchObject({ code: 'REMOTE_IDENTITY_MISMATCH' });
        expect(state.gitCalls).toHaveLength(0);
    });

    it('never spawns git with cwd inside the untrusted clone (uses cwd=configDir + git -C) and gives python preflight a neutral cwd', async () => {
        state.pythonCalls = [];
        const first: any = await checkout({});
        expect(first.success).toBe(true);
        expect(state.gitCalls.length).toBeGreaterThan(0);
        for (const call of state.gitCalls) {
            expect(call.cwd).toBe(state.configDir);
            expect(call.fullArgs?.slice(6, 8)).toEqual(['-C', call.targetDir]);
        }
        const args = { meshId: 'mesh_batrp', targetDaemonId: TARGET, identity: REPO, url: URL, hostDaemonId: SOURCE, workspace: first.workspace };
        const accepted: any = await remoteProjectHandlers.remote_project_accept(ctxFor(TARGET), args);
        expect(accepted.success).toBe(true);
        expect(state.pythonCalls.length).toBeGreaterThan(0);
        for (const py of state.pythonCalls) {
            expect(py.opts?.cwd).toBe(state.configDir);
            expect(py.opts?.windowsHide).toBe(true);
        }
    });

    it('clones into the managed path, then reuses it on retry without fetch/reset', async () => {
        const first: any = await checkout({});
        expect(first).toMatchObject({ success: true, reused: false, stage: 'checkout', attached: false, targetDaemonId: TARGET });
        expect(first.workspace).toBe(await managedCheckoutPath('mesh_batrp', REPO));
        expect(first.workspace.startsWith(join(realpathSync(state.configDir), 'remote-projects'))).toBe(true);
        state.gitCalls = [];
        const again: any = await checkout({});
        expect(again).toMatchObject({ success: true, reused: true, workspace: first.workspace });
        expect(state.gitCalls.map(c => c.args[0])).not.toContain('clone');
        expect(state.gitCalls.some(c => ['fetch', 'reset', 'checkout', 'pull', 'clean'].includes(c.args[0]))).toBe(false);
    });

    it('auth failure is classified without leaking stderr, and leaves no partial checkout', async () => {
        state.git = (args) => args[0] === 'ls-remote'
            ? { error: Object.assign(new Error(SECRET_STDERR), { code: 128, stderr: SECRET_STDERR }) }
            : { stdout: '' };
        const r: any = await checkout({});
        expect(r).toMatchObject({ success: false, code: 'GIT_AUTH_REQUIRED', stage: 'repository_access', attached: false });
        expect(JSON.stringify(r)).not.toMatch(/ghp_|SECRETTOKEN|Authentication failed/);
    });

    it('a git timeout is reported as GIT_TIMEOUT and a failed clone is removed so a retry is idempotent', async () => {
        const workspace = await managedCheckoutPath('mesh_batrp', REPO);
        state.git = (args) => {
            if (args[0] === 'ls-remote') return { stdout: 'abc\tHEAD' };
            if (args[0] === 'clone') { mkdirSync(args[args.length - 1], { recursive: true }); return { error: Object.assign(new Error('killed'), { killed: true, signal: 'SIGTERM' }) }; }
            return { stdout: '' };
        };
        expect(await checkout({})).toMatchObject({ success: false, code: 'GIT_TIMEOUT', stage: 'repository_access' });
        expect(existsSync(`${workspace}.pending`)).toBe(false);
        expect(existsSync(workspace)).toBe(false);
        workingGit();
        expect(await checkout({})).toMatchObject({ success: true, reused: false, workspace });
    });

    it('gives clone a 15-20 min timeout with watchdog while keeping 120s for other git calls, kills the process tree on win32, and reports ENOBUFS truthfully', async () => {
        expect(await checkout({})).toMatchObject({ success: true, reused: false });
        const lsRemoteCall = state.gitCalls.find(c => c.args[0] === 'ls-remote')!;
        const cloneCall = state.gitCalls.find(c => c.args[0] === 'clone')!;
        expect(lsRemoteCall.timeout).toBe(120_000);
        expect(cloneCall.timeout).toBeGreaterThanOrEqual(15 * 60_000);
        expect(cloneCall.timeout).toBeLessThanOrEqual(20 * 60_000);

        // ENOBUFS sets killed: true when maxBuffer overflows; must be reported as ENOBUFS, not GIT_TIMEOUT
        state.git = () => ({ error: Object.assign(new Error('maxBuffer exceeded'), { code: 'ENOBUFS', killed: true, signal: 'SIGTERM' }) });
        expect(await checkout({})).toMatchObject({ success: false, code: 'ENOBUFS', stage: 'repository_access' });

        // On win32, a timed-out git process kills the process tree via taskkill /PID <pid> /T /F with windowsHide: true
        state.taskkillCalls = [];
        const origPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
        Object.defineProperty(process, 'platform', { value: 'win32' });
        try {
            state.git = () => ({ error: Object.assign(new Error('timed out'), { killed: true, signal: 'SIGTERM' }) });
            expect(await checkout({})).toMatchObject({ success: false, code: 'GIT_TIMEOUT' });
            expect(state.taskkillCalls).toEqual([
                { args: ['/PID', '4242', '/T', '/F'], opts: expect.objectContaining({ shell: false, windowsHide: true }) },
            ]);
        } finally {
            Object.defineProperty(process, 'platform', origPlatform);
        }
    });

    it('an incomplete crash-left .pending directory is preserved and reported, while a verified crash-left .pending is adopted', async () => {
        const workspace = await managedCheckoutPath('mesh_batrp', REPO);
        mkdirSync(`${workspace}.pending`);
        // Incomplete .pending (fails rev-parse / verifyCheckout): preserved, not deleted or overwritten
        state.git = (args) => {
            if (args[0] === 'ls-remote') return { stdout: 'abc\tHEAD' };
            if (args[0] === 'rev-parse') return { error: Object.assign(new Error('not a git repo'), { code: 128 }) };
            return { stdout: '' };
        };
        expect(await checkout({})).toMatchObject({ success: false, code: 'CHECKOUT_RECOVERY_REQUIRED', stage: 'checkout' });
        expect(existsSync(`${workspace}.pending`)).toBe(true);

        // Verified crash-left .pending (passes verifyCheckout): adopted without re-cloning
        workingGit();
        state.gitCalls = [];
        const adopted: any = await checkout({});
        expect(adopted).toMatchObject({ success: true, reused: true, workspace });
        expect(existsSync(`${workspace}.pending`)).toBe(false);
        expect(existsSync(workspace)).toBe(true);
        expect(state.gitCalls.map(c => c.args[0])).not.toContain('clone');
    });

    it('uses a cross-process pid lockfile and retries rename on transient win32 EBUSY/EPERM', async () => {
        const workspace = await managedCheckoutPath('mesh_batrp', REPO);
        // Live PID lockfile from another process blocks checkout with ATTACH_IN_PROGRESS
        writeFileSync(`${workspace}.lock`, JSON.stringify({ pid: process.pid }));
        expect(await checkout({})).toMatchObject({ success: false, code: 'ATTACH_IN_PROGRESS', stage: 'checkout' });
        expect(state.gitCalls).toHaveLength(0);

        // Stale dead-PID lockfile is reclaimed, and transient EBUSY on rename retries 5x200ms and succeeds
        writeFileSync(`${workspace}.lock`, JSON.stringify({ pid: 99999999 }));
        state.renameFailures = 2;
        expect(await checkout({})).toMatchObject({ success: true, reused: false, workspace });
        expect(state.renameFailures).toBe(0);
        expect(existsSync(`${workspace}.lock`)).toBe(false);
    });

    it('an existing checkout with a different origin is preserved and refused', async () => {
        const workspace = await managedCheckoutPath('mesh_batrp', REPO);
        mkdirSync(workspace);
        state.git = (args, cwd) => args[0] === 'rev-parse' ? { stdout: cwd } : args[0] === 'remote' ? { stdout: 'https://github.com/someone/fork.git' } : { stdout: 'abc\tHEAD' };
        expect(await checkout({})).toMatchObject({ success: false, code: 'REMOTE_IDENTITY_MISMATCH', stage: 'checkout' });
        expect(existsSync(workspace)).toBe(true);
    });

    it('a concurrent attempt for the same checkout answers ATTACH_IN_PROGRESS, then a retry reuses it', async () => {
        let release!: () => void;
        const gate = new Promise<void>(r => { release = r; });
        const working = state.git;
        state.git = (args, cwd) => (args[0] === 'ls-remote' ? { stdout: 'abc\tHEAD', defer: gate } : working(args, cwd));
        const remote = githubRemote(URL)!;
        const p1 = checkoutRemote('mesh_batrp', remote);
        await new Promise(r => setTimeout(r, 10));
        expect(await checkout({})).toMatchObject({ success: false, code: 'ATTACH_IN_PROGRESS', stage: 'checkout' });
        release();
        await expect(p1).resolves.toMatchObject({ reused: false });
        expect(await checkout({})).toMatchObject({ success: true, reused: true });
    });
});

describe('remote_project_register / remote_project_accept', () => {
    const scoped = async () => ({ meshId: 'mesh_batrp', targetDaemonId: TARGET, identity: REPO, url: URL, hostDaemonId: SOURCE, workspace: await managedCheckoutPath('mesh_batrp', REPO) });

    it('register is idempotent: an existing node for the same target+workspace is not added twice', async () => {
        const args = await scoped();
        const execute = vi.fn(async () => ({ success: true, node: { id: 'n_new' } }));
        const ctx = { deps: { statusInstanceId: SOURCE }, execute } as any;
        expect(await remoteProjectHandlers.remote_project_register(ctx, args)).toMatchObject({ success: true, nodeId: 'n_new', attached: true });
        expect(execute).toHaveBeenCalledWith('add_mesh_node', { meshId: 'mesh_batrp', workspace: args.workspace, repoRoot: args.workspace, daemonId: TARGET }, 'internal', { inProcess: true });
        // The unpinned host was pinned before the foreign node arrived, so the retry still resolves this host.
        expect(state.pins).toEqual([{ id: 'mesh_batrp', hostDaemonId: SOURCE, hostNodeId: 'n1' }]);
        state.meshes[0].nodes.push({ id: 'n_new', daemonId: TARGET, workspace: args.workspace });
        const second = await remoteProjectHandlers.remote_project_register(ctx, args);
        expect(second, JSON.stringify(second)).toMatchObject({ success: true, nodeId: 'n_new', attached: true });
        expect(execute).toHaveBeenCalledTimes(1);
        expect(state.pins).toHaveLength(1);
    });

    it('an already pinned host is never re-pinned', async () => {
        state.meshes = [hostMesh({ meshHost: { role: 'host', hostDaemonId: SOURCE } })];
        const ctx = { deps: { statusInstanceId: SOURCE }, execute: vi.fn(async () => ({ success: true, node: { id: 'n_new' } })) } as any;
        expect(await remoteProjectHandlers.remote_project_register(ctx, await scoped())).toMatchObject({ success: true });
        expect(state.pins).toHaveLength(0);
    });

    it('register failure is recoverable and says the checkout was preserved', async () => {
        const ctx = { deps: { statusInstanceId: SOURCE }, execute: vi.fn(async () => ({ success: false, error: 'node limit' })) } as any;
        const r: any = await remoteProjectHandlers.remote_project_register(ctx, await scoped());
        expect(r).toMatchObject({ success: false, code: 'REGISTRATION_FAILED', stage: 'registration', attached: false });
        expect(r.action).toMatch(/preserved/i);
        expect(JSON.stringify(r)).not.toContain('node limit');
    });

    it('accept stores the host record once, reports resource readiness truthfully, and is idempotent', async () => {
        const args = await scoped();
        mkdirSync(args.workspace);
        state.python = false;
        const ctx = ctxFor(TARGET);
        const r: any = await remoteProjectHandlers.remote_project_accept(ctx, args);
        expect(r).toMatchObject({ success: true, attached: true, ready: false, stage: 'resource_preflight', resources: { code: 'GITPYTHON_UNAVAILABLE' } });
        expect(state.hostRecords.mesh_batrp).toEqual({ hostDaemonId: SOURCE });
        state.python = true;
        expect(await remoteProjectHandlers.remote_project_accept(ctx, args)).toMatchObject({ success: true, ready: true, stage: 'ready' });
    });

    it('accept refuses a different managed path and a conflicting existing host', async () => {
        const args = await scoped();
        mkdirSync(args.workspace);
        expect(await remoteProjectHandlers.remote_project_accept(ctxFor(TARGET), { ...args, workspace: '/tmp/elsewhere' })).toMatchObject({ code: 'PATH_CONFLICT' });
        state.hostRecords.mesh_batrp = { hostDaemonId: 'daemon_mach_other1' };
        expect(await remoteProjectHandlers.remote_project_accept(ctxFor(TARGET), args)).toMatchObject({ code: 'PROJECT_HOST_CONFLICT' });
        expect(state.hostRecords.mesh_batrp).toEqual({ hostDaemonId: 'daemon_mach_other1' });
    });

    it('checkout and accept refuse an unauthorized hostDaemonId unless authorized by a server-signed grant or allow-list', async () => {
        state.allowedHosts = [];
        const args = await scoped();
        mkdirSync(args.workspace);

        // Without grant or allow-list entry, spoofed or ungranted host is refused before writing hostRecords
        const spoofed = 'daemon_mach_evil999999999999999999999999';
        expect(await remoteProjectHandlers.remote_project_checkout(ctxFor(TARGET), { ...args, hostDaemonId: spoofed })).toMatchObject({
            success: false,
            code: 'HOST_NOT_AUTHORIZED',
            stage: 'target_access',
        });
        expect(await remoteProjectHandlers.remote_project_accept(ctxFor(TARGET), { ...args, hostDaemonId: spoofed })).toMatchObject({
            success: false,
            code: 'HOST_NOT_AUTHORIZED',
            stage: 'target_access',
        });
        expect(state.hostRecords.mesh_batrp).toBeUndefined();

        // With target machineSecret configured, a server-signed short-lived grant authorizes the exact {target, host, meshId, identity, exp}
        state.machineSecret = 'adm_targetsecret123';
        const secretHash = createHash('sha256').update(state.machineSecret).digest('hex');
        const exp = Date.now() + 60_000;
        const sign = (g: { target: string; host: string; meshId: string; identity: string; exp: number }) =>
            createHmac('sha256', secretHash).update(`${g.target}\n${g.host}\n${g.meshId}\n${g.identity}\n${g.exp}`).digest('hex');
        const validGrant = { target: TARGET, host: SOURCE, meshId: 'mesh_batrp', identity: REPO, exp, sig: '' };
        validGrant.sig = sign(validGrant);

        // Tampered or expired grants are rejected
        expect(await remoteProjectHandlers.remote_project_accept(ctxFor(TARGET), {
            ...args,
            grant: { ...validGrant, exp: Date.now() - 1000, sig: sign({ ...validGrant, exp: Date.now() - 1000 }) },
        })).toMatchObject({ success: false, code: 'HOST_NOT_AUTHORIZED' });
        expect(await remoteProjectHandlers.remote_project_accept(ctxFor(TARGET), {
            ...args,
            hostDaemonId: spoofed,
            grant: validGrant,
        })).toMatchObject({ success: false, code: 'HOST_NOT_AUTHORIZED' });
        expect(state.hostRecords.mesh_batrp).toBeUndefined();

        // Valid grant succeeds and pins SOURCE
        expect(await remoteProjectHandlers.remote_project_accept(ctxFor(TARGET), {
            ...args,
            grant: validGrant,
        })).toMatchObject({ success: true, attached: true });
        expect(state.hostRecords.mesh_batrp).toEqual({ hostDaemonId: SOURCE });
    });

    it('reports truthful REGISTRATION_FAILED subcodes for host-pin, node-add, and host-record-write failures', async () => {
        const regArgs = { meshId: 'mesh_batrp', targetDaemonId: TARGET, identity: REPO, workspace: '/remote/ws' };
        state.pinFail = true;
        expect(await remoteProjectHandlers.remote_project_register(
            { ...ctxFor(SOURCE), execute: async () => ({ success: true, node: { id: 'n2' } }) } as any,
            regArgs,
        )).toMatchObject({ success: false, code: 'REGISTRATION_FAILED', subcode: 'HOST_PIN_FAILED', stage: 'registration' });

        state.pinFail = false;
        expect(await remoteProjectHandlers.remote_project_register(
            { ...ctxFor(SOURCE), execute: async () => ({ success: false }) } as any,
            regArgs,
        )).toMatchObject({ success: false, code: 'REGISTRATION_FAILED', subcode: 'NODE_ADD_FAILED', stage: 'registration' });

        const checked = await remoteProjectHandlers.remote_project_checkout(ctxFor(TARGET), {
            meshId: 'mesh_batrp', targetDaemonId: TARGET, identity: REPO, url: URL, hostDaemonId: SOURCE,
        });
        state.writeHostRecordFail = true;
        expect(await remoteProjectHandlers.remote_project_accept(ctxFor(TARGET), {
            meshId: 'mesh_batrp', targetDaemonId: TARGET, identity: REPO, url: URL, hostDaemonId: SOURCE, workspace: (checked as any).workspace,
        })).toMatchObject({ success: false, code: 'REGISTRATION_FAILED', subcode: 'HOST_RECORD_WRITE_FAILED', stage: 'registration' });
    });
});

