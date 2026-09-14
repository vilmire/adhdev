/**
 * Runtime-authored chat messages (verbatim move out of CliProviderInstance —
 * M-FILE-SIZE-DEBT decomposition).
 *
 * "Runtime messages" are the daemon's OWN system bubbles — session-host restart
 * / resume-failure notices and the like — as opposed to bubbles parsed off the
 * provider's PTY or read from its native transcript. This module owns their
 * append path: normalization, the per-key dedup that keeps a repeated status
 * poll from re-appending the same notice, the ChatHistoryWriter persist, and
 * the merge back into the parsed transcript for display.
 *
 * State lives ON THE HOST (the provider instance) exactly as before, so suites
 * that seed/inspect runtimeMessages directly are unchanged.
 */

import type { ChatMessage } from '../types.js';
import { flattenContent } from './contracts.js';
import { buildChatMessage, buildRuntimeSystemChatMessage } from './chat-message-normalization.js';
import { ChatHistoryWriter } from '../config/chat-history.js';
import { workingDirBasename } from './working-dir.js';
import { mergeConversationMessages } from './cli-provider-transcript-merge.js';
import { ParsedIngestTimestampStamper } from './cli-provider-ingest-times.js';
import type { PtyRuntimeMetadata } from '../cli-adapters/pty-transport.js';
import type { InputEnvelope } from './contracts.js';
import { buildCliStructuredInputPrompt } from './cli-provider-input-prompt.js';
import { shortHash } from '../system/hash.js';
import { USER_INPUT_ACK_DEDUP_WINDOW_MS } from './cli-provider-instance-types.js';

/** The narrow surface of CliProviderInstance this cluster reads/writes. */
export interface RuntimeMessagesHost {
    type: string;
    workingDir: string;
    instanceId: string;
    providerSessionId?: string;
    historyWriter: ChatHistoryWriter;
    adapter: { getScriptParsedStatus?: () => { title?: string } | null | undefined };
    runtimeMessages: Array<{ key: string; message: ChatMessage }>;
    parsedIngestTimestamps: ParsedIngestTimestampStamper;
    /** TASKBUBBLE-DUP dedup ledger for user-input acks — see recordAcknowledgedUserInput. */
    recentUserInputAcks: Map<string, number>;
    lastAcknowledgedUserInputAt: number;
}

export function maybeAppendRuntimeRecoveryMessage(
    host: RuntimeMessagesHost,
    runtime: PtyRuntimeMetadata | null,
): void {
    if (!runtime?.restoredFromStorage || !runtime.runtimeId) return;

    const recoveryState = String(runtime.recoveryState || '').trim();
    if (!recoveryState) return;

    let content = '';
    if (recoveryState === 'auto_resumed') {
        content = 'Session host restored this CLI after restart and reattached it from a saved snapshot.';
    } else if (recoveryState === 'resume_failed') {
        const errorSuffix = runtime.recoveryError ? ` Resume failed: ${runtime.recoveryError}` : '';
        content = `Session host found this CLI after restart, but automatic resume failed.${errorSuffix}`;
    } else if (recoveryState === 'host_restart_interrupted') {
        content = 'Session host found this CLI in interrupted state after restart and is attempting to resume it.';
    } else if (recoveryState === 'orphan_snapshot') {
        content = 'Session host restored the last snapshot for this CLI, but the original runtime was not resumed automatically.';
    } else {
        content = `Session host restored this CLI after restart (${recoveryState}).`;
    }

    appendRuntimeSystemMessage(
        host,
        content,
        `runtime_recovery:${runtime.runtimeId}:${recoveryState}`,
    );
}

export function appendRuntimeSystemMessage(
    host: RuntimeMessagesHost,
    content: string,
    dedupKey: string,
    receivedAt = Date.now(),
): void {
    appendRuntimeMessage(host, buildRuntimeSystemChatMessage({
        content,
        receivedAt,
        timestamp: receivedAt,
    }), dedupKey);
}

export function appendRuntimeMessage(
    host: RuntimeMessagesHost,
    message: ChatMessage,
    dedupKey: string,
): void {
    const normalizedMessage = buildChatMessage({
        ...message,
        receivedAt: typeof message.receivedAt === 'number' ? message.receivedAt : (message.timestamp || Date.now()),
        timestamp: typeof message.timestamp === 'number' ? message.timestamp : (message.receivedAt || Date.now()),
    } as ChatMessage);
    const normalizedContent = typeof normalizedMessage.content === 'string'
        ? normalizedMessage.content.trim()
        : flattenContent(normalizedMessage.content).trim();
    if (!normalizedContent && (!Array.isArray(normalizedMessage.content) || normalizedMessage.content.length === 0)) return;
    if (host.runtimeMessages.some((entry) => entry.key === dedupKey)) return;

    host.runtimeMessages.push({
        key: dedupKey,
        message: normalizedMessage,
    });

    if (normalizedContent) {
        host.historyWriter.appendNewMessages(
            host.type,
            [{
                role: normalizedMessage.role,
                senderName: normalizedMessage.senderName,
                kind: normalizedMessage.kind,
                content: normalizedContent,
                receivedAt: normalizedMessage.receivedAt || normalizedMessage.timestamp,
                historyDedupKey: dedupKey,
            }],
            host.adapter.getScriptParsedStatus?.()?.title || workingDirBasename(host.workingDir),
            host.instanceId,
            host.providerSessionId,
        );
    }
}

export function mergeRuntimeChatMessages(
    host: RuntimeMessagesHost,
    parsedMessages: ChatMessage[],
): ChatMessage[] {
    return mergeConversationMessages(host.runtimeMessages, host.parsedIngestTimestamps.stamp(parsedMessages));
}

/**
 * TASKBUBBLE-DUP: record the user-input ack bubble for a dispatched message,
 * collapsing a redelivered dispatch to a single bubble.
 *
 * Pure move out of cli-provider-instance.ts (file-size gate decomposition,
 * mission B1). Byte-identical logic; the dedup ledger and the
 * lastAcknowledgedUserInputAt stamp stay HOST-owned exactly as before, so
 * suites that seed or inspect them directly are unchanged.
 */
export function recordAcknowledgedUserInput(
    host: RuntimeMessagesHost,
    input: InputEnvelope | string,
): void {
    const content = typeof input === 'string'
        ? input.trim()
        : buildCliStructuredInputPrompt(input).trim();
    if (!content) return;

    const receivedAt = Date.now();

    // TASKBUBBLE-DUP: collapse a redelivered dispatch to one bubble. A single
    // mesh_send_task can reach this instance as TWO send_chat calls when the
    // first injection is buffered during bootstrap/busy and a retry (dispatch-
    // confirm-timeout requeue, or a reconcile re-dispatch) fires before the
    // outbound queue drains. The previous dedupKey hashed receivedAt, so the
    // two acks produced different keys and BOTH bubbled. Suppress an identical
    // content ack seen within USER_INPUT_ACK_DEDUP_WINDOW_MS; a later resend of
    // the same text (beyond the window) is a genuine new turn and still shows.
    const ackContentKey = shortHash(`${host.instanceId}:${content}`, 24);
    const lastAckAt = host.recentUserInputAcks.get(ackContentKey);
    if (lastAckAt !== undefined && receivedAt - lastAckAt <= USER_INPUT_ACK_DEDUP_WINDOW_MS) {
        // Refresh the timestamp so a steady stream of redeliveries keeps
        // collapsing, and prune stale entries to bound the map size.
        host.recentUserInputAcks.set(ackContentKey, receivedAt);
        pruneRecentUserInputAcks(host, receivedAt);
        return;
    }
    host.recentUserInputAcks.set(ackContentKey, receivedAt);
    pruneRecentUserInputAcks(host, receivedAt);

    host.lastAcknowledgedUserInputAt = receivedAt;
    // The runtimeMessages dedupKey stays per-call unique (includes receivedAt)
    // so a genuine resend of the same text after the window appends a fresh
    // bubble; redelivery within the window is already suppressed above.
    const dedupKey = `user_input_ack:${shortHash(`${host.instanceId}:${content}:${receivedAt}`, 24)}`;
    appendRuntimeMessage(host, buildChatMessage({
        role: 'user',
        senderName: 'User',
        kind: 'standard',
        content,
        receivedAt,
        timestamp: receivedAt,
        source: 'runtime_input_ack',
        meta: {
            runtimeInputAck: true,
            provider: host.type,
            workspace: host.workingDir,
        },
    } as ChatMessage), dedupKey);
}

/** Drop user-input ack entries older than the dedup window so the map can't grow unbounded. */
export function pruneRecentUserInputAcks(host: RuntimeMessagesHost, now: number): void {
    if (host.recentUserInputAcks.size <= 1) return;
    for (const [key, at] of host.recentUserInputAcks) {
        if (now - at > USER_INPUT_ACK_DEDUP_WINDOW_MS) host.recentUserInputAcks.delete(key);
    }
}
