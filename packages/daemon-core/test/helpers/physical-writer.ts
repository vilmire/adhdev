import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';
import type { MeshWorkQueueEntry } from '../../src/mesh/mesh-work-queue-types.js';
import { attestLocalOwnership } from '../../src/mesh/mesh-physical-ownership.js';

/** A real, disposable Git root: different labels alone never prove isolation. */
export function physicalWriterFixture(workspace: string, nodeId: string, machineId = 'test-machine') {
    mkdirSync(workspace, { recursive: true });
    execFileSync('git', ['init', '-q', workspace], { stdio: 'pipe', timeout: 5_000, windowsHide: true });
    const ownedPaths = { paths: [{ path: 'src/owned.ts', subtree: false }] };
    const ownershipScope = attestLocalOwnership({ repoIdentity: 'fixture/repo', machineId,
        nodeId, workspace, phase: 'source', paths: ownedPaths });
    return { task: { ownedPaths, ownershipScope },
        bind(entry: MeshWorkQueueEntry) {
            // Seed the already-attested physical world at the store fixture boundary.
            // enqueueTask deliberately does not trust caller-supplied attestations.
            MeshRuntimeStore.getInstance().updateQueueEntry({ ...entry, ownedPaths, ownershipScope });
        }, claim: { physicalContext: { workspace: ownershipScope.worktree, machineId } } };
}
