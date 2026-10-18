/**
 * Authenticated remote project attach (commands/high-family/remote-project-attach.ts,
 * assistant/remote-project-checkout.ts): the cloud bridge is reachable from the
 * boot config through the router, the setup verbs are source-scoped (never mesh),
 * local-only projects are refused before the bridge, and the target checkout is
 * path-validated, idempotent on retry and truthful about failures — with no child
 * stderr (which may carry helper credentials) ever leaving the process.
 */
import { EventEmitter } from 'node:events';
import { createHash, createHmac } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, existsSync, writeFileSync, readFileSync, lstatSync, symlinkSync, utimesSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
    configDir: '',
    meshes: [] as any[],
    hostRecords: {} as Record<string, { hostDaemonId: string }>,
    git: (_args: string[], _cwd: string): { stdout?: string; error?: any; defer?: Promise<void>; manual?: boolean } => ({ stdout: '' }),
    python: true,
    gitCalls: [] as { args: string[]; cwd: string; targetDir?: string; detached?: boolean; windowsHide?: boolean; fullArgs?: string[] }[],
    pythonCalls: [] as { cmd: string; args: string[]; opts: any }[],
    taskkillCalls: [] as { args: string[]; opts: any }[],
    children: [] as any[],
    taskkillGate: null as Promise<void> | null,
    taskkillError: null as Error | null,
    beforeLockWrite: null as (() => Promise<void>) | null,
    renameError: null as string | null,
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
        writeFile: async (path: any, data: any, opts: any) => {
            if (String(path).endsWith('.lock') && state.beforeLockWrite) {
                const gate = state.beforeLockWrite;
                state.beforeLockWrite = null;
                await real.writeFile(path, '', opts);
                await gate();
                return real.writeFile(path, data);
            }
            return real.writeFile(path, data, opts);
        },
        rename: async (oldPath: any, newPath: any) => {
            if (state.renameError) throw Object.assign(new Error(state.renameError), { code: state.renameError });
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
        spawn: (cmd: string, args: string[], opts: any) => {
            const cIdx = args.indexOf('-C');
            const targetDir = args[cIdx + 1];
            const gitArgs = args.slice(cIdx + 2);
            state.gitCalls.push({ args: gitArgs, cwd: opts.cwd, targetDir, detached: opts.detached, windowsHide: opts.windowsHide, fullArgs: args });
            const child: any = new EventEmitter();
            child.pid = 4242;
            child.stdout = new EventEmitter();
            child.stderr = new EventEmitter();
            child.args = gitArgs;
            state.children.push(child);
            const r = state.git(gitArgs, targetDir);
            child.finish = () => {
                if (r.stdout) child.stdout.emit('data', r.stdout);
                if (r.error?.stderr) child.stderr.emit('data', r.error.stderr);
                if (r.error?.code === 'ENOENT') child.emit('error', r.error);
                child.emit('close', r.error ? (r.error.code ?? 1) : 0);
            };
            if (!r.manual) {
                if (r.defer) void r.defer.then(child.finish);
                else queueMicrotask(child.finish);
            }
            return child;
        },
        execFile: (cmd: string, args: string[], opts: any, cb: (e: any, out?: any) => void) => {
            if (cmd === 'taskkill') {
                state.taskkillCalls.push({ args, opts });
                if (state.taskkillGate) void state.taskkillGate.then(() => cb(state.taskkillError));
                else queueMicrotask(() => cb(state.taskkillError));
                return { pid: 9999 } as any;
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
    loadMeshes: () => state.meshes,
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
import { checkoutRemote, githubRemote, managedCheckoutPath, git, REMOTE_GIT_CLONE_TIMEOUT_MS, REMOTE_GIT_CLONE_WATCHDOG_MS } from '../../src/assistant/remote-project-checkout.js';

const SOURCE = 'daemon_mach_source1';
const TARGET = 'daemon_mach_target1';
const REPO = 'github.com/vilmire/batrp';
const URL = `https://${REPO}.git`;
const LOCK_NONCE = '12345678-1234-1234-1234-123456789abc';
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

const prevConfigDirEnv = process.env.ADHDEV_CONFIG_DIR;

beforeEach(() => {
    state.configDir = mkdtempSync(join(tmpdir(), 'adhdev-remote-attach-'));
    process.env.ADHDEV_CONFIG_DIR = state.configDir;
    state.meshes = [hostMesh()];
    state.hostRecords = {};
    state.python = true;
    state.gitCalls = [];
    state.children = [];
    state.taskkillCalls = [];
    state.taskkillGate = null;
    state.taskkillError = null;
    state.beforeLockWrite = null;
    state.renameError = null;
    state.renameFailures = 0;
    state.pins = [];
    state.allowedHosts = [SOURCE];
    state.machineSecret = null;
    state.pinFail = false;
    state.writeHostRecordFail = false;
    workingGit();
});
afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    if (prevConfigDirEnv === undefined) delete process.env.ADHDEV_CONFIG_DIR;
    else process.env.ADHDEV_CONFIG_DIR = prevConfigDirEnv;
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

    it('remote_project_attach_settings rejects ipc/mesh/api and accepts owner sources while preserving existing config.json keys', async () => {
        const registry = getDaemonCommandRegistry();
        expect(registry.get('remote_project_attach_settings')?.sources).toEqual(['p2p', 'ws', 'standalone']);

        const configPath = join(state.configDir, 'config.json');
        writeFileSync(configPath, JSON.stringify({
            userName: 'owner-user',
            serverUrl: 'https://adhdev.example',
            machineNickname: 'SourceMac',
            providerSettings: { claude: { customFlag: true } },
        }, null, 2));

        const router = routerWith(SOURCE);

        // Rejects ipc, mesh, api
        for (const forbidden of ['ipc', 'mesh', 'api'] as const) {
            const rejected: any = await router.execute('remote_project_attach_settings', { action: 'set', enabled: true }, forbidden as any);
            expect(rejected.success).toBe(false);
            expect(rejected.code).toBe('COMMAND_SOURCE_REJECTED');
        }
        expect(JSON.parse(readFileSync(configPath, 'utf-8')).allowRemoteProjectAttach).toBeUndefined();

        // Owner sources can read default OFF and toggle ON/OFF without clobbering other config keys
        const initial: any = await router.execute('remote_project_attach_settings', { action: 'get' }, 'p2p');
        expect(initial).toMatchObject({ success: true, allowRemoteProjectAttach: false, enabled: false });

        const enabledRes: any = await router.execute('remote_project_attach_settings', { action: 'set', enabled: true }, 'ws');
        expect(enabledRes).toMatchObject({ success: true, allowRemoteProjectAttach: true, enabled: true });
        const afterOn = JSON.parse(readFileSync(configPath, 'utf-8'));
        expect(afterOn.allowRemoteProjectAttach).toBe(true);
        expect(afterOn.userName).toBe('owner-user');
        expect(afterOn.serverUrl).toBe('https://adhdev.example');
        expect(afterOn.machineNickname).toBe('SourceMac');
        expect(afterOn.providerSettings).toEqual({ claude: { customFlag: true } });

        const disabledRes: any = await router.execute('remote_project_attach_settings', { action: 'set', enabled: false }, 'standalone');
        expect(disabledRes).toMatchObject({ success: true, allowRemoteProjectAttach: false, enabled: false });
        const afterOff = JSON.parse(readFileSync(configPath, 'utf-8'));
        expect(afterOff.allowRemoteProjectAttach).toBe(false);
        expect(afterOff.machineNickname).toBe('SourceMac');
        expect(afterOff.providerSettings).toEqual({ claude: { customFlag: true } });
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

    it('enriches PROJECT_ATTACH_DISABLED from the bridge with stage, role, machine attribution and the allowRemoteProjectAttach enable hint', async () => {
        const bridge = vi.fn(async () => ({
            success: false,
            code: 'PROJECT_ATTACH_DISABLED',
            stage: 'prepare',
            role: 'source',
            daemonId: SOURCE,
            machineName: 'SourceMac',
        }));
        const router = routerWith(SOURCE, bridge as any);
        const res: any = await router.execute('attach_remote_project', { meshId: 'mesh_batrp', targetDaemonId: TARGET }, 'ipc');
        expect(res).toMatchObject({
            success: false,
            code: 'PROJECT_ATTACH_DISABLED',
            stage: 'prepare',
            role: 'source',
            daemonId: SOURCE,
            machineName: 'SourceMac',
            setting: 'allowRemoteProjectAttach',
            attached: false,
        });
        expect(res.error).toContain('allowRemoteProjectAttach');
        expect(res.error).toContain('source machine SourceMac (daemon_mach_source1)');
        expect(res.error).toContain('Dashboard → Settings');
        expect(res.action).toBe(res.error);
        expect(res.hint).toBe(res.error);
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
        // Without a TTY git prints no progress unless asked, and the idle watchdog is reset
        // only by output — so a clone running past the idle window would always be killed.
        expect(state.gitCalls.find(c => c.args[0] === 'clone')?.args).toContain('--progress');
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

    it('idle watchdog waits for Windows tree termination AND child close before staging cleanup and lock release', async () => {
        const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
        Object.defineProperty(process, 'platform', { value: 'win32' });
        let killed!: () => void;
        state.taskkillGate = new Promise<void>(r => { killed = r; });
        const working = state.git;
        state.git = (args, cwd) => args[0] === 'clone' ? { manual: true } : working(args, cwd);
        const workspace = await managedCheckoutPath('mesh_batrp', REPO);
        vi.useFakeTimers();
        try {
            let settled = false;
            const attempt = checkout({}).then(r => { settled = true; return r; });
            await vi.waitFor(() => expect(state.children.find(c => c.args[0] === 'clone')).toBeDefined());
            const child = state.children.find(c => c.args[0] === 'clone');
            await vi.advanceTimersByTimeAsync(REMOTE_GIT_CLONE_WATCHDOG_MS);
            expect(state.taskkillCalls).toHaveLength(1);
            expect(settled).toBe(false);
            expect(existsSync(`${workspace}.pending`)).toBe(true);
            expect(existsSync(`${workspace}.lock`)).toBe(true);
            killed();
            await vi.advanceTimersByTimeAsync(0);
            expect(settled).toBe(false); // taskkill alone does not prove root close
            child.emit('close', null);
            await expect(attempt).resolves.toMatchObject({ success: false, code: 'GIT_TIMEOUT' });
            expect(existsSync(`${workspace}.pending`)).toBe(false);
            expect(existsSync(`${workspace}.lock`)).toBe(false);
        } finally { Object.defineProperty(process, 'platform', platform); }
    });

    it('clone progress rearms idle timeout, but wall deadline still stops the tree; output overflow also kills helpers', async () => {
        const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
        Object.defineProperty(process, 'platform', { value: 'win32' });
        state.git = () => ({ manual: true });
        vi.useFakeTimers();
        try {
            const pending = git(state.configDir, ['clone', '--', URL, 'unused']).catch(e => e);
            const child = state.children.at(-1);
            for (let elapsed = 0; elapsed < REMOTE_GIT_CLONE_TIMEOUT_MS; elapsed += 60_000) {
                child.stderr.emit('data', 'progress');
                await vi.advanceTimersByTimeAsync(60_000);
            }
            expect(state.taskkillCalls).toHaveLength(1);
            child.emit('close', null);
            expect(await pending).toMatchObject({ code: 'GIT_TIMEOUT' });
            expect(state.gitCalls[0].detached).toBe(false);

            const overflow = git(state.configDir, ['ls-remote', URL]).catch(e => e);
            const next = state.children.at(-1);
            next.stdout.emit('data', Buffer.alloc(1024 * 1024 + 1));
            await vi.advanceTimersByTimeAsync(0);
            expect(state.taskkillCalls).toHaveLength(2);
            expect(state.taskkillCalls[1]).toMatchObject({ args: ['/PID', '4242', '/T', '/F'], opts: { windowsHide: true } });
            next.emit('close', null);
            expect(await overflow).toMatchObject({ code: 'ENOBUFS' });
        } finally { Object.defineProperty(process, 'platform', platform); }
    });

    it('uncertain tree termination preserves staging and the owner lock for recovery', async () => {
        const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
        Object.defineProperty(process, 'platform', { value: 'win32' });
        const working = state.git;
        state.git = (args, cwd) => args[0] === 'clone' ? { manual: true } : working(args, cwd);
        state.taskkillGate = new Promise<void>(() => {});
        const workspace = await managedCheckoutPath('mesh_batrp', REPO);
        vi.useFakeTimers();
        try {
            const attempt = checkout({});
            await vi.waitFor(() => expect(state.children.find(c => c.args[0] === 'clone')).toBeDefined());
            await vi.advanceTimersByTimeAsync(REMOTE_GIT_CLONE_WATCHDOG_MS + 5001);
            await expect(attempt).resolves.toMatchObject({ success: false, code: 'CHECKOUT_RECOVERY_REQUIRED' });
            expect(existsSync(`${workspace}.pending`)).toBe(true);
            expect(existsSync(`${workspace}.lock`)).toBe(true);
        } finally { Object.defineProperty(process, 'platform', platform); }
    });

    it('uncertain termination while verifying crash-left completion evidence also keeps the lock', async () => {
        const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
        Object.defineProperty(process, 'platform', { value: 'win32' });
        const workspace = await managedCheckoutPath('mesh_batrp', REPO);
        mkdirSync(`${workspace}.pending`);
        const dir = lstatSync(`${workspace}.pending`);
        writeFileSync(`${workspace}.pending.complete`, JSON.stringify({ meshId: 'mesh_batrp', identity: REPO, nonce: LOCK_NONCE, dev: dir.dev, ino: dir.ino }));
        const working = state.git;
        state.git = (args, cwd) => args[0] === 'rev-parse' ? { manual: true } : working(args, cwd);
        state.taskkillError = new Error('denied');
        vi.useFakeTimers();
        try {
            const attempt = checkout({});
            await vi.waitFor(() => expect(state.children.find(c => c.args[0] === 'rev-parse')).toBeDefined());
            await vi.advanceTimersByTimeAsync(120_000);
            await expect(attempt).resolves.toMatchObject({ code: 'CHECKOUT_RECOVERY_REQUIRED' });
            expect(existsSync(`${workspace}.pending`)).toBe(true);
            expect(existsSync(`${workspace}.lock`)).toBe(true);
        } finally { Object.defineProperty(process, 'platform', platform); }
    });

    it('POSIX termination signals the detached process group and escalates before releasing', async () => {
        const actualKill = process.kill.bind(process);
        const signals: any[] = [];
        vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal: any) => {
            if (pid < 0) { signals.push([pid, signal]); return true; }
            return actualKill(pid, signal);
        }) as any);
        state.git = () => ({ manual: true });
        vi.useFakeTimers();
        const pending = git(state.configDir, ['clone', '--', URL, 'unused']).catch(e => e);
        const child = state.children.at(-1);
        await vi.advanceTimersByTimeAsync(REMOTE_GIT_CLONE_WATCHDOG_MS);
        expect(signals).toEqual([[-4242, 'SIGTERM']]);
        await vi.advanceTimersByTimeAsync(2000);
        expect(signals).toEqual([[-4242, 'SIGTERM'], [-4242, 'SIGKILL']]);
        child.emit('close', null);
        expect(await pending).toMatchObject({ code: 'GIT_TIMEOUT' });
        expect(state.gitCalls[0].detached).toBe(true);
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
        // Even a plausible origin/root is insufficient without producer evidence.
        expect(await checkout({})).toMatchObject({ code: 'CHECKOUT_RECOVERY_REQUIRED' });
        const dir = lstatSync(`${workspace}.pending`);
        writeFileSync(`${workspace}.pending.complete`, JSON.stringify({ meshId: 'mesh_batrp', identity: REPO, nonce: LOCK_NONCE, dev: dir.dev, ino: dir.ino }));
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
        writeFileSync(`${workspace}.lock`, JSON.stringify({ pid: process.pid, nonce: LOCK_NONCE }));
        expect(await checkout({})).toMatchObject({ success: false, code: 'ATTACH_IN_PROGRESS', stage: 'checkout' });
        expect(state.gitCalls).toHaveLength(0);

        // Stale dead-PID lockfile is reclaimed, and transient EBUSY on rename retries 5x200ms and succeeds
        writeFileSync(`${workspace}.lock`, JSON.stringify({ pid: 99999999, nonce: LOCK_NONCE }));
        state.renameFailures = 2;
        expect(await checkout({})).toMatchObject({ success: true, reused: false, workspace });
        expect(state.renameFailures).toBe(0);
        expect(existsSync(`${workspace}.lock`)).toBe(false);
    });

    it('does not steal a fresh partial lock, even from an independent module instance', async () => {
        vi.resetModules();
        const independent = await import('../../src/assistant/remote-project-checkout.js');
        let entered!: () => void, release!: () => void;
        const writing = new Promise<void>(r => { entered = r; });
        const gate = new Promise<void>(r => { release = r; });
        state.beforeLockWrite = async () => { entered(); await gate; };
        const first = checkoutRemote('mesh_batrp', githubRemote(URL)!);
        await writing;
        const workspace = await managedCheckoutPath('mesh_batrp', REPO);
        expect(readFileSync(`${workspace}.lock`, 'utf8')).toBe('');
        await expect(independent.checkoutRemote('mesh_batrp', githubRemote(URL)!)).rejects.toMatchObject({ code: 'ATTACH_IN_PROGRESS' });
        release();
        await expect(first).resolves.toMatchObject({ reused: false });
        expect(state.gitCalls.filter(c => c.args[0] === 'clone')).toHaveLength(1);
    });

    it('serializes competing stale reclaimers and never releases a replacement nonce', async () => {
        vi.resetModules();
        const independent = await import('../../src/assistant/remote-project-checkout.js');
        const workspace = await managedCheckoutPath('mesh_batrp', REPO);
        writeFileSync(`${workspace}.lock`, JSON.stringify({ pid: 99999999, nonce: LOCK_NONCE }));
        const results = await Promise.allSettled([
            checkoutRemote('mesh_batrp', githubRemote(URL)!), independent.checkoutRemote('mesh_batrp', githubRemote(URL)!),
        ]);
        expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
        expect(results.filter(r => r.status === 'rejected')).toHaveLength(1);
        expect(state.gitCalls.filter(c => c.args[0] === 'clone')).toHaveLength(1);

        const replacement = { pid: process.pid, nonce: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' };
        const working = state.git;
        state.git = (args, cwd) => {
            if (args[0] === 'ls-remote') writeFileSync(`${workspace}.lock`, JSON.stringify(replacement));
            return working(args, cwd);
        };
        await expect(checkoutRemote('mesh_batrp', githubRemote(URL)!)).rejects.toMatchObject({ code: 'CHECKOUT_RECOVERY_REQUIRED' });
        expect(JSON.parse(readFileSync(`${workspace}.lock`, 'utf8'))).toEqual(replacement);
    });

    it('preserves malformed locks and orphan mutation guards instead of guessing they are stale', async () => {
        const workspace = await managedCheckoutPath('mesh_batrp', REPO);
        writeFileSync(`${workspace}.lock`, '');
        expect(await checkout({})).toMatchObject({ code: 'CHECKOUT_RECOVERY_REQUIRED' });
        expect(readFileSync(`${workspace}.lock`, 'utf8')).toBe('');
        rmSync(`${workspace}.lock`);
        mkdirSync(`${workspace}.lock.guard`);
        expect(await checkout({})).toMatchObject({ code: 'ATTACH_IN_PROGRESS' });
        expect(state.gitCalls).toHaveLength(0);
    });

    it('a crash-left mutation guard answers CHECKOUT_RECOVERY_REQUIRED naming the guard, never ATTACH_IN_PROGRESS forever', async () => {
        const workspace = await managedCheckoutPath('mesh_batrp', REPO);
        const guard = `${workspace}.lock.guard`;
        const guardName = `remote-projects/${workspace.split(/[\\/]/).pop()}.lock.guard`;
        const old = new Date(Date.now() - 10 * 60_000);
        // Owner recorded in the guard has died (daemon crashed mid-mutation): recovery at once.
        mkdirSync(guard);
        writeFileSync(join(guard, 'owner'), JSON.stringify({ pid: 99999999, nonce: LOCK_NONCE }));
        const dead: any = await checkout({});
        expect(dead).toMatchObject({ success: false, code: 'CHECKOUT_RECOVERY_REQUIRED', stage: 'checkout' });
        expect(dead.action).toContain(guardName);
        expect(existsSync(join(guard, 'owner'))).toBe(true);
        // Owner-less guard (crash between mkdir and the owner write, or an older daemon) once it is old.
        rmSync(guard, { recursive: true });
        mkdirSync(guard);
        utimesSync(guard, old, old);
        expect(await checkout({})).toMatchObject({ code: 'CHECKOUT_RECOVERY_REQUIRED' });
        // A live recorded owner is waited on while fresh; held far past any mutation it is recovery.
        rmSync(guard, { recursive: true });
        mkdirSync(guard);
        writeFileSync(join(guard, 'owner'), JSON.stringify({ pid: process.pid, nonce: LOCK_NONCE }));
        expect(await checkout({})).toMatchObject({ code: 'ATTACH_IN_PROGRESS' });
        utimesSync(guard, old, old);
        expect(await checkout({})).toMatchObject({ code: 'CHECKOUT_RECOVERY_REQUIRED' });
        // Nothing was reclaimed or cloned; the guard survives every refusal.
        expect(existsSync(guard)).toBe(true);
        expect(state.gitCalls).toHaveLength(0);
        // Following the recovery action (removing the guard) lets the attach proceed, and the
        // guard is released with its owner record.
        rmSync(guard, { recursive: true });
        expect(await checkout({})).toMatchObject({ success: true, reused: false });
        expect(existsSync(guard)).toBe(false);
    });

    it('a crash-left completion marker without its staging dir is discarded so a later clone can complete', async () => {
        const workspace = await managedCheckoutPath('mesh_batrp', REPO);
        // Crash after adopting (rename) but before removing the marker; the workspace was later deleted.
        writeFileSync(`${workspace}.pending.complete`, JSON.stringify({ meshId: 'mesh_batrp', identity: REPO, nonce: LOCK_NONCE, dev: 1, ino: 1 }));
        expect(await checkout({})).toMatchObject({ success: true, reused: false, workspace });
        expect(state.gitCalls.filter(c => c.args[0] === 'clone')).toHaveLength(1);
        expect(existsSync(`${workspace}.pending`)).toBe(false);
        expect(existsSync(`${workspace}.pending.complete`)).toBe(false);
        // A non-file at the marker path is not guessed at: refused and preserved, nothing cloned.
        rmSync(workspace, { recursive: true });
        mkdirSync(`${workspace}.pending.complete`);
        state.gitCalls = [];
        expect(await checkout({})).toMatchObject({ code: 'CHECKOUT_RECOVERY_REQUIRED' });
        expect(lstatSync(`${workspace}.pending.complete`).isDirectory()).toBe(true);
        expect(state.gitCalls.some(c => c.args[0] === 'clone')).toBe(false);
        expect(readdirSync(join(realpathSync(state.configDir), 'remote-projects')).some(n => n.endsWith('.pending'))).toBe(false);
    });

    it('publishes completion evidence only after clone close and recovers it after a failed rename', async () => {
        const workspace = await managedCheckoutPath('mesh_batrp', REPO);
        state.renameError = 'EIO';
        expect(await checkout({})).toMatchObject({ success: false });
        const evidence = JSON.parse(readFileSync(`${workspace}.pending.complete`, 'utf8'));
        expect(evidence).toMatchObject({ meshId: 'mesh_batrp', identity: REPO, nonce: expect.any(String) });
        state.renameError = null;
        state.gitCalls = [];
        expect(await checkout({})).toMatchObject({ success: true, reused: true });
        expect(state.gitCalls.some(c => c.args[0] === 'clone')).toBe(false);
        expect(existsSync(`${workspace}.pending.complete`)).toBe(false);
    });

    it('refuses symlink staging, symlink locks, and completion evidence for a different directory', async () => {
        const workspace = await managedCheckoutPath('mesh_batrp', REPO);
        const outside = join(state.configDir, 'preserved');
        mkdirSync(outside);
        symlinkSync(outside, `${workspace}.pending`, 'dir');
        expect(await checkout({})).toMatchObject({ code: 'CHECKOUT_RECOVERY_REQUIRED' });
        expect(lstatSync(`${workspace}.pending`).isSymbolicLink()).toBe(true);
        rmSync(`${workspace}.pending`);
        mkdirSync(`${workspace}.pending`);
        writeFileSync(`${workspace}.pending.complete`, JSON.stringify({ meshId: 'mesh_batrp', identity: REPO, nonce: LOCK_NONCE, dev: -1, ino: -1 }));
        expect(await checkout({})).toMatchObject({ code: 'CHECKOUT_RECOVERY_REQUIRED' });
        symlinkSync(outside, `${workspace}.lock`, 'dir');
        expect(await checkout({})).toMatchObject({ code: 'CHECKOUT_RECOVERY_REQUIRED' });
        expect(lstatSync(`${workspace}.lock`).isSymbolicLink()).toBe(true);
        expect(existsSync(outside)).toBe(true);
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

