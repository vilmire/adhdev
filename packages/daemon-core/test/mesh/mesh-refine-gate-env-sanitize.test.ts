import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runMeshRefineValidationGate } from '../../src/mesh/mesh-refine-gates.js';

/**
 * REFINE-GATE-ENV-SANITIZE injection proof (mission M-MESH-INFRA-0829).
 *
 * Refinery spawns validation/bootstrap gate commands with `{ ...process.env,
 * ... }` — the running daemon's own environment, verbatim. An ADHDEV_* flag
 * the daemon booted with (e.g. a worker-MCP canary, ADHDEV_WORKER_MCP=on
 * applied via config.envOverrides) was inherited by the spawned test/build
 * process, breaking env-sensitive tests that have nothing to do with the
 * flag. Measured: cli-provider-startup-grace-generating-miss.test.ts threw
 * inside CliProviderInstance's completion path when ADHDEV_WORKER_MCP=on
 * leaked in, blocking the whole fleet's Refinery landing pipeline.
 *
 * These tests actually spawn a real child (via runMeshRefineValidationGate,
 * not a mock) that echoes its own env back, with ADHDEV_WORKER_MCP=on set on
 * THIS process — the same shape as a canaried daemon — and assert the gate
 * child never sees it. Before the mesh-refine-env-sanitize.ts fix this is
 * RED (the child echoes 'on'); after, it is GREEN (the child echoes
 * '<absent>').
 */
describe('Refinery gate child env sanitize', () => {
    const roots: string[] = [];
    let originalWorkerMcp: string | undefined;

    afterEach(() => {
        for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
        if (originalWorkerMcp === undefined) delete process.env.ADHDEV_WORKER_MCP;
        else process.env.ADHDEV_WORKER_MCP = originalWorkerMcp;
    });

    // A plain node script (no node_modules needed) that prints whether
    // ADHDEV_WORKER_MCP reached the child, plus a control var (PATH) to prove
    // the sanitize doesn't over-strip.
    function workspace(): string {
        const dir = mkdtempSync(join(tmpdir(), 'adhdev-refine-env-sanitize-'));
        roots.push(dir);
        writeFileSync(join(dir, 'package.json'), '{}\n', 'utf-8');
        writeFileSync(
            join(dir, 'echo-env.js'),
            "process.stdout.write(JSON.stringify({"
            + "workerMcp: process.env.ADHDEV_WORKER_MCP ?? '<absent>',"
            + "hasPath: typeof process.env.PATH === 'string' && process.env.PATH.length > 0,"
            + "}));\n",
            'utf-8',
        );
        return dir;
    }

    function meshWith(commands: Array<{ command: string; args?: string[]; category?: string }>): any {
        return {
            id: 'mesh-env-sanitize',
            policy: {
                refineConfig: {
                    version: 1,
                    validation: { required: true, bootstrap: 'skip', commands },
                },
            },
        };
    }

    it('validation-loop gate command never sees the daemon-process ADHDEV_WORKER_MCP flag', async () => {
        originalWorkerMcp = process.env.ADHDEV_WORKER_MCP;
        process.env.ADHDEV_WORKER_MCP = 'on';

        const ws = workspace();
        const mesh = meshWith([
            { command: 'node', args: ['echo-env.js'], category: 'custom' },
        ]);

        const summary = await runMeshRefineValidationGate(mesh, ws);

        expect(summary.status).toBe('passed');
        const record = summary.commandsRun.find((c: any) => c.displayCommand === 'node echo-env.js') as any;
        expect(record).toBeDefined();
        const echoed = JSON.parse(record!.stdout as string);
        expect(echoed.workerMcp).toBe('<absent>');
        expect(echoed.hasPath).toBe(true);
    });

    it('legacy bootstrapCommands gate command never sees the daemon-process ADHDEV_WORKER_MCP flag', async () => {
        originalWorkerMcp = process.env.ADHDEV_WORKER_MCP;
        process.env.ADHDEV_WORKER_MCP = 'on';

        const ws = workspace();
        const mesh: any = {
            id: 'mesh-env-sanitize-bootstrap',
            policy: {
                refineConfig: {
                    version: 1,
                    validation: {
                        required: true,
                        bootstrapCommands: [{ command: 'node', args: ['echo-env.js'], category: 'custom' }],
                        commands: [{ command: 'node', args: ['echo-env.js'], category: 'custom' }],
                    },
                },
            },
        };

        const summary = await runMeshRefineValidationGate(mesh, ws);

        expect(summary.status).toBe('passed');
        const record = summary.bootstrapCommandsRun.find((c: any) => c.displayCommand === 'node echo-env.js') as any;
        expect(record).toBeDefined();
        const echoed = JSON.parse(record!.stdout as string);
        expect(echoed.workerMcp).toBe('<absent>');
        expect(echoed.hasPath).toBe(true);
    });
});
