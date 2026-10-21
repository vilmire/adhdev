import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { terminateRefineProcessGroup } from '../../src/mesh/mesh-refine-lanes.js';
import { runMeshRefineValidationGate } from '../../src/mesh/mesh-refine-gates.js';

// REFINE-LANES process ownership. Cancellation may only ever signal the gate's
// OWN process group (-leaderPid) through the handle it holds, and only while
// the leader is un-reaped. Numeric pids from ps (descendants, reused pids,
// foreign processes) are never signalled — mock-only: no real foreign process
// is ever involved.

class FakeChild extends EventEmitter {
    exitCode: number | null = null;
    signalCode: NodeJS.Signals | null = null;
    constructor(public pid: number) { super(); }
    reap(signal: NodeJS.Signals | null = 'SIGTERM') {
        this.signalCode = signal;
        this.emit('exit', null, signal);
    }
}

const LEADER = 4242;
const ourTree = [
    { pid: LEADER, ppid: 1, pgid: LEADER, command: 'npm run x' },
    { pid: 4300, ppid: LEADER, pgid: LEADER, command: 'node worker.js' },
    { pid: 4400, ppid: 4300, pgid: 4400, command: 'node daemonized.js' }, // setsid'ed — left the group
];
const foreign = { pid: 9999, ppid: 1, pgid: 9999, command: 'some other user process' };

describe('terminateRefineProcessGroup — ownership', () => {
    it('signals only the negative leader pid (its own group), never a descendant or foreign pid', async () => {
        const child = new FakeChild(LEADER);
        const sent: Array<[number, string]> = [];
        await terminateRefineProcessGroup(child, {
            platform: 'darwin',
            graceMs: 10,
            listProcesses: async () => [...ourTree, foreign],
            signal: (pid, sig) => { sent.push([pid, sig]); if (sig === 'SIGTERM') child.reap('SIGTERM'); },
        });
        expect(sent).toEqual([[-LEADER, 'SIGTERM']]);
        expect(sent.every(([pid]) => pid === -LEADER)).toBe(true);
    });

    it('sends nothing once the leader has been reaped — its pid/pgid may already be reused', async () => {
        const child = new FakeChild(LEADER);
        child.exitCode = 0; // reaped: the number LEADER may now name an unrelated process
        const sent: unknown[] = [];
        let taskkilled = false;
        await terminateRefineProcessGroup(child, { platform: 'darwin', graceMs: 10, listProcesses: async () => [foreign], signal: (...a) => { sent.push(a); } });
        await terminateRefineProcessGroup(child, { platform: 'win32', taskkill: async () => { taskkilled = true; } });
        expect(sent).toEqual([]);
        expect(taskkilled).toBe(false);
    });

    it('does not escalate to SIGKILL after the leader exits during the grace window', async () => {
        const child = new FakeChild(LEADER);
        const sent: string[] = [];
        await terminateRefineProcessGroup(child, {
            platform: 'darwin',
            graceMs: 50,
            listProcesses: async () => ourTree,
            signal: (_pid, sig) => { sent.push(sig); if (sig === 'SIGTERM') setTimeout(() => child.reap('SIGTERM'), 5); },
        });
        expect(sent).toEqual(['SIGTERM']);
    });

    it('escalates to SIGKILL on the group only while the leader is still un-reaped', async () => {
        const child = new FakeChild(LEADER);
        const sent: Array<[number, string]> = [];
        await terminateRefineProcessGroup(child, {
            platform: 'darwin',
            graceMs: 10,
            listProcesses: async () => ourTree,
            signal: (pid, sig) => { sent.push([pid, sig]); if (sig === 'SIGKILL') child.reap('SIGKILL'); },
        });
        expect(sent).toEqual([[-LEADER, 'SIGTERM'], [-LEADER, 'SIGKILL']]);
    });

    it('reports a descendant that left the group, never signals it, and ignores a reused pid with a different command', async () => {
        const child = new FakeChild(LEADER);
        const sent: Array<[number, string]> = [];
        let call = 0;
        const result = await terminateRefineProcessGroup(child, {
            platform: 'darwin',
            graceMs: 10,
            listProcesses: async () => (call++ === 0
                ? ourTree
                // after: the daemonized child is still alive; pid 4300 was REUSED by a foreign command.
                : [{ pid: 4400, ppid: 1, pgid: 4400, command: 'node daemonized.js' }, { pid: 4300, ppid: 1, pgid: 4300, command: 'unrelated' }]),
            signal: (pid, sig) => { sent.push([pid, sig]); child.reap(sig); },
        });
        expect(sent).toEqual([[-LEADER, 'SIGTERM']]);
        expect(result.escaped).toEqual([{ pid: 4400, pgid: 4400, command: 'node daemonized.js', reason: 'left_group' }]);
    });

    it('win32: taskkill /T targets the root only while the handle reports no exit', async () => {
        const child = new FakeChild(LEADER);
        const killed: number[] = [];
        await terminateRefineProcessGroup(child, { platform: 'win32', taskkill: async pid => { killed.push(pid); child.reap('SIGKILL'); } });
        expect(killed).toEqual([LEADER]);
    });
});

describe('scheduled output limit matches execFile (bytes, streaming utf8)', () => {
    const roots: string[] = [];
    afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

    async function run(scheduled: boolean, script: string, outputLimitBytes: number) {
        const ws = mkdtempSync(join(tmpdir(), 'adhdev-refine-bytes-'));
        roots.push(ws);
        writeFileSync(join(ws, 'out.js'), script, 'utf-8');
        const command = { id: 'out', command: 'node', args: ['out.js'], outputLimitBytes, writes: [] };
        const validation: any = { required: true, bootstrap: 'skip', commands: [command] };
        if (scheduled) validation.schedule = { phases: [{ id: 'p', lanes: [{ id: 'l', commands: ['out'] }] }] };
        return await runMeshRefineValidationGate({ id: 'm', policy: { refineConfig: { version: 1, validation } } }, ws) as any;
    }

    it('600 euro signs (1800 bytes) at maxBuffer 1024 fail identically, serial and scheduled', async () => {
        const script = "process.stdout.write('€'.repeat(600))\n";
        const serial = await run(false, script, 1024);
        const scheduled = await run(true, script, 1024);
        for (const summary of [serial, scheduled]) {
            expect(summary.status).toBe('failed');
            expect(summary.failureKind).toBe('output_limit_exceeded');
            expect(summary.commandsRun[0]).toMatchObject({ passed: false, failureKind: 'output_limit_exceeded' });
        }
    });

    it('a multibyte character split across writes is decoded whole', async () => {
        const script = [
            "const b = Buffer.from('€');",
            'process.stdout.write(b.subarray(0, 1));',
            'setTimeout(() => { process.stdout.write(b.subarray(1)); }, 100);',
        ].join('\n');
        const scheduled = await run(true, script, 1024 * 1024);
        expect(scheduled.status).toBe('passed');
        expect(scheduled.commandsRun[0].stdout).toBe('€');
    });
});
