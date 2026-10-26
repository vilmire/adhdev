import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyValidationFailure } from '../../src/mesh/mesh-refine-gates.js';
import { refineValidationStage } from '../../src/commands/router-refine.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

async function run(scheduled: boolean, idle: boolean) {
    const workspace = mkdtempSync(join(tmpdir(), 'refine-runner-timeout-'));
    roots.push(workspace);
    writeFileSync(join(workspace, 'check.js'), idle
        // Only this fixture child can be terminated; it also has its own lifeline.
        ? 'setTimeout(() => {}, 5000);\n'
        : "process.stderr.write('Error: Test timed out in 30000ms\\n'); process.exitCode = 1;\n");
    const command = { id: 'check', command: 'node', args: ['check.js'], writes: [], timeoutMs: idle ? 1000 : 20_000 };
    const validation: any = { required: true, bootstrap: 'skip', commands: [command] };
    if (scheduled) validation.schedule = { phases: [{ id: 'p', lanes: [{ id: 'l', commands: ['check'] }] }] };
    const outcome = await refineValidationStage({} as any, {
        mesh: { id: 'fixture', policy: { refineConfig: { version: 1, validation } } },
        node: { id: 'node', workspace }, branch: 'fixture', baseBranch: 'main', refineStages: [],
    } as any);
    expect(outcome.kind).toBe('terminal');
    return (outcome as any).result;
}

for (const scheduled of [false, true]) {
    it(`test timeout text on exit 1 stays validation_failed (${scheduled ? 'lane' : 'serial'})`, async () => {
        const result = await run(scheduled, false);
        expect(result.code).toBe('validation_failed');
        const command = result.validationSummary.commandsRun[0];
        expect(command).toMatchObject({ passed: false, exitCode: 1, signal: null, timedOut: false });
        expect(command.stderr).toContain('Test timed out in 30000ms');
        expect(command.status).not.toBe('TIMEOUT');
        expect(result.validationSummary.failureCode).not.toBe('validation_timeout');
    });

    it(`an actual runner inactivity kill stays validation_timeout (${scheduled ? 'lane' : 'serial'})`, async () => {
        const result = await run(scheduled, true);
        expect(result.code).toBe('validation_timeout');
        expect(result.validationSummary.commandsRun[0]).toMatchObject({
            passed: false, timedOut: true, status: 'TIMEOUT', failureCode: 'validation_timeout',
        });
    });
}

it.each([
    { code: 1, killed: true, message: 'Command failed: child was cancelled' },
    { code: 1, killed: false, message: 'Command failed: Error: Test timed out in 30000ms' },
])('a message or non-timeout kill is not runner timeout metadata: %j', error => {
    expect(classifyValidationFailure(error, '', false).timedOut).toBe(false);
});
it.each([{ code: 'ETIMEDOUT' }, { timedOut: true }])('structured timeout metadata remains authoritative: %j', error => {
    expect(classifyValidationFailure(error, '', false).timedOut).toBe(true);
});
