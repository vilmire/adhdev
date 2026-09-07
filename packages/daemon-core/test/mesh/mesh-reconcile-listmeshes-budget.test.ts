import { describe, expect, it, beforeEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * Per-tick meshes.json read budget (perf regression gate).
 *
 * `listMeshes()` is a synchronous readFileSync + JSON.parse + full migration
 * object rebuild. `runMeshReconcileTick` iterates the mesh list in ~14 separate
 * phase loops, so before the per-tick snapshot each tick re-read and re-parsed
 * the same file up to 14 times every 4 seconds, producing byte-identical data
 * each time (measured 0.10ms/read at 20 meshes ≈ 1.7ms of blocking sync I/O per
 * tick).
 *
 * The tick now reads once into `meshesSnapshot` and passes it to every phase.
 * This test pins the resulting budget: ONE disk read per tick, regardless of how
 * many phases are active. Reverting the fix (restoring `for (const mesh of
 * listMeshes())` in the phase loops) makes the observed count jump well past the
 * ceiling and turns this test red.
 *
 * The counter is incremented inside `listMeshes` itself, so this measures real
 * reads rather than a mocked call count.
 */

const configDir = mkdtempSync(join(tmpdir(), 'mesh-reconcile-budget-'));
process.env.ADHDEV_CONFIG_DIR = configDir;

describe('reconcile tick meshes.json read budget', () => {
    beforeEach(() => {
        vi.resetModules();
    });

    it('reads meshes.json at most once per reconcile tick', async () => {
        // Several meshes, none hosted by this daemon: every phase loop still
        // ITERATES the list (which is what costs the read) and then skips the
        // per-mesh body on the host gate, so this isolates the read budget from
        // the phases' own work.
        writeFileSync(join(configDir, 'meshes.json'), JSON.stringify({
            meshes: Array.from({ length: 3 }, (_, i) => ({
                id: `mesh-${i}`,
                name: `mesh ${i}`,
                repoIdentity: `repo-${i}`,
                defaultBranch: 'main',
                nodes: [{ nodeId: `node-${i}`, daemonId: `other-daemon-${i}`, label: 'n', workspacePath: `/w/${i}` }],
                policy: {},
                createdAt: 1,
                updatedAt: 1,
            })),
        }));

        const meshConfig = await import('../../src/config/mesh-config.js');
        const { runMeshReconcileTick } = await import('../../src/mesh/mesh-reconcile-loop.js');

        // A deliberately minimal components object: no router, no
        // dispatchMeshCommand, no live coordinators. The phases those gate are
        // skipped, but the ungated phases (2.6, 4) still iterate the list — so a
        // reverted fix is caught even in this reduced configuration.
        const components = {
            instanceManager: {
                collectAllStates: () => [],
                getInstance: () => undefined,
                getByCategory: () => [],
            },
            sessionRegistry: new Map(),
            cdpManagers: new Map(),
        } as any;

        meshConfig.__resetListMeshesDiskReadCountForTests();
        await runMeshReconcileTick(components);
        const reads = meshConfig.__getListMeshesDiskReadCountForTests();

        // Exactly one snapshot read for the whole tick. Asserted as an upper
        // bound rather than an equality so an intentionally-added second read
        // (with a stated reason) is a deliberate edit here, while the reverted
        // 14-read shape fails loudly.
        expect(reads).toBeLessThanOrEqual(1);
    });
});
