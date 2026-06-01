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

export class CliScriptRunner {
    private scripts: CliScripts = {};
    private scriptState: unknown = null;
    private _parseErrorMessage: string | null = null;
    private readonly cliType: string;

    constructor(cliType: string) {
        this.cliType = cliType;
    }

    // ─── Script lifecycle ─────────────────────────────

    setScripts(scripts: CliScripts): void {
        this.scripts = scripts;
        this._parseErrorMessage = null;
        this.scriptState = typeof scripts.createState === 'function'
            ? (scripts.createState() ?? null)
            : null;
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
        return expectsState
            ? (fn as (state: unknown, input: any) => T)(this.scriptState, input)
            : (fn as (input: any) => T)(input);
    }
}
