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
