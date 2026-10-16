import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('node:child_process', async importOriginal => {
    const actual = await importOriginal<typeof import('node:child_process')>();
    return { ...actual, execFile: vi.fn((_file, _args, _options, callback) => callback(null, 'ok', '')) };
});
import { execFile } from 'node:child_process';
import { runMeshRefineValidationGate } from '../../src/mesh/mesh-refine-gates.js';

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
});
