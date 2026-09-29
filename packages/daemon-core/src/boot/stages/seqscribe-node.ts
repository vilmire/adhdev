/**
 * S4 bootSeqscribeNode — open the daemon's seqscribe node and its node-scoped
 * producers BEFORE the command plane, so the router receives the runtime as a
 * value (wiring-unification B4; replaces the `seqscribeNodeRef` holder).
 *
 * Fail-soft by contract: a DB or native-addon failure yields `seqscribe: null`
 * and the daemon boots without replication.
 */

import { openSeqscribeRuntime } from '../../seqscribe/runtime.js';
import type { SeqscribeNodeStage, SessionCoreStage } from './types.js';

export function bootSeqscribeNode(s3: SessionCoreStage): SeqscribeNodeStage {
    const seqscribe = openSeqscribeRuntime({
        daemonId: s3.cfg.statusInstanceId,
    });
    return { ...s3, seqscribe };
}
