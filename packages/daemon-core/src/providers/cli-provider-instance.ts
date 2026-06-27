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
import { shortHash } from '../system/hash.js';
import type { CliProviderModule } from '../cli-adapters/provider-cli-adapter.js';
import { createCliAdapter } from './spec/route.js';
import type { PtyRuntimeMetadata, PtyTransportFactory } from '../cli-adapters/pty-transport.js';
import { StatusMonitor } from './status-monitor.js';
import { ChatHistoryWriter, isNativeSourceCanonicalHistory, materializeProviderNativeHistory, readChatHistory, readProviderChatHistory } from '../config/chat-history.js';
import { LOG } from '../logging/logger.js';
import { traceMeshEventStage, traceMeshEventDrop } from '../mesh/mesh-event-trace.js';
import type { ChatMessage } from '../types.js';
import { buildPersistedProviderEffectMessage, normalizeProviderEffects } from './control-effects.js';
import { formatAutoApprovalMessage, pickApprovalButton, hasNegativeApprovalOption, looksLikeActiveApprovalPromptText } from './approval-utils.js';
import { getCliScriptCommand, parseCliScriptResult } from './cli-script-results.js';
import { mergeProviderPatchState, resolveProviderStateSurface } from './provider-patch-state.js';
import { normalizeProviderSessionId } from './provider-session-id.js';
import { buildChatMessage, buildRuntimeSystemChatMessage, isUserFacingChatMessage, normalizeChatMessages, resolveChatMessageKind, extractFinalSummaryFromMessages } from './chat-message-normalization.js';
import { workingDirBasename } from './working-dir.js';
import { ManualAttendanceTracker } from './manual-attendance.js';

type PersistableCliHistoryMessage = {
    role: string;
    content: string;
    kind?: string;
    senderName?: string;
    receivedAt?: number;
};

// Status snapshots only ever surface the newest messages: the cloud 'live'
// profile drops chat messages entirely (loaded lazily via read_chat on
// subscribe) and the 'full' profile caps activeChat.messages to the last 60
// (see status/normalize.ts). Unread/completion markers walk only the tail.
// So getState()'s saved-history hydration — which runs once per resume/manual
// CLI session on every status report — must read only a bounded tail, not the
// entire transcript. A full MAX_SAFE_INTEGER read here makes the initial
// status report O(transcript) × N(sessions), which is the real cold first-
// connection bottleneck on chat-heavy machines. The window comfortably exceeds
// the 60-message snapshot cap so dedup/collapse at the boundary stays stable.
const STATUS_HYDRATION_TAIL_LIMIT = 200;

type CompletedDebouncePending = {
    chatTitle: string;
    duration: number;
    timestamp: number;
    firstObservedAt: number;
    previousStatus: string;
    loggedBlockReason?: string;
    loggedTranscriptProbe?: boolean;
    transcriptProbeHistory?: ExternalTranscriptProbe[];
    // ARCH-REFACTOR R1: the taskId of the turn that produced this (debounced) completion,
    // captured SYNCHRONOUSLY at the generating→idle transition. The actual completion
    // event is emitted later by the debounce flush, by which point a follow-up task may
    // already have started its own turn and overwritten engine.currentTurnTaskId — so the
    // id must be snapshotted here, not re-read at flush time.
    taskId?: string;
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
    // (SETTLE-VALLEY) When set, suppress the CANON-C decoupled-immediate emit for this
    // missing_final_assistant block and HOLD (retry up to COMPLETED_FINALIZATION_MAX_WAIT_MS)
    // until the native transcript's final assistant turn arrives (block clears → genuine emit)
    // or the worker resumes (resume guard cancels). Set only for the inter-approval idle valley
    // of a native-history mesh worker, where an immediate weak emit would freeze a truncated
    // preamble summary (evidenceLevel=insufficient) into the append-only ledger before the
    // worker's next approval turn resumes. Independent of valley length.
    holdForTranscript?: boolean;
};

type CompletionFinalAssistantEvidence = {
    present: boolean;
    messages: unknown[];
    source: 'parsed' | 'external-native' | 'unavailable';
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
// (FALSEIDLE-BGCHILD-a) Minimum generating→idle settle window for native-history mesh worker
// sessions. Native-history providers (e.g. claude-cli) normally flush the completion with
// flushDelay=0 — the transcript is authoritative, so there is no reason to wait. But a worker
// turn that spawns a BACKGROUND child (e.g. `npm test &`, a backgrounded Bash tool) can paint
// a burst of child output, fall quiet, and have the screen parser read a PRIOR/intermediate
// standard assistant as if the turn were done — firing a false idle while the agent is in fact
// still generating (e.g. mid-commit). With flushDelay=0 there is no window for the resume guard
// in flushCompletedDebounceIfFinalized (latestVisibleStatus !== 'idle' → cancel) to observe the
// agent picking the turn back up. A short non-zero settle window restores that resume guard for
// mesh workers without delaying genuinely-finished turns beyond this bound. Scoped to mesh
// worker sessions so interactive native-history sessions keep the immediate flush.
// 4000ms (was 1500): live measurement showed the completion event can fire 1.6–3s
// BEFORE the worker's final-assistant turn lands in the transcript on a natural
// generating→idle completion (no approval modal), freezing a prior intermediate
// bubble as finalSummary (evidenceLevel=insufficient). The 68a3c324 waiting_approval
// hold only covers the approval-resolved valley; widening this settle window to 4000ms
// covers that race AND the ~3s waiting_approval valley within the settle bound.
const NATIVE_HISTORY_MESH_IDLE_SETTLE_MS = 4000;
// TASKBUBBLE-DUP: window during which an identical user-input ack (same trimmed
// content on the same instance) is treated as a redelivery of one dispatch and
// suppressed from the chat transcript. Matches the coordinator-side
// DUPLICATE_DISPATCH_WINDOW_MS (mesh-tools) so the daemon's bubble-level guard
// covers the same retry horizon as the MCP-level dispatch dedup.
const USER_INPUT_ACK_DEDUP_WINDOW_MS = 60_000;

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
    return status === 'generating' || status === 'streaming' || status === 'no_progress' || status === 'long_generating' || status === 'starting';
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

    /**
     * Quiet period an approval modal's signature must be stable before
     * auto-approve sends the approve key. Guards against firing on a prompt
     * that is still streaming into the PTY (the "resolves too fast" symptom):
     * while the modal text/buttons are still changing, every frame yields a
     * new signature and the settle clock restarts. Once the prompt finishes
     * rendering the signature holds and the key is sent after this window.
     * Bounded + small so genuine approvals stay timely. The FSM is already
     * authoritative over the `waiting_approval` state; this only delays the
     * keystroke until the modal *content* has settled.
     */
    private static readonly AUTO_APPROVE_SETTLE_MS = 600;

    /**
     * Busy-side hysteresis for the settle gate. A momentary `generating` flip
     * while the SAME approval modal's button block is still on screen (its
     * question line scrolled out of the captured frame, only the buttons + a
     * residual `esc to interrupt` spinner remain) briefly reports
     * status!=waiting_approval. Without hysteresis that flip wipes the settle
     * clock, and the modal→generating→modal flap restarts the 600ms window
     * every time so auto-approve never fires. We keep the in-progress settle
     * gate warm across an inactive blip up to this bound; only once the modal
     * has genuinely stayed gone this long (a real resolution → idle) is the
     * gate cleared. Bounded so a genuinely new, later approval still re-settles
     * from scratch rather than firing on a stale timestamp.
     */
    private static readonly AUTO_APPROVE_GATE_HYSTERESIS_MS = 1500;

    /**
     * STATUS-MISMATCH: upper bound on how long the auto-approve→`generating` SURFACE
     * mask may hide a worker's `waiting_approval` (status + activeModal) before we give
     * up and surface the real prompt. The mask exists because auto-approve is expected
     * to resolve the modal momentarily; but if it STALLS without ever calling
     * resolveModal — the modal signature never settles for AUTO_APPROVE_SETTLE_MS (a
     * perpetually-flapping/streaming prompt), no concrete modal is ever captured, or the
     * modal is a picker/non-affirmative we never auto-pick — the mask would persist
     * forever and read_chat / mesh_status / the dashboard would NEVER see the pending
     * approval (the coordinator cannot mesh_approve what it cannot see). Once an episode
     * exceeds this bound we stop masking. Generously larger than
     * AUTO_APPROVE_SETTLE_MS (600) + AUTO_APPROVE_GATE_HYSTERESIS_MS (1500) so a
     * legitimately slow-settling / blip-flapping prompt is never unmasked early; a
     * genuine never-resolving stall surfaces within this window. The settle gate keeps
     * running underneath, so a prompt that finally stabilises still auto-approves, and
     * mesh_approve (raw FSM, unmasked) works throughout.
     */
    private static readonly AUTO_APPROVE_MASK_STALL_MS = 4500;

    private adapter: ProviderCliAdapter;
    private context: InstanceContext | null = null;
    private events: ProviderEvent[] = [];
    private lastStatus: string = 'starting';
    // Idempotency guard for the queue-claim agent:ready event. agent:ready is the
    // sole signal the mesh coordinator's tryAssignQueueTask waits on to hand a
    // queued task to this worker. It is emitted in two places: the boot-time
    // starting→idle one-shot, and the readySeen re-arm below. This flag makes the
    // event fire AT MOST ONCE per session so a worker is never claimed twice and a
    // queued task is never double-dispatched/double-injected. Whichever path fires
    // first sets it; the other becomes a no-op.
    private agentReadyEmitted = false;
    private generatingStartedAt: number = 0;
    private settings: Record<string, any> = {};
    private monitor: StatusMonitor;
    private generatingDebounceTimer: NodeJS.Timeout | null = null;
    private generatingDebouncePending: { chatTitle: string; timestamp: number } | null = null;
    private lastApprovalEventFingerprint = '';
    private autoApproveBusy = false;
    private autoApproveBusyTimer: NodeJS.Timeout | null = null;
    private lastAutoApprovalSignature = '';
    // Settle gate: the approval modal's signature + the wall-clock when this
    // exact signature was first observed. Auto-approve only fires once the
    // SAME signature has been stable for AUTO_APPROVE_SETTLE_MS, so a prompt
    // still streaming into the PTY (its buttons/message changing frame to
    // frame) keeps resetting the timer and is never approved half-rendered.
    private pendingAutoApprovalSignature = '';
    private pendingAutoApprovalSince = 0;
    private autoApproveSettleTimer: NodeJS.Timeout | null = null;
    // Wall-clock when auto-approve first observed status!=waiting_approval while
    // a settle gate was in progress. Drives AUTO_APPROVE_GATE_HYSTERESIS_MS so a
    // brief generating flip does not immediately wipe the settle clock.
    private autoApproveInactiveSince = 0;
    // STATUS-MISMATCH: wall-clock when the CURRENT auto-approve episode (waiting_approval
    // + shouldAutoApprove) first began wanting to mask. Unlike pendingAutoApprovalSince it
    // is NOT reset when the modal signature changes (a still-streaming/flapping prompt) and
    // survives the same hysteresis blips the settle gate does, so it measures the TRUE age
    // of an unresolved auto-approve. Once it exceeds AUTO_APPROVE_MASK_STALL_MS the surface
    // mask is dropped so the real waiting_approval surfaces. Cleared when the episode ends
    // (modal genuinely gone, manual attendance takes over, or auto-approve fires).
    private autoApproveMaskSince = 0;
    // Provider-common manual-attendance signal: while a human is actively driving
    // this session from the dashboard, auto-approve holds so they can take manual
    // control. Background mesh workers are never attended → delegated auto-approve
    // is unaffected.
    private readonly manualAttendance = new ManualAttendanceTracker();
    private controlValues: Record<string, string | number | boolean> = {};
    private summaryMetadata: unknown = undefined;
    private appliedEffectKeys = new Set<string>();
    private historyWriter: ChatHistoryWriter;
    private runtimeMessages: Array<{ key: string; message: ChatMessage }> = [];
    private lastPersistedHistoryMessages: PersistableCliHistoryMessage[] = [];
    private lastAcknowledgedUserInputAt = 0;
    // TASKBUBBLE-DUP: per-content last-ack timestamps so the same dispatched
    // prompt acked twice in quick succession (the worker buffers the first
    // send during bootstrap/busy, then a redelivery — dispatch-confirm-timeout
    // requeue or a reconcile re-dispatch — fires a SECOND send_chat before the
    // outbound queue drains) collapses to ONE user bubble. Keyed on the trimmed
    // content; an entry older than USER_INPUT_ACK_DEDUP_WINDOW_MS is treated as
    // a fresh, intentional resend and is NOT suppressed.
    private recentUserInputAcks = new Map<string, number>();
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
            noProgressAlert: (this.settings.noProgressAlert ?? this.settings.longGeneratingAlert) !== false,
            noProgressThresholdSec: this.settings.noProgressThresholdSec ?? this.settings.longGeneratingThresholdSec ?? 180,
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
        const nowMs = Date.now();
        // STATUS-MISMATCH: maybeAutoApproveStatus still runs for its side effects (settle gate,
        // resolveModal fire), but the SURFACE mask is dropped once the episode has stalled past
        // AUTO_APPROVE_MASK_STALL_MS — otherwise a never-settling auto-approve hides the worker's
        // waiting_approval + modal from read_chat/mesh_status/dashboard forever.
        const autoApproveActive = this.maybeAutoApproveStatus(adapterStatus, nowMs)
            && !this.autoApproveMaskStalled(nowMs);
        const autoApproveHoldIdle = this.autoApproveBusy && adapterStatus.status === 'idle';
        let visibleStatus = parseErrorMessage || parsedStatus?.status === 'error'
            ? 'error'
            : (autoApproveActive || autoApproveHoldIdle ? 'generating' : adapterStatus.status);
        // getState() must agree with the status the FSM-driven detectStatusTransition()
        // already committed to lastStatus. The adapter's own status is authoritative; we do
        // not second-guess it with native-transcript shape. Only reconcile a generating-like
        // read down to idle when our own lastStatus has already flipped idle (avoids a
        // perpetual dashboard spinner during the brief window before the next getStatus()).
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

        const dirName = workingDirBasename(this.workingDir);
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
            if (!suppressStaleParsedBusyStatus && (parsedChatStatus === 'generating' || parsedChatStatus === 'no_progress' || parsedChatStatus === 'long_generating')) {
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
        const nowMs = Date.now();
        // STATUS-MISMATCH: drop the mask once the auto-approve episode has stalled (see getState).
        const autoApproveActive = this.autoApproveEffectivelyActive(adapterStatus.status, nowMs)
            && !this.autoApproveMaskStalled(nowMs);
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
        const nowMs = Date.now();
        // STATUS-MISMATCH: drop the mask once the auto-approve episode has stalled (see getState).
        const autoApproveActive = this.autoApproveEffectivelyActive(adapterStatus.status, nowMs)
            && !this.autoApproveMaskStalled(nowMs);
        const autoApproveHoldIdle = this.autoApproveBusy && adapterStatus.status === 'idle';
        const visibleStatus = autoApproveActive || autoApproveHoldIdle ? 'generating' : adapterStatus.status;
        const dirName = workingDirBasename(this.workingDir);
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
        // Merge semantics: a key omitted from newSettings preserves its existing
        // value, a key present in newSettings (even as false) overrides it.
        //
        // This is required because updateSettings has two callers with opposite
        // intent:
        //   1. Full re-injection — the dashboard toggle path (handleSetProviderSetting
        //      → getSettings → updateInstanceSettings) sends the COMPLETE settings
        //      object, so an explicit autoApprove:false must win.
        //   2. Partial stamp — the mesh relay-safety stamp (router.ts agent_command,
        //      buildMeshWorkerRelayStamp) sends ONLY {meshNodeFor, meshNodeId,
        //      meshCoordinatorDaemonId, launchedByCoordinator} on every coordinator
        //      re-dispatch. It carries no autoApprove, so a full replacement would
        //      wipe the launch-time autoApprove:true the worker was started with,
        //      silently dropping every later approval to a manual gate until the
        //      machine-page toggle re-injected the full settings.
        //
        // A plain merge satisfies both: undefined keys fall through to the existing
        // value (preserving launch-stamp settings like autoApprove + the mesh routing
        // keys), explicit keys override. This subsumes the previous mesh-key preserve
        // list, which only protected the routing keys and not autoApprove.
        this.settings = { ...this.settings, ...newSettings };
        this.adapter.updateRuntimeSettings?.(this.settings);
        this.monitor.updateConfig({
            approvalAlert: this.settings.approvalAlert !== false,
            noProgressAlert: (this.settings.noProgressAlert ?? this.settings.longGeneratingAlert) !== false,
            noProgressThresholdSec: this.settings.noProgressThresholdSec ?? this.settings.longGeneratingThresholdSec ?? 180,
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
    attachMeshAssignment(assignment: { meshId: string; nodeId?: string; taskId?: string; coordinatorDaemonId?: string; coordinatorSessionId?: string }): void {
        if (!assignment?.meshId) return;
        this.settings = {
            ...this.settings,
            meshNodeFor: assignment.meshId,
            // WTCLAIM (A): track the bound node id under BOTH the active marker
            // (meshNodeId, cleared on detach) and a sticky marker (meshLastNodeId,
            // preserved across detach). The sticky marker lets a detached but still
            // coordinator-owned session be re-picked ONLY for the SAME node it served
            // — never auto-adopted for a sibling node (e.g. a cloned worktree) that
            // shares this daemon. See isMeshOwnedDelegateSession's post-detach gate.
            ...(assignment.nodeId ? { meshNodeId: assignment.nodeId, meshLastNodeId: assignment.nodeId } : {}),
            ...(assignment.taskId ? { meshActiveTaskId: assignment.taskId } : {}),
            ...(assignment.coordinatorDaemonId ? { meshCoordinatorDaemonId: assignment.coordinatorDaemonId } : {}),
            // Session-level routing anchor: the originating coordinator session, so this
            // worker's completion events route back to the exact session that dispatched it.
            ...(assignment.coordinatorSessionId ? { meshCoordinatorSessionId: assignment.coordinatorSessionId } : {}),
        };
        this.adapter.updateRuntimeSettings?.(this.settings);
    }

    /**
     * Clear a previously-attached mesh assignment after the task reaches a
     * terminal state. Leaving meshNodeFor pinned would route this session's
     * subsequent unrelated turns (e.g. ad-hoc dashboard chats) to the
     * coordinator as if they were task completions.
     *
     * MESHID-DROP-ON-DETACH (Fix C): a coordinator-LAUNCHED worker session
     * (launchedByCoordinator) holds its mesh membership (meshNodeFor / meshNodeId /
     * meshCoordinatorDaemonId) at the SESSION level — set once at launch
     * (mesh_launch_session / queue auto-launch), independent of any single task.
     * The original detach wiped meshNodeFor + meshNodeId together with the
     * task-level meshActiveTaskId, so the FIRST task completion stripped the
     * membership and EVERY subsequent completion forwarded with meshId absent —
     * resolveWorkerDelegateRouting fell to mesh_unresolved and the coordinator
     * rejected the forward "meshId required". For a launched member we therefore
     * clear ONLY the task-level marker (meshActiveTaskId) and preserve the
     * session-level membership so its next task's completion still resolves.
     * A task-less ad-hoc turn on a preserved-membership session is NOT misrouted:
     * its completion carries no taskId and the session holds no active assignment,
     * so the forwarder's WARMUPGAP guard skips the dispatch-row flip (it only
     * injects a benign task-less notification). A NON-launched session (a plain CLI
     * session adopted by mesh_send_task --direct, launchedByCoordinator falsy)
     * keeps the original full clear so an ad-hoc session is never left pinned.
     */
    detachMeshAssignment(): void {
        if (!this.settings.meshNodeFor && !this.settings.meshActiveTaskId && !this.settings.meshNodeId) return;
        // Session-level member: keep membership, drop only the task-level marker.
        if (this.settings.launchedByCoordinator === true) {
            if (!this.settings.meshActiveTaskId) return;
            const { meshActiveTaskId, ...rest } = this.settings;
            void meshActiveTaskId;
            this.settings = rest;
            this.adapter.updateRuntimeSettings?.(this.settings);
            return;
        }
        const { meshNodeFor, meshNodeId, meshActiveTaskId, ...rest } = this.settings;
        void meshNodeFor; void meshActiveTaskId;
        // WTCLAIM (A): clear the active binding but PRESERVE the last bound node id
        // (meshLastNodeId) so a later sessionless dispatch can re-adopt this idle
        // session ONLY for the node it last served. Carry the id being cleared, or
        // keep an already-present sticky marker if meshNodeId was absent.
        const lastNodeId = (typeof meshNodeId === 'string' && meshNodeId.trim())
            ? meshNodeId.trim()
            : (typeof rest.meshLastNodeId === 'string' && rest.meshLastNodeId.trim() ? rest.meshLastNodeId.trim() : undefined);
        this.settings = lastNodeId ? { ...rest, meshLastNodeId: lastNodeId } : rest;
        this.adapter.updateRuntimeSettings?.(this.settings);
    }

    /**
     * The resolved modal-park status of this session, or null when it is not
     * parked on a modal awaiting a human answer. Mirrors the overlay logic in
     * getState(): an active AskUserQuestion interactive prompt resolves to
     * waiting_choice; otherwise the adapter's waiting_approval (tool consent)
     * counts — UNLESS auto-approve will dismiss it, in which case the session is
     * effectively generating and is NOT modal-parked. This is the single signal
     * the mesh force-inject guard consults, and the same status string the
     * reconcile loop reads off get_status_metadata. Lowercase literals only —
     * the SessionStatus enum is forked across modules and waiting_choice is
     * absent from some of them.
     */
    resolveModalParkStatus(): 'waiting_choice' | 'waiting_approval' | null {
        if (this.activeInteractivePrompt) return 'waiting_choice';
        let adapterStatus: { status?: string };
        try {
            adapterStatus = this.adapter.getStatus({ allowParse: false });
        } catch {
            return null;
        }
        // A session whose auto-approve is held by manual attendance IS parked on a
        // modal awaiting the human — autoApproveEffectivelyActive folds that in, so
        // the mesh force-inject guard correctly treats it as modal-parked. STATUS-MISMATCH:
        // a STALLED auto-approve (never resolving) is likewise effectively parked — treat it
        // as modal-parked so its events are held/surfaced rather than masked behind generating.
        if (adapterStatus.status === 'waiting_approval'
            && (!this.autoApproveEffectivelyActive(adapterStatus.status) || this.autoApproveMaskStalled())) {
            return 'waiting_approval';
        }
        return null;
    }

    /** True when this session is parked on a modal awaiting a human answer. */
    isModalParked(): boolean {
        return this.resolveModalParkStatus() !== null;
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
                // Modal guard: a force-inject still writes raw keystrokes into the PTY,
                // bypassing the busy send-guard. If the coordinator is parked on a
                // harness modal (claude-cli AskUserQuestion → waiting_choice, or a
                // tool-consent waiting_approval), those keystrokes are consumed by the
                // modal's key handler and silently select a choice the user never made
                // (data corruption). Hold the force-inject in that narrow window —
                // the event stays queued and the reconcile loop redelivers it on the
                // next tick once the modal is resolved. We ONLY hold for the two modal
                // states; generating is still force-injected (that is the deadlock the
                // force path exists to break — see mesh-events-coordinator).
                if (force && this.isModalParked()) {
                    LOG.info('CLI', `[${this.type}] force send_message held — coordinator parked on modal (${this.resolveModalParkStatus()})`);
                    return;
                }
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

        // TASKBUBBLE-DUP: collapse a redelivered dispatch to one bubble. A single
        // mesh_send_task can reach this instance as TWO send_chat calls when the
        // first injection is buffered during bootstrap/busy and a retry (dispatch-
        // confirm-timeout requeue, or a reconcile re-dispatch) fires before the
        // outbound queue drains. The previous dedupKey hashed receivedAt, so the
        // two acks produced different keys and BOTH bubbled. Suppress an identical
        // content ack seen within USER_INPUT_ACK_DEDUP_WINDOW_MS; a later resend of
        // the same text (beyond the window) is a genuine new turn and still shows.
        const ackContentKey = shortHash(`${this.instanceId}:${content}`, 24);
        const lastAckAt = this.recentUserInputAcks.get(ackContentKey);
        if (lastAckAt !== undefined && receivedAt - lastAckAt <= USER_INPUT_ACK_DEDUP_WINDOW_MS) {
            // Refresh the timestamp so a steady stream of redeliveries keeps
            // collapsing, and prune stale entries to bound the map size.
            this.recentUserInputAcks.set(ackContentKey, receivedAt);
            this.pruneRecentUserInputAcks(receivedAt);
            return;
        }
        this.recentUserInputAcks.set(ackContentKey, receivedAt);
        this.pruneRecentUserInputAcks(receivedAt);

        this.lastAcknowledgedUserInputAt = receivedAt;
        // The runtimeMessages dedupKey stays per-call unique (includes receivedAt)
        // so a genuine resend of the same text after the window appends a fresh
        // bubble; redelivery within the window is already suppressed above.
        const dedupKey = `user_input_ack:${shortHash(`${this.instanceId}:${content}:${receivedAt}`, 24)}`;
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

    /** Drop user-input ack entries older than the dedup window so the map can't grow unbounded. */
    private pruneRecentUserInputAcks(now: number): void {
        if (this.recentUserInputAcks.size <= 1) return;
        for (const [key, at] of this.recentUserInputAcks) {
            if (now - at > USER_INPUT_ACK_DEDUP_WINDOW_MS) this.recentUserInputAcks.delete(key);
        }
    }

    dispose(): void {
        this.adapter.shutdown();
        this.monitor.reset();
        // Cancel any armed auto-approve timers so a pending settle re-check
        // can't fire resolveModal/detectStatusTransition against a dead adapter.
        if (this.autoApproveSettleTimer) { clearTimeout(this.autoApproveSettleTimer); this.autoApproveSettleTimer = null; }
        if (this.autoApproveBusyTimer) { clearTimeout(this.autoApproveBusyTimer); this.autoApproveBusyTimer = null; }
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
        // For native-source providers (claude-cli: chatMessagesOwnedExternally), the PTY
        // screen parse is NOT the source of truth for the final summary — the terminal
        // wraps/scrolls/clips text, so a screen-parsed assistant message is often a partial
        // prefix (e.g. 76 chars of a 112-char turn). The append-only native transcript holds
        // the complete turn. Prefer it whenever it yields a longer/complete summary; fall back
        // to the parsed screen only when the transcript is unavailable. This is the real cause
        // of the truncated finalSummary — independent of cloud vs standalone (it surfaces on
        // any short, fast-completing task where screen parse wins the race).
        const adapterOwnsMessagesElsewhere = (this.adapter as any)?.chatMessagesOwnedExternally === true;
        const parsedSummary = extractFinalSummaryFromMessages(
            (this.completionHasFinalAssistantMessage(parsedMessages)
                ? (Array.isArray(parsedMessages) ? parsedMessages : [])
                : []) as any,
        );
        if (adapterOwnsMessagesElsewhere) {
            const externalMessages = this.readExternalCompletionMessages();
            const externalSummary = externalMessages
                ? extractFinalSummaryFromMessages(externalMessages as any)
                : '';
            // The transcript is authoritative for native-source providers. Use it unless it is
            // empty (not yet written) — only then fall back to whatever the screen parsed.
            if (externalSummary) return externalSummary;
            return parsedSummary || undefined;
        }
        return parsedSummary || undefined;
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

    private getCompletedFinalizationBlock(latestVisibleStatus: string, pending: CompletedDebouncePending): CompletedFinalizationBlock | null {
        if (latestVisibleStatus !== 'idle') return { reason: `status:${latestVisibleStatus}`, terminal: true };

        const adapterAny = this.adapter as any;
        const approvalResolvedIdle = pending.previousStatus === 'waiting_approval';
        if (!approvalResolvedIdle) {
            if (adapterAny?.isWaitingForResponse === true) return { reason: 'adapter_waiting_for_response', terminal: true };
            if (adapterAny?.currentTurnScope) return { reason: 'adapter_turn_scope_active', terminal: true };
            if (this.hasAdapterPendingResponse()) return { reason: 'adapter_pending_response', terminal: true };
        }

        const partial = typeof this.adapter.getPartialResponse === 'function'
            ? this.adapter.getPartialResponse()
            : '';
        if (typeof partial === 'string' && partial.trim()) return { reason: 'partial_response_pending', terminal: true };

        let parsed: any;
        try {
            parsed = this.adapter.getScriptParsedStatus();
        } catch (error: any) {
            return { reason: `parse_error:${error?.message || String(error)}` };
        }

        const parsedStatus = typeof parsed?.status === 'string' ? parsed.status : 'unknown';
        if (parsedStatus !== 'idle') {
            const adapterStatus = this.adapter.getStatus({ allowParse: false });
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
                    // (SETTLE-VALLEY) The inter-approval idle valley: a native-history mesh worker
                    // that resolved an approval and fell briefly idle (waiting_approval→idle) BEFORE
                    // the next approval turn resumes. The live valley (~3s) is mostly covered by the
                    // 4000ms NATIVE_HISTORY_MESH_IDLE_SETTLE_MS settle window, but a longer valley can
                    // still let the flush run while the transcript's final assistant turn is not yet
                    // written (source still the screen parse → finalAssistantPresent=false,
                    // workerResult.source='default'). CANON-C would emit immediately here, freezing a
                    // truncated preamble summary as evidenceLevel=insufficient. Instead HOLD: this
                    // waiting_approval hold complements the settle window. Retry until the transcript finalizes
                    // (block clears → genuine emit) or the worker resumes (resume guard cancels),
                    // bounded by COMPLETED_FINALIZATION_MAX_WAIT_MS. Scoped to the approval-resolved
                    // idle so a genuinely-finished background-child turn keeps the CANON-C immediate
                    // emit (its transcript trails by a write, not by a whole resume).
                    if (allowMissingAssistantTimeout && pending.previousStatus === 'waiting_approval') {
                        return { reason: 'missing_final_assistant', terminal: false, holdForTranscript: true };
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

        // (FALSEIDLE-a) Structural approval-resolution gate. Runs BEFORE the brittle
        // screen-text heuristic below so it also catches modals whose text does not match
        // looksLikeActiveApprovalPromptText (e.g. claude-cli's cd / "untrusted hooks" prompt).
        const approvalResolutionBlock = this.approvalResolutionFinalizationBlock(pending);
        if (approvalResolutionBlock) return approvalResolutionBlock;

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

    // (FALSEIDLE-a) Positive, structural proof that the latest approval entry was resolved
    // through ADHDev. resolveModal() — driven by auto-approve, dashboard/mesh_approve, and
    // dev-cli-debug alike — advances the engine's lastResolvedEntrySeq to the current
    // approvalEntrySeq. So `lastResolvedEntrySeq >= approvalEntrySeq` (with a real entry,
    // approvalEntrySeq > 0) means the modal we last saw was actually answered. Absence of this
    // evidence after a waiting_approval→idle transition means the idle is suspect: the spec's
    // text-based approval→idle rule false-tripped while the modal is still unresolved.
    // Fails OPEN (returns true) when the seq fields are unavailable, so the gate can never wedge
    // a session on a provider/adapter that does not surface the counters.
    private hasApprovalResolutionEvidence(): boolean {
        try {
            const status = this.adapter.getStatus({ allowParse: false }) as any;
            const entrySeq = typeof status?.approvalEntrySeq === 'number' ? status.approvalEntrySeq : 0;
            if (entrySeq <= 0) return true;
            const resolvedSeq = typeof status?.lastResolvedEntrySeq === 'number' ? status.lastResolvedEntrySeq : undefined;
            if (resolvedSeq === undefined) return true;
            return resolvedSeq >= entrySeq;
        } catch {
            return true;
        }
    }

    // (FALSEIDLE-a) Hold a completion that is the anomalous DIRECT waiting_approval→idle
    // transition with no positive resolution evidence. A genuinely resolved approval routes
    // through resolveModal → setStatus('generating'), so its completion's previousStatus is
    // 'generating' (not 'waiting_approval') and this gate never fires for it. Scoped to
    // delegated mesh/coordinator sessions — whose only modal-resolution path is auto-approve /
    // mesh_approve (both advance lastResolvedEntrySeq) — so an interactive local session, where
    // a human may answer the PTY prompt directly and leave no resolveModal record, is untouched.
    // Non-terminal: the hold is bounded by COMPLETED_FINALIZATION_MAX_WAIT_MS (30s), giving a
    // settling auto-approve time to fire and advance the seq, and guaranteeing no permanent wedge
    // if resolution ever happens via a path that does not record evidence.
    private approvalResolutionFinalizationBlock(pending: CompletedDebouncePending): CompletedFinalizationBlock | null {
        if (pending.previousStatus !== 'waiting_approval') return null;
        const meshContext = !!(this.settings.meshNodeFor || this.settings.meshActiveTaskId || this.settings.launchedByCoordinator);
        if (!meshContext) return null;
        if (this.hasApprovalResolutionEvidence()) return null;
        return { reason: 'approval_resolution_unconfirmed', terminal: false };
    }

    private scheduleCompletedDebounceFlush(delayMs: number): void {
        if (this.completedDebounceTimer) clearTimeout(this.completedDebounceTimer);
        this.completedDebounceTimer = setTimeout(() => this.flushCompletedDebounceIfFinalized(), delayMs);
    }

    // EVTTRACE (observation-only): is this a mesh worker session whose completion
    // events must route to a coordinator? Used purely to gate trace logging so a
    // non-mesh CLI session's completions don't add EvtTrace noise. No decision logic.
    private isMeshWorkerSession(): boolean {
        return !!(this.settings.meshNodeFor || this.settings.meshActiveTaskId
            || this.settings.meshNodeId || this.settings.launchedByCoordinator);
    }

    /**
     * ARCH-REFACTOR R1: the taskId to attribute the CURRENTLY-completing turn to.
     * Prefers the per-turn binding (engine.currentTurnTaskId, set when the turn was
     * submitted and surviving until the next turn starts) over the last-write-wins
     * session scalar (settings.meshActiveTaskId). The scalar is retained only as a
     * backward-compat alias for the "current/last assignment" and is the source of the
     * NOTIF-MISDELIVER / TASK-MSG-MISROUTE race: a second task attaching before this
     * turn completes overwrites it. Returns undefined for a non-task ad-hoc turn.
     */
    private completingTurnTaskId(): string | undefined {
        const turnTaskId = this.adapter?.currentTurnTaskId;
        if (typeof turnTaskId === 'string' && turnTaskId.trim()) return turnTaskId;
        const scalar = this.settings.meshActiveTaskId;
        return typeof scalar === 'string' && scalar.trim() ? scalar : undefined;
    }

    // EVTTRACE correlation context for this session's completion lifecycle. taskId is
    // the primary grep anchor; instanceId is the session fallback.
    private meshTraceCtx(event = 'agent:generating_completed'): Record<string, unknown> {
        return {
            // ARCH-REFACTOR R1: trace the per-turn taskId (falling back to the scalar) so
            // EvtTrace anchors on the same id the completion event actually carries.
            taskId: this.completingTurnTaskId(),
            sessionId: this.instanceId,
            nodeId: this.settings.meshNodeId,
            meshId: this.settings.meshNodeFor,
            event,
        };
    }

    private flushCompletedDebounceIfFinalized(): void {
        const pending = this.completedDebouncePending;
        if (!pending) {
            this.completedDebounceTimer = null;
            return;
        }

        const latestStatus = this.adapter.getStatus({ allowParse: false });
        const latestAutoApproveActive = latestStatus.status === 'waiting_approval' && this.shouldAutoApprove();
        const latestVisibleStatus = latestAutoApproveActive || this.autoApproveBusy ? 'generating' : latestStatus.status;
        LOG.debug('CLI', `[${this.type}] flush attempt: adapterStatus=${latestStatus.status} latestVisible=${latestVisibleStatus} generatingStartedAt=${this.generatingStartedAt} isWaitingForResponse=${!!(this.adapter as any)?.isWaitingForResponse} hasPartial=${!!this.adapter.getPartialResponse?.()}`);
        if (latestVisibleStatus !== 'idle') {
            LOG.info('CLI', `[${this.type}] cancelled pending completed (resumed ${latestVisibleStatus})`);
            this.completedDebouncePending = null;
            this.completedDebounceTimer = null;
            return;
        }

        const block = this.getCompletedFinalizationBlock(latestVisibleStatus, pending);
        if (block) {
            const blockReason = block.reason;
            const waitedMs = Date.now() - pending.firstObservedAt;
            // CANON-C (completion-gate decouple): a block carrying `allowTimeout` is the
            // transcript-evidence gate — the worker FSM has ALREADY reached idle and the only
            // thing missing is the append-only transcript's final assistant turn (a native-source
            // race: claude-cli owns its history externally and the file write trails the idle
            // transition). `allowTimeout` is set ONLY on the missing_final_assistant block, and
            // ONLY for mesh worker sessions (meshNodeFor / meshActiveTaskId / launchedByCoordinator).
            // The coordinator's sole path to learn this session is idle is agent:generating_completed,
            // so holding it up to COMPLETED_FINALIZATION_MAX_WAIT_MS (30s) leaves the coordinator
            // false-generating while the worker is done. Decouple the idle NOTIFICATION from the
            // transcript evidence: emit the completion immediately, marked weak
            // (completionDiagnostic.blockReason=missing_final_assistant, finalAssistantPresent=false).
            // The finalSummary is enriched on a SEPARATE path — the mesh reconcile loop reads the
            // transcript once written and re-emits a GENUINE completion (CANON-B weak→genuine
            // upgrade; buildPendingEventFingerprint keeps weak and genuine distinct so the enriched
            // one still surfaces, and isFalseIdleCompletion keeps the direct dispatch active until
            // then). All OTHER blocks (genuinely-busy adapter/partial/parsed states, transient
            // parse_error) keep the existing terminal-hold / 30s-retry behavior unchanged.
            //
            // (SETTLE-VALLEY) Exception: a `holdForTranscript` block is the inter-approval idle
            // valley of a native-history mesh worker (waiting_approval→idle that will resume into
            // the next approval). It deliberately does NOT carry allowTimeout, so it falls into the
            // hold-and-retry path below (terminal:false) rather than the CANON-C immediate emit —
            // the retry loop re-runs the resume guard each cycle, so when the worker resumes the
            // pending completion is cancelled, and when the transcript's final assistant arrives the
            // block clears for a GENUINE emit. This blocks the truncated weak (insufficient) summary
            // from ever being emitted during the valley, without depending on the valley's length.
            const isTranscriptEvidenceGate = block.allowTimeout === true;
            LOG.debug('CLI', `[${this.type}] finalization block: reason=${blockReason} terminal=${block.terminal} allowTimeout=${isTranscriptEvidenceGate} waitedMs=${waitedMs} maxWait=${COMPLETED_FINALIZATION_MAX_WAIT_MS}`);
            if (!isTranscriptEvidenceGate && (block.terminal || waitedMs < COMPLETED_FINALIZATION_MAX_WAIT_MS)) {
                if (pending.loggedBlockReason !== blockReason) {
                    LOG.info('CLI', `[${this.type}] waiting to emit completed until transcript finalizes (${blockReason})`);
                    // EVTTRACE: completion held by the finalization gate (CANON-C). Observation
                    // only — does not change the hold decision above.
                    if (this.isMeshWorkerSession()) {
                        traceMeshEventDrop('completion_gate_hold', this.meshTraceCtx(), `${blockReason} waited=${waitedMs}ms`);
                    }
                    pending.loggedBlockReason = blockReason;
                }
                this.scheduleCompletedDebounceFlush(COMPLETED_FINALIZATION_RETRY_MS);
                return;
            }
            const emittedAfterFinalizationTimeout = waitedMs >= COMPLETED_FINALIZATION_MAX_WAIT_MS;
            const completionDiagnostic = this.buildCompletedFinalizationDiagnostic({
                blockReason,
                latestStatus,
                latestVisibleStatus,
                waitedMs,
                pending,
                emittedAfterFinalizationTimeout,
            });
            // Surface the CANON-C immediate-emit path distinctly so a delegated worker's idle
            // notification (transcript still pending) is not mistaken for a 30s-timeout fallback.
            (completionDiagnostic as Record<string, unknown>).decoupledImmediateEmit = isTranscriptEvidenceGate && !emittedAfterFinalizationTimeout;
            LOG.warn('CLI', `[${this.type}] emitting completed event (${isTranscriptEvidenceGate && !emittedAfterFinalizationTimeout ? 'CANON-C decoupled-immediate, transcript pending' : `after ${waitedMs}ms`}) without finalized assistant turn (${blockReason})`);
            // EVTTRACE: completion fired (forced past the finalization timeout / CANON-C decoupled-immediate).
            if (this.isMeshWorkerSession()) {
                traceMeshEventStage('fired', this.meshTraceCtx(), `forced after ${waitedMs}ms (${blockReason})`);
            }
            this.pushEvent({
                event: 'agent:generating_completed',
                chatTitle: pending.chatTitle,
                duration: pending.duration,
                timestamp: pending.timestamp,
                // ARCH-REFACTOR R1: attribute to the turn captured at idle-transition.
                ...(pending.taskId ? { taskId: pending.taskId } : {}),
                // When finalization is forced past the timeout on a `parsed_status:` block
                // (the parser never confirmed a final assistant turn) we previously rode an
                // empty `finalSummary` unconditionally. That empty value propagates to the
                // mesh coordinator's mirror preview (meshSessionLastMessagePreview), leaving a
                // delegated session's inbox preview blank — or, for a LOCAL worktree session,
                // stuck on the dispatched user task. If the parser DID surface assistant text,
                // prefer it; only fall back to '' when no assistant summary can be derived.
                finalSummary: blockReason.startsWith('parsed_status:')
                    ? (this.completionFinalSummary(this.adapter?.getScriptParsedStatus()?.messages) ?? '')
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
        // EVTTRACE: completion fired (transcript finalized cleanly).
        if (this.isMeshWorkerSession()) {
            traceMeshEventStage('fired', this.meshTraceCtx(), `duration=${pending.duration}s`);
        }
        this.pushEvent({
            event: 'agent:generating_completed',
            chatTitle: pending.chatTitle,
            duration: pending.duration,
            timestamp: pending.timestamp,
            // ARCH-REFACTOR R1: attribute to the turn captured at idle-transition.
            ...(pending.taskId ? { taskId: pending.taskId } : {}),
            finalSummary: this.completionFinalSummary(this.adapter?.getScriptParsedStatus()?.messages),
        });
        this.completedDebouncePending = null;
        this.completedDebounceTimer = null;
        this.generatingStartedAt = 0;
        this.lastApprovalEventFingerprint = '';
    }

    private maybeAutoApproveStatus(adapterStatus: any, now = Date.now()): boolean {
        // Manual-attendance suppression (provider-common): when a human is
        // actively driving this session from the dashboard, hold auto-approve so
        // the modal stays visible and they can pick a button / use the controlbar
        // themselves. Return false (NOT auto-approving) so getState keeps the
        // modal surfaced. Clear any in-progress settle gate — a genuine fire
        // after the window lapses must re-settle from scratch — and arm a
        // re-check for the lapse moment, because the PTY may have gone silent and
        // would otherwise never re-drive this decision. Background mesh workers
        // are never attended, so their delegated auto-approve is untouched.
        if (adapterStatus?.status === 'waiting_approval'
            && this.shouldAutoApprove()
            && this.manualAttendance.isAttended(now)) {
            this.lastAutoApprovalSignature = '';
            this.pendingAutoApprovalSignature = '';
            this.pendingAutoApprovalSince = 0;
            this.autoApproveInactiveSince = 0;
            // Manual attendance takes over — the modal stays surfaced (maybeAutoApproveStatus
            // returns false), so end the mask episode.
            this.autoApproveMaskSince = 0;
            if (this.autoApproveSettleTimer) clearTimeout(this.autoApproveSettleTimer);
            this.autoApproveSettleTimer = setTimeout(() => {
                this.autoApproveSettleTimer = null;
                this.recheckAutoApproveSettled();
            }, this.manualAttendance.remainingMs(now) + 20);
            return false;
        }
        const autoApproveActive = adapterStatus?.status === 'waiting_approval' && this.shouldAutoApprove();
        // Guard re-entry: onStatusChange/getState can observe the same modal multiple
        // times while the PTY absorbs the approval key. Without this flag, repeated
        // snapshots would write stray keys into the input once the modal dismisses.
        // However, Claude Code can present a second approval immediately after the
        // first. Resolve a changed modal signature even while the previous write is
        // still inside the short busy window.
        if (!autoApproveActive) {
            this.lastAutoApprovalSignature = '';
            // Hysteresis: if a settle gate is mid-progress, a momentary
            // status!=waiting_approval blip (a generating flip while the same
            // modal's button block is still on screen) must NOT wipe the settle
            // clock — otherwise the modal→generating→modal flap restarts the
            // 600ms window every time and auto-approve never fires. Keep the
            // gate warm for AUTO_APPROVE_GATE_HYSTERESIS_MS; re-arm a timer so
            // that if the modal does NOT come back the gate is cleared on the
            // re-check (a genuine resolution → idle frees the gate normally).
            if (this.pendingAutoApprovalSince) {
                if (!this.autoApproveInactiveSince) this.autoApproveInactiveSince = now;
                const goneForMs = now - this.autoApproveInactiveSince;
                if (goneForMs < CliProviderInstance.AUTO_APPROVE_GATE_HYSTERESIS_MS) {
                    if (this.autoApproveSettleTimer) clearTimeout(this.autoApproveSettleTimer);
                    this.autoApproveSettleTimer = setTimeout(() => {
                        this.autoApproveSettleTimer = null;
                        this.recheckAutoApproveSettled();
                    }, CliProviderInstance.AUTO_APPROVE_GATE_HYSTERESIS_MS - goneForMs + 20);
                    return autoApproveActive;
                }
            }
            // Clear the settle gate so the next approval starts its own quiet
            // window from scratch (a stale timestamp would let it fire instantly).
            this.pendingAutoApprovalSignature = '';
            this.pendingAutoApprovalSince = 0;
            this.autoApproveInactiveSince = 0;
            // Modal has genuinely been gone past the hysteresis window → the episode ended;
            // end the mask episode too (a later approval starts a fresh stall clock).
            this.autoApproveMaskSince = 0;
            if (this.autoApproveSettleTimer) { clearTimeout(this.autoApproveSettleTimer); this.autoApproveSettleTimer = null; }
            return autoApproveActive;
        }
        // Active approval observed — reset the inactivity tracker so a later
        // blip starts its hysteresis window fresh.
        this.autoApproveInactiveSince = 0;
        // STATUS-MISMATCH: start (or keep) the mask-stall clock for this episode. Set ONLY
        // when zero so it survives modal-signature changes and hysteresis blips — it measures
        // the true age of the unresolved auto-approve, not the per-signature settle window.
        if (!this.autoApproveMaskSince) this.autoApproveMaskSince = now;
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
        // Picker/confirm exclusion (provider-common). A /model or /mode picker is
        // surfaced with status=waiting_approval so the dashboard shows it, but it
        // has no "correct" answer to auto-pick — blindly selecting the first
        // option silently switches the model (the "always Opus, before I even
        // choose" bug). Two independent gates, BOTH must pass to fire:
        //
        //   (1) modal_kind — the spec/FSM tells us this is an 'approval' modal,
        //       not a 'picker'/'confirm'. A modal whose kind is unknown (legacy
        //       adapter, or a spec that predates modal_kind) reads as 'approval'
        //       so genuine approvals keep auto-approving; only an explicit
        //       'picker'/'confirm' is excluded here.
        //   (2) structural anchor — a real approval offers an affirmative AND a
        //       decline option (pickApprovalButton finds a positive that isn't a
        //       decline, and hasNegativeApprovalOption confirms a No/Cancel/Deny
        //       is present). A model picker ("1. Default  2. Opus  3. Sonnet")
        //       has no decline, so even an un-migrated picker is caught here.
        //
        // Mirrors the SDK v1 detect-status approval heuristic (detect-status.ts).
        const modalKind = typeof modal?.kind === 'string' ? modal.kind : 'approval';
        if (modalKind !== 'approval') {
            // Picker/confirm — leave it for the user; keep the modal surfaced.
            return autoApproveActive;
        }
        const { index: buttonIndex, label: buttonLabel } = pickApprovalButton(buttons, this.provider);
        if (buttonIndex < 0 || !hasNegativeApprovalOption(buttons)) {
            // No affirmative matched, or no decline option present (→ not a real
            // consent prompt, e.g. a picker that slipped past the kind gate).
            // Surface the modal so the user decides; never pick blindly.
            return autoApproveActive;
        }
        // Modal *identity* signature — the question/button set only, NO volatile
        // counters. This is what the settle gate tracks: the FSM bumps
        // approvalEntrySeq on every fresh waiting_approval entry, and a
        // modal→generating→modal flap (the question line scrolled out of the
        // captured frame while the button block stays) re-enters and bumps it
        // again. Folding that seq into the settle signature made the 600ms
        // settle clock restart on every flap, so the modal never stayed stable
        // long enough to fire — the gate was never satisfied. Identity excludes
        // the seq so button/seq flap of the SAME modal keeps one settle clock.
        const modalSignature = [
            typeof modal?.message === 'string' ? modal.message.trim() : '',
            buttons.join('|'),
            buttonIndex,
        ].join('::');
        // Busy-window re-entry guard still needs the seq: two DISTINCT
        // back-to-back approvals can carry identical message/buttons (common
        // with claude-cli). Without the seq their busy signatures collide and
        // the 5s busy-window guard below would swallow the second auto-approve,
        // leaving it stuck. The seq is bumped by the FSM on every fresh
        // waiting_approval entry, so a new approval always yields a new busy
        // signature and fires through.
        const approvalEntrySeq = typeof adapterStatus?.approvalEntrySeq === 'number'
            ? adapterStatus.approvalEntrySeq
            : 0;
        const busySignature = `${approvalEntrySeq}::${modalSignature}`;
        // Already fired for this exact modal entry and still inside the busy
        // window — nothing to do (re-entry guard for repeated snapshots of one
        // modal).
        if (this.autoApproveBusy && busySignature === this.lastAutoApprovalSignature) {
            return autoApproveActive;
        }

        // Settle gate: only fire once this modal identity has been stable for
        // AUTO_APPROVE_SETTLE_MS. A still-streaming prompt mutates its
        // message/buttons each frame → new identity → clock restarts, so we
        // never approve a half-rendered prompt (the "resolves too fast" bug).
        if (modalSignature !== this.pendingAutoApprovalSignature) {
            this.pendingAutoApprovalSignature = modalSignature;
            this.pendingAutoApprovalSince = now;
        }
        const settledForMs = now - this.pendingAutoApprovalSince;
        if (settledForMs < CliProviderInstance.AUTO_APPROVE_SETTLE_MS) {
            // Not yet settled. Arm a timer to re-check after the remaining quiet
            // window — the PTY may go silent once the prompt finishes painting,
            // so there is no guaranteed status-change frame to re-drive us.
            if (this.autoApproveSettleTimer) clearTimeout(this.autoApproveSettleTimer);
            this.autoApproveSettleTimer = setTimeout(() => {
                this.autoApproveSettleTimer = null;
                this.recheckAutoApproveSettled();
            }, CliProviderInstance.AUTO_APPROVE_SETTLE_MS - settledForMs + 20);
            return autoApproveActive;
        }

        // Settled — fire the approve key.
        if (this.autoApproveSettleTimer) { clearTimeout(this.autoApproveSettleTimer); this.autoApproveSettleTimer = null; }
        this.autoApproveBusy = true;
        this.lastAutoApprovalSignature = busySignature;
        this.pendingAutoApprovalSignature = '';
        this.pendingAutoApprovalSince = 0;
        this.autoApproveInactiveSince = 0;
        // Fired (resolveModal in flight) — the episode resolved; end the mask-stall clock.
        this.autoApproveMaskSince = 0;
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
        return autoApproveActive;
    }

    /**
     * Re-drive the auto-approve check after the settle quiet window elapses.
     * The PTY may have gone silent once the approval prompt finished painting,
     * so no status-change frame is guaranteed to re-enter maybeAutoApproveStatus
     * — this timer-driven re-check picks up the now-settled modal and fires.
     * Deliberately lighter than detectStatusTransition(): it only re-evaluates
     * the approval decision; the next real PTY frame refreshes visible status.
     */
    private recheckAutoApproveSettled(): void {
        try {
            const adapterStatus = this.adapter.getStatus({ allowParse: false });
            this.maybeAutoApproveStatus(adapterStatus, Date.now());
        } catch { /* adapter gone / transient — next frame retries */ }
    }

    /**
     * Emit the queue-claim agent:ready event at most once per session. Both the
     * boot-time starting→idle one-shot and the fsmReadySeen re-arm call this; the
     * agentReadyEmitted guard ensures the second caller is a no-op so a worker is
     * never claimed twice and a queued task is never double-dispatched.
     */
    private emitAgentReadyOnce(chatTitle: string, now: number): void {
        if (this.agentReadyEmitted) return;
        this.agentReadyEmitted = true;
        this.pushEvent({ event: 'agent:ready', chatTitle, timestamp: now });
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
        // During the autoApproveBusy window (2s after firing approval key), the PTY
        // can briefly report 'idle' before the next generating phase starts. Treat that
        // transient idle as 'generating' to suppress a spurious agent:generating_completed
        // push notification. The adapter's status is otherwise authoritative — native
        // transcript shape does NOT override the FSM's busy/idle decision.
        const autoApproveHoldIdle = this.autoApproveBusy && rawStatus === 'idle';
        const newStatus = autoApproveActive || autoApproveHoldIdle ? 'generating' : rawStatus;
        const dirName = workingDirBasename(this.workingDir);
        const chatTitle = `${this.provider.name} · ${dirName}`;
        const partial = this.adapter.getPartialResponse();
        // Liveness fingerprint for the no-progress watchdog. The parsed
        // assistant buffer (`partial`) alone goes static while a tool/build runs
        // — the assistant emits no tokens even though the PTY is actively
        // printing tool output — which made the watchdog false-fire a "stuck"
        // alert mid-turn. Fold in the adapter's raw-activity timestamps so any
        // visible terminal progress (lastScreenChangeAt) or raw PTY byte
        // (lastOutputAt) keeps the fingerprint moving. The watchdog then only
        // survives a genuine stall where nothing at all is happening.
        const progressFingerprint = newStatus === 'generating'
            ? `${`${partial || ''}`.slice(-2000)}::scr=${adapterStatus.lastScreenChangeAt ?? 0}::out=${adapterStatus.lastOutputAt ?? 0}`
            : undefined;

        const previousStatus = this.lastStatus;
        if (newStatus !== this.lastStatus) {
            LOG.info('CLI', `[${this.type}] status: ${this.lastStatus} → ${newStatus}`);
            // GENERATING-MISSING (win32 fresh-worktree first-turn): a freshly-launched session
            // is in 'starting' until its startup-grace settles to idle. When the FIRST inject
            // lands inside that grace window, the adapter can report status DIRECTLY
            // starting → generating without an intervening 'idle' frame for
            // detectStatusTransition() to observe. Previously only the idle→generating arm
            // armed the bookkeeping, so a starting→generating frame fell straight through to the
            // bare `this.lastStatus = newStatus` update: generatingStartedAt stayed 0 and no
            // generating_started was queued. The fast turn's generating→idle completion was then
            // suppressed by the startup-blip guard below (generatingStartedAt===0 &&
            // !generatingDebouncePending) — so NO generating_started AND NO generating_completed
            // ever fired and the mesh coordinator never learned the worker went idle.
            //
            // We extend the idle→generating arm to also fire on starting→generating, BUT ONLY
            // when a real turn is in flight. The adapter script can also report 'generating' from
            // pure startup PTY noise (no task dispatched) — antigravity/codex/hermes-cli all
            // exercise that benign starting→generating→idle blip, which must NOT emit a
            // completion (see "startup-phase spurious completion suppression" tests).
            // hasAdapterPendingResponse() is the discriminator: a genuine inject sets the
            // adapter's isWaitingForResponse / currentTurnScope (or leaves a partial response),
            // whereas startup repaint noise leaves all of them empty. So an armed
            // starting→generating means "the worker actually started its first turn", and a
            // bare one stays a suppressed blip via the existing fall-through.
            const startingToGeneratingWithActiveTurn = this.lastStatus === 'starting'
                && newStatus === 'generating'
                && this.hasAdapterPendingResponse();
            if (((this.lastStatus === 'idle' && newStatus === 'generating') || startingToGeneratingWithActiveTurn)) {
                // If a completion event is already pending and the turn has ended
                // (generatingStartedAt===0), the PTY is painting its prompt area
                // after completing. Ignore this blip — do not cancel the pending
                // completion and do not advance lastStatus to generating. (On a true
                // starting→generating the session is fresh: completedDebouncePending is
                // null, so this blip guard is a no-op and we arm normally below.)
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
                // Include the FSM's approval entry seq, mirroring the auto-approve
                // path (maybeAutoApproveStatus) and resolveModal's sameEntryReResolve
                // guard. Two distinct back-to-back approvals can carry identical
                // message/buttons (very common with claude-cli's "Allow Bash
                // command?"). Without the seq their fingerprints collide and the dedup
                // below silently drops the second waiting_approval event — it is never
                // emitted, so it cannot even land in the pending inbox for a later
                // read_chat reconcile to recover. The seq is bumped by the FSM on every
                // fresh waiting_approval entry, so a new approval always yields a new
                // fingerprint and emits.
                const approvalEntrySeq = typeof adapterStatus?.approvalEntrySeq === 'number'
                    ? adapterStatus.approvalEntrySeq
                    : 0;
                const approvalFingerprint = JSON.stringify({
                    message: typeof modal?.message === 'string' ? modal.message.trim() : '',
                    buttons: Array.isArray(modal?.buttons) ? modal.buttons.map((button: unknown) => String(button).trim()) : [],
                    seq: approvalEntrySeq,
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
            } else if (newStatus === 'generating' && this.lastStatus === 'waiting_approval') {
                // Approval resolved and the agent resumed work. Defense-in-depth:
                // clear the approval emit fingerprint here too (not only on
                // completion at scheduleCompletedDebounceFlush). A subsequent
                // waiting_approval with the same modal content as the one just
                // resolved would otherwise collide with the stale fingerprint and be
                // dropped. The seq in the fingerprint already separates entries; this
                // reset is a belt-and-suspenders guard for the re-entry case.
                this.lastApprovalEventFingerprint = '';
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
                        // (No EvtTrace: not a mesh session, so nothing routes to a coordinator.)
                    } else {
                        // EVTTRACE: completion fired (short-generating idle path).
                        if (this.isMeshWorkerSession()) {
                            traceMeshEventStage('fired', this.meshTraceCtx(), `short-generating idle (source=${shortEvidenceSource})`);
                        }
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
                        // ARCH-REFACTOR R1: snapshot the completing turn's taskId NOW (sync),
                        // before any follow-up task's flush can start a new turn and move
                        // engine.currentTurnTaskId.
                        ...(this.completingTurnTaskId() ? { taskId: this.completingTurnTaskId() } : {}),
                    };
                    const ownsExternalHistory = !!(this.adapter as any)?.chatMessagesOwnedExternally;
                    // (FALSEIDLE-BGCHILD-a) Native-history providers flush immediately (the
                    // transcript is authoritative). For mesh worker sessions, give the
                    // generating→idle transition a short settle window so a background-child
                    // false idle (quiet after a backgrounded test/command while the parent turn
                    // continues) gets caught by the resume guard in flushCompletedDebounceIfFinalized
                    // instead of firing an early completion the coordinator can never correct.
                    const meshWorkerSession = this.isMeshWorkerSession();
                    const flushDelay = ownsExternalHistory
                        ? (meshWorkerSession ? NATIVE_HISTORY_MESH_IDLE_SETTLE_MS : 0)
                        : 3000;
                    LOG.debug('CLI', `[${this.type}] set completedDebouncePending duration=${duration}s ownsExternalHistory=${ownsExternalHistory} meshWorker=${meshWorkerSession} flushDelay=${flushDelay}ms generatingStartedAt=${this.generatingStartedAt}`);
                    this.scheduleCompletedDebounceFlush(flushDelay);
                }
            } else if (newStatus === 'idle' && this.lastStatus === 'starting') {
                this.emitAgentReadyOnce(chatTitle, now);
                // GENERATING-BOUNDARY fast-collapse (R4, win32 startup-grace first turn):
                // a turn dispatched into the startup-grace window can START and FINISH while
                // the FSM is still in 'starting'. On a daemon whose claude-cli spec has NOT yet
                // synced the starting→busy edge (the primary cure lives in the spec's
                // idle→busy.from), the FSM never reaches 'busy'/generating, so
                // detectStatusTransition observes starting→idle DIRECTLY with no intervening
                // 'generating' frame. The idle→generating arm — the only path that sets
                // generatingStartedAt and arms the completion — never fired, so the completing
                // turn's agent:generating_completed is never emitted and the mesh coordinator
                // never learns the worker went idle. Synthesize the started+completed pair here.
                //
                // Discriminator (false-positive safe — must NOT fire on a benign boot):
                //   adapter.currentTurnTaskId is set ONLY by onTurnStarted (a real turn STARTED
                //   this boot) and persists past completion, so it cleanly separates the three
                //   non-firing cases — a true idle boot (no turn → null), a queued-pending
                //   first turn that only runs AFTER startup-grace drains the composer (onTurnStarted
                //   not yet called → null; it completes normally later via idle→busy→idle), and a
                //   turn STILL running at the 8s mark (hasAdapterPendingResponse() still true →
                //   excluded so we don't fire a premature mid-turn completion; idle→busy self-
                //   corrects once the FSM reaches idle). We fire only when a turn started AND has
                //   already finished: started-this-boot && !still-in-flight.
                const startedTurnTaskId = typeof (this.adapter as any)?.currentTurnTaskId === 'string'
                    && (this.adapter as any).currentTurnTaskId.trim()
                    ? (this.adapter as any).currentTurnTaskId as string
                    : undefined;
                const fastCollapsed = !!startedTurnTaskId
                    && !this.hasAdapterPendingResponse()
                    && !this.generatingStartedAt
                    && !this.generatingDebouncePending;
                if (fastCollapsed) {
                    let fcFinalSummary: string | undefined;
                    let fcEvidenceSource: CompletionFinalAssistantEvidence['source'] = 'unavailable';
                    try {
                        const parsedMessages = this.adapter?.getScriptParsedStatus()?.messages;
                        const evidence = this.completionFinalAssistantEvidence(parsedMessages);
                        fcEvidenceSource = evidence.source;
                        fcFinalSummary = extractFinalSummaryFromMessages(evidence.messages as any);
                    } catch { /* best-effort */ }
                    const missingEvidence = ((this.provider as any).requiresFinalAssistantBeforeIdle === true || fcEvidenceSource === 'external-native') && !fcFinalSummary;
                    // Mirror the short-generating idle path's suppression: a provider that
                    // requires a final assistant (or external-native history) with NO confirmed
                    // summary and NO mesh context emits nothing — the session is idle with no
                    // confirmed turn, matching startup-blip semantics. With mesh context we still
                    // emit so the coordinator can apply its own timeout/retry logic.
                    const hasMeshContext = !!(this.settings.meshNodeFor || this.settings.meshActiveTaskId || this.settings.launchedByCoordinator);
                    if (missingEvidence && !hasMeshContext) {
                        LOG.info('CLI', `[${this.type}] startup-grace fast-collapse suppressed: missing final assistant evidence, no mesh context (source=${fcEvidenceSource})`);
                    } else {
                        LOG.info('CLI', `[${this.type}] startup-grace fast-collapse: synthesizing started+completed (taskId=${startedTurnTaskId} source=${fcEvidenceSource} hadFinalSummary=${!!fcFinalSummary})`);
                        // Retroactive started so the started→completed pair (and the chat bubble)
                        // is well-formed; pushEvent stamps the per-turn taskId for CANON-B ack.
                        this.pushEvent({ event: 'agent:generating_started', chatTitle, timestamp: now });
                        if (this.isMeshWorkerSession()) {
                            traceMeshEventStage('fired', this.meshTraceCtx(), `startup-grace fast-collapse (source=${fcEvidenceSource})`);
                        }
                        this.pushEvent({
                            event: 'agent:generating_completed',
                            chatTitle,
                            duration: 0,
                            timestamp: now,
                            finalSummary: fcFinalSummary,
                            completionDiagnostic: {
                                reason: 'startup_grace_fast_collapse',
                                finalAssistantEvidenceSource: fcEvidenceSource,
                                ...(missingEvidence ? { blockReason: 'missing_final_assistant' } : {}),
                            },
                        });
                    }
                }
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

        // Re-arm the queue-claim agent:ready on the FSM's first GENUINE ready.
        //
        // The boot-time starting→idle one-shot above is the historical claim
        // trigger, but it is consumed too early for FSM-spec providers whose
        // INITIAL state already reports status 'idle' (e.g. antigravity-cli): the
        // adapter reports idle before maybeMarkReady has fired, so lastStatus
        // advances starting→idle while the prompt is not yet drawn and the worker
        // cannot yet claim. Subsequent state-driven idle frames are idle→idle (no
        // status change), so the one-shot never re-fires and the worker strands its
        // queued task — the coordinator then relaunch-loops every ~90s.
        //
        // The adapter surfaces fsmReadySeen=true exactly when the FSM reaches its
        // first non-initial idle (the prompt is genuinely up). On that signal we
        // emit agent:ready once more. emitAgentReadyOnce is idempotent (guarded by
        // agentReadyEmitted), so providers whose boot one-shot already landed on a
        // real ready (claude-cli / codex-cli / hermes-cli, which use a startup
        // grace and whose initial state is not idle) treat this as a no-op — no
        // double claim, no double task injection.
        if (newStatus === 'idle' && adapterStatus.fsmReadySeen === true && !this.agentReadyEmitted) {
            this.emitAgentReadyOnce(chatTitle, now);
        }

        this.applyProviderResponse(parsedStatus, {
            phase: (newStatus === 'idle' && (previousStatus === 'generating' || previousStatus === 'waiting_approval'))
                ? 'turn_completed'
                : 'immediate',
        });

 // Monitor check (cooldown based notification, IDE/CLI common)
        const agentKey = `${this.type}:cli`;
        // Approval pending is detected from the raw adapter status, not `newStatus`:
        // auto-approve synthesizes `waiting_approval` → 'generating', which would
        // otherwise let the no-progress watchdog accumulate the approval wait.
        const approvalPending = rawStatus === 'waiting_approval';
        const monitorEvents = this.monitor.check(agentKey, newStatus, now, progressFingerprint, approvalPending);
        const monitorParsedStatus: any = parsedStatus;
        for (const me of monitorEvents) {
            if (
                me.type === 'monitor:no_progress'
                && this.completionHasFinalAssistantMessage(monitorParsedStatus?.messages)
                && !this.hasAdapterPendingResponse()
                && !hasNonEmptyCliModalButtons(monitorParsedStatus?.activeModal ?? monitorParsedStatus?.modal)
            ) {
                // EVTTRACE: completion fired (no-progress monitor reconciled to completion).
                if (this.isMeshWorkerSession()) {
                    traceMeshEventStage('fired', this.meshTraceCtx(), 'no_progress_monitor_final_summary');
                }
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
                        reconciliationReason: 'no_progress_monitor_final_summary',
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
            // Carry the workspace under BOTH `workspace` and `workspaceName` so the
            // downstream mesh forward/merge path — which reads `workspace` — can
            // propagate it to the coordinator snapshot. Without `workspace` the live
            // event path delivers an empty workspace and the dashboard falls back to
            // the generic "Terminal (Mesh Node)" title.
            workspace: typeof event.workspace === 'string' && event.workspace.trim()
                ? event.workspace
                : this.workingDir,
            providerSessionId: typeof event.providerSessionId === 'string' && event.providerSessionId.trim()
                ? event.providerSessionId
                : this.providerSessionId,
        };
        // TASKIDLESS: stamp the mesh task primary key on lifecycle events emitted by
        // a mesh worker session. The consumer (updateDirectDispatchStatus) was switched
        // to key on task_id (CANON-B), but the producer never carried it — so every
        // forwarded metadataEvent.taskId arrived undefined and the coordinator fell back
        // to a session_id match, which can flip a sibling dispatch row. Surface it here so
        // updateDirectDispatchStatus hits the exact PK row and the session_id fallback is
        // never exercised. Non-mesh sessions get no taskId (regression guard) —
        // isMeshWorkerSession() gates the injection.
        //
        // ARCH-REFACTOR R1 (per-turn identity): resolution order is
        //   (1) an explicit taskId already on the event — the debounce-flush completion
        //       path stamps the taskId captured at the generating→idle transition (the
        //       turn that actually produced this completion);
        //   (2) the per-turn binding (engine.currentTurnTaskId) for synchronously-emitted
        //       events whose turn is still the current one;
        //   (3) the legacy session scalar (settings.meshActiveTaskId) as a last-resort
        //       backward-compat alias.
        // The scalar is last because it is last-write-wins: a second task attaching while
        // this turn was still running overwrites it, which is the exact NOTIF-MISDELIVER /
        // TASK-MSG-MISROUTE race this refactor removes.
        if (this.isMeshWorkerSession()) {
            const existingTaskId = typeof enrichedEvent.taskId === 'string' && enrichedEvent.taskId.trim()
                ? enrichedEvent.taskId
                : undefined;
            if (!existingTaskId) {
                const resolved = this.completingTurnTaskId();
                if (resolved) enrichedEvent.taskId = resolved;
            }
        }
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

    /** @see ProviderInstance.noteManualInteraction */
    noteManualInteraction(now = Date.now()): void {
        this.manualAttendance.note(now);
    }

    /**
     * Whether auto-approve should be treated as active *right now* for display
     * and firing decisions: the configured intent AND the user is not currently
     * attending this session by hand. When a human is attending, auto-approve is
     * held so the modal stays visible and they can drive it via the controlbar.
     * Provider-agnostic — the attendance signal is the command set, never any
     * CLI-specific modal text.
     */
    private autoApproveEffectivelyActive(status: string | undefined, now = Date.now()): boolean {
        return status === 'waiting_approval'
            && this.shouldAutoApprove()
            && !this.manualAttendance.isAttended(now);
    }

    // STATUS-MISMATCH: true once the current auto-approve episode has been masking
    // waiting_approval behind `generating` for longer than AUTO_APPROVE_MASK_STALL_MS without
    // resolving (the settle gate never fired). When stalled, the surface mask must be dropped
    // so read_chat / mesh_status / the dashboard see the real waiting_approval + modal (and a
    // coordinator can mesh_approve it). autoApproveMaskSince is maintained by
    // maybeAutoApproveStatus (driven by getState + the recheck timer during a waiting episode);
    // this read is side-effect-free so getStatusMetadata can consult it too.
    private autoApproveMaskStalled(now = Date.now()): boolean {
        return this.autoApproveMaskSince > 0
            && now - this.autoApproveMaskSince > CliProviderInstance.AUTO_APPROVE_MASK_STALL_MS;
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
                this.adapter.getScriptParsedStatus?.()?.title || workingDirBasename(this.workingDir),
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

    private syncCanonicalSavedHistoryIfNeeded(options: { full?: boolean } = {}): boolean {
        if (!this.providerSessionId) return false;
        const canonicalHistory = this.provider.nativeHistory;
        if (!canonicalHistory) return false;

        // Per-status-report hydration reads only a bounded tail (snapshot needs at
        // most the newest 60). The once-per-resume restore path passes full:true
        // because seedSessionHistory needs the COMPLETE transcript to seed dedup
        // state. The read-cache key encodes the window so the bounded and full
        // reads don't share/clobber each other's 2s cache entry.
        const limit = options.full ? Number.MAX_SAFE_INTEGER : STATUS_HYDRATION_TAIL_LIMIT;
        const windowTag = options.full ? 'full' : `tail:${STATUS_HYDRATION_TAIL_LIMIT}`;

        if (isNativeSourceCanonicalHistory(canonicalHistory)) {
            const cacheKey = [this.type, this.providerSessionId, this.workingDir, windowTag].join('\0');
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
                limit,
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
            const cacheKey = [this.type, this.providerSessionId, this.workingDir, canonicalHistory.mode || 'materialized-mirror', windowTag].join('\0');
            const now = Date.now();
            if (cacheKey === this.lastNativeSourceCanonicalCacheKey && now - this.lastNativeSourceCanonicalCheckAt < 2_000) {
                return true;
            }
            this.lastNativeSourceCanonicalCacheKey = cacheKey;
            this.lastNativeSourceCanonicalCheckAt = now;

            if (!materializeProviderNativeHistory(this.type, canonicalHistory, this.providerSessionId, this.workingDir, this.provider.scripts as any)) {
                return false;
            }
            // Bounded by default: the per-status-report path only needs the newest
            // STATUS_HYDRATION_TAIL_LIMIT messages because the snapshot caps
            // activeChat.messages to the last 60 (status/normalize.ts) and loads
            // the rest lazily via read_chat on subscribe. The once-per-resume
            // restore path passes full:true so seedSessionHistory still sees the
            // COMPLETE transcript for prefix-dedup seeding. readChatHistory serves
            // a bounded limit as an O(tail) read.
            const restoredHistory = readChatHistory(this.type, 0, limit, this.providerSessionId, 0, this.provider.historyBehavior);
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
        // Restore is the once-per-resume seeding path: it needs the COMPLETE
        // transcript so seedSessionHistory can prime dedup state. Pass full so the
        // hydration read is unbounded here (and only here).
        this.syncCanonicalSavedHistoryIfNeeded({ full: true });
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
