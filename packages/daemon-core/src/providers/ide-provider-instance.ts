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
import { flattenContent, type ProviderModule } from './contracts.js';
import type { ProviderInstance, ProviderState, ProviderEvent, InstanceContext } from './provider-instance.js';
import { ExtensionProviderInstance } from './extension-provider-instance.js';
import { StatusMonitor } from './status-monitor.js';
import { ChatHistoryWriter } from '../config/chat-history.js';
import { LOG } from '../logging/logger.js';
import { buildPersistedProviderEffectMessage, normalizeProviderEffects } from './control-effects.js';
import { validateReadChatResultPayload } from './read-chat-contract.js';
import type { ChatMessage } from '../types.js';
import { formatAutoApprovalMessage, pickApprovalButton } from './approval-utils.js';
import { mergeProviderPatchState, resolveProviderStateSurface } from './provider-patch-state.js';
import { buildChatMessage, buildRuntimeSystemChatMessage, normalizeChatMessages } from './chat-message-normalization.js';

type ReadChatModal = {
    message?: string;
    buttons?: string[];
    width?: number;
    height?: number;
};

type ReadChatMessage = ChatMessage & { content: string };

type ReadChatPayload = {
    activeModal?: ReadChatModal;
    messages?: ReadChatMessage[];
    controlValues?: Record<string, string | number | boolean>;
    status?: string;
    title?: string;
    [key: string]: unknown;
};

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
    private appliedEffectKeys = new Set<string>();
    private runtimeMessages: Array<{ key: string; message: ChatMessage }> = [];

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
        const autoApproveActive = (
            this.currentStatus === 'waiting_approval'
            || this.cachedChat?.status === 'waiting_approval'
        ) && this.canAutoApprove();
        const visibleStatus = (autoApproveActive ? 'generating' : this.currentStatus) as ProviderState['status'];

 // Collect extension status
        const extensionStates: ProviderState[] = [];
        for (const ext of this.extensions.values()) {
            extensionStates.push(ext.getState());
        }

        const surface = resolveProviderStateSurface({
            summaryMetadata: this.cachedChat?.summaryMetadata,
            controlValues: this.cachedChat?.controlValues,
        });

        return {
            type: this.type,
            name: this.provider.name,
            category: 'ide',
            status: visibleStatus,
            activeChat: this.cachedChat ? {
                id: this.cachedChat.id || 'active_session',
                title: this.cachedChat.title || this.type,
                status: autoApproveActive && this.cachedChat.status === 'waiting_approval'
                    ? 'generating'
                    : (this.cachedChat.status || visibleStatus),
                messages: this.mergeConversationMessages(this.cachedChat.messages || []),
                activeModal: autoApproveActive ? null : (this.cachedChat.activeModal || null),
                inputContent: this.cachedChat.inputContent || '',
            } : null,
            workspace: this.workspace || null,
            extensions: extensionStates,
            cdpConnected: cdp?.isConnected || false,
            controlValues: surface.controlValues,
            providerControls: this.provider.controls,
            summaryMetadata: surface.summaryMetadata as any,
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
            for (const ext of this.extensions.values()) {
                ext.onEvent('stream_reset');
            }
        } else if (event === 'stream_update') {
 // Forward to Extension
            const extType = data?.extensionType;
            if (extType && this.extensions.has(extType)) {
                this.extensions.get(extType)!.onEvent('stream_update', data);
            }
        } else if (event === 'stream_reset') {
            const extType = data?.extensionType;
            if (extType && this.extensions.has(extType)) {
                this.extensions.get(extType)!.onEvent('stream_reset');
            }
        } else if (event === 'stream_reset_all') {
            for (const ext of this.extensions.values()) {
                ext.onEvent('stream_reset');
            }
        } else if (event === 'provider_state_patch' && data && typeof data === 'object') {
            const extType = typeof data.extensionType === 'string' ? data.extensionType : '';
            if (extType && this.extensions.has(extType)) {
                this.extensions.get(extType)!.onEvent('provider_state_patch', data);
            } else {
                this.applyProviderResponse(data, { phase: 'immediate' });
            }
        }
    }

    dispose(): void {
        this.cachedChat = null;
        this.lastAgentStatuses.clear();
        this.generatingStartedAt.clear();
        this.monitor.reset();
        this.appliedEffectKeys.clear();
        this.runtimeMessages = [];
 // Child Extension cleanup
        for (const ext of this.extensions.values()) {
            ext.dispose();
        }
        this.extensions.clear();
    }

    updateSettings(newSettings: Record<string, any>): void {
        this.settings = { ...newSettings };
        this.monitor.updateConfig({
            approvalAlert: this.settings.approvalAlert !== false,
            longGeneratingAlert: this.settings.longGeneratingAlert !== false,
            longGeneratingThresholdSec: this.settings.longGeneratingThresholdSec || 180,
        });
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
            let raw: unknown = null;

 // path 1: webview iframe internal (Kiro, PearAI etc)
            const webviewFn = this.provider.scripts?.webviewReadChat;
            if (typeof webviewFn === 'function' && cdp.evaluateInWebviewFrame) {
                const webviewScript = webviewFn();
                if (webviewScript) {
                    const matchText = this.provider.webviewMatchText;
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
                raw = await cdp.evaluate(readChatScript, 30000);
                if (typeof raw === 'string') {
                    try { raw = JSON.parse(raw); } catch { return; }
                }
            }

            if (!raw || typeof raw !== 'object') return;
            const chat = validateReadChatResultPayload(raw, `${this.type} readChat`) as ReadChatPayload;

 // Modal filter
            let { activeModal } = chat;
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
            const rawMessages = chat.messages || [];
            for (const msg of rawMessages) {
                const h = `${msg.role}:${(msg.content || '').slice(0, 100)}`;
                msg.receivedAt = prevByHash.get(h) || now;
            }
            chat.messages = normalizeChatMessages(rawMessages as ChatMessage[]) as any;
            const messages = chat.messages || [];

            // Filter messages by provider settings (showThinking, showToolCalls, showTerminal)
            if (messages.length > 0) {
                const hiddenKinds = new Set<string>();
                if (this.settings.showThinking === false) hiddenKinds.add('thought');
                if (this.settings.showToolCalls === false) hiddenKinds.add('tool');
                if (this.settings.showTerminal === false) hiddenKinds.add('terminal');
                if (hiddenKinds.size > 0) {
                    chat.messages = messages.filter((m) => !hiddenKinds.has(m.kind || ''));
                }
            }

            const patchedState = mergeProviderPatchState({
                providerControls: this.provider.controls,
                data: chat,
                mergeWithCurrent: false,
            });
            chat.controlValues = Object.keys(patchedState.controlValues).length > 0 ? patchedState.controlValues : undefined;
            chat.summaryMetadata = patchedState.summaryMetadata;

            this.cachedChat = { ...chat, activeModal };
            this.detectAgentTransitions(chat, now);

 // Save history (new messageonly append)
 // Exclude last incomplete assistant message during generating status
            const persistedMessages = chat.messages || messages;
            if (persistedMessages.length > 0) {
                let toSave = persistedMessages;
                if (chat.status === 'generating' || chat.status === 'long_generating') {
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
                        chat.title,
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
        return scripts.readChat({});
    }

 // ─── status transition detect ─────────────────────────────

    private detectAgentTransitions(chatData: any, now: number): void {
        const chatStatus = chatData?.status;
        if (!chatStatus) return;

        const agentKey = `${this.type}:native`;
        const rawAgentStatus = (chatStatus === 'streaming' || chatStatus === 'generating') ? 'generating'
            : chatStatus === 'waiting_approval' ? 'waiting_approval'
            : 'idle';
        const autoApproveActive = rawAgentStatus === 'waiting_approval' && this.canAutoApprove();
        const agentStatus = autoApproveActive ? 'generating' : rawAgentStatus;
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

        this.applyProviderResponse(chatData, {
            phase: (agentStatus === 'idle' && (lastStatus === 'generating' || lastStatus === 'waiting_approval'))
                ? 'turn_completed'
                : 'immediate',
        });

 // Auto-approve: when waiting_approval + settings.autoApprove → auto-click approve via CDP
        if (rawAgentStatus === 'waiting_approval' && autoApproveActive && !this.autoApproveBusy) {
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

    private applyProviderResponse(data: any, options: { phase: 'immediate' | 'turn_completed' }): void {
        if (!data || typeof data !== 'object') return;

        const patchedState = mergeProviderPatchState({
            providerControls: this.provider.controls,
            data,
            currentControlValues: this.cachedChat?.controlValues,
            currentSummaryMetadata: this.cachedChat?.summaryMetadata,
        });
        this.cachedChat = {
            ...(this.cachedChat || {}),
            ...data,
            controlValues: Object.keys(patchedState.controlValues).length > 0 ? patchedState.controlValues : undefined,
            summaryMetadata: patchedState.summaryMetadata,
        };

        const effects = normalizeProviderEffects(data);
        for (const effect of effects) {
            const effectWhen = effect.when || 'immediate';
            if (effectWhen === 'turn_completed' && options.phase !== 'turn_completed') continue;
            if (effectWhen === 'immediate' && options.phase === 'turn_completed') continue;

            const effectKey = this.getEffectDedupKey(effect);
            if (this.appliedEffectKeys.has(effectKey)) continue;
            this.appliedEffectKeys.add(effectKey);

            if (effect.persist !== false) {
                const persistedMessage = buildPersistedProviderEffectMessage(effect);
                if (persistedMessage) this.appendRuntimeMessage(persistedMessage, effectKey);
            }

            if (effect.type === 'message' && effect.message) {
                this.pushEvent({
                    event: 'provider:message',
                    timestamp: Date.now(),
                    content: typeof effect.message.content === 'string' ? effect.message.content : JSON.stringify(effect.message.content),
                    role: effect.message.role || 'system',
                    kind: effect.message.kind,
                    senderName: effect.message.senderName,
                });
            } else if (effect.type === 'toast' && effect.toast) {
                this.pushEvent({
                    event: 'provider:toast',
                    effectId: effect.id || effectKey,
                    timestamp: Date.now(),
                    message: effect.toast.message,
                    level: effect.toast.level || 'info',
                });
            } else if (effect.type === 'notification' && effect.notification) {
                this.pushEvent({
                    event: 'provider:notification',
                    effectId: effect.id || effectKey,
                    timestamp: Date.now(),
                    title: effect.notification.title,
                    message: effect.notification.body,
                    content: typeof effect.notification.bubbleContent === 'string'
                        ? effect.notification.bubbleContent
                        : effect.notification.body,
                    level: effect.notification.level || 'info',
                    channels: effect.notification.channels || ['toast'],
                    preferenceKey: effect.notification.preferenceKey,
                });
            }
        }
    }

    private appendRuntimeSystemMessage(content: string, dedupKey: string, receivedAt = Date.now()): void {
        this.appendRuntimeMessage(buildRuntimeSystemChatMessage({
            content,
            receivedAt,
            timestamp: receivedAt,
        }), dedupKey);
    }

    private appendRuntimeMessage(message: ChatMessage, dedupKey: string): void {
        const normalizedMessage = buildChatMessage({
            ...message,
            receivedAt: typeof message.receivedAt === 'number' ? message.receivedAt : (message.timestamp || Date.now()),
            timestamp: typeof message.timestamp === 'number' ? message.timestamp : (message.receivedAt || Date.now()),
        } as ChatMessage);
        const normalizedContent = typeof normalizedMessage.content === 'string'
            ? normalizedMessage.content.trim()
            : flattenContent(normalizedMessage.content).trim();
        if (!normalizedContent && (!Array.isArray(normalizedMessage.content) || normalizedMessage.content.length === 0)) return;
        if (this.runtimeMessages.some((entry) => entry.key === dedupKey)) return;
        if (!this.cachedChat) {
            this.cachedChat = {
                id: 'active_session',
                title: this.provider.name,
                status: this.currentStatus,
                messages: [],
                activeModal: null,
                inputContent: '',
            };
        }

        this.runtimeMessages.push({
            key: dedupKey,
            message: normalizedMessage,
        });
        if (this.runtimeMessages.length > 50) this.runtimeMessages = this.runtimeMessages.slice(-50);

        if (normalizedContent) {
            this.historyWriter.appendNewMessages(
                this.type,
                [{
                    role: normalizedMessage.role,
                    senderName: normalizedMessage.senderName,
                    kind: normalizedMessage.kind,
                    content: normalizedContent,
                    receivedAt: normalizedMessage.receivedAt || normalizedMessage.timestamp,
                    historyDedupKey: dedupKey,
                }],
                this.cachedChat?.title || this.provider.name,
                this.instanceId,
                this.cachedChat?.id || this.instanceId,
            );
        }
    }

    private mergeConversationMessages(messages: any[]): ChatMessage[] {
        if (this.runtimeMessages.length === 0) return normalizeChatMessages(messages);
        return normalizeChatMessages([...messages, ...this.runtimeMessages.map((entry) => entry.message)]
            .map((message, index) => ({ message, index }))
            .sort((a, b) => {
                const aTime = a.message.receivedAt || a.message.timestamp || 0;
                const bTime = b.message.receivedAt || b.message.timestamp || 0;
                if (aTime !== bTime) return aTime - bTime;
                return a.index - b.index;
            })
            .map((entry) => entry.message));
    }

    private getPersistedEffectContent(effect: { type: string; message?: { content?: unknown }; toast?: { message?: string }; notification?: { title?: string; body?: string; bubbleContent?: unknown } }): string | null {
        if (effect.type === 'message') {
            return typeof effect.message?.content === 'string'
                ? effect.message.content
                : JSON.stringify(effect.message?.content || '');
        }
        if (effect.type === 'toast') {
            return effect.toast?.message || null;
        }
        if (effect.type === 'notification') {
            if (typeof effect.notification?.bubbleContent === 'string') return effect.notification.bubbleContent;
            if (typeof effect.notification?.title === 'string' && effect.notification.title.trim()) {
                return `${effect.notification.title}\n${effect.notification.body || ''}`.trim();
            }
            return effect.notification?.body || null;
        }
        return null;
    }

    private getEffectDedupKey(effect: { id?: string; type: string; message?: { content?: unknown }; toast?: { message?: string }; notification?: { title?: string; body?: string } }): string {
        if (effect.id) return `provider_effect:${effect.id}`;
        if (effect.type === 'message') {
            return `provider_effect:message:${typeof effect.message?.content === 'string' ? effect.message.content : JSON.stringify(effect.message?.content || '')}`;
        }
        if (effect.type === 'notification') {
            return `provider_effect:notification:${effect.notification?.title || ''}:${effect.notification?.body || ''}`;
        }
        return `provider_effect:toast:${effect.toast?.message || ''}`;
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

    private canAutoApprove(): boolean {
        return this.settings.autoApprove !== false
            && typeof this.provider.scripts?.resolveAction === 'function'
            && !!this.context?.cdp?.isConnected;
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
            const { label: targetButton } = pickApprovalButton(_chatData?.activeModal?.buttons, this.provider);

            const script = scriptFn({ action: 'approve', button: targetButton, buttonText: targetButton });
            if (!script) return;
            const now = Date.now();
            this.appendRuntimeSystemMessage(
                formatAutoApprovalMessage(_chatData?.activeModal?.message, targetButton),
                `auto_approval:${now}:${targetButton}`,
                now,
            );

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
        } catch (e: any) {
            LOG.warn('IdeInstance', `[IdeInstance:${this.type}] autoApprove error: ${e?.message}`);
        } finally {
            // Debounce: prevent rapid re-approval
            setTimeout(() => { this.autoApproveBusy = false; }, 1000);
        }
    }
}
