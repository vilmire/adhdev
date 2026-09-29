/**
 * The ACP agent process and protocol session for AcpProviderInstance: spawning the
 * agent over stdio, wiring the ACP client (permission requests, file / terminal
 * callbacks, session updates), the `initialize` handshake, and creating or loading
 * the protocol session. Functions over the instance (`host`); the class keeps
 * delegators for the entry points.
 */
import { Readable, Writable } from 'stream';
import { spawn } from 'child_process';
import {
    ClientSideConnection,
    ndJsonStream,
    RequestError,
    PROTOCOL_VERSION,
    type Client,
    type Agent,
    type SessionNotification,
    type RequestPermissionRequest,
    type RequestPermissionResponse,
    type WriteTextFileRequest,
    type WriteTextFileResponse,
    type ReadTextFileRequest,
    type ReadTextFileResponse,
    type CreateTerminalRequest,
    type CreateTerminalResponse,
    type TerminalOutputRequest,
    type TerminalOutputResponse,
    type ReleaseTerminalRequest,
    type ReleaseTerminalResponse,
    type WaitForTerminalExitRequest,
    type WaitForTerminalExitResponse,
    type KillTerminalRequest,
    type KillTerminalResponse,
} from '@agentclientprotocol/sdk';
import type { AcpProviderInstance } from './acp-provider-instance.js';

/** The AcpProviderInstance members these functions read or call (compiler-checked; no cast). */
export type AcpAgentProcessHost = Pick<AcpProviderInstance, 'activeToolCalls' | 'agentCapabilities' | 'appendSystemMessage' | 'cliArgs' | 'configOptions' | 'connection' | 'currentStatus' | 'detectStatusTransition' | 'errorMessage' | 'errorReason' | 'getCurrentSelection' | 'handleSessionUpdate' | 'log' | 'manualAttendance' | 'messages' | 'parseConfigOptions' | 'parseModes' | 'permissionResolvers' | 'process' | 'provider' | 'selectedConfig' | 'sessionId' | 'setCurrentSelection' | 'settings' | 'spawnedAt' | 'stderrBuffer' | 'type' | 'useStaticConfig' | 'workingDir'>;

 // ─── ACP Process Management ──────────────────────
export async function spawnAgent(host: AcpAgentProcessHost): Promise<void> {
    const spawnConfig = host.provider.spawn;
    if (!spawnConfig) {
        throw new Error(`[ACP:${host.type}] No spawn config defined`);
    }

    const command = typeof host.settings.executablePath === 'string' && host.settings.executablePath.trim()
        ? host.settings.executablePath.trim()
        : spawnConfig.command;
 // Static config: create args via spawnArgBuilder (when provider defines it)
    let baseArgs = spawnConfig.args || [];
    if (host.provider.spawnArgBuilder && Object.keys(host.selectedConfig).length > 0) {
        baseArgs = host.provider.spawnArgBuilder(host.selectedConfig);
    }
    const args = [...baseArgs, ...host.cliArgs];

 // Auth: each CLI/ACP tool manages its own authentication.
 // ADHDev does NOT inject API keys — tools read their own env vars or config files.

    const env = { ...process.env, ...(spawnConfig.env || {}) };

    host.log.info(`[${host.type}] Spawning: ${command} ${args.join(' ')} in ${host.workingDir}`);

    host.spawnedAt = Date.now();
    host.errorMessage = null;
    host.errorReason = null;
    host.stderrBuffer = [];

    host.process = spawn(command, args, {
        cwd: host.workingDir,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: spawnConfig.shell || false,
        ...(process.platform === 'win32' ? { windowsHide: true } : {}),
    });

 // stderr → log + auth failure detection
    const AUTH_ERROR_PATTERNS = [
        /unauthorized|unauthenticated/i,
        /invalid.*(?:api[_ ]?key|token|credential)/i,
        /auth(?:entication|orization).*(?:fail|error|denied|invalid|expired)/i,
        /(?:api[_ ]?key|token).*(?:missing|required|not set|not found|invalid|expired)/i,
        /ENOENT|command not found|not recognized/i,
        /permission denied/i,
        /rate.?limit|quota.?exceeded/i,
        /login.*required|please.*(?:login|authenticate|sign.?in)/i,
    ];

    host.process.stderr?.on('data', (data) => {
        const text = data.toString().trim();
        if (!text) return;
        host.log.debug(`[${host.type}:stderr] ${text.slice(0, 300)}`);

 // Maintain stderr buffer (recent 20 lines)
        host.stderrBuffer.push(text);
        if (host.stderrBuffer.length > 20) host.stderrBuffer.shift();

 // Auth failure detection
        for (const pattern of AUTH_ERROR_PATTERNS) {
            if (pattern.test(text)) {
                if (/ENOENT|command not found|not recognized/i.test(text)) {
                    host.errorReason = 'not_installed';
                    host.errorMessage = `Command '${command}' not found. Install: ${host.provider.install || 'check documentation'}`;
                } else {
                    host.errorReason = 'auth_failed';
                    host.errorMessage = text.slice(0, 300);
                }
                host.log.warn(`[${host.type}] Error detected (${host.errorReason}): ${host.errorMessage?.slice(0, 100)}`);
                break;
            }
        }
    });

 // kill process detect
    host.process.on('exit', (code, signal) => {
        const elapsed = Date.now() - host.spawnedAt;
        host.log.info(`[${host.type}] Process exited: code=${code} signal=${signal} elapsed=${elapsed}ms`);

 // Exit code analysis
        if (code !== 0 && code !== null) {
            if (!host.errorReason) {
                if (code === 127) {
                    host.errorReason = 'not_installed';
                    host.errorMessage = `Command '${command}' not found (exit code 127). Install: ${host.provider.install || 'check documentation'}`;
                } else if (elapsed < 3000) {
 // 3-second crash → likely install/auth issue
                    host.errorReason = host.stderrBuffer.length > 0 ? 'crash' : 'spawn_error';
                    host.errorMessage = host.stderrBuffer.length > 0
                        ? `Agent crashed immediately (exit code ${code}): ${host.stderrBuffer.slice(-3).join(' | ').slice(0, 300)}`
                        : `Agent exited immediately with code ${code}. The agent may not be installed correctly.`;
                } else {
                    host.errorReason = 'crash';
                    host.errorMessage = `Agent exited with code ${code}${host.stderrBuffer.length > 0 ? ': ' + host.stderrBuffer.slice(-1)[0]?.slice(0, 200) : ''}`;
                }
            }
        }

        host.currentStatus = host.errorReason ? 'error' : 'stopped';
        host.detectStatusTransition();
    });

    host.process.on('error', (err) => {
        host.log.error(`[${host.type}] Process spawn error: ${err.message}`);
        if (err.message.includes('ENOENT')) {
            host.errorReason = 'not_installed';
            host.errorMessage = `Command '${command}' not found. Install: ${host.provider.install || 'check documentation'}`;
        } else {
            host.errorReason = 'spawn_error';
            host.errorMessage = err.message;
        }
        host.currentStatus = 'error';
        host.detectStatusTransition();
    });

 // ─── SDK Connection Setup ────────────────────────
 // Convert Node.js streams to Web Streams for ndJsonStream
    const webStdin = Writable.toWeb(host.process.stdin!) as WritableStream<Uint8Array>;
    const webStdout = Readable.toWeb(host.process.stdout!) as ReadableStream<Uint8Array>;
    const stream = ndJsonStream(webStdin, webStdout);

 // Create ClientSideConnection with our Client implementation
    host.connection = new ClientSideConnection((_agent: Agent) => createClient(host), stream);

 // Listen for connection close
    host.connection.signal.addEventListener('abort', () => {
        host.log.info(`[${host.type}] ACP connection closed`);
    });

 // ACP initialize handshake
    await initialize(host);
}

 // ─── Client Interface Implementation ────────────────────
export function createClient(host: AcpAgentProcessHost): Client {
    return {
        requestPermission: async (params: RequestPermissionRequest): Promise<RequestPermissionResponse> => {
            // Update active tool calls from the request
            const tc = params.toolCall;
            const existing = host.activeToolCalls.find(t => t.id === tc.toolCallId);
            if (existing) {
                existing.status = 'running';
                if (tc.title) existing.name = tc.title;
            } else {
                host.activeToolCalls.push({
                    id: tc.toolCallId,
                    name: tc.title || 'unknown',
                    status: 'running',
                    input: tc.rawInput ? (typeof tc.rawInput === 'string' ? tc.rawInput : JSON.stringify(tc.rawInput)) : undefined,
                });
            }

            // ─── Auto-approve: skip user confirmation ───
            // Held while a human is actively attending this session (manual
            // attendance) so they can decide the permission themselves; falls
            // through to the waiting_approval manual path below. A background
            // worker is never attended, so its delegated auto-approve fires
            // as before.
            if (host.settings.autoApprove !== false && !host.manualAttendance.isAttended()) {
                const toolTitle = tc.title || tc.toolCallId || 'tool call';
                host.log.info(`[${host.type}] Auto-approving: ${toolTitle}`);
                host.appendSystemMessage(`Auto-approved: ${toolTitle}`);
                const allowOption = params.options.find(o => o.kind === 'allow_once') || params.options.find(o => o.kind === 'allow_always');
                if (allowOption) {
                    return { outcome: { outcome: 'selected', optionId: allowOption.optionId } };
                }
                return { outcome: { outcome: 'selected', optionId: params.options[0]?.optionId || '' } };
            }

            // Approval request → switch to waiting_approval status
            host.currentStatus = 'waiting_approval';
            host.detectStatusTransition();

            // Wait for user approval
            const approved = await new Promise<boolean>((resolve) => {
                host.permissionResolvers.push(resolve);
                // 5-minute timeout → auto-reject
                setTimeout(() => {
                    const idx = host.permissionResolvers.indexOf(resolve);
                    if (idx >= 0) {
                        host.permissionResolvers.splice(idx, 1);
                        resolve(false);
                    }
                }, 300_000);
            });

            if (approved) {
 // Find the "allow" option (allow_once or allow_always)
                const allowOption = params.options.find(o => o.kind === 'allow_once') || params.options.find(o => o.kind === 'allow_always');
                if (allowOption) {
                    return { outcome: { outcome: 'selected', optionId: allowOption.optionId } };
                }
 // Fallback: use first option
                return { outcome: { outcome: 'selected', optionId: params.options[0]?.optionId || '' } };
            } else {
 // Find the "reject" option
                const rejectOption = params.options.find(o => o.kind === 'reject_once') || params.options.find(o => o.kind === 'reject_always');
                if (rejectOption) {
                    return { outcome: { outcome: 'selected', optionId: rejectOption.optionId } };
                }
                return { outcome: { outcome: 'cancelled' } };
            }
        },

        sessionUpdate: async (params: SessionNotification): Promise<void> => {
            host.handleSessionUpdate(params);
        },

 // File system — not supported
        readTextFile: async (_params: ReadTextFileRequest): Promise<ReadTextFileResponse> => {
            throw RequestError.methodNotFound('fs/read_text_file');
        },
        writeTextFile: async (_params: WriteTextFileRequest): Promise<WriteTextFileResponse> => {
            throw RequestError.methodNotFound('fs/write_text_file');
        },

 // Terminal — not supported
        createTerminal: async (_params: CreateTerminalRequest): Promise<CreateTerminalResponse> => {
            throw RequestError.methodNotFound('terminal/create');
        },
        terminalOutput: async (_params: TerminalOutputRequest): Promise<TerminalOutputResponse> => {
            throw RequestError.methodNotFound('terminal/output');
        },
        releaseTerminal: async (_params: ReleaseTerminalRequest): Promise<ReleaseTerminalResponse> => {
            throw RequestError.methodNotFound('terminal/release');
        },
        waitForTerminalExit: async (_params: WaitForTerminalExitRequest): Promise<WaitForTerminalExitResponse> => {
            throw RequestError.methodNotFound('terminal/wait_for_exit');
        },
        killTerminal: async (_params: KillTerminalRequest): Promise<KillTerminalResponse> => {
            throw RequestError.methodNotFound('terminal/kill');
        },
    };
}

 // ─── ACP Protocol (via SDK) ────────────────────────────
export async function initialize(host: AcpAgentProcessHost): Promise<void> {
    if (!host.connection) return;

    try {
        const result = await host.connection.initialize({
            protocolVersion: PROTOCOL_VERSION,
            clientCapabilities: {},
        });

        host.agentCapabilities = result?.agentCapabilities || {};
        host.log.info(`[${host.type}] Initialized. Agent capabilities: ${JSON.stringify(host.agentCapabilities)}`);

 // new session create
        await createSession(host);
    } catch (e: any) {
        host.log.error(`[${host.type}] Initialize failed: ${e?.message}`);
        if (!host.errorReason) {
            host.errorReason = 'init_failed';
            host.errorMessage = `ACP handshake failed: ${e?.message}${host.stderrBuffer.length > 0 ? '\n' + host.stderrBuffer.slice(-2).join('\n').slice(0, 200) : ''}`;
        }
        host.currentStatus = 'error';
    }
}

export async function createSession(host: AcpAgentProcessHost): Promise<void> {
    if (!host.connection) return;

    try {
        const result = await host.connection.newSession({
            cwd: host.workingDir,
            mcpServers: [],
        });
        host.sessionId = result?.sessionId || null;
        host.currentStatus = 'idle';
        host.messages = [];

 // DEBUG: session/new response key check
        host.log.info(`[${host.type}] session/new result keys: ${result ? Object.keys(result).join(', ') : 'null'}`);
        if (result?.configOptions) host.log.debug(`[${host.type}] configOptions: ${JSON.stringify(result.configOptions).slice(0, 500)}`);
        if (result?.modes) host.log.debug(`[${host.type}] modes: ${JSON.stringify(result.modes).slice(0, 300)}`);

 // ACP configOptions parsing (model, thought_level etc)
        host.parseConfigOptions(result?.configOptions);

 // ACP modes parsing
        host.parseModes(result?.modes);

 // Legacy: models.currentModelId (some agent compat)
        if (!host.getCurrentSelection('model') && result?.models?.currentModelId) {
            host.setCurrentSelection('model', result.models.currentModelId);
        }

 // ─── Static config fallback (for agents without config/* support) ───
        if (host.configOptions.length === 0 && host.provider.staticConfigOptions?.length) {
            host.useStaticConfig = true;
            for (const sc of host.provider.staticConfigOptions) {
                const defaultVal = host.selectedConfig[sc.configId] || sc.defaultValue || sc.options[0]?.value;
                host.configOptions.push({
                    category: sc.category,
                    configId: sc.configId,
                    currentValue: defaultVal,
                    options: sc.options.map(o => ({ ...o })),
                });
                if (defaultVal) {
                    host.selectedConfig[sc.configId] = defaultVal;
                    if (sc.category === 'model' || sc.category === 'mode') {
                        host.setCurrentSelection(sc.category, defaultVal);
                    }
                }
            }
            host.log.info(`[${host.type}] Using static configOptions (${host.configOptions.length} options)`);
        }

        const currentModel = host.getCurrentSelection('model');
        const currentMode = host.getCurrentSelection('mode');
        host.log.info(`[${host.type}] Session created: ${host.sessionId}${currentModel ? ` (model: ${currentModel})` : ''}${currentMode ? ` (mode: ${currentMode})` : ''}`);
        if (host.configOptions.length > 0) {
            host.log.info(`[${host.type}] Config options: ${host.configOptions.map(c => `${c.category}(${c.options.length})`).join(', ')}`);
        }
    } catch (e: any) {
        host.log.warn(`[${host.type}] session/new failed: ${e?.message}`);
        if (!host.errorReason) {
            host.errorReason = 'init_failed';
            host.errorMessage = `ACP session creation failed: ${e?.message}`;
        }
        host.currentStatus = 'error';
    }
}
