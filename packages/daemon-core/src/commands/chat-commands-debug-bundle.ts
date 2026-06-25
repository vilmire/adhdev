/**
 * Chat Commands — get_chat_debug_bundle: sanitize, summarize and store a
 * diagnostic snapshot of the current read_chat / provider / session state.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { CommandResult, CommandHelpers } from './handler.js';
import type { ProviderModule } from '../providers/contracts.js';
import { LOG, getRecentLogs } from '../logging/logger.js';
import { getRecentDebugTrace } from '../logging/debug-trace.js';
import {
    getCurrentManagerKey,
    getCurrentProviderType,
    getTargetTransport,
    getTargetedCliAdapter,
    getTargetInstance,
    isCliLikeTransport,
    parseMaybeJson,
} from './chat-commands-shared.js';
import { handleReadChat } from './chat-commands-read.js';

interface DebugSanitizeOptions {
    maxDepth?: number;
    maxArrayLength?: number;
    maxObjectKeys?: number;
    maxStringLength?: number;
}

const DEFAULT_DEBUG_SANITIZE_OPTIONS: Required<DebugSanitizeOptions> = {
    maxDepth: 8,
    maxArrayLength: 80,
    maxObjectKeys: 120,
    maxStringLength: 16_000,
};

const SECRET_KEY_PATTERN = /(?:token|secret|password|passwd|authorization|cookie|api[_-]?key|access[_-]?key|refresh[_-]?token|client[_-]?secret|private[_-]?key)/i;

function truncateDebugString(value: string, maxLength: number): string {
    if (value.length <= maxLength) return value;
    return `${value.slice(0, maxLength)}…[truncated ${value.length - maxLength} chars]`;
}

function redactDebugSecrets(value: string): string {
    return value
        .replace(/(Authorization\s*:\s*Bearer\s+)[^\s'"`]+/gi, '$1[REDACTED:bearer]')
        .replace(/(Bearer\s+)[A-Za-z0-9._~+\/-]{16,}=*/gi, '$1[REDACTED:bearer]')
        .replace(/\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{20,}\b/g, '[REDACTED:github-token]')
        .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, '[REDACTED:api-key]')
        .replace(/\bxox[baprs]-[A-Za-z0-9-]{12,}\b/g, '[REDACTED:slack-token]')
        .replace(/\b(?:adk|adm)_[A-Za-z0-9_-]{16,}\b/g, '[REDACTED:adhdev-token]')
        .replace(/((?:api[_-]?key|token|secret|password|passwd|client[_-]?secret)\s*[:=]\s*)[^\s,'"`}&]+/gi, '$1[REDACTED:secret]')
        .replace(/([?&](?:api[_-]?key|token|secret|password|client_secret)=)[^&#\s]+/gi, '$1[REDACTED:secret]');
}

export function sanitizeDebugBundleValue(
    value: unknown,
    options: DebugSanitizeOptions = {},
    depth = 0,
    keyHint = '',
): unknown {
    const normalizedOptions = { ...DEFAULT_DEBUG_SANITIZE_OPTIONS, ...options };
    if (value === null || value === undefined) return value;
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    if (typeof value === 'bigint') return String(value);
    if (typeof value === 'string') {
        if (SECRET_KEY_PATTERN.test(keyHint) && value.trim()) return '[REDACTED:secret-field]';
        return truncateDebugString(redactDebugSecrets(value), normalizedOptions.maxStringLength);
    }
    if (typeof value === 'function') return `[Function ${value.name || 'anonymous'}]`;
    if (typeof value !== 'object') return String(value);
    if (depth >= normalizedOptions.maxDepth) return '[MaxDepth]';

    if (Array.isArray(value)) {
        const items = value
            .slice(0, normalizedOptions.maxArrayLength)
            .map((item) => sanitizeDebugBundleValue(item, normalizedOptions, depth + 1, keyHint));
        if (value.length > normalizedOptions.maxArrayLength) {
            items.push(`[truncated ${value.length - normalizedOptions.maxArrayLength} items]`);
        }
        return items;
    }

    const record = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    const entries = Object.entries(record).slice(0, normalizedOptions.maxObjectKeys);
    for (const [key, item] of entries) {
        result[key] = sanitizeDebugBundleValue(item, normalizedOptions, depth + 1, key);
    }
    const remaining = Object.keys(record).length - entries.length;
    if (remaining > 0) result.__truncatedKeys = remaining;
    return result;
}

function summarizeProviderForDebug(provider: ProviderModule | undefined): Record<string, unknown> | null {
    if (!provider) return null;
    const scripts = provider.scripts && typeof provider.scripts === 'object'
        ? Object.keys(provider.scripts)
        : [];
    const controls = Array.isArray((provider as any).controls)
        ? (provider as any).controls.map((control: any) => ({
            id: control?.id,
            label: control?.label,
            type: control?.type,
            settingKey: control?.settingKey,
            invokeScript: control?.invokeScript,
            listScript: control?.listScript,
            location: control?.location,
        }))
        : [];
    return {
        type: provider.type,
        name: provider.name,
        category: provider.category,
        version: (provider as any).version,
        canonicalHistory: provider.nativeHistory,
        historyBehavior: provider.historyBehavior,
        webviewMatchText: provider.webviewMatchText,
        scriptNames: scripts,
        controls,
        resume: provider.resume,
    };
}

function summarizeSessionForDebug(session: any): Record<string, unknown> | null {
    if (!session || typeof session !== 'object') return null;
    return {
        sessionId: session.sessionId,
        instanceKey: session.instanceKey,
        adapterKey: session.adapterKey,
        providerType: session.providerType,
        providerName: session.providerName,
        transport: session.transport,
        kind: session.kind,
        cdpManagerKey: session.cdpManagerKey,
        parentSessionId: session.parentSessionId,
        providerSessionId: session.providerSessionId,
        workspace: session.workspace,
        title: session.title,
        status: session.status,
        mode: session.mode,
        capabilities: session.capabilities,
    };
}

function summarizeStateForDebug(state: any): Record<string, unknown> | null {
    if (!state || typeof state !== 'object') return null;
    const activeChat = state.activeChat && typeof state.activeChat === 'object' ? state.activeChat : null;
    return {
        type: state.type,
        name: state.name,
        category: state.category,
        status: state.status,
        instanceId: state.instanceId,
        providerSessionId: state.providerSessionId,
        title: state.title,
        transport: state.transport,
        mode: state.mode,
        workspace: state.workspace,
        runtime: state.runtime,
        errorMessage: state.errorMessage,
        errorReason: state.errorReason,
        activeChat: activeChat ? {
            status: activeChat.status,
            title: activeChat.title,
            messageCount: Array.isArray(activeChat.messages) ? activeChat.messages.length : undefined,
            activeModal: activeChat.activeModal,
            activeInteractivePrompt: activeChat.activeInteractivePrompt ?? null,
            messagesTail: Array.isArray(activeChat.messages) ? activeChat.messages.slice(-10) : undefined,
        } : null,
        activeInteractivePrompt: (state as { activeInteractivePrompt?: unknown }).activeInteractivePrompt ?? null,
        controlValues: state.controlValues,
        summaryMetadata: state.summaryMetadata,
    };
}

function buildDebugBundleText(bundle: Record<string, unknown>): string {
    return [
        '# ADHDev Chat Debug Bundle',
        '',
        '```json',
        JSON.stringify(bundle, null, 2),
        '```',
    ].join('\n');
}

function getChatDebugBundleDir(): string {
    const override = typeof process.env.ADHDEV_DEBUG_BUNDLE_DIR === 'string'
        ? process.env.ADHDEV_DEBUG_BUNDLE_DIR.trim()
        : '';
    return override || path.join(os.homedir(), '.adhdev', 'debug-bundles', 'chat');
}

function safeBundleIdSegment(value: unknown, fallback: string): string {
    const normalized = String(value || fallback)
        .trim()
        .replace(/[^A-Za-z0-9_.-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80);
    return normalized || fallback;
}

function createChatDebugBundleId(targetSessionId: string): string {
    const timestamp = new Date().toISOString().replace(/[-:.]/g, '').replace('T', 'T').replace('Z', 'Z');
    const sessionSegment = safeBundleIdSegment(targetSessionId, 'unknown-session');
    return `chat-debug-${timestamp}-${sessionSegment}-${randomUUID().slice(0, 8)}`;
}

function buildChatDebugBundleSummary(bundle: Record<string, unknown>): Record<string, unknown> {
    const target = bundle.target && typeof bundle.target === 'object' ? bundle.target as Record<string, unknown> : {};
    const readChat = bundle.readChat && typeof bundle.readChat === 'object' ? bundle.readChat as Record<string, unknown> : {};
    const cli = bundle.cli && typeof bundle.cli === 'object' ? bundle.cli as Record<string, unknown> : null;
    const frontend = bundle.frontend && typeof bundle.frontend === 'object' ? bundle.frontend as Record<string, unknown> : null;
    const debugReadChat = readChat.debugReadChat && typeof readChat.debugReadChat === 'object'
        ? readChat.debugReadChat as Record<string, unknown>
        : {};
    const parsedStatus = cli?.parsedStatus && typeof cli.parsedStatus === 'object'
        ? cli.parsedStatus as Record<string, unknown>
        : null;
    const cliParsedMessageCount = Array.isArray(parsedStatus?.messages) ? parsedStatus.messages.length : undefined;
    const readChatReturnedMessages = Array.isArray(readChat.messagesTail) ? readChat.messagesTail.length : undefined;
    const cliPartialResponse = typeof cli?.partialResponse === 'string' ? cli.partialResponse : '';
    const readChatStatus = typeof readChat.status === 'string' ? readChat.status : '';
    const cliStatus = typeof cli?.status === 'string' ? cli.status : '';
    const cliParsedStatus = typeof parsedStatus?.status === 'string' ? parsedStatus.status : '';
    return {
        createdAt: bundle.createdAt,
        targetSessionId: target.targetSessionId,
        providerType: target.providerType,
        transport: target.transport,
        readChatSuccess: readChat.success,
        readChatStatus: readChat.status,
        readChatTotalMessages: readChat.totalMessages,
        readChatReturnedMessages,
        cliStatus: cli?.status,
        cliParsedStatus: cliParsedStatus || undefined,
        cliMessageCount: cli?.messageCount,
        cliParsedMessageCount,
        cliPartialResponseChars: cliPartialResponse.length,
        parserAdapterStatusMismatch: Boolean(cliStatus && cliParsedStatus && cliStatus !== cliParsedStatus),
        parserReadChatStatusMismatch: Boolean(readChatStatus && cliParsedStatus && readChatStatus !== cliParsedStatus),
        readChatDebug: Object.keys(debugReadChat).length ? {
            adapterStatus: debugReadChat.adapterStatus,
            parsedStatus: debugReadChat.parsedStatus,
            returnedStatus: debugReadChat.returnedStatus,
            selectedMessageSource: debugReadChat.selectedMessageSource,
            messageSource: debugReadChat.messageSource,
            parsedMsgCount: debugReadChat.parsedMsgCount,
            returnedMsgCount: debugReadChat.returnedMsgCount,
            shouldPreferAdapterMessages: debugReadChat.shouldPreferAdapterMessages,
        } : undefined,
        hasFrontendSnapshot: !!frontend,
    };
}

function storeChatDebugBundleOnDaemon(bundle: Record<string, unknown>, targetSessionId: string): { bundleId: string; savedPath: string; sizeBytes: number } {
    const bundleId = createChatDebugBundleId(targetSessionId);
    const dir = getChatDebugBundleDir();
    fs.mkdirSync(dir, { recursive: true });
    const savedPath = path.join(dir, `${bundleId}.json`);
    const json = `${JSON.stringify(bundle, null, 2)}\n`;
    fs.writeFileSync(savedPath, json, { encoding: 'utf8', mode: 0o600 });
    return { bundleId, savedPath, sizeBytes: Buffer.byteLength(json, 'utf8') };
}

function isDaemonFileDebugDelivery(args: any): boolean {
    return args?.delivery === 'daemon_file' || args?.delivery === 'file';
}

export async function handleGetChatDebugBundle(h: CommandHelpers, args: any): Promise<CommandResult> {
    const targetSessionId = typeof args?.targetSessionId === 'string' ? args.targetSessionId.trim() : '';
    if (!targetSessionId && !h.currentSession) {
        return { success: false, error: 'No targetSessionId specified — cannot route command' };
    }

    const provider = h.getProvider(args?.agentType);
    const transport = getTargetTransport(h, provider);
    const providerType = provider?.type || getCurrentProviderType(h, args?.agentType || '');
    const adapter = isCliLikeTransport(transport) ? getTargetedCliAdapter(h, args, provider?.type) : null;
    const targetInstance = getTargetInstance(h, args);

    let adapterStatus: unknown = null;
    let parsedStatus: unknown = null;
    let adapterDebugSnapshot: unknown = null;
    let partialResponse = '';
    if (adapter) {
        try { adapterStatus = adapter.getStatus?.(); } catch (error: any) { adapterStatus = { error: error?.message || String(error) }; }
        try { parsedStatus = typeof adapter.getScriptParsedStatus === 'function' ? parseMaybeJson(adapter.getScriptParsedStatus()) : null; } catch (error: any) { parsedStatus = { error: error?.message || String(error) }; }
        try { adapterDebugSnapshot = typeof adapter.getDebugSnapshot === 'function' ? adapter.getDebugSnapshot() : null; } catch (error: any) { adapterDebugSnapshot = { error: error?.message || String(error) }; }
        try { partialResponse = adapter.getPartialResponse?.() || ''; } catch { partialResponse = ''; }
    }

    let instanceState: unknown = null;
    if (targetInstance?.getState) {
        try { instanceState = summarizeStateForDebug(targetInstance.getState()); } catch (error: any) { instanceState = { error: error?.message || String(error) }; }
    }

    let readChat: unknown = null;
    try {
        const readResult = await handleReadChat(h, { ...args, tailLimit: Math.max(1, Math.min(40, Number(args?.tailLimit || 40))) });
        readChat = readResult.success
            ? {
                success: true,
                status: readResult.status,
                title: readResult.title,
                totalMessages: readResult.totalMessages,
                providerSessionId: readResult.providerSessionId,
                transcriptAuthority: readResult.transcriptAuthority,
                coverage: readResult.coverage,
                messageSource: readResult.messageSource,
                transcriptProvenance: readResult.transcriptProvenance,
                activeModal: readResult.activeModal,
                messagesTail: Array.isArray(readResult.messages) ? readResult.messages.slice(-20) : [],
                debugReadChat: readResult.debugReadChat,
            }
            : {
                success: false,
                error: readResult.error,
                code: readResult.code,
                messageSource: readResult.messageSource,
                transcriptProvenance: readResult.transcriptProvenance,
                debugReadChat: readResult.debugReadChat,
            };
    } catch (error: any) {
        readChat = { success: false, error: error?.message || String(error) };
    }

    const cdp = h.getCdp();
    const rawBundle: Record<string, unknown> = {
        version: 1,
        createdAt: new Date().toISOString(),
        target: {
            targetSessionId,
            providerType,
            transport,
            routeManagerKey: h.currentManagerKey,
            currentIdeType: h.currentIdeType,
        },
        session: summarizeSessionForDebug(h.currentSession),
        provider: summarizeProviderForDebug(provider),
        daemon: {
            pid: process.pid,
            platform: process.platform,
            nodeVersion: process.version,
            cwd: process.cwd(),
        },
        cdp: {
            requested: !!cdp,
            connected: !!cdp?.isConnected,
            managerKey: getCurrentManagerKey(h),
        },
        instanceState,
        cli: adapter ? {
            cliType: adapter.cliType,
            cliName: adapter.cliName,
            workingDir: adapter.workingDir,
            status: (adapterStatus as any)?.status,
            activeModal: (adapterStatus as any)?.activeModal,
            messageCount: Array.isArray((adapterStatus as any)?.messages) ? (adapterStatus as any).messages.length : undefined,
            messagesTail: Array.isArray((adapterStatus as any)?.messages) ? (adapterStatus as any).messages.slice(-20) : undefined,
            parsedStatus,
            partialResponse,
            ready: typeof adapter.isReady === 'function' ? adapter.isReady() : undefined,
            processing: typeof adapter.isProcessing === 'function' ? adapter.isProcessing() : undefined,
            debugSnapshot: adapterDebugSnapshot,
            scriptInvocationTrace: typeof (adapter as any).getScriptInvocationTrace === 'function'
                ? (adapter as any).getScriptInvocationTrace()
                : undefined,
        } : null,
        readChat,
        frontend: args?.frontendSnapshot && typeof args.frontendSnapshot === 'object' ? args.frontendSnapshot : null,
        recentLogs: getRecentLogs(80, 'debug'),
        recentDebugTrace: getRecentDebugTrace({ limit: 120 }),
    };

    const bundle = sanitizeDebugBundleValue(rawBundle) as Record<string, unknown>;
    if (isDaemonFileDebugDelivery(args)) {
        const summary = buildChatDebugBundleSummary(bundle);
        const stored = storeChatDebugBundleOnDaemon(bundle, targetSessionId || String(summary.targetSessionId || 'unknown-session'));
        LOG.info('Command', `[get_chat_debug_bundle] saved daemon_file bundle id=${stored.bundleId} path=${stored.savedPath} sizeBytes=${stored.sizeBytes} targetSessionId=${summary.targetSessionId || ''} providerType=${summary.providerType || ''} transport=${summary.transport || ''}`);
        return {
            success: true,
            delivery: 'daemon_file',
            bundleId: stored.bundleId,
            savedPath: stored.savedPath,
            sizeBytes: stored.sizeBytes,
            createdAt: bundle.createdAt,
            summary,
        };
    }
    return {
        success: true,
        bundle,
        text: buildDebugBundleText(bundle),
    };
}
