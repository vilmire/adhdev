/**
 * SpecCliAdapter — bridges SpecDriver into the daemon's CliAdapter
 * interface so an existing CliProviderInstance can drive a spec-backed
 * provider without rewriting the surrounding session machinery.
 *
 * Translation:
 *   spec state.id 'approval' (with modal_buttons that produced a modal)
 *     → CliAdapterStatus.status='waiting_approval', activeModal={...}
 *   spec state.id 'busy' / any non-decision state with a 'busy' label
 *     → status='generating'
 *   spec state.id 'idle' or default
 *     → status='idle'
 *
 * Methods that the round-3 spec model doesn't have an opinion on
 * (transcript reading, slash commands, history, runtime metadata
 * surfacing) are minimal stubs. They satisfy the daemon's call sites
 * without pretending to implement anything.
 */
'use strict';

import { FsmDriver, type DashboardEvent, type ISpecDriver } from './fsm-driver.js';
import { lastContiguousNumberedBlock } from './evaluator.js';
import { executeNativeHistory } from './native-history-executor.js';
import { readJsonlLines } from './native-history-jsonl-cache.js';
import { detectBackgroundTaskActive } from './background-task-detector.js';
import { extractAntigravityScreenAssistantMessages } from './antigravity-screen-messages.js';
import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import type { NativeHistoryConfig, Control, ControlAction } from './types.js';
import {
    resolveInterruptCapability,
    type InterruptCapability,
    type InterruptUnsupportedReason,
} from './interrupt-capability.js';
import type { CliAdapter, CliAdapterStatus } from '../../cli-adapter-types.js';
import type { ChatMessage } from '../../types.js';
import type { PtyTransportFactory } from '../../cli-adapters/pty-transport.js';
import type { ResolvedTrustPlan } from '../trust-provenance-ledger.js';
import {
    encodeMeshSendKeys,
    truncateToByteTailByLine,
    type MeshSendKeyItem,
    type MeshSendKeyName,
} from '../../cli-adapters/provider-cli-shared.js';
import { LOG } from '../../logging/logger.js';
import {
    buildClaudeInteractiveTuiAnswerSteps,
    buildClaudeInteractiveToolResult,
    detectClaudeAskUserQuestionPromptFromJson,
    detectClaudeAskUserQuestionPromptFromTuiPages,
    detectClaudeTuiMultiSelect,
    isClaudeTuiReviewScreen,
    readFocusedClaudeTuiPickerRegion,
    readFocusedClaudeTuiQuestion,
    stableClaudeTuiPromptId,
    type ClaudeInteractiveTuiPage,
    type InteractivePrompt,
    type InteractivePromptResponse,
} from '../types/interactive-prompt.js';
import { buildKimiInteractiveTuiAnswerSteps } from '../types/interactive-prompt.js';
import {
    detectKimiPendingQuestion, detectKimiIdleSelectorPrompt,
    buildKimiSelectorAnswerSteps, KIMI_TUI_SELECTOR_PROMPT_PREFIX,
} from '../kimi-pending-question.js';
import { detectClaudePendingQuestion } from '../claude-pending-question.js';
import type { InteractivePrompts } from './fsm-types.js';
import { CLAUDE_TUI_REVIEW_PAGE_NOT_FOCUSED_PREFIX } from '@adhdev/mesh-shared';


// See the matching helper in cli-adapters/provider-cli-shared.ts for the full
// rationale. Kept as a separate copy deliberately: `check:boundaries` forbids a
// value import between providers/ and cli-adapters/, so sharing it would mean
// breaking a layer boundary to save a few lines.
// eslint-disable-next-line no-control-regex
const ANSI_OSC_DCS_RE = /\x1B\][^\x07]*(?:\x07|\x1B\\)|\x1B[P^_X][\s\S]*?(?:\x07|\x1B\\)/g;
// eslint-disable-next-line no-control-regex
const ANSI_CSI_RE = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

/**
 * Strip ANSI escape sequences. Byte-for-byte identical to the previous
 * three-pass chain. The CSI pass stays last and separate because deleting an
 * OSC/DCS can leave a dangling `ESC[` newly adjacent to following text, which
 * only a fresh scan will then match; a fused alternation advances past that
 * position and never revisits it.
 */
function stripAnsi(text: string): string {
    const s = String(text || '');
    if (s.indexOf('\x1B') === -1) return s;
    return s.replace(ANSI_OSC_DCS_RE, '').replace(ANSI_CSI_RE, '');
}

export interface KimiAuthBillingFailure {
    errorReason: 'auth_failed' | 'billing_failed' | 'quota_exceeded';
    failureKind: 'auth' | 'billing' | 'quota';
    message: string;
}

/**
 * KIMI-AUTH-BILLING-LIVE: classify only strong Kimi CLI failure markers.
 *
 * Spec-backed CLIs run inside one PTY, so stdout and stderr are intentionally
 * merged by node-pty. The live adapter therefore retains a small output tail
 * and applies this classifier both as chunks arrive and when the process exits.
 * A bare 403 is deliberately absent, and so is a bare `[provider.auth_error]`
 * tag: Kimi answers 403 for managed-usage exhaustion as well as for real
 * authorization faults, so the verdict comes from the accompanying entitlement
 * wording, exactly as the quota fetcher decides it from the response body. That
 * is why the live line "[provider.auth_error] 403 You've reached your 5-hour
 * usage limit" classifies as QUOTA exhaustion rather than billing or auth —
 * misreading it as auth would send an operator to re-login against a credential
 * that is actually fine, and misreading it as billing (an incident fixed
 * 2026-08-29: the classifier folded quota wording into the billing bucket and
 * told the operator to "renew the subscription" when the account was current
 * and merely rate-limited by usage) suppresses automatic recovery FOREVER for a
 * condition that heals on its own once the window resets. Billing stays a
 * separate, genuinely non-retryable bucket for wording that names the account
 * itself as the problem (expired/cancelled subscription, payment required,
 * insufficient credits) rather than a spent usage window.
 * Canonical messages never echo the raw PTY tail (which may contain credentials
 * or user data).
 */
/**
 * True when the tail carries a machine-emitted provider failure envelope, as
 * opposed to prose that merely mentions limits. This is the live-PTY stand-in
 * for the quota fetcher's "we already know this is a 403" precondition: it is
 * what separates the incident line "[provider.auth_error] 403 You've reached
 * your 5-hour usage limit" from an agent narrating the quota source file.
 */
function hasProviderFailureEnvelope(text: string): boolean {
    return /\bprovider\.[a-z_]*error\b/.test(text)
        || /\b(?:http\s*)?(?:40[23])\b\s*(?:[-:—]|\bforbidden\b|\bpayment\b|you\b|your\b)/.test(text)
        || /\bstatus(?:\s+code)?\s*[:=]?\s*40[23]\b/.test(text);
}

export function detectKimiAuthBillingFailure(output: string, _exitCode?: number): KimiAuthBillingFailure | null {
    const text = stripAnsi(output).replace(/\s+/g, ' ').trim().toLowerCase();
    if (!text) return null;

    // Entitlement EXHAUSTION — the account is fine, the usage window is spent.
    // The wording mirrors the quota fetcher's USAGE_LIMIT_BODY_PATTERN
    // (quota/fetchers/kimi.ts) so the live path and the polled path agree on
    // what "the plan is spent" looks like, but it is NOT reused verbatim: the
    // fetcher matches an HTTP error body already known to be a 403, whereas
    // this scans merged PTY output from a coding agent that frequently
    // *discusses* quota code ("reading kimi.ts to understand the usage limit
    // pattern"). Bare limit wording is therefore not sufficient — it must be
    // carried by an actual provider failure envelope (a provider error tag or
    // an HTTP 403/402 status), which is the structural equivalent of the
    // fetcher's status precondition.
    //
    // Kimi states the limit as a rolling window ("your 5-hour usage limit") as
    // well as per cycle ("usage limit for this billing cycle"), and the
    // qualifier sits between the noun and "limit", so the reached/exceeded verb
    // stays optional after it. This bucket is checked BEFORE billing so a
    // usage-limit envelope never falls through into the non-retryable bucket
    // below — the incident this file exists to prevent.
    const quota = hasProviderFailureEnvelope(text) && [
        /\b(?:usage|quota|credit)\s+limit\b/,
        /\bquota\s*(?:exhausted|refresh)/,
        /\bbilling\s+cycle\b/,
    ].some(pattern => pattern.test(text));
    if (quota) {
        return {
            errorReason: 'quota_exceeded',
            failureKind: 'quota',
            message: 'Kimi usage quota reached — the current window is exhausted but the account itself is fine. It will resume automatically once the quota resets.',
        };
    }

    const billing = [
        /\b(?:kimi code\s+)?(?:subscription|membership|plan)\s+(?:has\s+|is\s+)?(?:expired|inactive|suspended|cancelled|canceled)\b/,
        /\b(?:payment|billing)\s+(?:is\s+)?(?:required|failed|overdue)\b/,
        /\bpayment_required\b/,
        /\binsufficient\s+(?:balance|credits?)\b/,
    ].some(pattern => pattern.test(text));
    if (billing) {
        return {
            errorReason: 'billing_failed',
            failureKind: 'billing',
            message: 'Kimi billing/subscription failed. Renew the subscription or payment entitlement before retrying.',
        };
    }

    const auth = [
        /\b(?:authentication|authorization|login)\s*(?:error|failed|required)\b/,
        /\b(?:access|refresh|auth(?:entication)?)\s+token\s+(?:has\s+|is\s+)?(?:expired|invalid|rejected|revoked)\b/,
        /\b(?:token_expired|invalid_token)\b/,
        /\b(?:unauthorized|http\s*401|status(?:\s+code)?\s*[:=]?\s*401)\b/,
        /\b(?:not\s+(?:logged|signed)\s+in)\b/,
        /\bplease\s+(?:run\s+)?(?:`?kimi`?\s+)?login\b/,
    ].some(pattern => pattern.test(text));
    if (auth) {
        return {
            errorReason: 'auth_failed',
            failureKind: 'auth',
            message: 'Kimi authentication failed (the access token is expired or rejected). Run "kimi login" in this environment before retrying.',
        };
    }
    return null;
}

function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export class SpecCliAdapter implements CliAdapter {
    readonly cliType: string;
    readonly cliName: string;
    readonly workingDir: string;
    /**
     * Marker the daemon's finalization gate checks: `getStatus()` returns
     * `messages: []` by design here (chat history lives in the daemon's
     * native-history pipeline, not the adapter). Without this flag,
     * cli-provider-instance's `missing_final_assistant` gate would stall
     * every turn until the 30s safety timeout because it expects the
     * adapter to surface the final assistant message.
     */
    readonly chatMessagesOwnedExternally = true as const;

    private driver: ISpecDriver;
    /** Common spec fields the adapter reads, present in both v3 and v4. */
    private spec: {
        id: string;
        name: string;
        control_bar?: Control[];
        native_history?: NativeHistoryConfig;
        interactive_prompts?: InteractivePrompts;
    };
    /** Owning session id (session registry / read-path targetSessionId) —
     *  the sidecar-claim owner token for wire-based prompt detection. */
    private owningSessionId?: string;
    private lastEvent: DashboardEvent | null = null;
    private latestState: { id: string; label: string; title: string | null; status: 'idle' | 'generating' | 'approval' } | null = null;
    private latestModal: { title: string | null; buttons: { index: number; label: string }[]; kind?: 'approval' | 'picker' | 'confirm' | null } | null = null;
    private statusCallback: (() => void) | null = null;
    private ptyDataCallback: ((data: string) => void) | null = null;
    private partialResponse = '';
    private activeInteractivePrompt: InteractivePrompt | null = null;
    private interactivePromptTransport: 'stream-json' | 'tui' | null = null;
    private claudeTuiPromptCaptureInFlight = false;
    /**
     * OWNER-INPUT-WINS latch for the claude TUI capture pass. The multi-question
     * capture injects Tab/Shift-Tab into the PTY to snapshot pages 2..N — the
     * SAME input stream an owner answering in the attached terminal is typing
     * into. A single-question prompt never injects (its page loop is empty),
     * which is exactly the reported "1개일 때는 항상 동작, 2~3개일 때 꼬인다"
     * split. Set by writeRaw() when a keystroke arrives while the picker footer
     * is on screen; while set, no capture starts and any in-flight capture
     * bails before its next injected key. Cleared once the picker footer has
     * stayed off the screen across the repaint-grace window — a single
     * footer-less frame is claude mid-repaint, not a closed picker (the next
     * prompt may capture again after the grace elapses).
     */
    private claudeTuiCaptureSuppressed = false;
    /**
     * Failed-capture bookkeeping, keyed by the nav-line identity of the prompt.
     * A capture that ends without a prompt (page unparsable — e.g. options
     * scrolled out) used to re-arm on EVERY pty_data frame, turning detection
     * into a continuous Tab/Shift-Tab injection storm (the owner-visible
     * "디텍트가 한번 더 되면서 꼬인다"). Attempts are now bounded per prompt;
     * the count resets when the picker leaves the screen.
     */
    private claudeTuiCaptureFailures: { key: string; count: number } | null = null;
    /**
     * Wall clock of the first consecutive frame on which the picker footer was
     * absent. claude-cli repaints the picker across several PTY chunks (see
     * interactivePromptLostAt), so ONE footer-less frame is not proof the
     * picker left — clearing the owner-input latch on such a frame re-armed
     * capture mid-repaint and restarted Tab/Shift-Tab injection while the
     * owner was typing (the residual of the submit-tangle bug with the latch
     * already in place). The latch and the failure budget therefore re-arm
     * only after the footer has stayed absent for
     * INTERACTIVE_PROMPT_LOST_GRACE_MS — the same hysteresis the prompt-lost
     * path already uses.
     */
    private claudeTuiCaptureFooterAbsentAt: number | null = null;
    /** Max capture attempts per prompt identity before giving up (one retry). */
    private static readonly CLAUDE_TUI_CAPTURE_MAX_ATTEMPTS = 2;
    /**
     * Wall clock of the first frame on which a held interactive prompt was
     * observed to have left the screen. Mirrors the approval FSM's
     * `modalLostAt` hysteresis (see cli-state-engine.ts): claude-cli's TUI
     * repaints the choice picker as several PTY chunks, so a single frame
     * with no "Enter to select" footer is not proof the prompt is gone — it
     * may just be mid-repaint. We only clear the held prompt once it has
     * been absent across a short grace window. Reset to null the moment the
     * prompt footer reappears.
     *
     * Without this, a choice prompt resolved *directly in the terminal* (the
     * user picked an option without going through ADHDev's
     * setInteractivePromptResponse) was never cleared from
     * `activeInteractivePrompt`, so getStatus() re-emitted the same prompt
     * forever — the choice-resolve-stuck bug.
     */
    private interactivePromptLostAt: number | null = null;
    private jsonLineTail = '';
    private exited = false;
    private spawned = false;
    /** Bounded merged PTY output tail used only for Kimi auth/billing classification. */
    private kimiFailureOutputTail = '';
    private kimiAuthBillingFailure: KimiAuthBillingFailure | null = null;
    private lastExitCode: number | null = null;
    private providerSessionId: string | undefined;
    /** Wall clock at the moment spawn() ran. Used as the cutoff for
     *  native-history file selection so a prior session's transcript
     *  can't leak into this session before the agent has written its
     *  own records. */
    private spawnedAtMs = 0;
    /** Env vars the daemon set on the spawned child. Mesh coordinator
     *  points hermes at a per-coordinator HERMES_HOME so the dashboard's
     *  native-history reader needs that override to find the right
     *  state.db; without it the reader sees ~/.hermes/state.db which
     *  the coordinator-launched hermes never writes to. The choice to
     *  redirect HERMES_HOME is a workaround for an unresolved hermes
     *  upstream feature gap (see hermes-agent#23130 — runtime-supplied
     *  MCP config), so this routing keeps the dashboard honest until
     *  hermes ships a runtime MCP override. */
    private spawnedEnv: Record<string, string> = {};
    /** Wall clock at the moment an approval modal was last resolved (auto-approve,
     *  dashboard, or mesh_approve) via a successful button press. Powers
     *  isApprovalRecentlyResolved() — the second suppression signal the mesh event
     *  forwarder uses to drop a duplicate agent:waiting_approval re-emitted across
     *  the approval↔busy TUI flap window (AUTOAPPROVE-FLAP). Mirrors the
     *  cli-state-engine's lastApprovalResolvedAt for the spec-driven adapter path
     *  (claude-cli specs/4.0.json), which previously stubbed the method to false. */
    private lastApprovalResolvedAt = 0;

    constructor(
        specPath: string,
        workingDir: string,
        cliArgs: string[],
        extraEnv: Record<string, string>,
        transportFactory?: PtyTransportFactory,
        /** FSMLOG-SESSION-ATTRIBUTION (D3): owning session id, passed to the driver purely so its
         *  log lines are attributable to a session when several run concurrently. */
        sessionId?: string,
        /** MANIFEST-SEND-DELAY: submit tuning declared by the provider MANIFEST (as opposed to
         *  the spec). Optional so the many test call sites and out-of-tree embedders that build
         *  an adapter without a manifest keep their existing behaviour unchanged. */
        manifestTuning?: {
            sendDelayMs?: number;
            /** PERMISSION-MODE-DUPLICATE: base-arg flags the selected auto-approve mode
             *  replaces, relayed to the driver so they are stripped from the SPEC's
             *  `spawn_args` too — see route.ts's `removeArgs` parameter. */
            removeArgs?: string[];
        },
        resolvedTrustPlan?: ResolvedTrustPlan | null,
    ) {
        const raw = JSON.parse(fs.readFileSync(specPath, 'utf8'));
        this.spec = {
            id: raw.id,
            name: raw.name,
            control_bar: raw.control_bar,
            native_history: raw.native_history,
            interactive_prompts: raw.interactive_prompts,
        };
        this.owningSessionId = sessionId;
        this.cliType = this.spec.id;
        this.cliName = this.spec.name;
        this.workingDir = workingDir;
        this.spawnedEnv = { ...extraEnv };

        // cli-manager.ts allocates providerSessionId per launch and threads
        // it through resume.newSessionArgs as additional cliArgs (e.g.
        // ["--session-id", "<uuid>"]). We must hand those to the driver
        // so the agent uses the daemon's id, otherwise (claude case) the
        // agent generates its own id and the chat-history pipeline can't
        // pair the on-disk transcript with the live session.
        this.driver = new FsmDriver({
            specPath,
            workingDir,
            extraEnv,
            hotReload: true,
            emitTrace: false,
            transportFactory,
            extraCliArgs: cliArgs,
            sessionId,
            manifestSendDelayMs: manifestTuning?.sendDelayMs,
            removeSpawnArgs: manifestTuning?.removeArgs,
            resolvedTrustPlan,
        });
        this.driver.subscribe((ev) => this.handleEvent(ev));
    }

    async spawn(): Promise<void> {
        if (this.spawned) return;
        this.driver.start();
        this.spawned = true;
        this.spawnedAtMs = Date.now();
    }

    async sendMessage(text: string, _opts?: { force?: boolean; bracketedPaste?: boolean }): Promise<{ status: 'queued' | 'delivered' } | void> {
        // Content-free at info — the prompt body is user data.
        LOG.info('SpecAdapter', `[${this.cliType}] sendMessage(len=${text.length})`);
        LOG.debug('SpecAdapter', `[${this.cliType}] sendMessage body=${JSON.stringify(text.slice(0, 80))}${text.length > 80 ? '…' : ''}`);
        this.driver.dispatch({ kind: 'send_message', text, bracketedPaste: _opts?.bracketedPaste });
    }

    getStatus(_options?: { allowParse?: boolean }): CliAdapterStatus {
        const sessionFields = this.providerSessionId ? { providerSessionId: this.providerSessionId } : {};
        // A strong live Kimi auth/billing marker outranks generic process liveness.
        // Returning `error` makes CliProviderInstance emit agent:stopped with the
        // typed reason, rather than allowing an idle/exit edge to masquerade as a
        // zero-byte completion or a generic crash eligible for blind recovery.
        if (this.kimiAuthBillingFailure) {
            return {
                status: 'error',
                messages: [],
                activeModal: null,
                activeInteractivePrompt: this.activeInteractivePrompt,
                errorMessage: this.kimiAuthBillingFailure.message,
                errorReason: this.kimiAuthBillingFailure.errorReason,
                ...sessionFields,
            };
        }
        if (this.exited) return { status: 'stopped', messages: [], activeModal: null, activeInteractivePrompt: this.activeInteractivePrompt, ...sessionFields };
        if (!this.spawned) return { status: 'starting', messages: [], activeModal: null, activeInteractivePrompt: this.activeInteractivePrompt, ...sessionFields };

        // kimi_wire prompt hold: refresh on the ROUTINE status poll (not only
        // on chat reads) so a question asked while nobody reads the chat still
        // surfaces promptly — same cadence rationale as the legacy adapter.
        this.refreshWirePendingQuestion();

        // Refresh native history lazily — the watch_path is cheap to stat,
        // but parsing a full session.jsonl every call would be wasteful.
        this.maybeRefreshNativeHistory();

        const state = this.latestState;
        if (!state) return { status: 'starting', messages: [], activeModal: null, activeInteractivePrompt: this.activeInteractivePrompt, ...sessionFields };

        // The FSM state is authoritative for status. We do NOT infer status from whether
        // a modal was parsed this frame: a modal/approval state whose buttons briefly fail
        // to parse (PTY repaint) must still report waiting_approval, not collapse to idle —
        // that collapse fired false completions while a session sat at an approval prompt.
        const modal = this.latestModal;
        if (state.status === 'approval') {
            return {
                status: 'waiting_approval',
                messages: [],
                // Surface buttons when we have them; an approval state with no parsed
                // modal this frame still stays waiting_approval (no activeModal yet).
                // `kind` carries the semantic modal class through to the auto-approve
                // gate so a /model picker (kind='picker') is never auto-answered.
                // BUTTON-INDEX-MISMAP (Fix C.1): keep `buttons` as the label list every
                // existing consumer (pickApprovalButton, mesh_approve, auto-approve) reads,
                // but ALSO surface `buttonMeta` carrying each button's real FSM display index
                // alongside its label. A partial/non-contiguous modal (display indices [1,3,4]
                // at array positions [0,1,2]) then no longer loses the index → label mapping
                // once it leaves the adapter: a consumer that has an array position can recover
                // the true FSM index without re-parsing. resolveModal() below relies on the same
                // ordered list to translate an array position to the correct FSM index.
                activeModal: modal
                    ? {
                        message: modal.title ?? state.label,
                        buttons: modal.buttons.map(b => b.label),
                        buttonMeta: modal.buttons.map(b => ({ index: b.index, label: b.label })),
                        kind: modal.kind ?? null,
                    }
                    : null,
                activeInteractivePrompt: this.activeInteractivePrompt,
                ...sessionFields,
            };
        }
        // Until the FSM has drawn a genuine non-initial idle prompt, do NOT
        // project the initial state's declared status (often `idle`) or a
        // boot-phase generating state (antigravity `signing_in`) onto the
        // daemon status machine. Projecting idle consumes the starting→idle
        // agent:ready one-shot before the prompt exists; projecting generating
        // arms a false generating_started (signing_in lasting >3s) that never
        // completes — no assistant text — so the dashboard/claim freeze as
        // generating (M-MESH-INFRA-0829). Hold at 'starting' until
        // maybeMarkReady. Missing hasSeenReady (stub/legacy drivers) is
        // treated as "not gated" so existing tests and non-FSM adapters keep
        // their previous projection. Approval stays visible during boot
        // (trust/consent modals must not be hidden as 'starting').
        const readySeen = this.driver.hasSeenReady?.();
        if (readySeen === false) {
            return {
                status: 'starting',
                messages: [],
                activeModal: null,
                activeInteractivePrompt: this.activeInteractivePrompt,
                fsmReadySeen: false,
                ...sessionFields,
            };
        }
        if (state.status === 'generating') {
            return { status: 'generating', messages: [], activeModal: null, activeInteractivePrompt: this.activeInteractivePrompt, ...sessionFields };
        }
        // fsmReadySeen lets CliProviderInstance re-arm the queue-claim agent:ready
        // on the first genuine ready (prompt drawn), independent of the boot-time
        // starting→idle one-shot that the provider-instance otherwise relies on.
        // Surfaced only on idle so the provider-instance fires agent:ready exactly
        // when the worker is actually ready to claim.
        return { status: 'idle', messages: [], activeModal: null, activeInteractivePrompt: this.activeInteractivePrompt, fsmReadySeen: readySeen === true, ...sessionFields };
    }

    private maybeRefreshNativeHistory(): void {
        // Native history is now sourced by daemon's chat-history pipeline
        // (which calls provider.scripts.readNativeHistory wired by
        // provider-loader). SpecCliAdapter no longer polls or caches.
    }

    getScriptParsedStatus(): { status?: string; messages: unknown[]; title?: string } & Record<string, unknown> {
        const providerSessionId = this.extractProviderSessionIdFromScreen();
        if (providerSessionId) this.providerSessionId = providerSessionId;
        const status = this.getStatus();
        // Background-task passthrough: read the native-history transcript at
        // poll time for causally-owned background tool work (claude-cli
        // run_in_background bash; kimi run_in_background tool.call cells whose
        // launch result returns immediately with `status: running`). This is a
        // NEW signal that rides alongside `status` (it is NOT run through the
        // 5-value FSM normalization). Providers whose transcript the detector
        // cannot authoritatively read report backgroundTaskSupport:'unknown'
        // (an explicit UNKNOWN — never a silent "no background work") and are
        // not gated. Read at each poll — the JSONL trails the live idle
        // transition, so it must be observed BEFORE completion fires, which
        // SUB-B's hold + settle window give us.
        const bg = this.detectBackgroundTask();
        return {
            ...status,
            messages: this.readScreenAssistantMessages(),
            ...(this.providerSessionId ? { providerSessionId: this.providerSessionId } : {}),
            backgroundTaskSupport: bg.support ?? 'unknown',
            ...(bg.active ? { backgroundTaskActive: true, backgroundTaskCount: bg.count, backgroundTaskIds: bg.ids } : {}),
        };
    }

    private detectBackgroundTask(): { active: boolean; count: number; ids: string[]; support?: 'tracked' | 'unknown' } {
        if (!this.spec.native_history?.source) {
            // antigravity-cli declares no declarative `source` (its authority is
            // the per-session conversations/<uuid>.db, read via the built-in
            // reader) — the detector dispatches on agentType and resolves the
            // store itself. Without this branch antigravity reported
            // support:'unknown' and the background_task_active hold was silently
            // inert (the early-completion defect: a worker ending its turn with
            // an async run_command still running projected completed).
            if (this.cliType === 'antigravity-cli') {
                try {
                    return detectBackgroundTaskActive(undefined, {
                        agentType: this.cliType,
                        providerSessionId: this.providerSessionId,
                        sessionStartedAtMs: this.spawnedAtMs,
                        envOverrides: this.spawnedEnv,
                        workspace: this.workingDir,
                        instanceId: this.owningSessionId,
                    });
                } catch {
                    return { active: false, count: 0, ids: [], support: 'unknown' };
                }
            }
            // No transcript source: only the detector can say whether this
            // provider is tracked at all (claude-cli/kimi) or unknown.
            return { active: false, count: 0, ids: [], support: this.cliType === 'claude-cli' || this.cliType === 'kimi' ? 'tracked' : 'unknown' };
        }
        try {
            return detectBackgroundTaskActive(this.spec.native_history, {
                agentType: this.cliType,
                providerSessionId: this.providerSessionId,
                sessionStartedAtMs: this.spawnedAtMs,
                envOverrides: this.spawnedEnv,
                workspace: this.workingDir,
            });
        } catch {
            return { active: false, count: 0, ids: [], support: 'unknown' };
        }
    }

    getPartialResponse(): string {
        return this.partialResponse;
    }

    shutdown(): void {
        try { this.driver.dispatch({ kind: 'shutdown' }); } catch { /* ignore */ }
    }

    cancel(): void {
        try { this.driver.dispatch({ kind: 'cancel' }); } catch { /* ignore */ }
    }

    isProcessing(): boolean {
        return this.getStatus().status === 'generating';
    }

    isReady(): boolean {
        return this.spawned && !this.exited;
    }

    // Process liveness for the MESH-STALL-WATCH watchdog (checkMeshWorkerStall).
    // The spec path drives the child through the transport/driver rather than a
    // directly-held ptyProcess handle, so liveness is tracked by the spawned/exited
    // lifecycle flags — the same pair isReady() uses. A spawned, not-yet-exited
    // session is alive. ProviderCliAdapter exposes the equivalent via `ptyProcess !== null`.
    isAlive(): boolean {
        return this.spawned && !this.exited;
    }

    // MESH-READ-TERMINAL / MESH-SEND-KEYS byte caps — same envelope as
    // ProviderCliAdapter (32KiB default view, 64KiB absolute hard cap). Bytes,
    // not chars: a multi-byte-glyph screen can exceed an MCP payload cap while
    // the char count still looks safe.
    private static readonly TERMINAL_SNAPSHOT_DEFAULT_MAX_BYTES = 32 * 1024;
    private static readonly TERMINAL_SNAPSHOT_ABSOLUTE_MAX_BYTES = 64 * 1024;
    /** Window during which isApprovalRecentlyResolved() reports a just-resolved
     *  approval. Matches CliProviderInstance.APPROVAL_LOCAL_RESOLUTION_COOLDOWN_MS
     *  (8000) — the same auto-approve suppression window signal1 uses — so a modal
     *  re-emitted within the approval↔busy flap is suppressed by signal2 too. */
    private static readonly APPROVAL_RESOLVED_COOLDOWN_MS = 8000;

    /**
     * MESH-READ-TERMINAL (feature 2: RAW terminal read). Least-privilege read
     * of the CURRENT rendered viewport for mesh_read_terminal on the spec path
     * (claude-cli / antigravity / codex-cli — the native-source providers that
     * route through SpecCliAdapter). Mirrors ProviderCliAdapter.getTerminalScreenSnapshot:
     *  - returns ONLY the driver's current viewport snapshot, the cursor
     *    position and the terminal geometry — NO scrollback, NO parser/FSM
     *    state, NO debug buffers;
     *  - the payload is byte-bounded (UTF-8) with bottom-tail preservation so a
     *    screen of multi-byte glyphs can never exceed the MCP payload cap;
     *  - `hash` is over the FULL untruncated viewport so a caller can detect a
     *    screen change across polls even when the returned text was truncated.
     *
     * SECURITY: the raw viewport can carry tokens / command args / env / user
     * data. Callers MUST gate this on mesh ownership and MUST NOT log the text.
     */
    getTerminalScreenSnapshot(maxBytes = SpecCliAdapter.TERMINAL_SNAPSHOT_DEFAULT_MAX_BYTES): {
        text: string;
        cursor: { col: number; row: number };
        cols: number;
        rows: number;
        truncated: boolean;
        originalBytes: number;
        returnedBytes: number;
        hash: string;
    } {
        const cap = Math.min(
            SpecCliAdapter.TERMINAL_SNAPSHOT_ABSOLUTE_MAX_BYTES,
            Math.max(1024, Math.floor(maxBytes) || SpecCliAdapter.TERMINAL_SNAPSHOT_DEFAULT_MAX_BYTES),
        );
        let rawViewport = '';
        try { rawViewport = this.driver.snapshot() || ''; } catch { rawViewport = ''; }
        let cursor = { row: 0, col: 0 };
        try { cursor = this.driver.getCursorPosition(); } catch { /* keep 0,0 */ }
        // getScreenSize is optional on ISpecDriver; a test double may omit it.
        let size = { cols: 0, rows: 0 };
        try { size = this.driver.getScreenSize?.() ?? size; } catch { /* keep 0,0 */ }
        const truncation = truncateToByteTailByLine(rawViewport, cap);
        const hash = createHash('sha256').update(rawViewport, 'utf8').digest('hex').slice(0, 16);
        return {
            text: truncation.text,
            cursor: { col: cursor.col, row: cursor.row },
            cols: size.cols,
            rows: size.rows,
            truncated: truncation.truncated,
            originalBytes: truncation.originalBytes,
            returnedBytes: truncation.returnedBytes,
            hash,
        };
    }

    /**
     * Report whether this provider can have its in-flight turn interrupted,
     * resolved from the spec THIS session actually loaded (never a hardcoded
     * per-provider table — the stop key varies by spec version; hermes-cli
     * ships Ctrl-C in specs/0.14.json and an EMPTY key in specs/4.0.json).
     */
    getInterruptCapability(): InterruptCapability {
        return resolveInterruptCapability(this.cliType, this.spec.control_bar);
    }

    /**
     * Abort the turn currently in flight by writing the provider's own stop
     * key to the PTY. Used by delivery mode 'interrupt': the caller then waits
     * for the FSM to report idle and lets the ordinary queued-send drain
     * deliver the new prompt as a genuine new turn.
     *
     * ★ Deliberately NOT routed through invokeScript('stop'). That path calls
     * FsmDriver.handleClickControl, which silently returns when the control's
     * `visible_when_state` does not include the current state, and calls
     * send_keys("") for a provider whose stop key is empty — while
     * invokeScript unconditionally returns `{ ok: true, effects:[sent_keys] }`
     * either way. Reporting a successful interrupt that wrote nothing is
     * exactly the failure this feature exists to remove, so capability is
     * validated HERE, before any write, and the outcome is reported honestly.
     */
    async interruptTurn(): Promise<
        | { ok: true; keyName: string; bytes: number; confidence: 'proven' | 'declared' }
        | { ok: false; reason: InterruptUnsupportedReason | 'not_running' | 'not_busy'; message: string }
    > {
        if (!this.spawned || this.exited) {
            return { ok: false, reason: 'not_running', message: `${this.cliName} is not running.` };
        }
        const cap = this.getInterruptCapability();
        if (!cap.supported) {
            LOG.warn('SpecAdapter', `[${this.cliType}] interrupt refused: ${cap.reason}`);
            return { ok: false, reason: cap.reason, message: cap.message };
        }
        // Interrupting a session that is not generating would write a stray
        // Ctrl-C/ESC at an idle prompt. Report it instead of writing blindly.
        const status = this.latestState?.status;
        if (status !== 'generating') {
            return {
                ok: false,
                reason: 'not_busy',
                message: `Session is '${status ?? 'unknown'}', not generating — nothing to interrupt.`,
            };
        }
        this.driver.dispatch({ kind: 'pty_write', data: cap.keys });
        const bytes = Buffer.byteLength(cap.keys, 'utf8');
        LOG.info('SpecAdapter', `[${this.cliType}] turn interrupted via ${cap.keyName} (bytes=${bytes}, confidence=${cap.confidence})`);
        return { ok: true, keyName: cap.keyName, bytes, confidence: cap.confidence };
    }

    /**
     * MESH-SEND-KEYS (feature 3: key injection). Inject a STRUCTURED key
     * sequence into the spec-driven PTY for mesh_send_keys. Mirrors
     * ProviderCliAdapter.injectKeys' modal fail-closed guard, then writes the
     * whole encoded sequence in ONE pty_write dispatch (text+ENTER is a single
     * contiguous string, so a submit key can never be separated from the text
     * it submits).
     *
     * The spec path drives the child through the FsmDriver, not a directly-held
     * ptyProcess — there is no adapter-level echo-gate/submit-retry FIFO to race
     * against here (the driver serializes its own writes). A send_keys call is
     * refused while the session is generating: input can otherwise sit in the
     * PTY buffer while the active turn continues, and CTRL_C/ESC would bypass the
     * interrupt capability gate. Use mesh_send_task with delivery_mode:'interrupt'
     * to steer an active turn. The modal fail-closed guard remains: a
     * NON-destructive injection into an actionable approval modal is refused (use
     * mesh_approve) unless explicitly overridden.
     * A destructive ESC/CTRL_C dismisses rather than confirms, so it is allowed
     * past this gate (the tool layer owns the destructive double-gate + audit).
     * This method NEVER logs the literal text — only key enums / byte length.
     */
    async injectKeys(
        items: MeshSendKeyItem[],
        opts: { allowModalOverride?: boolean } = {},
    ): Promise<
        | { ok: true; keys: MeshSendKeyName[]; hasDestructive: boolean; submits: boolean; bytes: number }
        | { ok: false; refused: 'submit_race' | 'actionable_modal' | 'generating'; keys: MeshSendKeyName[]; hasDestructive: boolean; message?: string }
    > {
        if (!this.spawned || this.exited) throw new Error(`${this.cliName} is not running`);
        const encoded = encodeMeshSendKeys(items);

        // Modal fail-closed — a NON-destructive injection while parked on an
        // actionable approval modal is refused so a modal choice can't be
        // confirmed via send_keys and bypass the approval policy.
        const modalActive = this.latestState?.status === 'approval';
        if (modalActive && !encoded.hasDestructive && !opts.allowModalOverride) {
            LOG.warn('SpecAdapter', `[${this.cliType}] send_keys refused (actionable_modal): keys=${encoded.keys.join(',')} — use mesh_approve`);
            return { ok: false, refused: 'actionable_modal', keys: encoded.keys, hasDestructive: encoded.hasDestructive };
        }

        // Fail closed while an active turn owns the PTY. Blindly writing here can
        // leave bytes buffered until after the turn.
        //
        // A DESTRUCTIVE key (ESC / CTRL_C) is exempt, matching the modal guard
        // 8 lines up and the contract stated in this method's doc comment. It
        // dismisses rather than confirms, so it cannot commit anything a policy
        // gate would have refused, and the tool layer owns its double-gate +
        // audit. Without the exemption a session wedged on an unanswerable
        // screen — a first-run onboarding TUI reported as `generating` — has no
        // manual escape hatch at all: mesh_send_task's interrupt path needs a
        // real turn to interrupt, which is exactly what such a session lacks.
        if (this.latestState?.status === 'generating' && !encoded.hasDestructive) {
            const message = "session is generating; mesh_send_keys cannot write during an active turn. Use mesh_send_task with delivery_mode: 'interrupt' to interrupt it.";
            LOG.warn('SpecAdapter', `[${this.cliType}] send_keys refused (generating): keys=${encoded.keys.join(',')} — use mesh_send_task delivery_mode=interrupt`);
            return { ok: false, refused: 'generating', keys: encoded.keys, hasDestructive: encoded.hasDestructive, message };
        }

        // Atomic write: the full encoded sequence goes out in ONE pty_write.
        this.driver.dispatch({ kind: 'pty_write', data: encoded.sequence });
        LOG.info('SpecAdapter', `[${this.cliType}] send_keys injected keys=${encoded.keys.join(',') || '(text-only)'} bytes=${Buffer.byteLength(encoded.sequence, 'utf8')} destructive=${encoded.hasDestructive}`);
        return {
            ok: true,
            keys: encoded.keys,
            hasDestructive: encoded.hasDestructive,
            submits: encoded.submits,
            bytes: Buffer.byteLength(encoded.sequence, 'utf8'),
        };
    }

    setOnStatusChange(cb: () => void): void {
        this.statusCallback = cb;
    }

    setOnPtyData(cb: (data: string) => void): void {
        this.ptyDataCallback = cb;
    }

    writeRaw(data: string): void {
        // Raw pty input — typed characters, escape codes, arrow keys —
        // goes straight to the underlying terminal. send_message would
        // append submit_key after every chunk, which is why typing in
        // the dashboard terminal felt like "enter on every keystroke".
        // OWNER-INPUT WINS: a keystroke while the AskUserQuestion picker is on
        // screen means the owner is answering in the terminal, so suppress the
        // dashboard capture pass (which injects Tab/Shift-Tab into this same
        // stream) for the rest of this picker's lifetime. Best-effort only —
        // a snapshot failure must never block or delay owner input.
        try {
            if (!this.claudeTuiCaptureSuppressed
                && this.interactivePromptScheme() === 'claude_tui'
                && (this.driver.snapshot().includes('Enter to select')
                    // Mid-repaint frames transiently hide the footer (the
                    // picker redraws in chunks), so a held prompt or an
                    // in-flight capture also counts as picker-on-screen
                    // evidence — otherwise a keystroke landing on such a
                    // frame never sets the latch and the next footer frame
                    // starts injecting into the owner's stream.
                    || this.activeInteractivePrompt !== null
                    || this.claudeTuiPromptCaptureInFlight)) {
                this.claudeTuiCaptureSuppressed = true;
            }
        } catch { /* snapshot best-effort */ }
        this.driver.dispatch({ kind: 'pty_write', data });
    }

    resize(cols: number, rows: number): void {
        this.driver.dispatch({ kind: 'resize', cols, rows });
    }

    resolveModal(buttonIndex: number): void {
        this.resolveModalMatched(buttonIndex);
    }

    resolveModalMatched(buttonIndex: number): boolean {
        // BUTTON-INDEX-MISMAP (Fix C): `buttonIndex` is an ARRAY POSITION into the
        // label list this adapter surfaced via getStatus().activeModal.buttons (the
        // same order pickApprovalButton / mesh_approve pick from). The FSM matches a
        // click by the button's DISPLAYED number (evaluator sets button.index =
        // Number(m[1])), which is NOT `arrayPos + 1` for a partial / non-contiguous
        // modal — e.g. a "1. Yes / 3. Always / 4. No" set parses to display indices
        // [1,3,4] at array positions [0,1,2]. Blindly sending `arrayPos + 1` then
        // targets a non-existent display index (2) and handleClickModalButton finds
        // no button → nothing is pressed. Look up the real FSM display index from the
        // same ordered button list instead, and fall back to the legacy +1 only when
        // no modal is captured (defensive; the driver's own guard rejects a miss).
        const buttons = this.latestModal?.buttons ?? [];
        const target = (buttonIndex >= 0 && buttonIndex < buttons.length)
            ? buttons[buttonIndex].index
            : buttonIndex + 1;
        // clickModalButton returns whether the FSM actually found a button for `target`
        // and dispatched its confirm keys — surfaced so mesh_approve can distinguish a
        // real press from a silent miss (the exact false-success the mis-map produced).
        const pressed = this.driver.clickModalButton(target);
        // AUTOAPPROVE-FLAP (signal2): stamp the resolve time ONLY on a real press of an
        // approval-class modal. This is the resolution path for auto-approve, dashboard,
        // and mesh_approve alike, so isApprovalRecentlyResolved() then suppresses a
        // duplicate agent:waiting_approval re-emitted across the approval↔busy flap.
        // Gate on the authoritative FSM status (approval) — a picker/confirm press must
        // NOT arm the approval cooldown. A silent miss (pressed=false) leaves the modal
        // unresolved, so it must not stamp either.
        if (pressed && this.latestState?.status === 'approval') {
            this.lastApprovalResolvedAt = Date.now();
        }
        return pressed;
    }

    async resolveAction(data: unknown): Promise<void> {
        const args = (data && typeof data === 'object') ? (data as any) : {};
        const explicitIndex = typeof args.buttonIndex === 'number' ? args.buttonIndex : -1;
        if (explicitIndex >= 0) { this.resolveModal(explicitIndex); return; }
        const action = typeof args.action === 'string' ? args.action : 'approve';
        const buttons = this.latestModal?.buttons ?? [];
        if (buttons.length === 0) return;
        let target = -1;
        if (action === 'reject' || action === 'deny') {
            target = buttons.findIndex(b => /^(no|deny|reject|cancel)\b/i.test(b.label));
            if (target < 0) target = buttons.length - 1;
        } else {
            target = buttons.findIndex(b => /^(yes|allow|approve|accept|continue|proceed|update)\b/i.test(b.label));
            if (target < 0) target = 0;
        }
        this.resolveModal(target);
    }

    async setInteractivePromptResponse(response: InteractivePromptResponse): Promise<void> {
        const prompt = this.activeInteractivePrompt;
        if (!prompt || prompt.promptId !== response.promptId) throw new Error('Interactive prompt response does not match active prompt');
        const scheme = this.interactivePromptScheme();
        if (scheme === 'kimi_wire') {
            // Measured kimi keystroke protocols: digit/Tab/Enter for the
            // AskUserQuestion picker, arrow keys (cursor re-read live) for the
            // built-in selector — the spec-path port of the legacy adapter's
            // kimi branch, same 180ms inter-key repaint gap.
            const steps = prompt.promptId.startsWith(KIMI_TUI_SELECTOR_PROMPT_PREFIX)
                ? buildKimiSelectorAnswerSteps(prompt, response, this.driver.snapshot())
                : buildKimiInteractiveTuiAnswerSteps(prompt, response);
            for (const step of steps) {
                this.driver.dispatch({ kind: 'pty_write', data: step });
                await new Promise(resolve => setTimeout(resolve, 180));
            }
            this.activeInteractivePrompt = null;
            this.statusCallback?.();
            return;
        }
        // SILENT-SUCCESS DEFECT (2026-08-20): this used to `return` for any
        // other scheme — no keys pressed, prompt left held, and the caller
        // still reported success. A provider whose spec declares no answerable
        // interactive-prompt scheme must FAIL LOUDLY so the coordinator knows
        // the question is still parked.
        if (scheme !== 'claude_tui') {
            throw new Error(`Provider "${this.spec.id}" declares no answerable interactive-prompt scheme${scheme ? ` (scheme: ${scheme})` : ''} — the question was NOT answered.`);
        }
        if (this.interactivePromptTransport === 'tui') {
            // A claude terminal can render another picker above the held
            // AskUserQuestion. promptId only binds the dashboard response to
            // our held slot; it says nothing about which terminal widget owns
            // focus. Bind every key to the live focused question before it is
            // written, then require the matching review page for final Enter.
            // A mismatch fails closed and deliberately leaves the held prompt
            // intact so a stale response cannot operate another picker.
            const allowsFreeform = prompt.questions.some(q => q.allowFreeform);
            let completedWithoutReview = false;
            questionLoop: for (const question of prompt.questions) {
                const questionSteps = buildClaudeInteractiveTuiAnswerSteps({
                    ...prompt,
                    questions: [question],
                }, response).slice(0, -1); // final Enter belongs to the review page below
                for (const step of questionSteps) {
                    if (await this.assertFocusedClaudeTuiQuestion(question, prompt) === 'completed') {
                        completedWithoutReview = true;
                        break questionLoop;
                    }
                    this.driver.dispatch({ kind: 'pty_write', data: step });
                    await new Promise(resolve => setTimeout(resolve, 180));
                }
            }
            if (!completedWithoutReview) {
                await this.assertFocusedClaudeTuiReview(prompt, allowsFreeform);
                // Claude Code >=2.1.220 completes AskUserQuestion immediately after
                // the final choice. In that direct-submit path the settle poll
                // clears the bound prompt and there is no review page to confirm.
                // Never send a second Enter after that completion signal: focus now
                // belongs to the provider's busy screen (or whatever it renders
                // next), not to the question we answered.
                if (!this.activeInteractivePrompt) return;
                if (this.activeInteractivePrompt.promptId !== prompt.promptId) {
                    throw new Error('Claude TUI active interactive prompt changed before review submission');
                }
                this.driver.dispatch({ kind: 'pty_write', data: '\r' });
                await new Promise(resolve => setTimeout(resolve, 180));
            }
        } else {
            this.driver.dispatch({ kind: 'pty_write', data: `${buildClaudeInteractiveToolResult(response)}\n` });
        }
        this.activeInteractivePrompt = null;
        this.interactivePromptTransport = null;
        this.statusCallback?.();
    }

    isApprovalRecentlyResolved(): boolean {
        return !!(this.lastApprovalResolvedAt
            && (Date.now() - this.lastApprovalResolvedAt) < SpecCliAdapter.APPROVAL_RESOLVED_COOLDOWN_MS);
    }
    clearHistory(): void { /* no transcript buffer yet */ }
    updateRuntimeSettings(_settings?: Record<string, unknown>): void { /* no runtime settings in spec model yet */ }
    setServerConn(_conn?: unknown): void { /* server conn unused by SpecDriver */ }
    /**
     * Map an invokeScript(name, args) call onto a control_bar entry.
     *
     * scriptName is matched against control.id. The control's action.type
     * drives the dispatch:
     *
     *   send_keys     → click_control                   (e.g. stop)
     *   open_picker   → two roles, driven by the screen, not a hardcoded list:
     *                   - LIST  (no choice arg): open the picker, wait for it
     *                     to render, parse the on-screen options via
     *                     `extract_choices`, and return them as
     *                     `controlResult.options` (+ `currentValue`). This is
     *                     how the dashboard's Model/Mode controls learn what is
     *                     actually selectable in this CLI right now.
     *                   - SELECT (args.choiceIndex / args.choiceLabel): drive
     *                     the picker to that option using `submit_key`.
     *   attach_image  → attach_image dispatch; expects args.blob (data url
     *                   or base64) and args.mime
     *
     * Callers that pass an unknown control id get a { not_found } response.
     * No control matched, no driver call — keeps the surface honest.
     */
    invokeScript(scriptName: string, args?: Record<string, unknown>): Promise<unknown> {
        const controls = this.spec.control_bar ?? [];
        const ctl = controls.find(c => c.id === scriptName);
        if (!ctl) {
            return Promise.resolve({ ok: false, error: `unknown control: ${scriptName}` });
        }
        // Args may arrive as either { blob, mime } (direct invocation) or
        // { params: { blob, mime } } (when the dashboard wraps script args
        // in a params bag). Look at both.
        const flat: Record<string, unknown> = { ...(args || {}) };
        if (args && typeof args.params === 'object' && args.params) {
            Object.assign(flat, args.params as Record<string, unknown>);
        }
        const action = ctl.action;
        if (action.type === 'attach_image') {
            const blob = typeof flat.blob === 'string' ? flat.blob : '';
            const mime = typeof flat.mime === 'string' ? flat.mime : 'image/png';
            if (!blob) return Promise.resolve({ ok: false, error: 'attach_image requires args.blob (base64 or data URL)' });
            this.driver.dispatch({ kind: 'attach_image', blob, mime });
            return Promise.resolve({ ok: true, effects: [{ type: 'attached_image', controlId: ctl.id }] });
        }
        if (action.type === 'open_picker') {
            const choiceIndex = typeof flat.choiceIndex === 'number' ? flat.choiceIndex
                : typeof flat.choiceIndex === 'string' && flat.choiceIndex.trim() ? Number(flat.choiceIndex)
                : undefined;
            // `value` is the arg the dashboard's generic value-control set path
            // sends ({ value: <chosen option> }). control_bar pickers are
            // surfaced to the dashboard as dynamic `select` controls whose
            // option values are the screen-parsed labels, so a bare `value`
            // is just a label to match against the live choices.
            const choiceLabel = typeof flat.choiceLabel === 'string' ? flat.choiceLabel
                : typeof flat.choice === 'string' ? flat.choice
                : typeof flat.value === 'string' ? flat.value
                : undefined;
            if ((typeof choiceIndex === 'number' && Number.isFinite(choiceIndex)) || (choiceLabel && choiceLabel.trim())) {
                return this.selectPickerChoice(ctl, action, choiceIndex, choiceLabel);
            }
            return this.openPickerAndListChoices(ctl, action);
        }
        // send_keys routes through click_control.
        this.driver.dispatch({ kind: 'click_control', control_id: ctl.id, payload: flat });
        return Promise.resolve({ ok: true, effects: [{ type: 'sent_keys', controlId: ctl.id }] });
    }

    /**
     * Open an `open_picker` control and return the options the CLI is showing,
     * parsed live from the screen via `extract_choices`. Nothing is selected —
     * the picker is left open so a follow-up SELECT invoke can commit a choice.
     */
    private async openPickerAndListChoices(
        ctl: Control,
        action: Extract<ControlAction, { type: 'open_picker' }>,
    ): Promise<unknown> {
        this.driver.dispatch({ kind: 'click_control', control_id: ctl.id });
        const ready = await this.waitForPickerRendered(action);
        const options = this.extractPickerChoices(action);
        const currentValue = options.find(o => o.current)?.label;
        return {
            ok: true,
            effects: [{ type: 'opened_picker', controlId: ctl.id }],
            controlResult: {
                options: options.map(o => ({ value: o.label, label: o.label, current: o.current })),
                ...(currentValue ? { currentValue } : {}),
                source: 'screen-parse',
                ...(ready ? {} : { warning: 'picker_render_timeout' }),
            },
        };
    }

    /**
     * Drive an already-listable picker to a specific option. The option can be
     * named (choiceLabel — matched against the parsed on-screen labels) or
     * positional (choiceIndex — the on-screen number). The actual keystrokes
     * come from the spec's `submit_key` with `{index}` substituted, so the spec
     * — not this code — decides how a selection is keyed for each CLI.
     */
    private async selectPickerChoice(
        ctl: Control,
        action: Extract<ControlAction, { type: 'open_picker' }>,
        choiceIndex: number | undefined,
        choiceLabel: string | undefined,
    ): Promise<unknown> {
        // Open + wait so the choice list is on screen before we resolve the
        // label → index mapping. The picker is normally ALREADY open here (a
        // preceding list invoke leaves it rendered), so only send the trigger
        // when it is not on screen. Re-sending the trigger to an open picker is
        // NOT a harmless no-op on claude-cli: the trailing CR of `/model\r`
        // lands as Enter on the cursor's current row and commits the wrong
        // model before we navigate. De-dup the open to avoid that.
        let options = this.extractPickerChoicesIfRendered(action);
        if (!options) {
            this.driver.dispatch({ kind: 'click_control', control_id: ctl.id });
            await this.waitForPickerRendered(action);
            options = this.extractPickerChoices(action);
        }

        let index = choiceIndex;
        if ((index == null || !Number.isFinite(index)) && choiceLabel) {
            const needle = choiceLabel.trim().toLowerCase();
            const match = options.find(o => o.label.toLowerCase().includes(needle));
            if (!match) {
                return { ok: false, error: `choice not found on screen: ${choiceLabel}`, controlResult: { options: options.map(o => ({ value: o.label, label: o.label })) } };
            }
            index = match.index;
        }
        if (index == null || !Number.isFinite(index)) {
            return { ok: false, error: 'choiceIndex or choiceLabel required to select' };
        }

        if (action.select_mode === 'arrow_keys') {
            // Cursor-list picker (claude-cli /model): number keys are ignored.
            // The cursor starts on the active row (extract flags it `current`);
            // step it to the target row with arrows, then confirm.
            const current = options.find(o => o.current);
            if (current == null) {
                // Without a known cursor position a blind Enter would commit
                // whatever row the cursor sits on — fail loud instead.
                return {
                    ok: false,
                    error: 'arrow-nav picker: current cursor row not detected on screen',
                    controlResult: { options: options.map(o => ({ value: o.label, label: o.label, current: o.current })) },
                };
            }
            const up = action.cursor_keys?.up ?? '[A';
            const down = action.cursor_keys?.down ?? '[B';
            const delta = index - current.index;
            const step = delta >= 0 ? down : up;
            const nav = step.repeat(Math.abs(delta));
            // Confirm key = submit_key with the (unused) {index} placeholder
            // stripped — e.g. `{index}\r` → `\r`.
            const confirm = (action.submit_key || '\r').replace(/\{index\}/g, '') || '\r';
            if (nav) this.driver.dispatch({ kind: 'pty_write', data: nav });
            this.driver.dispatch({ kind: 'pty_write', data: confirm });
        } else {
            const keys = (action.submit_key || '{index}\r').replace(/\{index\}/g, String(index));
            this.driver.dispatch({ kind: 'pty_write', data: keys });
        }
        const selected = options.find(o => o.index === index);
        return {
            ok: true,
            effects: [{ type: 'selected_choice', controlId: ctl.id }],
            controlResult: {
                ok: true,
                ...(selected ? { currentValue: selected.label } : {}),
                selectedIndex: index,
            },
        };
    }

    /** Parse the picker choices only if the picker already appears rendered on
     *  the live screen (its `wait_for` condition currently matches and at least
     *  one choice parses). Returns the parsed choices when open, else null so
     *  the caller knows it must send the trigger to open it. Used to de-dup the
     *  picker open in {@link selectPickerChoice}. */
    private extractPickerChoicesIfRendered(
        action: Extract<ControlAction, { type: 'open_picker' }>,
    ): Array<{ index: number; label: string; current: boolean }> | null {
        const wf = action.wait_for;
        if (wf?.regex) {
            const re = new RegExp(wf.regex, wf.flags ?? 'i');
            if (!re.test(this.readScreenSectionText(wf.section))) return null;
        }
        const options = this.extractPickerChoices(action);
        return options.length > 0 ? options : null;
    }

    /** Poll the live screen until the picker's `wait_for` condition matches,
     *  up to a short budget. Returns true if it rendered, false on timeout. */
    private async waitForPickerRendered(action: Extract<ControlAction, { type: 'open_picker' }>): Promise<boolean> {
        const wf = action.wait_for;
        if (!wf?.regex) { await delay(250); return true; }
        const re = new RegExp(wf.regex, wf.flags ?? 'i');
        const deadline = Date.now() + 2500;
        while (Date.now() < deadline) {
            await delay(120);
            const hay = this.readScreenSectionText(wf.section);
            if (re.test(hay)) return true;
        }
        return false;
    }

    /** Parse the picker's `extract_choices` pattern against the live screen.
     *  Each match yields { index, label, current }. `current` is true for the
     *  line the CLI marks with its cursor glyph (❯ ›). Purely screen-driven —
     *  no model/mode names are baked in. */
    private extractPickerChoices(action: Extract<ControlAction, { type: 'open_picker' }>): Array<{ index: number; label: string; current: boolean }> {
        const ec = action.extract_choices;
        if (!ec?.pattern) return [];
        const text = this.readScreenSectionText(ec.section);
        // Collect EVERY matching line in screen order with no top-down de-dup.
        // The picker section can include conversation history above it (a stray
        // "1./2./3." list, blockquote `>` lines); a `seen.has(idx)` first-wins
        // scan would let those body lines claim the option indices and shadow
        // the real choices — committing the wrong model under arrow-key nav.
        const all: Array<{ index: number; label: string; current: boolean }> = [];
        for (const rawLine of text.split('\n')) {
            const line = rawLine.replace(/\r$/, '');
            const m = new RegExp(ec.pattern, ec.flags ?? '').exec(line);
            if (!m) continue;
            const idx = Number(m[1]);
            if (!Number.isFinite(idx) || idx <= 0) continue;
            const label = (m[2] ?? '').replace(/\s+/g, ' ').trim();
            if (!label) continue;
            const current = /^\s*[❯›>]/.test(line) || /[✔✓●]\s*$/.test(label);
            all.push({ index: idx, label, current });
        }
        // Real options are the bottom-most contiguous numbered block; this also
        // confines the `current` cursor flag to that block so a body `>` line is
        // never mistaken for the cursor row.
        return lastContiguousNumberedBlock(all);
    }

    /** Live text of a named screen section (or the whole screen when no
     *  section is named), resolved from the driver's current sections. */
    private readScreenSectionText(sectionId?: string): string {
        try {
            const sections = this.driver.getSections();
            if (sectionId && sections) {
                const hit = sections.find(s => s.id === sectionId);
                if (hit) return hit.text;
            }
            return this.driver.getScreen();
        } catch {
            return '';
        }
    }
    getDebugSnapshot(): unknown {
        let screen = '';
        let sections: Record<string, string> | undefined;
        try {
            screen = this.driver.snapshot();
            const driverSections = this.driver.getSections?.();
            if (driverSections) {
                sections = Object.fromEntries(driverSections.map(s => [s.id, s.text]));
            } else {
                sections = this.readCurrentScreenSections(screen);
            }
        } catch { /* best-effort */ }
        // Read native transcript messages for the debug snapshot
        let messages: any[] = [];
        if (this.spec.native_history?.source) {
            try {
                const nhResult = executeNativeHistory(this.spec.native_history, {
                    agentType: this.cliType,
                    providerSessionId: this.providerSessionId,
                    sessionStartedAtMs: this.spawnedAtMs,
                    envOverrides: this.spawnedEnv,
                    workspace: this.workingDir,
                });
                if (nhResult && Array.isArray(nhResult.messages)) messages = nhResult.messages;
            } catch { /* best-effort */ }
        } else {
            messages = this.readScreenAssistantMessages();
        }
        return {
            cliType: this.cliType,
            spec_id: this.spec.id,
            current_state: this.latestState,
            current_modal: this.latestModal,
            activeInteractivePrompt: this.activeInteractivePrompt,
            exited: this.exited,
            exitCode: this.lastExitCode,
            kimiFailureKind: this.kimiAuthBillingFailure?.failureKind ?? null,
            screen,
            sections,
            stateHistory: this.driver.getStateHistory(),
            idleHoldPending: this.driver.hasIdleHoldPending(),
            lastBusyAt: this.driver.getLastBusyAt(),
            specPath: this.driver.getSpecPath(),
            cursorPosition: this.driver.getCursorPosition(),
            completionIdleDebounce: this.driver.getCompletionIdleDebounceState(),
            // v4 FSM live transition table (null for v3 specs). Every outgoing
            // transition from the current state with its per-condition match
            // result + countdown — the canonical "why isn't it moving" answer.
            fsm: this.driver.getFsmDebug?.() ?? null,
            // v4 FSM transition snapshot history (null for v3 specs). The full
            // pre-transition evaluation table captured at each transition —
            // answers "why did this rule fire" after the fact, unlike the live
            // `fsm` field which only reflects the current instant.
            fsmHistory: this.driver.getFsmSnapshotHistory?.() ?? null,
            // PTY input/output/resize/cursor event timeline (debug-only) so the
            // snapshot shows what we typed / what the PTY printed around each
            // status transition. Null for drivers without the timeline.
            eventTimeline: this.driver.getEventTimeline?.() ?? null,
            // Extended fields
            name: this.cliName,
            status: this.getStatus().status,
            workingDir: this.workingDir,
            spawnedAtMs: this.spawnedAtMs,
            providerSessionId: this.providerSessionId ?? null,
            messages,
            committedMessages: messages,
        };
    }
    getRuntimeMetadata(): import('../../cli-adapters/pty-transport.js').PtyRuntimeMetadata & Record<string, unknown> {
        return {
            runtimeId: this.spec.id,
            runtimeKey: this.spec.id,
            displayName: this.spec.name,
            spawnedAtMs: this.spawnedAtMs,
            spawnedEnv: this.spawnedEnv,
            ...(this.providerSessionId ? { providerSessionId: this.providerSessionId } : {}),
        };
    }
    updateRuntimeMeta(meta?: Record<string, unknown>): void {
        if (!meta) return;
        if (typeof meta.providerSessionId === 'string') {
            this.providerSessionId = meta.providerSessionId;
        }
        // Forward the FULL meta (meshNodeId / meshNodeFor / workspaceLabel /
        // lifecycle / …) down to the transport so it reaches the session
        // registry. The legacy ProviderCliAdapter.updateRuntimeMeta does the
        // same via ptyProcess.updateMeta; the spec path previously dropped
        // everything but providerSessionId, leaving autoLaunch's meshNodeId
        // stamp unbound on the record — the root of SESSION-ACCUMULATION-LEAK.
        try { this.driver.updateMeta(meta); } catch { /* transport may not support meta */ }
    }
    refreshProviderDefinition(_provider?: unknown): void { /* hot reload handled by SpecDriver fs.watch */ }

    /**
     * TX-FSM Stage 0 (shadow): forward the daemon's normalized signal
     * observation into the FSM driver. Observation-only — failures here must
     * never break the adapter, and the driver treats the envelope as a pure
     * injected value (no reads cross the engine boundary).
     */
    setSignalObservation(snapshot: import('./signal-envelope.js').SignalSnapshot | null): void {
        try { this.driver.setSignalObservation?.(snapshot); } catch { /* shadow-only: never break the adapter */ }
    }

    private handleEvent(ev: DashboardEvent): void {
        this.lastEvent = ev;
        switch (ev.kind) {
            case 'state_changed':
                this.latestState = ev.state;
                this.latestModal = ev.modal;
                // info-level keeps only spec-defined identifiers (state.id /
                // state.label / button count). The extracted title can carry
                // user data — file paths, command text, ticket titles — so
                // it stays at debug.
                LOG.info('SpecAdapter', `[${this.cliType}] state=${ev.state.id} (${ev.state.label}) modal=${ev.modal ? `${ev.modal.buttons.length}-buttons` : 'none'}`);
                if (ev.state.title) {
                    LOG.debug('SpecAdapter', `[${this.cliType}] state.title=${JSON.stringify(ev.state.title)}`);
                }
                this.maybeClearResolvedClaudeTuiPrompt();
                this.maybeCaptureClaudeTuiPrompt();
                this.maybeUpgradeClaudeTuiMultiSelect();
                this.statusCallback?.();
                return;
            case 'pty_data':
                this.observeKimiAuthBillingOutput(ev.chunk);
                this.detectInteractivePromptFromPtyChunk(ev.chunk);
                this.maybeClearResolvedClaudeTuiPrompt();
                this.maybeCaptureClaudeTuiPrompt();
                this.maybeUpgradeClaudeTuiMultiSelect();
                try { this.ptyDataCallback?.(ev.chunk); } catch { /* ignore */ }
                return;
            case 'exit':
                this.exited = true;
                this.lastExitCode = ev.exit_code;
                // Some CLIs repaint the failure off-screen before exit. Re-run the
                // classifier against the retained tail at the exit seam. The observer
                // invokes statusCallback only when it discovers a new typed failure;
                // otherwise this branch publishes the ordinary stopped transition.
                if (!this.observeKimiAuthBillingOutput('', ev.exit_code)) this.statusCallback?.();
                return;
            case 'spec_error':
                LOG.warn('SpecAdapter', `[${this.cliType}] spec reload error: ${ev.errors.join('; ')}`);
                return;
            default:
                return;
        }
    }

    private observeKimiAuthBillingOutput(chunk: string, exitCode?: number): boolean {
        if (this.cliType !== 'kimi' || this.kimiAuthBillingFailure) return false;
        if (chunk) {
            this.kimiFailureOutputTail = `${this.kimiFailureOutputTail}${stripAnsi(chunk)}`.slice(-16 * 1024);
        }
        const failure = detectKimiAuthBillingFailure(this.kimiFailureOutputTail, exitCode);
        if (!failure) return false;
        this.kimiAuthBillingFailure = failure;
        const suppressionNote = failure.failureKind === 'quota'
            ? 'this PTY session will not be blindly restarted; the mesh may retry once quota resets'
            : 'automatic provider retry must be suppressed';
        LOG.warn('SpecAdapter', `[kimi] ${failure.failureKind} failure detected from live PTY/exit (exitCode=${exitCode ?? 'pending'}); ${suppressionNote}`);
        this.statusCallback?.();
        return true;
    }

    /**
     * Resolve the interactive-prompt protocol for this session — the spec's
     * declared `interactive_prompts.scheme`, with a legacy default: a
     * 'claude-cli' spec that predates the field keeps the claude_tui protocol
     * it always had (retire this fallback once the published claude spec
     * declares the field). Every other spec without the field captures no
     * interactive prompts, exactly as before.
     */
    private interactivePromptScheme(): InteractivePrompts['scheme'] | null {
        const declared = this.spec.interactive_prompts?.scheme;
        if (declared === 'claude_tui' || declared === 'kimi_wire') return declared;
        return this.cliType === 'claude-cli' ? 'claude_tui' : null;
    }

    /**
     * kimi_wire scheme: refresh the held AskUserQuestion / built-in selector
     * prompt on the routine status poll — the spec-path port of the legacy
     * adapter's refreshKimiPendingQuestion (same wire.jsonl authority, same
     * every-poll cadence, same fail-open semantics).
     */
    private refreshWirePendingQuestion(): void {
        if (this.interactivePromptScheme() !== 'kimi_wire') return;
        try {
            let prompt: InteractivePrompt | null = null;
            if (this.spec.native_history?.source) {
                prompt = detectKimiPendingQuestion(this.spec.native_history, {
                    agentType: this.cliType,
                    providerSessionId: this.providerSessionId || undefined,
                    sessionStartedAtMs: this.spawnedAtMs,
                    envOverrides: this.spawnedEnv,
                    workspace: this.workingDir,
                    // Sidecar-claim owner token — without it resolution fails
                    // closed on ambiguity (see the legacy call site's note).
                    instanceId: this.owningSessionId || undefined,
                });
            }
            if (!prompt && this.latestState?.status !== 'generating') {
                // Built-in idle/cache-expired selector: TUI-only, never on the
                // wire; only appears at idle (a quoted snapshot in scrolling
                // output must never parse as the picker).
                prompt = detectKimiIdleSelectorPrompt(this.driver.snapshot());
            }
            if ((prompt?.promptId ?? null) !== (this.activeInteractivePrompt?.promptId ?? null)) {
                this.activeInteractivePrompt = prompt;
                this.statusCallback?.();
            }
        } catch { /* fail open — keep the currently-held prompt */ }
    }

    private detectInteractivePromptFromPtyChunk(chunk: string): void {
        if (this.interactivePromptScheme() !== 'claude_tui' || !chunk) return;
        this.jsonLineTail += chunk;
        if (this.jsonLineTail.length > 64 * 1024) this.jsonLineTail = this.jsonLineTail.slice(-64 * 1024);
        const lines = this.jsonLineTail.split(/\r?\n/);
        this.jsonLineTail = lines.pop() || '';
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('{') || !trimmed.includes('AskUserQuestion')) continue;
            try {
                const parsed = JSON.parse(trimmed);
                const prompt = detectClaudeAskUserQuestionPromptFromJson(parsed, this.cliType);
                if (!prompt) continue;
                this.activeInteractivePrompt = prompt;
                this.interactivePromptTransport = 'stream-json';
                this.interactivePromptLostAt = null;
                this.statusCallback?.();
            } catch {
                // PTY output is not guaranteed to be machine JSON.
            }
        }
    }

    private readCurrentScreenSections(_screenText: string): Record<string, string> {
        try {
            const sections = this.driver.getSections() ?? [];
            return Object.fromEntries(sections.map(section => [section.id, section.text]));
        } catch {
            return {};
        }
    }

    private extractProviderSessionIdFromScreen(): string | undefined {
        if (this.cliType !== 'codex-cli') return this.providerSessionId;
        let screenText = '';
        try {
            screenText = this.driver.snapshot();
        } catch {
            return this.providerSessionId;
        }
        const clean = stripAnsi(screenText);
        const match = clean.match(/(?:gpt-|o\d|codex-)[^\n·]*·[^\n·]*·\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
        return match?.[1] || this.providerSessionId;
    }

    /**
     * PTY-scrape assistant bubbles for the live parse / spec-debug snapshot.
     *
     * Native-history remains the completion-path authority
     * (`chatMessagesOwnedExternally`). This scrape is the fail-closed
     * fallback the gate already consults via getScriptParsedStatus().messages
     * when the on-disk transcript has no final standard assistant — which is
     * the antigravity layout where the JSON report is on screen under
     * `● Bash(...)` but never lands as a step_type-15 field-20 answer.
     */
    private readScreenAssistantMessages(): ChatMessage[] {
        if (this.cliType === 'claude-cli') return this.readClaudeScreenAssistantMessages();
        if (this.cliType === 'antigravity-cli') {
            let screenText = '';
            try {
                screenText = this.driver.snapshot();
            } catch {
                return [];
            }
            return extractAntigravityScreenAssistantMessages(screenText);
        }
        return [];
    }

    private readClaudeScreenAssistantMessages(): ChatMessage[] {
        if (this.cliType !== 'claude-cli') return [];
        let screenText = '';
        try {
            screenText = this.driver.snapshot();
        } catch {
            return [];
        }
        const sections = this.readCurrentScreenSections(screenText);
        const body = sections.body || screenText;
        const messages: ChatMessage[] = [];
        const seen = new Set<string>();
        for (const line of body.split(/\r?\n/)) {
            const match = line.match(/^\s*⏺\s+(.+?)\s*$/);
            const content = match?.[1]?.trim();
            if (!content || seen.has(content)) continue;
            seen.add(content);
            messages.push({
                role: 'assistant',
                kind: 'standard',
                content,
                source: 'assistant_text',
                userFacing: true,
                bubbleState: 'final',
            });
        }
        return messages;
    }

    /**
     * Grace window a held interactive prompt must be absent from the screen
     * before we treat it as resolved-in-terminal and clear it. claude-cli
     * repaints the picker across multiple PTY chunks, so a single
     * footer-less frame is not proof the prompt is gone. Sized in the same
     * spirit as the approval FSM's `approvalCooldown` modal-lost hysteresis.
     */
    private static readonly INTERACTIVE_PROMPT_LOST_GRACE_MS = 1500;

    /**
     * Multi-question TUI capture: after Tabbing to a page, re-snapshot at this
     * interval until its checkbox glyph column has settled, up to the timeout.
     * The interval matches the legacy single fixed wait (120ms); the timeout
     * bounds total capture time so a single-select page (which never shows
     * glyphs) doesn't stall the capture indefinitely.
     */
    private static readonly CLAUDE_TUI_PAGE_POLL_INTERVAL_MS = 120;
    private static readonly CLAUDE_TUI_PAGE_SETTLE_TIMEOUT_MS = 600;

    /**
     * Review-page settle budget for a FREEFORM ("Other" / "Type something.")
     * answer specifically (residual gap after rc.34's settle-poll fix, live
     * defect 2026-08-29). CLAUDE_TUI_PAGE_SETTLE_TIMEOUT_MS was tuned against a
     * plain option-select transition — a single digit keypress that flips
     * straight to the review page with no reflow. A freeform confirm keystroke
     * instead commits a typed (possibly multi-byte/CJK, possibly wrapped)
     * string that the TUI must additionally lay out into the review echo
     * before the picker settles, which measurably exceeds the 600ms/5-sample
     * budget on a slower or higher-latency (remote CDP) link — the settle poll
     * exhausts on a still-question-shaped frame and assertFocusedClaudeTuiReview
     * fails closed with "Claude TUI review page is not focused for the active
     * interactive prompt" even though the review page was only moments away.
     * A short-lived retry from the caller then succeeds once real time has
     * passed, which is why the daemon log shows no repeated failures for a
     * question that visibly took over a minute to answer end-to-end.
     */
    private static readonly CLAUDE_TUI_REVIEW_SETTLE_TIMEOUT_MS = 1800;

    /**
     * Clear a held interactive prompt once the user has resolved it directly
     * in the terminal (the choice picker leaves the screen without going
     * through setInteractivePromptResponse). The approval path already does
     * this via the FSM's modal-lost hysteresis; the interactive-prompt path
     * had no equivalent, so a terminal-side answer left activeInteractivePrompt
     * set and getStatus() re-emitted the same choice modal forever.
     *
     * Detection is question-specific. "Enter to select" is shared by every
     * claude picker, so another picker must not keep this held question alive.
     * When the held question text is absent for
     * INTERACTIVE_PROMPT_LOST_GRACE_MS the prompt is genuinely resolved.
     */
    private maybeClearResolvedClaudeTuiPrompt(options: {
        screenText?: string;
        resolveImmediatelyWhenBusy?: boolean;
        resolvedByBoundToolResult?: boolean;
    } = {}): 'held' | 'missing' | 'cleared' | 'unavailable' {
        if (this.interactivePromptScheme() !== 'claude_tui' || !this.activeInteractivePrompt) return 'unavailable';
        // stream-json prompts are tracked by their tool-call lifecycle, not by
        // screen footer, but claude renders the same TUI picker for both
        // transports while awaiting an answer — so screen presence is a valid
        // resolved-signal for either. (If the screen read fails, keep holding.)
        let screenText = options.screenText;
        if (screenText === undefined) {
            try {
                screenText = this.driver.snapshot();
            } catch {
                return 'unavailable';
            }
        }
        const identifiableQuestions = this.activeInteractivePrompt.questions.filter(q => !!q.question?.trim());
        // Empty questions are not emitted by a real capture, but retaining the
        // footer fallback keeps defensive/manual prompt fixtures compatible.
        const stillOnScreen = identifiableQuestions.length > 0
            ? identifiableQuestions.some(q => this.claudeTuiQuestionTextAppears(q, screenText))
            : screenText.includes('Enter to select');
        if (stillOnScreen) {
            // Prompt reappeared / never left — reset the hysteresis timer.
            this.interactivePromptLostAt = null;
            return 'held';
        }
        // During a dashboard answer, a provider transition to busy is causal
        // confirmation that the final choice was submitted. Combined with the
        // bound question text being absent, it is stronger than the ordinary
        // terminal-side stale cleanup and does not need its repaint grace.
        // The review poll only enables this after ruling out a focused foreign
        // question, preserving the wrong-picker fail-closed guard.
        const resolvedByBusyAdvance = options.resolveImmediatelyWhenBusy === true
            && this.latestState?.status === 'generating';
        const resolvedByBoundToolResult = options.resolvedByBoundToolResult === true;
        const lostAt = this.interactivePromptLostAt ?? Date.now();
        if (this.interactivePromptLostAt == null) this.interactivePromptLostAt = lostAt;
        if (!resolvedByBusyAdvance && !resolvedByBoundToolResult
            && Date.now() - lostAt < SpecCliAdapter.INTERACTIVE_PROMPT_LOST_GRACE_MS) return 'missing';
        // Resolved in the terminal — drop the held prompt so getStatus() stops
        // re-emitting it.
        this.activeInteractivePrompt = null;
        this.interactivePromptTransport = null;
        this.interactivePromptLostAt = null;
        this.statusCallback?.();
        return 'cleared';
    }

    /**
     * True only when the native Claude JSONL contains a tool_result for the
     * AskUserQuestion bound to `prompt`. TUI-captured prompts use a stable
     * content-derived id rather than Claude's tool_use id, so bind the native
     * call by its exact question/header/option identity first (ignoring only
     * Claude's synthetic freeform/chat rows) and only then accept its matching
     * tool_use_id. A later identical unresolved call resets the result, keeping
     * latest-call-wins semantics.
     */
    private hasBoundClaudeAskUserQuestionToolResult(prompt: InteractivePrompt): boolean {
        if (this.cliType !== 'claude-cli' || this.spec.native_history?.source?.kind !== 'jsonl') return false;
        try {
            const history = executeNativeHistory(this.spec.native_history, {
                agentType: this.cliType,
                providerSessionId: this.providerSessionId,
                sessionStartedAtMs: this.spawnedAtMs,
                envOverrides: this.spawnedEnv,
                workspace: this.workingDir,
                instanceId: this.owningSessionId,
            });
            if (!history?.sourcePath) return false;

            let boundToolUseId: string | null = null;
            let resolved = false;
            for (const record of readJsonlLines(history.sourcePath)) {
                const observedPrompt = detectClaudeAskUserQuestionPromptFromJson(record, this.cliType);
                if (observedPrompt
                    && (observedPrompt.promptId === prompt.promptId
                        || this.claudeAskUserQuestionPromptsMatch(prompt, observedPrompt))) {
                    boundToolUseId = observedPrompt.promptId;
                    resolved = false;
                }
                if (!boundToolUseId) continue;
                if (this.readClaudeToolResultIds(record).includes(boundToolUseId)) resolved = true;
            }
            return resolved;
        } catch {
            // Native history is corroborating evidence only. If it cannot be
            // read or bound, retain the screen/state fail-closed path.
            return false;
        }
    }

    private claudeAskUserQuestionPromptsMatch(expected: InteractivePrompt, observed: InteractivePrompt): boolean {
        if (expected.questions.length !== observed.questions.length) return false;
        return expected.questions.every((expectedQuestion, index) => {
            const observedQuestion = observed.questions[index];
            if (!observedQuestion
                || this.normalizeClaudeTuiIdentity(expectedQuestion.question)
                    !== this.normalizeClaudeTuiIdentity(observedQuestion.question)) return false;

            const observedHeader = this.normalizeClaudeTuiIdentity(observedQuestion.header || '');
            if (observedHeader
                && this.normalizeClaudeTuiIdentity(expectedQuestion.header || '') !== observedHeader) return false;

            // Claude's native tool input omits the synthetic TUI escape rows.
            // Compare its complete option list against the captured picker
            // after removing only those known synthetic labels.
            const expectedLabels = expectedQuestion.options
                .map(option => this.normalizeClaudeTuiIdentity(option.label))
                .filter(label => !/^(?:Type something\.?|Chat about this)$/i.test(label));
            const observedLabels = observedQuestion.options
                .map(option => this.normalizeClaudeTuiIdentity(option.label));
            return expectedLabels.length === observedLabels.length
                && expectedLabels.every((label, optionIndex) => label === observedLabels[optionIndex]);
        });
    }

    private readClaudeToolResultIds(value: unknown): string[] {
        if (!value || typeof value !== 'object') return [];
        const record = value as Record<string, unknown>;
        const blocks: unknown[] = [];
        if (Array.isArray(record.content)) blocks.push(...record.content);
        const message = record.message;
        if (message && typeof message === 'object' && Array.isArray((message as Record<string, unknown>).content)) {
            blocks.push(...((message as Record<string, unknown>).content as unknown[]));
        }
        if (record.type === 'tool_result') blocks.push(record);

        const ids: string[] = [];
        for (const block of blocks) {
            if (!block || typeof block !== 'object') continue;
            const candidate = block as Record<string, unknown>;
            if (candidate.type !== 'tool_result') continue;
            const id = typeof candidate.tool_use_id === 'string' ? candidate.tool_use_id.trim() : '';
            if (id) ids.push(id);
        }
        return ids;
    }

    /**
     * Read the pending AskUserQuestion off claude's native JSONL transcript, or
     * null when there is none / it cannot be read.
     *
     * `ADHDEV_DISABLE_CLAUDE_JSONL_PROMPT=1` forces the legacy screen-scrape
     * path. It exists so the fallback stays exercisable — both in the injection
     * test that proves the scrape still produces the (broken) split labels, and
     * on a live machine where a transcript-format change would otherwise need a
     * downgrade to diagnose.
     */
    private detectClaudeNativePendingQuestion(): InteractivePrompt | null {
        if (process.env.ADHDEV_DISABLE_CLAUDE_JSONL_PROMPT === '1') return null;
        if (!this.spec.native_history?.source) return null;
        try {
            return detectClaudePendingQuestion(this.spec.native_history, {
                agentType: this.cliType,
                providerSessionId: this.providerSessionId || undefined,
                sessionStartedAtMs: this.spawnedAtMs,
                envOverrides: this.spawnedEnv,
                workspace: this.workingDir,
                // Sidecar-claim owner token — without it resolution fails closed
                // on ambiguity, same as the kimi wire call site.
                instanceId: this.owningSessionId || undefined,
            });
        } catch {
            // Fail open: the caller falls back to the screen scrape.
            return null;
        }
    }

    private maybeCaptureClaudeTuiPrompt(): void {
        if (this.interactivePromptScheme() !== 'claude_tui'
            || this.activeInteractivePrompt
            || this.claudeTuiPromptCaptureInFlight) return;
        // QUOTED-MARKER DEFENCE (2026-08-28): the capture below is pure screen
        // scraping, so a session that merely PRINTS the picker's marker strings
        // ("Enter to select", "✔ Submit", "❐ 1. …" — e.g. quoting a TUI layout
        // in its own output) used to parse as a live picker and publish a phony
        // waiting_choice prompt while the agent was still generating.
        //
        // The FSM already distinguishes the two: the claude spec has a dedicated
        // `picker` state (status falls through to idle) and its `busy` state
        // transitions explicitly NOT-match the picker footer, so a real picker is
        // never reported as generating. Gating on that is the same cheap
        // cross-check the kimi built-in selector already applies for the exact
        // same failure mode (refreshWirePendingQuestion: "a quoted snapshot in
        // scrolling output must never parse as the picker").
        if (this.latestState?.status === 'generating') return;
        const screenText = this.driver.snapshot();
        if (!screenText.includes('Enter to select')) {
            // Picker gone — re-arm capture for the next prompt, but only once
            // the footer has STAYED absent across the repaint-grace window.
            // A single footer-less frame is claude mid-repaint (chunked
            // redraw), not a closed picker: clearing the latch here on one
            // frame is how capture re-armed and restarted key injection
            // while the owner was mid-answer.
            const now = Date.now();
            if (this.claudeTuiCaptureFooterAbsentAt === null) this.claudeTuiCaptureFooterAbsentAt = now;
            if (now - this.claudeTuiCaptureFooterAbsentAt >= SpecCliAdapter.INTERACTIVE_PROMPT_LOST_GRACE_MS) {
                this.claudeTuiCaptureSuppressed = false;
                this.claudeTuiCaptureFailures = null;
            }
            return;
        }
        this.claudeTuiCaptureFooterAbsentAt = null;

        // NATIVE-JSONL FIRST (structured source of truth). The picker IS on
        // screen (footer present, not generating) — so if claude's own
        // transcript shows an unanswered AskUserQuestion, take its verbatim
        // labels/descriptions/previews instead of scraping them back off the
        // terminal, where a wrapped label is indistinguishable from a
        // description. Screen presence stays the liveness gate; the transcript
        // supplies only the CONTENT.
        //
        // Deliberately non-exclusive: on any miss (transcript not yet written,
        // unresolvable path, read error) this falls through to the scrape below
        // unchanged. That fallback is why a JSONL write lagging the repaint
        // degrades to the old behaviour rather than to no prompt at all.
        const nativePrompt = this.detectClaudeNativePendingQuestion();
        if (nativePrompt) {
            this.activeInteractivePrompt = nativePrompt;
            this.interactivePromptTransport = 'tui';
            this.interactivePromptLostAt = null;
            this.statusCallback?.();
            return;
        }

        const headers = this.readClaudeTuiHeaders(screenText);
        if (headers.length === 0) {
            // Headerless (single-question) capture parses the CURRENT screen
            // only and injects no keys — always safe, even while the owner is
            // driving the picker from the terminal.
            const prompt = detectClaudeAskUserQuestionPromptFromTuiPages([{ screenText }], {
                // REBIND OPTION FIDELITY (rc.20): provisional id — replaced with the
                // content-addressed stable id below, so the SAME picker re-captured
                // after a daemon restart keeps the SAME promptId and pre-restart
                // answers still bind to the options they were issued against.
                promptId: 'ask-user-tui-pending',
                providerType: this.cliType,
            });
            if (!prompt) return;
            prompt.promptId = stableClaudeTuiPromptId(prompt.questions);
            this.activeInteractivePrompt = prompt;
            this.interactivePromptTransport = 'tui';
            this.interactivePromptLostAt = null;
            this.statusCallback?.();
            return;
        }
        // Owner is driving this picker from the terminal — stay hands-off. The
        // multi-question capture injects Tab/Shift-Tab into the same input
        // stream the owner's keystrokes are in.
        if (this.claudeTuiCaptureSuppressed) return;
        // The review/submit page ("Ready to submit your answers?") still shows
        // the nav line + footer, so it looks capturable — but it parses to null
        // BY DESIGN, which used to leave activeInteractivePrompt null and
        // re-arm this whole capture on the very next frame: a Tab/Shift-Tab
        // injection loop running at the exact moment the owner presses Enter
        // on the pre-selected Submit row. Never capture from the review page.
        if (isClaudeTuiReviewScreen(screenText)) return;
        // Bound retries per prompt identity so an unparsable picker cannot
        // become a key-injection storm (see claudeTuiCaptureFailures).
        const navKey = headers.join('\u0001');
        if (this.claudeTuiCaptureFailures?.key === navKey
            && this.claudeTuiCaptureFailures.count >= SpecCliAdapter.CLAUDE_TUI_CAPTURE_MAX_ATTEMPTS) return;
        this.claudeTuiPromptCaptureInFlight = true;
        void this.captureClaudeTuiPrompt(screenText, headers).finally(() => {
            this.claudeTuiPromptCaptureInFlight = false;
        });
    }

    /**
     * The TUI prompt is captured on the FIRST frame that renders the
     * "Enter to select" footer. At that instant the option rows' checkbox
     * column may not have drawn yet, so `detectClaudeTuiMultiSelect` returns
     * false and the prompt is frozen as single-select — the dashboard then
     * renders radio buttons even though the picker is multi-select.
     *
     * While the same TUI prompt is still on screen, re-check the live snapshot:
     * if checkbox glyphs have since appeared, promote any single-select
     * question to multi-select and re-emit status. Promotion is one-way
     * (false→true only) — once a question is known multi-select we never demote
     * it, since the glyph column can scroll out of view on later frames.
     *
     * For MULTI-question prompts the per-page Tab capture is the actual source
     * of the bug: pages 2..N are snapshotted ~120ms after the Tab keypress,
     * before their option-row glyph column has redrawn, so those questions
     * freeze as single-select while page 1 (already settled) is correct. We
     * cannot upgrade blindly — the live snapshot shows only ONE focused page —
     * but we CAN read that page's question text/header and upgrade the matching
     * question. As the user navigates the picker (or it settles), each page is
     * eventually re-read and repaired.
     */
    private maybeUpgradeClaudeTuiMultiSelect(): void {
        if (this.interactivePromptScheme() !== 'claude_tui'
            || this.interactivePromptTransport !== 'tui'
            || !this.activeInteractivePrompt) return;
        const questions = this.activeInteractivePrompt.questions;
        if (questions.every(q => q.multiSelect)) return;
        let screenText = '';
        try {
            screenText = this.driver.snapshot();
        } catch {
            return;
        }
        if (!screenText.includes('Enter to select')) return;

        if (questions.length === 1) {
            if (questions[0].multiSelect) return;
            const focused = readFocusedClaudeTuiQuestion(screenText);
            if (!focused || !this.claudeTuiQuestionMatches(questions[0], focused) || !focused.multiSelect) return;
            questions[0].multiSelect = true;
            this.statusCallback?.();
            return;
        }

        // Multi-question: attribute the focused page's glyphs to its question by
        // matching header (preferred) or question text, then upgrade just that
        // one. Never demote — a settled non-multi page is left as captured.
        const focused = readFocusedClaudeTuiQuestion(screenText);
        if (!focused || !focused.multiSelect) return;
        const match = questions.find(q => this.claudeTuiQuestionMatches(q, focused));
        if (!match || match.multiSelect) return;
        match.multiSelect = true;
        this.statusCallback?.();
    }

    private normalizeClaudeTuiIdentity(text: string): string {
        return text.replace(/\s+/g, ' ').trim();
    }

    private claudeTuiQuestionMatches(
        expected: InteractivePrompt['questions'][number],
        focused: { question: string; header?: string },
    ): boolean {
        const expectedQuestion = this.normalizeClaudeTuiIdentity(expected.question);
        const focusedQuestion = this.normalizeClaudeTuiIdentity(focused.question);
        // The question line is always present when the focused-page parser
        // succeeds. Do not accept a header-only match: headers such as Model or
        // Approach are reusable across unrelated pickers, while a false match
        // here would authorize keystrokes against the wrong widget.
        return !!expectedQuestion && expectedQuestion === focusedQuestion;
    }

    private claudeTuiQuestionTextAppears(
        expected: InteractivePrompt['questions'][number],
        screenText: string,
    ): boolean {
        const expectedQuestion = this.normalizeClaudeTuiIdentity(expected.question);
        const focusedPickerRegion = readFocusedClaudeTuiPickerRegion(screenText);
        return !!expectedQuestion
            && focusedPickerRegion !== null
            && this.normalizeClaudeTuiIdentity(focusedPickerRegion).includes(expectedQuestion);
    }

    private readClaudeTuiSnapshotForAnswer(): string {
        try {
            return this.driver.snapshot();
        } catch (error: any) {
            throw new Error(`Cannot verify the focused Claude TUI question before answering: ${error?.message || error}`);
        }
    }

    private async assertFocusedClaudeTuiQuestion(
        expected: InteractivePrompt['questions'][number],
        prompt: InteractivePrompt,
    ): Promise<'focused' | 'completed'> {
        // MULTI-QUESTION PAGE REPAINT RACE (live defect, 2026-09-02).
        //
        // This used to gate on a SINGLE snapshot. In a multi-question prompt the
        // keystroke that answers question N is also what navigates the picker
        // onto question N+1, and that repaint is not instantaneous: the fixed
        // 180ms inter-key delay in setInteractivePromptResponse races it. On a
        // slow frame the next iteration's snapshot still showed the PREVIOUS
        // page, so the assertion fired with expected = the question we were
        // about to answer and focused = the one still on screen — the observed
        // "expected <question 2>; focused question is <question 1>" failure.
        // Because the picker never moves, every retry reproduced it identically:
        // a permanent deadlock on any 2+ question prompt.
        //
        // Single-question prompts never hit this (one iteration, no page
        // transition), which is why the defect looked multi-question-specific.
        //
        // The fix is the same bounded settle-poll assertFocusedClaudeTuiReview
        // already applies to the review page for this exact class of race: keep
        // re-snapshotting until the expected page lands, then fall through to
        // the last frame so a genuinely WRONG screen still fails closed with its
        // real content. A foreign picker that never becomes the expected page
        // costs only the bounded budget before it is rejected.
        const settleTimeoutMs = expected.allowFreeform
            ? SpecCliAdapter.CLAUDE_TUI_REVIEW_SETTLE_TIMEOUT_MS
            : SpecCliAdapter.CLAUDE_TUI_PAGE_SETTLE_TIMEOUT_MS;
        const deadline = Date.now() + settleTimeoutMs;
        let screenText = this.readClaudeTuiSnapshotForAnswer();
        let focused = readFocusedClaudeTuiQuestion(screenText);
        while (Date.now() < deadline && !(focused && this.claudeTuiQuestionMatches(expected, focused))) {
            // Either a stale/foreign page or no picker at all. Both can be
            // mid-repaint, and the no-picker case is separately resolved as
            // 'completed' below — so keep sampling rather than deciding on a
            // single transient frame.
            await new Promise(resolve => setTimeout(resolve, SpecCliAdapter.CLAUDE_TUI_PAGE_POLL_INTERVAL_MS));
            screenText = this.readClaudeTuiSnapshotForAnswer();
            focused = readFocusedClaudeTuiQuestion(screenText);
        }
        if (focused) {
            if (this.claudeTuiQuestionMatches(expected, focused)) return 'focused';
            throw new Error(`Claude TUI focused question does not match the active interactive prompt (expected "${expected.question}"; focused question is "${focused.question}")`);
        }

        // A direct-submit Claude TUI can resolve the question after an early
        // keystep (for example, the first digit of a previously multi-step
        // answer). Once the picker is gone, corroborate completion before
        // stopping the key loop so no remaining answer keys leak into the next
        // widget. A visible foreign picker is handled above and always fails
        // closed, even if the provider concurrently reports busy.
        const resolvedByBoundToolResult = this.hasBoundClaudeAskUserQuestionToolResult(prompt);
        const resolvedByBusyAdvance = this.latestState?.status === 'generating';
        if (resolvedByBoundToolResult || resolvedByBusyAdvance) return 'completed';

        throw new Error(`Claude TUI focused question does not match the active interactive prompt (expected "${expected.question}")`);
    }

    /**
     * Wait for the review page to actually be on screen before the final Enter.
     *
     * The last answer keystroke is what navigates the picker onto its review
     * page, and the TUI repaint is not instantaneous. Gating on a single
     * snapshot taken a fixed delay after that keypress races the repaint: on a
     * slow frame the assertion still sees the previous question page and fails
     * closed, refusing an answer that was in fact correct (live defect
     * 2026-08-28). Poll on the same bounded budget the capture path already
     * uses (snapshotSettledClaudeTuiPage) and accept the first frame that reads
     * as the review page; on timeout fall through to the last frame so a
     * genuinely wrong screen still fails closed with its real content.
     *
     * `allowsFreeform` widens the budget to CLAUDE_TUI_REVIEW_SETTLE_TIMEOUT_MS
     * (residual gap, live defect 2026-08-29): a picker that allows freeform
     * input ("Type something." / Other) carries a heavier layout burden even if
     * the user selects a standard option. The wider budget accounts for this
     * extra layout time when validating the review echo screen.
     */
    private async snapshotSettledClaudeTuiReview(prompt: InteractivePrompt, allowsFreeform: boolean): Promise<string | null> {
        let screenText = this.readClaudeTuiSnapshotForAnswer();
        const budgetMs = allowsFreeform
            ? SpecCliAdapter.CLAUDE_TUI_REVIEW_SETTLE_TIMEOUT_MS
            : SpecCliAdapter.CLAUDE_TUI_PAGE_SETTLE_TIMEOUT_MS;
        const deadline = Date.now() + budgetMs;
        let poll = 0;
        while (true) {
            poll += 1;
            const focused = readFocusedClaudeTuiQuestion(screenText);
            const review = !focused && isClaudeTuiReviewScreen(screenText);
            let classification: string;
            let directSubmitted = false;

            if (focused) {
                const boundQuestion = prompt.questions.some(question => this.claudeTuiQuestionMatches(question, focused));
                classification = boundQuestion ? 'bound_question' : 'foreign_question';
            } else if (review) {
                classification = 'review';
            } else if (!this.activeInteractivePrompt) {
                // The ordinary stale cleanup or a future native tool-result
                // observer may have cleared the prompt between poll samples.
                classification = 'direct_submit_already_cleared';
                directSubmitted = true;
            } else if (this.activeInteractivePrompt.promptId !== prompt.promptId) {
                classification = 'active_prompt_changed';
            } else {
                const resolvedByBoundToolResult = this.hasBoundClaudeAskUserQuestionToolResult(prompt);
                const resolution = this.maybeClearResolvedClaudeTuiPrompt({
                    screenText,
                    resolveImmediatelyWhenBusy: true,
                    resolvedByBoundToolResult,
                });
                classification = resolution === 'cleared'
                    ? resolvedByBoundToolResult
                        ? 'direct_submit_tool_result'
                        : 'direct_submit_busy'
                    : resolution === 'held'
                        ? 'bound_question_unparsed'
                        : resolution === 'missing'
                            ? 'bound_question_missing'
                            : 'snapshot_unavailable';
                directSubmitted = resolution === 'cleared';
            }

            // Screen text can contain source, secrets, or user input. Keep the
            // answer-settle diagnostic deliberately structural: classification,
            // UTF-8 byte count, poll index, and spec-defined provider state.
            LOG.debug(
                'SpecAdapter',
                `[${this.cliType}] Claude TUI answer poll=${poll} classification=${classification} screenBytes=${Buffer.byteLength(screenText, 'utf8')} providerState=${this.latestState?.id ?? 'unknown'} providerStatus=${this.latestState?.status ?? 'unknown'} allowsFreeform=${allowsFreeform}`,
            );

            if (review) return screenText;
            if (directSubmitted) return null;
            if (Date.now() >= deadline) return screenText;
            await new Promise(resolve => setTimeout(resolve, SpecCliAdapter.CLAUDE_TUI_PAGE_POLL_INTERVAL_MS));
            screenText = this.readClaudeTuiSnapshotForAnswer();
        }
    }

    private async assertFocusedClaudeTuiReview(prompt: InteractivePrompt, allowsFreeform: boolean): Promise<void> {
        const screenText = await this.snapshotSettledClaudeTuiReview(prompt, allowsFreeform);
        if (screenText === null) return;
        const focused = readFocusedClaudeTuiQuestion(screenText);
        if (focused || !isClaudeTuiReviewScreen(screenText)) {
            const observed = focused?.question ? `; focused question is "${focused.question}"` : '';
            // Log here, not just throw: the caller (mesh-events.ts
            // interactive_prompt_response handler) returns this over the P2P
            // command response as a plain { success: false } object with no
            // LOG.* call of its own, so without a line here this failure class
            // leaves NO trace in the daemon log — confirmed live 2026-08-29,
            // where a dashboard-visible "review page is not focused" error had
            // zero matching log output.
            LOG.warn('SpecAdapter', `[${this.cliType}] assertFocusedClaudeTuiReview failed closed (allowsFreeform=${allowsFreeform})${observed}`);
            throw new Error(`${CLAUDE_TUI_REVIEW_PAGE_NOT_FOCUSED_PREFIX} for the active interactive prompt${observed}`);
        }

        // Review pages retain the per-question nav headers. When the captured
        // prompt has headers, require the focused review nav to carry them so
        // a second AskUserQuestion review page cannot borrow the final Enter.
        const expectedHeaders = prompt.questions
            .map(q => q.header && this.normalizeClaudeTuiIdentity(q.header))
            .filter((header): header is string => !!header);
        if (expectedHeaders.length === 0) return;
        const reviewHeaders = this.readClaudeTuiHeaders(screenText)
            .map(header => this.normalizeClaudeTuiIdentity(header));
        if (expectedHeaders.every(header => reviewHeaders.includes(header))) return;
        throw new Error('Claude TUI review page does not match the active interactive prompt headers');
    }

    private readClaudeTuiHeaders(screenText: string): string[] {
        const lines = screenText.split(/\r?\n/);
        let navLine: string | undefined;
        for (let index = lines.length - 1; index >= 0; index -= 1) {
            if (lines[index].includes('✔ Submit') && /[☐☒]/.test(lines[index])) {
                navLine = lines[index];
                break;
            }
        }
        if (!navLine) return [];
        const headers: string[] = [];
        for (const match of navLine.matchAll(/[☐☒]\s+(.+?)(?=\s+[☐☒]|\s+✔\s+Submit)/g)) {
            const header = match[1]?.trim();
            if (header) headers.push(header);
        }
        return headers;
    }

    /**
     * Snapshot the currently-focused claude TUI page, polling until its
     * option-row checkbox glyph column has settled (or a bounded timeout).
     *
     * Why poll: right after a Tab keypress the newly-focused page's glyph
     * column has not redrawn yet, so an immediate snapshot shows the question +
     * option labels but NO per-option checkbox markers — freezing that page as
     * single-select. A fixed delay either races (too short) or is wasteful (too
     * long). Instead we re-snapshot at a fixed interval and stop as soon as the
     * frame shows multi-select glyphs, falling back to the last frame at the
     * timeout. Single-select pages never show glyphs, so they always poll to the
     * timeout — bounded small to keep capture snappy.
     */
    private async snapshotSettledClaudeTuiPage(): Promise<string> {
        let screenText = this.driver.snapshot();
        const deadline = Date.now() + SpecCliAdapter.CLAUDE_TUI_PAGE_SETTLE_TIMEOUT_MS;
        while (!detectClaudeTuiMultiSelect(screenText) && Date.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, SpecCliAdapter.CLAUDE_TUI_PAGE_POLL_INTERVAL_MS));
            screenText = this.driver.snapshot();
        }
        return screenText;
    }

    /**
     * Is `reread` a re-render of the SAME picker page as `landed`?
     *
     * Guards the return-pass screenText swap in captureClaudeTuiPrompt, which
     * replaces a page's entire raw screen and therefore must never be handed a
     * frame belonging to a different question.
     *
     * WHAT WE COMPARE — the question line, via the same parser the capture
     * itself uses (readFocusedClaudeTuiQuestion). Rationale:
     *  - The question text is the one field that is per-page, always rendered
     *    (it is the parse anchor — a page without it yields no question at all),
     *    and stable across the redraw we are waiting on. The redraw races the
     *    option-row GLYPH COLUMN, not the question line.
     *  - The header is NOT usable on its own: on the headered variant every page
     *    renders the identical nav line, and `page.header` is assigned by index
     *    from that shared line rather than read from the page body — so it is
     *    equal across pages by construction and would accept any frame.
     *  - The option-label set is rejected as the primary key: it is drawn in the
     *    very region that is mid-redraw, and rows can be clipped or scrolled out
     *    of the captured frame (the same truncation that forced the headerless
     *    parser to stop requiring the freeform escape hatch). Comparing it would
     *    reject legitimate repairs — exactly the frames this pass exists to fix.
     *
     * STRICTNESS — deliberately asymmetric, because the two error directions are
     * not equally costly. Wrongly ALLOWING a swap corrupts a question into a
     * duplicate of another (the reported user-visible defect). Wrongly BLOCKING
     * one merely leaves the forward-pass capture in place — at worst a
     * multi-select page stays flagged single-select, which the live status-tick
     * upgrade (maybeUpgradeClaudeTuiMultiSelect) then repairs anyway. So this
     * blocks only on POSITIVE EVIDENCE of a different page: if either side fails
     * to parse we return true and defer to the pre-existing glyph gate, keeping
     * behaviour identical to before for every frame whose identity we cannot
     * read. Comparison is whitespace-normalised so a reflow or trailing-pad
     * difference does not read as a different question.
     */
    private claudeTuiPagesLookLikeSameQuestion(landed: ClaudeInteractiveTuiPage, reread: string): boolean {
        const landedQuestion = readFocusedClaudeTuiQuestion(landed.screenText);
        const rereadQuestion = readFocusedClaudeTuiQuestion(reread);
        // Unparseable on either side → no evidence of a mismatch; fail open.
        if (!landedQuestion || !rereadQuestion) return true;
        const normalize = (text: string): string => text.replace(/\s+/g, ' ').trim();
        return normalize(landedQuestion.question) === normalize(rereadQuestion.question);
    }

    private async captureClaudeTuiPrompt(firstScreen: string, headers: string[]): Promise<void> {
        // Owner typed between detection and capture start — bail before any
        // key is injected (owner input wins over dashboard capture fidelity).
        if (this.claudeTuiCaptureSuppressed) return;
        const pages: ClaudeInteractiveTuiPage[] = [{ screenText: firstScreen, header: headers[0] }];
        // Forward pass: Tab to each page 2..N and snapshot once its glyph column
        // has settled, so pages 2+ capture their checkbox markers (not a racy
        // pre-redraw frame).
        for (let index = 1; index < headers.length; index += 1) {
            // Abort before injecting the NEXT key if the owner started typing
            // mid-capture — the keys below land in the owner's input stream.
            if (this.claudeTuiCaptureSuppressed) return;
            this.driver.dispatch({ kind: 'pty_write', data: '\t' });
            await new Promise(resolve => setTimeout(resolve, SpecCliAdapter.CLAUDE_TUI_PAGE_POLL_INTERVAL_MS));
            pages.push({ screenText: await this.snapshotSettledClaudeTuiPage(), header: headers[index] });
        }
        // Return pass: Shift-Tab back through pages N..2. As we land on each page
        // again re-read it and OR-in any now-visible multi-select glyphs — a
        // second chance to repair a page whose forward-pass frame was still racy.
        for (let index = headers.length - 1; index > 0; index -= 1) {
            if (this.claudeTuiCaptureSuppressed) return;
            this.driver.dispatch({ kind: 'pty_write', data: '\x1b[Z' });
            await new Promise(resolve => setTimeout(resolve, SpecCliAdapter.CLAUDE_TUI_PAGE_POLL_INTERVAL_MS));
            const reread = await this.snapshotSettledClaudeTuiPage();
            // The page we just Shift-Tab'd ONTO is index-1 (we move backwards).
            const landed = pages[index - 1];
            if (landed
                && !detectClaudeTuiMultiSelect(landed.screenText)
                && detectClaudeTuiMultiSelect(reread)
                // PAGE IDENTITY GUARD: the swap below replaces this page's WHOLE
                // raw screen, so it is only sound if `reread` is the same page we
                // captured going forward. The glyph signal alone cannot tell us
                // that: if the Shift-Tab keypress was swallowed (or the picker had
                // not moved yet when the frame settled) the re-read is still the
                // NEXT page, and we would overwrite this question with that one's
                // text + options + checkboxes. Because `header` is carried
                // separately (by nav-line index) it stays correct, producing the
                // observed symptom — question N-1 rendered with its own header but
                // question N's title, body and checkboxes.
                && this.claudeTuiPagesLookLikeSameQuestion(landed, reread)) {
                landed.screenText = reread;
            }
        }

        const prompt = detectClaudeAskUserQuestionPromptFromTuiPages(pages, {
            // REBIND OPTION FIDELITY (rc.20): provisional id — replaced with the
            // content-addressed stable id below (same rationale as the
            // headerless capture in maybeCaptureClaudeTuiPrompt).
            promptId: 'ask-user-tui-pending',
            providerType: this.cliType,
        });
        if (!prompt) {
            // Parse failure: the picker stays un-held, so maybeCapture would
            // re-run this whole injection pass on the next frame. Count the
            // failure against this prompt's nav identity so retries are
            // bounded (CLAUDE_TUI_CAPTURE_MAX_ATTEMPTS).
            this.noteClaudeTuiCaptureFailure(headers);
            return;
        }
        this.claudeTuiCaptureFailures = null;
        prompt.promptId = stableClaudeTuiPromptId(prompt.questions);
        this.activeInteractivePrompt = prompt;
        this.interactivePromptTransport = 'tui';
        this.interactivePromptLostAt = null;
        this.statusCallback?.();
    }

    /** Record a failed multi-question capture against the prompt's nav-line
     *  identity so maybeCaptureClaudeTuiPrompt can bound retries. */
    private noteClaudeTuiCaptureFailure(headers: string[]): void {
        const navKey = headers.join('\u0001');
        if (this.claudeTuiCaptureFailures?.key === navKey) {
            this.claudeTuiCaptureFailures.count += 1;
        } else {
            this.claudeTuiCaptureFailures = { key: navKey, count: 1 };
        }
        const { count } = this.claudeTuiCaptureFailures;
        LOG.warn(
            'SpecAdapter',
            `[${this.cliType}] TUI prompt capture failed to parse (attempt ${count}/${SpecCliAdapter.CLAUDE_TUI_CAPTURE_MAX_ATTEMPTS}) — ${count >= SpecCliAdapter.CLAUDE_TUI_CAPTURE_MAX_ATTEMPTS ? 'giving up until the picker leaves the screen' : 'one retry remains'}`,
        );
    }

    getDebugState(): Record<string, any> {
        const screen = this.driver.getScreen?.() ?? '';
        const history = this.driver.getStateHistory();
        const status = this.getStatus();
        
        let messages: any[] = [];
        if (this.spec.native_history?.source) {
            try {
                const result = executeNativeHistory(this.spec.native_history, {
                    agentType: this.cliType,
                    providerSessionId: this.providerSessionId,
                    sessionStartedAtMs: this.spawnedAtMs,
                    envOverrides: this.spawnedEnv,
                    workspace: this.workingDir,
                });
                if (result && Array.isArray(result.messages)) {
                    messages = result.messages;
                }
            } catch (e) {
                // Ignore native history read errors in debug state
            }
        } else {
            messages = this.readScreenAssistantMessages();
        }

        const latestState = this.latestState;
        const latestModal = this.latestModal;
        return {
            type: this.cliType,
            name: this.cliName,
            status: status.status,
            rawStatus: status.status,
            projectedStatus: status.status,
            ready: this.spawned,
            // Legacy snapshot-style fields for panels that read getDebugSnapshot shape
            spec_id: this.spec.id,
            current_state: latestState ?? null,
            current_modal: latestModal ?? null,
            // Interactive-prompt hold (waiting_choice path) — surfaced so the
            // spec-verification workflow can observe wire/TUI prompt capture
            // per session (it was previously invisible in this bundle).
            activeInteractivePrompt: this.activeInteractivePrompt ?? null,
            exited: this.exited,
            idleHoldPending: this.driver.hasIdleHoldPending?.() ?? false,
            lastBusyAt: this.driver.getLastBusyAt?.() ?? 0,
            screen: screen,
            screenText: screen,
            workingDir: this.workingDir,
            spawnedAtMs: this.spawnedAtMs,
            providerSessionId: this.providerSessionId ?? null,
            sections: this.driver.getSections?.() ?? null,
            stateHistory: history,
            specPath: this.driver.getSpecPath?.() ?? null,
            // v4 FSM live transition table — present only for FsmDriver. Lets
            // the panel (and the daemon API) show, for the current instant,
            // every outgoing transition with its per-condition match result
            // and countdown. This is the canonical "why isn't it transitioning"
            // answer — no screenshots needed.
            fsm: this.driver.getFsmDebug?.() ?? null,
            // v4 FSM transition snapshot history — the captured pre-transition
            // evaluation table at each transition (null for v3 specs).
            fsmHistory: this.driver.getFsmSnapshotHistory?.() ?? null,
            // PTY input/output/resize/cursor event timeline (debug-only).
            eventTimeline: this.driver.getEventTimeline?.() ?? null,
            messages,
            committedMessages: messages,
        };
    }

    getTraceState(limit = 120): Record<string, any> {
        const history = this.driver.getStateHistory();
        return {
            status: this.getStatus().status,
            stateHistory: history.slice(-limit),
            screenText: this.driver.getScreen?.() ?? '',
        };
    }

    getProviderResolutionMeta(): Record<string, any> {
        return {
            type: this.cliType,
            providerDir: null,
            resolvedVersion: null,
        };
    }
}
