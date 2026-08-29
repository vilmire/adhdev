import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const childProcessCalls = vi.hoisted(() => ({
    execFileOptions: [] as Array<Record<string, unknown>>,
    spawnOptions: [] as Array<Record<string, unknown>>,
}));

vi.mock('node:child_process', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:child_process')>();
    return {
        ...actual,
        execFile: vi.fn((
            _file: string,
            _args: string[],
            options: Record<string, unknown>,
            callback: (error: Error | null, stdout: string, stderr: string) => void,
        ) => {
            childProcessCalls.execFileOptions.push(options);
            callback(null, '', '');
        }),
        spawn: vi.fn((_command: string, _args: string[], options: Record<string, unknown>) => {
            childProcessCalls.spawnOptions.push(options);
            return {};
        }),
    };
});

import { runMeshRefineValidationGate } from '../src/mesh/mesh-refine-gates.js';
import { resolveDeps } from '../src/quota/fetchers/deps.js';

describe('child process windowsHide defaults', () => {
    const roots: string[] = [];

    afterEach(() => {
        childProcessCalls.execFileOptions.length = 0;
        childProcessCalls.spawnOptions.length = 0;
        for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
    });

    it('hides the quota fetcher default spawn window', () => {
        resolveDeps().spawn('powershell.exe', ['-NoProfile'], { env: {} });

        expect(childProcessCalls.spawnOptions).toHaveLength(1);
        expect(childProcessCalls.spawnOptions[0]).toMatchObject({
            windowsHide: true,
            stdio: ['pipe', 'pipe', 'pipe'],
        });
    });

    it('hides both legacy bootstrap and validation command windows', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'adhdev-windows-hide-'));
        roots.push(workspace);
        writeFileSync(join(workspace, 'package.json'), JSON.stringify({ name: 'windows-hide-fixture' }), 'utf8');
        const mesh = {
            id: 'mesh-windows-hide',
            policy: {
                refineConfig: {
                    version: 1,
                    validation: {
                        required: true,
                        bootstrapCommands: [{ command: 'node', args: ['bootstrap.js'], category: 'custom' }],
                        commands: [{ command: 'node', args: ['validate.js'], category: 'custom' }],
                    },
                },
            },
        };

        const summary = await runMeshRefineValidationGate(mesh, workspace);

        expect(summary.status).toBe('passed');
        expect(summary.bootstrapCommandsRun).toHaveLength(1);
        expect(summary.commandsRun).toHaveLength(1);
        expect(childProcessCalls.execFileOptions).toHaveLength(2);
        expect(childProcessCalls.execFileOptions).toEqual([
            expect.objectContaining({ windowsHide: true }),
            expect.objectContaining({ windowsHide: true }),
        ]);
    });
});
