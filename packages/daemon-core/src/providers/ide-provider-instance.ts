/**
 * IdeProviderInstance — Runtime instance for IDE Provider
 *
 * Within a single IDE:
 * 1. Native chat (readChat via CDP)
 * 2. Extension agents (Cline, Roo Code etc)
 *
 * IDE Instance manages child Extension Instances.
 * Daemon collects all via a single IDE Instance.getState() call.
 */

import * as os from 'os';
import * as crypto from 'crypto';
import type { ProviderModule } from './contracts.js';
import type { ProviderInstance, ProviderState, ProviderEvent, InstanceContext } from './provider-instance.js';
import { ExtensionProviderInstance } from './extension-provider-instance.js';
import { StatusMonitor } from './status-monitor.js';
import { ChatHistoryWriter } from '../config/chat-history.js';
import { LOG } from '../logging/logger.js';

export class IdeProviderInstance implements ProviderInstance {
    readonly type: string;
    readonly category = 'ide' as const;

    private provider: ProviderModule;
    private context: InstanceContext | null = null;
    private settings: Record<string, any> = {};
    private events: ProviderEvent[] = [];
    private tickErrorCount = 0;

 // Cached status
    private cachedChat: any = null;
    private currentStatus: string = 'idle';
    private lastAgentStatuses = new Map<string, string>();
    private generatingStartedAt = new Map<string, number>();
    private tickBusy = false;
    private monitor: StatusMonitor;
    private historyWriter: ChatHistoryWriter;
    private autoApproveBusy = false;

 // IDE meta
    private ideVersion: string = '';
    private instanceId: string;
    private workspace: string = '';

 // ─── Child Extension Instances ────────────────────
    private extensions = new Map<string, ExtensionProviderInstance>();

    constructor(provider: ProviderModule, instanceKey?: string) {
 // type always base provider type (e.g. 'antigravity') — display/script queryin use
        this.type = provider.type;
        this.provider = provider;
 // instanceId UUID — unique identifier for all routing
        this.instanceId = crypto.randomUUID();
        this.monitor = new StatusMonitor();
        this.historyWriter = new ChatHistoryWriter();
    }

 // ─── Lifecycle ─────────────────────────────────

    async init(context: InstanceContext): Promise<void> {
        this.context = context;
        this.settings = context.settings || {};
 // Sync Monitor config
        this.monitor.updateConfig({
            approvalAlert: this.settings.approvalAlert !== false,
            longGeneratingAlert: this.settings.longGeneratingAlert !== false,
            longGeneratingThresholdSec: this.settings.longGeneratingThresholdSec || 180,
        });
    }

    async onTick(): Promise<void> {
        if (!this.context?.cdp?.isConnected || this.tickBusy) return;
        this.tickBusy = true;

        try {
 // 1. Native chat read
            await this.readChat();

 // 2. Child Extension tick
            for (const [id, ext] of this.extensions) {
                try {
                    await ext.onTick();
                } catch (e: any) {
                    LOG.warn('IdeInstance', `[IdeInstance:${this.type}] Extension ${id} tick error: ${e?.message}`);
                }
            }

            this.tickErrorCount = 0;
        } catch (e: any) {
            this.tickErrorCount++;
            if (this.tickErrorCount <= 3 || this.tickErrorCount % 10 === 0) {
                LOG.warn('IdeInstance', `[IdeInstance:${this.type}] onTick error (${this.tickErrorCount}): ${e?.message || e}`);
            }
        } finally {
            this.tickBusy = false;
        }
    }

    getState(): ProviderState {
        const cdp = this.context?.cdp;

 // Collect extension status
        const extensionStates: ProviderState[] = [];
        for (const ext of this.extensions.values()) {
            extensionStates.push(ext.getState());
        }

        return {
            type: this.type,
            name: this.provider.name,
            category: 'ide',
            status: this.currentStatus as ProviderState['status'],
            activeChat: this.cachedChat ? {
                id: this.cachedChat.id || 'active_session',
                title: this.cachedChat.title || this.type,
                status: this.cachedChat.status || this.currentStatus,
                messages: this.cachedChat.messages || [],
                activeModal: this.cachedChat.activeModal || null,
                inputContent: this.cachedChat.inputContent || '',
            } : null,
            workspace: this.workspace || null,
            extensions: extensionStates,
            cdpConnected: cdp?.isConnected || false,
            currentModel: this.cachedChat?.model || undefined,
            currentPlan: this.cachedChat?.mode || undefined,
            currentAutoApprove: this.cachedChat?.autoApprove || undefined,
            instanceId: this.instanceId,
            lastUpdated: Date.now(),
            settings: this.settings,
            pendingEvents: this.flushEvents(),
        };
    }

    onEvent(event: string, data?: any): void {
        if (event === 'cdp_connected') {
 // CDP connection done
        } else if (event === 'cdp_disconnected') {
            this.cachedChat = null;
            this.currentStatus = 'idle';
        } else if (event === 'stream_update') {
 // Forward to Extension
            const extType = data?.extensionType;
            if (extType && this.extensions.has(extType)) {
                this.extensions.get(extType)!.onEvent('stream_update', data);
            }
        }
    }

    dispose(): void {
        this.cachedChat = null;
        this.lastAgentStatuses.clear();
        this.generatingStartedAt.clear();
        this.monitor.reset();
 // Child Extension cleanup
        for (const ext of this.extensions.values()) {
            ext.dispose();
        }
        this.extensions.clear();
    }

 // ─── Extension manage ─────────────────────────────

 /** Extension Instance add */
    async addExtension(provider: ProviderModule, settings?: Record<string, any>): Promise<void> {
        if (this.extensions.has(provider.type)) return;

        const ext = new ExtensionProviderInstance(provider);
        await ext.init({
            cdp: this.context?.cdp,
            serverConn: this.context?.serverConn,
            settings: settings || {},
        });
        ext.onEvent('extension_connected', { ideType: this.type });
        this.extensions.set(provider.type, ext);
        LOG.info('IdeInstance', `[IdeInstance:${this.type}] Extension added: ${provider.type}`);
    }

 /** Extension Instance remove */
    removeExtension(type: string): void {
        const ext = this.extensions.get(type);
        if (ext) {
            ext.dispose();
            this.extensions.delete(type);
        }
    }

 /** Extension Instance Import */
    getExtension(type: string): ExtensionProviderInstance | undefined {
        return this.extensions.get(type);
    }

 /** Child Extension list */
    getExtensionTypes(): string[] {
        return [...this.extensions.keys()];
    }

 /** Query UUID instanceId */
    getInstanceId(): string {
        return this.instanceId;
    }

 /** all Extension Instance list */
    getExtensionInstances(): ExtensionProviderInstance[] {
        return [...this.extensions.values()];
    }

 /** Set workspace from daemon launch context */
    setWorkspace(workspace: string): void {
        this.workspace = workspace;
    }

 // ─── CDP readChat ───────────────────────────────

    private async readChat(): Promise<void> {
        const { cdp } = this.context!;
        if (!cdp?.isConnected) return;

        try {
            let raw: any = null;

 // path 1: webview iframe internal (Kiro, PearAI etc)
            const webviewFn = (this.provider.scripts as any)?.webviewReadChat;
            if (typeof webviewFn === 'function' && cdp.evaluateInWebviewFrame) {
                const webviewScript = webviewFn();
                if (webviewScript) {
                    const matchText = (this.provider as any).webviewMatchText;
                    const matchFn = matchText ? (body: string) => body.includes(matchText) : undefined;
                    const webviewRaw = await cdp.evaluateInWebviewFrame(webviewScript, matchFn);
                    if (webviewRaw) {
                        raw = typeof webviewRaw === 'string' ? (() => { try { return JSON.parse(webviewRaw); } catch { return null; } })() : webviewRaw;
                    }
                }
            }

 // path 2: Main DOM (Cursor, Windsurf, Trae, Antigravity etc)
            if (!raw) {
                const readChatScript = this.getReadChatScript();
                if (!readChatScript) return;
                raw = await cdp.evaluate(readChatScript, 30000) as any;
                if (typeof raw === 'string') {
                    try { raw = JSON.parse(raw); } catch { return; }
                }
            }

            if (!raw || typeof raw !== 'object') return;

 // Modal filter
            let { activeModal } = raw;
            if (activeModal) {
                const w = activeModal.width ?? Infinity;
                const h = activeModal.height ?? Infinity;
                if (w < 80 || h < 40) {
                    activeModal = undefined;
                } else {
                    activeModal = {
                        message: activeModal.message?.slice(0, 5000) ?? '',
                        buttons: (activeModal.buttons ?? []).filter((t: string) => t.length < 200),
                    };
                }
            }

 // Assign receivedAt
            const prevMsgs = this.cachedChat?.messages || [];
            const prevByHash = new Map<string, number>();
            for (const pm of prevMsgs) {
                const h = `${pm.role}:${(pm.content || '').slice(0, 100)}`;
                if (pm.receivedAt) prevByHash.set(h, pm.receivedAt);
            }
            const now = Date.now();
            for (const msg of (raw.messages || [])) {
                const h = `${msg.role}:${(msg.content || '').slice(0, 100)}`;
                msg.receivedAt = prevByHash.get(h) || now;
            }

            // Filter messages by provider settings (showThinking, showToolCalls, showTerminal)
            if (raw.messages?.length > 0) {
                const hiddenKinds = new Set<string>();
                if (this.settings.showThinking === false) hiddenKinds.add('thought');
                if (this.settings.showToolCalls === false) hiddenKinds.add('tool');
                if (this.settings.showTerminal === false) hiddenKinds.add('terminal');
                if (hiddenKinds.size > 0) {
                    raw.messages = raw.messages.filter((m: any) => !hiddenKinds.has(m.kind));
                }
            }

            this.cachedChat = { ...raw, activeModal };
            this.detectAgentTransitions(raw, now);

 // Save history (new messageonly append)
 // Exclude last incomplete assistant message during generating status
            if (raw.messages?.length > 0) {
                let toSave = raw.messages;
                if (raw.status === 'generating' || raw.status === 'long_generating') {
 // Find and exclude last assistant message
                    const lastIdx = toSave.length - 1;
                    if (lastIdx >= 0 && toSave[lastIdx].role === 'assistant') {
                        toSave = toSave.slice(0, lastIdx);
                    }
                }
                if (toSave.length > 0) {
                    this.historyWriter.appendNewMessages(
                        this.type,
                        toSave,
                        raw.title,
                        this.instanceId,
                    );
                }
            }

        } catch (e: any) {
            const msg = e?.message || String(e);
            if (msg.includes('Timeout') || msg.includes('timeout') || msg.includes('Target closed')) {
 // CDP timeout — unified logging from onTick
            } else {
                LOG.warn('IdeInstance', `[IdeInstance:${this.type}] readChat internal error: ${msg}`);
            }
        }
    }

    private getReadChatScript(): string | null {
        const scripts = this.provider.scripts;
        if (!scripts?.readChat) return null;
        return typeof scripts.readChat === 'function' ? scripts.readChat({}) : scripts.readChat as any;
    }

 // ─── status transition detect ─────────────────────────────

    private detectAgentTransitions(chatData: any, now: number): void {
        const chatStatus = chatData?.status;
        if (!chatStatus) return;

        const agentKey = `${this.type}:native`;
        const agentStatus = (chatStatus === 'streaming' || chatStatus === 'generating') ? 'generating'
            : chatStatus === 'waiting_approval' ? 'waiting_approval'
            : 'idle';
        const lastMsg = Array.isArray(chatData?.messages) && chatData.messages.length > 0
            ? chatData.messages[chatData.messages.length - 1]
            : null;
        const progressFingerprint = agentStatus === 'generating'
            ? `${lastMsg?.role || ''}:${typeof lastMsg?.content === 'string' ? lastMsg.content : JSON.stringify(lastMsg?.content || '')}`.slice(-2000)
            : undefined;

        this.currentStatus = agentStatus;
        const lastStatus = this.lastAgentStatuses.get(agentKey) || 'idle';

        if (agentStatus !== lastStatus) {
            const chatTitle = chatData.title || this.provider.name;

            if (lastStatus === 'idle' && agentStatus === 'generating') {
                this.generatingStartedAt.set(agentKey, now);
                this.pushEvent({ event: 'agent:generating_started', chatTitle, timestamp: now, ideType: this.type });
            } else if (agentStatus === 'waiting_approval') {
                if (!this.generatingStartedAt.has(agentKey)) this.generatingStartedAt.set(agentKey, now);
                const msg = chatData.activeModal?.message;
                this.pushEvent({
                    event: 'agent:waiting_approval', chatTitle, timestamp: now, ideType: this.type,
                    modalMessage: msg,
                    modalButtons: chatData.activeModal?.buttons,
                });
            } else if (agentStatus === 'idle' && (lastStatus === 'generating' || lastStatus === 'waiting_approval')) {
                const startedAt = this.generatingStartedAt.get(agentKey);
                const duration = startedAt ? Math.round((now - startedAt) / 1000) : 0;
                this.pushEvent({ event: 'agent:generating_completed', chatTitle, duration, timestamp: now, ideType: this.type });
                this.generatingStartedAt.delete(agentKey);
            }

            this.lastAgentStatuses.set(agentKey, agentStatus);
        }

 // Auto-approve: when waiting_approval + settings.autoApprove → auto-click approve via CDP
        if (agentStatus === 'waiting_approval' && this.settings.autoApprove && !this.autoApproveBusy) {
            this.autoApproveViaScript(chatData);
        }

 // Monitor check (cooldown based notification)
        const monitorEvents = this.monitor.check(agentKey, agentStatus, now, progressFingerprint);
        for (const me of monitorEvents) {
            this.pushEvent({ event: me.type, agentKey: me.agentKey, message: me.message, elapsedSec: me.elapsedSec, timestamp: me.timestamp });
        }
    }

    private pushEvent(event: ProviderEvent): void {
        this.events.push(event);
        if (this.events.length > 50) this.events = this.events.slice(-50);
    }

    private flushEvents(): ProviderEvent[] {
        const events = [...this.events];
        this.events = [];
        return events;
    }

 // ─── external access ─────────────────────────────────

    updateCdp(cdp: InstanceContext['cdp']): void {
        if (this.context) this.context.cdp = cdp;
    }

 // ─── Auto-approve via CDP script ────────────────────

    private async autoApproveViaScript(_chatData: any): Promise<void> {
        const cdp = this.context?.cdp;
        if (!cdp?.isConnected) return;

        // Check if provider has resolveAction script
        const scriptFn = this.provider.scripts?.resolveAction;
        if (typeof scriptFn !== 'function') {
            LOG.debug('IdeInstance', `[IdeInstance:${this.type}] autoApprove: no resolveAction script available`);
            return;
        }

        this.autoApproveBusy = true;
        try {
            let targetButton = _chatData?.activeModal?.buttons?.[0] || 'Run';
            const buttons = _chatData?.activeModal?.buttons || [];
            
            // Prefer buttons like 'Run', 'Approve', 'Yes'
            for (const b of buttons) {
                const lower = String(b).toLowerCase().replace(/[^\w]/g, '');
                if (/^(run|approve|accept|yes|allow|always|proceed|save)/.test(lower)) {
                    targetButton = b;
                    break;
                }
            }

            const script = scriptFn({ action: 'approve', button: targetButton, buttonText: targetButton });
            if (!script) return;

            LOG.info('IdeInstance', `[IdeInstance:${this.type}] autoApprove: executing resolveAction for "${targetButton}"`);
            let rawResult = await cdp.evaluate(script, 10000);
            if (typeof rawResult === 'string') {
                try { rawResult = JSON.parse(rawResult); } catch { }
            }
            
            const result: any = rawResult;
            LOG.info('IdeInstance', `[IdeInstance:${this.type}] autoApprove result: ${JSON.stringify(result)?.slice(0, 200)}`);

            if (result?.found && result.x != null && result.y != null) {
                // Coordinate-based click (fallback when script cannot .click() directly)
                const x = result.x;
                const y = result.y;
                if (cdp.send) {
                    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
                    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
                    LOG.info('IdeInstance', `[IdeInstance:${this.type}] autoApprove: dispatched mouse event at ${x},${y}`);
                } else {
                    LOG.warn('IdeInstance', `[IdeInstance:${this.type}] autoApprove: cdp.send() not available for coordinate click`);
                }
            }

            this.pushEvent({
                event: 'agent:auto_approved',
                chatTitle: _chatData?.title || this.provider.name,
                timestamp: Date.now(),
                ideType: this.type,
            });
        } catch (e: any) {
            LOG.warn('IdeInstance', `[IdeInstance:${this.type}] autoApprove error: ${e?.message}`);
        } finally {
            // Debounce: prevent rapid re-approval
            setTimeout(() => { this.autoApproveBusy = false; }, 1000);
        }
    }
}
