/**
 * DevServer — Auto-Implement Handlers
 *
 * Extracted from dev-server.ts for maintainability.
 * Contains prompt builders (IDE + CLI), agent spawn logic,
 * SSE streaming, and provider directory resolution for auto-implement.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type * as http from 'http';
import type { ChildProcess } from 'child_process';
import type { DevServerContext, ProviderCategory } from './dev-server-types.js';
import { DEV_SERVER_PORT } from './dev-server.js';
import { LOG } from '../logging/logger.js';
import { runCliAutoImplVerification } from './dev-cli-debug.js';

type CliExerciseVerification = {
  request?: Record<string, any>;
  mustContainAny?: string[];
  mustNotContainAny?: string[];
  mustMatchAny?: string[];
  mustNotMatchAny?: string[];
  lastAssistantMustContainAny?: string[];
  lastAssistantMustNotContainAny?: string[];
  lastAssistantMustMatchAny?: string[];
  lastAssistantMustNotMatchAny?: string[];
  inspectFields?: string[];
  description?: string;
  focusAreas?: string[];
  fixtureName?: string;
  fixtureNames?: string[];
};

function getAutoImplPid(ctx: DevServerContext): number | null {
  const pid = ctx.autoImplProcess?.pid;
  return typeof pid === 'number' && pid > 0 ? pid : null;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    return error?.code === 'EPERM';
  }
}

function clearStaleAutoImplState(ctx: DevServerContext, reason: string): void {
  if (!ctx.autoImplStatus.running && !ctx.autoImplProcess) return;

  const pid = getAutoImplPid(ctx);
  if (pid && isPidAlive(pid)) return;

  ctx.log(`Clearing stale auto-implement state: ${reason}${pid ? ` (pid ${pid})` : ''}`);
  ctx.autoImplProcess = null;
  ctx.autoImplStatus.running = false;
}

function tryKillAutoImplProcess(processRef: ChildProcess | null, signal: NodeJS.Signals): void {
  if (!processRef) return;
  try {
    processRef.kill(signal);
  } catch {
    // ignore
  }
}

export function shouldScheduleAutoStopOnQuiet(options: {
  verification?: unknown;
  autoImpl?: { autoStopOnQuiet?: boolean } | null;
}): boolean {
  return !!options.verification && options.autoImpl?.autoStopOnQuiet === true;
}

export function getDefaultAutoImplReference(ctx: DevServerContext, category: string, type: string): string {
  const all = ctx.providerLoader.getAll();
  // Pick any other provider in the same category as a reference
  const sameCategoryOther = all.find((p: any) => p.category === category && p.type !== type);
  if (sameCategoryOther?.type) return sameCategoryOther.type;
  return 'antigravity';
}

export function resolveAutoImplReference(ctx: DevServerContext, category: string, requestedReference: string | undefined, targetType: string): string | null {
  const desired = requestedReference || getDefaultAutoImplReference(ctx, category, targetType);
  const ref = ctx.providerLoader.resolve(desired) || ctx.providerLoader.getMeta(desired);
  if (ref?.category === category) return desired;

  const all = ctx.providerLoader.getAll();
  const fallback = all
    .filter((p: any) => p.category === category && p.type !== targetType)
    .sort((a: any, b: any) => String(a.type || '').localeCompare(String(b.type || ''), undefined, { numeric: true, sensitivity: 'base' }))[0];
  return fallback?.type || null;
}

export function getLatestScriptVersionDir(scriptsDir: string): string | null {
  if (!fs.existsSync(scriptsDir)) return null;

  const versions = fs.readdirSync(scriptsDir)
    .filter((d: string) => {
      try { return fs.statSync(path.join(scriptsDir, d)).isDirectory(); } catch { return false; }
    })
    .sort((a: string, b: string) => b.localeCompare(a, undefined, { numeric: true, sensitivity: 'base' }));

  if (versions.length === 0) return null;
  return path.join(scriptsDir, versions[0]);
}

export function resolveAutoImplWritableProviderDir(ctx: DevServerContext, 
  category: ProviderCategory,
  type: string,
  requestedDir?: string,
): { dir: string | null; reason?: string } {
  const canonicalUserDir = path.resolve(ctx.providerLoader.getUserProviderDir(category, type));
  const desiredDir = requestedDir ? path.resolve(requestedDir) : canonicalUserDir;
  const upstreamRoot = path.resolve(ctx.providerLoader.getUpstreamDir());
  if (desiredDir === upstreamRoot || desiredDir.startsWith(`${upstreamRoot}${path.sep}`)) {
    return { dir: null, reason: `Refusing to write into upstream provider directory: ${desiredDir}` };
  }

  if (path.basename(desiredDir) !== type) {
    return { dir: null, reason: `Requested writable provider directory must end with '${type}': ${desiredDir}` };
  }

  const sourceDir = ctx.findProviderDir(type);
  if (!sourceDir) {
    return { dir: null, reason: `Provider source directory not found for '${type}'` };
  }

  if (!fs.existsSync(desiredDir)) {
    fs.mkdirSync(path.dirname(desiredDir), { recursive: true });
    fs.cpSync(sourceDir, desiredDir, { recursive: true });
    ctx.log(`Auto-implement writable copy created: ${desiredDir}`);
  }

  const providerJson = path.join(desiredDir, 'provider.json');
  if (!fs.existsSync(providerJson)) {
    return { dir: null, reason: `provider.json not found in writable provider directory: ${desiredDir}` };
  }

  return { dir: desiredDir };
}

export function loadAutoImplReferenceScripts(ctx: DevServerContext, referenceType: string | null): Record<string, string> {
  if (!referenceType) return {};

  const refDir = ctx.findProviderDir(referenceType);
  if (!refDir || !fs.existsSync(refDir)) return {};

  const referenceScripts: Record<string, string> = {};
  const scriptsDir = path.join(refDir, 'scripts');
  const latestDir = getLatestScriptVersionDir(scriptsDir);
  if (!latestDir) return referenceScripts;

  for (const file of fs.readdirSync(latestDir)) {
    if (!file.endsWith('.js')) continue;
    try {
      referenceScripts[file] = fs.readFileSync(path.join(latestDir, file), 'utf-8');
    } catch {
      // ignore broken reference files
    }
  }
  return referenceScripts;
}

export async function handleAutoImplement(ctx: DevServerContext, type: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await ctx.readBody(req);
  const {
    agent = 'claude-cli',
    functions,
    reference,
    model,
    comment,
    providerDir: requestedProviderDir,
    verification,
  } = body;
  if (!functions || !Array.isArray(functions) || functions.length === 0) {
    ctx.json(res, 400, { error: 'functions[] is required (e.g. ["readChat", "sendMessage"])' });
    return;
  }

  clearStaleAutoImplState(ctx, 'new auto-implement request');
  if (ctx.autoImplStatus.running) {
    ctx.json(res, 409, { error: 'Auto-implement already in progress', type: ctx.autoImplStatus.type });
    return;
  }

  const provider = ctx.providerLoader.resolve(type);
  if (!provider) { ctx.json(res, 404, { error: `Provider not found: ${type}` }); return; }

  const writableProvider = resolveAutoImplWritableProviderDir(ctx, provider.category, type, requestedProviderDir);
  if (!writableProvider.dir) {
    ctx.json(res, 409, {
      error: writableProvider.reason || `Auto-implement only writes to the canonical user provider directory for '${type}'.`,
    });
    return;
  }
  const providerDir = writableProvider.dir;

  ctx.autoImplStatus = { running: false, type, progress: [] };

  if (provider.category === 'cli' && verification && (verification.fixtureName || (verification.fixtureNames && verification.fixtureNames.length > 0))) {
    sendAutoImplSSE(ctx, {
      event: 'progress',
      data: {
        function: '_preflight',
        status: 'verifying',
        message: 'Running preflight verification before spawning agent...',
      }
    });
    try {
      const preflight = await runCliAutoImplVerification(ctx, type, verification);
      sendAutoImplSSE(ctx, { event: 'verification', data: preflight });
      if (preflight.pass) {
        sendAutoImplSSE(ctx, {
          event: 'complete',
          data: {
            success: true,
            exitCode: 0,
            functions,
            message: `✅ No-op: exact ${preflight.mode} already passes`,
            verification: preflight,
            skipped: true,
          },
        });
        ctx.json(res, 200, {
          started: false,
          skipped: true,
          type,
          functions,
          providerDir,
          verification: preflight,
          message: 'Preflight verification already passes. No auto-implement run needed.',
        });
        return;
      }
    } catch (error: any) {
      sendAutoImplSSE(ctx, {
        event: 'progress',
        data: {
          function: '_preflight',
          status: 'verify_failed',
          message: `Preflight verification errored, continuing to agent run: ${error?.message || error}`,
        }
      });
    }
  }

  try {
    ctx.autoImplStatus = { running: true, type, progress: ctx.autoImplStatus.progress };
    // 1. Collect DOM context
    // 1. Skip heavy DOM pre-parsing (Agent will use cURL to explore via CDP!)
    const resolvedReference = resolveAutoImplReference(ctx, provider.category, reference, type);
    sendAutoImplSSE(ctx, {
      event: 'progress',
      data: {
        function: '_init',
        status: 'analyzing',
        message: provider.category === 'cli'
          ? 'Initializing agent (granting CLI PTY debug access)...'
          : 'Initializing agent (granting DOM access)...'
      }
    });
    const domContext = null;

    // 2. Load reference scripts
    sendAutoImplSSE(ctx, {
      event: 'progress',
      data: {
        function: '_init',
        status: 'loading_reference',
        message: `Loading reference script (${resolvedReference || 'none'})...`
      }
    });

    const referenceScripts = loadAutoImplReferenceScripts(ctx, resolvedReference);

    // 3. Build the prompt
    const prompt = buildAutoImplPrompt(ctx, type, provider, providerDir, functions, domContext, referenceScripts, comment, resolvedReference, verification);

    // 4. Write prompt to temp file (avoids shell escaping issues with special chars)
    const tmpDir = path.join(os.tmpdir(), 'adhdev-autoimpl');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    const promptFile = path.join(tmpDir, `prompt-${type}-${Date.now()}.md`);
    fs.writeFileSync(promptFile, prompt, 'utf-8');
    ctx.log(`Auto-implement prompt written to ${promptFile} (${prompt.length} chars)`);

    // 5. Determine agent command from provider spawn config
    const agentProvider = ctx.providerLoader.resolve(agent) || ctx.providerLoader.getMeta(agent);
    const spawn = agentProvider?.spawn;
    if (!spawn?.command) {
      try { fs.unlinkSync(promptFile); } catch { /* ignore */ }
      ctx.json(res, 400, { error: `Agent '${agent}' has no spawn config. Select a CLI provider with a spawn configuration.` });
      return;
    }

    const agentCategory = agentProvider?.category;

    // ─── ACP Agent: use ACP SDK (JSON-RPC protocol) ───
    if (agentCategory === 'acp') {
      sendAutoImplSSE(ctx, { event: 'progress', data: { function: '_init', status: 'spawning', message: `Spawning ACP agent: ${spawn.command} ${(spawn.args || []).join(' ')}` } });
      ctx.autoImplStatus.running = true;
      ctx.autoImplStatus.type = type;

      // Dynamic import ACP SDK
      const { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION } = await import('@agentclientprotocol/sdk');
      const { Readable, Writable } = await import('stream');
      const { spawn: spawnFn } = await import('child_process');

      // Add model override to spawn args if specified
      const acpArgs = [...(spawn.args || [])];
      if (model) {
        acpArgs.push('--model', model);
        ctx.log(`Auto-implement ACP using model: ${model}`);
      }

      const child = spawnFn(spawn.command, acpArgs, {
        cwd: providerDir,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: spawn.shell ?? false,
        env: { ...process.env, ...(spawn.env || {}) },
      });
      ctx.autoImplProcess = child;

      // stderr → stream to SSE
      child.stderr?.on('data', (d: Buffer) => {
        const chunk = d.toString();
        sendAutoImplSSE(ctx, { event: 'output', data: { chunk, stream: 'stderr' } });
      });

      // Setup ACP connection via SDK
      const webStdin = Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>;
      const webStdout = Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>;
      const stream = ndJsonStream(webStdin, webStdout);

      const connection = new ClientSideConnection((_agent: any) => ({
        // Auto-approve all tool calls for auto-implement
        requestPermission: async (params: any) => {
          const allowOpt = params.options?.find((o: any) => o.kind === 'allow_once') || params.options?.[0];
          sendAutoImplSSE(ctx, { event: 'output', data: { chunk: `[ACP] Auto-approved: ${params.toolCall?.title || 'tool call'}\n`, stream: 'stdout' } });
          return { outcome: { outcome: 'selected', optionId: allowOpt?.optionId || '' } };
        },
        sessionUpdate: async (params: any) => {
          const update = params?.update;
          if (!update) return;
          // Stream meaningful output only (skip thought chunks — they're too verbose)
          switch (update.sessionUpdate) {
            case 'agent_message_chunk':
              if (update.content?.text) {
                sendAutoImplSSE(ctx, { event: 'output', data: { chunk: update.content.text, stream: 'stdout' } });
              }
              break;
            case 'tool_call':
              sendAutoImplSSE(ctx, { event: 'output', data: { chunk: `\n🔧 [Tool] ${update.title || 'unknown'}\n`, stream: 'stdout' } });
              break;
            case 'tool_call_update':
              if (update.status === 'completed' || update.status === 'failed') {
                const label = update.status === 'completed' ? '✅' : '❌';
                const out = update.rawOutput ? (typeof update.rawOutput === 'string' ? update.rawOutput : JSON.stringify(update.rawOutput)) : '';
                sendAutoImplSSE(ctx, { event: 'output', data: { chunk: `${label} Result: ${out.slice(0, 1000)}\n`, stream: 'stdout' } });
              }
              break;
            case 'agent_thought_chunk':
              // Skip — too verbose for auto-implement UI
              break;
            default:
              break;
          }
        },
        // Not used for auto-implement
        readTextFile: async () => { throw new Error('not supported'); },
        writeTextFile: async () => { throw new Error('not supported'); },
        createTerminal: async () => { throw new Error('not supported'); },
        terminalOutput: async () => { throw new Error('not supported'); },
        releaseTerminal: async () => { throw new Error('not supported'); },
        waitForTerminalExit: async () => { throw new Error('not supported'); },
        killTerminal: async () => { throw new Error('not supported'); },
      }), stream);

      child.on('exit', (code) => {
        ctx.autoImplProcess = null;
        ctx.autoImplStatus.running = false;
        const success = code === 0;
        sendAutoImplSSE(ctx, { event: 'complete', data: { success, exitCode: code, functions, message: success ? '✅ ACP Auto-implement complete' : `❌ ACP agent exited (code: ${code})` } });
        try { ctx.providerLoader.reload(); } catch { /* ignore */ }
        try { fs.unlinkSync(promptFile); } catch { /* ignore */ }
        ctx.log(`Auto-implement (ACP) ${success ? 'completed' : 'failed'}: ${type} (exit: ${code})`);
      });

      // ACP handshake flow (async, runs in background)
      (async () => {
        try {
          sendAutoImplSSE(ctx, { event: 'progress', data: { function: '_init', status: 'initializing', message: 'ACP initialize...' } });
          await connection.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });

          sendAutoImplSSE(ctx, { event: 'progress', data: { function: '_init', status: 'session', message: 'Creating ACP session...' } });
          const session = await connection.newSession({ cwd: providerDir, mcpServers: [] });
          const sessionId = session?.sessionId;
          if (!sessionId) throw new Error('No sessionId returned from session/new');

          sendAutoImplSSE(ctx, { event: 'progress', data: { function: '_init', status: 'prompting', message: `Sending prompt (${prompt.length} chars)...` } });
          await connection.prompt({
            sessionId,
            prompt: [{ type: 'text', text: prompt }],
          });

          sendAutoImplSSE(ctx, { event: 'progress', data: { function: '_done', status: 'complete', message: '✅ ACP prompt processing complete' } });
        } catch (e: any) {
          sendAutoImplSSE(ctx, { event: 'output', data: { chunk: `[ACP Error] ${e.message}\n`, stream: 'stderr' } });
          ctx.log(`Auto-implement ACP error: ${e.message}`);
          // Process exit will trigger the 'complete' SSE event
          if (child.exitCode === null) { child.kill('SIGTERM'); }
        }
      })();

      ctx.json(res, 202, {
        started: true, type, agent: spawn.command, functions, providerDir,
        message: 'ACP Auto-implement started. Connect to SSE for progress.',
        sseUrl: `/api/providers/${type}/auto-implement/status`,
      });
      return;
    }

    // ─── CLI Agent: declarative autoImpl config from provider.json ───
    const command: string = spawn.command;
    const autoImpl = spawn.autoImpl;
    // Strip interactive-only flags for auto-implement (non-interactive mode)
    const interactiveFlags = ['--yolo', '--interactive', '-i'];
    const baseArgs: string[] = [...(spawn.args || [])].filter((a: string) => !interactiveFlags.includes(a));

    // 6. Construct the complete shell command from provider.json autoImpl config
    let shellCmd: string;
    const isWin = os.platform() === 'win32';
    const escapeArg = (a: string) => isWin ? `"${a.replace(/"/g, '""')}"` : `'${a.replace(/'/g, "'\\''")}'`;

    const promptMode = autoImpl?.promptMode ?? 'stdin';
    const extraArgs = autoImpl?.extraArgs ?? [];
    const rawMetaPrompt = autoImpl?.metaPrompt
      ? autoImpl.metaPrompt.replace('{{promptFile}}', promptFile)
      : `Read the file at ${promptFile} and follow ALL the instructions in it exactly. Do not ask questions, just execute.`;

    if (promptMode === 'flag') {
      const flag = autoImpl?.promptFlag ?? '-p';
      const args = [...baseArgs, ...extraArgs];
      if (model) args.push('--model', model);
      const escapedArgs = args.map(escapeArg).join(' ');
      shellCmd = `${command} ${escapedArgs} ${flag} ${escapeArg(rawMetaPrompt)}`;
    } else if (promptMode === 'subcommand') {
      const subcommand = autoImpl?.subcommand ?? '';
      const args = subcommand ? [subcommand, ...baseArgs] : [...baseArgs];
      for (const extra of extraArgs) {
        if (!args.includes(extra)) args.push(extra);
      }
      if (model) args.push('--model', model);
      const escapedArgs = args.map(escapeArg).join(' ');
      shellCmd = `${command} ${escapedArgs} ${escapeArg(rawMetaPrompt)}`;
    } else {
      // stdin fallback (generic)
      const args = [...baseArgs, ...extraArgs];
      const escapedArgs = args.map(escapeArg).join(' ');
      if (isWin) {
        shellCmd = `type "${promptFile}" | ${command} ${escapedArgs}`;
      } else {
        shellCmd = `cat '${promptFile}' | ${command} ${escapedArgs}`;
      }
    }

    sendAutoImplSSE(ctx, { event: 'progress', data: { function: '_init', status: 'spawning', message: `Spawning agent: ${shellCmd.substring(0, 200)}... (prompt: ${prompt.length} chars)` } });

    ctx.autoImplStatus.running = true;
    ctx.autoImplStatus.type = type;
    const spawnedAt = Date.now();

    let child: any;
    let isPty = false;
    const { spawn: spawnFn } = await import('child_process');
    
    try {
      const pty = require('node-pty');
      ctx.log(`Auto-implement spawn (PTY): ${shellCmd}`);
      const isWin = os.platform() === 'win32';
      child = pty.spawn(isWin ? 'cmd.exe' : (process.env.SHELL || '/bin/zsh'), [isWin ? '/c' : '-c', shellCmd], {
        name: 'xterm-256color',
        cols: 120,
        rows: 40,
        cwd: providerDir,
        env: { ...process.env, ...(spawn.env || {}) },
      });
      isPty = true;
    } catch (err: any) {
      ctx.log(`PTY not available, using child_process: ${err.message}`);
      child = spawnFn(isWin ? 'cmd.exe' : 'sh', [isWin ? '/c' : '-c', shellCmd], {
        cwd: providerDir,
        shell: false,
        timeout: 900000,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          ...(spawn.env || {}),
        },
      });
      child.on('error', (err: Error) => {
        ctx.log(`Auto-implement spawn error: ${err.message}`);
        sendAutoImplSSE(ctx, { event: 'output', data: { chunk: `[Spawn Error] ${err.message}\n`, stream: 'stderr' } });
      });
    }

    ctx.autoImplProcess = child;
    let stdout = '';
    let stderr = '';
    
    let approvalPatterns: RegExp[] = [];
    let approvalKeys: Record<number, string> = { 0: 'y\r' };
    let approvalBuffer = '';
    let lastApprovalTime = 0;
    let completionSignalSeen = false;
    let autoStopTimer: ReturnType<typeof setTimeout> | null = null;
    let autoStopIssued = false;
    
    try {
      if (agentProvider?.category === 'cli') {
        const { normalizeCliProviderForRuntime } = await import('../cli-adapters/provider-cli-adapter.js');
        const normalized = normalizeCliProviderForRuntime(agentProvider);
        approvalPatterns = normalized.patterns.approval;
        approvalKeys = agentProvider.approvalKeys || { 0: 'y\r', 1: 'a\r' };
      }
    } catch (err: any) {
      ctx.log(`Failed to load approval patterns: ${err.message}`);
    }

    const checkAutoApproval = (chunk: string, writeFn: (s: string) => void) => {
      // Strip ANSI
      const cleanData = chunk.replace(/\x1B\[\d*[A-HJKSTfG]/g, ' ')
          .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '')
          .replace(/\x1B\][^\x07]*\x07/g, '')
          .replace(/\x1B\][^\x1B]*\x1B\\/g, '')
          .replace(/  +/g, ' ');
          
      approvalBuffer = (approvalBuffer + cleanData).slice(-1500);
      
      // Force exit on completion signal (check cleanData directly to avoid stale buffer echo matches)
      const elapsed = Date.now() - spawnedAt;
      if (elapsed > 15000 && cleanData.includes('_PIPELINE_COMPLETE_SIGNAL_')) {
        completionSignalSeen = true;
        ctx.log(`Agent finished task after ${Math.round(elapsed/1000)}s. Terminating interactive CLI session to unblock pipeline.`);
        sendAutoImplSSE(ctx, { event: 'output', data: { chunk: `\n[🤖 ADHDev Pipeline] Completion token detected. Proceeding...\n`, stream: 'stdout' } });
        approvalBuffer = '';
        
        tryKillAutoImplProcess(ctx.autoImplProcess, 'SIGINT');
        return;
      }
      
      // Use a cooldown to prevent overlapping approval submissions
      if (Date.now() - lastApprovalTime < 2000) return;
      
      if (approvalPatterns.some(p => p.test(approvalBuffer))) {
        // Use 'Always allow' (1) if available, otherwise 'Allow once' (0), otherwise hard fallback to 'a\r' for newer CLIs
        const key = approvalKeys[1] || approvalKeys[0] || 'a\r';
        writeFn(key);
        ctx.log(`Auto-Implement auto-approved prompt! Sending: ${JSON.stringify(key)}`);
        sendAutoImplSSE(ctx, { event: 'output', data: { chunk: `\n[🤖 ADHDev Auto-Approve] CLI Action Approved\n`, stream: 'stdout' } });
        approvalBuffer = '';
        lastApprovalTime = Date.now();
      }
    };

    const clearAutoStopTimer = () => {
      if (autoStopTimer) {
        clearTimeout(autoStopTimer);
        autoStopTimer = null;
      }
    };

    const scheduleAutoStopForVerification = () => {
      if (!shouldScheduleAutoStopOnQuiet({ verification, autoImpl }) || completionSignalSeen || autoStopIssued) return;
      const elapsed = Date.now() - spawnedAt;
      if (elapsed < 30000) return;
      clearAutoStopTimer();
      autoStopTimer = setTimeout(() => {
        if (!ctx.autoImplProcess || completionSignalSeen || autoStopIssued) return;
        autoStopIssued = true;
        ctx.log(`Auto-implement output quiet for 30s after ${Math.round((Date.now() - spawnedAt) / 1000)}s. Interrupting agent and switching to daemon verification.`);
        sendAutoImplSSE(ctx, {
          event: 'output',
          data: {
            chunk: '\n[🤖 ADHDev Pipeline] Agent output quiet. Interrupting and running daemon verification...\n',
            stream: 'stdout',
          },
        });
        tryKillAutoImplProcess(ctx.autoImplProcess, 'SIGINT');
      }, 30000);
    };

    const finalizeCliAutoImpl = async (code: number | null) => {
      ctx.autoImplProcess = null;
      clearAutoStopTimer();
      let success = completionSignalSeen || code === 0;
      let message = success
        ? (completionSignalSeen && code !== 0 ? '✅ Auto-implement complete (completion signal)' : '✅ Auto-implement complete')
        : `❌ Agent exited (code: ${code})`;
      let verificationSummary: any = null;

      try { ctx.providerLoader.reload(); } catch { /* ignore */ }

      if (provider.category === 'cli' && verification) {
        sendAutoImplSSE(ctx, {
          event: 'progress',
          data: {
            function: '_verify',
            status: 'running',
            message: 'Running exact post-patch verification...',
          },
        });
        try {
          verificationSummary = await runCliAutoImplVerification(ctx, type, verification);
          sendAutoImplSSE(ctx, { event: 'verification', data: verificationSummary });
          success = verificationSummary.pass;
          message = verificationSummary.pass
            ? `✅ Auto-implement complete (${verificationSummary.mode})`
            : `❌ Post-patch verification failed (${verificationSummary.mode}): ${verificationSummary.failures.join('; ') || 'unknown failure'}`;
        } catch (error: any) {
          success = false;
          message = `❌ Post-patch verification error: ${error?.message || error}`;
          sendAutoImplSSE(ctx, {
            event: 'verification',
            data: { pass: false, error: error?.message || String(error) },
          });
        }
      }

      ctx.autoImplStatus.running = false;
      sendAutoImplSSE(ctx, {
        event: 'complete',
        data: {
          success,
          exitCode: code,
          functions,
          message,
          verification: verificationSummary,
        },
      });
      try { fs.unlinkSync(promptFile); } catch { /* ignore */ }
      ctx.log(`Auto-implement ${success ? 'completed' : 'failed'}: ${type} (exit: ${code})${verificationSummary ? ` verify=${verificationSummary.pass ? 'pass' : 'fail'}` : ''}`);
    };

    if (isPty) {
      child.onData((data: string) => {
        stdout += data;
        clearAutoStopTimer();
        if (data.includes('\x1b[6n')) {
          child.write('\x1b[12;1R');
          ctx.log('Terminal CPR request (\\x1b[6n) intercepted in PTY, responding with dummy coordinates [12;1R]');
        }
        checkAutoApproval(data, (s) => child.write(s));
        sendAutoImplSSE(ctx, { event: 'output', data: { chunk: data, stream: 'stdout' } });
        scheduleAutoStopForVerification();
      });
      child.onExit(({ exitCode: code }: { exitCode: number }) => {
        void finalizeCliAutoImpl(code);
      });
    } else {
      child.stdout?.on('data', (d: Buffer) => {
        const chunk = d.toString();
        stdout += chunk;
        clearAutoStopTimer();
        if (chunk.includes('\x1b[6n')) child.stdin?.write('\x1b[1;1R');
        checkAutoApproval(chunk, (s) => child.stdin?.write(s));
        sendAutoImplSSE(ctx, { event: 'output', data: { chunk, stream: 'stdout' } });
        scheduleAutoStopForVerification();
      });
      child.stderr?.on('data', (d: Buffer) => {
        const chunk = d.toString();
        stderr += chunk;
        clearAutoStopTimer();
        checkAutoApproval(chunk, (s) => child.stdin?.write(s));
        sendAutoImplSSE(ctx, { event: 'output', data: { chunk, stream: 'stderr' } });
        scheduleAutoStopForVerification();
      });
      child.on('exit', (code: number) => {
        void finalizeCliAutoImpl(code);
      });
    }
    ctx.json(res, 202, {
      started: true,
      type,
      agent: command,
      functions,
      providerDir,
      message: 'Auto-implement started. Connect to SSE for progress.',
      sseUrl: `/api/providers/${type}/auto-implement/status`,
    });
  } catch (e: any) {
    ctx.autoImplStatus.running = false;
    ctx.json(res, 500, { error: `Auto-implement failed: ${e.message}` });
  }
}

export function buildAutoImplPrompt(ctx: DevServerContext, 
  type: string,
  provider: any,
  providerDir: string,
  functions: string[],
  domContext: any,
  referenceScripts: Record<string, string>,
  userComment?: string,
  referenceType?: string | null,
  verification?: CliExerciseVerification,
): string {
  if (provider.category === 'cli') {
    return buildCliAutoImplPrompt(ctx, type, provider, providerDir, functions, referenceScripts, userComment, referenceType, verification);
  }

  const lines: string[] = [];

  /** CDP connection key: extension scripts use host IDE (default Cursor), not the extension id. */
  const cdpIdeType = provider.category === 'extension' ? 'cursor' : type;

  // ── System instructions ──
  lines.push('You are implementing browser automation scripts for an IDE provider.');
  lines.push('Be concise. Do NOT explain your reasoning. Just edit files directly.');
  lines.push('');

  // ── Target ──
  lines.push(`# Target: ${provider.name || type} (${type})`);
  lines.push(`Provider directory: \`${providerDir}\``);
  lines.push('');
  if (provider.category === 'extension') {
    lines.push('## CDP host (extension providers)');
    lines.push(
      `Extension **${type}** runs inside a host IDE. For \`/api/scripts/run\` and \`/api/cdp/evaluate\`, keep \`"type": "${type}"\` (which provider scripts run) but set \`"ideType"\` to the DevServer CDP **managerKey** for that window.`,
    );
    lines.push(
      `Examples use \`"ideType": "${cdpIdeType}"\` (Cursor). If **multiple** IDE windows are connected, run \`GET /api/cdp/targets\` and use the correct \`managerKey\` / \`pageTitle\` — short \`cursor\` or \`vscode\` only works when it uniquely identifies one window.`,
    );
    lines.push(
      'For VS Code hosts, use `vscode` or full `vscode_<targetId>` managerKey in every curl below.',
    );
    lines.push('');
  }

  // ── funcToFile mapping (needed early for file classification) ──
  const funcToFile: Record<string, string> = {
    readChat: 'read_chat.js', sendMessage: 'send_message.js',
    resolveAction: 'resolve_action.js', listSessions: 'list_sessions.js',
    listChats: 'list_chats.js', switchSession: 'switch_session.js',
    newSession: 'new_session.js', focusEditor: 'focus_editor.js',
    openPanel: 'open_panel.js', listModels: 'list_models.js',
    listModes: 'list_modes.js', setModel: 'set_model.js', setMode: 'set_mode.js',
  };
  const targetFileNames = new Set(functions.map(fn => funcToFile[fn]).filter(Boolean));

  // ── Existing target files (inline, so no reading needed) ──
  const scriptsDir = path.join(providerDir, 'scripts');
  const latestScriptsDir = getLatestScriptVersionDir(scriptsDir);
  if (latestScriptsDir) {
    lines.push(`Scripts version directory: \`${latestScriptsDir}\``);
    lines.push('');

    // Target files: editable
    lines.push('## ✏️ Target Files (EDIT THESE)');
    lines.push('These are the ONLY files you are allowed to modify. Replace the TODO stubs with working implementations.');
    lines.push('');
    for (const file of fs.readdirSync(latestScriptsDir)) {
      if (file.endsWith('.js') && targetFileNames.has(file)) {
        try {
          const content = fs.readFileSync(path.join(latestScriptsDir, file), 'utf-8');
          lines.push(`### \`${file}\` ✏️ EDIT`);
          lines.push('```javascript');
          lines.push(content);
          lines.push('```');
          lines.push('');
        } catch { /* skip */ }
      }
    }

    // Non-target files: reference only
    const refFiles = fs.readdirSync(latestScriptsDir).filter(f => f.endsWith('.js') && !targetFileNames.has(f));
    if (refFiles.length > 0) {
      lines.push('## 🔒 Other Scripts (REFERENCE ONLY — DO NOT EDIT)');
      lines.push('These files are shown for context only. Do NOT modify them under any circumstances.');
      lines.push('');
      for (const file of refFiles) {
        try {
          const content = fs.readFileSync(path.join(latestScriptsDir, file), 'utf-8');
          lines.push(`### \`${file}\` 🔒`);
          lines.push('```javascript');
          lines.push(content);
          lines.push('```');
          lines.push('');
        } catch { /* skip */ }
      }
    }
  }

  // ── DOM context ──
  if (domContext) {
    lines.push('## Live DOM Analysis (from CDP)');
    lines.push('Use these selectors in your implementations:');
    lines.push('```json');
    lines.push(JSON.stringify(domContext, null, 2));
    lines.push('```');
    lines.push('');
  }

  // ── Reference implementation ── (funcToFile already defined above)

  if (Object.keys(referenceScripts).length > 0) {
    lines.push(`## Reference Implementation (from ${referenceType || 'antigravity'} provider)`);
    lines.push('These are WORKING scripts from another IDE. Adapt the PATTERNS (not selectors) for the target IDE.');
    lines.push('');
    for (const fn of functions) {
      const fileName = funcToFile[fn];
      if (fileName && referenceScripts[fileName]) {
        lines.push(`### ${fn} → \`${fileName}\``);
        lines.push('```javascript');
        lines.push(referenceScripts[fileName]);
        lines.push('```');
        lines.push('');
      }
    }
    if (referenceScripts['scripts.js']) {
      lines.push('### Router → `scripts.js`');
      lines.push('```javascript');
      lines.push(referenceScripts['scripts.js']);
      lines.push('```');
      lines.push('');
    }
  }

  // ── Markdown Guides (Provider Fix) ──
  const docsDir = path.join(providerDir, '../../docs');
  const loadGuide = (name: string) => {
    try {
      const p = path.join(docsDir, name);
      if (fs.existsSync(p)) return fs.readFileSync(p, 'utf-8');
    } catch { /* ignore */ }
    return null;
  };

  const providerGuide = loadGuide('PROVIDER_GUIDE.md');
  if (providerGuide) {
    lines.push('## Documentation: PROVIDER_GUIDE.md');
    lines.push('```markdown');
    lines.push(providerGuide);
    lines.push('```');
    lines.push('');
  }

  const cdpGuide = loadGuide('CDP_SELECTOR_GUIDE.md');
  if (cdpGuide) {
    lines.push('## Documentation: CDP_SELECTOR_GUIDE.md');
    lines.push('```markdown');
    lines.push(cdpGuide);
    lines.push('```');
    lines.push('');
  }

  // ── Task ──
  lines.push('## Task');
  lines.push(`Edit files in \`${providerDir}\` to implement: **${functions.join(', ')}**`);
  lines.push('');

  // ── Rules ──
  lines.push('## Rules');
  lines.push('0. **🚫 SCOPE CONSTRAINT**: You may ONLY edit files marked ✏️ EDIT above. ALL other files are READ-ONLY. Do NOT modify, rewrite, refactor, or "improve" any file not explicitly marked as editable — even if you notice bugs or improvements. No exceptions.');
  lines.push('1. **Scripts WITHOUT params** → IIFE: `(() => { ... })()`');
  lines.push('2. **Scripts WITH params** → arrow: `(params) => { ... }` — router calls `(${script})(${JSON.stringify(params)})`');
  lines.push('3. If live DOM analysis is included above, use it. Otherwise, discover selectors yourself via CDP before coding.');
  lines.push('4. Always wrap in try-catch, return `JSON.stringify(result)`');
  lines.push('5. Do NOT modify `scripts.js` router — only edit individual `*.js` files');
  lines.push('6. All scripts run in the browser (CDP evaluate) — use DOM APIs only');
  lines.push('7. **Cross-Platform Compatibility**: If you use ARIA labels that contain keyboard shortcuts (e.g., `Cascade (⌘L)`), you MUST use substring matches (`aria-label*="Cascade"`) or handle both macOS (`⌘`, `Cmd`) and Windows (`Ctrl`) so the script does not break on other operating systems.');
  lines.push('8. **CRITICAL: DO NOT explore the filesystem or read other providers.** The reference implementation pattern is already provided below. Do not run `find`, `rg`, or `cat` on upstream providers. Doing so wastes context tokens and will crash the agent session. Focus entirely on modifying the target files.');
  lines.push('9. Do NOT delete any files. Implement the logic by replacing the empty stubs.');
  lines.push('');

  // ── Output contracts ──
  lines.push('## Required Return Format');
  lines.push('| Function | Return JSON |');
  lines.push('|---|---|');
  lines.push('| readChat | `{ id, status, title, messages: [{role, content, index, kind?, meta?}], inputContent, activeModal, controlValues?, summaryMetadata? }` — optional `kind`: standard, thought, tool, terminal; prefer explicit `controlValues` for current selections and `summaryMetadata` for compact always-visible UI metadata |');
  lines.push('| sendMessage | `{ sent: false, needsTypeAndSend: true, selector }` |');
  lines.push('| resolveAction | `{ resolved: true/false, clicked? }` |');
  lines.push('| listSessions | `{ sessions: [{ id, title, active, index }] }` |');
  lines.push('| switchSession | `{ switched: true/false }` |');
  lines.push('| newSession | `{ created: true/false }` |');
  lines.push('| listModels | `{ models: [{ name, id }], current }` |');
  lines.push('| setModel | `{ success: true/false }` |');
  lines.push('| listModes | `{ modes: [{ name, id }], current }` |');
  lines.push('| setMode | `{ success: true/false }` |');
  lines.push('| focusEditor | `{ focused: true/false, error? }` |');
  lines.push('| openPanel | `{ opened: true/false, visible: true/false, focused?: true, error? }` |');
  lines.push('');

  // ── readChat.status lifecycle spec ──
  lines.push('## 🔴 CRITICAL: readChat `status` Lifecycle');
  lines.push('The `status` field in readChat controls how the dashboard and daemon auto-approve-loop behave.');
  lines.push('Getting this wrong will break the entire automation pipeline. The status MUST reflect the ACTUAL current state:');
  lines.push('');
  lines.push('| Status | When to use | How to detect |');
  lines.push('|---|---|---|');
  lines.push('| `idle` | AI is NOT generating, no approval needed | Default state. No stop button, no spinners, no approval pills/buttons |');
  lines.push('| `generating` | AI is actively streaming/thinking | ANY of: (1) Submit button icon SVG changes (e.g. arrow→stop square, fill="none"→fill="currentColor"), (2) Stop/Cancel button visible, (3) CSS animation, (4) Structural markers (aria-labels that only appear during generation) |');
  lines.push('| `waiting_approval` | AI stopped and needs user action | Actionable buttons like Run/Skip/Accept/Reject are visible AND clickable |');
  lines.push('');
  lines.push('### ⚠️ Status Detection Gotchas (MUST READ!)');
  lines.push('1. **DO NOT rely on button text/labels in the user\'s language.** OS locale may be Korean, Japanese, etc. Button text like "Cancel" or "Stop" will be localized. Instead, detect STRUCTURAL indicators: SVG icon changes, CSS classes, aria-labels from the extension\'s own React/Radix UI (which stay in English regardless of OS locale).');
  lines.push('2. **Use sendMessage to CREATE a generating state, then CAPTURE the DOM.** Send a LONG prompt (e.g. "Write an extremely detailed 5000-word essay...") so the AI takes 10+ seconds. Then periodically capture the DOM during generation to find which elements appear/change. Compare idle vs generating DOM snapshots to find reliable structural markers.');
  lines.push('3. **Look for SVG icon changes in the submit button.** Many IDEs change the submit button icon from an arrow (send) to a square (stop) during generation. Check the SVG `fill` attribute or path data.');
  lines.push('4. **FALSE POSITIVES from old messages**: Chat history may contain text like "Command Awaiting Approval" from PAST turns. ONLY match small leaf elements (under 80 chars) or use explicit button/pill selectors.');
  lines.push('5. **Awaiting Approval pill without actions**: Some IDEs show a floating pill/banner that is just a scroll-to indicator. If NO actionable buttons exist, the status should be `idle`, NOT `waiting_approval`.');
  lines.push('6. **activeModal must include actions**: When `status` is `waiting_approval`, the `activeModal` object MUST include a non-empty `actions` array.');
  lines.push('');

  lines.push('## Action');
  lines.push('1. Edit the script files to implement working code');
  lines.push('2. After editing, TEST each function using the DevConsole API (see below)');
  lines.push('3. If a test fails, fix the implementation and re-test');
  lines.push('4. **IMPORTANT VERIFICATION LOGIC**: When verifying your implementation, beware of state contamination! You MUST perform strict Integration Testing:');
  lines.push('   - `openPanel`: Toggle buttons are usually located in the top header, sidebar, or activity bar. Prefer finding and clicking these native UI buttons over extreme CSS injection hacks if possible.');
  lines.push('   - `listSessions`: If sessions are unmounted when the panel is closed, try to explicitly interact with the UI to open the history/sessions view (e.g., clicking a history icon usually found near the chat header) BEFORE scraping.');
  lines.push('   - `switchSession`: Prove your switch was successful by subsequently calling `readChat` and explicitly checking that the chat context has actually changed.');
  lines.push('');

  // ── DevConsole API for verification ──
  lines.push('## DOM Exploration');
  if (domContext) {
    lines.push('A lightweight DOM snapshot is included above, but you MUST still verify selectors yourself before finalizing the scripts.');
  } else {
    lines.push('No DOM snapshot is included here. You MUST use your command-line tools to discover the IDE structure dynamically.');
  }
  lines.push('');
  lines.push('### 1. Evaluate JS to explore IDE DOM');
  lines.push('Use cURL to run JavaScript inside the IDE:');
  lines.push('```bash');
  lines.push(`curl -sS -X POST http://127.0.0.1:${DEV_SERVER_PORT}/api/cdp/evaluate \\`);
  lines.push(`  -H "Content-Type: application/json" \\`);
  lines.push(`  -d '{"expression": "document.body.innerHTML.substring(0, 1000)", "ideType": "${cdpIdeType}"}'`);
  lines.push('```');
  lines.push('');
  lines.push('### 2. Test your generated function');
  lines.push('Once you save the file, test it by running:');
  lines.push('```bash');
  lines.push(`curl -X POST http://127.0.0.1:${DEV_SERVER_PORT}/api/providers/reload`);
  lines.push(`curl -sS -X POST http://127.0.0.1:${DEV_SERVER_PORT}/api/scripts/run -H "Content-Type: application/json" -d '{"script": "readChat", "type": "${type}", "ideType": "${cdpIdeType}"}'`);
  lines.push('```');
  lines.push('');
  lines.push('### Task Workflow');
  lines.push('1. Write bash scripts to `curl` the CDP evaluate API above to find exactly where `.chat-message`, etc., are located.');
  lines.push('2. Iteratively explore until you are confident in your selectors.');
  lines.push('3. Edit the `.js` files using the selectors you discovered.');
  lines.push('4. Reload providers and TEST your script via the API.');
  lines.push('');
  lines.push('### 🔥 Advanced UI Parsing (CRUCIAL for `readChat`)');
  lines.push(
    `Your \`readChat\` must flawlessly parse complex UI elements (tables, code blocks, tool calls, and AI thoughts). Match the depth of the **${referenceType || 'reference'}** scripts above (patterns and structure, not necessarily the same DOM).`,
  );
  lines.push('To achieve this, you MUST generate a live test scenario:');
  lines.push(`1. Early in your process, send a rich prompt to the IDE using the API:`);
  lines.push(`   \`curl -sS -X POST http://127.0.0.1:${DEV_SERVER_PORT}/api/scripts/run -H "Content-Type: application/json" -d '{"script": "sendMessage", "type": "${type}", "ideType": "${cdpIdeType}", "args": {"message": "Write a python script, draw a markdown table, use a tool, and show your reasoning/thought process"}}'\``);
  lines.push('2. Wait a few seconds for the IDE AI to generate these elements in the UI.');
  lines.push('3. Use CDP evaluate to deeply inspect the DOM structure of the newly generated tables, code blocks, thought blocks, and tool calls.');
  lines.push('4. Ensure `readChat` extracts `content` with precise markdown formatting (especially for tables/code) and assigns correct `kind` tags (`thought`, `tool`, `terminal`).');
  lines.push('');

  // ── Mandatory Integration Test ──
  lines.push('## 🧪 MANDATORY: Status Integration Test');
  lines.push('Before finishing, you MUST run this end-to-end test to verify readChat status transitions work:');
  lines.push('');
  lines.push('### Step 1: Baseline — confirm idle');
  lines.push('```bash');
  lines.push(`curl -X POST http://127.0.0.1:${DEV_SERVER_PORT}/api/providers/reload`);
  lines.push(`RESULT=$(curl -sS -X POST http://127.0.0.1:${DEV_SERVER_PORT}/api/scripts/run -H "Content-Type: application/json" -d '{"script": "readChat", "type": "${type}", "ideType": "${cdpIdeType}"}')`);
  lines.push(`echo "$RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); r=d.get('result',d); r=json.loads(r) if isinstance(r,str) else r; assert r.get('status')=='idle', f'Expected idle, got {r.get(chr(34)+chr(115)+chr(116)+chr(97)+chr(116)+chr(117)+chr(115)+chr(34))}'; print('Step 1 PASS: status=idle')"`);
  lines.push('```');
  lines.push('');
  lines.push('### Step 2: Send a LONG message that triggers extended generation (10+ seconds)');
  lines.push('```bash');
  lines.push(`curl -sS -X POST http://127.0.0.1:${DEV_SERVER_PORT}/api/scripts/run -H "Content-Type: application/json" -d '{"script": "sendMessage", "type": "${type}", "ideType": "${cdpIdeType}", "args": {"message": "Write an extremely detailed 5000-word essay about the history of artificial intelligence from Alan Turing to 2025. Be very thorough and verbose."}}'`);
  lines.push('sleep 3');
  lines.push('```');
  lines.push('');
  lines.push('### Step 3: Check generating OR completed');
  lines.push('The AI may still be generating OR may have finished already. Either generating or idle is acceptable:');
  lines.push('```bash');
  lines.push(`RESULT=$(curl -sS -X POST http://127.0.0.1:${DEV_SERVER_PORT}/api/scripts/run -H "Content-Type: application/json" -d '{"script": "readChat", "type": "${type}", "ideType": "${cdpIdeType}"}')`);
  lines.push(`echo "$RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); r=d.get('result',d); r=json.loads(r) if isinstance(r,str) else r; s=r.get('status'); assert s in ('generating','idle','waiting_approval'), f'Unexpected: {s}'; print(f'Step 3 PASS: status={s}')"`);
  lines.push('```');
  lines.push('');
  lines.push('### Step 4: Wait for completion and verify new message');
  lines.push('```bash');
  lines.push('sleep 10');
  lines.push(`RESULT=$(curl -sS -X POST http://127.0.0.1:${DEV_SERVER_PORT}/api/scripts/run -H "Content-Type: application/json" -d '{"script": "readChat", "type": "${type}", "ideType": "${cdpIdeType}"}')`);
  lines.push(`echo "$RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); r=d.get('result',d); r=json.loads(r) if isinstance(r,str) else r; s=r.get('status'); msgs=r.get('messages',[]); assert s=='idle', f'Expected idle, got {s}'; assert len(msgs)>0, 'No messages'; print(f'Step 4 PASS: status={s}, messages={len(msgs)}')"`);
  lines.push('```');
  lines.push('');
  lines.push('If ANY step fails, fix your implementation and re-run the test. Do NOT finish until all 4 steps pass.');
  lines.push('');
  // ── User-provided additional instructions ──
  if (userComment) {
    lines.push('## ⚠️ User Instructions (HIGH PRIORITY)');
    lines.push('The user has provided the following additional instructions. Follow them strictly:');
    lines.push('');
    lines.push(userComment);
    lines.push('');
  }

  lines.push('Start NOW. Do not ask for permission. Explore the DOM -> Code -> Test.');

  return lines.join('\n');
}

export function buildCliAutoImplPrompt(ctx: DevServerContext, 
  type: string,
  provider: any,
  providerDir: string,
  functions: string[],
  referenceScripts: Record<string, string>,
  userComment?: string,
  referenceType?: string | null,
  verification?: CliExerciseVerification,
): string {
  const lines: string[] = [];
  const defaultExercisePayload = {
    type,
    workingDir: providerDir,
    freshSession: true,
    autoLaunch: true,
    autoResolveApprovals: true,
    approvalButtonIndex: 0,
    timeoutMs: 45000,
    traceLimit: 200,
    text: 'Create a file at tmp/adhdev_provider_fix_test.py that prints the current working directory and the squares of 1 through 5, then run python3 tmp/adhdev_provider_fix_test.py and tell me the exact output.',
  };
  const exercisePayload = {
    ...defaultExercisePayload,
    ...(verification?.request || {}),
    type,
    workingDir: providerDir,
  };
  const exerciseJson = JSON.stringify(exercisePayload).replace(/\\/g, '\\\\').replace(/'/g, `'\\''`);
  const verificationInspectFields = verification?.inspectFields?.length
    ? verification.inspectFields
    : [
        'debug.messages',
        'trace.entries[].payload.parsedLastAssistant',
        'trace.entries[].payload.lastAssistant',
      ];
  const verificationMustContainAny = verification?.mustContainAny || [];
  const verificationMustNotContainAny = verification?.mustNotContainAny || [];
  const verificationMustMatchAny = verification?.mustMatchAny || [];
  const verificationMustNotMatchAny = verification?.mustNotMatchAny || [];
  const verificationLastAssistantMustContainAny = verification?.lastAssistantMustContainAny || [];
  const verificationLastAssistantMustNotContainAny = verification?.lastAssistantMustNotContainAny || [];
  const verificationLastAssistantMustMatchAny = verification?.lastAssistantMustMatchAny || [];
  const verificationLastAssistantMustNotMatchAny = verification?.lastAssistantMustNotMatchAny || [];
  const quotedMustContain = verificationMustContainAny.map((value) => JSON.stringify(value)).join(', ');
  const quotedMustNotContain = verificationMustNotContainAny.map((value) => JSON.stringify(value)).join(', ');
  const quotedMustMatch = verificationMustMatchAny.map((value) => JSON.stringify(value)).join(', ');
  const quotedMustNotMatch = verificationMustNotMatchAny.map((value) => JSON.stringify(value)).join(', ');
  const quotedLastAssistantMustContain = verificationLastAssistantMustContainAny.map((value) => JSON.stringify(value)).join(', ');
  const quotedLastAssistantMustNotContain = verificationLastAssistantMustNotContainAny.map((value) => JSON.stringify(value)).join(', ');
  const quotedLastAssistantMustMatch = verificationLastAssistantMustMatchAny.map((value) => JSON.stringify(value)).join(', ');
  const quotedLastAssistantMustNotMatch = verificationLastAssistantMustNotMatchAny.map((value) => JSON.stringify(value)).join(', ');
  const fixtureName = verification?.fixtureName || `${type}-provider-fix`;
  const fixtureNames = Array.isArray(verification?.fixtureNames)
    ? verification!.fixtureNames.map((value) => String(value || '').trim()).filter(Boolean)
    : [];
  const fixtureCaptureJson = JSON.stringify({
    type,
    name: fixtureName,
    request: exercisePayload,
    assertions: {
      mustContainAny: verificationMustContainAny,
      mustNotContainAny: verificationMustNotContainAny,
      mustMatchAny: verificationMustMatchAny,
      mustNotMatchAny: verificationMustNotMatchAny,
      lastAssistantMustContainAny: verificationLastAssistantMustContainAny,
      lastAssistantMustNotContainAny: verificationLastAssistantMustNotContainAny,
      lastAssistantMustMatchAny: verificationLastAssistantMustMatchAny,
      lastAssistantMustNotMatchAny: verificationLastAssistantMustNotMatchAny,
      requireNotTimedOut: true,
    },
  }).replace(/\\/g, '\\\\').replace(/'/g, `'\\''`);
  const fixtureReplayJson = JSON.stringify({
    type,
    name: fixtureName,
  }).replace(/\\/g, '\\\\').replace(/'/g, `'\\''`);

  lines.push('You are implementing PTY parsing scripts for a CLI provider.');
  lines.push('Be concise. Do NOT explain your reasoning. Edit files directly and verify with the local DevServer.');
  lines.push('');

  lines.push(`# Target: ${provider.name || type} (${type})`);
  lines.push(`Provider directory: \`${providerDir}\``);
  lines.push('Provider category: `cli`');
  lines.push('');

  const funcToFile: Record<string, string> = {
    parseOutput: 'parse_output.js',
    detectStatus: 'detect_status.js',
    parseApproval: 'parse_approval.js',
  };
  const targetFileNames = new Set(functions.map(fn => funcToFile[fn]).filter(Boolean));

  const scriptsDir = path.join(providerDir, 'scripts');
  const latestScriptsDir = getLatestScriptVersionDir(scriptsDir);
  if (latestScriptsDir) {
    lines.push(`Scripts version directory: \`${latestScriptsDir}\``);
    lines.push('');

    // Target files: editable
    lines.push('## ✏️ Target Files (EDIT THESE)');
    lines.push('These are the ONLY files you are allowed to modify. Replace TODO or heuristic-only logic with working PTY-aware implementations.');
    lines.push('');
    for (const file of fs.readdirSync(latestScriptsDir)) {
      if (!file.endsWith('.js')) continue;
      if (!targetFileNames.has(file)) continue;
      try {
        const content = fs.readFileSync(path.join(latestScriptsDir, file), 'utf-8');
        lines.push(`### \`${file}\` ✏️ EDIT`);
        lines.push('```javascript');
        lines.push(content);
        lines.push('```');
        lines.push('');
      } catch {
        // ignore
      }
    }

    // Non-target files: reference only
    const refFiles = fs.readdirSync(latestScriptsDir).filter(f => f.endsWith('.js') && !targetFileNames.has(f));
    if (refFiles.length > 0) {
      lines.push('## 🔒 Other Scripts (REFERENCE ONLY — DO NOT EDIT)');
      lines.push('These files are shown for context only. Do NOT modify them under any circumstances.');
      lines.push('');
      for (const file of refFiles) {
        try {
          const content = fs.readFileSync(path.join(latestScriptsDir, file), 'utf-8');
          lines.push(`### \`${file}\` 🔒`);
          lines.push('```javascript');
          lines.push(content);
          lines.push('```');
          lines.push('');
        } catch {
          // ignore
        }
      }
    }
  }



  if (Object.keys(referenceScripts).length > 0) {
    lines.push(`## Reference Implementation (from ${referenceType || 'another CLI'} provider)`);
    lines.push('These are working CLI PTY parser scripts. Reuse the parsing shape and runtime contract, but adapt to the target CLI screen.');
    lines.push('');
    for (const fn of functions) {
      const fileName = funcToFile[fn];
      if (fileName && referenceScripts[fileName]) {
        lines.push(`### ${fn} → \`${fileName}\``);
        lines.push('```javascript');
        lines.push(referenceScripts[fileName]);
        lines.push('```');
        lines.push('');
      }
    }
    if (referenceScripts['scripts.js']) {
      lines.push('### Router → `scripts.js`');
      lines.push('```javascript');
      lines.push(referenceScripts['scripts.js']);
      lines.push('```');
      lines.push('');
    }
  }

  // ── Markdown Guides (Provider Fix) ──
  const docsDir = path.join(providerDir, '../../docs');
  const loadGuide = (name: string) => {
    try {
      const p = path.join(docsDir, name);
      if (fs.existsSync(p)) return fs.readFileSync(p, 'utf-8');
    } catch { /* ignore */ }
    return null;
  };

  const providerGuide = loadGuide('PROVIDER_GUIDE.md');
  if (providerGuide && provider.category !== 'cli') {
    lines.push('## Documentation: PROVIDER_GUIDE.md');
    lines.push('```markdown');
    lines.push(providerGuide);
    lines.push('```');
    lines.push('');
  }

  lines.push('## Runtime Contract');
  lines.push('The daemon runtime is already implemented in `packages/daemon-core/src/cli-adapters/provider-cli-adapter.ts`.');
  lines.push('Your scripts receive PTY-derived input and must return plain JS objects.');
  lines.push('');
  lines.push('| Function | Input | Return |');
  lines.push('|---|---|---|');
  lines.push('| `parseOutput` | `{ buffer, rawBuffer, recentBuffer, screenText, messages, partialResponse }` | `{ id, status, title, messages, activeModal }` |');
  lines.push('| `detectStatus` | `{ tail, screenText, rawBuffer }` | `idle`, `generating`, `waiting_approval`, or `error` |');
  lines.push('| `parseApproval` | `{ buffer, rawBuffer, tail }` | `{ message, buttons }` or `null` |');
  lines.push('');
  lines.push('## Primary Source of Truth');
  lines.push('The runtime now provides a reliable current-screen snapshot. Treat `screenText` as the primary source of truth for the LIVE visible UI.');
  lines.push('That means:');
  lines.push('- Use `screenText` first for prompt detection, approval UI, status, and visible assistant content.');
  lines.push('- Use `rawBuffer` only as supporting evidence when ANSI/style/cursor cues matter.');
  lines.push('- Use `buffer` only when the visible screen does not contain enough text to recover the latest assistant answer.');
  lines.push('- Do NOT build the parser around stale transcript noise if the current screen already gives the answer.');
  lines.push('');

  lines.push('## Rules');
  lines.push('0. **🚫 SCOPE CONSTRAINT**: You may ONLY edit files marked ✏️ EDIT above. ALL other files are READ-ONLY. Do NOT modify, rewrite, refactor, or "improve" any file not explicitly marked as editable — even if you notice bugs or improvements. No exceptions.');
  lines.push('1. These scripts run in Node.js CommonJS, not in the browser. Do NOT use DOM APIs.');
  lines.push('2. Prefer `screenText` for current visible UI state. It is now the PTY equivalent of a trustworthy live DOM snapshot.');
  lines.push('3. Use `messages` as prior transcript state so redraws do not duplicate old turns on every parse.');
  lines.push('4. Use `partialResponse` for the actively streaming assistant text when status is `generating`.');
  lines.push('5. `detectStatus` must stay lightweight and current-screen-oriented. Prefer the active bottom-of-screen region over stale history.');
  lines.push('6. `parseApproval` should understand the live approval area and return clean button labels from the CURRENT visible modal.');
  lines.push('7. Use `rawBuffer` only when ANSI/control-sequence artifacts or style cues matter. Do not depend on raw escape noise unless necessary.');
  lines.push('8. Keep exports compatible with the existing `scripts.js` router (`module.exports = function ...`).');
  lines.push('9. Do NOT modify ANY file not explicitly marked ✏️ EDIT above. No exceptions — no "tiny supporting changes" to other files.');
  lines.push('10. When the verification API returns `instanceId`, keep using that exact instance for follow-up `send`, `resolve`, `raw`, and `stop` calls. Do not assume type-only routing is safe if multiple sessions exist.');
  lines.push('11. Do NOT repeatedly dump the same target files. Read the target scripts once, reproduce the bug, then move directly to patching.');
  lines.push('12. If the user instructions include concrete screen text, raw PTY snippets, or a specific repro, treat that as the primary acceptance criteria.');
  lines.push('13. After the first successful live repro, stop broad diagnosis. Edit the scripts, reload, and verify. Do not burn tokens on repeated re-inspection without code changes.');
  lines.push('14. If the visible current screen is clean and sufficient, do NOT fall back to complex buffer heuristics. Simpler current-screen parsing is preferred.');
  lines.push('15. Before changing parser logic, verify whether `provider.json` submit/approval behavior (`sendDelayMs`, `approvalKeys`, submit strategy) is the simpler and more correct fix.');
  lines.push('16. Do NOT patch transcript bugs by piling up one-off literal string exceptions (`includes("foo")`, `=== "bar"`, ad hoc allowlists/denylists) for every observed variant. Model the UI as PATTERN FAMILIES using reusable regex classifiers and normalization first.');
  lines.push('17. If you find yourself adding a second or third near-duplicate literal check for spinner words, tool headers, approval prompts, footer chrome, or OSC residue, STOP and replace them with a broader regex or helper classifier.');
  lines.push('18. Prefer a small number of named classifiers such as "status line", "tool header", "tool detail", "footer chrome", "approval cue", "prompt line", and "OSC residue" over a long chain of unrelated string checks.');
  lines.push('19. Literal string checks are allowed only for stable proper nouns or exact product chrome that cannot be expressed safely as a broader pattern. Everything else should generalize.');
  lines.push('20. When a bug comes from noisy PTY text, first normalize and classify the line family; do NOT just append another special-case substring to the parser.');
  lines.push('');

  if (verification?.focusAreas?.length) {
    lines.push('## Provider-Specific Focus Areas');
    for (const area of verification.focusAreas) {
      lines.push(`- ${area}`);
    }
    lines.push('');
  }

  lines.push('## Task');
  lines.push(`Edit files in \`${providerDir}\` to implement: **${functions.join(', ')}**`);
  lines.push('');

  lines.push('## Verification API');
  lines.push('Use the DevServer CLI debug endpoints, not DOM/CDP routes.');
  lines.push('');
  lines.push('### 1. Preferred: run a full autonomous repro');
  lines.push('Use the exercise endpoint first. It launches a fresh CLI session, sends the repro prompt, auto-resolves approvals, waits for the session to settle, and returns the final debug + trace payload in one response.');
  lines.push('```bash');
  lines.push(`curl -sS -X POST http://127.0.0.1:${DEV_SERVER_PORT}/api/cli/exercise \\`);
  lines.push('  -H "Content-Type: application/json" \\');
  lines.push(`  -d '${exerciseJson}'`);
  lines.push('```');
  lines.push('');
  if (verification?.description) {
    lines.push('Verification intent:');
    lines.push(verification.description);
    lines.push('');
  }
  lines.push('Read the JSON response carefully. It already includes:');
  lines.push('1. `instanceId`');
  lines.push('2. `statusesSeen` and `approvalsResolved`');
  lines.push('3. `debug` for the final settled state');
  lines.push('4. `trace.entries` for the repro turn');
  lines.push('');
  lines.push('Save the response to a temp file and inspect the exact parsed transcript fields before editing:');
  lines.push('```bash');
  lines.push(`EXERCISE_JSON=$(mktemp)`);
  lines.push(`curl -sS -X POST http://127.0.0.1:${DEV_SERVER_PORT}/api/cli/exercise \\`);
  lines.push('  -H "Content-Type: application/json" \\');
  lines.push(`  -d '${exerciseJson}' > "$EXERCISE_JSON"`);
  lines.push(`jq '{timedOut,statusesSeen,approvalsResolved,inspect:{${verificationInspectFields.map((field, index) => `f${index + 1}: .${field}`).join(', ')}}}' "$EXERCISE_JSON"`);
  lines.push('```');
  lines.push('');
  if (
    verificationMustContainAny.length > 0
    || verificationMustNotContainAny.length > 0
    || verificationMustMatchAny.length > 0
    || verificationMustNotMatchAny.length > 0
    || verificationLastAssistantMustContainAny.length > 0
    || verificationLastAssistantMustNotContainAny.length > 0
    || verificationLastAssistantMustMatchAny.length > 0
    || verificationLastAssistantMustNotMatchAny.length > 0
  ) {
    lines.push('The exact repro below is mandatory. Do NOT declare success unless these transcript assertions pass on the exercise JSON from the PATCHED provider.');
    lines.push('```bash');
    if (verificationMustContainAny.length > 0) {
      lines.push(`node -e 'const fs=require(\"fs\");const text=fs.readFileSync(process.argv[1],\"utf8\");const required=[${quotedMustContain}];const missing=required.filter(v=>!text.includes(v));if(missing.length){console.error(\"Missing required substrings:\\n\"+missing.join(\"\\n\"));process.exit(1);}' "$EXERCISE_JSON"`);
    }
    if (verificationMustNotContainAny.length > 0) {
      lines.push(`node -e 'const fs=require(\"fs\");const text=fs.readFileSync(process.argv[1],\"utf8\");const banned=[${quotedMustNotContain}];const hits=banned.filter(v=>text.includes(v));if(hits.length){console.error(\"Found banned substrings:\\n\"+hits.join(\"\\n\"));process.exit(1);}' "$EXERCISE_JSON"`);
    }
    if (verificationMustMatchAny.length > 0) {
      lines.push(`node -e 'const fs=require(\"fs\");const text=fs.readFileSync(process.argv[1],\"utf8\");const required=[${quotedMustMatch}].map(v=>new RegExp(v,\"m\"));const missing=required.filter(v=>!v.test(text)).map(v=>String(v));if(missing.length){console.error(\"Missing required regex matches:\\n\"+missing.join(\"\\n\"));process.exit(1);}' "$EXERCISE_JSON"`);
    }
    if (verificationMustNotMatchAny.length > 0) {
      lines.push(`node -e 'const fs=require(\"fs\");const text=fs.readFileSync(process.argv[1],\"utf8\");const banned=[${quotedMustNotMatch}].map(v=>new RegExp(v,\"m\"));const hits=banned.filter(v=>v.test(text)).map(v=>String(v));if(hits.length){console.error(\"Found banned regex matches:\\n\"+hits.join(\"\\n\"));process.exit(1);}' "$EXERCISE_JSON"`);
    }
    if (verificationLastAssistantMustContainAny.length > 0) {
      lines.push(`node -e 'const fs=require(\"fs\");const payload=JSON.parse(fs.readFileSync(process.argv[1],\"utf8\"));const text=String(payload.lastAssistant||\"\");const required=[${quotedLastAssistantMustContain}];const missing=required.filter(v=>!text.includes(v));if(missing.length){console.error(\"Missing required lastAssistant substrings:\\n\"+missing.join(\"\\n\"));process.exit(1);}' "$EXERCISE_JSON"`);
    }
    if (verificationLastAssistantMustNotContainAny.length > 0) {
      lines.push(`node -e 'const fs=require(\"fs\");const payload=JSON.parse(fs.readFileSync(process.argv[1],\"utf8\"));const text=String(payload.lastAssistant||\"\");const banned=[${quotedLastAssistantMustNotContain}];const hits=banned.filter(v=>text.includes(v));if(hits.length){console.error(\"Found banned lastAssistant substrings:\\n\"+hits.join(\"\\n\"));process.exit(1);}' "$EXERCISE_JSON"`);
    }
    if (verificationLastAssistantMustMatchAny.length > 0) {
      lines.push(`node -e 'const fs=require(\"fs\");const payload=JSON.parse(fs.readFileSync(process.argv[1],\"utf8\"));const text=String(payload.lastAssistant||\"\");const required=[${quotedLastAssistantMustMatch}].map(v=>new RegExp(v,\"m\"));const missing=required.filter(v=>!v.test(text)).map(v=>String(v));if(missing.length){console.error(\"Missing required lastAssistant regex matches:\\n\"+missing.join(\"\\n\"));process.exit(1);}' "$EXERCISE_JSON"`);
    }
    if (verificationLastAssistantMustNotMatchAny.length > 0) {
      lines.push(`node -e 'const fs=require(\"fs\");const payload=JSON.parse(fs.readFileSync(process.argv[1],\"utf8\"));const text=String(payload.lastAssistant||\"\");const banned=[${quotedLastAssistantMustNotMatch}].map(v=>new RegExp(v,\"m\"));const hits=banned.filter(v=>v.test(text)).map(v=>String(v));if(hits.length){console.error(\"Found banned lastAssistant regex matches:\\n\"+hits.join(\"\\n\"));process.exit(1);}' "$EXERCISE_JSON"`);
    }
    lines.push('```');
    lines.push('');
  }
  lines.push('If you need a manual follow-up repro after patching, use the SAME endpoint again with the SAME prompt and compare the new trace to the previous one.');
  lines.push('');
  lines.push('### 1b. Persist or replay the exact repro as a reusable fixture');
  if (fixtureNames.length > 0) {
    lines.push(`Replay this exact fixture suite before editing, and replay the SAME suite again after patching. Do not declare success unless EVERY fixture passes: ${fixtureNames.map((name) => `\`${name}\``).join(', ')}.`);
    for (const name of fixtureNames) {
      const replayJson = JSON.stringify({ type, name }).replace(/\\/g, '\\\\').replace(/'/g, `'\\''`);
      lines.push('```bash');
      lines.push(`curl -sS -X POST http://127.0.0.1:${DEV_SERVER_PORT}/api/cli/fixture/replay \\`);
      lines.push('  -H "Content-Type: application/json" \\');
      lines.push(`  -d '${replayJson}'`);
      lines.push('```');
      lines.push('');
    }
    lines.push('Do not create new fixtures unless one of the listed fixtures is missing or stale.');
  } else if (verification?.fixtureName) {
    lines.push(`Replay the EXISTING saved fixture \`${fixtureName}\` before editing, and replay the SAME fixture again after patching. Do not declare success unless that exact fixture passes.`);
    lines.push('```bash');
    lines.push(`curl -sS -X POST http://127.0.0.1:${DEV_SERVER_PORT}/api/cli/fixture/replay \\`);
    lines.push('  -H "Content-Type: application/json" \\');
    lines.push(`  -d '${fixtureReplayJson}'`);
    lines.push('```');
    lines.push('');
    lines.push('Only if the named fixture is missing or outdated should you recapture it. Prefer replaying the existing failing fixture over creating a new one.');
    lines.push('```bash');
    lines.push(`curl -sS -X POST http://127.0.0.1:${DEV_SERVER_PORT}/api/cli/fixture/capture \\`);
    lines.push('  -H "Content-Type: application/json" \\');
    lines.push(`  -d '${fixtureCaptureJson}'`);
    lines.push('```');
  } else {
    lines.push('Capture the exact exercise once before editing. After patching, replay THIS fixture and do not declare success unless replay passes.');
    lines.push('```bash');
    lines.push(`curl -sS -X POST http://127.0.0.1:${DEV_SERVER_PORT}/api/cli/fixture/capture \\`);
    lines.push('  -H "Content-Type: application/json" \\');
    lines.push(`  -d '${fixtureCaptureJson}'`);
    lines.push('');
    lines.push(`curl -sS -X POST http://127.0.0.1:${DEV_SERVER_PORT}/api/cli/fixture/replay \\`);
    lines.push('  -H "Content-Type: application/json" \\');
    lines.push(`  -d '${fixtureReplayJson}'`);
    lines.push('```');
  }
  lines.push('');
  lines.push('The capture endpoint saves the exact request, initial result, and transcript assertions into the provider directory. The replay endpoint reruns the SAME exercise against your patched scripts and returns pass/fail.');
  lines.push('');
  lines.push('### 2. Inspect parsed + raw adapter state');
  lines.push('```bash');
  lines.push(`curl -sS -X POST http://127.0.0.1:${DEV_SERVER_PORT}/api/cli/launch \\`);
  lines.push('  -H "Content-Type: application/json" \\');
  lines.push(`  -d '{"type":"${type}","workingDir":"${providerDir.replace(/\\/g, '\\\\')}"}'`);
  lines.push(`curl -sS http://127.0.0.1:${DEV_SERVER_PORT}/api/cli/debug/${type}`);
  lines.push(`curl -sS http://127.0.0.1:${DEV_SERVER_PORT}/api/cli/trace/${type}`);
  lines.push(`curl -sS http://127.0.0.1:${DEV_SERVER_PORT}/api/cli/status`);
  lines.push('```');
  lines.push('');
  lines.push('The CLI trace endpoint is the primary debugging source. Read it BEFORE editing any parser code.');
  lines.push('Use the trace timeline to find the latest `settled` or `commit_transcript` frame for the repro turn and inspect these fields first:');
  lines.push('1. `payload.screenText`');
  lines.push('2. `payload.detectStatus` and `payload.parsedStatus`');
  lines.push('3. `payload.parsedLastAssistant`');
  lines.push('4. `payload.approval` / `payload.parsedActiveModal`');
  lines.push('5. `payload.rawPreview` only when control-sequence residue matters');
  lines.push('');
  lines.push('The debug payload should be read in this priority order:');
  lines.push('1. `screenText` / current visible state');
  lines.push('2. parsed `status`, `messages`, `activeModal`');
  lines.push('3. `rawBuffer` only for style/control-sequence cues');
  lines.push('4. `buffer` only when the current screen is insufficient');
  lines.push('');
  lines.push('If the bug is transcript corruption, quote the exact bad `parsedLastAssistant` or bad committed assistant message from the trace and patch against that concrete failure.');
  lines.push('Do NOT guess based only on the final chat bubble or a truncated UI preview.');
  lines.push('');
  lines.push('Extract the current `instanceId` from the exercise, launch, or status response and keep using it below.');
  lines.push('');
  lines.push('### 3. Manual fallback only: send a realistic approval-triggering prompt');
  lines.push('```bash');
  lines.push(`curl -sS -X POST http://127.0.0.1:${DEV_SERVER_PORT}/api/cli/send \\`);
  lines.push('  -H "Content-Type: application/json" \\');
  lines.push(`  -d '{"type":"${type}","instanceId":"<INSTANCE_ID>","text":"Create a file at tmp/adhdev_provider_fix_test.py that prints the current working directory and the squares of 1 through 5, then run python3 tmp/adhdev_provider_fix_test.py and tell me the exact output."}'`);
  lines.push('```');
  lines.push('');
  lines.push('### 4. Manual fallback only: if approval appears, resolve it until the CLI reaches idle');
  lines.push('```bash');
  lines.push(`curl -sS -X POST http://127.0.0.1:${DEV_SERVER_PORT}/api/cli/resolve \\`);
  lines.push('  -H "Content-Type: application/json" \\');
  lines.push(`  -d '{"type":"${type}","instanceId":"<INSTANCE_ID>","buttonIndex":0}'`);
  lines.push(`curl -sS -X POST http://127.0.0.1:${DEV_SERVER_PORT}/api/cli/raw \\`);
  lines.push('  -H "Content-Type: application/json" \\');
  lines.push(`  -d '{"type":"${type}","instanceId":"<INSTANCE_ID>","keys":"1"}'`);
  lines.push('```');
  lines.push('');
  lines.push('Use `resolve` when the parsed modal buttons are correct. Use `raw` when the CLI expects a literal keystroke like `1`, `y`, or Enter. Repeat until idle. Prefer the exercise endpoint instead of doing this by hand.');
  lines.push('');
  lines.push('### Patch Discipline');
  lines.push('Once the repro is confirmed, immediately edit the target files. Avoid loops where you keep re-reading long files or re-running the same debug commands without changing code.');
  lines.push('For CLI transcript bugs, reproduce once with the exercise endpoint, inspect the returned trace once, patch immediately, then re-run the SAME exercise and compare the new `commit_transcript` frame.');
  lines.push('If the patched run still fails the exact required/banned substring checks above, the task is NOT complete even if the CLI exits normally.');
  lines.push('When you patch, write down the pattern family you are fixing: e.g. spinner/status, tool block, approval modal, footer chrome, OSC/control residue, prompt echo, or long-output continuation. Patch that family once instead of adding case-by-case literals.');
  lines.push('Bad fix pattern: add another `includes("Drizzling")` or `includes("Show more (")` check. Good fix pattern: broaden the regex/helper that recognizes spinner words, collapsed tool overflow lines, or footer chrome as a family.');
  lines.push('');
  lines.push('### 5. Verify the side effects outside the CLI');
  lines.push('```bash');
  lines.push('test -f tmp/adhdev_provider_fix_test.py');
  lines.push('python3 tmp/adhdev_provider_fix_test.py');
  lines.push('```');
  lines.push('');
  lines.push('### 6. Stop the CLI when finished');
  lines.push('```bash');
  lines.push(`curl -sS -X POST http://127.0.0.1:${DEV_SERVER_PORT}/api/cli/stop \\`);
  lines.push('  -H "Content-Type: application/json" \\');
  lines.push(`  -d '{"type":"${type}","instanceId":"<INSTANCE_ID>"}'`);
  lines.push('```');
  lines.push('');

  lines.push('## Required Validation');
  lines.push('1. Confirm `detectStatus` changes sensibly between startup, generating, approval, and idle.');
  lines.push('2. Confirm `parseOutput` produces a stable transcript without duplicating past turns when the PTY redraws.');
  lines.push('3. Confirm the latest assistant message streams through `partialResponse` while generation is in progress.');
  lines.push('4. Confirm approval parsing returns meaningful button labels when the CLI requests permission.');
  lines.push('5. Confirm the Python file was actually created and executed, not just described in chat text.');
  lines.push('6. Confirm the final assistant transcript includes the exact Python output, including the working directory line and the five square numbers.');
  lines.push('7. Re-run the debug endpoints after edits. Do NOT finish until the parsed result looks correct.');
  lines.push('8. Confirm the parser still works after a redraw or scroll change without duplicating transcript history.');
  lines.push('9. Confirm the implementation prefers current-screen signals over stale history when both are present.');
  lines.push('10. For transcript-cleanliness bugs, confirm the latest `commit_transcript` trace frame no longer contains tool headers, approval prompts, OSC residue like `0;`, or footer chrome unless they are truly user-facing answer content.');
  lines.push('11. Confirm the implementation uses generalized pattern classifiers or regexes for noisy UI families instead of accumulating one-off literal string exceptions for each observed sample.');
  lines.push('');

  if (userComment) {
    lines.push('## ⚠️ User Instructions (HIGH PRIORITY)');
    lines.push('The user has provided the following additional instructions. Follow them strictly:');
    lines.push('');
    lines.push(userComment);
    lines.push('');
  }

  lines.push('Start NOW. Launch the CLI, inspect the trace and PTY state, edit the scripts, and verify via the CLI debug + trace endpoints.');

  return lines.join('\n');
}

export function handleAutoImplSSE(ctx: DevServerContext, type: string, req: http.IncomingMessage, res: http.ServerResponse): void {
  clearStaleAutoImplState(ctx, 'SSE connection opened');
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });
  res.write(`data: ${JSON.stringify({ type: 'connected', running: ctx.autoImplStatus.running, providerType: type })}\n\n`);

  // Replay existing progress
  for (const p of ctx.autoImplStatus.progress) {
    res.write(`event: ${p.event}\ndata: ${JSON.stringify(p.data)}\n\n`);
  }

  ctx.autoImplSSEClients.push(res);
  req.on('close', () => {
    ctx.autoImplSSEClients = ctx.autoImplSSEClients.filter((c: any) => c !== res);
  });
}

export function handleAutoImplCancel(ctx: DevServerContext, _type: string, _req: http.IncomingMessage, res: http.ServerResponse): void {
  clearStaleAutoImplState(ctx, 'cancel request');
  if (ctx.autoImplProcess) {
    ctx.autoImplProcess.kill('SIGTERM');
    setTimeout(() => { if (ctx.autoImplProcess) ctx.autoImplProcess.kill('SIGKILL'); }, 3000);
    sendAutoImplSSE(ctx, { event: 'complete', data: { success: false, exitCode: -1, message: '⛔ Aborted by user' } });
    ctx.autoImplProcess = null;
    ctx.autoImplStatus.running = false;
    ctx.json(res, 200, { cancelled: true });
  } else {
    ctx.autoImplStatus.running = false;
    ctx.json(res, 200, { cancelled: false, message: 'No running process' });
  }
}

export function sendAutoImplSSE(ctx: DevServerContext, msg: { event: string; data: any }): void {
  ctx.autoImplStatus.progress.push(msg);
  const payload = `event: ${msg.event}\ndata: ${JSON.stringify(msg.data)}\n\n`;
  for (const client of ctx.autoImplSSEClients) {
    try { client.write(payload); } catch { /* ignore */ }
  }
}
