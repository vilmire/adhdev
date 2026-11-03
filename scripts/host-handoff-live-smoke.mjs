#!/usr/bin/env node
/**
 * Opt-in live host-handoff smoke for two isolated standalone daemons.
 *
 * Does nothing unless ADHDEV_HANDOFF_LIVE=1. Never runs from the default test
 * suite. The authenticated canary is the installed provider declaration's
 * host-enforced probe (15s, 16384 output bytes). This script does not raise
 * that cap, does not inject a successful canary, and does not call Claude.
 *
 * Required when live:
 *   ADHDEV_HANDOFF_LIVE=1
 *   ADHDEV_HANDOFF_LIVE_HOME   account home whose native Codex login the
 *                              daemon process may inherit. Not printed.
 * Optional:
 *   ADHDEV_HANDOFF_LIVE_CODEX_HOME   defaults to <home>/.codex at runtime
 *   ADHDEV_HANDOFF_EVIDENCE          JSON path; default is a temp file
 *
 * Inherited ADHDEV_* is dropped. Each daemon gets its own config dir,
 * session-host name, port, and token. Ephemeral tokens and homes stay out of
 * the evidence file.
 */
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

const LIVE = process.env.ADHDEV_HANDOFF_LIVE === '1';
if (!LIVE) {
    console.log('host-handoff-live-smoke: refused (set ADHDEV_HANDOFF_LIVE=1 to spend a bounded Codex canary)');
    process.exit(0);
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const STANDALONE = path.join(ROOT, 'oss', 'packages', 'daemon-standalone');
const NODE = process.execPath;
const TASK = '09bc29be';
const PROVIDER = 'codex-cli';
const MODEL = 'gpt-6.1-sol';
const home = process.env.ADHDEV_HANDOFF_LIVE_HOME?.trim() || '';
const codexHome = process.env.ADHDEV_HANDOFF_LIVE_CODEX_HOME?.trim() || (home ? path.join(home, '.codex') : '');
const evidencePath = process.env.ADHDEV_HANDOFF_EVIDENCE?.trim() || path.join(tmpdir(), `handoff-${TASK}-evidence.json`);

if (process.version !== 'v22.17.0') {
    console.error(`host-handoff-live-smoke: node ${process.version} refused; require v22.17.0`);
    process.exit(2);
}
if (!home || !codexHome) {
    console.error('host-handoff-live-smoke: ADHDEV_HANDOFF_LIVE_HOME is required');
    process.exit(2);
}

const secrets = new Set();
const created = [];
const evidence = {
    task: TASK,
    kind: 'live-isolated-daemons',
    startedAt: new Date().toISOString(),
    node: process.version,
    provider: PROVIDER,
    model: MODEL,
    thinking: 'omitted',
    hostTimeoutMs: 15000,
    hostMaxOutputBytes: 16384,
    nativeTurnCap: false,
    nativeOutputTokenCap: false,
    authInvocations: 0,
    cases: {},
    processes: [],
    shutdown: [],
};

function rememberSecret(value) {
    if (typeof value === 'string' && value.length >= 8) secrets.add(value);
}
rememberSecret(home);
rememberSecret(codexHome);

function redactString(text) {
    let out = String(text);
    for (const secret of [...secrets].sort((a, b) => b.length - a.length)) out = out.split(secret).join('<redacted>');
    return out.replace(/\/Users\/[^/\s"']+/g, '<home>').replace(/\/home\/[^/\s"']+/g, '<home>');
}
function redact(value) {
    if (value == null) return value;
    if (typeof value === 'string') return redactString(value);
    if (Array.isArray(value)) return value.map(redact);
    if (typeof value === 'object') {
        const out = {};
        for (const [key, item] of Object.entries(value)) {
            if (/token|secret|authorization|peerSecret|cookie/i.test(key)) continue;
            out[key] = redact(item);
        }
        return out;
    }
    return value;
}
function save() {
    writeFileSync(evidencePath, `${JSON.stringify(redact(evidence), null, 2)}\n`);
}
function finish(code, summary) {
    evidence.finishedAt = new Date().toISOString();
    evidence.exitCode = code;
    evidence.summary = summary;
    save();
    console.log(code === 0 ? `HANDOFF_SMOKE_DONE ${redactString(evidencePath)}` : `HANDOFF_SMOKE_FAIL ${code} ${redactString(summary)} ${redactString(evidencePath)}`);
    return code;
}

function freePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            const port = typeof address === 'object' && address ? address.port : 0;
            server.close(() => resolve(port));
        });
        server.on('error', reject);
    });
}

function childEnv(configDir, sessionName, token) {
    const env = {};
    for (const [key, value] of Object.entries(process.env)) {
        if (key.startsWith('ADHDEV_')) continue;
        if (value !== undefined) env[key] = value;
    }
    env.HOME = home;
    env.CODEX_HOME = codexHome;
    env.ADHDEV_CONFIG_DIR = configDir;
    env.ADHDEV_SESSION_HOST_NAME = sessionName;
    env.ADHDEV_TOKEN = token;
    env.ADHDEV_USE_SIBLING_PROVIDERS = '1';
    env.ADHDEV_ALLOW_SIBLING_PROVIDERS_ON_STABLE = '1';
    delete env.ADHDEV_PROVIDER_CHANNEL;
    delete env.ADHDEV_BUILD_CHANNEL;
    return env;
}

async function startDaemon(role) {
    const configDir = path.join(tmpdir(), `adhdev-handoff-${role}-${TASK}-${randomUUID()}`);
    const sessionName = `adhdev-handoff-${role}-${TASK}`;
    const token = randomBytes(24).toString('hex');
    rememberSecret(token);
    rememberSecret(configDir);
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
    writeFileSync(path.join(configDir, 'config.json'), `${JSON.stringify({
        experimental: { hostHandoff: true },
        setupCompleted: true,
        machineProviders: { 'codex-cli': { enabled: true } },
    }, null, 2)}\n`, { mode: 0o600 });
    const port = await freePort();
    const logPath = path.join(configDir, 'daemon.log');
    const log = await import('node:fs').then(fs => fs.createWriteStream(logPath));
    const child = spawn(NODE, ['--import', 'tsx', 'src/index.ts', '--host', '127.0.0.1', '--port', String(port), '--token', token], {
        cwd: STANDALONE,
        env: childEnv(configDir, sessionName, token),
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
    });
    child.stdout?.pipe(log);
    child.stderr?.pipe(log);
    const record = { role, pid: child.pid, port, sessionName, configDir, token, logPath, child };
    created.push(record);
    evidence.processes.push({ role, pid: child.pid, port, sessionName });
    const deadline = Date.now() + 45_000;
    let up = false;
    while (Date.now() < deadline) {
        if (child.exitCode != null) break;
        try {
            const res = await fetch(`http://127.0.0.1:${port}/health`);
            if (res.ok) { up = true; break; }
        } catch { /* boot */ }
        await new Promise(r => setTimeout(r, 250));
    }
    if (!up) throw new Error(`${role} daemon did not open /health`);
    return record;
}

async function command(daemon, type, payload, timeoutMs = 30_000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(`http://127.0.0.1:${daemon.port}/api/v1/command`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${daemon.token}` },
            body: JSON.stringify({ type, payload }),
            signal: controller.signal,
        });
        const text = await res.text();
        let body;
        try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 500) }; }
        return { status: res.status, body };
    } finally { clearTimeout(timer); }
}

function gitRepo() {
    const dir = path.join(tmpdir(), `adhdev-handoff-repo-${TASK}-${randomUUID()}`);
    mkdirSync(dir, { recursive: true });
    const git = (args) => execFileSync('git', ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', ...args], { cwd: dir, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    git(['init', '-b', 'main']);
    git(['config', 'user.email', 'handoff-fixture@example.invalid']);
    git(['config', 'user.name', 'handoff-fixture']);
    writeFileSync(path.join(dir, 'README.md'), 'isolated handoff fixture\n');
    git(['add', 'README.md']);
    git(['commit', '-m', 'fixture']);
    git(['remote', 'add', 'origin', 'https://example.invalid/adhdev/handoff-fixture.git']);
    created.push({ role: 'repo', configDir: dir });
    return dir;
}

function countCanaries(body) {
    const text = JSON.stringify(body ?? {});
    const ids = new Set();
    for (const match of text.matchAll(/canary ([A-Za-z0-9_-]+)/g)) ids.add(match[1]);
    return ids.size;
}

function descendants(pid) {
    let rows = [];
    try { rows = execFileSync('ps', ['-ax', '-o', 'pid=,ppid='], { encoding: 'utf8' }).trim().split('\n'); } catch { return []; }
    const children = new Map();
    for (const line of rows) {
        const [id, parent] = line.trim().split(/\s+/).map(Number);
        if (!children.has(parent)) children.set(parent, []);
        children.get(parent).push(id);
    }
    const out = [];
    const walk = (id) => { for (const child of children.get(id) ?? []) { out.push(child); walk(child); } };
    walk(pid);
    return out;
}

function cmdline(pid) {
    try { return execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).trim(); } catch { return ''; }
}

function commandBase(pid) {
    const token = cmdline(pid).split(/\s+/)[0] ?? '';
    return token ? path.basename(token) : '';
}

async function shutdown() {
    for (const daemon of created.filter(item => item.pid)) {
        // Every descendant of this isolated daemon is one we spawned, including
        // a coordinator CLI whose argv does not repeat the daemon port.
        const kids = descendants(daemon.pid);
        const bases = kids.map(commandBase);
        const targets = [daemon.pid, ...kids];
        for (const pid of targets) {
            try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
        }
        const deadline = Date.now() + 8_000;
        while (Date.now() < deadline) {
            let alive = false;
            for (const pid of targets) { try { process.kill(pid, 0); alive = true; } catch { /* gone */ } }
            if (!alive) break;
            await new Promise(r => setTimeout(r, 200));
        }
        const still = [];
        for (const pid of targets) {
            try { process.kill(pid, 0); process.kill(pid, 'SIGKILL'); still.push(pid); } catch { /* gone */ }
        }
        let listening = false;
        try {
            const res = await fetch(`http://127.0.0.1:${daemon.port}/health`);
            listening = res.ok;
        } catch { listening = false; }
        evidence.shutdown.push({ role: daemon.role, pid: daemon.pid, children: kids, childCommands: bases, remaining: descendants(daemon.pid), forced: still, listening });
    }
}

process.on('SIGINT', () => { void shutdown().finally(() => process.exit(130)); });

async function restartSource(daemon) {
    const kids = descendants(daemon.pid);
    try { process.kill(daemon.pid, 'SIGTERM'); } catch { /* already exited */ }
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
        try { process.kill(daemon.pid, 0); await new Promise(r => setTimeout(r, 200)); }
        catch { break; }
    }
    try { process.kill(daemon.pid, 'SIGKILL'); } catch { /* gone */ }
    for (const pid of kids) {
        try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ }
    }
    const log = (await import('node:fs')).createWriteStream(daemon.logPath, { flags: 'a' });
    const child = spawn(NODE, ['--import', 'tsx', 'src/index.ts', '--host', '127.0.0.1', '--port', String(daemon.port), '--token', daemon.token], {
        cwd: STANDALONE,
        env: childEnv(daemon.configDir, daemon.sessionName, daemon.token),
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.pipe(log);
    child.stderr?.pipe(log);
    daemon.pid = child.pid;
    daemon.child = child;
    evidence.processes.push({ role: 'source-restart', pid: child.pid, port: daemon.port, sessionName: daemon.sessionName });
    const boot = Date.now() + 45_000;
    while (Date.now() < boot) {
        try { const res = await fetch(`http://127.0.0.1:${daemon.port}/health`); if (res.ok) return daemon; } catch { /* boot */ }
        await new Promise(r => setTimeout(r, 250));
    }
    throw new Error('source restart did not open /health');
}

// status instance id is not known until a command returns it. Query get_mesh.
async function discoverDaemonId(daemon, meshId) {
    const listed = await command(daemon, 'get_mesh', { meshId });
    const id = listed.body?.mesh?.meshHost?.hostDaemonId || listed.body?.meshHost?.hostDaemonId;
    daemon.statusInstanceId = id;
    return listed;
}

process.exit(await run());

async function run() {
    let code = 1;
    let summary = 'incomplete';
    try {
        const outcome = await exercise();
        code = outcome.code;
        summary = outcome.summary;
    } catch (error) {
        evidence.cases.exception = redactString(error?.stack || error?.message || error);
        code = 1;
        summary = redactString(error?.message || error);
    } finally {
        try { await shutdown(); } catch (error) {
            evidence.cases.shutdownError = redactString(error?.message || error);
        }
    }
    return finish(code, summary);
}

async function exercise() {
    const version = execFileSync('codex', ['--version'], { encoding: 'utf8', env: { ...process.env, HOME: home, CODEX_HOME: codexHome } }).trim();
    evidence.codexVersion = redactString(version).split('\n')[0];
    const repo = gitRepo();
    const source = await startDaemon('source');
    const target = await startDaemon('target');
    const sourceInfo = await command(source, 'get_provider_source_config', {});
    const targetInfo = await command(target, 'get_provider_source_config', {});
    const summarize = (body) => ({ userDirSource: body?.userDirSource, basename: typeof body?.userDir === 'string' ? path.basename(body.userDir) : undefined });
    evidence.providerSource = { source: summarize(sourceInfo.body), target: summarize(targetInfo.body) };
    const userDir = sourceInfo.body?.userDir;
    const targetDir = targetInfo.body?.userDir;
    const accepted = new Set(['sibling-env', 'sibling-marker']);
    const checkout = path.resolve(ROOT, 'adhdev-providers');
    const sameCheckout = typeof userDir === 'string' && typeof targetDir === 'string'
        && path.resolve(userDir) === checkout && path.resolve(targetDir) === checkout;
    let providersHead = '';
    let contractDirty = true;
    try {
        providersHead = execFileSync('git', ['-C', userDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
        contractDirty = execFileSync('git', ['-C', userDir, 'status', '--porcelain', '--', 'cli/codex-cli/provider.v1.json'], { encoding: 'utf8' }).trim() !== '';
    } catch { /* recorded by the contract read below */ }
    evidence.providerSource.head = providersHead;
    evidence.providerSource.contractDirty = contractDirty;
    evidence.providerSource.sameCheckout = sameCheckout;
    if (!accepted.has(sourceInfo.body?.userDirSource) || !accepted.has(targetInfo.body?.userDirSource) || !sameCheckout) {
        evidence.cases.providerPath = { ok: false, actual: true };
        throw new Error('provider path refused before any canary');
    }
        const manifest = JSON.parse(readFileSync(path.join(userDir, 'cli', 'codex-cli', 'provider.v1.json'), 'utf8'));
        const canary = manifest.hostHandoffCanary;
        evidence.loadedContract = {
            providerVersion: manifest.providerVersion, version: canary?.version, enforcement: canary?.enforcement,
            hostTimeoutMs: canary?.hostTimeoutMs, hostMaxOutputBytes: canary?.hostMaxOutputBytes,
            nativeTurnCap: canary?.nativeTurnCap, nativeOutputCap: canary?.nativeOutputTokenCap,
            baseArgsOmitThinking: !JSON.stringify(canary?.args ?? []).includes('thinkingLevel'),
            baseArgsOmitNativeCaps: !JSON.stringify(canary?.args ?? []).includes('maxTurns') && !JSON.stringify(canary?.args ?? []).includes('maxOutputTokens'),
        };
        if (manifest.providerVersion !== '1.1.39' || canary?.enforcement !== 'host' || canary?.hostTimeoutMs !== 15000 || canary?.nativeTurnCap !== false || canary?.nativeOutputTokenCap !== false) {
            evidence.cases.providerPath = { ok: false };
            throw new Error('contract mismatch before any canary');
        }
        evidence.cases.providerPath = { ok: true, actual: true };

        const repoIdentity = 'example.invalid/adhdev/handoff-fixture';
        const remote = 'https://example.invalid/adhdev/handoff-fixture.git';
        const createdSource = await command(source, 'create_mesh', { name: 'Handoff fixture', repoIdentity, repoRemoteUrl: remote, workspace: repo, defaultBranch: 'main' });
        const createdTarget = await command(target, 'create_mesh', { name: 'Handoff fixture member', repoIdentity, repoRemoteUrl: remote, workspace: repo, defaultBranch: 'main' });
        const meshId = createdSource.body?.mesh?.id;
        const memberMeshId = createdTarget.body?.mesh?.id;
        if (!meshId || !memberMeshId) throw new Error('create_mesh failed');
        const sourceNode = await command(source, 'add_mesh_node', { meshId, workspace: repo });
        const targetNode = await command(target, 'add_mesh_node', { meshId: memberMeshId, workspace: repo });
        const tokenRes = await command(source, 'create_mesh_host_pairing_token', { meshId });
        const pairingToken = tokenRes.body?.token;
        rememberSecret(pairingToken);
        await command(target, 'configure_mesh_host_pairing', { meshId: memberMeshId, hostAddress: `127.0.0.1:${source.port}`, token: pairingToken });
        const joined = await command(target, 'join_mesh_host_pairing', { meshId: memberMeshId, hostMeshId: meshId, token: pairingToken });
        const targetNodeId = targetNode.body?.node?.id;
        evidence.cases.pair = { ok: joined.body?.success === true, transport: joined.body?.transport, code: joined.body?.code, targetNodeId };
        if (!evidence.cases.pair.ok || !targetNodeId) throw new Error(`pairing failed: ${joined.body?.error || joined.body?.code}`);
        const sourceMesh = await command(source, 'get_mesh', { meshId });
        const targetDaemonId = (sourceMesh.body?.mesh?.nodes ?? []).map(node => node.daemonId).find(id => id && id !== sourceMesh.body?.mesh?.meshHost?.hostDaemonId);
        evidence.cases.membership = { targetDaemonId: Boolean(targetDaemonId), sourceNode: sourceNode.body?.success === true };
        if (!targetDaemonId) throw new Error('target daemon id was not recorded on the source mesh');

        for (const daemon of [source, target]) {
            const set = await command(daemon, 'launch_defaults_set', { action: 'set', role: 'coordinator', provider: PROVIDER, model: MODEL, expectedRevision: 0 });
            evidence.cases[`launchDefault_${daemon.role}`] = { ok: set.body?.success === true, code: set.body?.code, result: set.body?.result };
            if (set.body?.success !== true) throw new Error(`launch default refused on ${daemon.role}`);
        }
        const memory = await command(source, 'assistant_memory', { action: 'add', target: 'memory', scope: 'project', project: meshId, text: 'preserved project lesson' });
        evidence.cases.memory = { result: memory.body?.result, code: memory.body?.code, ok: memory.body?.success === true };
        if (memory.body?.result === 'staged' && memory.body?.stagedId) {
            const resolved = await command(source, 'assistant_staged_resolve', { action: 'resolve', id: memory.body.stagedId, decision: 'apply' });
            evidence.cases.memoryResolve = { ok: resolved.body?.success === true, result: resolved.body?.result, code: resolved.body?.code };
        }
        const note = await command(source, 'assistant_project_note', { action: 'record', project: meshId, text: 'original approval bytes' });
        evidence.cases.approval = { ok: note.body?.success === true, result: note.body?.result, code: note.body?.code, error: note.body?.error };
        if (note.body?.success !== true || note.body?.result !== 'staged') throw new Error('approval bytes were not staged; preflight was not called');
        const mission = await command(source, 'mission_upsert', { v: 1, meshId, title: 'Handoff preservation', goal: 'Preserve one mission row', status: 'active' });
        evidence.cases.mission = { ok: mission.body?.success === true, id: mission.body?.mission?.id, code: mission.body?.code, error: mission.body?.error };
        const queued = await command(source, 'queue_enqueue', {
            v: 1, meshId, message: 'preserved queue item',
            options: { difficulty: 'easy', notBefore: new Date(Date.now() + 60 * 60 * 1000).toISOString() },
        });
        evidence.cases.queue = { ok: queued.body?.success === true, id: Boolean(queued.body?.entry?.id), code: queued.body?.code, error: queued.body?.error };
        if (queued.body?.success !== true) throw new Error('queue item was not stored; preflight was not called');
        const opened = await command(source, 'turn_observe', { v: 1, evidence: {
            kind: 'dispatch_accepted', eventId: `ev-open-${TASK}`, at: Date.now(), source: 'dispatch', sessionId: `sess-${TASK}`,
            observedBy: 'handoff-smoke', scope: 'mesh_queue', messageId: `msg-${TASK}`, meshId, taskId: `task-${TASK}`,
        } });
        const reported = await command(source, 'turn_observe', { v: 1, evidence: {
            kind: 'worker_report', eventId: `ev-report-${TASK}`, at: Date.now(), source: 'operator', sessionId: `sess-${TASK}`,
            observedBy: 'handoff-smoke', attemptRef: opened.body?.attemptRef, outcome: 'failed', hasHandoffNotes: false,
        } });
        evidence.cases.history = {
            synthetic: true, open: opened.body?.verdict, report: reported.body?.verdict, outcome: reported.body?.outcome, error: reported.body?.error,
        };
        if (reported.body?.outcome !== 'failed') throw new Error('history turn stayed open; preflight was not called');

        const negative = await command(source, 'mesh_host_handoff', { op: 'preflight', meshId, targetDaemonId: `not-a-member-${TASK}`, targetNodeId });
        evidence.authInvocations += countCanaries(negative.body);
        evidence.cases.nonMemberPreflight = {
            ok: negative.body?.ok === false,
            code: negative.body?.checks?.find(check => check.ok === false)?.code,
            canaries: countCanaries(negative.body),
        };
        if (evidence.cases.nonMemberPreflight.ok !== true || evidence.cases.nonMemberPreflight.canaries !== 0) {
            throw new Error('non-member preflight did not fail closed before a canary');
        }
        const unknownAbort = await command(source, 'mesh_host_handoff', { op: 'abort', meshId, handoffId: `absent-${TASK}` });
        evidence.cases.unknownAbort = { refused: unknownAbort.body?.success !== true, code: unknownAbort.body?.code };

        const preflight = await command(source, 'mesh_host_handoff', { op: 'preflight', meshId, targetDaemonId, targetNodeId }, 55_000);
        evidence.authInvocations += countCanaries(preflight.body);
        evidence.cases.preflight = { ok: preflight.body?.ok === true, checks: redact(preflight.body?.checks), code: preflight.body?.code };
        save();
        if (preflight.body?.ok !== true) {
            evidence.cases.start = { called: false, reason: 'preflight failed' };
            return { code: 1, summary: 'preflight failed; start was not called' };
        }
        const started = await command(source, 'mesh_host_handoff', { op: 'start', meshId, targetDaemonId, targetNodeId }, 300_000);
        evidence.authInvocations += countCanaries(started.body);
        const handoffId = started.body?.handoffId;
        evidence.cases.start = { called: true, ok: started.body?.success === true, phase: started.body?.phase, code: started.body?.code, handoffId };
        let status = null;
        const terminal = new Set(['committed', 'aborted']);
        const readPhase = (body) => ({ source: body?.source?.phase, target: body?.evidence?.target?.phase });
        if (handoffId) {
            // Activation includes another bounded canary and the target launch.
            // Do not restart the source while that reply is still in flight.
            const deadline = Date.now() + 180_000;
            do {
                status = await command(source, 'mesh_host_handoff', { op: 'status', handoffId, meshId });
                const phases = readPhase(status.body);
                if (terminal.has(phases.source) || phases.target === 'discarded') break;
                if (phases.target === 'active' && phases.source !== 'activating') break;
                await new Promise(r => setTimeout(r, 2000));
            } while (Date.now() < deadline);
            if (readPhase(status?.body).source === 'uncertain' || readPhase(status?.body).source === 'activating') {
                const retried = await command(source, 'mesh_host_handoff', { op: 'retry', handoffId, meshId }, 120_000);
                evidence.cases.recoveryRetry = { ok: retried.body?.success === true, phase: retried.body?.phase, code: retried.body?.code };
                const recoveryDeadline = Date.now() + 90_000;
                do {
                    status = await command(source, 'mesh_host_handoff', { op: 'status', handoffId, meshId });
                    const phases = readPhase(status.body);
                    if (terminal.has(phases.source) || phases.target === 'active' || phases.target === 'discarded') break;
                    await new Promise(r => setTimeout(r, 2000));
                } while (Date.now() < recoveryDeadline);
            }
        }
        evidence.cases.finalStatus = redact(status?.body);
        const activatedNow = () => status?.body?.source?.phase === 'committed' || status?.body?.evidence?.target?.phase === 'active';
        if (handoffId && activatedNow()) {
            const censusDeadline = Date.now() + 90_000;
            let observation = status?.body?.evidence?.target?.observation;
            while (Date.now() < censusDeadline && observation?.ready !== true) {
                await new Promise(r => setTimeout(r, 2000));
                status = await command(source, 'mesh_host_handoff', { op: 'status', handoffId, meshId });
                observation = status?.body?.evidence?.target?.observation;
                if (observation?.ready === true) break;
            }
            evidence.cases.finalStatus = redact(status?.body);
            evidence.cases.launchCensus = {
                ready: observation?.ready === true,
                runtimeVerified: observation?.runtimeVerified === true,
                liveCount: Number.isInteger(observation?.liveCount) ? observation.liveCount : null,
                sessionSeen: typeof observation?.sessionId === 'string' && observation.sessionId.length > 0,
            };
        }
        const stoppedSessionIds = status?.body?.evidence?.sourceStopProof?.sessionIds ?? [];
        evidence.cases.stopReceipt = {
            sourceStopped: status?.body?.evidence?.sourceStopped === true,
            sessionIds: stoppedSessionIds.length,
            sourcePhase: status?.body?.source?.phase,
            targetPhase: status?.body?.target?.phase,
        };
        const transcripts = [];
        for (const sessionId of stoppedSessionIds) {
            const read = await command(source, 'read_chat', { targetSessionId: sessionId });
            transcripts.push({ ok: read.body?.success === true, code: read.body?.code });
        }
        evidence.cases.stoppedTranscripts = transcripts;
        const restarted = await restartSource(source);
        const refused = await command(restarted, 'queue_enqueue', { v: 1, meshId, message: 'must refuse after handoff' });
        evidence.cases.sourceWriteAfterRestart = { refused: refused.body?.success !== true, code: refused.body?.code };
        evidence.cases.collision = {
            exercised: false,
            reason: 'exact mesh id is chosen before retarget, so the live apply path does not throw handoff mesh id collision',
        };
        save();
        const activated = evidence.cases.stopReceipt.sourcePhase === 'committed' || evidence.cases.finalStatus?.evidence?.target?.phase === 'active';
        evidence.cases.activation = { activated, sourcePhase: evidence.cases.stopReceipt.sourcePhase, targetPhase: evidence.cases.finalStatus?.evidence?.target?.phase };
        const ok = evidence.cases.preflight.ok && evidence.cases.start.ok && activated && evidence.cases.launchCensus?.ready === true && evidence.cases.stopReceipt.sourceStopped === true && evidence.cases.sourceWriteAfterRestart.refused === true;
        const summary = ok
            ? 'live handoff activated on the target, the coordinator census was ready, the source stopped first, and the restarted source refused a write'
            : (activated ? 'live handoff activated but the target coordinator census was not ready' : 'live handoff did not activate on the target');
        return { code: ok ? 0 : 1, summary };
}
