/**
 * CODEX-WORKER-TRUST-STALL — a delegated codex worker parks in the FSM `trust`
 * state on every launch, and every dispatched task body queues behind it.
 *
 * Live evidence (2026-09-19, preview daemon 1.0.60-rc.18, session 10e8f7ba):
 *
 *   14:45:14.928 [FsmDriver] starting → trust (→trust)
 *   14:45:15.659 [FsmDriver] send queued — machine not ready yet (queued=1)
 *   14:46:19.996 [Command] [resolve_action] action="approve"
 *   14:48:45.009 [FsmDriver] send queued — machine not ready yet (queued=2)
 *
 * ★The FSM edge itself is NOT broken. Replaying the real captured PTY bytes
 * through the real driver (the `escapes` test below) shows `trust → idle` firing
 * exactly as the spec declares, and the queued body being written. What is
 * broken is upstream of the FSM: a delegated worker's `CODEX_HOME` is private
 * and its directory name carries a PER-SESSION hash, so codex's project-trust
 * store starts empty on EVERY launch and the modal fires on EVERY launch. The
 * session only leaves `trust` when a human answers it, which makes manual
 * approval a standing precondition for automated work.
 *
 * The fix is a pre-launch grant (`pre_launch_trust: { scheme: 'codex_toml_file' }`),
 * so the prompt never renders. These tests pin BOTH halves:
 *
 *   1. the spec declares the scheme, and the grant materializes codex's real
 *      on-disk projection into the worker's PRIVATE store (not the owner's);
 *   2. the FSM, driven by real captured codex frames, reaches a NON-trust state
 *      — asserted as a STATE TRANSITION through `getFsmDebug().currentState`,
 *      never by matching text on the screen. A screen-string assertion would
 *      pass for the wrong reason the moment codex rewords its modal.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FsmDriver } from '../../../src/providers/spec/fsm-driver.js';
import { validateFsmSpec } from '../../../src/providers/spec/fsm-loader.js';
import { applyPreLaunchTrust } from '../../../src/providers/spec/pre-launch-trust.js';
import { applyCodexWorkspaceTrust } from '../../../src/providers/codex-workspace-trust.js';
import type { ResolvedTrustPlan } from '../../../src/providers/trust-provenance-ledger.js';
import type {
    PtyTransportFactory, PtyRuntimeTransport, PtySpawnOptions,
} from '../../../src/cli-adapters/pty-transport.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROVIDERS = path.resolve(HERE, '../../../../../../adhdev-providers');
const SPEC_PATH = path.join(PROVIDERS, 'cli/codex-cli/specs/4.0.json');
const FIXTURE = path.join(PROVIDERS, 'cli/codex-cli/fixtures/replay/trust-modal-2026-09-19.json');

const assetsAvailable = fs.existsSync(SPEC_PATH) && fs.existsSync(FIXTURE);
const maybe = assetsAvailable ? describe : describe.skip;

interface Frame { atMs: number; data: string }
interface Capture { phase1_trust: Frame[]; phase2_after_approve: Frame[] }

class DrivablePty implements PtyRuntimeTransport {
    readonly pid = 4711;
    readonly ready = Promise.resolve();
    readonly writes: string[] = [];
    private dataCb: ((chunk: string) => void) | null = null;
    private exitCb: ((info: { exitCode: number }) => void) | null = null;
    write(data: string): void { this.writes.push(data); }
    resize(): void { /* no-op */ }
    kill(): void { this.exitCb?.({ exitCode: 0 }); }
    onData(cb: (chunk: string) => void): void { this.dataCb = cb; }
    onExit(cb: (info: { exitCode: number }) => void): void { this.exitCb = cb; }
    feed(chunk: string): void { this.dataCb?.(chunk); }
}

class DrivableFactory implements PtyTransportFactory {
    last: DrivablePty | null = null;
    spawn(_c: string, _a: string[], _o: PtySpawnOptions): PtyRuntimeTransport {
        this.last = new DrivablePty();
        return this.last;
    }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Replay a captured phase honoring the real inter-chunk gaps. */
async function replay(pty: DrivablePty, frames: Frame[]): Promise<void> {
    let prev = 0;
    for (const f of frames) {
        const gap = f.atMs - prev;
        prev = f.atMs;
        if (gap > 0) await sleep(gap);
        pty.feed(f.data);
    }
}

maybe('codex-cli folder trust — pre-launch grant', () => {
    if (!assetsAvailable) return;

    describe('the shipping spec declares the scheme', () => {
        it('validates and selects codex_toml_file', () => {
            const raw = JSON.parse(fs.readFileSync(SPEC_PATH, 'utf8'));
            expect(validateFsmSpec(raw)).toEqual([]);
            expect(raw.pre_launch_trust).toEqual({ scheme: 'codex_toml_file' });
        });
    });

    describe('the grant writes codex\'s real on-disk projection', () => {
        let home: string;
        let workspace: string;
        let storePath: string;

        beforeEach(() => {
            home = fs.mkdtempSync(path.join(os.tmpdir(), 'codexhome-'));
            workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-codex-'));
            storePath = path.join(home, 'config.toml');
        });
        afterEach(() => {
            fs.rmSync(home, { recursive: true, force: true });
            fs.rmSync(workspace, { recursive: true, force: true });
        });

        function codexPlan(): ResolvedTrustPlan {
            return {
                provider: 'codex-cli',
                workspaceRealpath: fs.realpathSync(workspace),
                storePath,
                scope: 'worker',
                origin: 'worker_auto',
                sessionKey: 'session-codex',
                lifecycle: { kind: 'persistent', expiresAt: null },
            };
        }

        it('writes the exact table codex itself writes', () => {
            // Byte-for-byte the shape captured from live codex 0.154.0 after
            // answering the prompt with CODEX_HOME pointed at an empty dir.
            const added = applyPreLaunchTrust({ scheme: 'codex_toml_file' }, codexPlan());
            const real = fs.realpathSync(workspace);
            expect(added).toBe(real);
            const toml = fs.readFileSync(storePath, 'utf8');
            expect(toml).toContain(`[projects."${real}"]`);
            expect(toml).toContain('trust_level = "trusted"');
            // NOT grok's shape — the two schemes are not interchangeable.
            expect(toml).not.toContain('[folders.');
            expect(toml).not.toContain('trusted = true');
        });

        it('APPENDS — an existing [mcp_servers.*] table survives untouched', () => {
            // Load-bearing: config.toml is codex's MAIN config and carries the
            // worker's MCP server table. A rewrite here would silently undo the
            // worker-MCP isolation this grant must stay orthogonal to.
            const mcp = '[mcp_servers.adhdev-worker]\ncommand = "adhdev-preview"\nenabled = true\n';
            fs.writeFileSync(storePath, mcp, 'utf8');
            applyPreLaunchTrust({ scheme: 'codex_toml_file' }, codexPlan());
            const toml = fs.readFileSync(storePath, 'utf8');
            expect(toml).toContain('[mcp_servers.adhdev-worker]');
            expect(toml).toContain('command = "adhdev-preview"');
            expect(toml).toContain(`[projects."${fs.realpathSync(workspace)}"]`);
        });

        it('never flips an explicit non-trusted decision', () => {
            const real = fs.realpathSync(workspace);
            fs.writeFileSync(storePath, `[projects."${real}"]\ntrust_level = "untrusted"\n`, 'utf8');
            expect(applyPreLaunchTrust({ scheme: 'codex_toml_file' }, codexPlan())).toBeNull();
            expect(fs.readFileSync(storePath, 'utf8')).toContain('trust_level = "untrusted"');
        });

        it('lands in the PRIVATE store, never the owner\'s ~/.codex', () => {
            // The whole point of the per-session CODEX_HOME. `applyCodexWorkspaceTrust`
            // resolves CODEX_HOME FIRST precisely so a worker's automatic grant
            // cannot widen the owner's personal trust store.
            const ownerHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ownerhome-'));
            try {
                const added = applyCodexWorkspaceTrust(workspace, {
                    CODEX_HOME: home,
                    HOME: ownerHome,
                } as NodeJS.ProcessEnv);
                expect(added).toBe(fs.realpathSync(workspace));
                expect(fs.existsSync(storePath)).toBe(true);
                expect(fs.existsSync(path.join(ownerHome, '.codex', 'config.toml'))).toBe(false);
            } finally {
                fs.rmSync(ownerHome, { recursive: true, force: true });
            }
        });
    });

    describe('FSM behaviour on real captured codex frames', () => {
        /**
         * The counter-invariant, and the reason the grant is the fix rather than
         * an FSM change: when the modal DOES render (no pre-grant, e.g. a
         * best-effort write that failed), the machine must still park in `trust`
         * so the approval surfaces instead of the session running untrusted.
         */
        it('parks in trust while the modal is up — asserted as FSM state', async () => {
            const cap = JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) as Capture;
            const factory = new DrivableFactory();
            const driver = new FsmDriver({
                specPath: SPEC_PATH,
                workingDir: os.tmpdir(),
                hotReload: false,
                transportFactory: factory,
            });
            driver.start();
            const pty = factory.last!;
            try {
                await replay(pty, cap.phase1_trust);
                await sleep(1200);
                expect(driver.getFsmDebug().currentState).toBe('trust');
            } finally { driver.shutdown(); }
        }, 30000);

        /**
         * And once the modal is answered, the machine must LEAVE `trust` and the
         * queued body must actually be written — the two halves the live wedge
         * never reached. Both are asserted on state/PTY effects, not on screen
         * text.
         */
        it('escapes trust after the answer and drains the queued send', async () => {
            const cap = JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) as Capture;
            const factory = new DrivableFactory();
            const driver = new FsmDriver({
                specPath: SPEC_PATH,
                workingDir: os.tmpdir(),
                hotReload: false,
                transportFactory: factory,
            });
            driver.start();
            const pty = factory.last!;
            const BODY = 'MESH-TASK-BODY-' + 'x'.repeat(200);
            try {
                await replay(pty, cap.phase1_trust);
                await sleep(1200);
                expect(driver.getFsmDebug().currentState).toBe('trust');

                // The live ordering: a mesh task is dispatched WHILE parked in
                // trust, so it queues rather than being written.
                driver.dispatch({ kind: 'send_message', text: BODY } as never);
                expect(pty.writes.some(w => w.includes(BODY))).toBe(false);

                // The approval is answered through the real modal path.
                expect(driver.clickModalButton(1)).toBe(true);
                await replay(pty, cap.phase2_after_approve);
                await sleep(6000);

                const state = driver.getFsmDebug().currentState;
                expect(state, `expected to leave trust, got ${state}`).not.toBe('trust');
                expect(state).toBe('idle');
                expect(
                    pty.writes.some(w => w.includes(BODY)),
                    'queued task body was never written to the PTY',
                ).toBe(true);
            } finally { driver.shutdown(); }
        }, 60000);
    });
});
