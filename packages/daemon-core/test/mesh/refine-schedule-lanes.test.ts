import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { validateMeshRefineConfig } from '../../src/mesh/refine-config.js';
import { planScheduledRefineRun } from '../../src/mesh/refine-schedule.js';
import { runMeshRefineValidationGate } from '../../src/mesh/mesh-refine-gates.js';
import { extractValidationFailureDiagnostics } from '../../src/commands/router-refine-jobs.js';

// REFINE-LANES: the config-declared parallel schedule. Two properties matter
// more than speed: a schedule can never drop a gate, and it can never overlap a
// dist writer with a reader of the same dist (the 1.0.81 npm-pack ENOENT race).

const cmd = (id: string, extra: Record<string, unknown> = {}) => ({ id, command: 'node', args: [`${id}.js`], ...extra });

function config(commands: any[], schedule: any) {
    return { version: 1, validation: { required: true, bootstrap: 'skip', commands, schedule } };
}

describe('validation.schedule — config validation', () => {
    it('accepts a schedule that places every command exactly once', () => {
        const result = validateMeshRefineConfig(config(
            [cmd('a', { writes: [] }), cmd('b', { writes: [] }), cmd('c', { writes: ['pkg/dist'] })],
            { phases: [
                { id: 'p1', lanes: [{ id: 's', commands: ['a'] }, { id: 't', commands: ['b'] }] },
                { id: 'p2', lanes: [{ id: 'serial', commands: ['c'] }] },
            ] },
        ));
        expect(result.errors).toEqual([]);
        expect(result.valid).toBe(true);
        expect(result.schedule?.phases.map(p => p.concurrency)).toEqual([2, 1]);
    });

    it('a config without schedule is unchanged (serial, no ids needed)', () => {
        const result = validateMeshRefineConfig({ version: 1, validation: { commands: [{ command: 'node', args: ['x.js'] }] } });
        expect(result.valid).toBe(true);
        expect(result.schedule).toBeUndefined();
    });

    it('refuses a schedule that drops a configured gate', () => {
        const result = validateMeshRefineConfig(config([cmd('a'), cmd('b')], { phases: [{ id: 'p', lanes: [{ id: 'l', commands: ['a'] }] }] }));
        expect(result.valid).toBe(false);
        expect(result.errors.join('\n')).toMatch(/"b" is not scheduled/);
    });

    it('refuses duplicates, unknown ids and commands without id', () => {
        const dup = validateMeshRefineConfig(config([cmd('a')], { phases: [{ id: 'p', lanes: [{ id: 'l', commands: ['a', 'a'] }] }] }));
        expect(dup.errors.join('\n')).toMatch(/scheduled twice/);
        const unknown = validateMeshRefineConfig(config([cmd('a')], { phases: [{ id: 'p', lanes: [{ id: 'l', commands: ['a', 'zz'] }] }] }));
        expect(unknown.errors.join('\n')).toMatch(/unknown command id "zz"/);
        const noId = validateMeshRefineConfig(config([{ command: 'node', args: ['x.js'] }], { phases: [{ id: 'p', lanes: [{ id: 'l', commands: ['x'] }] }] }));
        expect(noId.errors.join('\n')).toMatch(/needs an id/);
    });

    it('refuses a parallel phase where a dist writer can overlap a reader of that dist', () => {
        const result = validateMeshRefineConfig(config(
            [cmd('build', { writes: ['oss/packages/daemon-core/dist'] }), cmd('scripts', { writes: [], reads: ['oss/packages/daemon-core/dist/index.js'] })],
            { phases: [{ id: 'p', lanes: [{ id: 'w', commands: ['build'] }, { id: 'r', commands: ['scripts'] }] }] },
        ));
        expect(result.valid).toBe(false);
        expect(result.errors.join('\n')).toMatch(/schedule refused: in phase "p", "build" \(lane w\) writes oss\/packages\/daemon-core\/dist/);
    });

    it('treats undeclared reads as reading everything, and undeclared writes as refused in a parallel phase', () => {
        const readsAll = validateMeshRefineConfig(config(
            [cmd('build', { writes: ['x/dist'] }), cmd('t', { writes: [] })],
            { phases: [{ id: 'p', lanes: [{ id: 'a', commands: ['build'] }, { id: 'b', commands: ['t'] }] }] },
        ));
        expect(readsAll.errors.join('\n')).toMatch(/may touch \*/);
        const noWrites = validateMeshRefineConfig(config(
            [cmd('a'), cmd('b', { writes: [] })],
            { phases: [{ id: 'p', lanes: [{ id: 'a', commands: ['a'] }, { id: 'b', commands: ['b'] }] }] },
        ));
        expect(noWrites.errors.join('\n')).toMatch(/"a" runs in overlapping phase "p" but does not declare "writes"/);
    });

    it('allows writers in a phase whose lanes cannot overlap (concurrency 1)', () => {
        const result = validateMeshRefineConfig(config(
            [cmd('build', { writes: ['x/dist'] }), cmd('t')],
            { phases: [{ id: 'p', concurrency: 1, lanes: [{ id: 'a', commands: ['build'] }, { id: 'b', commands: ['t'] }] }] },
        ));
        expect(result.errors).toEqual([]);
    });

    it('rejects non-canonical path declarations that could alias a canonical path past the overlap check', () => {
        for (const bad of ['pkg/../shared', './shared', 'shared//dist', '/abs/shared', 'C:/repo/shared', 'shared\\dist', '..', '.']) {
            const result = validateMeshRefineConfig(config(
                [cmd('w', { writes: [bad] }), cmd('r', { writes: [], reads: ['shared'] })],
                { phases: [{ id: 'p', lanes: [{ id: 'a', commands: ['w'] }, { id: 'b', commands: ['r'] }] }] },
            ));
            expect(result.valid, bad).toBe(false);
            expect(result.rejectedCommands.map(r => String(r.reason)).join('\n'), bad).toMatch(/not a canonical repo-relative POSIX path/);
        }
        // Canonical spellings (trailing '/' trimmed) are accepted and still overlap-checked.
        const ok = validateMeshRefineConfig(config(
            [cmd('w', { writes: ['shared/dist/'] }), cmd('r', { writes: [], reads: ['shared'] })],
            { phases: [{ id: 'p', lanes: [{ id: 'a', commands: ['w'] }, { id: 'b', commands: ['r'] }] }] },
        ));
        expect(ok.errors.join('\n')).toMatch(/schedule refused: in phase "p", "w" \(lane a\) writes shared\/dist/);
    });

    it('planScheduledRefineRun drops scope-skipped commands and empty lanes but keeps every runnable one', () => {
        const result = validateMeshRefineConfig(config(
            [cmd('a', { writes: [] }), cmd('b', { writes: [] }), cmd('c')],
            { phases: [{ id: 'p1', lanes: [{ id: 's', commands: ['a'] }, { id: 't', commands: ['b'] }] }, { id: 'p2', lanes: [{ id: 'z', commands: ['c'] }] }] },
        ));
        const toRun = result.commands.filter(c => c.id !== 'b');
        const phases = planScheduledRefineRun(result.schedule!, toRun);
        expect(phases.map(p => p.lanes.map(l => l.id))).toEqual([['s'], ['z']]);
        expect(phases.flatMap(p => p.lanes.flatMap(l => l.commands.map(c => c.id))).sort()).toEqual(['a', 'c']);
    });
});

describe('validation.schedule — runner', () => {
    const roots: string[] = [];
    afterEach(() => {
        for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
    });

    function workspace(scripts: Record<string, string>): string {
        const dir = mkdtempSync(join(tmpdir(), 'adhdev-refine-lanes-'));
        roots.push(dir);
        for (const [name, body] of Object.entries(scripts)) writeFileSync(join(dir, name), body, 'utf-8');
        return dir;
    }

    // Each script appends "<id> start <ms>" / "<id> end <ms>" + its run id to log.txt.
    const timed = (id: string, ms: number, exitCode = 0) => `
const fs = require('fs');
const log = (s) => fs.appendFileSync(__dirname + '/log.txt', s + '\\n');
log('${id} start ' + Date.now() + ' ' + (process.env.ADHDEV_REFINE_RUN_ID || '-') + ' ' + (process.env.LANE_TAG || '-'));
setTimeout(() => { log('${id} end ' + Date.now()); process.exit(${exitCode}); }, ${ms});
`;

    it('runs every configured gate exactly once, lanes concurrently, and keeps prepare out of commandsRun', async () => {
        const ids = ['p0a', 'p0b', 's1', 't1', 't2', 'z1'];
        const ws = workspace({
            'prep.js': timed('prep', 10),
            'p0a.js': timed('p0a', 10), 'p0b.js': timed('p0b', 10),
            's1.js': timed('s1', 600), 't1.js': timed('t1', 250), 't2.js': timed('t2', 250),
            'z1.js': timed('z1', 10),
        });
        const commands = ids.map(id => cmd(id, ['s1', 't1', 't2'].includes(id) ? { writes: [] } : {}));
        const mesh = { id: 'm', policy: { refineConfig: config(commands, {
            prepare: [{ command: 'node', args: ['prep.js'] }],
            phases: [
                { id: 'P0', lanes: [{ id: 'serial', commands: ['p0a', 'p0b'] }] },
                { id: 'P2', lanes: [{ id: 'S', commands: ['s1'] }, { id: 'T', commands: ['t1', 't2'], env: { LANE_TAG: 'lane-t' } }] },
                { id: 'P3', lanes: [{ id: 'tail', commands: ['z1'] }] },
            ],
        }) } };

        const summary: any = await runMeshRefineValidationGate(mesh, ws);

        expect(summary.status).toBe('passed');
        // ★Coverage: the executed gate set equals the configured command set.
        const executed = summary.commandsRun.map((c: any) => c.displayCommand).sort();
        expect(executed).toEqual(ids.map(id => `node ${id}.js`).sort());
        expect(summary.commandsRun.every((c: any) => c.passed === true && !c.skipped)).toBe(true);
        expect(summary.schedule.prepareRun.map((c: any) => c.displayCommand)).toEqual(['node prep.js']);

        const log = readFileSync(join(ws, 'log.txt'), 'utf-8').trim().split('\n').map(l => l.split(' '));
        const at = (id: string, kind: string) => Number(log.find(l => l[0] === id && l[1] === kind)![2]);
        // S and T overlapped; P3 started only after both finished; prepare ran first.
        expect(at('t1', 'start')).toBeLessThan(at('s1', 'end'));
        expect(at('z1', 'start')).toBeGreaterThanOrEqual(Math.max(at('s1', 'end'), at('t2', 'end')));
        expect(at('prep', 'end')).toBeLessThanOrEqual(at('p0a', 'start'));
        // Lane T commands ran in order; lane env + run id reached the children.
        expect(at('t2', 'start')).toBeGreaterThanOrEqual(at('t1', 'end'));
        const t1 = log.find(l => l[0] === 't1' && l[1] === 'start')!;
        expect(t1[3]).toBe(summary.schedule.runId);
        expect(t1[4]).toBe('lane-t');
        expect(log.find(l => l[0] === 's1' && l[1] === 'start')![4]).toBe('-');
    });

    it.skipIf(process.platform === 'win32')('first failure cancels the other lane: its process group dies, an escaped (setsid) grandchild is reported, never signalled', async () => {
        const ws = workspace({
            'fail.js': timed('fail', 300, 3),
            // Lane S: npm-like wrapper → child → detached grandchild that would outlive a plain kill.
            'slow.js': `
const { spawn } = require('child_process');
const fs = require('fs');
const g = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 4000)'], { detached: true, stdio: 'ignore' });
fs.writeFileSync(__dirname + '/grandchild.pid', String(g.pid));
const c = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'inherit' });
fs.writeFileSync(__dirname + '/child.pid', String(c.pid));
setTimeout(() => {}, 60000);
`,
            'after.js': timed('after', 10),
        });
        const mesh = { id: 'm', policy: { refineConfig: config(
            [cmd('slow', { writes: [] }), cmd('fail', { writes: [] }), cmd('after')],
            { phases: [
                { id: 'P2', lanes: [{ id: 'S', commands: ['slow'] }, { id: 'T', commands: ['fail'] }] },
                { id: 'P3', lanes: [{ id: 'tail', commands: ['after'] }] },
            ] },
        ) } };

        const started = Date.now();
        const summary: any = await runMeshRefineValidationGate(mesh, ws);
        expect(Date.now() - started).toBeLessThan(20_000);

        expect(summary.status).toBe('failed');
        // firstFailedCommand semantics: the first passed:false record is the real failure.
        expect(extractValidationFailureDiagnostics(summary)?.firstFailedCommand).toBe('node fail.js');
        const slow = summary.commandsRun.find((c: any) => c.displayCommand === 'node slow.js');
        expect(slow).toMatchObject({ passed: false, cancelled: true, failureKind: 'cancelled_by_lane_failure' });
        expect(summary.commandsRun.findIndex((c: any) => c.displayCommand === 'node fail.js'))
            .toBeLessThan(summary.commandsRun.indexOf(slow));
        // The later phase never started.
        expect(summary.commandsRun.some((c: any) => c.displayCommand === 'node after.js')).toBe(false);
        expect(existsSync(join(ws, 'log.txt')) && readFileSync(join(ws, 'log.txt'), 'utf-8').includes('after start')).toBe(false);

        // signal 0 only probes existence; nothing is delivered.
        const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
        const childPid = Number(readFileSync(join(ws, 'child.pid'), 'utf-8'));
        const grandchildPid = Number(readFileSync(join(ws, 'grandchild.pid'), 'utf-8'));
        // The in-group child died with the group signal.
        expect(alive(childPid), `in-group child ${childPid} survived the lane cancel`).toBe(false);
        // The setsid'ed grandchild left the group: not signalled (it ends on its own
        // 4 s lifeline), but reported on the run.
        expect(summary.schedule.report.escaped).toEqual(expect.arrayContaining([
            expect.objectContaining({ pid: grandchildPid, reason: 'left_group' }),
        ]));
    }, 30_000);

    it('a failing prepare command fails validation before any gate runs and is the first failed command', async () => {
        const ws = workspace({ 'prep.js': 'process.exit(2)\n', 'a.js': timed('a', 10) });
        const mesh = { id: 'm', policy: { refineConfig: config([cmd('a')], {
            prepare: [{ command: 'node', args: ['prep.js'] }],
            phases: [{ id: 'P', lanes: [{ id: 'l', commands: ['a'] }] }],
        }) } };
        const summary: any = await runMeshRefineValidationGate(mesh, ws);
        expect(summary.status).toBe('failed');
        expect(extractValidationFailureDiagnostics(summary)?.firstFailedCommand).toBe('node prep.js');
        expect(summary.commandsRun.some((c: any) => c.displayCommand === 'node a.js')).toBe(false);
    });
});
