/**
 * Spawn prime + focus-gated stall watchdog for the FSM driver.
 *
 * Split out of fsm-driver.ts (file-size gate). Both halves write the spec's
 * declared `send_on_spawn` sequences and own nothing but their timers, so they
 * read the driver only through the narrow {@link FocusPrimerHost} view.
 *
 *  - Spawn prime: write `send_on_spawn` once, a configured delay after the
 *    child's FIRST output (or after a max-wait when no output ever arrives).
 *  - Stall watchdog (`refocus_when_stalled_ms`): a focus-event TUI
 *    (antigravity's `agy`) freezes its render loop the moment it thinks it has
 *    lost focus mid-turn: the screen stops updating and only repaints on the
 *    next keypress, which the daemon never sends. The output pump is wired
 *    entirely to PTY onData (no PTY data → no reevaluate, no
 *    on_screen_changed), so a normal time-wake that only re-reads the screen
 *    can't help — there is nothing new to read. The fix is to re-inject the
 *    focus-in wake (`send_on_spawn`) so the CLI flushes the held output itself.
 */
import { LOG } from '../../logging/logger.js';
import type { TerminalAdapter } from './adapter.js';
import type { CliSpecV4, FsmStatus } from './fsm-types.js';

/** No-output escape hatch for spawn priming. Live agy startup output arrived at
 *  +335ms / +612ms; 2s is >3x the slower observation while still bounding a
 *  focus-gated startup cycle to a short, human-visible pause. */
const DEFAULT_SPAWN_PRIME_MAX_WAIT_MS = 2_000;
/** Three detailed watchdog attempts show the first injection plus two repeat
 *  intervals, enough to diagnose cadence without an unbounded per-session log. */
const STALL_REFOCUS_INFO_LIMIT = 3;

export interface FocusPrimerHost {
    /** Live: the spec is replaced wholesale on a hot reload. */
    readonly spec: CliSpecV4;
    readonly adapter: Pick<TerminalAdapter, 'send_keys'>;
    specTag(): string;
    currentStatus(): FsmStatus;
    /** Wall-clock time the screen last changed IN THE CURRENT STATE, falling
     *  back to state entry — the stall window is measured from state entry. */
    stallScreenReferenceAt(): number;
}

export class FocusPrimer {
    /** Spawn-prime delay timer. First PTY output is useful readiness evidence,
     *  not proof that stdin is ready; a separate max-wait timer preserves the
     *  old spawn-relative fallback when no output ever arrives. */
    private spawnPrimeTimer: ReturnType<typeof setTimeout> | null = null;
    private spawnPrimeMaxWaitTimer: ReturnType<typeof setTimeout> | null = null;
    private spawnPrimeAwaitingOutput = false;
    /** Shared latch for the first-output and max-wait paths. Both timers call
     *  fireSpawnPrimeOnce(), which consumes it before writing. */
    private spawnPrimePending = false;
    /** Timer driving the stall watchdog. Re-arms itself while the machine is
     *  generating so a re-prime can fire even when the PTY has gone quiet. */
    private stallTimer: ReturnType<typeof setTimeout> | null = null;
    /** Wall-clock time the last stall re-prime was injected. The cooldown gate:
     *  after a re-prime we don't re-inject until the screen changes (which
     *  resets the stall reference) or another full stall window lapses. */
    private lastRefocusAt = 0;
    private stallRefocusInfoCount = 0;
    private stallRefocusSuppressedCount = 0;

    constructor(private readonly host: FocusPrimerHost) {}

    /** Arm the spawn prime. Must run before adapter.start(): a transport may
     *  synchronously flush buffered child output while registering onData. */
    armSpawnPrime(): void {
        const seqs = this.host.spec.send_on_spawn;
        if (!Array.isArray(seqs) || seqs.length === 0) return;
        this.spawnPrimeAwaitingOutput = true;
        this.spawnPrimePending = true;
        const configuredMaxWait = this.host.spec.send_on_spawn_max_wait_ms;
        const maxWait = typeof configuredMaxWait === 'number' && Number.isFinite(configuredMaxWait)
            ? Math.max(0, configuredMaxWait)
            : DEFAULT_SPAWN_PRIME_MAX_WAIT_MS;
        this.spawnPrimeMaxWaitTimer = setTimeout(() => {
            this.spawnPrimeMaxWaitTimer = null;
            this.fireSpawnPrimeOnce('max-wait');
        }, maxWait);
    }

    /** Start the configured prime delay only after the child produces output.
     *  On macOS, writing at a fixed spawn-relative deadline can land while the
     *  slave is still in canonical echo mode: focus-in is echoed as `^[[I` and
     *  lost before the TUI installs its input handler. First output is the
     *  earliest transport-level readiness evidence available to the engine. */
    onPtyOutput(): void {
        if (!this.spawnPrimeAwaitingOutput) return;
        this.spawnPrimeAwaitingOutput = false;
        if (this.spawnPrimeMaxWaitTimer) {
            clearTimeout(this.spawnPrimeMaxWaitTimer);
            this.spawnPrimeMaxWaitTimer = null;
        }
        const delay = Math.max(0, this.host.spec.send_on_spawn_delay_ms ?? 250);
        this.spawnPrimeTimer = setTimeout(() => {
            this.spawnPrimeTimer = null;
            this.fireSpawnPrimeOnce('first-output');
        }, delay);
    }

    /** Consume the one-shot spawn-prime latch and cancel the competing timer
     *  before writing. JavaScript callbacks are serialized, so whichever path
     *  gets here first makes every later/queued callback a no-op. */
    private fireSpawnPrimeOnce(trigger: 'first-output' | 'max-wait'): void {
        if (!this.spawnPrimePending) return;
        this.clearSpawnPrime();
        this.sendPrime('spawn-prime', trigger);
    }

    private clearSpawnPrime(): void {
        this.spawnPrimePending = false;
        this.spawnPrimeAwaitingOutput = false;
        if (this.spawnPrimeTimer) { clearTimeout(this.spawnPrimeTimer); this.spawnPrimeTimer = null; }
        if (this.spawnPrimeMaxWaitTimer) { clearTimeout(this.spawnPrimeMaxWaitTimer); this.spawnPrimeMaxWaitTimer = null; }
    }

    /** Write the declared `send_on_spawn` sequences to the PTY once. Used both
     *  on the first-output spawn path and, for focus-gated TUIs, by the stall
     *  watchdog to re-inject the focus-in wake mid-turn. No-op when the spec
     *  declares no prime, so non-focus-gated CLIs are never poked. */
    private sendPrime(source: 'spawn-prime' | 'stall-refocus', trigger?: 'first-output' | 'max-wait'): void {
        const seqs = this.host.spec.send_on_spawn;
        if (!Array.isArray(seqs) || seqs.length === 0) return;
        const validSeqs = seqs.filter((seq): seq is string => typeof seq === 'string' && seq.length > 0);
        if (validSeqs.length === 0) return;
        const specTag = this.host.specTag();
        if (source === 'spawn-prime') {
            LOG.info('FsmDriver', `[${specTag}] spawn prime firing trigger=${trigger ?? 'unknown'} sequences=${validSeqs.length}`);
        }
        for (const seq of validSeqs) {
            void this.host.adapter.send_keys(seq, { source, specTag });
        }
    }

    /** True when this spec opts into stall recovery (declares a positive
     *  refocus window AND a wake sequence to re-inject). */
    private stallRecoveryEnabled(): boolean {
        const ms = this.host.spec.refocus_when_stalled_ms;
        return typeof ms === 'number' && ms > 0
            && Array.isArray(this.host.spec.send_on_spawn) && this.host.spec.send_on_spawn.length > 0;
    }

    /** Arm a timer to re-inject the focus-in prime if the screen stays frozen
     *  through a `generating` state. Only active for opted-in focus-gated specs;
     *  a no-op (and cleared) for every other CLI and every non-generating state.
     *  Re-arms itself so it keeps watching while the PTY is quiet. */
    scheduleStallWatchdog(): void {
        if (this.stallTimer) { clearTimeout(this.stallTimer); this.stallTimer = null; }
        if (!this.stallRecoveryEnabled()) return;
        if (this.host.currentStatus() !== 'generating') return;
        const windowMs = this.host.spec.refocus_when_stalled_ms as number;
        // Cooldown reference: a re-prime defers the next one by a full window,
        // even if the screen has not yet repainted, so we don't tight-loop.
        const since = Math.max(this.host.stallScreenReferenceAt(), this.lastRefocusAt);
        const remaining = windowMs - (Date.now() - since);
        this.stallTimer = setTimeout(
            () => { this.stallTimer = null; this.onStallTick(); },
            Math.max(remaining + 30, 50),
        );
    }

    /** Fire when the stall window elapses: if the screen is still frozen and we
     *  are still generating, re-inject the focus-in wake once, then re-arm. */
    private onStallTick(): void {
        if (!this.stallRecoveryEnabled()) return;
        if (this.host.currentStatus() !== 'generating') return;
        const windowMs = this.host.spec.refocus_when_stalled_ms as number;
        const now = Date.now();
        const stalledFor = now - this.host.stallScreenReferenceAt();
        const sinceLastRefocus = now - this.lastRefocusAt;
        if (stalledFor >= windowMs && sinceLastRefocus >= windowMs) {
            if (this.stallRefocusInfoCount < STALL_REFOCUS_INFO_LIMIT) {
                this.stallRefocusInfoCount += 1;
                LOG.info('FsmDriver', `[${this.host.specTag()}] stall detected (${stalledFor}ms quiet, generating) — re-injecting focus-in (${this.stallRefocusInfoCount}/${STALL_REFOCUS_INFO_LIMIT} detailed)`);
            } else {
                this.stallRefocusSuppressedCount += 1;
            }
            this.sendPrime('stall-refocus');
            this.lastRefocusAt = now;
        }
        // Keep watching: the re-prime may not flush instantly, and a still-quiet
        // screen needs the next window to come around.
        this.scheduleStallWatchdog();
    }

    /** Clear every timer and emit one exact stall-refocus summary, then zero
     *  the counter so repeated shutdown calls cannot duplicate it. Write
     *  failures remain warn per attempt in TerminalAdapter and are never
     *  suppressed here. */
    dispose(): void {
        if (this.stallTimer) { clearTimeout(this.stallTimer); this.stallTimer = null; }
        this.clearSpawnPrime();
        const suppressed = this.stallRefocusSuppressedCount;
        if (suppressed === 0) return;
        this.stallRefocusSuppressedCount = 0;
        LOG.info('FsmDriver', `[${this.host.specTag()}] stall refocus log summary: ${suppressed} later reinjection(s) suppressed after first ${STALL_REFOCUS_INFO_LIMIT}`);
    }
}
