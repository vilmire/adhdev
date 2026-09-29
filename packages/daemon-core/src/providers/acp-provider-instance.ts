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

import { currentMeshAttemptRef } from './cli-provider-mesh-assignment.js';
import * as path from 'path';
import { type ChildProcess } from 'child_process';
import { ClientSideConnection, type SessionNotification } from '@agentclientprotocol/sdk';
import type {
    ProviderModule,
    ContentBlock,
    InputEnvelope,
    ToolCallInfo,
} from './contracts.js';
import { flattenContent, normalizeInputEnvelope } from './contracts.js';
import { assertProviderSupportsDeclaredInput, getEffectiveMessageInputSupport } from './provider-input-support.js';
import type { ProviderInstance, ProviderState, AcpProviderState, ProviderErrorReason, ProviderEvent, InstanceContext, ProviderSendMessageResult } from './provider-instance.js';
import { StatusMonitor } from './status-monitor.js';
import { ManualAttendanceTracker } from './manual-attendance.js';
import { buildLegacyModelModeSummaryMetadata } from './summary-metadata.js';
import { workingDirBasename } from './working-dir.js';
import {
    buildAssistantChatMessage,
    buildChatMessage,
    buildRuntimeSystemChatMessage,
    buildUserChatMessage,
    normalizeChatMessages,
    extractFinalSummaryFromMessages,
} from './chat-message-normalization.js';
import { LOG } from '../logging/logger.js';
import type { ChatMessage } from '../types.js';
import { emitStatusEdge, forwardProviderEvent, type SessionEventPort } from './provider-event-port.js';
import { emitTurnStarted, emitTurnEnd, emitSuspension, emitProcessExit, type TurnEvidencePort } from './turn-evidence-port.js';
import type { TurnAttemptRef } from '@adhdev/mesh-shared';
import {
    handleSessionUpdate,
    nextMessageSourceId,
    turnSourceId,
    withAcpSource,
    buildPartialBlocks,
    buildPartialThoughtMessage,
    finalizeAssistantMessage,
} from './acp-session-updates.js';
import { spawnAgent } from './acp-agent-process.js';

// ─── Internal Display Types (for dashboard) ────────────────────────────

export type AcpMessage = ChatMessage & {
    role: 'user' | 'assistant' | 'system';
    /** Rich content blocks (ACP standard) or plain text (legacy) */
    content: string | ContentBlock[];
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

type SelectionCategory = 'model' | 'mode';

interface PromptCapabilityFlags {
    image: boolean;
    audio: boolean;
    embeddedContext: boolean;
}

function getPromptCapabilityFlags(agentCapabilities?: Record<string, any>): PromptCapabilityFlags {
    const prompt = agentCapabilities?.promptCapabilities || {};
    return {
        image: prompt.image === true,
        audio: prompt.audio === true,
        embeddedContext: prompt.embeddedContext === true,
    };
}

function appendPromptText(promptParts: ContentBlock[], text: string | undefined): void {
    const normalized = typeof text === 'string' ? text.trim() : '';
    if (!normalized) return;
    const last = promptParts[promptParts.length - 1];
    if (last?.type === 'text' && last.text === normalized) return;
    promptParts.push({ type: 'text', text: normalized });
}

function getUriDisplayName(uri: string | undefined, fallback: string): string {
    if (!uri) return fallback;
    try {
        const pathname = uri.startsWith('file://') ? new URL(uri).pathname : uri;
        return pathname.split(/[\\/]/).filter(Boolean).pop() || fallback;
    } catch {
        return uri.split(/[\\/]/).filter(Boolean).pop() || fallback;
    }
}

function appendResourceLink(
    promptParts: ContentBlock[],
    uri: string,
    fallbackName: string,
    mimeType?: string,
    description?: string,
    metadata?: Pick<Extract<ContentBlock, { type: 'resource_link' }>, 'title' | 'size' | 'annotations'> & { name?: string },
): void {
    promptParts.push({
        type: 'resource_link',
        uri,
        name: metadata?.name || getUriDisplayName(uri, fallbackName),
        ...(metadata?.title ? { title: metadata.title } : {}),
        ...(mimeType ? { mimeType } : {}),
        ...(description ? { description } : {}),
        ...(typeof metadata?.size === 'number' ? { size: metadata.size } : {}),
        ...(metadata?.annotations ? { annotations: metadata.annotations } : {}),
    });
}

function appendMediaFallbackText(promptParts: ContentBlock[], label: string, details: Array<string | undefined>): void {
    const normalizedDetails = details.map((value) => typeof value === 'string' ? value.trim() : '').filter(Boolean);
    appendPromptText(promptParts, `[${[label, ...normalizedDetails].join(': ')}]`);
}

export function buildAcpPromptParts(input: InputEnvelope, agentCapabilities?: Record<string, any>): ContentBlock[] {
    const caps = getPromptCapabilityFlags(agentCapabilities);
    const promptParts: ContentBlock[] = [];

    for (const part of input.parts) {
        if (part.type === 'text') {
            promptParts.push({ type: 'text', text: part.text });
            continue;
        }

        if (part.type === 'image') {
            if (caps.image && part.data) {
                promptParts.push({
                    type: 'image',
                    data: part.data,
                    mimeType: part.mimeType,
                    ...(part.uri ? { uri: part.uri } : {}),
                    ...(part.alt ? { alt: part.alt } : {}),
                });
                if (part.alt) appendPromptText(promptParts, part.alt);
            } else if (part.uri) {
                appendResourceLink(promptParts, part.uri, 'image', part.mimeType, part.alt);
                if (part.alt) appendPromptText(promptParts, part.alt);
            } else {
                appendMediaFallbackText(promptParts, 'Image attachment', [part.alt, part.mimeType]);
            }
            continue;
        }

        if (part.type === 'audio') {
            if (caps.audio && part.data) {
                promptParts.push({
                    type: 'audio',
                    data: part.data,
                    mimeType: part.mimeType,
                    ...(part.uri ? { uri: part.uri } : {}),
                    ...(part.transcript ? { transcript: part.transcript } : {}),
                });
                if (part.transcript) appendPromptText(promptParts, part.transcript);
            } else if (part.uri) {
                appendResourceLink(promptParts, part.uri, 'audio', part.mimeType, part.transcript);
                if (part.transcript) appendPromptText(promptParts, part.transcript);
            } else {
                appendMediaFallbackText(promptParts, 'Audio attachment', [part.transcript, part.mimeType]);
            }
            continue;
        }

        if (part.type === 'resource') {
            if (caps.embeddedContext && part.text) {
                promptParts.push({
                    type: 'resource',
                    resource: { uri: part.uri, text: part.text, mimeType: part.mimeType ?? null },
                });
                continue;
            }
            if (caps.embeddedContext && part.data) {
                promptParts.push({
                    type: 'resource',
                    resource: { uri: part.uri, blob: part.data, mimeType: part.mimeType ?? null },
                });
                continue;
            }
            appendResourceLink(promptParts, part.uri, part.name || 'resource', part.mimeType, part.text);
            if (part.text) appendPromptText(promptParts, part.text);
            continue;
        }

        if (part.type === 'resource_link') {
            appendResourceLink(promptParts, part.uri, part.name, part.mimeType, part.description, {
                name: part.name,
                ...(part.title ? { title: part.title } : {}),
                ...(typeof part.size === 'number' ? { size: part.size } : {}),
                ...(part.annotations ? { annotations: part.annotations } : {}),
            });
            continue;
        }

        if (part.type === 'video') {
            // ACP v0.16 prompt capabilities do not advertise native video input. Preserve meaning by
            // sending a linked resource when possible, plus transcript/descriptive text when present.
            if (part.uri) {
                appendResourceLink(promptParts, part.uri, 'video', part.mimeType, part.transcript);
                if (part.transcript) appendPromptText(promptParts, part.transcript);
            } else {
                appendMediaFallbackText(promptParts, 'Video attachment', [part.transcript, part.mimeType]);
            }
        }
    }

    if (!promptParts.some((part) => part.type === 'text') && input.textFallback) {
        appendPromptText(promptParts, input.textFallback);
    }

    return promptParts;
}

// ─── AcpProviderInstance ───────────────────────────

export class AcpProviderInstance implements ProviderInstance {
    readonly type: string;
    readonly category = 'acp' as const;
    readonly log = LOG.forComponent('ACP');

    provider: ProviderModule;
    settings: Record<string, any> = {};
    /** Lifecycle port (wiring-unification B2); null until boot wires it. */
    private lifecyclePort: SessionEventPort | null = null;
    private turnEvidencePort: TurnEvidencePort | null = null;
    private monitor: StatusMonitor;

 // Process
    process: ChildProcess | null = null;
    connection: ClientSideConnection | null = null;

 // State
    sessionId: string | null = null;
    messages: AcpMessage[] = [];
    currentStatus: ProviderState['status'] = 'starting';
    private lastStatus: string = 'starting';
    private generatingStartedAt = 0;
    agentCapabilities: Record<string, any> = {};
    private currentSelections: Partial<Record<SelectionCategory, string>> = {};
    activeToolCalls: AcpToolCall[] = [];
    partialContent = '';
    partialThoughtContent = '';
    /** Rich content blocks accumulated during streaming */
    partialBlocks: ContentBlock[] = [];
    /** Tool calls collected during current turn */
    turnToolCalls: ToolCallInfo[] = [];
    /**
     * Local ids for the message identity ledger's `acp` source class (design
     * 2026-09-28 §3.4). Every pushed message gets `m<n>`; a turn's streaming
     * thought/answer partials use `t<turn>.thought` / `t<turn>.answer` and the
     * finalized messages REUSE those ids, so the ledger keeps one bubble id
     * from first partial to final. Tool bubbles use the protocol toolCallId.
     */
    acpMessageSeq = 0;
    acpTurnSeq = 0;
    /**
     * When the current turn started. The streaming thought/answer partials are
     * stamped with it rather than `Date.now()`, so re-reading an unchanged
     * partial yields an identical bubble — the keyed transcript lane writes
     * only bubbles whose fields changed (design 2026-09-28 §3.1, §8.1-2).
     */
    private acpTurnStartedAt = 0;
 /** Guard: prevent concurrent sendPrompt calls from racing on shared state */
    private _sendPromptInFlight = false;

 // Error tracking
    errorMessage: string | null = null;
    errorReason: ProviderErrorReason | null = null;
    stderrBuffer: string[] = [];
    spawnedAt = 0;

 // ACP ConfigOptions & Modes (from session/new response or static fallback)
    configOptions: AcpConfigOption[] = [];
    private availableModes: AcpMode[] = [];
 /** Static config mode — agent doesn't support config/* methods */
    useStaticConfig = false;
 /** Current config selections (for spawnArgBuilder) */
    selectedConfig: Record<string, string> = {};

 // Config
    workingDir: string;
    private instanceId: string;

    constructor(
        provider: ProviderModule,
        workingDir: string,
        public cliArgs: string[] = [],
    ) {
        this.type = provider.type;
        this.provider = provider;
        this.workingDir = workingDir;
        this.instanceId = crypto.randomUUID();

        this.monitor = new StatusMonitor();
    }

 // ─── Lifecycle ─────────────────────────────────

    async init(context: InstanceContext): Promise<void> {
        this.settings = context.settings || {};
        if (!this.lifecyclePort && context.lifecycle) this.lifecyclePort = context.lifecycle;
        if (!this.turnEvidencePort && context.turnEvidence) this.turnEvidencePort = context.turnEvidence;
        this.monitor.updateConfig({
            approvalAlert: this.settings.approvalAlert !== false,
            noProgressAlert: (this.settings.noProgressAlert ?? this.settings.longGeneratingAlert) !== false,
            noProgressThresholdSec: this.settings.noProgressThresholdSec ?? this.settings.longGeneratingThresholdSec ?? 180,
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
        const dirName = workingDirBasename(this.workingDir);

        const recentMessages = normalizeChatMessages(this.messages.map(m => {
            const content = m.content;
            return buildChatMessage({
                ...m,
                content,
            });
        })) as ChatMessage[];

        if (this.currentStatus === 'generating') {
            const partialThoughtMessage = this.buildPartialThoughtMessage(this.acpTurnStartedAt || Date.now());
            if (partialThoughtMessage) recentMessages.push(this.withAcpSource(partialThoughtMessage, this.turnSourceId('thought')) as ChatMessage);
        }

 // generating during partial response add
        if (this.currentStatus === 'generating' && (this.partialContent || this.partialBlocks.length > 0)) {
            const blocks = this.buildPartialBlocks();
            if (blocks.length > 0) {
                recentMessages.push(this.withAcpSource(buildAssistantChatMessage({
                    content: blocks,
                    timestamp: this.acpTurnStartedAt || Date.now(),
                    toolCalls: this.turnToolCalls.length > 0 ? [...this.turnToolCalls] : undefined,
                }), this.turnSourceId('answer')));
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
                messages: normalizeChatMessages(recentMessages as any),
                activeModal: this.currentStatus === 'waiting_approval' ? {
                    message: this.activeToolCalls.find(t => t.status === 'running')?.name || 'Permission requested',
                    buttons: ['Approve', 'Reject'],
                } : null,
                inputContent: '',
            },
            workspace: this.workingDir,
            instanceId: this.instanceId,
            lastUpdated: Date.now(),
            settings: this.settings,
            messageInput: getEffectiveMessageInputSupport(this.provider, this.agentCapabilities),
 // ACP-specific: expose available models/modes for dashboard
            acpConfigOptions: this.configOptions,
            acpModes: this.availableModes,
 // Error details for dashboard display
            errorMessage: this.errorMessage || undefined,
            errorReason: this.errorReason || undefined,
            controlValues: this.getSelectionControlValues(),
            providerControls: this.provider.controls,
            summaryMetadata: this.buildSelectionSummaryMetadata(),
        };
    }

    onEvent(event: string, data?: any): void | Promise<ProviderSendMessageResult> {
        if (event === 'send_message') {
            const input = normalizeInputEnvelope(data)
            assertProviderSupportsDeclaredInput(this.provider, input)
            const promptParts = buildAcpPromptParts(input, this.agentCapabilities)
            // SEND-RECORD-SYMMETRY: report whether the prompt was ACCEPTED, mirroring
            // CliProviderInstance.onEvent. This was previously fire-and-forget, so the
            // two refusals below — no connection/session, and the in-flight guard —
            // were invisible to the caller, which then reported `success: true` for a
            // prompt the agent never received.
            //
            // `sendPrompt` resolves once the ACP turn COMPLETES, not when it is
            // accepted, and it deliberately swallows mid-turn `connection.prompt`
            // failures (see its catch: it finalizes the assistant message and returns
            // to idle, treating the turn as having happened). So awaiting it here would
            // block the send call for the whole turn AND still not surface those.
            // Acceptance is what this contract reports; the turn outcome reaches the
            // caller through status transitions as before.
            const accepted = this.beginSendPrompt();
            if (!accepted.ok) {
                this.log.warn(`[${this.type}] send_message refused: ${accepted.error}`);
                return Promise.resolve({ success: false, error: accepted.error });
            }
            void this.sendPrompt(
                input.textFallback,
                promptParts.length > 0 ? promptParts : undefined,
                { alreadyClaimed: true },
            ).catch(e =>
                this.log.warn(`[${this.type}] sendPrompt error: ${e?.message}`)
            );
            return Promise.resolve({ success: true, status: 'delivered' });
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

    private resolveConfigOptionLabel(category: string, value: string | undefined): string | undefined {
        if (!value) return undefined;
        const option = this.configOptions.find((entry) => entry.category === category);
        return option?.options.find((candidate) => candidate.value === value)?.name || value;
    }

    private resolveModeLabel(modeId: string | undefined): string | undefined {
        if (!modeId) return undefined;
        return this.availableModes.find((mode) => mode.id === modeId)?.name || modeId;
    }

    getCurrentSelection(category: SelectionCategory): string | undefined {
        return this.currentSelections[category];
    }

    setCurrentSelection(category: SelectionCategory, value: string | null | undefined): void {
        const normalized = typeof value === 'string' ? value.trim() : '';
        if (normalized) {
            this.currentSelections[category] = normalized;
            if (category === 'model') this.notifyModelObserved(normalized);
            return;
        }
        delete this.currentSelections[category];
    }

    /**
     * Phase E: the agent's own report of which model it runs (config options,
     * session/new result, prompt result) is an OBSERVATION for the session's
     * launch record. The launcher installs the observer once the record exists
     * (cli-manager), and the current value is reported immediately so the
     * selection parsed during session start is not lost.
     */
    private modelObserver: ((model: string, observedAt: number) => void) | null = null;

    setModelObserver(observer: ((model: string, observedAt: number) => void) | null): void {
        this.modelObserver = observer;
        const current = this.getCurrentSelection('model');
        if (observer && current) this.notifyModelObserved(current);
    }

    private notifyModelObserved(model: string): void {
        try {
            this.modelObserver?.(model, Date.now());
        } catch { /* observation bookkeeping must never break the ACP session */ }
    }

    private getSelectionControlValues(): Record<string, string> {
        const model = this.getCurrentSelection('model');
        const mode = this.getCurrentSelection('mode');
        return {
            ...(model ? { model } : {}),
            ...(mode ? { mode } : {}),
        };
    }

    private resolveSelectionLabel(category: SelectionCategory, value: string | undefined): string | undefined {
        if (!value) return undefined;
        const configLabel = this.resolveConfigOptionLabel(category, value);
        if (configLabel && configLabel !== value) return configLabel;
        if (category === 'mode') {
            const modeLabel = this.resolveModeLabel(value);
            if (modeLabel) return modeLabel;
        }
        return configLabel || value;
    }

    private buildSelectionSummaryMetadata() {
        const model = this.getCurrentSelection('model');
        const mode = this.getCurrentSelection('mode');
        return buildLegacyModelModeSummaryMetadata({
            model,
            mode,
            modelLabel: this.resolveSelectionLabel('model', model),
            modeLabel: this.resolveSelectionLabel('mode', mode),
        });
    }

 // ─── ACP Config Options & Modes ─────────────────────

    parseConfigOptions(raw: any): void {
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

 // Auto-set current selections from config
            if (category === 'model' || category === 'mode') {
                this.setCurrentSelection(category, currentValue);
            }
        }
    }

    parseModes(raw: any): void {
        if (!raw) return;
 // modes: { currentModeId, availableModes: [{ id, name, description }] }
        this.setCurrentSelection('mode', raw.currentModeId);
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
            if (category === 'model' || category === 'mode') this.setCurrentSelection(category, value);
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
            if (category === 'model' || category === 'mode') this.setCurrentSelection(category, value);
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
            this.setCurrentSelection('mode', modeId);
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
            this.setCurrentSelection('mode', modeId);
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
            noProgressAlert: (this.settings.noProgressAlert ?? this.settings.longGeneratingAlert) !== false,
            noProgressThresholdSec: this.settings.noProgressThresholdSec ?? this.settings.longGeneratingThresholdSec ?? 180,
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
    private spawnAgent(): Promise<void> { return spawnAgent(this); }

    /**
     * SEND-RECORD-SYMMETRY: the two preconditions that mean a prompt will NEVER be
     * delivered, evaluated and claimed atomically so a caller can report the refusal
     * instead of a phantom success. Claiming here (rather than re-checking inside
     * sendPrompt) is what makes the in-flight guard race-free: the decision and the
     * claim are one step.
     */
    private beginSendPrompt(): { ok: true } | { ok: false; error: string } {
        if (!this.connection || !this.sessionId) {
            return { ok: false, error: 'no active ACP connection/session' };
        }
        if (this._sendPromptInFlight) {
            return { ok: false, error: 'ACP sendPrompt already in flight' };
        }
        this._sendPromptInFlight = true;
        return { ok: true };
    }

    async sendPrompt(text: string, contentBlocks?: ContentBlock[], opts?: { alreadyClaimed?: boolean }): Promise<void> {
        if (!opts?.alreadyClaimed) {
            const accepted = this.beginSendPrompt();
            if (!accepted.ok) {
                // Preserved shape: a missing connection/session logs and returns, an
                // in-flight collision throws. onEvent no longer relies on either —
                // it claims up front — but direct callers still see prior behaviour.
                if (accepted.error === 'ACP sendPrompt already in flight') {
                    this.log.warn(`[${this.type}] sendPrompt already in flight — dropping concurrent request`);
                    throw new Error(accepted.error);
                }
                this.log.warn(`[${this.type}] Cannot send prompt: no active connection/session`);
                return;
            }
        }

 // Build prompt content
        const promptParts: any[] = contentBlocks && contentBlocks.length > 0
            ? contentBlocks.map((b) => {
                if (b.type === 'text') return { type: 'text', text: b.text };
                if (b.type === 'image') {
                    return {
                        type: 'image',
                        data: b.data,
                        mimeType: b.mimeType,
                        ...(b.uri ? { uri: b.uri } : {}),
                        ...(b.alt ? { alt: b.alt } : {}),
                    };
                }
                if (b.type === 'audio') {
                    return {
                        type: 'audio',
                        data: b.data,
                        mimeType: b.mimeType,
                        ...(b.uri ? { uri: b.uri } : {}),
                        ...(b.transcript ? { transcript: b.transcript } : {}),
                    };
                }
                if (b.type === 'video') {
                    return b.uri
                        ? {
                            type: 'resource_link',
                            uri: b.uri,
                            name: path.basename(b.uri),
                            mimeType: b.mimeType,
                            ...(b.transcript ? { description: b.transcript } : {}),
                        }
                        : { type: 'text', text: b.transcript || `[Video attachment: ${b.mimeType}]` };
                }
                if (b.type === 'resource_link') {
                    return {
                        type: 'resource_link',
                        uri: b.uri,
                        name: b.name,
                        ...(b.title ? { title: b.title } : {}),
                        ...(b.description ? { description: b.description } : {}),
                        ...(b.mimeType ? { mimeType: b.mimeType } : {}),
                        ...(typeof b.size === 'number' ? { size: b.size } : {}),
                        ...(b.annotations ? { annotations: b.annotations } : {}),
                    };
                }
                if (b.type === 'resource') return { type: 'resource', resource: b.resource };
                return { type: 'text', text: flattenContent([b]) };
            })
            : [{ type: 'text', text }];

 // Add user message locally (store as ContentBlock[])
        this.acpTurnSeq += 1;
        this.acpTurnStartedAt = Date.now();
        this.messages.push(this.withAcpSource(buildUserChatMessage({
            content: contentBlocks && contentBlocks.length > 0 ? contentBlocks : text,
            timestamp: Date.now(),
        }), this.nextMessageSourceId()));

        this.currentStatus = 'generating';
        this.partialContent = '';
        this.partialThoughtContent = '';
        this.partialBlocks = [];
        this.turnToolCalls = [];
        this.detectStatusTransition();
        this.log.info(`[${this.type}] Sending prompt: "${text.slice(0, 100)}" (${promptParts.length} parts)`);

        // Non-null by construction: beginSendPrompt() refuses the send unless both are
        // set, and it is the only way to claim the in-flight slot. Captured locally
        // because that guarantee lives in the helper, where TS cannot narrow from here.
        const connection = this.connection!;
        const sessionId = this.sessionId!;

        try {
            const result = await connection.prompt({
                sessionId,
                prompt: promptParts,
            });

 // Prompt complete → reflect final message
            if (result?.stopReason) {
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
        } finally {
            this._sendPromptInFlight = false;
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

    permissionResolvers: ((approved: boolean) => void)[] = [];

    // Provider-common manual-attendance signal: while a human is actively driving
    // this session from the dashboard, auto-approve holds so they can decide on
    // the permission request themselves. Background workers are never attended →
    // delegated auto-approve is unaffected.
    readonly manualAttendance = new ManualAttendanceTracker();

    /** @see ProviderInstance.noteManualInteraction */
    noteManualInteraction(now = Date.now()): void {
        this.manualAttendance.note(now);
    }

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
    handleSessionUpdate(params: SessionNotification): void { handleSessionUpdate(this, params); }
    private nextMessageSourceId(): string { return nextMessageSourceId(this); }
    private turnSourceId(slot: string): string { return turnSourceId(this, slot); }
    private withAcpSource<T extends object | null>(message: T, localId: string): T { return withAcpSource(this, message, localId); }
    private buildPartialBlocks(): ContentBlock[] { return buildPartialBlocks(this); }
    private buildPartialThoughtMessage(timestamp = Date.now()): AcpMessage | null { return buildPartialThoughtMessage(this, timestamp); }
    private finalizeAssistantMessage(): void { finalizeAssistantMessage(this); }

 // ─── status transition detect ────────────────────────────

    detectStatusTransition(): void {
        const now = Date.now();
        const newStatus = this.currentStatus;
        const dirName = workingDirBasename(this.workingDir);
        const chatTitle = `${this.provider.name} · ${dirName}`;
        const progressFingerprint = newStatus === 'generating'
            ? `${this.partialContent}::${JSON.stringify(this.partialBlocks)}::${JSON.stringify(this.activeToolCalls.map(t => ({ name: t.name, status: t.status })))}`.slice(-2000)
            : undefined;

        if (newStatus !== this.lastStatus) {
            if (this.lastStatus === 'idle' && newStatus === 'generating') {
                this.generatingStartedAt = now;
                this.pushEvent({ event: 'agent:generating_started', chatTitle, timestamp: now });
                if (this.turnEvidencePort) {
                    emitTurnStarted(this.turnEvidencePort, {
                        sessionId: this.instanceId, observedBy: 'acp_update', source: 'fsm_edge',
                        attemptRef: this.currentAttemptRef() ?? undefined, at: now, retro: false,
                    });
                }
            } else if (newStatus === 'waiting_approval') {
                if (!this.generatingStartedAt) this.generatingStartedAt = now;
                this.pushEvent({
                    event: 'agent:waiting_approval', chatTitle, timestamp: now,
                    modalMessage: this.activeToolCalls.find(t => t.status === 'running')?.name,
                });
                if (this.turnEvidencePort) {
                    emitSuspension(this.turnEvidencePort, {
                        sessionId: this.instanceId, observedBy: 'acp_update', source: 'fsm_edge',
                        attemptRef: this.currentAttemptRef() ?? undefined, at: now, modal: 'approval',
                    });
                }
            } else if (newStatus === 'idle' && (this.lastStatus === 'generating' || this.lastStatus === 'waiting_approval')) {
                // C-W5c: no legacy `agent:generating_completed` wire literal —
                // the port is the sole producer; `envelope.finalSummary` carries
                // the same text the deleted wire event used to carry.
                if (this.turnEvidencePort) {
                    const finalSummary = extractFinalSummaryFromMessages(this.messages);
                    emitTurnEnd(this.turnEvidencePort, {
                        sessionId: this.instanceId, observedBy: 'acp_update', source: 'fsm_edge',
                        attemptRef: this.currentAttemptRef() ?? undefined, at: now, strength: 'genuine',
                        ...(finalSummary ? { envelope: { finalSummary } } : {}),
                    });
                }
                this.generatingStartedAt = 0;
            } else if (newStatus === 'stopped') {
                // C-W5c: no legacy `agent:stopped` wire literal — a bare ACP
                // stop carries no text to attach.
                if (this.turnEvidencePort) {
                    emitProcessExit(this.turnEvidencePort, {
                        sessionId: this.instanceId, observedBy: 'acp_update', source: 'fsm_edge',
                        attemptRef: this.currentAttemptRef() ?? undefined, at: now, exitCode: null,
                    });
                }
            }
            const previousStatus = this.lastStatus;
            this.lastStatus = newStatus;
            // Lifecycle port (B2): the committed edge, after its provider events.
            emitStatusEdge(this.lifecyclePort, this.instanceId, previousStatus, newStatus, 'acp_update', this.type);
        }

 // Monitor check
        const agentKey = `${this.type}:acp`;
        const approvalPending = newStatus === 'waiting_approval';
        const monitorEvents = this.monitor.check(agentKey, newStatus, now, progressFingerprint, approvalPending);
        for (const me of monitorEvents) {
            this.pushEvent({ event: me.type, agentKey: me.agentKey, message: me.message, elapsedSec: me.elapsedSec, timestamp: me.timestamp });
        }
    }

    private pushEvent(event: ProviderEvent): void {
        // Lifecycle port (B2): the only delivery path since wiring-unification B5
        // — no buffer, no collectAllStates() drain.
        forwardProviderEvent(this.lifecyclePort, this.instanceId, {
            ...event,
            providerType: this.type,
            instanceId: this.instanceId,
            targetSessionId: this.instanceId,
            workspaceName: this.workingDir || undefined,
        });
    }

    /** Attach (or detach with null) the lifecycle port (wiring-unification B2). */
    setSessionEventPort(port: SessionEventPort | null): void {
        this.lifecyclePort = port;
    }

    /** Attach (or detach with null) the turn-evidence port (wiring-unification C5). */
    setTurnEvidencePort(port: TurnEvidencePort | null): void {
        this.turnEvidencePort = port;
    }

    /** Live attempt ref for this session, if a mesh assignment attached one. */
    private currentAttemptRef(): TurnAttemptRef | null {
        return currentMeshAttemptRef(this.settings);
    }

    /** The ledger's `release_attempt_ref` effect: stop naming `attemptId` in this session's evidence. */
    releaseAttemptRef(attemptId: string): boolean {
        if (!attemptId || this.settings?.meshActiveAttemptId !== attemptId) return false;
        const { meshActiveAttemptId, meshActiveAttemptGeneration, ...rest } = this.settings;
        void meshActiveAttemptId; void meshActiveAttemptGeneration;
        this.settings = rest;
        return true;
    }

    appendSystemMessage(content: string, timestamp = Date.now()): void {
        const normalizedContent = String(content || '').trim();
        if (!normalizedContent) return;
        this.messages.push(this.withAcpSource(buildRuntimeSystemChatMessage({
            content: normalizedContent,
            timestamp,
        }), this.nextMessageSourceId()));
        if (this.messages.length > 200) {
            this.messages = this.messages.slice(-100);
        }
    }

 // ─── external access ─────────────────────────────────

    get cliType(): string { return this.type; }
    get cliName(): string { return this.provider.name; }

 /** ACP Agent capabilities (available after initialize) */
    getCapabilities(): Record<string, any> { return this.agentCapabilities; }
}
