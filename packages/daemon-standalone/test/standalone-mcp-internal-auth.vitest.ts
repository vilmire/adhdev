/**
 * Loopback-only credentials for the MCP servers a token- / password-gated
 * standalone daemon launches (daemon-core standalone-mcp-auth.ts).
 *
 * Live repro (2026-10-08, two-machine standalone mesh on Linux): a daemon
 * started with `--token` answered 401 to the worker's adhdev-mesh MCP, which
 * printed "Cannot reach local daemon" and exited 1 — task_failed session_exit.
 * The coordinator / assistant MCP hit the same wall.
 *
 * Worker scope = the worker's own session bind: worker verbs + a liveness-only
 * status, nothing else. Coordinator scope = the per-boot internal token:
 * status + the command API, nothing else. Both refused from a non-loopback
 * peer; no credential is still 401. Real HTTP server over a real
 * StandaloneHttpApi.
 */
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

process.env.ADHDEV_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'adhdev-sa-mcp-auth-'));

let mod: typeof import('../src/standalone-http.js');
let authFileMod: typeof import('../src/standalone-mcp-internal-auth.js');

beforeAll(async () => {
  mod = await import('../src/standalone-http.js');
  authFileMod = await import('../src/standalone-mcp-internal-auth.js');
});

const DASHBOARD_TOKEN = 'dashboard-token';
const INTERNAL = 'adi_internal_token_for_test';
const LIVE_BIND = 'wsb_live_bind';

const WORKER_HEADER = 'x-adhdev-worker-credential';
const INTERNAL_HEADER = 'x-adhdev-internal-auth';

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((resolve) => {
    s.closeAllConnections?.();
    s.close(() => resolve());
  })));
});

async function startServer(opts: { remoteAddress?: string } = {}): Promise<{ base: string; calls: string[] }> {
  const calls: string[] = [];
  const http = new mod.StandaloneHttpApi({
    isReady: () => true,
    getStatus: () => ({ full: 'snapshot', sessions: ['s1'] }) as any,
    executeCommand: async (type) => {
      calls.push(type);
      return { success: true, type };
    },
    rawTerminalService: () => ({}) as any,
    interactivePromptService: () => ({}) as any,
    isCliSession: () => false,
    createSessionHostClient: async () => ({}) as any,
    verifyWorkerCredential: (credential) => credential === LIVE_BIND,
  });
  http.configureAuth(DASHBOARD_TOKEN);
  http.internalAuthToken = INTERNAL;
  const server = createServer((req, res) => {
    if (opts.remoteAddress) {
      Object.defineProperty(req.socket, 'remoteAddress', { value: opts.remoteAddress, configurable: true });
    }
    http.handle(req, res);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no port');
  return { base: `http://127.0.0.1:${addr.port}`, calls };
}

function status(base: string, headers: Record<string, string> = {}) {
  return fetch(`${base}/api/v1/status`, { headers });
}

function command(base: string, type: string, headers: Record<string, string> = {}) {
  return fetch(`${base}/api/v1/command`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ type, payload: { bind: LIVE_BIND } }),
  });
}

describe('standalone HTTP gate — daemon-launched MCP credentials', () => {
  it('no credential is still 401 on a gated daemon', async () => {
    const { base, calls } = await startServer();
    expect((await status(base)).status).toBe(401);
    expect((await command(base, 'worker_progress_update')).status).toBe(401);
    expect(calls).toEqual([]);
  });

  it('the dashboard token still works unchanged', async () => {
    const { base, calls } = await startServer();
    const res = await status(base, { Authorization: `Bearer ${DASHBOARD_TOKEN}` });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ full: 'snapshot', sessions: ['s1'] });
    expect((await command(base, 'launch_cli', { Authorization: `Bearer ${DASHBOARD_TOKEN}` })).status).toBe(200);
    expect(calls).toEqual(['launch_cli']);
  });

  it('worker credential: worker verbs pass, status is liveness-only', async () => {
    const { base, calls } = await startServer();
    const h = { [WORKER_HEADER]: LIVE_BIND };
    const st = await status(base, h);
    expect(st.status).toBe(200);
    expect(await st.json()).toEqual({ ok: true, scope: 'worker' });
    for (const verb of ['worker_report_completion', 'worker_progress_update', 'worker_peer_context_pull', 'worker_drain_mailbox', 'git_status', 'git_diff_summary', 'git_diff_file', 'git_log']) {
      expect((await command(base, verb, h)).status, verb).toBe(200);
    }
    expect(calls).toEqual(['worker_report_completion', 'worker_progress_update', 'worker_peer_context_pull', 'worker_drain_mailbox', 'git_status', 'git_diff_summary', 'git_diff_file', 'git_log']);
  });

  it('worker credential: every other verb and route is refused', async () => {
    const { base, calls } = await startServer();
    const h = { [WORKER_HEADER]: LIVE_BIND };
    for (const verb of ['launch_cli', 'mesh_status', 'mesh_relay_command', 'send_chat', 'git_push']) {
      const res = await command(base, verb, h);
      expect(res.status, verb).toBe(403);
      expect(((await res.json()) as { code?: string }).code).toBe('worker_scope_forbidden');
    }
    expect((await fetch(`${base}/api/v1/providers/installed`, { headers: h })).status).toBe(403);
    expect(calls).toEqual([]);
  });

  it('an unknown / revoked worker bind is 401', async () => {
    const { base, calls } = await startServer();
    const h = { [WORKER_HEADER]: 'wsb_forged' };
    expect((await status(base, h)).status).toBe(401);
    expect((await command(base, 'worker_progress_update', h)).status).toBe(401);
    expect(calls).toEqual([]);
  });

  it('coordinator credential: full status and the command API, nothing else', async () => {
    const { base, calls } = await startServer();
    const h = { [INTERNAL_HEADER]: INTERNAL };
    const st = await status(base, h);
    expect(st.status).toBe(200);
    expect(await st.json()).toEqual({ full: 'snapshot', sessions: ['s1'] });
    expect((await command(base, 'mesh_status', h)).status).toBe(200);
    expect((await command(base, 'mesh_relay_command', h)).status).toBe(200);
    expect(calls).toEqual(['mesh_status', 'mesh_relay_command']);
    expect((await fetch(`${base}/api/v1/providers/installed`, { headers: h })).status).toBe(403);
    // Settings routes keep their own dashboard-only check.
    const prefs = await fetch(`${base}/api/v1/standalone/preferences`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...h },
      body: JSON.stringify({ standaloneBindHost: '0.0.0.0' }),
    });
    expect(prefs.status).toBe(401);
  });

  it('a wrong internal token is 401', async () => {
    const { base } = await startServer();
    expect((await status(base, { [INTERNAL_HEADER]: `${INTERNAL}x` })).status).toBe(401);
  });

  it('both credentials are refused from a non-loopback peer', async () => {
    const { base, calls } = await startServer({ remoteAddress: '10.0.0.5' });
    expect((await status(base, { [INTERNAL_HEADER]: INTERNAL })).status).toBe(401);
    expect((await command(base, 'mesh_status', { [INTERNAL_HEADER]: INTERNAL })).status).toBe(401);
    expect((await status(base, { [WORKER_HEADER]: LIVE_BIND })).status).toBe(401);
    expect((await command(base, 'worker_progress_update', { [WORKER_HEADER]: LIVE_BIND })).status).toBe(401);
    expect(calls).toEqual([]);
    // The dashboard token is not a loopback-only credential.
    expect((await status(base, { Authorization: `Bearer ${DASHBOARD_TOKEN}` })).status).toBe(200);
  });

  it('an IPv4-mapped loopback peer counts as loopback', async () => {
    const { base } = await startServer({ remoteAddress: '::ffff:127.0.0.1' });
    expect((await status(base, { [INTERNAL_HEADER]: INTERNAL })).status).toBe(200);
  });
});

describe('per-boot MCP auth file', () => {
  it('is written owner-only and replaced atomically per boot', () => {
    const dir = mkdtempSync(join(tmpdir(), 'adhdev-sa-mcp-auth-file-'));
    const file = authFileMod.standaloneMcpAuthFilePath(dir, 3847);
    const first = authFileMod.mintStandaloneMcpInternalToken();
    const second = authFileMod.mintStandaloneMcpInternalToken();
    expect(first).not.toBe(second);
    authFileMod.writeStandaloneMcpAuthFile(file, first);
    expect(readFileSync(file, 'utf8')).toBe(first);
    authFileMod.writeStandaloneMcpAuthFile(file, second);
    expect(readFileSync(file, 'utf8')).toBe(second);
    if (process.platform !== 'win32') {
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }
  });
});

describe('captureOwnerAuthGuard — bearer token + password auth coexistence and live revocation', () => {
  it('binds live owner proof to the actual credential mode (token vs password session) and revokes on logout or credential change', async () => {
    const authMod = await import('../src/standalone-auth.js');
    const coreMod = await import('@adhdev/daemon-core');
    const seenArgs: Array<Record<string, unknown>> = [];
    const http = new mod.StandaloneHttpApi({
      isReady: () => true,
      getStatus: () => ({ ok: true }) as any,
      executeCommand: async (_type, payload) => {
        seenArgs.push(payload);
        const proof = coreMod.readTrustedOwnerIngressProof(payload, 'standalone');
        return { success: true, trusted: Boolean(proof) };
      },
      rawTerminalService: () => ({}) as any,
      interactivePromptService: () => ({}) as any,
      isCliSession: () => false,
      createSessionHostClient: async () => ({}) as any,
      verifyWorkerCredential: (credential) => credential === LIVE_BIND,
    });
    http.configureAuth(DASHBOARD_TOKEN);
    http.passwordConfig = authMod.createPasswordRecord('fixture-password');
    http.internalAuthToken = INTERNAL;

    const server = createServer((req, res) => http.handle(req, res));
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no port');
    const base = `http://127.0.0.1:${addr.port}`;

    // Configured bearer token succeeds as owner even when passwordConfig also exists
    const tokenRes = await command(base, 'select_session', { Authorization: `Bearer ${DASHBOARD_TOKEN}` });
    expect(tokenRes.status).toBe(200);
    expect(await tokenRes.json()).toMatchObject({ success: true, trusted: true });
    const tokenArgs = seenArgs.at(-1)!;
    expect(coreMod.readTrustedOwnerIngressProof(tokenArgs, 'standalone')).toBeTruthy();

    // Internal MCP header cannot inherit owner proof even when bearer token is also supplied
    const internalRes = await command(base, 'select_session', {
      Authorization: `Bearer ${DASHBOARD_TOKEN}`,
      [INTERNAL_HEADER]: INTERNAL,
    });
    expect(internalRes.status).toBe(200);
    expect(await internalRes.json()).toMatchObject({ success: true, trusted: false });

    // Password-session cookie also succeeds as owner and revokes on logout
    const loginRes = await fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'fixture-password' }),
    });
    expect(loginRes.status).toBe(200);
    // Login bumps authEpoch, revoking the earlier token-mode proof
    expect(coreMod.readTrustedOwnerIngressProof(tokenArgs, 'standalone')).toBeNull();

    const setCookie = loginRes.headers.get('set-cookie') || '';
    const cookiePair = setCookie.split(';')[0] || '';
    const cookieCmdRes = await command(base, 'select_session', { Cookie: cookiePair });
    expect(cookieCmdRes.status).toBe(200);
    expect(await cookieCmdRes.json()).toMatchObject({ success: true, trusted: true });
    const cookieArgs = seenArgs.at(-1)!;
    expect(coreMod.readTrustedOwnerIngressProof(cookieArgs, 'standalone')).toBeTruthy();

    // Logout revokes the active password-session proof immediately
    const logoutRes = await fetch(`${base}/auth/logout`, {
      method: 'POST',
      headers: { Cookie: cookiePair },
    });
    expect(logoutRes.status).toBe(200);
    expect(coreMod.readTrustedOwnerIngressProof(cookieArgs, 'standalone')).toBeNull();
  });

  it('F1 consumer: StandaloneHttpApi + DaemonCommandRouter enforces live owner proof, revoked-to-ipc downgrade refusal, and worker/coordinator MCP IPC scopes across all 7 artifact aliases', async () => {
    const fsMod = await import('node:fs');
    const authMod = await import('../src/standalone-auth.js');
    const coreMod = await import('@adhdev/daemon-core');
    const { ArtifactStore } = await import('../../daemon-core/src/artifacts/index.js');
    const { setArtifactCommandRuntimeForDeps } = await import('../../daemon-core/src/commands/med-family/artifacts.js');
    const { DaemonCommandRouter } = await import('../../daemon-core/src/commands/router.js');
    const { MeshRuntimeStore } = await import('../../daemon-core/src/mesh/mesh-runtime-store.js');
    const { SessionRegistry } = await import('../../daemon-core/src/sessions/registry.js');
    const { mintWorkerSessionBind, mintWorkerTaskToken, __resetWorkerSessionBindsForTest, __resetWorkerTaskTokensForTest } = await import('../../daemon-core/src/mesh/worker-mcp-isolation.js');
    const { isLiveWorkerMcpCredential, matchesLiveArtifactWorkerCredential } = await import('../../daemon-core/src/standalone-mcp-auth-verify.js');
    const { seedMeshAttempt } = await import('../../daemon-core/test/helpers/turn-attempt-seed.js');
    const { registerMeshCoordinator, unregisterMeshCoordinator } = await import('../../daemon-core/src/mesh/coordinator-registry.js');
    const { configureTranscriptProjection, __resetTranscriptProjectionForTests } = await import('../../daemon-core/src/seqscribe/transcript-publisher.js');

    const tempRoot = mkdtempSync(join(tmpdir(), 'adhdev-f1-sa-artifacts-'));
    const workspaceDir = join(tempRoot, 'workspace');
    const foreignDir = join(tempRoot, 'foreign');
    fsMod.mkdirSync(workspaceDir, { recursive: true });
    fsMod.mkdirSync(foreignDir, { recursive: true });
    fsMod.writeFileSync(join(workspaceDir, 'doc.md'), 'STANDALONE-SECRET-DOC', 'utf8');
    fsMod.writeFileSync(join(foreignDir, 'foreign.md'), 'FOREIGN-STANDALONE-SECRET', 'utf8');

    const sessionRegistry = new SessionRegistry();
    sessionRegistry.register({
      sessionId: 'coord-sa',
      parentSessionId: null,
      providerType: 'claude-cli',
      transport: 'pty',
      workspace: workspaceDir,
    });
    sessionRegistry.register({
      sessionId: 'worker-sa',
      parentSessionId: 'coord-sa',
      providerType: 'codex-cli',
      transport: 'pty',
      workspace: workspaceDir,
    });
    sessionRegistry.register({
      sessionId: 'foreign-sa',
      parentSessionId: null,
      providerType: 'claude-cli',
      transport: 'pty',
      workspace: foreignDir,
    });

    MeshRuntimeStore.resetForTests();
    configureTranscriptProjection({
      daemonId: () => 'test-sa-daemon',
      writerId: () => 'test-sa-writer',
      epoch: 'test-sa-epoch',
      appendChatFrame: async () => {},
    });
    const meshStore = MeshRuntimeStore.getInstance();
    const artifactStore = new ArtifactStore(meshStore.db);
    const now = new Date().toISOString();
    meshStore.insertQueueEntry({
      id: 'task-sa-1',
      meshId: 'mesh-sa',
      message: 'sa worker task',
      status: 'assigned',
      assignedSessionId: 'worker-sa',
      attemptId: 'att-sa-1',
      workspace: workspaceDir,
      createdAt: now,
      updatedAt: now,
    } as any);
    seedMeshAttempt({
      meshId: 'mesh-sa',
      taskId: 'task-sa-1',
      sessionId: 'worker-sa',
      attemptId: 'att-sa-1',
      attemptNo: 0,
      stage: 'generating',
    });

    const workerToken = mintWorkerTaskToken({
      meshId: 'mesh-sa',
      taskId: 'task-sa-1',
      sessionId: 'worker-sa',
      attemptId: 'att-sa-1',
    });
    const workerBind = mintWorkerSessionBind({
      meshId: 'mesh-sa',
      sessionId: 'worker-sa',
    });
    meshStore.insertQueueEntry({
      id: 'foreign-task', meshId: 'foreign-mesh', message: 'foreign fixture task',
      status: 'assigned', assignedSessionId: 'foreign-sa', attemptId: 'foreign-attempt',
      workspace: foreignDir, createdAt: now, updatedAt: now,
    } as any);
    seedMeshAttempt({ meshId: 'foreign-mesh', taskId: 'foreign-task', sessionId: 'foreign-sa', attemptId: 'foreign-attempt', attemptNo: 0, stage: 'generating' });
    const foreignWorkerToken = mintWorkerTaskToken({ meshId: 'foreign-mesh', taskId: 'foreign-task', sessionId: 'foreign-sa', attemptId: 'foreign-attempt' });

    registerMeshCoordinator({
      meshId: 'mesh-sa',
      sessionId: 'coord-sa',
      workspace: workspaceDir,
      startedAt: Date.now(),
    });

    artifactStore.register({
      sessionId: 'foreign-sa',
      workspaceRoot: foreignDir,
      path: 'foreign.md',
    });

    const deps: any = {
      commandHandler: {
        rejectUnknown: async (cmd: string) => ({ success: false, error: `Unknown command: ${cmd}` }),
      },
      cliManager: {},
      cdpManagers: new Map(),
      providerLoader: {},
      instanceManager: { listInstanceIds: () => [] },
      detectedIdes: { value: [] },
      sessionRegistry,
      statusInstanceId: 'daemon_mach_f1_sa',
    };
    setArtifactCommandRuntimeForDeps(deps, {
      artifactStore,
      meshRuntimeStore: meshStore,
    });
    const router = new DaemonCommandRouter(deps);

    let beforeArtifactDispatch: (() => void) | undefined;
    const capturedPayloads: Array<Record<string, unknown>> = [];
    const http = new mod.StandaloneHttpApi({
      isReady: () => true,
      getStatus: () => ({ ok: true }) as any,
      executeCommand: async (type, payload, source, opts) => {
        capturedPayloads.push(payload);
        const verifyCurrentOwner = typeof opts?.verifyCurrentOwner === 'function' ? opts.verifyCurrentOwner : undefined;
        let currentOwnerOk = true;
        if (verifyCurrentOwner) {
          try {
            currentOwnerOk = verifyCurrentOwner() === true;
          } catch {
            currentOwnerOk = false;
          }
        }
        const attachedProof = currentOwnerOk ? coreMod.readTrustedOwnerIngressProof(payload, 'standalone') : null;
        const explicitProof = currentOwnerOk && opts?.ownerProof && coreMod.isValidTrustedOwnerIngressProof(opts.ownerProof, 'standalone')
          ? opts.ownerProof
          : null;
        const ownerProof = attachedProof ?? explicitProof;
        const isOwner = source === 'standalone' && opts?.ownerVerified === true && currentOwnerOk && Boolean(ownerProof);
        const effectiveSource = isOwner ? 'standalone' : 'ipc';
        // Same copy primitive as the production host's toArgsRecord; retain
        // authenticated MCP context as well as owner transport context.
        const forwardedPayload = coreMod.preserveTrustedOwnerTransportProof(
          payload, { ...payload, _interactionId: 'itx-f1-sa' },
        );
        if (type === 'artifact_register' && beforeArtifactDispatch) {
          const hook = beforeArtifactDispatch;
          beforeArtifactDispatch = undefined;
          hook();
        }
        return router.execute(type, forwardedPayload, effectiveSource, {
          ownerVerified: isOwner ? true : opts?.ownerVerified,
          ...(ownerProof ? { ownerProof } : {}),
          ...(verifyCurrentOwner ? { verifyCurrentOwner } : {}),
        });
      },
      rawTerminalService: () => ({}) as any,
      interactivePromptService: () => ({}) as any,
      isCliSession: () => false,
      createSessionHostClient: async () => ({}) as any,
      verifyWorkerCredential: isLiveWorkerMcpCredential,
      verifyArtifactWorkerCredential: matchesLiveArtifactWorkerCredential,
    });
    http.configureAuth(DASHBOARD_TOKEN);
    http.passwordConfig = authMod.createPasswordRecord('fixture-password');
    http.internalAuthToken = INTERNAL;

    const server = createServer((req, res) => http.handle(req, res));
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no port');
    const base = `http://127.0.0.1:${addr.port}`;

    const postCmd = (type: string, payload: Record<string, unknown>, headers: Record<string, string> = {}) =>
      fetch(`${base}/api/v1/command`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({ type, payload }),
      });

    const allAliases = [
      'artifact_register',
      'session_artifact_register',
      'artifact_list',
      'session_artifact_list',
      'artifact_fetch',
      'artifact_read',
      'session_artifact_fetch',
    ] as const;

    try {
      // 1. Worker MCP loopback positive control: artifact_register with worker credential header + bind
      const workerRegRes = await postCmd(
        'artifact_register',
        { bind: workerBind.bind, path: 'doc.md' },
        { [WORKER_HEADER]: workerBind.bind },
      );
      expect(workerRegRes.status).toBe(200);
      const workerRegJson = (await workerRegRes.json()) as any;
      expect(workerRegJson.success).toBe(true);
      const workerArtId = String(workerRegJson.artifactId);

      // A verified worker header is not a standard IPC credential. Missing,
      // forged or cross-principal body credentials cannot select another session.
      const deniedWorkerScopes: Array<{ status: number; success: boolean; artifactSession: string | null }> = [];
      for (const payload of [
        { sessionId: 'foreign-sa', path: 'foreign.md' },
        { sessionId: 'coord-sa', path: 'doc.md', bind: 'forged' },
        { bind: workerBind.bind, token: foreignWorkerToken.token, path: 'foreign.md' },
      ]) {
        const response = await postCmd('artifact_register', payload, { [WORKER_HEADER]: workerBind.bind });
        const denied = await response.json() as any;
        deniedWorkerScopes.push({ status: response.status, success: denied.success, artifactSession: denied.artifact?.sessionId ?? null });
      }
      expect(deniedWorkerScopes).toEqual(Array.from({ length: 3 }, () => ({ status: 403, success: false, artifactSession: null })));
      const workerTokenPositive = await postCmd('artifact_register', { token: workerToken.token, bind: workerBind.bind, path: 'doc.md' }, { [WORKER_HEADER]: workerToken.token });
      expect(workerTokenPositive.status).toBe(200);
      expect(await workerTokenPositive.json()).toMatchObject({ success: true, sessionId: 'worker-sa' });

      // The exact recovery regression: real standard helpers over authenticated HTTP.
      const artifactToolsSource = fileURLToPath(new URL('../../mcp-server/src/tools/artifact-tools.ts', import.meta.url));
      const standardTools = await import(/* @vite-ignore */ artifactToolsSource);
      const standardTransport = { command: async (type: string, payload: Record<string, unknown>) => {
        const response = await postCmd(type, payload, { [INTERNAL_HEADER]: INTERNAL });
        expect(response.status).toBe(200);
        return response.json();
      }} as any;
      const workerTransport = { command: async (type: string, payload: Record<string, unknown>) => {
        const response = await postCmd(type, payload, { [WORKER_HEADER]: workerBind.bind });
        expect(response.status).toBe(200);
        return response.json();
      }} as any;
      const workerHelper = JSON.parse(await standardTools.callWorkerArtifactRegister(
        workerTransport, { bind: workerBind.bind, token: workerToken.token },
        { path: 'doc.md', sessionId: 'foreign-sa', workspaceRoot: foreignDir, bind: 'forged' },
      ));
      expect(workerHelper).toMatchObject({ success: true, sessionId: 'worker-sa' });
      const standardRegister = JSON.parse(await standardTools.callStandardArtifactRegister(
        standardTransport, { session_id: 'coord-sa', path: 'doc.md' },
      ));
      expect(standardRegister.success).toBe(true);
      const standardList = JSON.parse(await standardTools.callStandardArtifactList(
        standardTransport, { session_id: 'coord-sa' },
      ));
      expect(standardList.success).toBe(true);
      expect(standardList.artifacts[0].artifactId).toBe(standardRegister.artifactId);
      const standardListPayload = capturedPayloads.at(-1)!;
      expect(coreMod.isTrustedOwnerIngress(standardListPayload)).toBe(false);
      expect(coreMod.readTrustedOwnerIngressProof(standardListPayload)).toBeNull();

      // Registered-session standard operations include the existing aliases,
      // but the internal MCP context does not grant owner-only fetch/history.
      for (const alias of ['artifact_register', 'session_artifact_register', 'artifact_list', 'session_artifact_list']) {
        const response = await postCmd(alias, { sessionId: 'coord-sa', path: 'doc.md' }, { [INTERNAL_HEADER]: INTERNAL });
        expect((await response.json() as any).success, alias).toBe(true);
      }
      for (const payload of [
        { sessionId: 'unregistered-sa' },
        { sessionId: 'coord-sa', callerSessionId: 'foreign-sa' },
        { sessionId: 'coord-sa', workspaceRoot: foreignDir },
        { sessionId: 'worker-sa', meshId: 'mesh-sa', taskId: 'task-sa-1' },
        { sessionId: 'worker-sa', attemptId: 'att-sa-1' },
        { sessionId: 'worker-sa', nodeId: 'node-sa' },
      ]) {
        const response = await postCmd('artifact_list', payload, { [INTERNAL_HEADER]: INTERNAL });
        expect((await response.json() as any).success).toBe(false);
      }
      // A real capability cannot be replayed with a different target, command,
      // workspace override, or changed file request, even by a trusted copy.
      for (const change of [
        { sessionId: 'foreign-sa' }, { workspaceRoot: foreignDir }, { meshId: 'foreign-mesh' },
      ]) {
        const replay = coreMod.preserveAuthenticatedMcpCommand(standardListPayload, { ...standardListPayload, ...change });
        expect(await router.execute('artifact_list', replay, 'ipc')).toMatchObject({ success: false, code: 'COMMAND_SOURCE_REJECTED' });
      }
      const wrongOperation = coreMod.preserveAuthenticatedMcpCommand(standardListPayload, { ...standardListPayload });
      expect(await router.execute('session_artifact_list', wrongOperation, 'ipc')).toMatchObject({ success: false, code: 'COMMAND_SOURCE_REJECTED' });
      const serialized = JSON.parse(JSON.stringify(standardListPayload));
      expect(await router.execute('artifact_list', serialized, 'ipc')).toMatchObject({ success: false, code: 'COMMAND_SOURCE_REJECTED' });
      for (const alias of allAliases) {
        const alteredScope = coreMod.preserveAuthenticatedMcpCommand(standardListPayload, { ...standardListPayload, sessionId: 'foreign-sa' });
        expect(await router.execute(alias, alteredScope, 'ipc')).toMatchObject({ success: false, code: 'COMMAND_SOURCE_REJECTED' });
        for (const headers of [{}, { [INTERNAL_HEADER]: 'invalid' }] as Array<Record<string, string>>) {
          const response = await postCmd(alias, { sessionId: 'coord-sa', mcpVerified: true, internalScope: 'coordinator' }, headers);
          expect(response.status).toBe(401);
        }
      }

      // 2. Coordinator MCP loopback positive & negative controls via x-adhdev-internal-auth
      const coordListOk = await postCmd(
        'artifact_list',
        { sessionId: 'worker-sa', meshId: 'mesh-sa' },
        { [INTERNAL_HEADER]: INTERNAL },
      );
      expect(coordListOk.status).toBe(200);
      expect(await coordListOk.json()).toMatchObject({ success: true });

      const coordinatorContext = {
        coordinatorSessionId: 'coord-sa',
        mesh: { id: 'mesh-sa', nodes: [{ id: 'node-sa', sessionId: 'worker-sa' }] },
        transport: standardTransport,
      } as any;
      const helperCoordList = JSON.parse(await standardTools.callCoordinatorArtifactList(coordinatorContext, { session_id: 'worker-sa' }));
      expect(helperCoordList.success).toBe(true);
      const helperForeign = JSON.parse(await standardTools.callCoordinatorArtifactList(coordinatorContext, { session_id: 'foreign-sa' }));
      expect(helperForeign.success).toBe(false);

      const coordListForeign = await postCmd(
        'artifact_list',
        { sessionId: 'foreign-sa', meshId: 'mesh-sa' },
        { [INTERNAL_HEADER]: INTERNAL },
      );
      expect(await coordListForeign.json()).toMatchObject({
        success: false,
        code: 'artifact_session_mismatch',
      });

      for (const fetchAlias of ['artifact_fetch', 'artifact_read', 'session_artifact_fetch'] as const) {
        const coordFetch = await postCmd(
          fetchAlias,
          { sessionId: 'worker-sa', meshId: 'mesh-sa', artifactId: workerArtId },
          { [INTERNAL_HEADER]: INTERNAL },
        );
        expect(await coordFetch.json()).toMatchObject({
          success: false,
          code: 'COMMAND_SOURCE_REJECTED',
        });
      }

      // 3. Standalone owner positive control across all 7 aliases via password session cookie
      const loginRes = await fetch(`${base}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'fixture-password' }),
      });
      expect(loginRes.status).toBe(200);
      const cookiePair = (loginRes.headers.get('set-cookie') || '').split(';')[0] || '';

      for (const cmd of allAliases) {
        const res = await postCmd(
          cmd,
          { sessionId: 'worker-sa', artifactId: workerArtId, path: 'doc.md' },
          { Cookie: cookiePair },
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as any;
        expect(body.success, `standalone owner ${cmd}`).toBe(true);
      }

      // Capture a live owner-proof-attached payload before logout, then logout to revoke it
      const livePayload = capturedPayloads.at(-1)!;
      expect(coreMod.readTrustedOwnerIngressProof(livePayload, 'standalone')).toBeTruthy();

      const logoutRes = await fetch(`${base}/auth/logout`, {
        method: 'POST',
        headers: { Cookie: cookiePair },
      });
      expect(logoutRes.status).toBe(200);

      // 4. Post-logout / revoked owner proof downgraded to ipc must fail closed across all 7 aliases
      for (const cmd of allAliases) {
        const res = await router.execute(cmd, livePayload, 'ipc', { ownerVerified: false });
        expect(res.success, `post-logout downgraded ipc ${cmd}`).toBe(false);
        expect(res.code, `post-logout downgraded ipc ${cmd}`).toBe('COMMAND_SOURCE_REJECTED');
      }
      // Revoking the actual internal credential invalidates preserved in-process
      // authority immediately; it cannot fall back to ordinary IPC admission.
      const oldEpochCopy = coreMod.preserveTrustedOwnerTransportProof(standardListPayload, { ...standardListPayload });
      expect(await router.execute('artifact_list', oldEpochCopy, 'ipc')).toMatchObject({ success: false, code: 'COMMAND_SOURCE_REJECTED' });
      // A fresh internal request is independent of dashboard login, yet its
      // own credential rotation must revoke it too.
      expect(JSON.parse(await standardTools.callStandardArtifactList(standardTransport, { session_id: 'coord-sa' })).success).toBe(true);
      const freshMcpPayload = capturedPayloads.at(-1)!;
      http.internalAuthToken = `${INTERNAL}-rotated`;
      const revokedCopy = coreMod.preserveTrustedOwnerTransportProof(freshMcpPayload, { ...freshMcpPayload });
      expect(await router.execute('artifact_list', revokedCopy, 'ipc')).toMatchObject({ success: false, code: 'COMMAND_SOURCE_REJECTED' });
      expect((await postCmd('artifact_list', { sessionId: 'coord-sa' }, { [INTERNAL_HEADER]: INTERNAL })).status).toBe(401);
      // Disabling dashboard auth does not turn an anonymous HTTP request into
      // a native MCP IPC caller (or an authenticated owner).
      http.internalAuthToken = null;
      http.configureAuth(null);
      // The artifact READ verbs are the one deliberate exception on a no-auth
      // daemon (standalone-artifact-read-noauth.vitest.ts): the open dashboard
      // reads them like every other read endpoint. Writes and everything else
      // stay refused.
      const noAuthReadAliases = ['artifact_list', 'session_artifact_list', 'artifact_fetch', 'artifact_read', 'session_artifact_fetch'];
      for (const alias of [...allAliases, 'get_command_history']) {
        const response = await postCmd(alias, { sessionId: 'worker-sa', path: 'doc.md', artifactId: workerArtId });
        expect(response.status).toBe(200);
        const body = await response.json() as any;
        if (noAuthReadAliases.includes(alias)) {
          expect(body.success, `no-auth owner read ${alias}`).toBe(true);
          continue;
        }
        expect(body).toMatchObject({ success: false, code: 'COMMAND_SOURCE_REJECTED' });
        expect(body.content).toBeUndefined();
        expect(body.artifacts).toBeUndefined();
        expect(body.history).toBeUndefined();
      }
      // Rotate the actual authenticated token after HTTP admission, retaining
      // a live same-session bind and a fresh current token. The old header may
      // not silently fall back to that different credential in the consumer.
      beforeArtifactDispatch = () => {
        __resetWorkerTaskTokensForTest();
        mintWorkerTaskToken({ meshId: 'mesh-sa', taskId: 'task-sa-1', sessionId: 'worker-sa', attemptId: 'att-sa-1' });
      };
      const rotatedWorker = await postCmd('artifact_register', { bind: workerBind.bind, token: workerToken.token, path: 'doc.md' }, { [WORKER_HEADER]: workerToken.token });
      expect(await rotatedWorker.json()).toMatchObject({ success: false, code: 'COMMAND_SOURCE_REJECTED' });
    } finally {
      __resetTranscriptProjectionForTests();
      unregisterMeshCoordinator('coord-sa');
      __resetWorkerSessionBindsForTest();
      __resetWorkerTaskTokensForTest();
      MeshRuntimeStore.resetForTests();
      fsMod.rmSync(tempRoot, { recursive: true, force: true });
    }
  }, 30_000);
});
