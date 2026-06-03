/**
 * CliScriptRunner — isolated execution of provider CLI scripts
 *
 * Responsible solely for invoking provider-supplied JavaScript functions
 * (detectStatus, parseApproval, parseSession, etc.) and managing the
 * per-session script state created by createState().
 *
 * The runner is stateless with respect to PTY / buffer content — all
 * input data is passed explicitly by the caller so that the adapter can
 * remain a pure transport layer without embedding parsing logic.
 */

import { LOG } from '../logging/logger.js';
import {
    listCliScriptNames,
    type CliApprovalInput,
    type CliScripts,
    type CliScriptInput,
    type CliScreenSnapshot,
    type CliStatusInput,
    type ParsedSession,
} from './provider-cli-shared.js';
import { buildDetectStatusFromTui } from '../providers/sdk/v1/builders/cli/detect-status.js';
import { buildParseApprovalFromTui } from '../providers/sdk/v1/builders/cli/parse-approval.js';
import { buildParseSessionFromTui, normalizeMessageIdentity } from '../providers/sdk/v1/builders/cli/parse-session.js';

/**
 * Capability bag injected into provider scripts as the third argument.
 *
 * v1 manifests declare line-shape recognition in their `tui` block — for
 * those providers, the daemon builds the canonical (input → verdict)
 * functions from the manifest and hands them to the script via `sdk`. The
 * script's job is then only to wrap that verdict with stateful logic
 * (idle-hold timers, frame counting, etc.) that can't be expressed
 * declaratively.
 *
 * Without these, the extended-tier overrides bail with `return 'idle'`
 * and the session sticks in generating forever. That's the regression
 * we hit on codex-cli during the registry-install path.
 */
interface CliScriptSdk {
    declarativeDetectStatus?: (input: CliStatusInput) => string | null;
    declarativeParseApproval?: (input: CliApprovalInput) => { message: string; buttons: string[] } | null;
}

/**
 * One entry per script invocation, kept in a ring buffer so debug
 * tooling can answer "what did the script see, and what did it return?"
 * without having to re-run the daemon with custom logs. This is the
 * trace that would have answered the codex-cli #102 regression in one
 * pass instead of a dozen guesses.
 *
 * Body fields are bounded: input is reduced to a small summary (sizes
 * + a salted hash + the first few normalized chars of screenText), and
 * result is JSON-serialized then capped. Full PTY frames are NOT
 * captured here — they live in CliBufferSnapshot and are exposed by
 * the chat debug bundle separately.
 */
export interface CliScriptInvocationTrace {
    at: number;                       // Date.now()
    scriptName: string;
    arity: number;
    inputSummary: {
        screenTextLen: number;
        rawBufferLen: number;
        tailLen: number;
        isWaitingForResponse?: boolean;
        screenTextHead?: string;       // first 200 chars of screenText (post-strip)
    };
    ok: boolean;
    elapsedUs: number;
    resultSummary?: string;            // JSON.stringify(result).slice(0, 400)
    error?: string;
    /**
     * True when the invocation's elapsed time exceeded the runner's
     * `scriptCallBudgetMs`. The script is NOT aborted (Node CJS can't
     * interrupt sync code without a worker thread) — this flag plus the
     * trace ring lets an operator identify which provider is hanging the
     * settle loop. A throttled WARN is emitted alongside.
     */
    timedOut?: boolean;
}

const TRACE_RING_CAPACITY = 64;

/** Default per-invocation wall-clock budget (ms) when the manifest omits one. */
const DEFAULT_SCRIPT_CALL_BUDGET_MS = 50;

/** Minimum interval between repeated budget-violation WARNs per script. */
const BUDGET_WARN_THROTTLE_MS = 30_000;

function summarizeInput(input: any): CliScriptInvocationTrace['inputSummary'] {
    const screenText = typeof input?.screenText === 'string' ? input.screenText : '';
    const rawBuffer = typeof input?.rawBuffer === 'string' ? input.rawBuffer : '';
    const tail = typeof input?.tail === 'string' ? input.tail : '';
    return {
        screenTextLen: screenText.length,
        rawBufferLen: rawBuffer.length,
        tailLen: tail.length,
        isWaitingForResponse: typeof input?.isWaitingForResponse === 'boolean' ? input.isWaitingForResponse : undefined,
        screenTextHead: screenText ? screenText.slice(0, 200) : undefined,
    };
}

function summarizeResult(result: unknown): string {
    try {
        const json = JSON.stringify(result);
        return json && json.length > 400 ? `${json.slice(0, 400)}…[truncated ${json.length - 400}]` : (json ?? 'undefined');
    } catch (e: any) {
        return `<unserializable: ${e?.message || e}>`;
    }
}

export class CliScriptRunner {
    private scripts: CliScripts = {};
    private scriptState: unknown = null;
    private _parseErrorMessage: string | null = null;
    private readonly cliType: string;
    private sdk: CliScriptSdk = {};
    private invocationTrace: CliScriptInvocationTrace[] = [];
    /** Per-invocation wall-clock budget (ms). Configurable via setScriptCallBudget. */
    private scriptCallBudgetMs = DEFAULT_SCRIPT_CALL_BUDGET_MS;
    /** Last WARN emit time per scriptName, used to throttle repeated budget violations. */
    private lastBudgetWarnAt = new Map<string, number>();

    constructor(cliType: string) {
        this.cliType = cliType;
    }

    /** Returns the most-recent script invocation traces (oldest → newest). */
    getInvocationTrace(): CliScriptInvocationTrace[] {
        return this.invocationTrace.slice();
    }

    /** Clear the trace ring — used by tests and after PTY reset. */
    clearInvocationTrace(): void {
        this.invocationTrace = [];
    }

    /**
     * Configure the wall-clock budget (ms) applied to every script invocation.
     *
     * Out-of-range or non-finite values are clamped to [1, 5000] and the
     * default (50ms) is used as a fallback. The budget is enforced per-call,
     * not aggregated — it does not abort a runaway script (Node CJS cannot
     * interrupt synchronous code without a worker thread). Instead, an
     * exceeded budget flags the trace entry with `timedOut: true` and emits
     * a throttled WARN naming the script and elapsed time so an operator
     * can identify which provider is hanging the settle loop.
     */
    setScriptCallBudget(ms: number): void {
        if (typeof ms !== 'number' || !Number.isFinite(ms)) {
            this.scriptCallBudgetMs = DEFAULT_SCRIPT_CALL_BUDGET_MS;
            return;
        }
        const clamped = Math.max(1, Math.min(5000, Math.floor(ms)));
        this.scriptCallBudgetMs = clamped;
    }

    /** Test/debug accessor — current effective budget in ms. */
    getScriptCallBudgetMs(): number {
        return this.scriptCallBudgetMs;
    }

    private recordTrace(entry: CliScriptInvocationTrace): void {
        this.invocationTrace.push(entry);
        if (this.invocationTrace.length > TRACE_RING_CAPACITY) {
            this.invocationTrace.splice(0, this.invocationTrace.length - TRACE_RING_CAPACITY);
        }
    }

    // ─── Script lifecycle ─────────────────────────────

    setScripts(scripts: CliScripts, providerTui?: Record<string, unknown> | undefined): void {
        // SDK is built first so the synth functions below have access to it.
        this.sdk = this.buildSdk(providerTui);

        // Fill missing scripts from the SDK synth. This is the heart of the
        // declarative model: a v1 manifest with a complete tui block (spinner
        // + modal + settledPrompt + transcriptPty) gets working detectStatus
        // / parseApproval / parseSession functions for free, no provider .js
        // required. Providers that supply their own override always win
        // because we don't overwrite when scripts[name] is already a function.
        const tui = providerTui as Record<string, unknown> | undefined;
        const enriched: CliScripts = { ...scripts };

        if (typeof enriched.detectStatus !== 'function' && this.sdk.declarativeDetectStatus) {
            enriched.detectStatus = this.sdk.declarativeDetectStatus as any;
        }
        if (typeof enriched.parseApproval !== 'function' && this.sdk.declarativeParseApproval) {
            enriched.parseApproval = this.sdk.declarativeParseApproval as any;
        }
        if (typeof enriched.parseSession !== 'function' && tui?.transcriptPty) {
            try {
                const synth = buildParseSessionFromTui({
                    spinner: tui.spinner,
                    settledPrompt: tui.settledPrompt,
                    modal: tui.modal as any,
                    dispatchOrder: tui.dispatchOrder,
                    transcriptPty: tui.transcriptPty as any,
                });
                // Wrap to apply identity stamps the daemon downstream expects.
                enriched.parseSession = ((input: any) => {
                    const out = synth(input);
                    return {
                        ...out,
                        messages: normalizeMessageIdentity(out.messages, out.status ?? 'idle'),
                    };
                }) as any;
            } catch (e: any) {
                LOG.warn('CLI', `[${this.cliType}] buildParseSessionFromTui failed: ${e?.message || e}`);
            }
        }

        this.scripts = enriched;
        this._parseErrorMessage = null;
        this.scriptState = typeof enriched.createState === 'function'
            ? (enriched.createState() ?? null)
            : null;
    }

    private buildSdk(providerTui: Record<string, unknown> | undefined): CliScriptSdk {
        const tui = providerTui as Record<string, unknown> | undefined;
        if (!tui) return {};
        const sdk: CliScriptSdk = {};
        // Build declarativeDetectStatus from the manifest tui block. The
        // builder requires at least spinner OR settledPrompt OR modal; if
        // none are present we skip silently so a non-tui manifest doesn't
        // throw at boot time.
        if (tui.spinner || tui.settledPrompt || tui.modal || tui.dispatchOrder) {
            try {
                sdk.declarativeDetectStatus = buildDetectStatusFromTui({
                    spinner: tui.spinner as any,
                    settledPrompt: tui.settledPrompt as any,
                    modal: tui.modal as any,
                    dispatchOrder: tui.dispatchOrder as any,
                }) as unknown as (input: CliStatusInput) => string | null;
            } catch (e: any) {
                LOG.warn('CLI', `[${this.cliType}] buildDetectStatusFromTui failed: ${e?.message || e}`);
            }
        }
        if (tui.modal) {
            try {
                sdk.declarativeParseApproval = buildParseApprovalFromTui(tui.modal as any) as unknown as (input: CliApprovalInput) => { message: string; buttons: string[] } | null;
            } catch (e: any) {
                LOG.warn('CLI', `[${this.cliType}] buildParseApprovalFromTui failed: ${e?.message || e}`);
            }
        }
        return sdk;
    }

    /** Reset per-session state — called when the PTY process exits. */
    resetSessionState(): void {
        this.scriptState = null;
        this.invocationTrace = [];
        this.lastBudgetWarnAt.clear();
    }

    // ─── Script access (for reflection and test patching) ────────────────────

    /** Returns the live scripts object. Direct property assignment on this object
     *  patches individual scripts without replacing others (used in tests). */
    get cliScripts(): CliScripts { return this.scripts; }

    // ─── Capability checks ────────────────────────────

    hasDetectStatus(): boolean {
        return typeof this.scripts.detectStatus === 'function';
    }

    hasParseSession(): boolean {
        return typeof this.scripts.parseSession === 'function';
    }

    getScriptNames(): string[] {
        return listCliScriptNames(this.scripts);
    }

    // ─── Error state ──────────────────────────────────

    get parseErrorMessage(): string | null {
        return this._parseErrorMessage;
    }

    clearParseError(): void {
        this._parseErrorMessage = null;
    }

    // ─── Script invocation ────────────────────────────

    detectStatus(input: CliStatusInput): string | null {
        if (!this.scripts.detectStatus) return null;
        try {
            return this.invoke<string | null>('detectStatus', this.scripts.detectStatus, input);
        } catch (e: any) {
            LOG.warn('CLI', `[${this.cliType}] detectStatus error: ${e?.message || e}`);
            return null;
        }
    }

    parseApproval(
        input: CliApprovalInput,
    ): { message: string; buttons: string[] } | null {
        if (!this.scripts.parseApproval) return null;
        try {
            return this.invoke<{ message: string; buttons: string[] } | null>(
                'parseApproval',
                this.scripts.parseApproval,
                input,
            );
        } catch (e: any) {
            LOG.warn('CLI', `[${this.cliType}] parseApproval error: ${e?.message || e}`);
            return null;
        }
    }

    parseSession(
        input: CliScriptInput & { tail?: string; tailScreen?: CliScreenSnapshot },
    ): ParsedSession | null {
        if (!this.scripts.parseSession) {
            this._parseErrorMessage = `${this.cliType} parseSession unavailable`;
            return null;
        }
        try {
            const result = this.invoke<ParsedSession | null>('parseSession', this.scripts.parseSession, input);
            this._parseErrorMessage = null;
            return result && typeof result === 'object' ? result : null;
        } catch (e: any) {
            this._parseErrorMessage = e?.message || String(e);
            LOG.warn('CLI', `[${this.cliType}] parseSession error: ${this._parseErrorMessage}`);
            return null;
        }
    }

    /**
     * Invoke an arbitrary named script (e.g. setModel, openModelPicker).
     * Throws if the script is not available.
     */
    invokeByName(name: string, input: any): any {
        const fn = this.scripts[name];
        if (typeof fn !== 'function') {
            throw new Error(`CLI script '${name}' not available`);
        }
        return this.invoke(name, fn, input);
    }

    // ─── Internal ─────────────────────────────────────

    private invoke<T>(scriptName: string, fn: Function, input: any): T {
        // Pick the call shape from fn.length so each script gets exactly the
        // args its signature declares:
        //   (input)             — v0 single-arg scripts
        //   (state, input)      — v0 stateful scripts that opt in via createState()
        //   (state, input, sdk) — v1 extended-tier overrides that consume the SDK
        const arity = fn.length;
        const startedAt = Date.now();
        const startedHr = typeof process !== 'undefined' && typeof process.hrtime === 'function'
            ? process.hrtime.bigint()
            : null;
        let result: T;
        try {
            if (arity >= 3) {
                result = (fn as (state: unknown, input: any, sdk: CliScriptSdk) => T)(this.scriptState, input, this.sdk);
            } else if (arity === 2) {
                result = (fn as (state: unknown, input: any) => T)(this.scriptState, input);
            } else {
                result = (fn as (input: any) => T)(input);
            }
            const elapsedUs = startedHr ? Number((process.hrtime.bigint() - startedHr) / 1000n) : 0;
            const timedOut = this.checkBudget(scriptName, elapsedUs);
            this.recordTrace({
                at: startedAt,
                scriptName,
                arity,
                inputSummary: summarizeInput(input),
                ok: true,
                elapsedUs,
                resultSummary: summarizeResult(result),
                ...(timedOut ? { timedOut: true } : {}),
            });
            return result;
        } catch (e: any) {
            const elapsedUs = startedHr ? Number((process.hrtime.bigint() - startedHr) / 1000n) : 0;
            const timedOut = this.checkBudget(scriptName, elapsedUs);
            this.recordTrace({
                at: startedAt,
                scriptName,
                arity,
                inputSummary: summarizeInput(input),
                ok: false,
                elapsedUs,
                error: e?.message ? String(e.message).slice(0, 400) : String(e).slice(0, 400),
                ...(timedOut ? { timedOut: true } : {}),
            });
            throw e;
        }
    }

    /**
     * Returns true when `elapsedUs` exceeded the configured budget. On the
     * first violation per script (or after the throttle window expires) we
     * emit a single WARN so the operator learns which provider is slow.
     *
     * We deliberately throttle per-scriptName so a chronically-slow
     * detectStatus doesn't spam the log on every PTY frame settle.
     */
    private checkBudget(scriptName: string, elapsedUs: number): boolean {
        const budgetUs = this.scriptCallBudgetMs * 1000;
        if (elapsedUs <= budgetUs) return false;
        const now = Date.now();
        const last = this.lastBudgetWarnAt.get(scriptName) ?? 0;
        if (now - last >= BUDGET_WARN_THROTTLE_MS) {
            this.lastBudgetWarnAt.set(scriptName, now);
            LOG.warn(
                'CLI',
                `[${this.cliType}] script ${scriptName} took ${elapsedUs}us, budget ${budgetUs}us`,
            );
        }
        return true;
    }
}
