/**
 * @file README-design.ts
 * @description Phase 5 Sandbox Design Document
 *
 * This file is a design document written as TypeScript JSDoc/comments.
 * It is NOT executable — it exists to communicate the sandboxing architecture
 * to future implementors, reviewers, and delegated agents.
 *
 * =============================================================================
 * CONTEXT: EXTENDED-LEGACY PROVIDER SCRIPT EXECUTION (PRE-PHASE-5)
 * =============================================================================
 *
 * "Extended-legacy" providers (e.g. hermes-cli, and any provider using the
 * `compatibility` script format) supply JavaScript override scripts that the
 * daemon loads and calls directly via Node.js `require()`:
 *
 *   provider-loader.ts → require(scriptsPath)           // load
 *   cli-script-runner.ts → this.invoke(fn, input)       // call at runtime
 *
 * The loaded module exports plain JS functions (detectStatus, parseApproval,
 * parseSession, etc.). These functions run **in the daemon process with full
 * Node.js access** — no memory cap, no CPU limit, full `require`, `fs`, `net`.
 *
 * The `extended-legacy` label refers to providers that still use the JS-function
 * override layer rather than the pure-declarative `tui` manifest block. The
 * claude-cli provider (scripts/v1/detect_status.js) is the canonical example of
 * this pattern: it delegates to `sdk.declarativeDetectStatus` for the raw verdict
 * but adds a stateful generating-hold on top that cannot be expressed declaratively.
 *
 * =============================================================================
 * PHASE 5 GOAL: isolated-vm SANDBOXING
 * =============================================================================
 *
 * Phase 5 wraps each script call in an isolated-vm context so that:
 *
 *   1. CPU time is capped per call (default 50 ms hard limit).
 *   2. Memory is capped per Isolate (default 32 MB heap limit).
 *   3. The script cannot reach back into the daemon process — no `require`,
 *      no `import`, no Node.js built-ins (fs, net, child_process, etc.).
 *   4. Execution errors and timeouts are caught and surfaced cleanly instead
 *      of propagating exceptions that could crash the daemon parse loop.
 *
 * =============================================================================
 * SANDBOX EXECUTION MODEL
 * =============================================================================
 *
 * Each call to SandboxedScriptRunner.run() creates a **fresh evaluation context**
 * inside the Isolate. Persistent state across calls (e.g. the `state` object in
 * detectStatus) is cloned in/out of the sandbox via structured serialization.
 *
 * Flow per call:
 *
 *   1. Serialize `context` (input + state) into a plain JSON-safe value.
 *   2. Create a new isolated-vm Context from the shared Isolate.
 *   3. Inject allowed globals (see below) into the context.
 *   4. Compile + run the script string with `cpuTimeLimitMs` enforced.
 *   5. Deserialize and return the result.
 *   6. Discard the Context (short-lived).
 *
 * The Isolate itself is reused across calls so that the V8 JIT and snapshot
 * warm-up cost is paid once per runner instance, not per call.
 *
 * Memory limit (32 MB) applies to the Isolate heap. If a script allocates
 * beyond the limit, isolated-vm throws RangeError: Array buffer allocation
 * failed (or similar). The runner catches this and returns an error signal.
 *
 * CPU time limit (50 ms) is a wall-clock limit on the script execution tick
 * measured by isolated-vm's internal timer. Async operations inside the script
 * are not permitted (the context is synchronous-only).
 *
 * =============================================================================
 * ALLOWED API SURFACE (what scripts CAN use)
 * =============================================================================
 *
 * The following globals are explicitly injected into the sandbox context:
 *
 *   - `input`        — the calling frame's input object (CliStatusInput, etc.)
 *   - `sdk`          — a controlled facade object; see sdk shape below
 *   - `console.log`  — redirected to daemon LOG.debug; console.error/warn also
 *                      allowed but routed to LOG.warn
 *   - `JSON`         — standard JSON object (parse + stringify)
 *   - `Math`         — standard Math object
 *   - `Date`         — Date constructor (read-only; no timers)
 *   - `String`, `Number`, `Boolean`, `Array`, `Object`, `RegExp`
 *                    — standard constructors
 *   - `undefined`, `null`, `NaN`, `Infinity`, `parseInt`, `parseFloat`,
 *     `isNaN`, `isFinite`, `encodeURIComponent`, `decodeURIComponent`
 *
 * sdk shape injected into the sandbox:
 *
 *   sdk.declarativeDetectStatus(input) → string
 *     Calls the daemon-built declarative verdict function. The implementation
 *     serializes the call, executes the declarative function in daemon-land,
 *     and returns the result string into the sandbox.
 *
 *   sdk.tailHasPrimitive(input, primitive) → boolean
 *     Returns true if the screen tail contains the named TUI primitive token.
 *
 *   sdk.state (object | null)
 *     The per-session state object returned by createState(). Mutable inside
 *     the script; mutations are copied back after the call completes.
 *
 * =============================================================================
 * FORBIDDEN API SURFACE (what scripts CANNOT use)
 * =============================================================================
 *
 * The sandbox provides NO access to:
 *
 *   - `require` / `import` / `module` / `exports` / `__dirname` / `__filename`
 *   - `process` (no env, no exit, no stdio)
 *   - `fs`, `path`, `os`, `net`, `http`, `https`, `child_process`, `worker_threads`
 *   - `setTimeout`, `setInterval`, `setImmediate`, `clearTimeout`, `clearInterval`
 *     (async scheduling is blocked; scripts must be synchronous)
 *   - `Promise`, `async/await` (not injected; async resolution is disallowed)
 *   - `WebAssembly` (not injected)
 *   - `Buffer`, `TextEncoder`, `TextDecoder` (not injected by default; can be
 *     added to allowedGlobals if a specific script family requires them)
 *   - Any daemon-internal module, class, or singleton
 *
 * =============================================================================
 * MIGRATION PATH FOR HERMES-CLI (when Phase 5 lands)
 * =============================================================================
 *
 * hermes-cli (adhdev-providers/cli/hermes-cli) uses the `compatibility` script
 * format with `defaultScriptDir: "scripts/1.0"`. Its scripts are loaded via
 * require() in provider-loader.ts → loadScriptsFromDir() and called via
 * CliScriptRunner.invoke().
 *
 * Phase 5 migration steps:
 *
 *   1. The ProviderLoader detects at load time whether a provider's scriptDir
 *      uses the extended-legacy JS override layer (i.e. scripts.js exports
 *      function(s) rather than a pure-declarative object).
 *
 *   2. For extended-legacy providers, instead of storing the raw Function
 *      references in `normalizedProvider.scripts`, the loader stores the
 *      **script source strings** alongside a flag `sandboxed: true`.
 *
 *   3. CliScriptRunner is extended with an optional SandboxedScriptRunner
 *      member. When present, invoke() routes script calls through the sandbox
 *      instead of calling the function directly.
 *
 *   4. hermes-cli's scripts/1.0/scripts.js is updated (or a scripts/2.0/ dir
 *      created) with source strings compatible with the allowed API surface.
 *      In particular:
 *        - `require` calls must be removed.
 *        - Any direct Node.js module access must be replaced with sdk equivalents.
 *
 *   5. The daemon's dev server (port 19280) exposes a /sandbox/test endpoint
 *      that accepts a script source string + input and returns the sandboxed
 *      result — useful for provider authors to iterate without restarting.
 *
 *   6. Fallback: providers that have not been migrated to the sandbox API still
 *      run via DirectEvalRunner (see script-runner.ts) — unsafe but compatible,
 *      with a visible deprecation warning in the daemon log.
 *
 * =============================================================================
 * SandboxedScriptRunner INTERFACE (to be satisfied by the Phase 5 implementation)
 * =============================================================================
 *
 * The interface defined in script-runner.ts must be satisfied by two
 * implementations:
 *
 *   DirectEvalRunner   — no-op stub; runs script via eval() in a try/catch.
 *                        Used when isolated-vm is not installed or when
 *                        sandboxing is explicitly disabled for development.
 *                        Logs a warning on first use.
 *                        Safe to use in tests (no native dependency).
 *
 *   IsolatedVmRunner   — full implementation using the `isolated-vm` npm package.
 *                        Created by createScriptRunner() when isolated-vm is
 *                        importable. Not committed to the OSS package — loaded
 *                        dynamically at runtime.
 *
 * Factory function createScriptRunner(options?) returns:
 *   - IsolatedVmRunner if `require('isolated-vm')` succeeds
 *   - DirectEvalRunner otherwise, with a LOG.warn() deprecation notice
 *
 * =============================================================================
 * FILE LAYOUT (Phase 5 deliverables under this directory)
 * =============================================================================
 *
 *   sandbox/
 *     README-design.ts          ← this file (design document)
 *     script-runner.ts          ← SandboxedScriptRunner interface + DirectEvalRunner stub
 *     isolated-vm-runner.ts     ← IsolatedVmRunner (Phase 5 full impl, not yet committed)
 *
 *   Related files that will be touched in Phase 5:
 *     cli-adapters/cli-script-runner.ts     ← add optional SandboxedScriptRunner member
 *     providers/provider-loader.ts          ← detect extended-legacy, store source strings
 *     providers/cli-provider-instance.ts    ← TODO comment (already added in Phase 4 scaffold)
 */

// This file contains no executable code.
export {};
