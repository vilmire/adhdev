/** Physical stage-input retention admission, including unregistered chunks and recovery journals. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { StageDiffBlocked, STAGE_DIFF_MAX_BYTES } from './stage-diff-manifest.js';

// Existing artifact contracts, mirrored here because mesh cannot value-import artifacts.
const METADATA_BUDGET = 64 * 1024 * 1024, ROW_FLOOR = 4096, FREE_RESERVE = 64 * 1024 * 1024;

/** Synchronous check+publish callers cannot interleave on the host event loop. No evidence is pruned. */
export function assertStageDiffRetentionGrowth(root: string, deltaBytes: number, deltaEntries = 1): void {
    let bytes = 0, entries = 0;
    const pending = [root];
    while (pending.length) {
        const directory = pending.pop()!;
        if (!fs.existsSync(directory)) continue;
        if (fs.realpathSync.native(directory) !== directory || fs.lstatSync(directory).isSymbolicLink()) throw new StageDiffBlocked('review_diff_retention_path', { directory });
        const handle = fs.opendirSync(directory);
        try { for (;;) {
            const entry = handle.readSync();
            if (!entry) break;
            const file = path.join(directory, entry.name), st = fs.lstatSync(file);
            entries++;
            if (entries * ROW_FLOOR > METADATA_BUDGET) throw new StageDiffBlocked('artifact_storage_budget_exceeded', { scope: 'stage_retention_metadata', entries, limitBytes: METADATA_BUDGET });
            if (st.isSymbolicLink()) throw new StageDiffBlocked('review_diff_retention_path', { file });
            if (st.isDirectory()) pending.push(file);
            else if (st.isFile() && st.nlink === 1) bytes += st.size;
            else throw new StageDiffBlocked('review_diff_retention_path', { file });
        } } finally { handle.closeSync(); }
    }
    if (bytes + deltaBytes > STAGE_DIFF_MAX_BYTES || (entries + deltaEntries) * ROW_FLOOR > METADATA_BUDGET) throw new StageDiffBlocked('artifact_storage_budget_exceeded', {
        scope: 'stage_retention', currentBytes: bytes, deltaBytes, limitBytes: STAGE_DIFF_MAX_BYTES, entries,
    });
    let ancestor = root;
    while (!fs.existsSync(ancestor) && path.dirname(ancestor) !== ancestor) ancestor = path.dirname(ancestor);
    if (fs.realpathSync.native(ancestor) !== ancestor) throw new StageDiffBlocked('review_diff_retention_path', { ancestor });
    const disk = fs.statfsSync(ancestor);
    if (disk.bavail * disk.bsize - deltaBytes < FREE_RESERVE) throw new StageDiffBlocked('artifact_storage_budget_exceeded', {
        scope: 'stage_free_reserve', deltaBytes, freeBytes: disk.bavail * disk.bsize, reserveBytes: FREE_RESERVE,
    });
}
