/**
 * RESTORED MID-TURN status projection (live 2026-10-09, preview 1.0.79-rc.3).
 *
 * A worker session was mid-turn (a 120 s foreground sleep) when its daemon was
 * force-restarted. The hosted runtime survived and was re-attached, and the
 * FSM went starting → busy without ever drawing a ready prompt in the new
 * daemon's lifetime. SpecCliAdapter's boot-phase gate ("hold at starting until
 * the first ready prompt") then reported 'starting' for the whole turn:
 *
 *   [FsmDriver] starting → busy        (03:19:09)
 *   [CLI] [claude-cli] status: starting → idle   (03:20:43, the real turn end)
 *
 * The instance never saw generating, so the real end arrived as the prompt-up
 * edge (starting → idle), which emits no completion. No turn_end left the
 * worker, and the owner closed the task only from its own 60 s transcript
 * probe instead of the worker's idle edge.
 *
 * Pinned here: an adapter re-attached to an existing runtime projects a
 * generating FSM state as 'generating' even before the ready latch, while a
 * fresh process keeps the boot-phase hold, and idle stays held in both cases.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
    PtyRuntimeExitInfo,
    PtyRuntimeTransport,
    PtySpawnOptions,
    PtyTransportFactory,
} from '../../../src/cli-adapters/pty-transport.js';
import { SessionHostPtyTransportFactory } from '../../../src/cli-adapters/session-host-transport.js';
import { SpecCliAdapter } from '../../../src/providers/spec/cli-adapter.js';
import { projectAdapterStatus, type AdapterStatusInputs } from '../../../src/providers/spec/adapter-status-projection.js';

class DrivablePty implements PtyRuntimeTransport {
    readonly pid = 4545;
    readonly ready = Promise.resolve();
    readonly writes: string[] = [];
    private dataCb: ((chunk: string) => void) | null = null;
    private exitCb: ((info: PtyRuntimeExitInfo) => void) | null = null;
    write(data: string): void { this.writes.push(data); }
    resize(): void { /* no-op */ }
    kill(): void { this.exitCb?.({ exitCode: 0 } as PtyRuntimeExitInfo); }
    onData(cb: (chunk: string) => void): void { this.dataCb = cb; }
    onExit(cb: (info: PtyRuntimeExitInfo) => void): void { this.exitCb = cb; }
    feed(chunk: string): void { this.dataCb?.(chunk); }
}

class DrivableFactory implements PtyTransportFactory {
    last: DrivablePty | null = null;
    constructor(readonly attachesExistingRuntime: boolean) {}
    spawn(_command: string, _args: string[], _options: PtySpawnOptions): PtyRuntimeTransport {
        this.last = new DrivablePty();
        return this.last;
    }
}

/** claude-cli shape: the initial state can go straight to busy (a restored mid-turn screen). */
function restoreSpec(): Record<string, unknown> {
    return {
        $schema: 'adhdev:cli/spec@4',
        id: 'test.restored-midturn',
        name: 'restored mid-turn test',
        binary: '/bin/true',
        send_message: { submit_key: '\r' },
        sections: { footer: { from_bottom: 1 } },
        states: [
            { id: 'starting', label: 'Starting', initial: true, status: 'idle' },
            { id: 'idle', label: 'Ready', status: 'idle' },
            { id: 'busy', label: 'Working', status: 'generating' },
        ],
        transitions: [
            { label: 'starting→idle', from: 'starting', to: 'idle', when: { section: 'footer', matches: '\\? for shortcuts' } },
            { label: 'idle→busy', from: ['starting', 'idle'], to: 'busy', when: { section: 'footer', matches: 'esc to interrupt' } },
            { label: 'busy→idle', from: 'busy', to: 'idle', when: { section: 'footer', matches: '\\? for shortcuts' } },
        ],
    };
}

const tmpDirs: string[] = [];
const adapters: SpecCliAdapter[] = [];
afterEach(() => {
    while (adapters.length) { try { adapters.pop()!.shutdown(); } catch { /* ignore */ } }
    while (tmpDirs.length) { try { fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true }); } catch { /* ignore */ } }
});

function writeSpec(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'restored-midturn-'));
    tmpDirs.push(dir);
    const p = path.join(dir, 'spec.json');
    fs.writeFileSync(p, JSON.stringify(restoreSpec()));
    return p;
}

function spawnAdapter(attached: boolean): { adapter: SpecCliAdapter; pty: DrivablePty } {
    const factory = new DrivableFactory(attached);
    const adapter = new SpecCliAdapter(writeSpec(), '/tmp/project', [], {}, factory, `sess_restore_${attached}`);
    adapters.push(adapter);
    void adapter.spawn();
    return { adapter, pty: factory.last! };
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
/** TerminalAdapter coalesces screen snapshots (80 ms debounce); wait past it. */
const SETTLE_MS = 250;
const BUSY_FRAME = '\x1b[2J\x1b[H> sleep 120\n\nRunning… (esc to interrupt)';
const IDLE_FRAME = '\x1b[2J\x1b[H> sleep 120\nZEBRA-42 done\n? for shortcuts';

describe('SpecCliAdapter — a re-attached runtime that is mid-turn (real FsmDriver chain)', () => {
    it('reports generating for the in-flight turn, then idle with the ready latch at its real end', async () => {
        const { adapter, pty } = spawnAdapter(true);
        pty.feed(BUSY_FRAME);
        await sleep(SETTLE_MS);
        const busy = adapter.getStatus();
        expect(busy.status).toBe('generating');
        expect(adapter.isProcessing()).toBe(true);

        pty.feed(IDLE_FRAME);
        await sleep(SETTLE_MS);
        const idle = adapter.getStatus();
        expect(idle.status).toBe('idle');
        expect(idle.fsmReadySeen).toBe(true);
    });

    it('a FRESH process keeps the boot-phase hold: generating before the first ready prompt stays starting', async () => {
        const { adapter, pty } = spawnAdapter(false);
        pty.feed(BUSY_FRAME);
        await sleep(SETTLE_MS);
        expect(adapter.getStatus().status).toBe('starting');
    });
});

describe('projectAdapterStatus — restored-attach branch of the ready gate', () => {
    const inputs = (over: Partial<AdapterStatusInputs>): AdapterStatusInputs => ({
        providerSessionId: undefined,
        providerFailure: null,
        exited: false,
        spawned: true,
        activeInteractivePrompt: null,
        state: { id: 'busy', label: 'Working', title: null, status: 'generating' },
        modal: null,
        readySeen: () => false,
        lastOutputAt: undefined,
        lastScreenChangeAt: undefined,
        ...over,
    });

    it('attached + generating before the ready latch → generating', () => {
        expect(projectAdapterStatus(inputs({ attachedExistingRuntime: true })).status).toBe('generating');
    });

    it('fresh (absent or false) + generating before the ready latch → starting (boot noise stays hidden)', () => {
        expect(projectAdapterStatus(inputs({})).status).toBe('starting');
        expect(projectAdapterStatus(inputs({ attachedExistingRuntime: false })).status).toBe('starting');
    });

    it('attached + idle before the ready latch → still starting (the agent:ready one-shot is not consumed early)', () => {
        const status = projectAdapterStatus(inputs({
            attachedExistingRuntime: true,
            state: { id: 'starting', label: 'Starting', title: null, status: 'idle' },
        }));
        expect(status.status).toBe('starting');
        expect(status.fsmReadySeen).toBe(false);
    });
});

describe('SessionHostPtyTransportFactory.attachesExistingRuntime', () => {
    it('mirrors the attachExisting option the restore path passes', () => {
        const base = { clientId: 'c', runtimeId: 'r', providerType: 'claude-cli', workspace: '/w' };
        expect(new SessionHostPtyTransportFactory({ ...base, attachExisting: true }).attachesExistingRuntime).toBe(true);
        expect(new SessionHostPtyTransportFactory({ ...base, attachExisting: false }).attachesExistingRuntime).toBe(false);
        expect(new SessionHostPtyTransportFactory(base).attachesExistingRuntime).toBe(false);
    });
});
