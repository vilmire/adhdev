/**
 * Authenticated remote project attach (commands/high-family/remote-project-attach.ts,
 * assistant/remote-project-checkout.ts): the cloud bridge is reachable from the
 * boot config through the router, the setup verbs are source-scoped (never mesh),
 * local-only projects are refused before the bridge, and the target checkout is
 * path-validated, idempotent on retry and truthful about failures — with no child
 * stderr (which may carry helper credentials) ever leaving the process.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
    configDir: '',
    meshes: [] as any[],
    hostRecords: {} as Record<string, { hostDaemonId: string }>,
    git: (_args: string[], _cwd: string): { stdout?: string; error?: any; defer?: Promise<void> } => ({ stdout: '' }),
    python: true,
    gitCalls: [] as { args: string[]; cwd: string }[],
    pins: [] as any[],
}));

vi.mock('node:child_process', async (importOriginal) => {
    const real = await importOriginal<typeof import('node:child_process')>();
    return {
        ...real,
        execFile: (cmd: string, args: string[], opts: any, cb: (e: any, out?: any) => void) => {
            if (cmd === 'git') {
                const gitArgs = args.slice(6);
                state.gitCalls.push({ args: gitArgs, cwd: opts?.cwd });
                const r = state.git(gitArgs, opts?.cwd);
                const reply = () => (r.error ? cb(r.error) : cb(null, { stdout: r.stdout ?? '', stderr: '' }));
                if (r.defer) void r.defer.then(reply);
                else reply();
                return;
            }
            if (state.python) cb(null, { stdout: 'gitpython-ready\n', stderr: '' });
            else cb(Object.assign(new Error('missing'), { code: 1 }));
        },
    };
});
vi.mock('../../src/config/config.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../src/config/config.js')>()),
    getConfigDir: () => state.configDir,
}));
vi.mock('../../src/config/mesh-config.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../src/config/mesh-config.js')>()),
    getMesh: (id: string) => state.meshes.find(m => m.id === id),
}));
vi.mock('../../src/config/mesh-config-host-pairing.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../src/config/mesh-config-host-pairing.js')>()),
    setMeshHostPin: (id: string, opts: { hostDaemonId: string; hostNodeId: string }) => {
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
    writeMeshHostRecord: (id: string, host: string) => { state.hostRecords[id] = { hostDaemonId: host }; return true; },
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

    it('setup verbs are source-scoped: owner surfaces for the entry, server api for the steps, never mesh', async () => {
        const registry = getDaemonCommandRegistry();
        expect(registry.get('attach_remote_project')?.sources).toEqual(['ipc', 'standalone']);
        for (const step of ['remote_project_prepare', 'remote_project_checkout', 'remote_project_register', 'remote_project_accept']) {
            expect(registry.get(step)?.sources).toEqual(['api']);
        }
        expect(registry.get('assistant_project_attach_remote')?.sources).not.toContain('mesh');
        const bridge = vi.fn();
        const router = routerWith(SOURCE, bridge as any);
        const viaMesh: any = await router.execute('attach_remote_project', { meshId: 'mesh_batrp', targetDaemonId: TARGET }, 'mesh');
        const stepViaIpc: any = await router.execute('remote_project_checkout', { meshId: 'mesh_batrp', targetDaemonId: SOURCE, identity: REPO, url: URL }, 'ipc');
        expect(viaMesh.success).toBe(false);
        expect(stepViaIpc.success).toBe(false);
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
    const checkout = (args: any, self = TARGET) => remoteProjectHandlers.remote_project_checkout(ctxFor(self), { meshId: 'mesh_batrp', targetDaemonId: TARGET, identity: REPO, url: URL, ...args });

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

    it('a crash-left .pending directory is preserved and reported, not overwritten', async () => {
        const workspace = await managedCheckoutPath('mesh_batrp', REPO);
        mkdirSync(`${workspace}.pending`);
        expect(await checkout({})).toMatchObject({ success: false, code: 'CHECKOUT_RECOVERY_REQUIRED', stage: 'checkout' });
        expect(existsSync(`${workspace}.pending`)).toBe(true);
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
});
