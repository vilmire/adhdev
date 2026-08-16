/**
 * REFINE-RESUME-SCAN — the boot-time pass that reconciles refine dispatches the
 * ledger never closed in the LIVE set.
 *
 * Extracted from router-refine.ts (pure move, no behavior change) to keep that
 * file under the repo file-size gate. The classification itself is pure and lives
 * in mesh/mesh-refine-zombie-sweep.ts; this module is the I/O shell that reads the
 * ledger, resolves mesh membership, and drives ledger writes / event emission /
 * job spawning through the router.
 */

import type { DaemonCommandRouter } from './router.js';
import { LOG } from '../logging/logger.js';
import { meshNodeIdMatches } from '@adhdev/mesh-shared';
import { resolveTunedReconcileMs } from '../mesh/mesh-reconcile-acked-hold.js';
import {
    appendRefineJobLedger,
    buildRefineJobHandle,
    buildRefineJobKey,
    queueRefineJobEvent,
} from './router-refine.js';


// RESUME-DISPATCH-GRACE: an un-terminated `task_dispatched` may still be genuinely
// running elsewhere (e.g. an old/new daemon overlap during an atomic upgrade
// handoff). Resuming it would race a live execution, so a dispatch younger than
// this is skipped this boot pass and reconsidered next boot. 60s mirrors the
// DEAD_TARGET_GRACE_MS precedent in mesh-skip-notify.ts.
function resolveRefineResumeDispatchGraceMs(): number {
    return resolveTunedReconcileMs('MESH_REFINE_RESUME_DISPATCH_GRACE_MS', 60_000, 0, 10 * 60_000);
}

// RESUME-ZOMBIE-CUTOFF: a dispatch this old has outlived any plausible single-run
// refine, so it is not treated as a job mid-flight — it is closed out via a
// synthetic task_failed entry rather than resumed forever (once per boot).
//
// ★CORRECTION (2026-08-16): this comment used to assert that such a dispatch "is an
// orphan the ledger never closed". That is FALSE, and believing it sends the next
// reader looking for a missing writer that does not exist. In the observed case the
// ledger DID close all five jobs — within 1–4 minutes of dispatch — and the terminal
// rows were later archived out of the live store by compactLedger while the dispatch
// rows (never archivable) stayed. The reader, which only replays the live set, then
// saw dispatch-with-no-terminal and reported a week-old completed job as a zombie.
// Because the archive window (7d) is wider than this cutoff (24h), that asymmetry
// made the false positive structural for any job key that lives long enough.
// mesh-ledger.ts now keeps the pair atomic (B) and records archived terminal keys
// (A) so the reader can still see the closure; passing the cutoff no longer implies
// "the ledger never closed it", only "the live set holds no terminal row for it".
function resolveRefineResumeZombieCutoffMs(): number {
    return resolveTunedReconcileMs('MESH_REFINE_RESUME_ZOMBIE_CUTOFF_MS', 24 * 60 * 60_000, 5 * 60_000, 30 * 24 * 60 * 60_000);
}

    /**
     * On daemon restart, scan all mesh ledgers for refine jobs that were dispatched
     * but never completed/failed (i.e. the daemon died mid-job). Re-queue each one,
     * PRESERVING the original jobId (JOBID-RESUME-PRESERVE) so its terminal event
     * closes out the job the coordinator is waiting on — minting a fresh jobId left
     * the original un-terminated forever (zombie re-resume every boot) while a
     * second execution raced the coordinator's already-converged view (ghost
     * dispatch). A dispatch younger than resolveRefineResumeDispatchGraceMs() is
     * skipped this pass (may be genuinely running elsewhere); older than
     * resolveRefineResumeZombieCutoffMs() is closed out as failed, not resumed.
     */
export async function resumePendingRefineJobsOnStartup(self: DaemonCommandRouter): Promise<void> {
        try {
            const { listMeshes, getMesh } = await import('../config/mesh-config.js');
            const { readLedgerEntries, readArchivedTerminalKeys } = await import('../mesh/mesh-ledger.js');
            const { selectOpenRefineDispatches, classifyRefineDispatch } = await import('../mesh/mesh-refine-zombie-sweep.js');
            const meshIds: string[] = listMeshes().map(m => m.id).filter(Boolean) as string[];
            const nowMs = Date.now();
            const dispatchGraceMs = resolveRefineResumeDispatchGraceMs();
            const zombieCutoffMs = resolveRefineResumeZombieCutoffMs();
            for (const meshId of meshIds) {
                const entries = readLedgerEntries(meshId, { kind: ['task_dispatched', 'task_completed', 'task_failed'] });

                // ARCHIVE-TERMINAL-KEY-INDEX (A): a job whose terminal row was archived
                // out of the live set is closed, not open — consult the sidecar index so
                // rows stranded by the old asymmetric archive policy are not re-read as
                // zombies. Absent index → empty set → previous behavior.
                const archivedTerminalKeys = readArchivedTerminalKeys(meshId);

                // NODE-EXISTENCE (D): resolve the mesh's live node list ONCE per mesh.
                // Compared via meshNodeIdMatches, never raw ===, because node ids appear
                // in several spellings (see the canon-identity defect class) and a raw
                // miss here would wrongly classify a live node as removed and close out
                // a real in-flight job.
                const meshNodes: any[] = (() => {
                    try {
                        const nodes = getMesh(meshId)?.nodes;
                        return Array.isArray(nodes) ? nodes : [];
                    } catch { return []; }
                })();
                // A mesh whose node list is unreadable/empty must NOT make every job look
                // removed — fail open (treat nodes as existing) so an unrelated config
                // read failure cannot mass-close live work.
                const nodeExists = (nodeId: string): boolean =>
                    meshNodes.length === 0 || meshNodes.some((n: any) => meshNodeIdMatches(n, nodeId));

                const openDispatches = selectOpenRefineDispatches(entries, archivedTerminalKeys);
                for (const record of openDispatches) {
                    const decision = classifyRefineDispatch(record, {
                        nowMs,
                        graceMs: dispatchGraceMs,
                        zombieCutoffMs,
                        nodeExists,
                        isRunning: (nodeId: string) => self.runningRefineJobs.has(buildRefineJobKey(self, meshId, nodeId)),
                    });
                    if (!decision) continue;

                    const { nodeId, jobId, ageMs } = decision;
                    const sourceEntry = entries.find(e =>
                        e.kind === 'task_dispatched'
                        && e.nodeId === nodeId
                        && (e.payload as any)?.refineJob?.jobId === jobId);
                    const node = (sourceEntry?.payload as any)?.refineJob;
                    const coordinatorDaemonId = node?.targetCoordinatorDaemonId;
                    const coordinatorSessionId = node?.targetCoordinatorSessionId;
                    const dispatchedAt = sourceEntry?.timestamp ?? record.timestamp;

                    if (decision.disposition === 'defer_grace') {
                        // RESUME-DISPATCH-GRACE: too young to safely assume the original
                        // process is dead — skip this boot pass, reconsider next boot.
                        LOG.info('Mesh', `[Refinery] Deferring resume of refine job for node ${nodeId} (jobId=${jobId}) — `
                            + `dispatched ${ageMs}ms ago, within the ${dispatchGraceMs}ms grace window; may still be running.`);
                        continue;
                    }

                    if (decision.disposition === 'close_removed_node' || decision.disposition === 'close_stale') {
                        const removedNode = decision.disposition === 'close_removed_node';
                        const zombieHandle = buildRefineJobHandle(self, {
                            meshId,
                            nodeId,
                            jobId,
                            interactionId: typeof node?.interactionId === 'string' ? node.interactionId : undefined,
                            status: 'failed',
                            startedAt: typeof node?.startedAt === 'string' ? node.startedAt : dispatchedAt,
                            completedAt: new Date().toISOString(),
                            coordinatorDaemonId,
                            coordinatorSessionId,
                        });
                        const zombieResult = removedNode
                            // NODE-EXISTENCE (D): the target node was removed
                            // (mesh_remove_node / worktree retention) while its dispatch row
                            // stayed behind. Re-running is impossible and there is no
                            // actionable follow-up, so this is pure bookkeeping.
                            ? {
                                success: false,
                                code: 'resume_abandoned_removed_node',
                                error: `Refine job dispatched at ${dispatchedAt} targets node ${nodeId}, which is no longer a `
                                    + `member of mesh ${meshId}; closed out without resuming.`,
                            }
                            : {
                                success: false,
                                code: 'resume_abandoned_stale_dispatch',
                                error: `Refine job dispatched at ${dispatchedAt} has no terminal entry in the live ledger and `
                                    + `exceeded the ${zombieCutoffMs}ms zombie cutoff on daemon restart; closed out without resuming.`,
                            };
                        LOG.warn('Mesh', removedNode
                            ? `[Refinery] Closing out refine job for removed node ${nodeId} (jobId=${jobId}) as failed — `
                                + `node is no longer in mesh ${meshId}; not resuming.`
                            : `[Refinery] Closing out stale refine job for node ${nodeId} (jobId=${jobId}) as failed — `
                                + `dispatched ${ageMs}ms ago, past the ${zombieCutoffMs}ms zombie cutoff with no terminal entry in `
                                + `the live ledger; not resuming.`);
                        await appendRefineJobLedger(self, 'task_failed', zombieHandle, zombieResult);
                        queueRefineJobEvent(self, 'refine:failed', zombieHandle, zombieResult);
                        continue;
                    }

                    LOG.info('Mesh', `[Refinery] Auto-resuming interrupted refine job for node ${nodeId} (jobId=${jobId})`);
                    const { startMeshRefineJob } = await import('./router-refine.js');
                    void startMeshRefineJob(self, meshId, nodeId, {
                        jobId,
                        coordinatorDaemonId,
                        coordinatorSessionId,
                    });
                }
            }
        } catch (e: any) {
            LOG.warn('Mesh', `[Refinery] resumePendingRefineJobsOnStartup failed: ${e?.message || e}`);
        }
    }
