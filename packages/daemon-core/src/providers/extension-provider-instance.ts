/**
 * ExtensionProviderInstance — Runtime instance for Extension Provider
 *
 * Manages IDE extensions (Cline, Roo Code, etc).
 * CDP webview discovery + agent stream collection moved here.
 */

import type { ProviderModule } from './contracts.js';
import type { ProviderInstance, ProviderState, ProviderEvent, InstanceContext } from './provider-instance.js';
import { StatusMonitor } from './status-monitor.js';
import { normalizeProviderEffects } from './control-effects.js';
import { ChatHistoryWriter } from '../config/chat-history.js';
import type { ChatMessage } from '../types.js';
import { mergeProviderPatchState, resolveProviderStateSurface } from './provider-patch-state.js';

export class ExtensionProviderInstance implements ProviderInstance {
    readonly type: string;
    readonly category = 'extension' as const;

    private provider: ProviderModule;
    private context: InstanceContext | null = null;
    private settings: Record<string, any> = {};
    private events: ProviderEvent[] = [];

 // status
    private currentStatus: string = 'idle';
    private agentStreams: any[] = [];
    private messages: any[] = [];
    private prevMessageHashes = new Map<string, number>();
    private activeModal: any = null;
    private controlValues: Record<string, string | number | boolean> = {};
    private summaryMetadata: unknown = undefined;
    private appliedEffectKeys = new Set<string>();
    private runtimeMessages: Array<{ key: string; message: ChatMessage }> = [];
    private lastAgentStatus: string = 'idle';
    private generatingStartedAt: number = 0;
    private monitor: StatusMonitor;
    private historyWriter: ChatHistoryWriter;

 // meta
    private instanceId: string;
    private ideType: string = '';
    private chatId: string | null = null;
    private chatTitle: string | null = null;
    private agentName: string = '';
    private extensionId: string = '';

    constructor(provider: ProviderModule) {
        this.type = provider.type;
        this.provider = provider;
        this.instanceId = crypto.randomUUID();
        this.monitor = new StatusMonitor();
        this.historyWriter = new ChatHistoryWriter();
    }

 // ─── Lifecycle ──────────────────────────────────

    async init(context: InstanceContext): Promise<void> {
        this.context = context;
        this.settings = context.settings || {};
        this.monitor.updateConfig({
            approvalAlert: this.settings.approvalAlert !== false,
            longGeneratingAlert: this.settings.longGeneratingAlert !== false,
            longGeneratingThresholdSec: this.settings.longGeneratingThresholdSec || 180,
        });
    }

    async onTick(): Promise<void> {
 // Extension gets data pushed from IDE's CDP agent stream
 // Needed when direct stream collection via CDP is possible
        if (!this.context?.cdp?.isConnected) return;

 // Agent stream collect (CDP discoverAgentWebviews etc)
 // Currently handled separately by agent-stream-manager only
 // Can be moved here in the future
    }

    getState(): ProviderState {
        const surface = resolveProviderStateSurface({
            summaryMetadata: this.summaryMetadata as any,
            controlValues: this.controlValues,
        })

        return {
            type: this.type,
            name: this.provider.name,
            category: 'extension',
            status: this.currentStatus as ProviderState['status'],
            activeChat: (this.messages.length > 0 || this.runtimeMessages.length > 0) ? {
                id: this.chatId || this.instanceId,
                title: this.chatTitle || this.agentName || this.provider.name,
                status: this.currentStatus,
                messages: this.mergeConversationMessages(this.messages),
                activeModal: this.activeModal,
                inputContent: '',
            } : null,
            controlValues: surface.controlValues,
            providerControls: this.provider.controls,
            summaryMetadata: surface.summaryMetadata as any,
            agentStreams: this.agentStreams,
            instanceId: this.instanceId,
            lastUpdated: Date.now(),
            settings: this.settings,
            pendingEvents: this.flushEvents(),
        };
    }

    onEvent(event: string, data?: any): void {
        if (event === 'stream_update') {
 // Reflect data collected from agent-stream-manager
            if (data?.streams) this.agentStreams = data.streams;
            if (data?.messages) this.messages = this.assignReceivedAt(data.messages);
            if (data?.activeModal !== undefined) this.activeModal = data.activeModal;
            const patchedState = mergeProviderPatchState({
                providerControls: this.provider.controls,
                data,
                currentControlValues: this.controlValues,
                currentSummaryMetadata: this.summaryMetadata,
            });
            this.controlValues = patchedState.controlValues;
            this.summaryMetadata = patchedState.summaryMetadata;
            if (typeof data?.sessionId === 'string' && data.sessionId.trim()) this.chatId = data.sessionId;
            if (typeof data?.title === 'string' && data.title.trim()) this.chatTitle = data.title;
            if (typeof data?.agentName === 'string' && data.agentName.trim()) this.agentName = data.agentName;
            if (typeof data?.extensionId === 'string' && data.extensionId.trim()) this.extensionId = data.extensionId;
            if (data?.status) {
                const newStatus = data.status;
                this.detectTransition(newStatus, data);
                this.currentStatus = newStatus;
            }
        } else if (event === 'stream_reset') {
            this.resetStreamState();
        } else if (event === 'extension_connected') {
            this.ideType = data?.ideType || '';
        } else if (event === 'provider_state_patch' && data && typeof data === 'object') {
            this.applyProviderResponse(data, { phase: 'immediate' });
 // Maintain instanceId UUID — do not overwrite
        }
    }

    dispose(): void {
        this.agentStreams = [];
        this.messages = [];
        this.prevMessageHashes.clear();
        this.monitor.reset();
        this.appliedEffectKeys.clear();
        this.runtimeMessages = [];
    }

    updateSettings(newSettings: Record<string, any>): void {
        this.settings = { ...newSettings };
        this.monitor.updateConfig({
            approvalAlert: this.settings.approvalAlert !== false,
            longGeneratingAlert: this.settings.longGeneratingAlert !== false,
            longGeneratingThresholdSec: this.settings.longGeneratingThresholdSec || 180,
        });
    }

 /** Query UUID instanceId */
    getInstanceId(): string {
        return this.instanceId;
    }

 // ─── status transition detect ──────────────────────────────
    private detectTransition(newStatus: string, data: any): void {
        const now = Date.now();
        const agentStatus = (newStatus === 'streaming' || newStatus === 'generating') ? 'generating'
            : newStatus === 'waiting_approval' ? 'waiting_approval'
            : 'idle';
        const lastMsg = Array.isArray(data?.messages) && data.messages.length > 0
            ? data.messages[data.messages.length - 1]
            : null;
        const progressFingerprint = agentStatus === 'generating'
            ? `${lastMsg?.role || ''}:${typeof lastMsg?.content === 'string' ? lastMsg.content : JSON.stringify(lastMsg?.content || '')}`.slice(-2000)
            : undefined;

        const previousStatus = this.lastAgentStatus;
        if (agentStatus !== this.lastAgentStatus) {
            if (this.lastAgentStatus === 'idle' && agentStatus === 'generating') {
                this.generatingStartedAt = now;
                this.pushEvent({
                    event: 'agent:generating_started',
                    chatTitle: this.resolveChatTitle(data),
                    timestamp: now,
                    ideType: this.ideType || this.type,
                    agentType: this.type,
                    agentName: this.agentName || this.provider.name,
                    extensionId: this.extensionId || this.type,
                });
            } else if (agentStatus === 'waiting_approval') {
                if (!this.generatingStartedAt) this.generatingStartedAt = now;
                this.pushEvent({
                    event: 'agent:waiting_approval',
                    chatTitle: this.resolveChatTitle(data),
                    timestamp: now,
                    ideType: this.ideType || this.type,
                    agentType: this.type,
                    agentName: this.agentName || this.provider.name,
                    extensionId: this.extensionId || this.type,
                    modalMessage: data?.activeModal?.message,
                    modalButtons: data?.activeModal?.buttons,
                });
            } else if (agentStatus === 'idle' && (this.lastAgentStatus === 'generating' || this.lastAgentStatus === 'waiting_approval')) {
                const duration = this.generatingStartedAt ? Math.round((now - this.generatingStartedAt) / 1000) : 0;
                this.pushEvent({
                    event: 'agent:generating_completed',
                    chatTitle: this.resolveChatTitle(data),
                    duration,
                    timestamp: now,
                    ideType: this.ideType || this.type,
                    agentType: this.type,
                    agentName: this.agentName || this.provider.name,
                    extensionId: this.extensionId || this.type,
                });
                this.generatingStartedAt = 0;
            }
            this.lastAgentStatus = agentStatus;
        }

        this.applyProviderResponse(data, {
            phase: (agentStatus === 'idle' && (previousStatus === 'generating' || previousStatus === 'waiting_approval'))
                ? 'turn_completed'
                : 'immediate',
        });

 // Monitor check (cooldown based notification) — keep monitor events (long_generating etc)
        const agentKey = `${this.type}:ext`;
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
            currentControlValues: this.controlValues,
            currentSummaryMetadata: this.summaryMetadata,
        });
        this.controlValues = patchedState.controlValues;
        this.summaryMetadata = patchedState.summaryMetadata;

        const effects = normalizeProviderEffects(data);
        for (const effect of effects) {
            const effectWhen = effect.when || 'immediate';
            if (effectWhen === 'turn_completed' && options.phase !== 'turn_completed') continue;
            if (effectWhen === 'immediate' && options.phase === 'turn_completed') continue;

            const effectKey = this.getEffectDedupKey(effect);
            if (this.appliedEffectKeys.has(effectKey)) continue;
            this.appliedEffectKeys.add(effectKey);

            if (effect.persist !== false) {
                const persisted = this.getPersistedEffectContent(effect);
                if (persisted) this.appendRuntimeSystemMessage(persisted, effectKey);
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
        const normalizedContent = String(content || '').trim();
        if (!normalizedContent) return;
        if (this.runtimeMessages.some((entry) => entry.key === dedupKey)) return;

        this.runtimeMessages.push({
            key: dedupKey,
            message: {
                role: 'system',
                senderName: 'System',
                content: normalizedContent,
                receivedAt,
                timestamp: receivedAt,
            },
        });
        if (this.runtimeMessages.length > 50) this.runtimeMessages = this.runtimeMessages.slice(-50);

        this.historyWriter.appendNewMessages(
            this.type,
            [{
                role: 'system',
                senderName: 'System',
                content: normalizedContent,
                kind: 'system',
                receivedAt,
                historyDedupKey: dedupKey,
            }],
            this.chatTitle || this.agentName || this.provider.name,
            this.instanceId,
            this.chatId || this.instanceId,
        );
    }

    /**
     * Assign stable receivedAt to extension messages.
     * Same pattern as IdeProviderInstance.readChat() prevByHash —
     * preserves first-seen timestamp across polling cycles.
     */
    private assignReceivedAt(messages: any[]): any[] {
        const now = Date.now();
        const nextHashes = new Map<string, number>();

        for (const msg of messages) {
            const hash = `${msg.role}:${(msg.content || '').slice(0, 100)}`;
            const prevTime = this.prevMessageHashes.get(hash);
            msg.receivedAt = prevTime || now;
            nextHashes.set(hash, msg.receivedAt);
        }

        this.prevMessageHashes = nextHashes;
        return messages;
    }

    private mergeConversationMessages(messages: any[]): ChatMessage[] {
        if (this.runtimeMessages.length === 0) return messages;
        return [...messages, ...this.runtimeMessages.map((entry) => entry.message)]
            .map((message, index) => ({ message, index }))
            .sort((a, b) => {
                const aTime = a.message.receivedAt || a.message.timestamp || 0;
                const bTime = b.message.receivedAt || b.message.timestamp || 0;
                if (aTime !== bTime) return aTime - bTime;
                return a.index - b.index;
            })
            .map((entry) => entry.message);
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

    private resolveChatTitle(data: any): string {
        const title = typeof data?.title === 'string' && data.title.trim()
            ? data.title.trim()
            : this.chatTitle;
        return title || this.agentName || this.provider.name;
    }

    private resetStreamState(): void {
        if (this.currentStatus !== 'idle') {
            this.detectTransition('idle', {
                title: this.chatTitle,
                agentName: this.agentName,
                extensionId: this.extensionId,
                messages: this.messages,
            });
        }
        this.agentStreams = [];
        this.messages = [];
        this.prevMessageHashes.clear();
        this.activeModal = null;
        this.controlValues = {};
        this.currentStatus = 'idle';
        this.chatId = null;
        this.chatTitle = null;
        this.agentName = '';
        this.extensionId = '';
        this.lastAgentStatus = 'idle';
        this.generatingStartedAt = 0;
        this.monitor.reset();
    }
}
