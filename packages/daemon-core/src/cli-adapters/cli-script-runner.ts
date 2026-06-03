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

export class CliScriptRunner {
    private scripts: CliScripts = {};
    private scriptState: unknown = null;
    private _parseErrorMessage: string | null = null;
    private readonly cliType: string;
    private sdk: CliScriptSdk = {};

    constructor(cliType: string) {
        this.cliType = cliType;
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
            return this.invoke<string | null>(this.scripts.detectStatus, input);
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
            const result = this.invoke<ParsedSession | null>(this.scripts.parseSession, input);
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
        return this.invoke(fn, input);
    }

    // ─── Internal ─────────────────────────────────────

    private invoke<T>(fn: Function, input: any): T {
        const hasStateFactory = typeof this.scripts.createState === 'function';
        const expectsState = hasStateFactory || this.scriptState !== null || fn.length >= 2;
        // SDK is always passed as the 3rd argument. Scripts that don't need
        // it ignore the extra arg; scripts that do — like codex-cli's
        // detect_status v1 override — fail closed (return 'idle' forever)
        // without it, which manifests as sessions stuck in `generating`.
        return expectsState
            ? (fn as (state: unknown, input: any, sdk: CliScriptSdk) => T)(this.scriptState, input, this.sdk)
            : (fn as (input: any, sdk: CliScriptSdk) => T)(input, this.sdk);
    }
}
