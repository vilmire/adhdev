/**
 * ACP `session/update` ingestion for AcpProviderInstance: streamed agent message /
 * thought chunks, tool-call lifecycle updates, plan and mode updates (and the legacy
 * update shapes), folded into the instance's partial turn and finalized into chat
 * bubbles with stable ACP source addresses. Functions over the instance (`host`);
 * the class keeps delegators for the entry points.
 */
import { type SessionNotification, type ToolCallStatus } from '@agentclientprotocol/sdk';
import type {
    ContentBlock,
    ToolCallInfo,
    ToolCallContent as TCC,
    ToolKind,
    ToolCallStatus as TCS,
} from './contracts.js';
import { flattenContent } from './contracts.js';
import {
    buildAssistantChatMessage,
    buildChatMessage,
    buildTerminalChatMessage,
    buildThoughtChatMessage,
    buildToolChatMessage,
} from './chat-message-normalization.js';
import { acpSourceAddress } from '../chat/message-source-address.js';
import type { AcpMessage, AcpProviderInstance } from './acp-provider-instance.js';

/** The AcpProviderInstance members these functions read or call (compiler-checked; no cast). */
export type AcpSessionUpdateHost = Pick<AcpProviderInstance, 'acpMessageSeq' | 'acpTurnSeq' | 'activeToolCalls' | 'currentStatus' | 'detectStatusTransition' | 'log' | 'messages' | 'parseConfigOptions' | 'partialBlocks' | 'partialContent' | 'partialThoughtContent' | 'setCurrentSelection' | 'turnToolCalls' | 'type'>;

 // ─── ACP session/update handle ─────────────────────
export function handleSessionUpdate(host: AcpSessionUpdateHost, params: SessionNotification): void {
    if (!params) return;

    const update = params.update;
    host.log.debug(`[${host.type}] sessionUpdate: ${update.sessionUpdate}`);

    switch (update.sessionUpdate) {
        case 'agent_message_chunk': {
            const content: any = update.content;
            if (content.type === 'text') {
                host.partialContent += content.text;
            } else if (content.type === 'image') {
                host.partialBlocks.push({
                    type: 'image',
                    data: content.data,
                    mimeType: content.mimeType,
                    ...(content.uri ? { uri: content.uri } : {}),
                });
            } else if (content.type === 'audio') {
                host.partialBlocks.push({
                    type: 'audio',
                    data: content.data,
                    mimeType: content.mimeType,
                    ...(content.uri ? { uri: content.uri } : {}),
                    ...(content.transcript ? { transcript: content.transcript } : {}),
                });
            } else if (content.type === 'video') {
                host.partialBlocks.push({
                    type: 'video',
                    data: content.data,
                    mimeType: content.mimeType,
                    ...(content.uri ? { uri: content.uri } : {}),
                    ...(content.transcript ? { transcript: content.transcript } : {}),
                    ...(content.posterUri ? { posterUri: content.posterUri } : {}),
                });
            } else if (content.type === 'resource_link') {
                host.partialBlocks.push({
                    type: 'resource_link',
                    uri: content.uri,
                    name: content.name || 'resource',
                    title: content.title ?? undefined,
                    mimeType: content.mimeType ?? undefined,
                });
            } else if (content.type === 'resource') {
                host.partialBlocks.push({
                    type: 'resource',
                    resource: content.resource,
                });
            }
            host.currentStatus = 'generating';
            break;
        }
        case 'agent_thought_chunk': {
            const content = update.content;
            if (content?.type === 'text' && typeof content.text === 'string') {
                host.partialThoughtContent += content.text;
            }
            host.currentStatus = 'generating';
            break;
        }
        case 'user_message_chunk': {
            break;
        }
        case 'tool_call': {
 // New tool call — ACP SDK ToolCall has all fields typed
            const tcId = update.toolCallId || `tc_${Date.now()}`;
            const tcTitle = update.title || 'unknown';
            const tcKind = update.kind as ToolKind | undefined;
            const tcStatus = mapToolCallStatus(host, update.status);
            
            host.activeToolCalls.push({
                id: tcId,
                name: tcTitle,
                status: tcStatus,
                input: update.rawInput ? (typeof update.rawInput === 'string' ? update.rawInput : JSON.stringify(update.rawInput)) : undefined,
            });
            
            // Also collect as ToolCallInfo for rich content
            const acpStatus = update.status || 'in_progress';
            host.turnToolCalls.push({
                toolCallId: tcId,
                title: tcTitle,
                kind: tcKind,
                status: acpStatus as TCS,
                rawInput: update.rawInput,
                content: convertToolCallContent(host, update.content),
                locations: update.locations,
            });
            break;
        }
        case 'tool_call_update': {
 // Update existing tool call — ACP SDK ToolCallUpdate typed
            const toolCallId = update.toolCallId;
            const existing = host.activeToolCalls.find(t => t.id === toolCallId);
            if (existing) {
                if (update.status) existing.status = mapToolCallStatus(host, update.status);
                if (update.rawOutput) existing.output = typeof update.rawOutput === 'string' ? update.rawOutput : JSON.stringify(update.rawOutput);
            }
            // Update ToolCallInfo too
            const tcInfo = host.turnToolCalls.find(t => t.toolCallId === toolCallId);
            if (tcInfo) {
                if (update.status) tcInfo.status = update.status as TCS;
                if (update.rawOutput) tcInfo.rawOutput = update.rawOutput;
                if (update.content) tcInfo.content = convertToolCallContent(host, update.content);
                if (update.locations) tcInfo.locations = update.locations;
            }
            break;
        }
        case 'current_mode_update': {
            host.setCurrentSelection('mode', update.currentModeId);
            break;
        }
        case 'config_option_update': {
            if (update.configOptions) {
                host.parseConfigOptions(update.configOptions);
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
            handleLegacyUpdate(host, update);
            break;
    }
}

 /** Handle legacy session/update formats (pre-standardization compat) */
export function handleLegacyUpdate(host: AcpSessionUpdateHost, params: any): void {
 // Legacy: messageDelta format
    if (params.messageDelta) {
        const delta = params.messageDelta;
        if (delta.content) {
            for (const part of Array.isArray(delta.content) ? delta.content : [delta.content]) {
                if (part.type === 'text' && part.text) {
                    host.partialContent += part.text;
                }
            }
        }
        host.currentStatus = 'generating';
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
            host.messages.push(withAcpSource(host, buildChatMessage({
                role: m.role || 'assistant',
                content: content.trim(),
                timestamp: Date.now(),
            }), nextMessageSourceId(host)));
            host.partialContent = '';
        }
    }

 // Legacy: toolCallUpdate
    if (params.toolCallUpdate) {
        const tc = params.toolCallUpdate;
        const existing = host.activeToolCalls.find(t => t.id === tc.id);
        if (existing) {
            if (tc.status) existing.status = tc.status;
            if (tc.output) existing.output = tc.output;
        } else {
            host.activeToolCalls.push({
                id: tc.id || `tc_${Date.now()}`,
                name: tc.name || 'unknown',
                status: tc.status || 'running',
                input: typeof tc.input === 'string' ? tc.input : JSON.stringify(tc.input),
            });
        }
    }

 // Legacy: stopReason
    if (params.stopReason) {
        if (params.stopReason !== 'cancelled') {
            host.currentStatus = 'idle';
        }
        host.activeToolCalls = [];
        host.detectStatusTransition();
    }

 // Legacy: model info
    if (params.model) {
        host.setCurrentSelection('model', params.model);
    }
}

 /** Map SDK ToolCallStatus to internal status */
export function mapToolCallStatus(host: AcpSessionUpdateHost, status?: ToolCallStatus | string): 'running' | 'completed' | 'failed' {
    switch (status) {
        case 'completed': return 'completed';
        case 'failed': return 'failed';
        case 'pending':
        case 'in_progress':
        default: return 'running';
    }
}

 // ─── Rich Content Helpers ────────────────────────────
export function nextMessageSourceId(host: AcpSessionUpdateHost): string {
    host.acpMessageSeq += 1;
    return `m${host.acpMessageSeq}`;
}

export function turnSourceId(host: AcpSessionUpdateHost, slot: string): string {
    return `t${host.acpTurnSeq}.${slot}`;
}

/** Stamp the identity ledger's `acp` source address (daemon-internal `_src`). */
export function withAcpSource<T extends object | null>(host: AcpSessionUpdateHost, message: T, localId: string): T {
    if (!message) return message;
    const src = acpSourceAddress(localId);
    return src ? { ...message, _src: src } : message;
}

/** Build ContentBlock[] from current partial state */
export function buildPartialBlocks(host: AcpSessionUpdateHost): ContentBlock[] {
    const blocks: ContentBlock[] = [];
    if (host.partialContent.trim()) {
        blocks.push({ type: 'text', text: host.partialContent.trim() + '...' });
    }
    blocks.push(...host.partialBlocks);
    return blocks;
}

export function buildPartialThoughtMessage(host: AcpSessionUpdateHost, timestamp = Date.now()): AcpMessage | null {
    const content = host.partialThoughtContent.trim();
    if (!content) return null;
    return buildThoughtChatMessage({
        content,
        timestamp,
        meta: {
            label: 'Thought',
            isRunning: host.currentStatus === 'generating',
        },
    });
}

export function buildToolCallBubbleKind(host: AcpSessionUpdateHost, toolCall: ToolCallInfo): 'thought' | 'tool' | 'terminal' {
    if (toolCall.kind === 'think') return 'thought';
    if (toolCall.kind === 'execute') return 'terminal';
    if (Array.isArray(toolCall.content) && toolCall.content.some((entry) => entry?.type === 'terminal')) return 'terminal';
    return 'tool';
}

export function summarizeToolCallBubbleContent(host: AcpSessionUpdateHost, toolCall: ToolCallInfo): string {
    const rawOutput = typeof toolCall.rawOutput === 'string'
        ? toolCall.rawOutput.trim()
        : (toolCall.rawOutput != null ? JSON.stringify(toolCall.rawOutput) : '');
    if (rawOutput) return rawOutput;

    const contentText = Array.isArray(toolCall.content)
        ? toolCall.content
            .map((entry) => {
                if (!entry || typeof entry !== 'object') return '';
                if (entry.type === 'content') return flattenContent([entry.content]).trim();
                if (entry.type === 'diff') return `${entry.path}\n${entry.newText || ''}`.trim();
                if (entry.type === 'terminal') return `Terminal: ${entry.terminalId || ''}`.trim();
                return '';
            })
            .filter(Boolean)
            .join('\n\n')
            .trim()
        : '';
    if (contentText) return contentText;

    const rawInput = typeof toolCall.rawInput === 'string'
        ? toolCall.rawInput.trim()
        : (toolCall.rawInput != null ? JSON.stringify(toolCall.rawInput) : '');
    if (rawInput) {
        return toolCall.title ? `${toolCall.title}\n${rawInput}` : rawInput;
    }

    return toolCall.title || '';
}

export function buildTurnToolCallMessages(host: AcpSessionUpdateHost, timestamp = Date.now()): AcpMessage[] {
    return host.turnToolCalls
        .map((toolCall, index) => withAcpSource(host, buildTurnToolCallMessage(host, toolCall, timestamp), turnSourceId(host, `tool.${toolCall.toolCallId || index}`)))
        .filter(Boolean) as AcpMessage[];
}

export function buildTurnToolCallMessage(host: AcpSessionUpdateHost, toolCall: ToolCallInfo, timestamp: number): AcpMessage | null {
    const content = summarizeToolCallBubbleContent(host, toolCall);
    if (!content) return null;
    const isRunning = toolCall.status === 'pending' || toolCall.status === 'in_progress';
    const label = toolCall.title || undefined;
    const kind = buildToolCallBubbleKind(host, toolCall);
    if (kind === 'thought') {
        return buildThoughtChatMessage({
            content,
            timestamp,
            meta: { label: label || 'Thought', isRunning },
        });
    }
    if (kind === 'terminal') {
        return buildTerminalChatMessage({
            content,
            timestamp,
            meta: { label: label || 'Ran command', isRunning },
        });
    }
    return buildToolChatMessage({
        content,
        timestamp,
        meta: { label: label || 'Tool call', isRunning },
    });
}

/** Finalize streaming content into an assistant message */
export function finalizeAssistantMessage(host: AcpSessionUpdateHost): void {
    const timestamp = Date.now();
    const thoughtMessage = buildPartialThoughtMessage(host, timestamp);
    if (thoughtMessage) {
        host.messages.push(withAcpSource(host, thoughtMessage, turnSourceId(host, 'thought')));
    }

    const toolCallMessages = buildTurnToolCallMessages(host, timestamp);
    if (toolCallMessages.length > 0) {
        host.messages.push(...toolCallMessages);
    }

    const blocks = buildPartialBlocks(host);
    // Remove trailing '...' from text blocks for final message
    const finalBlocks = blocks.map(b => {
        if (b.type === 'text' && b.text.endsWith('...')) {
            return { ...b, text: b.text.slice(0, -3) };
        }
        return b;
    }).filter(b => b.type !== 'text' || (b.type === 'text' && b.text.trim()));

    if (finalBlocks.length > 0) {
        host.messages.push(withAcpSource(host, buildAssistantChatMessage({
            content: finalBlocks.length === 1 && finalBlocks[0].type === 'text'
                ? (finalBlocks[0] as {type: 'text', text: string}).text   // single text → string (backward compat)
                : finalBlocks,
            timestamp: Date.now(),
            toolCalls: host.turnToolCalls.length > 0 ? [...host.turnToolCalls] : undefined,
        }), turnSourceId(host, 'answer')));
    }
    host.partialContent = '';
    host.partialThoughtContent = '';
    host.partialBlocks = [];
    host.turnToolCalls = [];
}

/** Convert ACP ToolCallContent[] to our ToolCallContent[] */
export function convertToolCallContent(host: AcpSessionUpdateHost, acpContent?: any[]): TCC[] | undefined {
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
