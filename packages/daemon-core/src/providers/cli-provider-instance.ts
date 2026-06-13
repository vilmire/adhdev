/**
 * CliProviderInstance — Runtime instance for CLI Provider
 *
 * Lifecycle layer on top of ProviderCliAdapter.
 * collectCliData() + status transition logic from daemon-status.ts moved here.
 */

import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import * as fs from 'fs';
import { createRequire } from 'node:module';
import { normalizeInputEnvelope, type ProviderModule, flattenContent, type InputEnvelope, type InputPart } from './contracts.js';
import { assertProviderSupportsDeclaredInput, getEffectiveMessageInputSupport } from './provider-input-support.js';
import type { ProviderInstance, ProviderState, ProviderEvent, InstanceContext, ProviderErrorReason, HotChatSessionState, SessionModalState } from './provider-instance.js';
import { normalizeInteractivePrompt, normalizeInteractivePromptResponse, type InteractivePrompt } from './types/interactive-prompt.js';
import { ProviderCliAdapter } from '../cli-adapters/provider-cli-adapter.js';
import type { CliProviderModule } from '../cli-adapters/provider-cli-adapter.js';
import { createCliAdapter } from './spec/route.js';
import type { PtyRuntimeMetadata, PtyTransportFactory } from '../cli-adapters/pty-transport.js';
import { StatusMonitor } from './status-monitor.js';
import { ChatHistoryWriter, isNativeSourceCanonicalHistory, materializeProviderNativeHistory, readChatHistory, readProviderChatHistory } from '../config/chat-history.js';
import { LOG } from '../logging/logger.js';
import type { ChatMessage } from '../types.js';
import { buildPersistedProviderEffectMessage, normalizeProviderEffects } from './control-effects.js';
import { formatAutoApprovalMessage, pickApprovalButton, pickAutoApprovalButton, looksLikeActiveApprovalPromptText } from './approval-utils.js';
import { getCliScriptCommand, parseCliScriptResult } from './cli-script-results.js';
import { mergeProviderPatchState, resolveProviderStateSurface } from './provider-patch-state.js';
import { normalizeProviderSessionId } from './provider-session-id.js';
import { buildChatMessage, buildRuntimeSystemChatMessage, isUserFacingChatMessage, normalizeChatMessages, resolveChatMessageKind, extractFinalSummaryFromMessages } from './chat-message-normalization.js';

type PersistableCliHistoryMessage = {
    role: string;
    content: string;
    kind?: string;
    senderName?: string;
    receivedAt?: number;
};

type CompletedDebouncePending = {
    chatTitle: string;
    duration: number;
    timestamp: number;
    firstObservedAt: number;
    previousStatus: string;
    loggedBlockReason?: string;
    loggedTranscriptProbe?: boolean;
    transcriptProbeHistory?: ExternalTranscriptProbe[];
};

function isIdleStatus(value: unknown): boolean {
    const status = typeof value === 'string' ? value.trim().toLowerCase() : '';
    return !status || status === 'idle' || status === 'ready';
}


function getMessageTime(message: unknown): number {
    if (!message || typeof message !== 'object') return 0;
    const record = message as { receivedAt?: unknown; timestamp?: unknown };
    const value = Number(record.receivedAt ?? record.timestamp ?? 0);
    return Number.isFinite(value) ? value : 0;
}

type CompletedFinalizationBlock = {
    reason: string;
    terminal?: boolean;
    allowTimeout?: boolean;
};

type CompletionFinalAssistantEvidence = {
    present: boolean;
    messages: unknown[];
    source: 'parsed' | 'external-native' | 'unavailable';
};

type ExternalNativeFinalReconciliation = {
    fingerprint: string;
    finalSummary: string;
    evidence: CompletionFinalAssistantEvidence;
};

type ExternalTranscriptProbe = {
    readAt: number;
    msgCount: number;
    lastRole: string | null;
    lastKind: string | null;
    contentLen: number;
    sourcePath: string | null;
    sourceMtimeMs: number | null;
    mtimeAgeMs: number | null;
};

const COMPLETED_FINALIZATION_RETRY_MS = 1000;
const COMPLETED_FINALIZATION_MAX_WAIT_MS = 30_000;

/** Events that signal a dispatched mesh task has reached a terminal state.
 *  Detach the mesh assignment after emitting one of these so the worker's
 *  next unrelated turn doesn't impersonate another completion. */
const TERMINAL_MESH_EVENTS = new Set([
    'agent:generating_completed',
    'agent:stopped',
    'agent:ready',
]);

const IMAGE_MIME_EXTENSIONS: Record<string, string> = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/bmp': '.bmp',
    'image/tiff': '.tiff',
    'image/svg+xml': '.svg',
};

function filePathFromUri(uri: string): string | null {
    if (!uri) return null;
    if (uri.startsWith('file://')) {
        try {
            return decodeURIComponent(new URL(uri).pathname);
        } catch {
            return uri.slice('file://'.length);
        }
    }
    if (path.isAbsolute(uri)) return uri;
    return null;
}

function extensionForImageMime(mimeType: string): string {
    return IMAGE_MIME_EXTENSIONS[mimeType.toLowerCase()] || '.img';
}

function safeInputImageBasename(index: number, mimeType: string): string {
    const extension = extensionForImageMime(mimeType);
    const suffix = crypto.randomBytes(6).toString('hex');
    return `adhdev-input-image-${Date.now()}-${index}-${suffix}${extension}`;
}

function materializeImageDataPart(part: Extract<InputPart, { type: 'image' }>, index: number, dir: string): string | null {
    if (!part.data) return null;
    const rawData = part.data.includes(',') ? part.data.split(',').pop() || '' : part.data;
    if (!rawData) return null;
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, safeInputImageBasename(index, part.mimeType));
    fs.writeFileSync(filePath, Buffer.from(rawData, 'base64'));
    cleanupStaleMaterializedImages(dir);
    return filePath;
}

const MATERIALIZED_IMAGE_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour
const MATERIALIZED_IMAGE_CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
let lastMaterializedImageCleanupAt = 0;

function cleanupStaleMaterializedImages(dir: string): void {
    const now = Date.now();
    if (now - lastMaterializedImageCleanupAt < MATERIALIZED_IMAGE_CLEANUP_INTERVAL_MS) return;
    lastMaterializedImageCleanupAt = now;
    try {
        const entries = fs.readdirSync(dir);
        for (const entry of entries) {
            if (!entry.startsWith('adhdev-input-image-')) continue;
            const fullPath = path.join(dir, entry);
            try {
                const stat = fs.statSync(fullPath);
                if (now - stat.mtimeMs > MATERIALIZED_IMAGE_MAX_AGE_MS) {
                    fs.unlinkSync(fullPath);
                }
            } catch { /* file may have been removed concurrently */ }
        }
    } catch { /* dir may not exist or be inaccessible */ }
}

function hasNonEmptyCliModalButtons(activeModal: unknown): boolean {
    const buttons = (activeModal as any)?.buttons;
    return Array.isArray(buttons) && buttons.some((button) => String(button || '').trim().length > 0);
}

function isCliGeneratingLikeStatus(status: unknown): boolean {
    return status === 'generating' || status === 'streaming' || status === 'long_generating' || status === 'starting';
}

export function buildCliStructuredInputPrompt(
    input: InputEnvelope,
    options: { materializeDir?: string } = {},
): string {
    const promptParts: string[] = [];
    const imageRefs: string[] = [];
    const resourceRefs: string[] = [];
    const materializeDir = options.materializeDir || path.join(os.tmpdir(), 'adhdev-input-media');

    input.parts.forEach((part, index) => {
        if (part.type === 'text' && part.text.trim()) {
            promptParts.push(part.text.trim());
            return;
        }

        if (part.type === 'image') {
            const localPath = typeof part.uri === 'string' ? filePathFromUri(part.uri) : null;
            const materializedPath = !localPath && part.data ? materializeImageDataPart(part, index, materializeDir) : null;
            const ref = localPath || materializedPath || part.uri || '';
            if (ref) imageRefs.push(ref);
            if (part.alt?.trim()) promptParts.push(part.alt.trim());
            return;
        }

        if (part.type === 'resource_link') {
            resourceRefs.push([part.title, part.name, part.description, part.uri].filter(Boolean).join('\n'));
            return;
        }

        if (part.type === 'resource') {
            resourceRefs.push([part.name, part.text, part.uri].filter(Boolean).join('\n'));
        }
    });

    // Only use textFallback when no explicit text parts were collected — it is
    // the flattened version of the same parts, so appending it alongside them
    // would duplicate the content for multipart inputs.
    const hasExplicitTextParts = input.parts.some((part) => part.type === 'text' && part.text.trim());
    if (!hasExplicitTextParts && input.textFallback.trim()) {
        promptParts.push(input.textFallback.trim());
    }

    const ordered = [
        ...imageRefs,
        ...promptParts,
        ...resourceRefs,
    ].filter((value, index, values) => value.trim().length > 0 && values.indexOf(value) === index);

    return ordered.join('\n');
}

function normalizePersistableCliHistoryContent(content: unknown): string {
    return flattenContent(content as any).replace(/\s+/g, ' ').trim();
}

function buildPersistableCliHistorySignature(message: PersistableCliHistoryMessage): string {
    return [
        String(message.role || ''),
        String(message.kind || ''),
        String(message.senderName || ''),
        normalizePersistableCliHistoryContent(message.content),
    ].join('|');
}

function hasSamePersistableCliHistoryIdentity(a: PersistableCliHistoryMessage, b: PersistableCliHistoryMessage): boolean {
    return String(a?.role || '') === String(b?.role || '')
        && String(a?.kind || '') === String(b?.kind || '')
        && String(a?.senderName || '') === String(b?.senderName || '')
        && String(a?.content || '') === String(b?.content || '');
}

export function buildIncrementalHistoryAppendMessages(
    previousMessages: PersistableCliHistoryMessage[],
    currentMessages: PersistableCliHistoryMessage[],
): PersistableCliHistoryMessage[] {
    if (!Array.isArray(currentMessages) || currentMessages.length === 0) return [];
    if (!Array.isArray(previousMessages) || previousMessages.length === 0) return currentMessages;

    const comparableLength = Math.min(previousMessages.length, currentMessages.length);
    let sharedPrefixLength = 0;
    while (
        sharedPrefixLength < comparableLength
        && hasSamePersistableCliHistoryIdentity(previousMessages[sharedPrefixLength], currentMessages[sharedPrefixLength])
    ) {
        sharedPrefixLength += 1;
    }

    if (sharedPrefixLength === currentMessages.length) return [];
    if (sharedPrefixLength === previousMessages.length) return currentMessages.slice(sharedPrefixLength);

    // Rare fallback: preserve the older whitespace-normalized behavior only when
    // the cheap identity check detects a changed prefix. Recomputing normalized
    // signatures for the full transcript on every idle status poll was a CPU
    // hot path for long CLI sessions.
    while (
        sharedPrefixLength < comparableLength
        && buildPersistableCliHistorySignature(previousMessages[sharedPrefixLength])
            === buildPersistableCliHistorySignature(currentMessages[sharedPrefixLength])
    ) {
        sharedPrefixLength += 1;
    }

    if (sharedPrefixLength === currentMessages.length) return [];
    if (sharedPrefixLength === previousMessages.length) return currentMessages.slice(sharedPrefixLength);
    return currentMessages;
}

let CachedDatabaseSync: (new (path: string, options?: { readOnly?: boolean }) => {
    prepare(sql: string): { get(...params: Array<string | number>): unknown };
    close(): void;
}) | null = null;

function getDatabaseSync() {
    if (CachedDatabaseSync) return CachedDatabaseSync;
    const requireFn = typeof require === 'function'
        ? require
        : createRequire(path.join(process.cwd(), '__adhdev_sqlite_loader__.js'));
    const sqliteModule = requireFn(`node:${'sqlite'}`) as {
        DatabaseSync: typeof CachedDatabaseSync;
    };
    CachedDatabaseSync = sqliteModule.DatabaseSync;
    if (!CachedDatabaseSync) {
        throw new Error('node:sqlite DatabaseSync unavailable');
    }
    return CachedDatabaseSync;
}

export function getForcedNewSessionScriptName(
    provider: ProviderModule | undefined,
    launchMode: 'new' | 'resume' | 'manual',
): string | null {
    if (!provider || launchMode !== 'new') return null;
    const resume = provider.resume;
    if (!resume?.supported) return null;
    if (Array.isArray(resume.newSessionArgs) && resume.newSessionArgs.length > 0) return null;

    const controls = Array.isArray((provider as any).controls) ? (provider as any).controls : [];
    for (const control of controls) {
        if (control?.type !== 'action') continue;
        if (typeof control?.confirmTitle === 'string' && control.confirmTitle.trim()) continue;
        if (typeof control?.confirmMessage === 'string' && control.confirmMessage.trim()) continue;
        if (typeof control?.confirmLabel === 'string' && control.confirmLabel.trim()) continue;
        const invokeScript = typeof control?.invokeScript === 'string' ? control.invokeScript.trim() : '';
        if (!invokeScript) continue;
        const controlId = typeof control?.id === 'string' ? control.id.trim() : '';
        if (controlId === 'new_session' || /^new.?session$/i.test(invokeScript)) {
            return invokeScript;
        }
    }

    return null;
}

export async function waitForCliAdapterReady(
    adapter: { isReady?: () => boolean; getStatus?: () => { status?: string } },
    options?: { timeoutMs?: number; pollMs?: number },
): Promise<void> {
    const timeoutMs = Math.max(100, options?.timeoutMs ?? 15_000);
    const pollMs = Math.max(10, options?.pollMs ?? 50);
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        if (adapter?.isReady?.()) return;
        const status = adapter?.getStatus?.()?.status;
        if (status === 'stopped') {
            throw new Error('CLI runtime stopped before it became ready');
        }
        await new Promise((resolve) => setTimeout(resolve, pollMs));
    }

    throw new Error(`CLI runtime did not become ready within ${timeoutMs}ms`);
}

export class CliProviderInstance implements ProviderInstance {
    readonly type: string;
    readonly category = 'cli' as const;

    private adapter: ProviderCliAdapter;
    private context: InstanceContext | null = null;
    private events: ProviderEvent[] = [];
    private lastStatus: string = 'starting';
    private generatingStartedAt: number = 0;
    private settings: Record<string, any> = {};
    private monitor: StatusMonitor;
    private generatingDebounceTimer: NodeJS.Timeout | null = null;
    private generatingDebouncePending: { chatTitle: string; timestamp: number } | null = null;
    private lastApprovalEventFingerprint = '';
    private autoApproveBusy = false;
    private autoApproveBusyTimer: NodeJS.Timeout | null = null;
    private lastAutoApprovalSignature = '';
    private controlValues: Record<string, string | number | boolean> = {};
    private summaryMetadata: unknown = undefined;
    private appliedEffectKeys = new Set<string>();
    private historyWriter: ChatHistoryWriter;
    private runtimeMessages: Array<{ key: string; message: ChatMessage }> = [];
    private lastPersistedHistoryMessages: PersistableCliHistoryMessage[] = [];
    private lastAcknowledgedUserInputAt = 0;
    private externalBusyIdleFingerprint = '';
    private lastNativeSourceCanonicalCheckAt = 0;
    private lastNativeSourceCanonicalCacheKey: string | undefined = undefined;
    private cachedSqliteDb: {
        prepare(sql: string): { get(...values: Array<string | number>): unknown };
        close(): void;
    } | null = null;
    private cachedSqliteDbPath: string | null = null;
    private cachedSqliteDbMissingUntil = 0;
    readonly instanceId: string;
    private suppressIdleHistoryReplay = false;
    private errorMessage: string | undefined = undefined;
    private errorReason: ProviderErrorReason | undefined = undefined;
    private activeInteractivePrompt: InteractivePrompt | null = null;

    private presentationMode: 'terminal' | 'chat';
    private providerSessionId?: string;
    private launchMode: 'new' | 'resume' | 'manual';
    private readonly startedAt = Date.now();
    private onProviderSessionResolved?: (info: {
        instanceId: string;
        providerType: string;
        providerName: string;
        workspace: string;
        providerSessionId: string;
        previousProviderSessionId?: string;
    }) => void;

    constructor(
        private provider: ProviderModule,
        private workingDir: string,
        private cliArgs: string[] = [],
        instanceId?: string,
        transportFactory?: PtyTransportFactory,
        options?: {
            providerSessionId?: string;
            launchMode?: 'new' | 'resume' | 'manual';
            extraEnv?: Record<string, string>;
            onProviderSessionResolved?: (info: {
                instanceId: string;
                providerType: string;
                providerName: string;
                workspace: string;
                providerSessionId: string;
                previousProviderSessionId?: string;
            }) => void;
        },
    ) {
        this.type = provider.type;
        this.instanceId = instanceId || crypto.randomUUID();
        this.presentationMode = 'chat';
        this.providerSessionId = options?.providerSessionId;
        this.launchMode = options?.launchMode || 'new';
        this.onProviderSessionResolved = options?.onProviderSessionResolved;
        this.adapter = createCliAdapter(provider as CliProviderModule, workingDir, cliArgs, options?.extraEnv || {}, transportFactory) as ProviderCliAdapter;
        if (this.providerSessionId) {
            this.adapter.updateRuntimeMeta({ providerSessionId: this.providerSessionId });
        }
        this.monitor = new StatusMonitor();
        this.historyWriter = new ChatHistoryWriter();
    }

    refreshProviderDefinition(provider: ProviderModule): void {
        if (provider.type !== this.type || provider.category !== 'cli') return;
        this.provider = provider;
        this.adapter.refreshProviderDefinition(provider as CliProviderModule);
    }

 // ─── Lifecycle ─────────────────────────────────

    async init(context: InstanceContext): Promise<void> {
        this.context = context;
        this.settings = context.settings || {};
        this.adapter.updateRuntimeSettings?.(this.settings);
        this.monitor.updateConfig({
            approvalAlert: this.settings.approvalAlert !== false,
            longGeneratingAlert: this.settings.longGeneratingAlert !== false,
            longGeneratingThresholdSec: this.settings.longGeneratingThresholdSec || 180,
        });

 // Server connection
        if (context.serverConn) {
            this.adapter.setServerConn(context.serverConn);
        }

 // PTY output callback
        if (context.onPtyData) {
            this.adapter.setOnPtyData(context.onPtyData);
        }

 // Emit event on status change
        this.adapter.setOnStatusChange(() => {
            this.detectStatusTransition();
        });

 // PTY spawn
        await this.adapter.spawn();
        await this.enforceFreshSessionLaunchIfNeeded();
        this.maybeAppendRuntimeRecoveryMessage(this.adapter.getRuntimeMetadata());
        if (this.providerSessionId && this.shouldHydrateExistingProviderHistory()) {
            this.restorePersistedHistoryFromCurrentSession();
        }
        if (this.providerSessionId && this.launchMode === 'resume') {
            const resumedAt = Date.now();
            this.historyWriter.appendSystemMarker(
                this.type,
                `Resumed saved session at ${this.formatMarkerTimestamp(resumedAt)}`,
                {
                    instanceId: this.instanceId,
                    historySessionId: this.providerSessionId,
                    dedupKey: `resume:${this.providerSessionId}:${resumedAt}`,
                    receivedAt: resumedAt,
                },
            );
        }
    }

    async onTick(): Promise<void> {
        if (this.providerSessionId) return;
        if (this.provider.resume?.skipProbeOnNewSession && this.launchMode === 'new') return;

        const probeConfig = this.provider.sessionProbe;
        if (!probeConfig) return;

        const probedSessionId = this.probeSessionIdFromConfig(probeConfig);
        if (probedSessionId) {
            this.promoteProviderSessionId(probedSessionId);
        }
    }

    /**
     * Generic session ID probe using declarative ProviderSessionProbe config.
     * Replaces the previously duplicated probeOpenCode/Codex/Goose functions.
     */
    private probeSessionIdFromConfig(probe: {
        dbPath: string;
        query: string;
        timestampFormat?: 'unix_ms' | 'unix_s' | 'iso';
    }): string | null {
        const resolvedDbPath = probe.dbPath.replace(/^~/, os.homedir());
        // Skip existsSync if we already confirmed DB is missing (cache for 10s)
        const now = Date.now();
        if (this.cachedSqliteDbMissingUntil > now) return null;
        if (!fs.existsSync(resolvedDbPath)) {
            this.cachedSqliteDbMissingUntil = now + 10_000;
            return null;
        }

        const directories = this.getProbeDirectories();
        const minCreatedAt = Math.max(0, this.startedAt - 60_000);
        const tsFormat = probe.timestampFormat || 'unix_ms';

        let timestampParam: string | number;
        if (tsFormat === 'unix_s') {
            timestampParam = Math.floor(minCreatedAt / 1000);
        } else if (tsFormat === 'iso') {
            timestampParam = new Date(minCreatedAt).toISOString().slice(0, 19).replace('T', ' ');
        } else {
            timestampParam = minCreatedAt;
        }

        // Build query: replace {dirs} with SQL placeholder list
        const placeholders = this.buildSqlPlaceholderList(directories.length);
        const query = probe.query.replace('{dirs}', placeholders);

        try {
            return this.querySqliteText(resolvedDbPath, query, [...directories, timestampParam]);
        } catch {
            return null;
        }
    }

    getState(): ProviderState {
        // TODO(phase5-sandbox): JS override scripts (detectStatus, parseApproval,
        // parseSession) are currently invoked by CliScriptRunner.invoke() via direct
        // function calls — the scripts run in the daemon process with full Node.js
        // access and no resource limits.
        //
        // When Phase 5 lands, CliScriptRunner should route these calls through a
        // SandboxedScriptRunner (see providers/sdk/v1/sandbox/script-runner.ts) so
        // that each call gets a fresh isolated-vm context with a 50 ms CPU limit and
        // a 32 MB memory cap.  The execution path to change is:
        //   CliScriptRunner.invoke() → SandboxedScriptRunner.run(scriptSource, context)
        //
        // This getState() call-site is NOT where the change goes — the wiring belongs
        // in cli-script-runner.ts (CliScriptRunner.detectStatus / parseApproval /
        // parseSession), with provider-loader.ts updated to store script source strings
        // alongside the loaded function references for extended-legacy providers.
        const adapterStatus = this.adapter.getStatus();
        if (Object.prototype.hasOwnProperty.call(adapterStatus, 'activeInteractivePrompt')) {
            this.activeInteractivePrompt = adapterStatus.activeInteractivePrompt ?? null;
        }
        let parsedStatus: any = null;
        let parseErrorMessage: string | undefined;
        if (typeof this.adapter.getScriptParsedStatus === 'function') {
            try {
                parsedStatus = this.adapter.getScriptParsedStatus() || null;
                const parsedErrorMessage = typeof parsedStatus?.errorMessage === 'string' && parsedStatus.errorMessage.trim()
                    ? parsedStatus.errorMessage.trim()
                    : undefined;
                const parsedErrorReason = typeof parsedStatus?.errorReason === 'string' && parsedStatus.errorReason.trim()
                    ? parsedStatus.errorReason.trim() as ProviderErrorReason
                    : undefined;
                this.errorMessage = parsedErrorMessage;
                this.errorReason = parsedErrorReason;
            } catch (error: any) {
                parseErrorMessage = error?.message || String(error);
                this.errorMessage = parseErrorMessage;
                this.errorReason = 'parse_error';
            }
        } else {
            this.errorMessage = undefined;
            this.errorReason = undefined;
        }
        const adapterProviderSessionId = normalizeProviderSessionId(
            this.provider,
            typeof adapterStatus?.providerSessionId === 'string' ? adapterStatus.providerSessionId : '',
        );
        const autoApproveActive = this.maybeAutoApproveStatus(adapterStatus, Date.now());
        const autoApproveHoldIdle = this.autoApproveBusy && adapterStatus.status === 'idle';
        let visibleStatus = parseErrorMessage || parsedStatus?.status === 'error'
            ? 'error'
            : (autoApproveActive || autoApproveHoldIdle ? 'generating' : adapterStatus.status);
        const externalNativeFinal = this.getExternalNativeFinalReconciliation(parsedStatus?.messages, adapterStatus);
        if (externalNativeFinal && isCliGeneratingLikeStatus(visibleStatus)) {
            visibleStatus = 'idle';
        }
        // Adapter raw status can lag behind parsed/native evidence: if the spec driver
        // has not yet emitted a state_changed(idle) event but the parsed transcript
        // already shows a final assistant turn, treat the session as idle so that
        // getState() agrees with what detectStatusTransition already recorded via
        // lastStatus. Without this guard, getState() returns 'generating' even after
        // the instance's lastStatus has flipped to 'idle', causing the dashboard to
        // show a perpetual generating spinner.
        if (isCliGeneratingLikeStatus(visibleStatus) && this.lastStatus === 'idle') {
            visibleStatus = 'idle';
        }
        const runtime = this.adapter.getRuntimeMetadata();
        this.maybeAppendRuntimeRecoveryMessage(runtime);
        let parsedMessages = Array.isArray(parsedStatus?.messages)
            ? parsedStatus.messages
            : [];
        const parsedProviderSessionId = normalizeProviderSessionId(
            this.provider,
            typeof parsedStatus?.providerSessionId === 'string' ? parsedStatus.providerSessionId : '',
        );
        const suppressFreshLaunchStartupReplay = this.shouldSuppressFreshLaunchStartupReplay(
            parsedMessages,
            parsedStatus,
            adapterStatus,
            parsedProviderSessionId,
        );
        if (adapterProviderSessionId && !suppressFreshLaunchStartupReplay) {
            this.promoteProviderSessionId(adapterProviderSessionId);
        }
        if (parsedProviderSessionId && !suppressFreshLaunchStartupReplay) {
            this.promoteProviderSessionId(parsedProviderSessionId);
        }
        if (suppressFreshLaunchStartupReplay) {
            parsedMessages = [];
        }
        // Adapter runtime metadata is transport-owned and is not guaranteed to
        // identify this conversation. Spec adapters historically exposed the
        // provider spec id (for example "codex-cli") as runtimeId, which made
        // concurrent sessions share one activeChat identity until their native
        // provider session ids were discovered.
        const activeChatId = this.providerSessionId || this.instanceId;
        const historyMessageCount = Number.isFinite(parsedStatus?.historyMessageCount)
            ? Math.max(0, Number(parsedStatus.historyMessageCount))
            : null;
        if (historyMessageCount !== null) {
            parsedMessages = historyMessageCount > 0
                ? parsedMessages.slice(-historyMessageCount)
                : [];
        }
        const mergedMessages = this.mergeConversationMessages(parsedMessages);
        const canonicalBackedHistory = this.shouldHydrateExistingProviderHistory()
            ? this.syncCanonicalSavedHistoryIfNeeded()
            : false;
        const statusMessages = canonicalBackedHistory && this.lastPersistedHistoryMessages.length > 0
            ? this.lastPersistedHistoryMessages.map((message) => ({
                role: message.role,
                content: message.content,
                kind: message.kind,
                senderName: message.senderName,
                receivedAt: message.receivedAt,
            }))
            : mergedMessages;

        const dirName = this.workingDir.split('/').filter(Boolean).pop() || 'session';
        const parsedChatStatus = typeof parsedStatus?.status === 'string' && parsedStatus.status.trim()
            ? parsedStatus.status.trim()
            : undefined;
        const suppressStaleParsedBusyStatus = this.shouldSuppressStaleParsedBusyStatus(parsedStatus, adapterStatus);

        if (parsedMessages.length > 0) {
            const shouldSkipReplayPersist =
                this.suppressIdleHistoryReplay
                && adapterStatus.status === 'idle'
                && parsedStatus?.status === 'idle';
            let messagesToSave = parsedMessages;
            if (!suppressStaleParsedBusyStatus && (parsedChatStatus === 'generating' || parsedChatStatus === 'long_generating')) {
                const lastIdx = messagesToSave.length - 1;
                if (lastIdx >= 0 && messagesToSave[lastIdx]?.role === 'assistant') {
                    messagesToSave = messagesToSave.slice(0, lastIdx);
                }
            }
            const normalizedMessagesToSave = messagesToSave.map((message: PersistableCliHistoryMessage & { timestamp?: number }) => ({
                role: message.role,
                content: flattenContent(message.content),
                kind: typeof message.kind === 'string' ? message.kind : undefined,
                senderName: typeof message.senderName === 'string' ? message.senderName : undefined,
                receivedAt: typeof message.receivedAt === 'number' ? message.receivedAt : message.timestamp,
            }));
            if (!canonicalBackedHistory && !shouldSkipReplayPersist && normalizedMessagesToSave.length > 0) {
                const incrementalMessages = buildIncrementalHistoryAppendMessages(this.lastPersistedHistoryMessages, normalizedMessagesToSave);
                if (incrementalMessages.length > 0) {
                    this.historyWriter.appendNewMessages(
                        this.type,
                        incrementalMessages,
                        parsedStatus?.title || dirName,
                        this.instanceId,
                        this.providerSessionId,
                    );
                }
            }
            if (!canonicalBackedHistory) {
                this.lastPersistedHistoryMessages = normalizedMessagesToSave;
            }
        }

        this.applyProviderResponse(
            suppressFreshLaunchStartupReplay && parsedStatus && typeof parsedStatus === 'object'
                ? { ...parsedStatus, providerSessionId: undefined }
                : parsedStatus,
            { phase: 'immediate' },
        );
        const surface = resolveProviderStateSurface({
            summaryMetadata: this.summaryMetadata as any,
            controlValues: this.controlValues,
        });
        const activeChatStatus = parseErrorMessage
            ? 'error'
            : (autoApproveActive && parsedStatus?.status === 'waiting_approval') || autoApproveHoldIdle
            ? 'generating'
            : (adapterStatus.status !== 'idle'
                ? visibleStatus
                : (suppressStaleParsedBusyStatus ? visibleStatus : (parsedChatStatus || visibleStatus)));

        // If an AskUserQuestion prompt is awaiting user input, overlay status as
        // waiting_choice. This is distinct from waiting_approval (tool-use consent)
        // — the engine's isWaitingForResponse state is unchanged, so completion
        // tracking continues normally once the user responds.
        const hasInteractivePrompt = !!this.activeInteractivePrompt;
        const finalStatus = hasInteractivePrompt ? 'waiting_choice' : visibleStatus;
        const finalChatStatus = hasInteractivePrompt ? 'waiting_choice' : activeChatStatus;

        return {
            type: this.type,
            name: this.provider.name,
            category: 'cli',
            status: finalStatus,
            mode: this.presentationMode,
            activeChat: {
                id: activeChatId,
                title: parsedStatus?.title || dirName,
                status: finalChatStatus,
                messages: statusMessages,
                activeModal: (autoApproveActive || autoApproveHoldIdle) ? null : (parsedStatus?.activeModal ?? adapterStatus.activeModal),
                activeInteractivePrompt: this.activeInteractivePrompt,
                inputContent: '',
            },
            activeInteractivePrompt: this.activeInteractivePrompt,
            workspace: this.workingDir,
            instanceId: this.instanceId,
            providerSessionId: this.providerSessionId,
            lastUpdated: Date.now(),
            settings: this.settings,
            pendingEvents: this.flushEvents(),
            runtime: runtime ? {
                runtimeId: runtime.runtimeId,
                runtimeKey: runtime.runtimeKey,
                displayName: runtime.displayName,
                workspaceLabel: runtime.workspaceLabel,
                lifecycle: runtime.lifecycle ?? null,
                surfaceKind: runtime.surfaceKind,
                writeOwner: runtime.writeOwner || null,
                attachedClients: runtime.attachedClients || [],
                restoredFromStorage: runtime.restoredFromStorage === true,
                recoveryState: runtime.recoveryState ?? null,
            } : undefined,
            resume: this.provider.resume,
            controlValues: surface.controlValues,
            providerControls: this.provider.controls,
            messageInput: getEffectiveMessageInputSupport(this.provider),
            summaryMetadata: surface.summaryMetadata as any,
            errorMessage: this.errorMessage,
            errorReason: this.errorReason,
        };
    }

    setPresentationMode(mode: 'terminal' | 'chat'): void {
        if (this.presentationMode === mode) return;
        this.presentationMode = mode;
    }

    getPresentationMode(): 'terminal' | 'chat' {
        return this.presentationMode;
    }

    getHotChatSessionState(): HotChatSessionState {
        const adapterStatus = this.adapter.getStatus({ allowParse: false });
        const autoApproveActive = adapterStatus.status === 'waiting_approval' && this.shouldAutoApprove();
        const autoApproveHoldIdle = this.autoApproveBusy && adapterStatus.status === 'idle';
        const visibleStatus = autoApproveActive || autoApproveHoldIdle ? 'generating' : adapterStatus.status;
        const runtime = this.adapter.getRuntimeMetadata();
        return {
            id: this.instanceId,
            status: visibleStatus,
            runtimeLifecycle: runtime?.lifecycle ?? null,
            runtimeSurfaceKind: runtime?.surfaceKind,
            runtimeRestoredFromStorage: runtime?.restoredFromStorage === true,
            runtimeRecoveryState: runtime?.recoveryState ?? null,
        };
    }

    getSessionModalState(sessionId?: string): SessionModalState {
        const adapterStatus = this.adapter.getStatus({ allowParse: true });
        const autoApproveActive = adapterStatus.status === 'waiting_approval' && this.shouldAutoApprove();
        const autoApproveHoldIdle = this.autoApproveBusy && adapterStatus.status === 'idle';
        const visibleStatus = autoApproveActive || autoApproveHoldIdle ? 'generating' : adapterStatus.status;
        const dirName = this.workingDir.split('/').filter(Boolean).pop() || 'session';
        return {
            // Honor the caller-supplied sessionId — InstanceMgr rejects the
            // projection when projected.id !== requested sessionId, and
            // this.instanceId is the manager's internal key, not the public
            // sessionId the dashboard subscribes by.
            id: sessionId ?? this.instanceId,
            status: visibleStatus,
            title: dirName,
            activeModal: (autoApproveActive || autoApproveHoldIdle) ? null : adapterStatus.activeModal,
        };
    }

    updateSettings(newSettings: Record<string, any>): void {
        const runtimeMeshSettings: Record<string, any> = {};
        for (const key of [
            'meshNodeFor',
            'meshNodeId',
            'meshActiveTaskId',
            'meshCoordinatorFor',
            'meshCoordinatorDaemonId',
            'meshCoordinatorNodeId',
            'spawnedSessionVisibility',
            'launchedByCoordinator',
        ]) {
            if (this.settings[key] !== undefined && newSettings[key] === undefined) {
                runtimeMeshSettings[key] = this.settings[key];
            }
        }
        this.settings = { ...newSettings, ...runtimeMeshSettings };
        this.adapter.updateRuntimeSettings?.(this.settings);
        this.monitor.updateConfig({
            approvalAlert: this.settings.approvalAlert !== false,
            longGeneratingAlert: this.settings.longGeneratingAlert !== false,
            longGeneratingThresholdSec: this.settings.longGeneratingThresholdSec || 180,
        });
    }

    /**
     * Stamp a direct-dispatch mesh assignment on this instance.
     * setupMeshEventForwarding reads settings.meshNodeFor + meshActiveTaskId to
     * route generating_completed back to the originating coordinator. Without
     * this stamp, mesh_send_task --direct targets a plain CLI session whose
     * completion events silently drop because the forwarder has nothing to
     * match against.
     */
    attachMeshAssignment(assignment: { meshId: string; nodeId?: string; taskId?: string; coordinatorDaemonId?: string }): void {
        if (!assignment?.meshId) return;
        this.settings = {
            ...this.settings,
            meshNodeFor: assignment.meshId,
            ...(assignment.nodeId ? { meshNodeId: assignment.nodeId } : {}),
            ...(assignment.taskId ? { meshActiveTaskId: assignment.taskId } : {}),
            ...(assignment.coordinatorDaemonId ? { meshCoordinatorDaemonId: assignment.coordinatorDaemonId } : {}),
        };
        this.adapter.updateRuntimeSettings?.(this.settings);
    }

    /**
     * Clear a previously-attached mesh assignment after the task reaches a
     * terminal state. Leaving meshNodeFor pinned would route this session's
     * subsequent unrelated turns (e.g. ad-hoc dashboard chats) to the
     * coordinator as if they were task completions.
     */
    detachMeshAssignment(): void {
        if (!this.settings.meshNodeFor && !this.settings.meshActiveTaskId && !this.settings.meshNodeId) return;
        const { meshNodeFor, meshNodeId, meshActiveTaskId, ...rest } = this.settings;
        void meshNodeFor; void meshNodeId; void meshActiveTaskId;
        this.settings = rest;
        this.adapter.updateRuntimeSettings?.(this.settings);
    }

    onEvent(event: string, data?: any): void {
        if (event === 'send_message') {
            const input = normalizeInputEnvelope(data);
            assertProviderSupportsDeclaredInput(this.provider, input);
            const promptText = buildCliStructuredInputPrompt(input);
            if (promptText) {
                // force:true bypasses the busy/generating send guard so terminal mesh
                // events (completion/failure/bootstrap) land in a coordinator session that
                // is itself parked in `generating` while awaiting that very event.
                // Without it the message is queued and only flushed on the coordinator's
                // own idle transition — which never happens until it receives the message.
                const force = data?.force === true;
                void this.adapter.sendMessage(promptText, force ? { force: true } : {}).catch((e: any) => {
                    LOG.warn('CLI', `[${this.type}] send_message failed: ${e?.message || e}`);
                });
            }
        } else if (event === 'server_connected' && data?.serverConn) {
            this.adapter.setServerConn(data.serverConn);
        } else if (event === 'resolve_action' && data) {
            void this.adapter.resolveAction(data).catch((e: any) => {
                LOG.warn('CLI', `[${this.type}] resolve_action failed: ${e?.message || e}`);
            });
        } else if (event === 'interactive_prompt' && data) {
            const prompt = normalizeInteractivePrompt(data);
            if (prompt) {
                this.activeInteractivePrompt = prompt;
                this.events.push({
                    event: 'interactive_prompt',
                    timestamp: Date.now(),
                    promptId: prompt.promptId,
                });
            }
        } else if (event === 'interactive_prompt_response' && data) {
            try {
                const response = normalizeInteractivePromptResponse(data);
                if (this.activeInteractivePrompt?.promptId === response.promptId) {
                    this.activeInteractivePrompt = null;
                }
                if (typeof this.adapter.setInteractivePromptResponse !== 'function') {
                    LOG.warn('CLI', `[${this.type}] interactive_prompt_response ignored: adapter does not support interactive prompts`);
                    return;
                }
                void this.adapter.setInteractivePromptResponse(response).catch((e: any) => {
                    LOG.warn('CLI', `[${this.type}] interactive_prompt_response failed: ${e?.message || e}`);
                });
            } catch (e: any) {
                LOG.warn('CLI', `[${this.type}] invalid interactive_prompt_response: ${e?.message || e}`);
            }
        } else if (event === 'provider_state_patch' && data && typeof data === 'object') {
            this.applyProviderResponse(data, { phase: 'immediate' });
        }
    }

    recordAcknowledgedUserInput(input: InputEnvelope | string): void {
        const content = typeof input === 'string'
            ? input.trim()
            : buildCliStructuredInputPrompt(input).trim();
        if (!content) return;

        const receivedAt = Date.now();
        this.lastAcknowledgedUserInputAt = receivedAt;
        this.externalBusyIdleFingerprint = '';
        const dedupKey = `user_input_ack:${crypto
            .createHash('sha256')
            .update(`${this.instanceId}:${content}:${receivedAt}`)
            .digest('hex')
            .slice(0, 24)}`;
        this.appendRuntimeMessage(buildChatMessage({
            role: 'user',
            senderName: 'User',
            kind: 'standard',
            content,
            receivedAt,
            timestamp: receivedAt,
            source: 'runtime_input_ack',
            meta: {
                runtimeInputAck: true,
                provider: this.type,
                workspace: this.workingDir,
            },
        } as ChatMessage), dedupKey);
    }

    dispose(): void {
        this.adapter.shutdown();
        this.monitor.reset();
        this.appliedEffectKeys.clear();
        try { this.cachedSqliteDb?.close(); } catch { /* noop */ }
        this.cachedSqliteDb = null;
        this.cachedSqliteDbPath = null;
    }

    private completedDebounceTimer: NodeJS.Timeout | null = null;
    private completedDebouncePending: CompletedDebouncePending | null = null;
    private lastExternalCompletionProbe: ExternalTranscriptProbe | null = null;

    private async enforceFreshSessionLaunchIfNeeded(): Promise<void> {
        const scriptName = getForcedNewSessionScriptName(this.provider, this.launchMode);
        if (!scriptName) return;

        LOG.info('CLI', `[${this.type}] forcing fresh session launch via script: ${scriptName}`);
        await waitForCliAdapterReady(this.adapter);
        const raw = await this.adapter.invokeScript(scriptName, {});
        const parsed = parseCliScriptResult(raw);
        if (!parsed.success) {
            throw new Error(parsed.payload?.error || `Failed to invoke fresh-session script '${scriptName}'`);
        }

        const cliCommand = getCliScriptCommand(parsed.payload);
        if (cliCommand?.type === 'send_message' && cliCommand.text) {
            await this.adapter.sendMessage(cliCommand.text);
        } else if (cliCommand?.type === 'pty_write' && cliCommand.text) {
            const enterCount = cliCommand.enterCount || 1;
            await this.adapter.writeRaw(cliCommand.text + '\r');
            for (let i = 1; i < enterCount; i += 1) {
                await new Promise(resolve => setTimeout(resolve, 50));
                await this.adapter.writeRaw('\r');
            }
        }

        this.applyProviderResponse(parsed.payload, { phase: 'immediate' });
    }

    private completionHasFinalAssistantMessage(messages: unknown): boolean {
        const visibleMessages = (Array.isArray(messages) ? messages : [])
            .filter((message: any) => isUserFacingChatMessage(message as ChatMessage));
        const lastVisible = visibleMessages[visibleMessages.length - 1] as ChatMessage | undefined;
        const role = typeof lastVisible?.role === 'string' ? lastVisible.role.trim().toLowerCase() : '';
        const content = lastVisible ? flattenContent(lastVisible.content).trim() : '';
        if (role !== 'assistant' || !content) return false;
        // Guard: if the last assistant message looks like an active approval/input prompt,
        // it is not a real completion — the session is still awaiting user input.
        if (looksLikeActiveApprovalPromptText(content)) return false;
        return true;
    }

    private buildExternalTranscriptProbe(messages: unknown[], sourcePath?: string, sourceMtimeMs?: number): ExternalTranscriptProbe {
        const visibleMessages = messages.filter((message: any) => isUserFacingChatMessage(message as ChatMessage));
        const lastVisible = visibleMessages[visibleMessages.length - 1] as ChatMessage | undefined;
        const readAt = Date.now();
        const mtimeMs = Number(sourceMtimeMs) || 0;
        return {
            readAt,
            msgCount: messages.length,
            lastRole: typeof lastVisible?.role === 'string' ? lastVisible.role.trim().toLowerCase() : null,
            lastKind: typeof (lastVisible as any)?.kind === 'string' ? (lastVisible as any).kind : null,
            contentLen: lastVisible ? flattenContent(lastVisible.content).trim().length : 0,
            sourcePath: typeof sourcePath === 'string' && sourcePath ? sourcePath : null,
            sourceMtimeMs: mtimeMs || null,
            mtimeAgeMs: mtimeMs ? Math.max(0, readAt - mtimeMs) : null,
        };
    }

    private recordPendingTranscriptProbe(pending: CompletedDebouncePending): ExternalTranscriptProbe | null {
        const probe = this.lastExternalCompletionProbe;
        if (!probe) return null;
        const history = pending.transcriptProbeHistory || [];
        const last = history[history.length - 1];
        if (!last || last.readAt !== probe.readAt || last.msgCount !== probe.msgCount || last.lastRole !== probe.lastRole || last.contentLen !== probe.contentLen) {
            history.push(probe);
            pending.transcriptProbeHistory = history.slice(-5);
        }
        return probe;
    }

    private readExternalCompletionMessages(): unknown[] | null {
        const adapterOwnsMessagesElsewhere = (this.adapter as any)?.chatMessagesOwnedExternally === true;
        if (!adapterOwnsMessagesElsewhere) return null;
        if (!this.providerSessionId) return null;
        if (!isNativeSourceCanonicalHistory(this.provider.nativeHistory)) return null;

        if (this.lastExternalCompletionProbe?.sourcePath) {
            try { fs.statSync(this.lastExternalCompletionProbe.sourcePath); } catch { /* best-effort metadata refresh */ }
        }
        const restoredHistory = readProviderChatHistory(this.type, {
            canonicalHistory: this.provider.nativeHistory,
            historySessionId: this.providerSessionId,
            workspace: this.workingDir,
            offset: 0,
            limit: Number.MAX_SAFE_INTEGER,
            historyBehavior: this.provider.historyBehavior,
            scripts: this.provider.scripts as any,
            sessionStartedAtMs: this.startedAt,
            forceRefresh: true,
        });
        if (restoredHistory.source !== 'provider-native') {
            this.lastExternalCompletionProbe = null;
            return null;
        }
        this.lastExternalCompletionProbe = this.buildExternalTranscriptProbe(
            restoredHistory.messages,
            restoredHistory.sourcePath,
            restoredHistory.sourceMtimeMs,
        );
        return restoredHistory.messages;
    }

    private completionFinalAssistantEvidence(parsedMessages: unknown): CompletionFinalAssistantEvidence {
        if (this.completionHasFinalAssistantMessage(parsedMessages)) {
            return {
                present: true,
                messages: Array.isArray(parsedMessages) ? parsedMessages : [],
                source: 'parsed',
            };
        }

        const externalMessages = this.readExternalCompletionMessages();
        if (externalMessages) {
            return {
                present: this.completionHasFinalAssistantMessage(externalMessages),
                messages: externalMessages,
                source: 'external-native',
            };
        }

        return {
            present: false,
            messages: Array.isArray(parsedMessages) ? parsedMessages : [],
            source: 'unavailable',
        };
    }

    private completionFinalSummary(parsedMessages: unknown): string | undefined {
        const evidence = this.completionFinalAssistantEvidence(parsedMessages);
        return extractFinalSummaryFromMessages(evidence.messages as any);
    }

    private externalNativeFinalFingerprint(evidence: CompletionFinalAssistantEvidence): string {
        const messages = Array.isArray(evidence.messages) ? evidence.messages : [];
        const visibleMessages = messages.filter((message: any) => isUserFacingChatMessage(message as ChatMessage));
        const lastVisible = visibleMessages[visibleMessages.length - 1] as ChatMessage | undefined;
        const content = lastVisible ? flattenContent(lastVisible.content).trim() : '';
        const receivedAt = lastVisible ? getMessageTime(lastVisible) : 0;
        const probe = this.lastExternalCompletionProbe;
        return crypto
            .createHash('sha256')
            .update([
                this.type,
                this.providerSessionId || '',
                probe?.sourcePath || '',
                String(probe?.sourceMtimeMs || 0),
                String(receivedAt || 0),
                content.slice(-500),
            ].join('\0'))
            .digest('hex')
            .slice(0, 24);
    }

    private getExternalNativeFinalReconciliation(parsedMessages: unknown, adapterStatus: any): ExternalNativeFinalReconciliation | null {
        const rawStatus = typeof adapterStatus?.status === 'string' ? adapterStatus.status.trim() : '';
        if (!isCliGeneratingLikeStatus(rawStatus)) return null;
        if (hasNonEmptyCliModalButtons(adapterStatus?.activeModal ?? adapterStatus?.modal)) return null;

        const evidence = this.completionFinalAssistantEvidence(parsedMessages);
        if (evidence.source !== 'external-native' || !evidence.present) return null;

        const messages = Array.isArray(evidence.messages) ? evidence.messages : [];
        const visibleMessages = messages.filter((message: any) => isUserFacingChatMessage(message as ChatMessage));
        const lastVisible = visibleMessages[visibleMessages.length - 1] as ChatMessage | undefined;
        const lastMessageAt = lastVisible ? getMessageTime(lastVisible) : 0;
        const sourceMtimeMs = Number(this.lastExternalCompletionProbe?.sourceMtimeMs || 0);
        const minEvidenceAt = Math.max(
            this.startedAt > 0 ? this.startedAt - 5_000 : 0,
            this.generatingStartedAt > 0 ? this.generatingStartedAt - 5_000 : 0,
            this.lastAcknowledgedUserInputAt > 0 ? this.lastAcknowledgedUserInputAt - 1_000 : 0,
        );
        if (minEvidenceAt > 0 && lastMessageAt > 0 && lastMessageAt < minEvidenceAt && sourceMtimeMs < minEvidenceAt) {
            return null;
        }

        const finalSummary = extractFinalSummaryFromMessages(evidence.messages as any);
        if (!finalSummary) return null;
        const fingerprint = this.externalNativeFinalFingerprint(evidence);
        if (fingerprint === this.externalBusyIdleFingerprint) {
            return { fingerprint, finalSummary, evidence };
        }
        this.externalBusyIdleFingerprint = fingerprint;
        return { fingerprint, finalSummary, evidence };
    }

    private buildCompletedFinalizationDiagnostic(args: {
        blockReason: string;
        latestStatus?: any;
        latestVisibleStatus: string;
        waitedMs: number;
        pending: CompletedDebouncePending;
        emittedAfterFinalizationTimeout: boolean;
    }): Record<string, unknown> {
        let parsed: any = null;
        let parseError: string | undefined;
        try {
            parsed = this.adapter.getScriptParsedStatus();
        } catch (error: any) {
            parseError = error?.message || String(error);
        }

        const evidence = this.completionFinalAssistantEvidence(parsed?.messages);
        if (evidence.source === 'external-native') {
            this.recordPendingTranscriptProbe(args.pending);
        }
        const visibleMessages = (Array.isArray(evidence.messages) ? evidence.messages : [])
            .filter((message: any) => isUserFacingChatMessage(message as ChatMessage));
        const lastVisible = visibleMessages[visibleMessages.length - 1] as ChatMessage | undefined;
        const lastVisibleRole = typeof lastVisible?.role === 'string' ? lastVisible.role.trim().toLowerCase() : null;
        const lastVisibleKind = typeof (lastVisible as any)?.kind === 'string' ? (lastVisible as any).kind : null;
        const lastVisibleContentLength = lastVisible ? flattenContent(lastVisible.content).trim().length : 0;

        return {
            providerType: this.type,
            sessionId: this.instanceId,
            providerSessionId: this.providerSessionId || null,
            workspace: this.workingDir,
            blockReason: args.blockReason,
            emittedAfterFinalizationTimeout: args.emittedAfterFinalizationTimeout,
            waitedMs: args.waitedMs,
            maxWaitMs: COMPLETED_FINALIZATION_MAX_WAIT_MS,
            adapterStatus: typeof args.latestStatus?.status === 'string' ? args.latestStatus.status : null,
            latestVisibleStatus: args.latestVisibleStatus,
            parsedStatus: typeof parsed?.status === 'string' ? parsed.status : (parseError ? 'parse_error' : 'unknown'),
            parseError: parseError || undefined,
            finalAssistantPresent: evidence.present,
            finalAssistantEvidenceSource: evidence.source,
            visibleMessageCount: visibleMessages.length,
            lastVisibleRole,
            lastVisibleKind,
            lastVisibleContentLength,
            pendingStartedAt: this.generatingStartedAt || null,
            pendingFirstObservedAt: args.pending.firstObservedAt,
            pendingTimestamp: args.pending.timestamp,
            pendingDurationSec: args.pending.duration,
            previousBlockReason: args.pending.loggedBlockReason || null,
            transcriptProbeHistory: args.pending.transcriptProbeHistory || [],
        };
    }

    private hasAdapterPendingResponse(): boolean {
        const adapterAny = this.adapter as any;
        if (adapterAny?.isWaitingForResponse === true) return true;
        if (adapterAny?.currentTurnScope) return true;
        try {
            if (typeof this.adapter.isProcessing === 'function' && this.adapter.isProcessing()) return true;
        } catch { /* defensive: status rendering must not fail because of adapter diagnostics */ }
        try {
            const partial = typeof this.adapter.getPartialResponse === 'function'
                ? this.adapter.getPartialResponse()
                : '';
            if (typeof partial === 'string' && partial.trim()) return true;
        } catch { /* defensive: missing partial means no pending response evidence */ }
        return false;
    }

    private shouldSuppressStaleParsedBusyStatus(parsedStatus: any, adapterStatus: any): boolean {
        const parsedRawStatus = typeof parsedStatus?.status === 'string' ? parsedStatus.status.trim() : '';
        const adapterRawStatus = typeof adapterStatus?.status === 'string' ? adapterStatus.status.trim() : '';
        if (!isCliGeneratingLikeStatus(parsedRawStatus)) return false;
        if (adapterRawStatus !== 'idle') return false;
        if (hasNonEmptyCliModalButtons(parsedStatus?.activeModal ?? parsedStatus?.modal)) return false;
        if (this.hasAdapterPendingResponse()) return false;
        // Do not suppress when the adapter's raw response buffer is still non-empty.
        // This catches the case where isWaitingForResponse has already flipped to false
        // (so getPartialResponse() returns '') but the provider's native parser still
        // reports generating because it's parsing buffered content. Suppressing the
        // finalization block here would emit a false completion event while the provider
        // session is still actively processing its response stream.
        const adapterAny = this.adapter as any;
        if (typeof adapterAny?.responseBuffer === 'string' && adapterAny.responseBuffer.trim()) return false;
        return true;
    }

    private getCompletedFinalizationBlock(latestVisibleStatus: string, pending: CompletedDebouncePending, opts?: { externalNativeFinal?: ExternalNativeFinalReconciliation | null }): CompletedFinalizationBlock | null {
        if (latestVisibleStatus !== 'idle') return { reason: `status:${latestVisibleStatus}`, terminal: true };

        const adapterAny = this.adapter as any;
        const approvalResolvedIdle = pending.previousStatus === 'waiting_approval';
        const externalNativeFinal = opts?.externalNativeFinal || null;
        if (!approvalResolvedIdle && !externalNativeFinal) {
            if (adapterAny?.isWaitingForResponse === true) return { reason: 'adapter_waiting_for_response', terminal: true };
            if (adapterAny?.currentTurnScope) return { reason: 'adapter_turn_scope_active', terminal: true };
            if (this.hasAdapterPendingResponse()) return { reason: 'adapter_pending_response', terminal: true };
        }

        const partial = typeof this.adapter.getPartialResponse === 'function'
            ? this.adapter.getPartialResponse()
            : '';
        if (!externalNativeFinal && typeof partial === 'string' && partial.trim()) return { reason: 'partial_response_pending', terminal: true };

        let parsed: any;
        try {
            parsed = this.adapter.getScriptParsedStatus();
        } catch (error: any) {
            return { reason: `parse_error:${error?.message || String(error)}` };
        }

        const parsedStatus = typeof parsed?.status === 'string' ? parsed.status : 'unknown';
        if (parsedStatus !== 'idle') {
            const adapterStatus = this.adapter.getStatus({ allowParse: false });
            if (externalNativeFinal && isCliGeneratingLikeStatus(parsedStatus)) return null;
            if (this.shouldSuppressStaleParsedBusyStatus(parsed, adapterStatus)) return null;
            return { reason: `parsed_status:${parsedStatus}`, terminal: isCliGeneratingLikeStatus(parsedStatus) };
        }
        if (parsed?.activeModal || parsed?.modal) return { reason: 'parsed_modal_active', terminal: true };
        const adapterOwnsMessagesElsewhere = (this.adapter as any)?.chatMessagesOwnedExternally === true;
        const finalAssistantEvidence = this.completionFinalAssistantEvidence(parsed?.messages);
        const allowMissingAssistantTimeout = !!(this.settings.meshNodeFor || this.settings.meshActiveTaskId || this.settings.launchedByCoordinator);
        LOG.debug('CLI', `[${this.type}] finalAssistantEvidence: present=${finalAssistantEvidence.present} source=${finalAssistantEvidence.source} adapterOwnsMessagesElsewhere=${adapterOwnsMessagesElsewhere} parsedStatus=${parsedStatus}`);
        if (!finalAssistantEvidence.present) {
            if (adapterOwnsMessagesElsewhere) {
                if (finalAssistantEvidence.source === 'external-native') {
                    const probe = this.recordPendingTranscriptProbe(pending);
                    if (probe && !pending.loggedTranscriptProbe) {
                        LOG.info('CLI', `[${this.type}] external transcript probe: msgCount=${probe.msgCount} lastRole=${probe.lastRole || 'none'} lastKind=${probe.lastKind || 'none'} contentLen=${probe.contentLen} sourceMtime=${probe.sourceMtimeMs ?? 'unknown'} mtimeAge=${probe.mtimeAgeMs ?? 'unknown'}ms`);
                        pending.loggedTranscriptProbe = true;
                    }
                    LOG.debug('CLI', `[${this.type}] external-native probe result: lastRole=${probe?.lastRole} contentLen=${probe?.contentLen}`);
                    if (probe?.lastRole === 'assistant' && (probe.contentLen ?? 0) > 0) {
                        return null;
                    }
                    if (this.type === 'antigravity-cli') {
                        return null;
                    }
                    return { reason: 'missing_final_assistant', terminal: true, allowTimeout: allowMissingAssistantTimeout };
                }
                if ((this.provider as any).requiresFinalAssistantBeforeIdle === true) {
                    return { reason: 'missing_final_assistant', terminal: true, allowTimeout: allowMissingAssistantTimeout };
                }
            } else {
                LOG.debug('CLI', `[${this.type}] missing_final_assistant (not ownsExternal) requiresFinalAssistant=${!!(this.provider as any).requiresFinalAssistantBeforeIdle}`);
                return {
                    reason: 'missing_final_assistant',
                    terminal: (this.provider as any).requiresFinalAssistantBeforeIdle === true,
                    allowTimeout: allowMissingAssistantTimeout,
                };
            }
        }

        // Guard: if the screen still shows an approval/choice prompt as the last visible text,
        // the turn is not complete even if the parsed status says idle and there is an assistant
        // message. This catches the case where waiting_approval→idle transitions occur before
        // the modal has been resolved (e.g. the PTY rendered the prompt but no button press fired).
        try {
            const screenText = typeof (this.adapter as any).getScreenText === 'function'
                ? String((this.adapter as any).getScreenText() || '')
                : '';
            if (screenText) {
                const tailLines = screenText.split(/\r?\n/).slice(-16).join('\n');
                if (looksLikeActiveApprovalPromptText(tailLines)) {
                    return { reason: 'screen_shows_approval_prompt', terminal: approvalResolvedIdle };
                }
            }
        } catch { /* defensive: screen text read is best-effort */ }

        return null;
    }

    private scheduleCompletedDebounceFlush(delayMs: number): void {
        if (this.completedDebounceTimer) clearTimeout(this.completedDebounceTimer);
        this.completedDebounceTimer = setTimeout(() => this.flushCompletedDebounceIfFinalized(), delayMs);
    }

    private flushCompletedDebounceIfFinalized(): void {
        const pending = this.completedDebouncePending;
        if (!pending) {
            this.completedDebounceTimer = null;
            return;
        }

        const latestStatus = this.adapter.getStatus({ allowParse: false });
        const latestAutoApproveActive = latestStatus.status === 'waiting_approval' && this.shouldAutoApprove();
        const externalNativeFinal = this.getExternalNativeFinalReconciliation(undefined, latestStatus);
        const latestVisibleStatus = externalNativeFinal && isCliGeneratingLikeStatus(latestStatus.status)
            ? 'idle'
            : (latestAutoApproveActive || this.autoApproveBusy ? 'generating' : latestStatus.status);
        LOG.debug('CLI', `[${this.type}] flush attempt: adapterStatus=${latestStatus.status} latestVisible=${latestVisibleStatus} externalNativeFinal=${!!externalNativeFinal} generatingStartedAt=${this.generatingStartedAt} isWaitingForResponse=${!!(this.adapter as any)?.isWaitingForResponse} hasPartial=${!!this.adapter.getPartialResponse?.()}`);
        if (latestVisibleStatus !== 'idle') {
            LOG.info('CLI', `[${this.type}] cancelled pending completed (resumed ${latestVisibleStatus})`);
            this.completedDebouncePending = null;
            this.completedDebounceTimer = null;
            return;
        }

        const block = this.getCompletedFinalizationBlock(latestVisibleStatus, pending, { externalNativeFinal });
        if (block) {
            const blockReason = block.reason;
            const waitedMs = Date.now() - pending.firstObservedAt;
            LOG.debug('CLI', `[${this.type}] finalization block: reason=${blockReason} terminal=${block.terminal} waitedMs=${waitedMs} maxWait=${COMPLETED_FINALIZATION_MAX_WAIT_MS}`);
            if ((block.terminal && !block.allowTimeout) || waitedMs < COMPLETED_FINALIZATION_MAX_WAIT_MS) {
                if (pending.loggedBlockReason !== blockReason) {
                    LOG.info('CLI', `[${this.type}] waiting to emit completed until transcript finalizes (${blockReason})`);
                    pending.loggedBlockReason = blockReason;
                }
                this.scheduleCompletedDebounceFlush(COMPLETED_FINALIZATION_RETRY_MS);
                return;
            }
            const completionDiagnostic = this.buildCompletedFinalizationDiagnostic({
                blockReason,
                latestStatus,
                latestVisibleStatus,
                waitedMs,
                pending,
                emittedAfterFinalizationTimeout: true,
            });
            LOG.warn('CLI', `[${this.type}] emitting completed event after ${waitedMs}ms without finalized assistant turn (${blockReason})`);
            this.pushEvent({
                event: 'agent:generating_completed',
                chatTitle: pending.chatTitle,
                duration: pending.duration,
                timestamp: pending.timestamp,
                finalSummary: blockReason.startsWith('parsed_status:')
                    ? ''
                    : this.completionFinalSummary(this.adapter?.getScriptParsedStatus()?.messages),
                completionDiagnostic,
            });
            this.completedDebouncePending = null;
            this.completedDebounceTimer = null;
            this.generatingStartedAt = 0;
            this.lastApprovalEventFingerprint = '';
            return;
        }

        LOG.info('CLI', `[${this.type}] completed in ${pending.duration}s`);
        this.pushEvent({
            event: 'agent:generating_completed',
            chatTitle: pending.chatTitle,
            duration: pending.duration,
            timestamp: pending.timestamp,
            finalSummary: externalNativeFinal?.finalSummary || this.completionFinalSummary(this.adapter?.getScriptParsedStatus()?.messages),
            ...(externalNativeFinal ? {
                completionDiagnostic: {
                    providerType: this.type,
                    sessionId: this.instanceId,
                    providerSessionId: this.providerSessionId || null,
                    reconciliationReason: 'external_native_final_assistant_while_adapter_busy',
                    finalAssistantPresent: true,
                    finalAssistantEvidenceSource: externalNativeFinal.evidence.source,
                    externalFinalFingerprint: externalNativeFinal.fingerprint,
                },
            } : {}),
        });
        this.completedDebouncePending = null;
        this.completedDebounceTimer = null;
        this.generatingStartedAt = 0;
        this.lastApprovalEventFingerprint = '';
    }

    private maybeAutoApproveStatus(adapterStatus: any, now = Date.now()): boolean {
        const autoApproveActive = adapterStatus?.status === 'waiting_approval' && this.shouldAutoApprove();
        // Guard re-entry: onStatusChange/getState can observe the same modal multiple
        // times while the PTY absorbs the approval key. Without this flag, repeated
        // snapshots would write stray keys into the input once the modal dismisses.
        // However, Claude Code can present a second approval immediately after the
        // first. Resolve a changed modal signature even while the previous write is
        // still inside the short busy window.
        if (!autoApproveActive) {
            this.lastAutoApprovalSignature = '';
            return autoApproveActive;
        }
        const modal = adapterStatus.activeModal;
        // (fix) Do not auto-approve when no concrete modal/buttons are present.
        // Claude TUI flaps between paints; without this guard adapterStatus
        // could report status=waiting_approval with activeModal=null (or with
        // an empty buttons array briefly) and we'd still call
        // resolveModal(-1) — which used to type "1" into the prompt
        // repeatedly. Skip until a real modal is captured.
        const buttons = Array.isArray(modal?.buttons)
            ? modal.buttons.map((b: any) => String(b || '').trim()).filter(Boolean)
            : [];
        if (!modal || buttons.length === 0) {
            return autoApproveActive;
        }
        const { index: buttonIndex, label: buttonLabel } = pickAutoApprovalButton(buttons);
        if (buttonIndex < 0) {
            // No concrete button matched — don't pick a random index, just
            // surface the modal so the user can decide.
            return autoApproveActive;
        }
        const signature = [
            typeof modal?.message === 'string' ? modal.message.trim() : '',
            buttons.join('|'),
            buttonIndex,
        ].join('::');
        if (!this.autoApproveBusy || signature !== this.lastAutoApprovalSignature) {
            this.autoApproveBusy = true;
            this.lastAutoApprovalSignature = signature;
            if (this.autoApproveBusyTimer) clearTimeout(this.autoApproveBusyTimer);
            this.autoApproveBusyTimer = setTimeout(() => {
                this.autoApproveBusy = false;
                this.autoApproveBusyTimer = null;
                this.lastAutoApprovalSignature = '';
            }, 5000);
            this.recordAutoApproval(modal?.message, buttonLabel, now);
            setTimeout(() => {
                this.adapter.resolveModal(buttonIndex);
            }, 0);
        }
        return autoApproveActive;
    }

    private detectStatusTransition(): void {
        const now = Date.now();
        // Status-change handling is a hot path: PTY output can fire it many times
        // during long-running CLI sessions. Keep this path on adapter-owned light
        // state only; rich provider parsing is reserved for getState/read_chat.
        const adapterStatus = this.adapter.getStatus({ allowParse: false });
        const adapterProviderSessionId = normalizeProviderSessionId(
            this.provider,
            typeof adapterStatus?.providerSessionId === 'string' ? adapterStatus.providerSessionId : '',
        );
        if (adapterProviderSessionId) {
            this.promoteProviderSessionId(adapterProviderSessionId);
        }
        const parsedStatus = null;
        const rawStatus = adapterStatus.status;
        const autoApproveActive = this.maybeAutoApproveStatus(adapterStatus, now);
        const externalNativeFinal = this.getExternalNativeFinalReconciliation(undefined, adapterStatus);
        // During the autoApproveBusy window (2s after firing approval key), the PTY
        // can briefly report 'idle' before the next generating phase starts. Treat that
        // transient idle as 'generating' to suppress a spurious agent:generating_completed
        // push notification. externalNativeFinal still wins to allow hard-stop overrides.
        const autoApproveHoldIdle = this.autoApproveBusy && rawStatus === 'idle';
        const newStatus = externalNativeFinal && isCliGeneratingLikeStatus(rawStatus)
            ? 'idle'
            : (autoApproveActive || autoApproveHoldIdle ? 'generating' : rawStatus);
        const dirName = this.workingDir.split('/').filter(Boolean).pop() || 'session';
        const chatTitle = `${this.provider.name} · ${dirName}`;
        const partial = this.adapter.getPartialResponse();
        const progressFingerprint = newStatus === 'generating'
            ? `${partial || ''}`.slice(-2000)
            : undefined;

        const previousStatus = this.lastStatus;
        if (newStatus !== this.lastStatus) {
            LOG.info('CLI', `[${this.type}] status: ${this.lastStatus} → ${newStatus}`);
            if (this.lastStatus === 'idle' && newStatus === 'generating') {
                // If a completion event is already pending and the turn has ended
                // (generatingStartedAt===0), the PTY is painting its prompt area
                // after completing. Ignore this blip — do not cancel the pending
                // completion and do not advance lastStatus to generating.
                if (this.completedDebouncePending && this.generatingStartedAt === 0) {
                    LOG.debug('CLI', `[${this.type}] ignoring post-completion PTY generating blip (generatingStartedAt=0)`);
                    return;
                }
                this.suppressIdleHistoryReplay = false;
                // Cancel any pending completed event (multi-step: idle→generating resume)
                if (this.completedDebouncePending) {
                    LOG.info('CLI', `[${this.type}] cancelled pending completed (resumed generating) generatingStartedAt=${this.generatingStartedAt} isWaitingForResponse=${!!(this.adapter as any)?.isWaitingForResponse}`);
                    if (this.completedDebounceTimer) { clearTimeout(this.completedDebounceTimer); this.completedDebounceTimer = null; }
                    this.completedDebouncePending = null;
                }

                if (!this.generatingStartedAt) this.generatingStartedAt = now;
                // Defer the generating_started event — if idle comes back within 3s,
                // the whole started→completed pair was a false positive from PTY noise
                if (this.generatingDebounceTimer) clearTimeout(this.generatingDebounceTimer);
                this.generatingDebouncePending = { chatTitle, timestamp: now };
                this.generatingDebounceTimer = setTimeout(() => {
                    if (this.generatingDebouncePending) {
                        this.pushEvent({ event: 'agent:generating_started', ...this.generatingDebouncePending });
                        this.generatingDebouncePending = null;
                    }
                    this.generatingDebounceTimer = null;
                }, 3000);
            } else if (newStatus === 'waiting_approval') {
                this.suppressIdleHistoryReplay = false;
                // Flush pending generating_started if debounce still pending
                if (this.generatingDebouncePending) {
                    if (this.generatingDebounceTimer) { clearTimeout(this.generatingDebounceTimer); this.generatingDebounceTimer = null; }
                    this.pushEvent({ event: 'agent:generating_started', ...this.generatingDebouncePending });
                    this.generatingDebouncePending = null;
                }
                // Cancel any pending completed
                if (this.completedDebounceTimer) { clearTimeout(this.completedDebounceTimer); this.completedDebounceTimer = null; }
                this.completedDebouncePending = null;

                if (!this.generatingStartedAt) this.generatingStartedAt = now;
                const modal = adapterStatus.activeModal;
                LOG.info('CLI', `[${this.type}] approval modal: "${modal?.message?.slice(0, 80) ?? 'none'}"`);
                const approvalFingerprint = JSON.stringify({
                    message: typeof modal?.message === 'string' ? modal.message.trim() : '',
                    buttons: Array.isArray(modal?.buttons) ? modal.buttons.map((button: unknown) => String(button).trim()) : [],
                });
                // PTY redraws repeat the same modal content; fingerprint dedup prevents duplicate events.
                // Do NOT also gate on lastStatus: consecutive approvals can arrive waiting_approval→waiting_approval
                // (e.g. antigravity-cli resolves one prompt and immediately shows the next) and would be silently dropped.
                if (approvalFingerprint !== this.lastApprovalEventFingerprint) {
                    this.lastApprovalEventFingerprint = approvalFingerprint;
                    this.appendRuntimeSystemMessage(
                        this.formatApprovalRequestMessage(modal?.message, modal?.buttons),
                        `approval_request:${now}`,
                        now,
                    );
                    this.pushEvent({
                        event: 'agent:waiting_approval', chatTitle, timestamp: now,
                        modalMessage: modal?.message,
                        modalButtons: modal?.buttons,
                    });
                }
            } else if (newStatus === 'idle' && (this.lastStatus === 'generating' || this.lastStatus === 'waiting_approval')) {
                const duration = this.generatingStartedAt ? Math.round((now - this.generatingStartedAt) / 1000) : 0;
                // Guard: if generatingStartedAt===0 and no debounce pending, the generating phase
                // was entered from 'starting' state (startup PTY noise), not from a real idle→generating
                // task dispatch. The idle→generating handler is the only code path that sets
                // generatingStartedAt and generatingDebouncePending, so both being absent means no
                // task was ever dispatched. Suppress the spurious completion event and fall through
                // to a simple lastStatus update.
                if (!this.generatingStartedAt && !this.generatingDebouncePending) {
                    LOG.debug('CLI', `[${this.type}] suppressed startup-phase generating→idle blip (generatingStartedAt=0, no debounce pending)`);
                } else
                // If debounce still pending (generating lasted < 1s), cancel both UI events.
                // Still emit agent:generating_completed so mesh orchestration can record
                // task_completed for direct dispatches that complete faster than the debounce.
                if (this.generatingDebouncePending) {
                    const shortDurationMs = this.generatingStartedAt ? now - this.generatingStartedAt : 0;
                    LOG.info('CLI', `[${this.type}] suppressed short generating (${shortDurationMs}ms)`);
                    if (this.generatingDebounceTimer) { clearTimeout(this.generatingDebounceTimer); this.generatingDebounceTimer = null; }
                    // Emit completion for mesh task association even though the UI generating
                    // started/completed pair is suppressed (too short for visible UI update).
                    let shortFinalSummary: string | undefined;
                    let shortEvidenceSource: CompletionFinalAssistantEvidence['source'] = 'unavailable';
                    try {
                        const parsedMessages = this.adapter?.getScriptParsedStatus()?.messages;
                        const evidence = this.completionFinalAssistantEvidence(parsedMessages);
                        shortEvidenceSource = evidence.source;
                        shortFinalSummary = extractFinalSummaryFromMessages(evidence.messages as any);
                    } catch { /* best-effort */ }
                    // If a real response is confirmed, retroactively emit started so the chat
                    // bubble appears even though the debounce suppressed the original event.
                    if (shortFinalSummary) {
                        this.pushEvent({ event: 'agent:generating_started', chatTitle, timestamp: now - shortDurationMs });
                    }
                    this.generatingDebouncePending = null;
                    this.generatingStartedAt = 0;
                    const missingEvidence = ((this.provider as any).requiresFinalAssistantBeforeIdle === true || shortEvidenceSource === 'external-native') && !shortFinalSummary;
                    if (missingEvidence) {
                        LOG.warn('CLI', `[${this.type}] short completion missing final assistant evidence (source=${shortEvidenceSource})`);
                    }
                    // When evidence is missing and there is no active mesh task context, suppress
                    // the completion event. Providers with requiresFinalAssistantBeforeIdle or
                    // external-native history must confirm a final assistant message before the
                    // coordinator records task_completed. Only emit here if a mesh task is active
                    // so the coordinator can apply its own timeout/retry logic.
                    const hasMeshContext = !!(this.settings.meshNodeFor || this.settings.meshActiveTaskId || this.settings.launchedByCoordinator);
                    if (missingEvidence && !hasMeshContext) {
                        LOG.info('CLI', `[${this.type}] short completion suppressed: missing final assistant evidence, no mesh context (source=${shortEvidenceSource})`);
                        // completedDebouncePending intentionally left null — the session is now idle
                        // with no confirmed turn, matching the startup-blip suppression semantics.
                    } else {
                        this.pushEvent({
                            event: 'agent:generating_completed',
                            chatTitle,
                            duration: 0,
                            timestamp: now,
                            finalSummary: shortFinalSummary,
                            completionDiagnostic: {
                                reason: 'short_generating_suppressed',
                                shortDurationMs,
                                finalAssistantEvidenceSource: shortEvidenceSource,
                                ...(missingEvidence ? { blockReason: 'missing_final_assistant' } : {}),
                            },
                        });
                    }
                } else {
                    // Debounce completed, then require the rich transcript path that read_chat
                    // uses to show an idle turn whose last user-facing message is assistant.
                    this.completedDebouncePending = {
                        chatTitle,
                        duration,
                        timestamp: now,
                        firstObservedAt: now,
                        previousStatus: this.lastStatus,
                    };
                    const ownsExternalHistory = !!(this.adapter as any)?.chatMessagesOwnedExternally;
                    const flushDelay = ownsExternalHistory ? 0 : 3000;
                    LOG.debug('CLI', `[${this.type}] set completedDebouncePending duration=${duration}s ownsExternalHistory=${ownsExternalHistory} flushDelay=${flushDelay}ms generatingStartedAt=${this.generatingStartedAt}`);
                    this.scheduleCompletedDebounceFlush(flushDelay);
                }
            } else if (newStatus === 'idle' && this.lastStatus === 'starting') {
                this.pushEvent({ event: 'agent:ready', chatTitle, timestamp: now });
            } else if (newStatus === 'error') {
                if (this.generatingDebounceTimer) { clearTimeout(this.generatingDebounceTimer); this.generatingDebounceTimer = null; }
                this.generatingDebouncePending = null;
                if (this.completedDebounceTimer) { clearTimeout(this.completedDebounceTimer); this.completedDebounceTimer = null; }
                this.completedDebouncePending = null;
                this.errorMessage = adapterStatus.errorMessage || this.errorMessage;
                this.errorReason = (adapterStatus.errorReason as ProviderErrorReason) || this.errorReason;
                this.pushEvent({
                    event: 'agent:stopped',
                    chatTitle,
                    timestamp: now,
                    finalSummary: adapterStatus.errorMessage || adapterStatus.errorReason || 'Provider reported an error',
                    completionDiagnostic: {
                        reason: adapterStatus.errorReason || 'provider_error',
                        errorMessage: adapterStatus.errorMessage || undefined,
                    },
                });
            } else if (newStatus === 'stopped') {
                // Cancel any pending debounce
                if (this.generatingDebounceTimer) { clearTimeout(this.generatingDebounceTimer); this.generatingDebounceTimer = null; }
                this.generatingDebouncePending = null;
                if (this.completedDebounceTimer) { clearTimeout(this.completedDebounceTimer); this.completedDebounceTimer = null; }
                this.completedDebouncePending = null;
                this.pushEvent({ event: 'agent:stopped', chatTitle, timestamp: now });
            }
            this.lastStatus = newStatus;
        }

        this.applyProviderResponse(parsedStatus, {
            phase: (newStatus === 'idle' && (previousStatus === 'generating' || previousStatus === 'waiting_approval'))
                ? 'turn_completed'
                : 'immediate',
        });

 // Monitor check (cooldown based notification, IDE/CLI common)
        const agentKey = `${this.type}:cli`;
        const monitorEvents = this.monitor.check(agentKey, newStatus, now, progressFingerprint);
        const monitorParsedStatus: any = parsedStatus;
        for (const me of monitorEvents) {
            if (
                me.type === 'monitor:long_generating'
                && this.completionHasFinalAssistantMessage(monitorParsedStatus?.messages)
                && !this.hasAdapterPendingResponse()
                && !hasNonEmptyCliModalButtons(monitorParsedStatus?.activeModal ?? monitorParsedStatus?.modal)
            ) {
                this.pushEvent({
                    event: 'agent:generating_completed',
                    chatTitle,
                    duration: this.generatingStartedAt ? Math.round((now - this.generatingStartedAt) / 1000) : undefined,
                    timestamp: me.timestamp,
                    finalSummary: extractFinalSummaryFromMessages(monitorParsedStatus?.messages),
                    completionDiagnostic: {
                        providerType: this.type,
                        sessionId: this.instanceId,
                        providerSessionId: this.providerSessionId || null,
                        reconciliationReason: 'long_generating_monitor_final_summary',
                        finalAssistantPresent: true,
                    },
                });
                this.generatingStartedAt = 0;
                // Cancel any pending debounce flush — monitor already fired completion.
                if (this.completedDebounceTimer) { clearTimeout(this.completedDebounceTimer); this.completedDebounceTimer = null; }
                this.completedDebouncePending = null;
                continue;
            }
            this.pushEvent({ event: me.type, agentKey: me.agentKey, message: me.message, elapsedSec: me.elapsedSec, timestamp: me.timestamp });
        }
    }

    private pushEvent(event: ProviderEvent): void {
        const enrichedEvent: ProviderEvent = {
            ...event,
            instanceId: typeof event.instanceId === 'string' && event.instanceId.trim()
                ? event.instanceId
                : this.instanceId,
            targetSessionId: typeof event.targetSessionId === 'string' && event.targetSessionId.trim()
                ? event.targetSessionId
                : this.instanceId,
            providerType: typeof event.providerType === 'string' && event.providerType.trim()
                ? event.providerType
                : this.type,
            workspaceName: typeof event.workspaceName === 'string' && event.workspaceName.trim()
                ? event.workspaceName
                : this.workingDir,
            providerSessionId: typeof event.providerSessionId === 'string' && event.providerSessionId.trim()
                ? event.providerSessionId
                : this.providerSessionId,
        };
        if (this.context?.emitProviderEvent) {
            this.context.emitProviderEvent(enrichedEvent);
        } else {
            this.events.push(enrichedEvent);
        }
        // Auto-detach a direct-dispatch mesh assignment once the dispatched
        // task reaches a terminal state. Leaving meshNodeFor pinned would
        // route this session's next unrelated turn (a dashboard chat) into
        // the coordinator as if it were the completion of another task.
        // We schedule after the emit so the originating coordinator still
        // observes the completion event with its routing marker intact.
        if (TERMINAL_MESH_EVENTS.has(event.event) && this.settings.meshActiveTaskId) {
            try { this.detachMeshAssignment(); } catch { /* best-effort */ }
        }
    }

    private flushEvents(): ProviderEvent[] {
        const events = [...this.events];
        this.events = [];
        return events;
    }

    private applyProviderResponse(data: any, options: { phase: 'immediate' | 'turn_completed' }): void {
        if (!data || typeof data !== 'object') return;

        const patchedProviderSessionId = normalizeProviderSessionId(
            this.provider,
            typeof data.providerSessionId === 'string' ? data.providerSessionId : '',
        );
        if (patchedProviderSessionId) {
            this.promoteProviderSessionId(patchedProviderSessionId);
        }

        if (data.sessionEvent === 'new_session') {
            this.runtimeMessages = [];
            this.lastPersistedHistoryMessages = [];
            this.suppressIdleHistoryReplay = false;
            this.adapter.clearHistory();
        }

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
                const persistedMessage = buildPersistedProviderEffectMessage(effect);
                if (persistedMessage) this.appendRuntimeMessage(persistedMessage, effectKey);
            }

            if (effect.type === 'message' && effect.message) {
                const content = typeof effect.message.content === 'string'
                    ? effect.message.content
                    : JSON.stringify(effect.message.content);
                this.pushEvent({
                    event: 'provider:message',
                    timestamp: Date.now(),
                    content,
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

        if (this.appliedEffectKeys.size > 200) {
            this.appliedEffectKeys = new Set(Array.from(this.appliedEffectKeys).slice(-100));
        }
    }

    private getEffectDedupKey(effect: { id?: string; type: string; message?: { content?: unknown }; toast?: { message?: string }; notification?: { title?: string; body?: string } }): string {
        if (effect.id) return `provider_effect:${effect.id}`;
        if (effect.type === 'message') {
            const content = typeof effect.message?.content === 'string'
                ? effect.message.content
                : JSON.stringify(effect.message?.content || '');
            return `provider_effect:message:${content}`;
        }
        if (effect.type === 'notification') {
            return `provider_effect:notification:${effect.notification?.title || ''}:${effect.notification?.body || ''}`;
        }
        return `provider_effect:toast:${effect.toast?.message || ''}`;
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

 // ─── Adapter access (backward compat) ──────────────────

    getAdapter(): ProviderCliAdapter {
        return this.adapter;
    }

    get cliType(): string { return this.type; }
    get cliName(): string { return this.provider.name; }

    private shouldAutoApprove(): boolean {
        if (typeof this.settings.autoApprove === 'boolean') {
            return this.settings.autoApprove;
        }
        const providerDefault = this.provider.settings?.autoApprove?.default;
        if (typeof providerDefault === 'boolean') {
            return providerDefault;
        }
        return false;
    }

    private recordAutoApproval(modalMessage?: string, buttonLabel?: string, now = Date.now()): void {
        this.appendRuntimeSystemMessage(
            formatAutoApprovalMessage(modalMessage, buttonLabel),
            `auto_approval:${now}:${buttonLabel || 'approve'}`,
            now,
        );
    }

    recordApprovalSelection(buttonText: string): void {
        const cleanButton = String(buttonText || '').trim();
        if (!cleanButton) return;
        const now = Date.now();
        this.appendRuntimeSystemMessage(
            `Approval selected: ${cleanButton}`,
            `approval_selection:${now}:${cleanButton}`,
            now,
        );
    }

    private formatMarkerTimestamp(timestamp: number): string {
        const date = new Date(timestamp);
        const pad = (value: number) => String(value).padStart(2, '0');
        return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
    }

    private maybeAppendRuntimeRecoveryMessage(runtime: PtyRuntimeMetadata | null): void {
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

        this.appendRuntimeSystemMessage(
            content,
            `runtime_recovery:${runtime.runtimeId}:${recoveryState}`,
        );
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

        this.runtimeMessages.push({
            key: dedupKey,
            message: normalizedMessage,
        });

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
                this.adapter.getScriptParsedStatus?.()?.title || this.workingDir.split('/').filter(Boolean).pop() || 'session',
                this.instanceId,
                this.providerSessionId,
            );
        }
    }

    mergeRuntimeChatMessages(parsedMessages: ChatMessage[]): ChatMessage[] {
        return this.mergeConversationMessages(parsedMessages);
    }

    private mergeConversationMessages(parsedMessages: any[]): ChatMessage[] {
        if (this.runtimeMessages.length === 0) return normalizeChatMessages(parsedMessages);

        type MergeEntry = { message: ChatMessage; index: number; source: 'parsed' | 'runtime'; runtimeKey?: string };
        const parsedEntries: MergeEntry[] = parsedMessages.map((message, index) => ({
            message,
            index,
            source: 'parsed',
        }));
        const getRole = (message: ChatMessage): string => typeof message.role === 'string'
            ? message.role.trim().toLowerCase()
            : '';
        const runtimeEntries: MergeEntry[] = this.runtimeMessages.map((entry, index) => ({
            message: entry.message,
            index: parsedMessages.length + index,
            source: 'runtime' as const,
            runtimeKey: entry.key,
        })).filter((entry) => {
            const meta = entry.message.meta && typeof entry.message.meta === 'object' && !Array.isArray(entry.message.meta)
                ? entry.message.meta as Record<string, unknown>
                : {};
            if (meta.runtimeInputAck !== true) return true;
            const runtimeText = flattenContent(entry.message.content).replace(/\s+/g, ' ').trim();
            if (!runtimeText) return false;
            return !parsedEntries.some((parsedEntry) => {
                const parsedRole = getRole(parsedEntry.message);
                if (parsedRole !== 'user' && parsedRole !== 'human') return false;
                const parsedText = flattenContent(parsedEntry.message.content).replace(/\s+/g, ' ').trim();
                return parsedText === runtimeText;
            });
        });
        const getTime = (message: ChatMessage): number => {
            const value = typeof message.receivedAt === 'number'
                ? message.receivedAt
                : typeof message.timestamp === 'number'
                    ? message.timestamp
                    : 0;
            return Number.isFinite(value) && value > 0 ? value : 0;
        };

        const isRuntimeOverlay = (entry: MergeEntry): boolean => {
            if (entry.source !== 'runtime') return false;
            const key = typeof entry.runtimeKey === 'string' ? entry.runtimeKey.trim().toLowerCase() : '';
            if (key.startsWith('auto_approval:')) return true;
            return !isUserFacingChatMessage(entry.message);
        };
        const shouldKeepParsedBeforeUntimedRuntime = (message: ChatMessage): boolean => {
            const role = getRole(message);
            return role === 'user' || role === 'human';
        };
        const shouldKeepParsedAfterUntimedRuntime = (message: ChatMessage): boolean => {
            const role = getRole(message);
            if (role !== 'assistant') return false;
            const kind = resolveChatMessageKind(message);
            return kind === 'standard' || kind === 'terminal';
        };

        return normalizeChatMessages([...parsedEntries, ...runtimeEntries]
            .sort((a, b) => {
                const aTime = getTime(a.message);
                const bTime = getTime(b.message);
                if (aTime && bTime && aTime !== bTime) return aTime - bTime;
                if (a.source !== b.source && aTime !== bTime) {
                    const parsedEntry = a.source === 'parsed' ? a : b.source === 'parsed' ? b : null;
                    const runtimeEntry = a.source === 'runtime' ? a : b.source === 'runtime' ? b : null;
                    if (parsedEntry && runtimeEntry && isRuntimeOverlay(runtimeEntry) && getTime(parsedEntry.message) === 0 && getTime(runtimeEntry.message) > 0) {
                        if (shouldKeepParsedBeforeUntimedRuntime(parsedEntry.message)) {
                            return a.source === 'parsed' ? -1 : 1;
                        }
                        if (shouldKeepParsedAfterUntimedRuntime(parsedEntry.message)) {
                            return a.source === 'parsed' ? 1 : -1;
                        }
                    }
                }
                // Many provider-owned CLI transcripts (including Hermes CLI in debug bundles)
                // do not carry timestamps on parsed messages. In that case there is no safe
                // clock basis for interleaving timestamped runtime/system messages into the
                // provider transcript. Keep user prompts before runtime overlays, but do not
                // let timed runtime/system/tool/internal overlays become the final chat turns
                // after an untimed parsed assistant transcript.
                return a.index - b.index;
            })
            .map((entry) => entry.message));
    }

    private formatApprovalRequestMessage(modalMessage?: string, buttons?: string[]): string {
        const lines = ['Approval requested'];
        const cleanMessage = String(modalMessage || '').trim();
        if (cleanMessage) lines.push(cleanMessage);
        const labels = (buttons || []).map((button) => String(button || '').trim()).filter(Boolean);
        if (labels.length > 0) {
            lines.push(labels.map((label) => `[${label}]`).join(' '));
        }
        return lines.join('\n');
    }

    private promoteProviderSessionId(sessionId: string): void {
        const nextSessionId = String(sessionId || '').trim();
        if (!nextSessionId || nextSessionId === this.providerSessionId) return;

        const previousHistorySessionId = this.providerSessionId || this.instanceId;
        const previousProviderSessionId = this.providerSessionId;
        this.providerSessionId = nextSessionId;
        this.historyWriter.promoteHistorySession(this.type, previousHistorySessionId, nextSessionId);
        this.historyWriter.writeSessionStart(this.type, nextSessionId, this.workingDir, this.instanceId);
        if (this.shouldHydrateExistingProviderHistory()) {
            this.restorePersistedHistoryFromCurrentSession();
        }
        this.adapter.updateRuntimeMeta({ providerSessionId: nextSessionId });
        this.onProviderSessionResolved?.({
            instanceId: this.instanceId,
            providerType: this.type,
            providerName: this.provider.name,
            workspace: this.workingDir,
            providerSessionId: nextSessionId,
            previousProviderSessionId,
        });
        LOG.info('CLI', `[${this.type}] discovered provider session id: ${nextSessionId}`);
    }

    private shouldHydrateExistingProviderHistory(): boolean {
        return this.launchMode === 'resume' || this.launchMode === 'manual';
    }

    private shouldSuppressFreshLaunchStartupReplay(parsedMessages: unknown[], parsedStatus: any, adapterStatus: any, parsedProviderSessionId = ''): boolean {
        if (this.launchMode !== 'new') return false;
        if (this.providerSessionId) return false;
        if (!Array.isArray(parsedMessages) || parsedMessages.length === 0) return false;
        if (!isIdleStatus(adapterStatus?.status) || !isIdleStatus(parsedStatus?.status)) return false;
        if (parsedProviderSessionId) return true;

        const newestMessageAt = parsedMessages.reduce<number>((newest, message) => Math.max(newest, getMessageTime(message)), 0);

        // Untimestamped idle parser output during a fresh launch is usually the
        // provider's last workspace transcript before a new turn exists.
        return newestMessageAt === 0;
    }

    private syncCanonicalSavedHistoryIfNeeded(): boolean {
        if (!this.providerSessionId) return false;
        const canonicalHistory = this.provider.nativeHistory;
        if (!canonicalHistory) return false;

        if (isNativeSourceCanonicalHistory(canonicalHistory)) {
            const cacheKey = [this.type, this.providerSessionId, this.workingDir].join('\0');
            const now = Date.now();
            if (cacheKey === this.lastNativeSourceCanonicalCacheKey && now - this.lastNativeSourceCanonicalCheckAt < 2_000) {
                return true;
            }
            this.lastNativeSourceCanonicalCacheKey = cacheKey;
            this.lastNativeSourceCanonicalCheckAt = now;

            const restoredHistory = readProviderChatHistory(this.type, {
                canonicalHistory,
                historySessionId: this.providerSessionId,
                workspace: this.workingDir,
                offset: 0,
                limit: Number.MAX_SAFE_INTEGER,
                historyBehavior: this.provider.historyBehavior,
                scripts: this.provider.scripts as any,
            });
            if (restoredHistory.source === 'provider-native') {
                this.lastPersistedHistoryMessages = restoredHistory.messages.map((message) => ({
                    role: message.role,
                    content: message.content,
                    kind: message.kind,
                    senderName: message.senderName,
                    receivedAt: message.receivedAt,
                }));
            }
            return true;
        }

        try {
            const cacheKey = [this.type, this.providerSessionId, this.workingDir, canonicalHistory.mode || 'materialized-mirror'].join('\0');
            const now = Date.now();
            if (cacheKey === this.lastNativeSourceCanonicalCacheKey && now - this.lastNativeSourceCanonicalCheckAt < 2_000) {
                return true;
            }
            this.lastNativeSourceCanonicalCacheKey = cacheKey;
            this.lastNativeSourceCanonicalCheckAt = now;

            if (!materializeProviderNativeHistory(this.type, canonicalHistory, this.providerSessionId, this.workingDir, this.provider.scripts as any)) {
                return false;
            }
            const restoredHistory = readChatHistory(this.type, 0, Number.MAX_SAFE_INTEGER, this.providerSessionId, 0, this.provider.historyBehavior);
            this.lastPersistedHistoryMessages = restoredHistory.messages.map((message) => ({
                role: message.role,
                content: message.content,
                kind: message.kind,
                senderName: message.senderName,
                receivedAt: message.receivedAt,
            }));
            return true;
        } catch {
            return false;
        }
    }

    private restorePersistedHistoryFromCurrentSession(): void {
        if (!this.providerSessionId) return;
        this.syncCanonicalSavedHistoryIfNeeded();
        const restoredHistory = isNativeSourceCanonicalHistory(this.provider.nativeHistory)
            ? readProviderChatHistory(this.type, {
                canonicalHistory: this.provider.nativeHistory,
                historySessionId: this.providerSessionId,
                workspace: this.workingDir,
                offset: 0,
                limit: Number.MAX_SAFE_INTEGER,
                historyBehavior: this.provider.historyBehavior,
                scripts: this.provider.scripts as any,
            })
            : (() => {
                this.historyWriter.compactHistorySession(this.type, this.providerSessionId!, this.provider.historyBehavior);
                return readChatHistory(this.type, 0, Number.MAX_SAFE_INTEGER, this.providerSessionId, 0, this.provider.historyBehavior);
            })();
        this.historyWriter.seedSessionHistory(
            this.type,
            restoredHistory.messages,
            this.providerSessionId,
            this.instanceId,
        );
        this.lastPersistedHistoryMessages = restoredHistory.messages.map((message) => ({
            role: message.role,
            content: message.content,
            kind: message.kind,
            senderName: message.senderName,
            receivedAt: message.receivedAt,
        }));
        this.suppressIdleHistoryReplay = restoredHistory.messages.length > 0;
    }


    private getProbeDirectories(): string[] {
        const dirs = new Set<string>();
        const addDir = (value: string | null | undefined) => {
            const normalized = typeof value === 'string' ? value.trim() : '';
            if (normalized) dirs.add(normalized);
        };

        addDir(this.workingDir);
        try {
            addDir(fs.realpathSync.native(this.workingDir));
        } catch {
            // noop
        }

        return Array.from(dirs);
    }

    private buildSqlPlaceholderList(count: number): string {
        return Array.from({ length: count }, () => '?').join(', ');
    }

    private querySqliteText(dbPath: string, query: string, params: Array<string | number>): string | null {
        try {
            if (this.cachedSqliteDb === null || this.cachedSqliteDbPath !== dbPath) {
                try { this.cachedSqliteDb?.close(); } catch { /* noop */ }
                this.cachedSqliteDb = null;
                this.cachedSqliteDbPath = null;
                const DatabaseSync = getDatabaseSync();
                this.cachedSqliteDb = new DatabaseSync(dbPath, { readOnly: true });
                this.cachedSqliteDbPath = dbPath;
            }
            const row = this.cachedSqliteDb!.prepare(query).get(...params) as { id?: unknown } | undefined;
            const sessionId = typeof row?.id === 'string' ? row.id.trim() : '';
            return sessionId || null;
        } catch {
            // Close cached connection on error so we retry fresh next tick
            try { this.cachedSqliteDb?.close(); } catch { /* noop */ }
            this.cachedSqliteDb = null;
            this.cachedSqliteDbPath = null;
            return null;
        }
    }
}
