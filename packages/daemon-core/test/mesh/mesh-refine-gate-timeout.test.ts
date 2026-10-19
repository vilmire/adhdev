import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('node:child_process', async importOriginal => {
    const actual = await importOriginal<typeof import('node:child_process')>();
    return { ...actual, execFile: vi.fn((_file, _args, _options, callback) => callback(null, 'ok', '')) };
});
import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { classifyValidationFailure, runMeshRefineValidationGate } from '../../src/mesh/mesh-refine-gates.js';
import { refineValidationStage } from '../../src/commands/router-refine.js';

const roots: string[] = [];
afterEach(() => {
    vi.clearAllMocks();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('configured validation budget reaches the child executor', () => {
    it.each([600001, 1800000, undefined])('forwards %s and retains the 120000 default', async timeoutMs => {
        const workspace = mkdtempSync(join(tmpdir(), 'refine-timeout-'));
        roots.push(workspace);
        const mesh = { policy: { refineConfig: { version: 1, validation: {
            bootstrap: 'skip', commands: [{ command: 'node', args: ['check.js'], ...(timeoutMs === undefined ? {} : { timeoutMs }) }],
        } } } };
        const summary = await runMeshRefineValidationGate(mesh, workspace);
        expect(summary.status).toBe('passed');
        expect(summary.rejectedCommands).toEqual([]);
        expect(execFile).toHaveBeenCalledExactlyOnceWith('node', ['check.js'], expect.objectContaining({ timeout: timeoutMs ?? 120000 }), expect.any(Function));
        expect(summary.timeoutMs).toBe(120000);
    });

    it('keeps a step alive past timeoutMs while it keeps emitting stdout/stderr progress', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'refine-progress-'));
        roots.push(workspace);
        vi.useFakeTimers();
        try {
            let killed = false;
            vi.mocked(execFile).mockImplementationOnce(((_file: any, _args: any, _options: any, callback: any) => {
                const stdout = new EventEmitter();
                const stderr = new EventEmitter();
                const child = {
                    stdout,
                    stderr,
                    kill: vi.fn(() => {
                        killed = true;
                        callback(Object.assign(new Error('killed'), { killed: true, signal: 'SIGTERM' }), 'partial', '');
                    }),
                };
                setTimeout(() => { if (!killed) stdout.emit('data', 'test 1 ok\n'); }, 600);
                setTimeout(() => { if (!killed) stderr.emit('data', 'test 2 ok\n'); }, 1200);
                setTimeout(() => { if (!killed) stdout.emit('data', 'test 3 ok\n'); }, 1800);
                setTimeout(() => { if (!killed) callback(null, 'all 3 passed', ''); }, 2400);
                return child as any;
            }) as any);

            const mesh = { policy: { refineConfig: { version: 1, validation: {
                bootstrap: 'skip', commands: [{ command: 'node', args: ['slow-active.js'], timeoutMs: 1000 }],
            } } } };
            const summaryPromise = runMeshRefineValidationGate(mesh, workspace);
            await vi.advanceTimersByTimeAsync(2500);
            const summary = await summaryPromise;
            expect(killed).toBe(false);
            expect(summary.status).toBe('passed');
            expect(summary.commandsRun[0]?.passed).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });

    it('terminates a step that produces no output for timeoutMs and reports TIMEOUT (validation_timeout)', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'refine-idle-timeout-'));
        roots.push(workspace);
        vi.useFakeTimers();
        try {
            let killSignal: string | undefined;
            vi.mocked(execFile).mockImplementationOnce(((_file: any, _args: any, _options: any, callback: any) => {
                const stdout = new EventEmitter();
                const stderr = new EventEmitter();
                const child = {
                    stdout,
                    stderr,
                    kill: vi.fn((sig?: string) => {
                        killSignal = sig;
                        callback(Object.assign(new Error('Command failed: node hung.js'), { killed: true, signal: sig || 'SIGTERM' }), 'test 1 ok\n', 'node_modules/foo stack trace');
                    }),
                };
                setTimeout(() => stdout.emit('data', 'test 1 ok\n'), 500);
                return child as any;
            }) as any);

            const mesh = { policy: { refineConfig: { version: 1, validation: {
                bootstrap: 'skip', commands: [{ command: 'node', args: ['hung.js'], timeoutMs: 1000 }],
            } } } };
            const stagePromise = refineValidationStage({} as any, {
                mesh,
                node: { id: 'node-1', workspace },
                branch: 'fix/load',
                baseBranch: 'main',
                refineStages: [],
            } as any);
            await vi.advanceTimersByTimeAsync(1600);
            const outcome = await stagePromise;
            expect(killSignal).toBe('SIGTERM');
            expect(outcome.kind).toBe('terminal');
            const result = (outcome as any).result;
            expect(result.code).toBe('validation_timeout');
            expect(result.error).toMatch(/^TIMEOUT:/);
            const summary = result.validationSummary;
            expect(summary.status).toBe('failed');
            expect(summary.failureCode).toBe('validation_timeout');
            expect(summary.failureKind).toBe('validation_timeout');
            expect(summary.commandsRun[0]).toEqual(expect.objectContaining({
                passed: false,
                timedOut: true,
                status: 'TIMEOUT',
                failureKind: 'validation_timeout',
                failureCode: 'validation_timeout',
            }));

            const classification = classifyValidationFailure(
                { killed: true, signal: 'SIGTERM', timedOut: true },
                'Cannot find module in node_modules/foo',
                false,
            );
            expect(classification).toEqual({
                outputLimitExceeded: false,
                missingDependencyFailure: false,
                timedOut: true,
            });
        } finally {
            vi.useRealTimers();
        }
    });
});

