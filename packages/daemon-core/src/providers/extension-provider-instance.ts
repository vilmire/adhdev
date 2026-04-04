/**
 * ExtensionProviderInstance — Runtime instance for Extension Provider
 *
 * Manages IDE extensions (Cline, Roo Code, etc).
 * CDP webview discovery + agent stream collection moved here.
 */

import type { ProviderModule } from './contracts.js';
import type { ProviderInstance, ProviderState, ProviderEvent, InstanceContext } from './provider-instance.js';
import { StatusMonitor } from './status-monitor.js';

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
    private activeModal: any = null;
    private currentModel: string = '';
    private currentMode: string = '';
    private controlValues: Record<string, string | number | boolean> = {};
    private lastAgentStatus: string = 'idle';
    private generatingStartedAt: number = 0;
    private monitor: StatusMonitor;

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
        return {
            type: this.type,
            name: this.provider.name,
            category: 'extension',
            status: this.currentStatus as ProviderState['status'],
            activeChat: this.messages.length > 0 ? {
                id: this.chatId || this.instanceId,
                title: this.chatTitle || this.agentName || this.provider.name,
                status: this.currentStatus,
                messages: this.messages,
                activeModal: this.activeModal,
                inputContent: '',
            } : null,
            currentModel: this.currentModel || undefined,
            currentPlan: this.currentMode || undefined,
            controlValues: this.controlValues,
            providerControls: this.provider.controls as any,
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
            if (data?.messages) this.messages = data.messages;
            if (data?.activeModal !== undefined) this.activeModal = data.activeModal;
            if (data?.model) this.currentModel = data.model;
            if (data?.mode) this.currentMode = data.mode;
            if (data?.controlValues) this.controlValues = data.controlValues;
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
 // Maintain instanceId UUID — do not overwrite
        }
    }

    dispose(): void {
        this.agentStreams = [];
        this.messages = [];
        this.monitor.reset();
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
        this.activeModal = null;
        this.currentModel = '';
        this.currentMode = '';
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
