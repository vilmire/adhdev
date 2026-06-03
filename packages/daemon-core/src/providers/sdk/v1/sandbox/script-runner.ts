/**
 * script-runner.ts — SandboxedScriptRunner interface + DirectEvalRunner stub
 *
 * Phase 5 scaffold: defines the interface that the isolated-vm implementation
 * will satisfy, and provides a DirectEvalRunner that keeps providers working
 * without the native isolated-vm package.
 *
 * See README-design.ts for the full design rationale.
 */

import { LOG } from '../../../../logging/logger.js';

/** Options controlling the resource limits applied to a sandboxed script call. */
export interface SandboxOptions {
    /** Maximum CPU time (wall-clock) in milliseconds before the script is killed. Default: 50. */
    cpuTimeLimitMs: number;
    /** Maximum V8 heap size in megabytes for the Isolate. Default: 32. */
    memoryLimitMb: number;
    /**
     * Whitelist of global names the script may access.
     * The full allowed surface is documented in README-design.ts.
     * Default: ['console', 'JSON', 'Math', 'Date', 'String', 'Number', 'Boolean',
     *           'Array', 'Object', 'RegExp']
     */
    allowedGlobals: string[];
}

/** Default resource limits applied when no options are supplied. */
export const DEFAULT_SANDBOX_OPTIONS: SandboxOptions = {
    cpuTimeLimitMs: 50,
    memoryLimitMb: 32,
    allowedGlobals: ['console', 'JSON', 'Math', 'Date', 'String', 'Number', 'Boolean', 'Array', 'Object', 'RegExp'],
};

/**
 * Contract for sandboxed script execution.
 *
 * Implementations:
 *   - DirectEvalRunner  — no-op stub; uses eval() with a try/catch (unsafe, no limits).
 *   - IsolatedVmRunner  — Phase 5 full implementation using the `isolated-vm` package.
 *
 * Usage:
 *   const runner = createScriptRunner({ cpuTimeLimitMs: 50, memoryLimitMb: 32 });
 *   const result = await runner.run(scriptSource, { input, sdk });
 *   runner.dispose();
 */
export interface SandboxedScriptRunner {
    /**
     * Execute `script` synchronously inside a sandboxed context.
     *
     * @param script   JavaScript source string. The script body should
     *                 evaluate to the desired return value (the last expression
     *                 is returned, module.exports is NOT consulted).
     *                 Example: `"input.tail.includes('✓') ? 'idle' : 'generating'"`
     *
     * @param context  Plain key/value pairs injected as globals inside the
     *                 sandbox. All values must be JSON-serializable.
     *                 Typically: `{ input: <CliStatusInput>, sdk: <sdk facade> }`
     *
     * @param options  Optional per-call overrides for resource limits.
     *                 Merged with the options supplied to createScriptRunner().
     *
     * @returns        The value produced by the script (JSON-deserialized from
     *                 the sandbox). May be `unknown` — callers must validate.
     *
     * @throws         Re-throws if the script contains a syntax error.
     *                 Returns `undefined` (via rejection) on timeout or OOM.
     */
    run(script: string, context: Record<string, unknown>, options?: Partial<SandboxOptions>): Promise<unknown>;

    /**
     * Release all resources held by this runner (Isolate, Contexts, etc.).
     * After dispose(), calling run() has undefined behavior.
     */
    dispose(): void;
}

/**
 * No-op stub used when isolated-vm is not available (graceful degradation).
 *
 * Falls back to direct `eval()` inside a try/catch — there are no CPU or
 * memory limits. A warning is logged on the first run() call to make the
 * fallback visible in daemon logs.
 *
 * This implementation is suitable for:
 *   - Development environments where isolated-vm is not installed.
 *   - Unit tests (no native dependency required).
 *   - Graceful fallback for existing extended-legacy providers while Phase 5
 *     is being rolled out.
 *
 * NOT suitable for production use with untrusted script sources.
 */
export class DirectEvalRunner implements SandboxedScriptRunner {
    private warned = false;
    private readonly defaultOptions: SandboxOptions;

    constructor(options?: Partial<SandboxOptions>) {
        this.defaultOptions = { ...DEFAULT_SANDBOX_OPTIONS, ...options };
    }

    async run(
        script: string,
        context: Record<string, unknown>,
        _options?: Partial<SandboxOptions>,
    ): Promise<unknown> {
        if (!this.warned) {
            LOG.warn('Sandbox', '[DirectEvalRunner] isolated-vm not available — running script without sandboxing. Install isolated-vm for production use.');
            this.warned = true;
        }

        // Build a function body that exposes context keys as locals, then
        // evaluates the script and returns its result.
        const contextKeys = Object.keys(context);
        const contextValues = contextKeys.map((k) => context[k]);

        // eslint-disable-next-line no-new-func
        const fn = new Function(...contextKeys, `"use strict";\nreturn (${script});`);
        return fn(...contextValues);
    }

    dispose(): void {
        // Nothing to release — DirectEvalRunner holds no native resources.
    }
}

/**
 * Factory: returns IsolatedVmRunner if isolated-vm is installed, else DirectEvalRunner.
 *
 * Logs a warning when falling back to DirectEvalRunner so the operator is aware
 * that sandboxing is inactive.
 *
 * @param options  Resource limit defaults applied to every run() call unless
 *                 overridden at the call site. Merged with DEFAULT_SANDBOX_OPTIONS.
 */
export function createScriptRunner(options?: Partial<SandboxOptions>): SandboxedScriptRunner {
    try {
        // Dynamic require so that the import does not break the module when
        // isolated-vm is absent from node_modules.
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const isolatedVm = require('isolated-vm');
        if (isolatedVm && typeof isolatedVm.Isolate === 'function') {
            // Phase 5: IsolatedVmRunner — not yet implemented.
            // TODO(phase5): return new IsolatedVmRunner(options);
            LOG.warn('Sandbox', '[createScriptRunner] isolated-vm detected but IsolatedVmRunner is not yet implemented — falling back to DirectEvalRunner.');
        }
    } catch {
        // isolated-vm is not installed — this is the expected state for now.
    }
    return new DirectEvalRunner(options);
}
