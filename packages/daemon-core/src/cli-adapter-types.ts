/**
 * CliAdapter — common interface for CLI agents
 *
 * Contract implemented by all CLI adapters (ProviderCliAdapter etc).
 */

import type { ChatMessage } from './types.js';
import type { InteractivePrompt, InteractivePromptResponse } from './providers/types/interactive-prompt.js';
import type { MeshSendKeyItem, MeshSendKeyName } from './cli-adapters/provider-cli-shared.js';

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
     * claude-cli only: true when the session's native-history transcript shows
     * ≥1 unresolved `run_in_background` bash job (a Bash tool_use whose
     * completion tool_result has not yet appeared). NEW passthrough signal —
     * it rides ALONGSIDE `status` and is NOT forced through the 5-value FSM
     * normalization (like `activeModal`/`providerSessionId`). The completion
     * gate uses it to HOLD a false idle→completed transition while a background
     * job is still running: the parent turn can return to a ready prompt (idle)
     * while its background bash keeps running, which otherwise fired a false
     * agent:generating_completed. Absent/undefined for every non-claude-cli
     * provider and whenever the transcript can't be read or shows nothing.
     */
    backgroundTaskActive?: boolean;
    /** Count of unresolved background bash jobs (only when backgroundTaskActive). */
    backgroundTaskCount?: number;
    /** tool_use ids of the unresolved background bash jobs (diagnostics). */
    backgroundTaskIds?: string[];
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
    sendMessage(text: string, options?: { force?: boolean; meshTaskId?: string }): Promise<{ status: 'queued' | 'delivered' } | void>;
    forceSendMessage?(text: string, meshTaskId?: string): Promise<{ status: 'queued' | 'delivered' } | void>;
    getStatus(options?: { allowParse?: boolean }): CliAdapterStatus;
    getScriptParsedStatus?(): unknown;
    getDebugSnapshot?(): unknown;
    invokeScript?(scriptName: string, args?: Record<string, unknown>): Promise<unknown>;
    getPartialResponse(): string;
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
        | { ok: false; refused: 'submit_race' | 'actionable_modal'; keys: MeshSendKeyName[]; hasDestructive: boolean }
    >;
    setOnStatusChange(callback: () => void): void;
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
