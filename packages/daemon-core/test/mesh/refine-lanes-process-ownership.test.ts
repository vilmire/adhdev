import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { spawnRefineGateChild, terminateRefineChild } from '../../src/mesh/mesh-refine-lanes.js';
import { runMeshRefineValidationGate } from '../../src/mesh/mesh-refine-gates.js';

// REFINE-LANES process ownership (standing mesh rule): a gate is only ever
// signalled through the ChildProcess handle the runner holds (child.kill()).
// No numeric pid, process group or tree is ever signalled — census pids are
// reported, never touched. Signal assertions use mocks; the real-process cases
// below use only self-exiting children and never send a signal from the test.

class FakeChild extends EventEmitter {
    exitCode: number | null = null;
    signalCode: NodeJS.Signals | null = null;
    kills: string[] = [];
    destroyed = { stdout: false, stderr: false };
    stdout = { destroy: () => { this.destroyed.stdout = true; } };
    stderr = { destroy: () => { this.destroyed.stderr = true; } };
    constructor(public pid: number, private dieOn: NodeJS.Signals | null = 'SIGTERM') { super(); }
    kill(signal: NodeJS.Signals = 'SIGTERM') {
        this.kills.push(signal);
        if (this.dieOn === signal || signal === 'SIGKILL') setTimeout(() => { this.signalCode = signal; this.emit('exit', null, signal); }, 1);
        return true;
    }
}

const ROOT = 4242;
const tree = [
    { pid: ROOT, ppid: 1, command: 'npm run x' },
    { pid: 4300, ppid: ROOT, command: 'node worker.js' },
    { pid: 4400, ppid: 4300, command: 'node daemonized.js' },
];
const foreign = { pid: 9999, ppid: 1, command: 'some other user process' };

describe('terminateRefineChild — handle only', () => {
    afterEach(() => vi.restoreAllMocks());

    it('signals only through the held handle; never process.kill on any pid (census or foreign)', async () => {
        const processKill = vi.spyOn(process, 'kill').mockImplementation(() => true); // never delivers anything, even on a regression
        const child = new FakeChild(ROOT);
        await terminateRefineChild(child, { graceMs: 20, listProcesses: async () => [...tree, foreign] });
        expect(child.kills).toEqual(['SIGTERM']);
        expect(processKill).not.toHaveBeenCalled();
    });

    it('destroys the pipes (as execFile does) so a descendant holding them cannot hang the gate', async () => {
        const child = new FakeChild(ROOT);
        await terminateRefineChild(child, { graceMs: 20, listProcesses: async () => [] });
        expect(child.destroyed).toEqual({ stdout: true, stderr: true });
    });

    it('sends nothing to a child that has already exited', async () => {
        const child = new FakeChild(ROOT);
        child.exitCode = 0;
        const result = await terminateRefineChild(child, { graceMs: 20, listProcesses: async () => [] });
        expect(child.kills).toEqual([]);
        expect(result.signals).toEqual([]);
    });

    it('escalates to SIGKILL on the same handle only when SIGTERM did not end it within the grace', async () => {
        const child = new FakeChild(ROOT, null); // ignores SIGTERM
        await terminateRefineChild(child, { graceMs: 20, listProcesses: async () => [] });
        expect(child.kills).toEqual(['SIGTERM', 'SIGKILL']);
    });

    it('reports surviving descendants from the census, never signals them, and ignores a reused pid with a different command', async () => {
        const processKill = vi.spyOn(process, 'kill').mockImplementation(() => true); // never delivers anything, even on a regression
        const child = new FakeChild(ROOT);
        let call = 0;
        const result = await terminateRefineChild(child, {
            graceMs: 20,
            listProcesses: async () => (call++ === 0
                ? tree
                : [{ pid: 4400, ppid: 1, command: 'node daemonized.js' }, { pid: 4300, ppid: 1, command: 'unrelated (pid reused)' }, foreign]),
        });
        expect(result.escaped).toEqual([{ pid: 4400, command: 'node daemonized.js', reason: 'outlived_gate' }]);
        expect(processKill).not.toHaveBeenCalled();
        expect(child.kills).toEqual(['SIGTERM']);
    });
});

describe('spawnRefineGateChild — settles on exit, bounded; overflow reports escapees', () => {
    const roots: string[] = [];
    afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
    const ws = () => { const d = mkdtempSync(join(tmpdir(), 'adhdev-refine-settle-')); roots.push(d); return d; };

    it.skipIf(process.platform === 'win32')('a descendant holding the pipes cannot keep the gate open past the bounded grace', async () => {
        const dir = ws();
        // The parent exits at once; its child inherits the pipes and lives 6 s
        // on its own lifeline (self-exiting — nothing here signals it).
        writeFileSync(join(dir, 'p.js'), "require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 6000)'], { stdio: 'inherit' }).unref(); console.log('parent done');\n");
        const started = Date.now();
        const result = await new Promise<{ error: any; stdout: string }>(resolve => {
            spawnRefineGateChild(process.execPath, ['p.js'], { cwd: dir, encoding: 'utf8', maxBuffer: 1024 * 1024 }, (error, stdout) => resolve({ error, stdout }));
        });
        const elapsed = Date.now() - started;
        expect(result.error).toBeNull();
        expect(result.stdout).toContain('parent done');
        expect(elapsed).toBeLessThan(5_000);
    }, 15_000);

    it.skipIf(process.platform === 'win32')('maxBuffer overflow terminates through the handle and reports the surviving descendant on the error', async () => {
        const dir = ws();
        writeFileSync(join(dir, 'p.js'), [
            "const c = require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { stdio: 'ignore' });",
            "require('fs').writeFileSync(__dirname + '/child.pid', String(c.pid));",
            "setTimeout(() => { process.stdout.write('x'.repeat(4096)); setTimeout(() => {}, 5000); }, 300);",
        ].join('\n'));
        const result = await new Promise<{ error: any }>(resolve => {
            spawnRefineGateChild(process.execPath, ['p.js'], { cwd: dir, encoding: 'utf8', maxBuffer: 1024 }, error => resolve({ error }));
        });
        const childPid = Number(require('node:fs').readFileSync(join(dir, 'child.pid'), 'utf8'));
        expect(result.error?.code).toBe('ERR_CHILD_PROCESS_STDIO_MAXBUFFER');
        expect(result.error?.escapedProcesses).toEqual(expect.arrayContaining([expect.objectContaining({ pid: childPid, reason: 'outlived_gate' })]));
    }, 20_000);
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
