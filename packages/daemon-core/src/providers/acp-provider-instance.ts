/**
 * AcpProviderInstance — ACP (Agent Client Protocol) Provider runtime instance
 *
 * Spawns ACP agent process and communicates via the official ACP SDK.
 * Uses ClientSideConnection + ndJsonStream for structured protocol communication.
 *
 * ACP spec: https://agentclientprotocol.com
 * ACP SDK: @agentclientprotocol/sdk@0.16.1
 * 
 * lifecycle:
 * 1. init() → Spawn agent process + ACP initialize handshake
 * 2. onTick() → no-op (ACP event based)
 * 3. getState() → ProviderState return (dashboard for display)
 * 4. onEvent('send_message') → session/prompt transmit
 * 5. dispose() → kill process
 */

import { Readable, Writable } from 'stream';
import { spawn, type ChildProcess } from 'child_process';
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
    type SessionUpdate,
    type ToolCallStatus,
    type SessionConfigOption,
} from '@agentclientprotocol/sdk';
import type { ProviderModule, ContentBlock, ToolCallInfo, ToolCallContent as TCC, ToolKind, ToolCallStatus as TCS } from './contracts.js';
import { normalizeContent, flattenContent } from './contracts.js';
import type { ProviderInstance, ProviderState, AcpProviderState, ProviderErrorReason, ProviderEvent, InstanceContext } from './provider-instance.js';
import { StatusMonitor } from './status-monitor.js';
import { LOG } from '../logging/logger.js';

// ─── Internal Display Types (for dashboard) ────────────────────────────

interface AcpMessage {
    role: 'user' | 'assistant' | 'system';
    /** Rich content blocks (ACP standard) or plain text (legacy) */
    content: string | ContentBlock[];
    timestamp?: number;
    /** Tool calls associated with this message */
    toolCalls?: ToolCallInfo[];
}

interface AcpToolCall {
    id: string;
    name: string;
    status: 'running' | 'completed' | 'failed';
    input?: string;
    output?: string;
}

interface AcpConfigOption {
    category: 'model' | 'mode' | 'thought_level' | 'other';
    configId: string;
    currentValue?: string;
    options: { value: string; name: string; description?: string; group?: string }[];
}

interface AcpMode {
    id: string;
    name: string;
    description?: string;
}

// ─── AcpProviderInstance ───────────────────────────

export class AcpProviderInstance implements ProviderInstance {
    readonly type: string;
    readonly category = 'acp' as const;
    private readonly log = LOG.forComponent('ACP');

    private provider: ProviderModule;
    private context: InstanceContext | null = null;
    private settings: Record<string, any> = {};
    private events: ProviderEvent[] = [];
    private monitor: StatusMonitor;

 // Process
    private process: ChildProcess | null = null;
    private connection: ClientSideConnection | null = null;

 // State
    private sessionId: string | null = null;
    private messages: AcpMessage[] = [];
    private currentStatus: ProviderState['status'] = 'starting';
    private lastStatus: string = 'starting';
    private generatingStartedAt = 0;
    private agentCapabilities: Record<string, any> = {};
    private currentModel: string | undefined;
    private currentMode: string | undefined;
    private activeToolCalls: AcpToolCall[] = [];
    private stopReason: string | null = null;
    private partialContent = '';
    /** Rich content blocks accumulated during streaming */
    private partialBlocks: ContentBlock[] = [];
    /** Tool calls collected during current turn */
    private turnToolCalls: ToolCallInfo[] = [];

 // Error tracking
    private errorMessage: string | null = null;
    private errorReason: ProviderErrorReason | null = null;
    private stderrBuffer: string[] = [];
    private spawnedAt = 0;

 // ACP ConfigOptions & Modes (from session/new response or static fallback)
    private configOptions: AcpConfigOption[] = [];
    private availableModes: AcpMode[] = [];
 /** Static config mode — agent doesn't support config/* methods */
    private useStaticConfig = false;
 /** Current config selections (for spawnArgBuilder) */
    private selectedConfig: Record<string, string> = {};

 // Config
    private workingDir: string;
    private instanceId: string;

    constructor(
        provider: ProviderModule,
        workingDir: string,
        private cliArgs: string[] = [],
    ) {
        this.type = provider.type;
        this.provider = provider;
        this.workingDir = workingDir;
        this.instanceId = crypto.randomUUID();

        this.monitor = new StatusMonitor();
    }

 // ─── Lifecycle ─────────────────────────────────

    async init(context: InstanceContext): Promise<void> {
        this.context = context;
        this.settings = context.settings || {};
        this.monitor.updateConfig({
            approvalAlert: this.settings.approvalAlert !== false,
            longGeneratingAlert: this.settings.longGeneratingAlert !== false,
            longGeneratingThresholdSec: this.settings.longGeneratingThresholdSec || 180,
        });

        await this.spawnAgent();
    }

    async onTick(): Promise<void> {
 // ACP event based — tick unnecessary
 // Run process health check only
        if (this.process && this.process.exitCode !== null) {
            this.currentStatus = 'stopped';
            this.detectStatusTransition();
        }
    }

    getState(): AcpProviderState {
        const dirName = this.workingDir.split('/').filter(Boolean).pop() || 'session';

 // Recent 50 messages
        const recentMessages = this.messages.slice(-50).map(m => {
            const content = this.truncateContent(m.content);
            return {
                role: m.role,
                content,
                timestamp: m.timestamp,
                toolCalls: m.toolCalls,
            };
        });

 // generating during partial response add
        if (this.currentStatus === 'generating' && (this.partialContent || this.partialBlocks.length > 0)) {
            const blocks = this.buildPartialBlocks();
            if (blocks.length > 0) {
                recentMessages.push({
                    role: 'assistant',
                    content: blocks,
                    timestamp: Date.now(),
                    toolCalls: this.turnToolCalls.length > 0 ? [...this.turnToolCalls] : undefined,
                });
            }
        }

        return {
            type: this.type,
            name: this.provider.name,
            category: 'acp',
            status: this.currentStatus,
            mode: 'chat',
            activeChat: {
                id: this.sessionId || `${this.type}_${this.workingDir}`,
                title: `${this.provider.name} · ${dirName}`,
                status: this.currentStatus,
                messages: recentMessages,
                activeModal: this.currentStatus === 'waiting_approval' ? {
                    message: this.activeToolCalls.find(t => t.status === 'running')?.name || 'Permission requested',
                    buttons: ['Approve', 'Reject'],
                } : null,
                inputContent: '',
            },
            workspace: this.workingDir,
            currentModel: this.currentModel,
            currentPlan: this.currentMode,
            instanceId: this.instanceId,
            lastUpdated: Date.now(),
            settings: this.settings,
            pendingEvents: this.flushEvents(),
 // ACP-specific: expose available models/modes for dashboard
            acpConfigOptions: this.configOptions,
            acpModes: this.availableModes,
 // Error details for dashboard display
            errorMessage: this.errorMessage || undefined,
            errorReason: this.errorReason || undefined,
            controlValues: {
                ...(this.currentModel ? { model: this.currentModel } : {}),
                ...(this.currentMode ? { mode: this.currentMode } : {}),
            },
            providerControls: this.provider.controls as any,
        };
    }

    onEvent(event: string, data?: any): void {
        if (event === 'send_message' && data?.text) {
            this.sendPrompt(data.text).catch(e =>
                this.log.warn(`[${this.type}] sendPrompt error: ${e?.message}`)
            );
        } else if (event === 'resolve_action') {
            const action = data?.action || 'approve';
            this.resolvePermission(action === 'approve' || action === 'accept')
                .catch(e => this.log.warn(`[${this.type}] resolvePermission error: ${e?.message}`));
        } else if (event === 'cancel') {
            this.cancelSession().catch(e =>
                this.log.warn(`[${this.type}] cancel error: ${e?.message}`)
            );
        } else if (event === 'change_model' && data?.model) {
            this.setConfigOption('model', data.model).catch(e =>
                this.log.warn(`[${this.type}] change_model error: ${e?.message}`)
            );
        } else if (event === 'set_mode' && data?.mode) {
            this.setMode(data.mode).catch(e =>
                this.log.warn(`[${this.type}] set_mode error: ${e?.message}`)
            );
        } else if (event === 'set_thought_level' && data?.level) {
            this.setConfigOption('thought_level', data.level).catch(e =>
                this.log.warn(`[${this.type}] set_thought_level error: ${e?.message}`)
            );
        }
    }

    getInstanceId(): string {
        return this.instanceId;
    }

 // ─── ACP Config Options & Modes ─────────────────────

    private parseConfigOptions(raw: any): void {
        if (!Array.isArray(raw)) return;
        this.configOptions = [];
        for (const opt of raw) {
            const category = opt.category || 'other';
            const configId = opt.configId || opt.id || '';
            const currentValue = opt.currentValue ?? opt.select?.currentValue;

 // flatten options (ungrouped + grouped)
            const flatOptions: AcpConfigOption['options'] = [];
            const selectOpts = opt.select?.options || opt.options;
            if (selectOpts) {
 // ungrouped options
                if (Array.isArray(selectOpts.ungrouped)) {
                    for (const o of selectOpts.ungrouped) {
                        flatOptions.push({ value: o.value, name: o.name || o.value, description: o.description });
                    }
                }
 // grouped options
                if (Array.isArray(selectOpts.grouped)) {
                    for (const g of selectOpts.grouped) {
                        const groupName = g.name || g.group || '';
                        for (const o of (Array.isArray(g.options?.ungrouped) ? g.options.ungrouped : (g.options || []))) {
                            flatOptions.push({ value: o.value, name: o.name || o.value, description: o.description, group: groupName });
                        }
                    }
                }
 // direct array
                if (Array.isArray(selectOpts)) {
                    for (const o of selectOpts) {
                        if (o.value) flatOptions.push({ value: o.value, name: o.name || o.value, description: o.description });
                    }
                }
            }

            this.configOptions.push({ category: category as 'model' | 'mode' | 'thought_level' | 'other', configId, currentValue, options: flatOptions });

 // Auto-set currentModel/currentMode from config
            if (category === 'model' && currentValue) this.currentModel = currentValue;
        }
    }

    private parseModes(raw: any): void {
        if (!raw) return;
 // modes: { currentModeId, availableModes: [{ id, name, description }] }
        if (raw.currentModeId) this.currentMode = raw.currentModeId;
        if (Array.isArray(raw.availableModes)) {
            this.availableModes = raw.availableModes.map((m: any) => ({
                id: m.id, name: m.name || m.id, description: m.description,
            }));
        }
    }

    async setConfigOption(category: string, value: string): Promise<void> {
 // Find configId for this category
        const opt = this.configOptions.find(c => c.category === category);
        if (!opt) {
            const message = `[${this.type}] No config option for category: ${category}`;
            this.log.warn(message);
            throw new Error(message);
        }

 // Static config mode: update selection and restart process
        if (this.useStaticConfig) {
            opt.currentValue = value;
            this.selectedConfig[opt.configId] = value;
            if (category === 'model') this.currentModel = value;
            if (category === 'mode') this.currentMode = value;
            this.log.info(`[${this.type}] Static config ${category} set to: ${value} — restarting agent`);
            await this.restartWithNewConfig();
            return;
        }

        if (!this.connection || !this.sessionId) {
            const message = `[${this.type}] Cannot set config: no active connection/session`;
            this.log.warn(message);
            throw new Error(message);
        }

        try {
            this.log.info(`[${this.type}] Sending session/set_config_option: configId=${opt.configId} value=${value} sessionId=${this.sessionId}`);
            const result = await this.connection.setSessionConfigOption({
                sessionId: this.sessionId,
                configId: opt.configId,
                value,
            });
 // Update local state
            opt.currentValue = value;
            if (category === 'model') this.currentModel = value;
 // Response may include updated configOptions
            if (result?.configOptions) this.parseConfigOptions(result.configOptions);
            this.log.info(`[${this.type}] Config ${category} set to: ${value} | response: ${JSON.stringify(result)?.slice(0, 300)}`);
        } catch (e: any) {
            const message = e?.message || 'Unknown ACP config error';
            this.log.warn(`[${this.type}] set_config_option failed: ${message}`);
            throw new Error(message);
        }
    }

    async setMode(modeId: string): Promise<void> {
 // Static config: mode changes via restart
        if (this.useStaticConfig) {
            const opt = this.configOptions.find(c => c.category === 'mode');
            if (opt) {
                opt.currentValue = modeId;
                this.selectedConfig[opt.configId] = modeId;
            }
            this.currentMode = modeId;
            this.log.info(`[${this.type}] Static mode set to: ${modeId} — restarting agent`);
            await this.restartWithNewConfig();
            return;
        }

        if (!this.connection || !this.sessionId) {
            const message = `[${this.type}] Cannot set mode: no active connection/session`;
            this.log.warn(message);
            throw new Error(message);
        }

        try {
            await this.connection.setSessionMode({
                sessionId: this.sessionId,
                modeId,
            });
            this.currentMode = modeId;
            this.log.info(`[${this.type}] Mode set to: ${modeId}`);
        } catch (e: any) {
            const message = e?.message || 'Unknown ACP mode error';
            this.log.warn(`[${this.type}] set_mode failed: ${message}`);
            throw new Error(message);
        }
    }

 /** Static config: kill process and restart with new args */
    private async restartWithNewConfig(): Promise<void> {
 // Build new args from spawnArgBuilder
        if (this.provider.spawnArgBuilder) {
            this.cliArgs = []; // clear previous extra args
        }

 // Kill existing process
        if (this.process) {
            try { this.process.kill('SIGTERM'); } catch { }
            this.process = null;
        }
        this.connection = null;
        this.sessionId = null;

        this.currentStatus = 'starting';
        this.detectStatusTransition();

 // Re-spawn with updated config
        await this.spawnAgent();
    }

    /** Update settings at runtime (called when user changes settings from dashboard) */
    updateSettings(newSettings: Record<string, any>): void {
        this.settings = { ...this.settings, ...newSettings };
        this.monitor.updateConfig({
            approvalAlert: this.settings.approvalAlert !== false,
            longGeneratingAlert: this.settings.longGeneratingAlert !== false,
            longGeneratingThresholdSec: this.settings.longGeneratingThresholdSec || 180,
        });
        this.log.info(`[${this.type}] Settings updated: ${Object.keys(newSettings).join(', ')}`);
    }

    dispose(): void {
        // kill process
        if (this.process) {
            try { this.process.kill('SIGTERM'); } catch { }
            this.process = null;
        }
        this.connection = null;
        this.monitor.reset();
    }

 // ─── ACP Process Management ──────────────────────

    private async spawnAgent(): Promise<void> {
        const spawnConfig = this.provider.spawn;
        if (!spawnConfig) {
            throw new Error(`[ACP:${this.type}] No spawn config defined`);
        }

        const command = typeof this.settings.executablePath === 'string' && this.settings.executablePath.trim()
            ? this.settings.executablePath.trim()
            : spawnConfig.command;
 // Static config: create args via spawnArgBuilder (when provider defines it)
        let baseArgs = spawnConfig.args || [];
        if (this.provider.spawnArgBuilder && Object.keys(this.selectedConfig).length > 0) {
            baseArgs = this.provider.spawnArgBuilder(this.selectedConfig);
        }
        const args = [...baseArgs, ...this.cliArgs];

 // Auth: each CLI/ACP tool manages its own authentication.
 // ADHDev does NOT inject API keys — tools read their own env vars or config files.

        const env = { ...process.env, ...(spawnConfig.env || {}) };

        this.log.info(`[${this.type}] Spawning: ${command} ${args.join(' ')} in ${this.workingDir}`);

        this.spawnedAt = Date.now();
        this.errorMessage = null;
        this.errorReason = null;
        this.stderrBuffer = [];

        this.process = spawn(command, args, {
            cwd: this.workingDir,
            env,
            stdio: ['pipe', 'pipe', 'pipe'],
            shell: spawnConfig.shell || false,
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

        this.process.stderr?.on('data', (data) => {
            const text = data.toString().trim();
            if (!text) return;
            this.log.debug(`[${this.type}:stderr] ${text.slice(0, 300)}`);

 // Maintain stderr buffer (recent 20 lines)
            this.stderrBuffer.push(text);
            if (this.stderrBuffer.length > 20) this.stderrBuffer.shift();

 // Auth failure detection
            for (const pattern of AUTH_ERROR_PATTERNS) {
                if (pattern.test(text)) {
                    if (/ENOENT|command not found|not recognized/i.test(text)) {
                        this.errorReason = 'not_installed';
                        this.errorMessage = `Command '${command}' not found. Install: ${this.provider.install || 'check documentation'}`;
                    } else {
                        this.errorReason = 'auth_failed';
                        this.errorMessage = text.slice(0, 300);
                    }
                    this.log.warn(`[${this.type}] Error detected (${this.errorReason}): ${this.errorMessage?.slice(0, 100)}`);
                    break;
                }
            }
        });

 // kill process detect
        this.process.on('exit', (code, signal) => {
            const elapsed = Date.now() - this.spawnedAt;
            this.log.info(`[${this.type}] Process exited: code=${code} signal=${signal} elapsed=${elapsed}ms`);

 // Exit code analysis
            if (code !== 0 && code !== null) {
                if (!this.errorReason) {
                    if (code === 127) {
                        this.errorReason = 'not_installed';
                        this.errorMessage = `Command '${command}' not found (exit code 127). Install: ${this.provider.install || 'check documentation'}`;
                    } else if (elapsed < 3000) {
 // 3-second crash → likely install/auth issue
                        this.errorReason = this.stderrBuffer.length > 0 ? 'crash' : 'spawn_error';
                        this.errorMessage = this.stderrBuffer.length > 0
                            ? `Agent crashed immediately (exit code ${code}): ${this.stderrBuffer.slice(-3).join(' | ').slice(0, 300)}`
                            : `Agent exited immediately with code ${code}. The agent may not be installed correctly.`;
                    } else {
                        this.errorReason = 'crash';
                        this.errorMessage = `Agent exited with code ${code}${this.stderrBuffer.length > 0 ? ': ' + this.stderrBuffer.slice(-1)[0]?.slice(0, 200) : ''}`;
                    }
                }
            }

            this.currentStatus = this.errorReason ? 'error' : 'stopped';
            this.detectStatusTransition();
        });

        this.process.on('error', (err) => {
            this.log.error(`[${this.type}] Process spawn error: ${err.message}`);
            if (err.message.includes('ENOENT')) {
                this.errorReason = 'not_installed';
                this.errorMessage = `Command '${command}' not found. Install: ${this.provider.install || 'check documentation'}`;
            } else {
                this.errorReason = 'spawn_error';
                this.errorMessage = err.message;
            }
            this.currentStatus = 'error';
            this.detectStatusTransition();
        });

 // ─── SDK Connection Setup ────────────────────────
 // Convert Node.js streams to Web Streams for ndJsonStream
        const webStdin = Writable.toWeb(this.process.stdin!) as WritableStream<Uint8Array>;
        const webStdout = Readable.toWeb(this.process.stdout!) as ReadableStream<Uint8Array>;
        const stream = ndJsonStream(webStdin, webStdout);

 // Create ClientSideConnection with our Client implementation
        this.connection = new ClientSideConnection((_agent: Agent) => this.createClient(), stream);

 // Listen for connection close
        this.connection.signal.addEventListener('abort', () => {
            this.log.info(`[${this.type}] ACP connection closed`);
        });

 // ACP initialize handshake
        await this.initialize();
    }

 // ─── Client Interface Implementation ────────────────────

    private createClient(): Client {
        return {
            requestPermission: async (params: RequestPermissionRequest): Promise<RequestPermissionResponse> => {
                // Update active tool calls from the request
                const tc = params.toolCall;
                const existing = this.activeToolCalls.find(t => t.id === tc.toolCallId);
                if (existing) {
                    existing.status = 'running';
                    if (tc.title) existing.name = tc.title;
                } else {
                    this.activeToolCalls.push({
                        id: tc.toolCallId,
                        name: tc.title || 'unknown',
                        status: 'running',
                        input: tc.rawInput ? (typeof tc.rawInput === 'string' ? tc.rawInput : JSON.stringify(tc.rawInput)) : undefined,
                    });
                }

                // ─── Auto-approve: skip user confirmation ───
                if (this.settings.autoApprove !== false) {
                    const toolTitle = tc.title || tc.toolCallId || 'tool call';
                    this.log.info(`[${this.type}] Auto-approving: ${toolTitle}`);
                    this.appendSystemMessage(`Auto-approved: ${toolTitle}`);
                    const allowOption = params.options.find(o => o.kind === 'allow_once') || params.options.find(o => o.kind === 'allow_always');
                    if (allowOption) {
                        return { outcome: { outcome: 'selected', optionId: allowOption.optionId } };
                    }
                    return { outcome: { outcome: 'selected', optionId: params.options[0]?.optionId || '' } };
                }

                // Approval request → switch to waiting_approval status
                this.currentStatus = 'waiting_approval';
                this.detectStatusTransition();

                // Wait for user approval
                const approved = await new Promise<boolean>((resolve) => {
                    this.permissionResolvers.push(resolve);
                    // 5-minute timeout → auto-reject
                    setTimeout(() => {
                        const idx = this.permissionResolvers.indexOf(resolve);
                        if (idx >= 0) {
                            this.permissionResolvers.splice(idx, 1);
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
                this.handleSessionUpdate(params);
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

    private async initialize(): Promise<void> {
        if (!this.connection) return;

        try {
            const result = await this.connection.initialize({
                protocolVersion: PROTOCOL_VERSION,
                clientCapabilities: {},
            });

            this.agentCapabilities = result?.agentCapabilities || {};
            this.log.info(`[${this.type}] Initialized. Agent capabilities: ${JSON.stringify(this.agentCapabilities)}`);

 // new session create
            await this.createSession();
        } catch (e: any) {
            this.log.error(`[${this.type}] Initialize failed: ${e?.message}`);
            if (!this.errorReason) {
                this.errorReason = 'init_failed';
                this.errorMessage = `ACP handshake failed: ${e?.message}${this.stderrBuffer.length > 0 ? '\n' + this.stderrBuffer.slice(-2).join('\n').slice(0, 200) : ''}`;
            }
            this.currentStatus = 'error';
        }
    }

    private async createSession(): Promise<void> {
        if (!this.connection) return;

        try {
            const result = await this.connection.newSession({
                cwd: this.workingDir,
                mcpServers: [],
            });
            this.sessionId = result?.sessionId || null;
            this.currentStatus = 'idle';
            this.messages = [];

 // DEBUG: session/new response key check
            this.log.info(`[${this.type}] session/new result keys: ${result ? Object.keys(result).join(', ') : 'null'}`);
            if (result?.configOptions) this.log.debug(`[${this.type}] configOptions: ${JSON.stringify(result.configOptions).slice(0, 500)}`);
            if (result?.modes) this.log.debug(`[${this.type}] modes: ${JSON.stringify(result.modes).slice(0, 300)}`);

 // ACP configOptions parsing (model, thought_level etc)
            this.parseConfigOptions(result?.configOptions);

 // ACP modes parsing
            this.parseModes(result?.modes);

 // Legacy: models.currentModelId (some agent compat)
            if (!this.currentModel && result?.models?.currentModelId) {
                this.currentModel = result.models.currentModelId;
            }

 // ─── Static config fallback (for agents without config/* support) ───
            if (this.configOptions.length === 0 && this.provider.staticConfigOptions?.length) {
                this.useStaticConfig = true;
                for (const sc of this.provider.staticConfigOptions) {
                    const defaultVal = this.selectedConfig[sc.configId] || sc.defaultValue || sc.options[0]?.value;
                    this.configOptions.push({
                        category: sc.category,
                        configId: sc.configId,
                        currentValue: defaultVal,
                        options: sc.options.map(o => ({ ...o })),
                    });
                    if (defaultVal) {
                        this.selectedConfig[sc.configId] = defaultVal;
                        if (sc.category === 'model') this.currentModel = defaultVal;
                        if (sc.category === 'mode') this.currentMode = defaultVal;
                    }
                }
                this.log.info(`[${this.type}] Using static configOptions (${this.configOptions.length} options)`);
            }

            this.log.info(`[${this.type}] Session created: ${this.sessionId}${this.currentModel ? ` (model: ${this.currentModel})` : ''}${this.currentMode ? ` (mode: ${this.currentMode})` : ''}`);
            if (this.configOptions.length > 0) {
                this.log.info(`[${this.type}] Config options: ${this.configOptions.map(c => `${c.category}(${c.options.length})`).join(', ')}`);
            }
        } catch (e: any) {
            this.log.warn(`[${this.type}] session/new failed: ${e?.message}`);
            this.currentStatus = 'idle';
        }
    }

    async sendPrompt(text: string, contentBlocks?: ContentBlock[]): Promise<void> {
        if (!this.connection || !this.sessionId) {
            this.log.warn(`[${this.type}] Cannot send prompt: no active connection/session`);
            return;
        }

 // Build prompt content
        let promptParts: any[];
        if (contentBlocks && contentBlocks.length > 0) {
            // Rich content — forward ContentBlock[] as ACP prompt parts
            promptParts = contentBlocks.map(b => {
                if (b.type === 'text') return { type: 'text', text: b.text };
                if (b.type === 'image') return { type: 'image', data: b.data, mimeType: b.mimeType };
                if (b.type === 'resource_link') return { type: 'resource_link', uri: b.uri, name: b.name };
                if (b.type === 'resource') return { type: 'resource', resource: b.resource };
                return { type: 'text', text: flattenContent([b]) };
            });
        } else {
            promptParts = [{ type: 'text', text }];
        }

 // Add user message locally (store as ContentBlock[])
        this.messages.push({
            role: 'user',
            content: contentBlocks && contentBlocks.length > 0 ? contentBlocks : text,
            timestamp: Date.now(),
        });

        this.currentStatus = 'generating';
        this.partialContent = '';
        this.partialBlocks = [];
        this.turnToolCalls = [];
        this.detectStatusTransition();
        this.log.info(`[${this.type}] Sending prompt: "${text.slice(0, 100)}" (${promptParts.length} parts)`);

        try {
            const result = await this.connection.prompt({
                sessionId: this.sessionId,
                prompt: promptParts,
            });

 // Prompt complete → reflect final message
            if (result?.stopReason) {
                this.stopReason = result.stopReason;
            }
            this.log.info(`[${this.type}] Prompt completed: stopReason=${result?.stopReason} partialContent=${this.partialContent.length} chars partialBlocks=${this.partialBlocks.length}`);

 // Build final assistant message with rich content
            this.finalizeAssistantMessage();

            this.currentStatus = 'idle';
            this.detectStatusTransition();
        } catch (e: any) {
            this.log.warn(`[${this.type}] prompt error: ${e?.message}`);
            this.finalizeAssistantMessage();
            this.currentStatus = 'idle';
            this.detectStatusTransition();
        }
    }

    private async cancelSession(): Promise<void> {
        if (!this.connection || !this.sessionId) return;

        await this.connection.cancel({
            sessionId: this.sessionId,
        });
        this.currentStatus = 'idle';
        this.detectStatusTransition();
    }

    private permissionResolvers: ((approved: boolean) => void)[] = [];

    async resolvePermission(approved: boolean): Promise<void> {
        const resolver = this.permissionResolvers.shift();
        if (resolver) {
            resolver(approved);
        }
        if (this.currentStatus === 'waiting_approval') {
            this.currentStatus = 'generating';
            this.detectStatusTransition();
        }
    }

 // ─── ACP session/update handle ─────────────────────

    private handleSessionUpdate(params: SessionNotification): void {
        if (!params) return;

        const update = params.update;
        this.log.debug(`[${this.type}] sessionUpdate: ${update.sessionUpdate}`);

        switch (update.sessionUpdate) {
            case 'agent_message_chunk': {
                const content = update.content;
                if (content.type === 'text') {
                    this.partialContent += content.text;
                } else if (content.type === 'image') {
                    this.partialBlocks.push({
                        type: 'image',
                        data: content.data,
                        mimeType: content.mimeType,
                    });
                } else if (content.type === 'resource_link') {
                    this.partialBlocks.push({
                        type: 'resource_link',
                        uri: content.uri,
                        name: content.name || 'resource',
                        title: content.title ?? undefined,
                        mimeType: content.mimeType ?? undefined,
                    });
                } else if (content.type === 'resource') {
                    this.partialBlocks.push({
                        type: 'resource',
                        resource: content.resource,
                    });
                }
                this.currentStatus = 'generating';
                break;
            }
            case 'agent_thought_chunk':
            case 'user_message_chunk': {
 // Track but don't display thought chunks as main content
                break;
            }
            case 'tool_call': {
 // New tool call — ACP SDK ToolCall has all fields typed
                const tcId = update.toolCallId || `tc_${Date.now()}`;
                const tcTitle = update.title || 'unknown';
                const tcKind = update.kind as ToolKind | undefined;
                const tcStatus = this.mapToolCallStatus(update.status);
                
                this.activeToolCalls.push({
                    id: tcId,
                    name: tcTitle,
                    status: tcStatus,
                    input: update.rawInput ? (typeof update.rawInput === 'string' ? update.rawInput : JSON.stringify(update.rawInput)) : undefined,
                });
                
                // Also collect as ToolCallInfo for rich content
                const acpStatus = update.status || 'in_progress';
                this.turnToolCalls.push({
                    toolCallId: tcId,
                    title: tcTitle,
                    kind: tcKind,
                    status: acpStatus as TCS,
                    rawInput: update.rawInput,
                    content: this.convertToolCallContent(update.content),
                    locations: update.locations,
                });
                break;
            }
            case 'tool_call_update': {
 // Update existing tool call — ACP SDK ToolCallUpdate typed
                const toolCallId = update.toolCallId;
                const existing = this.activeToolCalls.find(t => t.id === toolCallId);
                if (existing) {
                    if (update.status) existing.status = this.mapToolCallStatus(update.status);
                    if (update.rawOutput) existing.output = typeof update.rawOutput === 'string' ? update.rawOutput : JSON.stringify(update.rawOutput);
                }
                // Update ToolCallInfo too
                const tcInfo = this.turnToolCalls.find(t => t.toolCallId === toolCallId);
                if (tcInfo) {
                    if (update.status) tcInfo.status = update.status as TCS;
                    if (update.rawOutput) tcInfo.rawOutput = update.rawOutput;
                    if (update.content) tcInfo.content = this.convertToolCallContent(update.content);
                    if (update.locations) tcInfo.locations = update.locations;
                }
                break;
            }
            case 'current_mode_update': {
                this.currentMode = update.currentModeId;
                break;
            }
            case 'config_option_update': {
                if (update.configOptions) {
                    this.parseConfigOptions(update.configOptions);
                }
                break;
            }
            case 'plan':
            case 'available_commands_update':
            case 'session_info_update':
            case 'usage_update':
 // Noted but no specific handling needed
                break;
            default:
 // Unknown update type — try legacy parsing for backward compatibility
                this.handleLegacyUpdate(update);
                break;
        }
    }

 /** Handle legacy session/update formats (pre-standardization compat) */
    private handleLegacyUpdate(params: any): void {
 // Legacy: messageDelta format
        if (params.messageDelta) {
            const delta = params.messageDelta;
            if (delta.content) {
                for (const part of Array.isArray(delta.content) ? delta.content : [delta.content]) {
                    if (part.type === 'text' && part.text) {
                        this.partialContent += part.text;
                    }
                }
            }
            this.currentStatus = 'generating';
        }

 // Legacy: message complete
        if (params.message) {
            const m = params.message;
            let content = '';
            if (typeof m.content === 'string') {
                content = m.content;
            } else if (Array.isArray(m.content)) {
                content = m.content
                    .filter((p: any) => p.type === 'text')
                    .map((p: any) => p.text || '')
                    .join('\n');
            }

            if (content.trim()) {
                this.messages.push({
                    role: m.role || 'assistant',
                    content: content.trim(),
                    timestamp: Date.now(),
                });
                this.partialContent = '';
            }
        }

 // Legacy: toolCallUpdate
        if (params.toolCallUpdate) {
            const tc = params.toolCallUpdate;
            const existing = this.activeToolCalls.find(t => t.id === tc.id);
            if (existing) {
                if (tc.status) existing.status = tc.status;
                if (tc.output) existing.output = tc.output;
            } else {
                this.activeToolCalls.push({
                    id: tc.id || `tc_${Date.now()}`,
                    name: tc.name || 'unknown',
                    status: tc.status || 'running',
                    input: typeof tc.input === 'string' ? tc.input : JSON.stringify(tc.input),
                });
            }
        }

 // Legacy: stopReason
        if (params.stopReason) {
            this.stopReason = params.stopReason;
            if (params.stopReason !== 'cancelled') {
                this.currentStatus = 'idle';
            }
            this.activeToolCalls = [];
            this.detectStatusTransition();
        }

 // Legacy: model info
        if (params.model) {
            this.currentModel = params.model;
        }
    }

 /** Map SDK ToolCallStatus to internal status */
    private mapToolCallStatus(status?: ToolCallStatus | string): 'running' | 'completed' | 'failed' {
        switch (status) {
            case 'completed': return 'completed';
            case 'failed': return 'failed';
            case 'pending':
            case 'in_progress':
            default: return 'running';
        }
    }

 // ─── Rich Content Helpers ────────────────────────────

    /** Truncate content for transport (text: 2000 chars, images preserved) */
    private truncateContent(content: string | ContentBlock[]): string | ContentBlock[] {
        if (typeof content === 'string') {
            return content.length > 2000 ? content.slice(0, 2000) + '\n... (truncated)' : content;
        }
        return content.map(b => {
            if (b.type === 'text' && b.text.length > 2000) {
                return { ...b, text: b.text.slice(0, 2000) + '\n... (truncated)' };
            }
            return b;
        });
    }

    /** Build ContentBlock[] from current partial state */
    private buildPartialBlocks(): ContentBlock[] {
        const blocks: ContentBlock[] = [];
        if (this.partialContent.trim()) {
            blocks.push({ type: 'text', text: this.partialContent.trim() + '...' });
        }
        blocks.push(...this.partialBlocks);
        return blocks;
    }

    /** Finalize streaming content into an assistant message */
    private finalizeAssistantMessage(): void {
        const blocks = this.buildPartialBlocks();
        // Remove trailing '...' from text blocks for final message
        const finalBlocks = blocks.map(b => {
            if (b.type === 'text' && b.text.endsWith('...')) {
                return { ...b, text: b.text.slice(0, -3) };
            }
            return b;
        }).filter(b => b.type !== 'text' || (b.type === 'text' && b.text.trim()));

        if (finalBlocks.length > 0) {
            this.messages.push({
                role: 'assistant',
                content: finalBlocks.length === 1 && finalBlocks[0].type === 'text'
                    ? (finalBlocks[0] as {type: 'text', text: string}).text   // single text → string (backward compat)
                    : finalBlocks,
                timestamp: Date.now(),
                toolCalls: this.turnToolCalls.length > 0 ? [...this.turnToolCalls] : undefined,
            });
        }
        this.partialContent = '';
        this.partialBlocks = [];
        this.turnToolCalls = [];
    }

    /** Convert ACP ToolCallContent[] to our ToolCallContent[] */
    private convertToolCallContent(acpContent?: any[]): TCC[] | undefined {
        if (!acpContent || !Array.isArray(acpContent)) return undefined;
        return acpContent.map((c: any) => {
            if (c.type === 'diff') {
                return { type: 'diff' as const, path: c.path || '', oldText: c.oldText, newText: c.newText || '' };
            }
            if (c.type === 'terminal') {
                return { type: 'terminal' as const, terminalId: c.terminalId || '' };
            }
            // type: 'content' or unknown
            return { type: 'content' as const, content: c.content || { type: 'text' as const, text: JSON.stringify(c) } };
        });
    }

 // ─── status transition detect ────────────────────────────

    private detectStatusTransition(): void {
        const now = Date.now();
        const newStatus = this.currentStatus;
        const dirName = this.workingDir.split('/').filter(Boolean).pop() || 'session';
        const chatTitle = `${this.provider.name} · ${dirName}`;
        const progressFingerprint = newStatus === 'generating'
            ? `${this.partialContent}::${JSON.stringify(this.partialBlocks)}::${JSON.stringify(this.activeToolCalls.map(t => ({ name: t.name, status: t.status })))}`.slice(-2000)
            : undefined;

        if (newStatus !== this.lastStatus) {
            if (this.lastStatus === 'idle' && newStatus === 'generating') {
                this.generatingStartedAt = now;
                this.pushEvent({ event: 'agent:generating_started', chatTitle, timestamp: now });
            } else if (newStatus === 'waiting_approval') {
                if (!this.generatingStartedAt) this.generatingStartedAt = now;
                this.pushEvent({
                    event: 'agent:waiting_approval', chatTitle, timestamp: now,
                    modalMessage: this.activeToolCalls.find(t => t.status === 'running')?.name,
                });
            } else if (newStatus === 'idle' && (this.lastStatus === 'generating' || this.lastStatus === 'waiting_approval')) {
                const duration = this.generatingStartedAt ? Math.round((now - this.generatingStartedAt) / 1000) : 0;
                this.pushEvent({ event: 'agent:generating_completed', chatTitle, duration, timestamp: now });
                this.generatingStartedAt = 0;
            } else if (newStatus === 'stopped') {
                this.pushEvent({ event: 'agent:stopped', chatTitle, timestamp: now });
            }
            this.lastStatus = newStatus;
        }

 // Monitor check
        const agentKey = `${this.type}:acp`;
        const monitorEvents = this.monitor.check(agentKey, newStatus, now, progressFingerprint);
        for (const me of monitorEvents) {
            this.pushEvent({ event: me.type, agentKey: me.agentKey, message: me.message, elapsedSec: me.elapsedSec, timestamp: me.timestamp });
        }
    }

    private pushEvent(event: ProviderEvent): void {
        this.events.push(event);
        if (this.events.length > 50) this.events = this.events.slice(-50);
    }

    private appendSystemMessage(content: string, timestamp = Date.now()): void {
        const normalizedContent = String(content || '').trim();
        if (!normalizedContent) return;
        this.messages.push({
            role: 'system',
            content: normalizedContent,
            timestamp,
        });
        if (this.messages.length > 200) {
            this.messages = this.messages.slice(-100);
        }
    }

    private flushEvents(): ProviderEvent[] {
        const events = [...this.events];
        this.events = [];
        return events;
    }

 // ─── external access ─────────────────────────────────

    get cliType(): string { return this.type; }
    get cliName(): string { return this.provider.name; }

 /** ACP Agent capabilities (available after initialize) */
    getCapabilities(): Record<string, any> { return this.agentCapabilities; }
}
