/**
 * CliAdapter — common interface for CLI agents
 *
 * Contract implemented by all CLI adapters (ProviderCliAdapter etc).
 */

import type { ChatMessage } from './types.js';
import type { InteractivePrompt, InteractivePromptResponse } from './providers/types/interactive-prompt.js';
import type { MeshSendKeyItem, MeshSendKeyName } from './cli-adapters/provider-cli-shared.js';

/**
 * Why a CLI adapter poked its owner (wiring-unification B2). The adapter only
 * says WHAT KIND of thing changed; the owning instance's status-transition tick
 * is the single diff-and-emit point that decides whether a status / modal /
 * prompt edge actually happened.
 *
 *   fsm_state        — the spec FSM emitted state_changed (state and/or modal)
 *   pty_exit         — the PTY child exited (ordinary stopped transition)
 *   provider_failure — an auth/billing failure was latched (status -> error)
 *   prompt_captured  — an interactive prompt became held (TUI / stream-json / wire)
 *   prompt_cleared   — the held prompt was answered or resolved
 *   prompt_updated   — the held prompt changed in place (multiSelect upgrade)
 */
export type AdapterChangeCause =
    | 'fsm_state'
    | 'pty_exit'
    | 'provider_failure'
    | 'prompt_captured'
    | 'prompt_cleared'
    | 'prompt_updated';

export interface CliAdapterStatus {
    status?: string;
    parsedStatus?: string;
    messages?: ChatMessage[];
    activeModal?: {
        message: string;
        buttons: string[];
        /**
         * BUTTON-INDEX-MISMAP (Fix C.1): each button's label paired with its real FSM
         * DISPLAYED index (evaluator's Number(m[1])). `buttons` above is the label-only list
         * every existing consumer reads (array position === pick order); `buttonMeta` preserves
         * the index → label mapping so a partial / non-contiguous modal (display indices [1,3,4]
         * at array positions [0,1,2]) does not lose its true indices once the modal leaves the
         * adapter. Present only on spec/FSM adapters; absent for adapters that surface labels
         * alone.
         */
        buttonMeta?: { index: number; label: string }[];
        /**
         * Semantic modal class, when the adapter knows it (spec/FSM path):
         * 'approval' = tool/command/trust consent (auto-approve may fire);
         * 'picker' = a selection menu the user opened (/model, /mode — must NOT
         * be auto-answered); 'confirm' = a yes/no left to the user. Absent/null
         * for adapters that don't classify modals — the auto-approve gate then
         * falls back to its structural heuristic.
         */
        kind?: 'approval' | 'picker' | 'confirm' | null;
    } | null;
    activeInteractivePrompt?: InteractivePrompt | null;
    providerSessionId?: string;
    errorMessage?: string;
    errorReason?: string;
    /**
     * FSM-spec adapters only: true once the driver has observed its first
     * non-initial idle state (the prompt is genuinely drawn — see
     * FsmDriver.maybeMarkReady / readySeenOnce). Used by CliProviderInstance to
     * re-arm the queue-claim `agent:ready` event on the first genuine ready,
     * independent of the boot-time starting→idle one-shot. That one-shot is
     * consumed too early for providers whose INITIAL FSM state already reports
     * status 'idle' (e.g. antigravity-cli), so without this re-arm the worker
     * never claims its queued task and the coordinator relaunch-loops. Absent
     * (undefined) for non-FSM adapters — they keep the boot one-shot behavior.
     */
    fsmReadySeen?: boolean;
    /**
     * Wall-clock (ms) of the most recent raw PTY output chunk. Advances on every
     * byte the process emits, including tool/build output that produces no
     * parsed assistant text. Absent until the first chunk. Liveness watchdogs
     * use it to tell a real stall (no output at all) from an active turn whose
     * assistant text is momentarily static while a tool runs.
     */
    lastOutputAt?: number;
    /**
     * Wall-clock (ms) of the most recent *rendered* screen change. Stricter than
     * lastOutputAt — only advances when the rendered text actually differs, so
     * keepalive / cursor-only bytes do not register as progress. Absent until
     * the first change. Preferred liveness signal for the no-progress watchdog.
     */
    lastScreenChangeAt?: number;
    /**
     * Tracked providers (claude-cli, kimi) only: true when the session's
     * native-history transcript shows causally-owned background tool work that
     * must hold completion — ≥1 unresolved `run_in_background` invocation
     * (claude: Bash tool_use with no matching tool_result; kimi: background
     * tool.call cell with no terminal task.* notification / TaskStop result),
     * or (kimi) a resolved background cell whose result the provider has not
     * yet consumed into a final assistant response. NEW passthrough signal —
     * it rides ALONGSIDE `status` and is NOT forced through the 5-value FSM
     * normalization (like `activeModal`/`providerSessionId`). The completion
     * gate uses it to HOLD a false idle→completed transition: the provider can
     * end its model turn with progress prose (idle) while its background cell
     * keeps running, which otherwise fired a false agent:generating_completed
     * and prematurely completed the delegated mesh queue task. Absent/undefined
     * whenever the transcript can't be read or shows nothing outstanding.
     */
    backgroundTaskActive?: boolean;
    /** Count of unresolved (still-running) background invocations (only when backgroundTaskActive). */
    backgroundTaskCount?: number;
    /** Ids of the unresolved background invocations (tool_use ids / kimi task_ids; diagnostics). */
    backgroundTaskIds?: string[];
    /**
     * Whether this provider's background-tool lifecycle is authoritatively
     * tracked from its native transcript. 'tracked' = claude-cli / kimi (the
     * detector understands the record shape); 'unknown' = every other provider
     * (PTY-only FSM adapters, ACP providers — no transcript tool-lifecycle
     * authority exists). 'unknown' is an EXPLICIT contract: the completion
     * path is not gated on background work for these providers, which is
     * documented here rather than silently treated as "no background work".
     */
    backgroundTaskSupport?: 'tracked' | 'unknown';
}

export interface AcpAdapterHandle {
    onEvent(event: string, data?: unknown): void;
    getState(): {
        status: string;
        activeChat?: {
            messages?: ChatMessage[];
            activeModal?: {
                message: string;
                buttons: string[];
            } | null;
        } | null;
    };
    setMode?(mode: string): Promise<void>;
    setConfigOption?(configId: string, value: string): Promise<void>;
    resolvePermission?(approved: boolean): Promise<void>;
}

/**
 * Launch metadata for a CLI session, surfaced by the dashboard Session info panel.
 * Derived from the live adapter's spawn plan — the resolved binary, the full
 * argument vector (provider base args + per-launch extra args), the cwd, and the
 * set of per-launch extra-env KEYS (values are intentionally omitted so secrets in
 * extraEnv are never sent to the dashboard). providerSessionId is the upstream
 * agent's own session id once the CLI reports it.
 */
export interface CliLaunchInfo {
    /** Resolved executable path the PTY actually spawns. */
    command?: string;
    /** Full argument vector (provider spawn.args + extraArgs, {{workingDir}} expanded). */
    args: string[];
    /** Per-launch extra args only (subset of args), for attribution. */
    extraArgs: string[];
    /** Working directory the session was spawned in. */
    cwd: string;
    /** KEYS of per-launch extra env (values omitted — may contain secrets). */
    extraEnvKeys: string[];
    /** Upstream agent session id, once the CLI reports one. */
    providerSessionId?: string;
}

export interface CliAdapter {
    cliType: string;
    cliName: string;
    workingDir: string;
    _acpInstance?: AcpAdapterHandle;
    spawn(): Promise<void>;
    /**
     * `bracketedPaste` routes an image-bearing body through the provider's
     * declared paste channel; `claimKey` (SEND-NOW-DOUBLE-SEND, image bodies) is
     * the raw source text a structured prompt was built from, parked alongside a
     * queued body so out-of-band claims (send-now / cancel / interrupt) can find
     * it by the only identity the dashboard knows.
     */
    sendMessage(text: string, options?: { force?: boolean; meshTaskId?: string; bracketedPaste?: boolean; claimKey?: string }): Promise<{ status: 'queued' | 'delivered' } | void>;
    /**
     * Abort the turn currently in flight by writing the provider's OWN stop key,
     * so the caller can wait for busy→idle and then deliver a new prompt as a
     * genuine turn (SEND-NOW / delivery mode 'interrupt').
     *
     * This replaced `forceSendMessage`, which wrote the body straight into a
     * generating PTY: the bytes were never consumed as a turn and the caller was
     * still told the send succeeded (retired in oss 6cca365b after measured data
     * loss). Optional because only the spec-driven adapter implements it; callers
     * must typeof-guard and report `interrupt_not_implemented` rather than
     * silently falling back to a write.
     */
    interruptTurn?(): Promise<
        | { ok: true; keyName: string; bytes: number; confidence: 'proven' | 'declared' }
        | { ok: false; reason: string; message: string }
    >;
    /**
     * ENTER-LOSS layer ① (2026-09-10 incident: a body written to the PTY lost its
     * CR to a daemon restart and sat in the composer for 1h42m). True while a
     * message body has been written but its submit key is not yet confirmed.
     * Optional — only the spec/FSM adapter implements it; callers typeof-guard
     * and treat absence as "nothing in flight".
     */
    hasInFlightSubmit?(): boolean;
    /**
     * ENTER-LOSS layer ①: resolve once no submit is in flight, or after
     * `timeoutMs` (true = drained, false = timed out). The shutdown path awaits
     * this BEFORE tearing the adapter down, so an in-flight CR gets to fire.
     */
    whenSubmitDrained?(timeoutMs: number): Promise<boolean>;
    /**
     * ENTER-LOSS layer ③ (boot-time composer-residue sweep): scrollback-inclusive
     * raw terminal text. Same security posture as getTerminalScreenSnapshot —
     * may carry user data / tokens; callers MUST NOT log it.
     */
    getScrollbackText?(): string;
    getStatus(options?: { allowParse?: boolean }): CliAdapterStatus;
    getScriptParsedStatus?(): unknown;
    getDebugSnapshot?(): unknown;
    invokeScript?(scriptName: string, args?: Record<string, unknown>): Promise<unknown>;
    saveAndStop?(): Promise<void>;
    shutdown(): void;
    detach?(): void;
    cancel(): void;
    isProcessing(): boolean;
    isReady(): boolean;
    // Liveness of the underlying process/PTY. Optional because not every adapter
    // implementation exposes it (the spec-driven path historically did not); the
    // MESH-STALL-WATCH watchdog must call it defensively (typeof guard) so a
    // missing implementation never throws in the 5s tick.
    isAlive?(): boolean;
    // MESH-READ-TERMINAL (feature 2) / MESH-SEND-KEYS (feature 3). Optional
    // because not every adapter implements the raw-terminal read / structured
    // key-injection surface; callers (cli-provider-instance) MUST typeof-guard
    // and return a clean unsupported result rather than throwing when absent.
    // Both ProviderCliAdapter (PTY path) and SpecCliAdapter (native-source spec
    // path — claude-cli / antigravity / codex-cli) implement them.
    getTerminalScreenSnapshot?(maxBytes?: number): {
        text: string;
        cursor: { col: number; row: number };
        cols: number;
        rows: number;
        truncated: boolean;
        originalBytes: number;
        returnedBytes: number;
        hash: string;
    };
    injectKeys?(
        items: MeshSendKeyItem[],
        opts?: { allowModalOverride?: boolean },
    ): Promise<
        | { ok: true; keys: MeshSendKeyName[]; hasDestructive: boolean; submits: boolean; bytes: number }
        | { ok: false; refused: 'submit_race' | 'actionable_modal' | 'generating'; keys: MeshSendKeyName[]; hasDestructive: boolean; message?: string }
    >;
    setOnStatusChange(callback: () => void): void;
    /**
     * Cause-carrying variant of setOnStatusChange (wiring-unification B2). Every
     * change the adapter would signal through setOnStatusChange also reaches this
     * callback, with its cause. Optional: adapters without it are driven through
     * setOnStatusChange and their ticks carry no adapter cause.
     */
    setOnChange?(callback: (cause: AdapterChangeCause) => void): void;
    /** How the currently held interactive prompt was captured; null when none is held. */
    getInteractivePromptTransport?(): 'tui' | 'stream-json' | 'wire' | null;
    updateRuntimeSettings?(settings: Record<string, unknown>): void;
    setCliScripts?(scripts: Record<string, unknown>): void;
    setServerConn?(serverConn: unknown): void;
    clearHistory?(): void;
    resolveAction?(data: unknown): Promise<void>;
    setInteractivePromptResponse?(response: InteractivePromptResponse): Promise<void>;
    resolveModal?(buttonIndex: number): void;
    // BUTTON-INDEX-MISMAP (Fix C.3): resolve a modal button by ARRAY POSITION and report
    // whether a real button was matched (the FSM found a button for the mapped display index
    // and dispatched its confirm keys). A `false` verdict means the requested position mapped
    // to no button — the caller (mesh_approve) must then NOT report success. Optional so
    // legacy adapters that only expose the void resolveModal keep working (the caller falls
    // back to resolveModal + the resolution-cooldown check).
    resolveModalMatched?(buttonIndex: number): boolean;
    isApprovalRecentlyResolved?(): boolean;
    /**
     * APPROVE-LATCH-STALE (live defect, 2026-09-23): force one live re-parse of
     * the approval modal from the CURRENT screen and report whether a modal with
     * buttons is now latched.
     *
     * Exists because the latched modal can be arbitrarily stale in a quiet TUI:
     * the FSM latch is refreshed only by a driver emit, an emit happens only on a
     * PTY frame or an armed wake timer, and a modal state whose exits are pure
     * content guards arms no timer. A `busy→approval-timeout` entry (no modal
     * anchor in the transition) can therefore latch `activeModal: null` while the
     * status is authoritatively waiting_approval — and mesh_approve refuses a
     * session that is really sitting at a drawn picker.
     *
     * Contract: refreshes the MODAL only. It must never be used to derive or
     * change status — see adapter-status-projection.ts:81-84.
     *
     * Optional: legacy/non-FSM adapters and test doubles omit it, and callers
     * typeof-guard and fall through to the latched value.
     */
    refreshModalNow?(): boolean;
    /**
     * TX-FSM Stage 0 (shadow): receive the daemon-normalized transcript signal
     * observation (SignalSnapshot envelope, providers/spec/signal-envelope.ts).
     * Optional — only the spec-driven FSM adapter implements it; callers must
     * typeof-guard. Shadow-only: the observation can never gate a transition.
     */
    setSignalObservation?(snapshot: unknown): void;
 // Raw PTY I/O (for terminal view)
    setOnPtyData?(callback: (data: string) => void): void;
    writeRaw?(data: string): void;
    resize?(cols: number, rows: number): void;
    // ── Launch metadata for the dashboard Session info panel (args/cwd/env keys) ──
    getLaunchInfo?(): CliLaunchInfo;
    // ── Runtime metadata used by CliProviderInstance for session tracking ──
    getRuntimeMetadata?(): unknown;
    updateRuntimeMeta?(meta: Record<string, unknown>): void;
    refreshProviderDefinition?(provider: unknown): void;
    // ── Optional auxiliary fields some daemon paths read off the status ──
}

export interface CliAdapterStatusOptional {
    providerSessionId?: string;
    errorMessage?: string;
    errorReason?: string;
}
