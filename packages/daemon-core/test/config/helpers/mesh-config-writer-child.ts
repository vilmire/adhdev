/**
 * Child-process writer for mesh-config-write-lock.test.ts.
 *
 * Each invocation appends CHILD_COUNT nodes named `node_${CHILD_TAG}_${i}` to
 * the mesh CHILD_MESH_ID in the meshes.json under ADHDEV_CONFIG_DIR, using the
 * REAL addNode — the unit under test. Several of these children are spawned
 * concurrently against the SAME file to reproduce the cross-process
 * read-modify-write race (last-writer-wins whole-file overwrite).
 */
import { addNode } from '../../../src/config/mesh-config.js';

const meshId = process.env.CHILD_MESH_ID;
const tag = process.env.CHILD_TAG;
const count = Number(process.env.CHILD_COUNT || '0');
if (!meshId || !tag || !count) {
    console.error('CHILD_MESH_ID / CHILD_TAG / CHILD_COUNT required');
    process.exit(2);
}

for (let i = 0; i < count; i++) {
    const node = addNode(meshId, {
        id: `node_${tag}_${i}`,
        workspace: `/tmp/mesh-config-lock-test/${tag}/${i}`,
    });
    if (!node) {
        console.error(`addNode returned undefined for mesh ${meshId}`);
        process.exit(3);
    }
}
console.log(`child ${tag}: wrote ${count} nodes`);
