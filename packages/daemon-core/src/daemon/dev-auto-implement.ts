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
import type { DevServerContext, ProviderCategory } from './dev-server-types.js';
import { DEV_SERVER_PORT } from './dev-server.js';
import { LOG } from '../logging/logger.js';

export function getDefaultAutoImplReference(ctx: DevServerContext, category: string, type: string): string {
  if (category === 'cli') {
    return type === 'codex-cli' ? 'claude-cli' : 'codex-cli';
  }
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

  try {
    const providerData = JSON.parse(fs.readFileSync(providerJson, 'utf-8'));
    if (providerData.disableUpstream !== true) {
      providerData.disableUpstream = true;
      fs.writeFileSync(providerJson, JSON.stringify(providerData, null, 2));
    }
  } catch (error) {
    return {
      dir: null,
      reason: `Failed to update provider.json in writable provider directory: ${(error as Error).message}`,
    };
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
  const { agent = 'claude-cli', functions, reference, model, comment, providerDir: requestedProviderDir } = body;
  if (!functions || !Array.isArray(functions) || functions.length === 0) {
    ctx.json(res, 400, { error: 'functions[] is required (e.g. ["readChat", "sendMessage"])' });
    return;
  }

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

  try {
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
    const prompt = buildAutoImplPrompt(ctx, type, provider, providerDir, functions, domContext, referenceScripts, comment, resolvedReference);

    // 4. Write prompt to temp file (avoids shell escaping issues with special chars)
    const tmpDir = path.join(os.tmpdir(), 'adhdev-autoimpl');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    const promptFile = path.join(tmpDir, `prompt-${type}-${Date.now()}.md`);
    fs.writeFileSync(promptFile, prompt, 'utf-8');
    ctx.log(`Auto-implement prompt written to ${promptFile} (${prompt.length} chars)`);

    // 5. Determine agent command from provider spawn config
    const agentProvider = ctx.providerLoader.resolve(agent) || ctx.providerLoader.getMeta(agent);
    const spawn = (agentProvider as any)?.spawn;
    if (!spawn?.command) {
      try { fs.unlinkSync(promptFile); } catch { /* ignore */ }
      ctx.json(res, 400, { error: `Agent '${agent}' has no spawn config. Select a CLI provider with a spawn configuration.` });
      return;
    }

    const agentCategory = (agentProvider as any)?.category;

    // ─── ACP Agent: use ACP SDK (JSON-RPC protocol) ───
    if (agentCategory === 'acp') {
      sendAutoImplSSE(ctx, { event: 'progress', data: { function: '_init', status: 'spawning', message: `Spawning ACP agent: ${spawn.command} ${(spawn.args || []).join(' ')}` } });
      ctx.autoImplStatus = { running: true, type, progress: [] };

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

    // ─── CLI Agent: stdin pipe approach ───
    const command: string = spawn.command;
    // Strip interactive-only flags for auto-implement (non-interactive mode)
    const interactiveFlags = ['--yolo', '--interactive', '-i'];
    const baseArgs: string[] = [...(spawn.args || [])].filter((a: string) => !interactiveFlags.includes(a));

    // 6. Construct the complete shell command per-agent
    let shellCmd: string;

    if (command === 'claude') {
      // Claude Code: autonomous agent mode (no --print), skip permissions, prompt via meta-prompt
      const args = [...baseArgs, '--dangerously-skip-permissions'];
      if (model) args.push('--model', model);
      const escapedArgs = args.map(a => `'${a.replace(/'/g, "'\\''")}'`).join(' ');
      const metaPrompt = `Read the file at ${promptFile} and follow ALL the instructions. Implement the specific function requested, then test it via CDP curl targeting 127.0.0.1:19280, wait for confirmation of success, and then close. DO NOT start working on other features not listed in the prompt constraint.`;
      shellCmd = `${command} ${escapedArgs} -p "${metaPrompt}"`;
    } else if (command === 'gemini') {
      // Gemini CLI: non-interactive prompt mode
      // We can't use @file syntax (causes Parts object parsing bug) or $(cat) (arg too long).
      // Solution: meta-prompt that tells Gemini to read the instructions file itself.
      const args = [...baseArgs, '-y', '-s', 'false'];
      if (model) args.push('-m', model);
      const escapedArgs = args.map(a => `'${a.replace(/'/g, "'\\''")}'`).join(' ');
      shellCmd = `${command} ${escapedArgs} -p "Read the file at ${promptFile} and follow ALL the instructions in it exactly. Do not ask questions, just execute."`;

    } else if (command === 'codex') {
      const args = ['exec', ...baseArgs];
      if (!args.includes('--dangerously-bypass-approvals-and-sandbox')) {
        args.push('--dangerously-bypass-approvals-and-sandbox');
      }
      if (!args.includes('--skip-git-repo-check')) {
        args.push('--skip-git-repo-check');
      }
      if (model) args.push('--model', model);
      const escapedArgs = args.map(a => `'${a.replace(/'/g, "'\\''")}'`).join(' ');
      const metaPrompt = `Read the file at ${promptFile} and follow ALL instructions strictly. DO NOT spend time exploring the filesystem or other providers. You have full authority to implement ALL required script files and independently test them against 127.0.0.1:19280 via CDP CURL. Upon complete validation of ALL assigned files, print exactly "_PIPELINE_COMPLETE_SIGNAL_" to gracefully close the pipeline. DO NOT WAIT FOR APPROVAL, execute completely autonomously.`;
      shellCmd = `${command} ${escapedArgs} "${metaPrompt}"`;
    } else {
      // Generic fallback: pipe prompt via stdin
      const escapedArgs = baseArgs.map(a => `'${a.replace(/'/g, "'\\''")}'`).join(' ');
      shellCmd = `cat '${promptFile}' | ${command} ${escapedArgs}`;
    }

    sendAutoImplSSE(ctx, { event: 'progress', data: { function: '_init', status: 'spawning', message: `Spawning agent: ${shellCmd.substring(0, 200)}... (prompt: ${prompt.length} chars)` } });

    ctx.autoImplStatus = { running: true, type, progress: [] };
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
      child = spawnFn('sh', ['-c', shellCmd], {
        cwd: providerDir,
        shell: false,
        timeout: 900000,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { 
          ...process.env, 
          ...(spawn.env || {}),
          ...(command === 'gemini' ? { SANDBOX: '1', GEMINI_CLI_NO_RELAUNCH: '1' } : {}),
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
    
    try {
      const { normalizeCliProviderForRuntime } = await import('../cli-adapters/provider-cli-adapter.js');
      const normalized = normalizeCliProviderForRuntime(agentProvider);
      approvalPatterns = normalized.patterns.approval;
      approvalKeys = (agentProvider as any)?.approvalKeys || { 0: 'y\r', 1: 'a\r' };
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
        ctx.log(`Agent finished task after ${Math.round(elapsed/1000)}s. Terminating interactive CLI session to unblock pipeline.`);
        sendAutoImplSSE(ctx, { event: 'output', data: { chunk: `\n[🤖 ADHDev Pipeline] Completion token detected. Proceeding...\n`, stream: 'stdout' } });
        approvalBuffer = '';
        
        try {
          (ctx.autoImplProcess as any).kill('SIGINT');
        } catch {
          // ignore
        }
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

    if (isPty) {
      child.onData((data: string) => {
        stdout += data;
        if (data.includes('\x1b[6n')) {
          child.write('\x1b[12;1R');
          ctx.log('Terminal CPR request (\\x1b[6n) intercepted in PTY, responding with dummy coordinates [12;1R]');
        }
        checkAutoApproval(data, (s) => child.write(s));
        sendAutoImplSSE(ctx, { event: 'output', data: { chunk: data, stream: 'stdout' } });
      });
      child.onExit(({ exitCode: code }: { exitCode: number }) => {
        ctx.autoImplProcess = null;
        ctx.autoImplStatus.running = false;
        const success = code === 0;
        sendAutoImplSSE(ctx, {
          event: 'complete',
          data: { success, exitCode: code, functions, message: success ? '✅ Auto-implement complete' : `❌ Agent exited (code: ${code})` },
        });
        try { ctx.providerLoader.reload(); } catch { /* ignore */ }
        try { fs.unlinkSync(promptFile); } catch { /* ignore */ }
      });
    } else {
      child.stdout?.on('data', (d: Buffer) => {
        const chunk = d.toString();
        stdout += chunk;
        if (chunk.includes('\x1b[6n')) child.stdin?.write('\x1b[1;1R');
        checkAutoApproval(chunk, (s) => child.stdin?.write(s));
        sendAutoImplSSE(ctx, { event: 'output', data: { chunk, stream: 'stdout' } });
      });
      child.stderr?.on('data', (d: Buffer) => {
        const chunk = d.toString();
        stderr += chunk;
        checkAutoApproval(chunk, (s) => child.stdin?.write(s));
        sendAutoImplSSE(ctx, { event: 'output', data: { chunk, stream: 'stderr' } });
      });
      child.on('exit', (code: number) => {
        ctx.autoImplProcess = null;
        ctx.autoImplStatus.running = false;
        const success = code === 0;
        sendAutoImplSSE(ctx, {
          event: 'complete',
          data: {
            success,
            exitCode: code,
            functions,
            message: success ? '✅ Auto-implement complete' : `❌ Agent exited (code: ${code})`,
          },
        });
        try { ctx.providerLoader.reload(); } catch { /* ignore */ }
        try { fs.unlinkSync(promptFile); } catch { /* ignore */ }
        ctx.log(`Auto-implement ${success ? 'completed' : 'failed'}: ${type} (exit: ${code})`);
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
): string {
  if (provider.category === 'cli') {
    return buildCliAutoImplPrompt(ctx, type, provider, providerDir, functions, referenceScripts, userComment, referenceType);
  }

  const lines: string[] = [];

  // ── System instructions ──
  lines.push('You are implementing browser automation scripts for an IDE provider.');
  lines.push('Be concise. Do NOT explain your reasoning. Just edit files directly.');
  lines.push('');

  // ── Target ──
  lines.push(`# Target: ${provider.name || type} (${type})`);
  lines.push(`Provider directory: \`${providerDir}\``);
  lines.push('');

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
  lines.push('| readChat | `{ id, status, title, messages: [{role, content, index, kind?, meta?}], inputContent, activeModal }` — optional `kind`: standard, thought, tool, terminal; optional `meta`: e.g. `{ label, isRunning }` for dashboard |');
  lines.push('| sendMessage | `{ sent: false, needsTypeAndSend: true, selector }` |');
  lines.push('| resolveAction | `{ resolved: true/false, clicked? }` |');
  lines.push('| listSessions | `{ sessions: [{ id, title, active, index }] }` |');
  lines.push('| switchSession | `{ switched: true/false }` |');
  lines.push('| newSession | `{ created: true/false }` |');
  lines.push('| listModels | `{ models: [{ name, id }], current }` |');
  lines.push('| setModel | `{ success: true/false }` |');
  lines.push('| listModes | `{ modes: [{ name, id }], current }` |');
  lines.push('| setMode | `{ success: true/false }` |');
  lines.push('| focusEditor | `{ focused: true/false }` |');
  lines.push('| openPanel | `{ opened: true/false }` |');
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
  lines.push(`  -d '{"expression": "document.body.innerHTML.substring(0, 1000)", "ideType": "${type}"}'`);
  lines.push('```');
  lines.push('');
  lines.push('### 2. Test your generated function');
  lines.push('Once you save the file, test it by running:');
  lines.push('```bash');
  lines.push(`curl -X POST http://127.0.0.1:${DEV_SERVER_PORT}/api/providers/reload`);
  lines.push(`curl -sS -X POST http://127.0.0.1:${DEV_SERVER_PORT}/api/scripts/run -H "Content-Type: application/json" -d '{"script": "readChat", "type": "${type}", "ideType": "${type}"}'`);
  lines.push('```');
  lines.push('');
  lines.push('### Task Workflow');
  lines.push('1. Write bash scripts to `curl` the CDP evaluate API above to find exactly where `.chat-message`, etc., are located.');
  lines.push('2. Iteratively explore until you are confident in your selectors.');
  lines.push('3. Edit the `.js` files using the selectors you discovered.');
  lines.push('4. Reload providers and TEST your script via the API.');
  lines.push('');
  lines.push('### 🔥 Advanced UI Parsing (CRUCIAL for `readChat`)');
  lines.push('Your `readChat` must flawlessly parse complex UI elements (tables, code blocks, tool calls, and AI thoughts). The quality must match the `antigravity` reference.');
  lines.push('To achieve this, you MUST generate a live test scenario:');
  lines.push(`1. Early in your process, send a rich prompt to the IDE using the API:`);
  lines.push(`   \`curl -sS -X POST http://127.0.0.1:${DEV_SERVER_PORT}/api/scripts/run -H "Content-Type: application/json" -d '{"script": "sendMessage", "type": "${type}", "ideType": "${type}", "args": {"message": "Write a python script, draw a markdown table, use a tool, and show your reasoning/thought process"}}'\``);
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
  lines.push(`RESULT=$(curl -sS -X POST http://127.0.0.1:${DEV_SERVER_PORT}/api/scripts/run -H "Content-Type: application/json" -d '{"script": "readChat", "type": "${type}", "ideType": "${type}"}')`);
  lines.push(`echo "$RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); r=d.get('result',d); r=json.loads(r) if isinstance(r,str) else r; assert r.get('status')=='idle', f'Expected idle, got {r.get(chr(34)+chr(115)+chr(116)+chr(97)+chr(116)+chr(117)+chr(115)+chr(34))}'; print('Step 1 PASS: status=idle')"`);
  lines.push('```');
  lines.push('');
  lines.push('### Step 2: Send a LONG message that triggers extended generation (10+ seconds)');
  lines.push('```bash');
  lines.push(`curl -sS -X POST http://127.0.0.1:${DEV_SERVER_PORT}/api/scripts/run -H "Content-Type: application/json" -d '{"script": "sendMessage", "type": "${type}", "ideType": "${type}", "args": {"message": "Write an extremely detailed 5000-word essay about the history of artificial intelligence from Alan Turing to 2025. Be very thorough and verbose."}}'`);
  lines.push('sleep 3');
  lines.push('```');
  lines.push('');
  lines.push('### Step 3: Check generating OR completed');
  lines.push('The AI may still be generating OR may have finished already. Either generating or idle is acceptable:');
  lines.push('```bash');
  lines.push(`RESULT=$(curl -sS -X POST http://127.0.0.1:${DEV_SERVER_PORT}/api/scripts/run -H "Content-Type: application/json" -d '{"script": "readChat", "type": "${type}", "ideType": "${type}"}')`);
  lines.push(`echo "$RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); r=d.get('result',d); r=json.loads(r) if isinstance(r,str) else r; s=r.get('status'); assert s in ('generating','idle','waiting_approval'), f'Unexpected: {s}'; print(f'Step 3 PASS: status={s}')"`);
  lines.push('```');
  lines.push('');
  lines.push('### Step 4: Wait for completion and verify new message');
  lines.push('```bash');
  lines.push('sleep 10');
  lines.push(`RESULT=$(curl -sS -X POST http://127.0.0.1:${DEV_SERVER_PORT}/api/scripts/run -H "Content-Type: application/json" -d '{"script": "readChat", "type": "${type}", "ideType": "${type}"}')`);
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
): string {
  const lines: string[] = [];

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
  if (providerGuide) {
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

  lines.push('## Rules');
  lines.push('0. **🚫 SCOPE CONSTRAINT**: You may ONLY edit files marked ✏️ EDIT above. ALL other files are READ-ONLY. Do NOT modify, rewrite, refactor, or "improve" any file not explicitly marked as editable — even if you notice bugs or improvements. No exceptions.');
  lines.push('1. These scripts run in Node.js CommonJS, not in the browser. Do NOT use DOM APIs.');
  lines.push('2. Prefer `screenText` for current visible UI state. That is the PTY equivalent of parsing the current IDE DOM.');
  lines.push('3. Use `messages` as prior transcript state so redraws do not duplicate old turns on every parse.');
  lines.push('4. Use `partialResponse` for the actively streaming assistant text when status is `generating`.');
  lines.push('5. `detectStatus` must stay lightweight and tail-based. Do not scan the entire history there.');
  lines.push('6. `parseApproval` should understand the live approval area and return clean button labels.');
  lines.push('7. Use `rawBuffer` only when ANSI/control-sequence artifacts matter. Do not depend on raw escape noise unless necessary.');
  lines.push('8. Keep exports compatible with the existing `scripts.js` router (`module.exports = function ...`).');
  lines.push('9. Do NOT modify ANY file not explicitly marked ✏️ EDIT above. No exceptions — no "tiny supporting changes" to other files.');
  lines.push('10. When the verification API returns `instanceId`, keep using that exact instance for follow-up `send`, `resolve`, `raw`, and `stop` calls. Do not assume type-only routing is safe if multiple sessions exist.');
  lines.push('11. Do NOT repeatedly dump the same target files. Read the target scripts once, reproduce the bug, then move directly to patching.');
  lines.push('12. If the user instructions include concrete screen text, raw PTY snippets, or a specific repro, treat that as the primary acceptance criteria.');
  lines.push('13. After the first successful live repro, stop broad diagnosis. Edit the scripts, reload, and verify. Do not burn tokens on repeated re-inspection without code changes.');
  lines.push('');

  lines.push('## Task');
  lines.push(`Edit files in \`${providerDir}\` to implement: **${functions.join(', ')}**`);
  lines.push('');

  lines.push('## Verification API');
  lines.push('Use the DevServer CLI debug endpoints, not DOM/CDP routes.');
  lines.push('');
  lines.push('### 1. Launch the target CLI');
  lines.push('```bash');
  lines.push(`curl -sS -X POST http://127.0.0.1:${DEV_SERVER_PORT}/api/cli/launch \\`);
  lines.push('  -H "Content-Type: application/json" \\');
  lines.push(`  -d '{"type":"${type}","workingDir":"${providerDir.replace(/\\/g, '\\\\')}"}'`);
  lines.push('```');
  lines.push('');
  lines.push('### 2. Inspect parsed + raw adapter state');
  lines.push('```bash');
  lines.push(`curl -sS http://127.0.0.1:${DEV_SERVER_PORT}/api/cli/debug/${type}`);
  lines.push(`curl -sS http://127.0.0.1:${DEV_SERVER_PORT}/api/cli/status`);
  lines.push('```');
  lines.push('');
  lines.push('Extract the current `instanceId` from the launch or status response and keep using it below.');
  lines.push('');
  lines.push('### 3. Send a realistic approval-triggering prompt');
  lines.push('```bash');
  lines.push(`curl -sS -X POST http://127.0.0.1:${DEV_SERVER_PORT}/api/cli/send \\`);
  lines.push('  -H "Content-Type: application/json" \\');
  lines.push(`  -d '{"type":"${type}","instanceId":"<INSTANCE_ID>","text":"Create a file at tmp/adhdev_provider_fix_test.py that prints the current working directory and the squares of 1 through 5, then run python3 tmp/adhdev_provider_fix_test.py and tell me the exact output."}'`);
  lines.push('```');
  lines.push('');
  lines.push('### 4. If approval appears, resolve it until the CLI reaches idle');
  lines.push('```bash');
  lines.push(`curl -sS -X POST http://127.0.0.1:${DEV_SERVER_PORT}/api/cli/resolve \\`);
  lines.push('  -H "Content-Type: application/json" \\');
  lines.push(`  -d '{"type":"${type}","instanceId":"<INSTANCE_ID>","buttonIndex":0}'`);
  lines.push(`curl -sS -X POST http://127.0.0.1:${DEV_SERVER_PORT}/api/cli/raw \\`);
  lines.push('  -H "Content-Type: application/json" \\');
  lines.push(`  -d '{"type":"${type}","instanceId":"<INSTANCE_ID>","keys":"1"}'`);
  lines.push('```');
  lines.push('');
  lines.push('Use `resolve` when the parsed modal buttons are correct. Use `raw` when the CLI expects a literal keystroke like `1`, `y`, or Enter. Repeat until idle.');
  lines.push('');
  lines.push('### Patch Discipline');
  lines.push('Once the repro is confirmed, immediately edit the target files. Avoid loops where you keep re-reading long files or re-running the same debug commands without changing code.');
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
  lines.push('');

  if (userComment) {
    lines.push('## ⚠️ User Instructions (HIGH PRIORITY)');
    lines.push('The user has provided the following additional instructions. Follow them strictly:');
    lines.push('');
    lines.push(userComment);
    lines.push('');
  }

  lines.push('Start NOW. Launch the CLI, inspect PTY state, edit the scripts, and verify via the CLI debug endpoints.');

  return lines.join('\n');
}

export function handleAutoImplSSE(ctx: DevServerContext, type: string, req: http.IncomingMessage, res: http.ServerResponse): void {
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