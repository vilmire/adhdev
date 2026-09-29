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
import { DEFAULT_SESSION_HOST_COLS, DEFAULT_SESSION_HOST_ROWS } from '@adhdev/session-host-core';
import type * as http from 'http';
import type { ChildProcess } from 'child_process';
import type { DevServerContext, ProviderCategory } from './dev-server-types.js';
import { runCliAutoImplVerification } from './dev-cli-debug.js';
import { isPidAlive } from '../system/process-utils.js';
import { buildAutoImplPrompt } from './dev-auto-implement-prompts.js';

export type CliExerciseVerification = {
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
        windowsHide: true,
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
        cols: DEFAULT_SESSION_HOST_COLS,
        rows: DEFAULT_SESSION_HOST_ROWS,
        cwd: providerDir,
        env: { ...process.env, ...(spawn.env || {}) },
      });
      isPty = true;
    } catch (err: any) {
      ctx.log(`PTY not available, using child_process: ${err.message}`);
      child = spawnFn(isWin ? 'cmd.exe' : 'sh', [isWin ? '/c' : '-c', shellCmd], {
        cwd: providerDir,
        shell: false,
        windowsHide: true,
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
        // Legacy tui-manifest approval patterns died with ProviderCliAdapter
        // (2026-08-17); the spec FSM owns approval detection now. Keep only
        // the key fallback this dev tool types when it must answer manually.
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
