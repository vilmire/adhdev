/**
 * Wire mapping of the host-handoff peer verbs (design §7.6): the arguments each
 * verb carries and the routing of an inbound verb to the right engine. The
 * transport stamps the authenticated sender daemon id; engines additionally
 * require it to be the handoff's recorded peer.
 */

import type { HostHandoffSource } from './source-machine.js';
import type { HostHandoffTarget } from './target-machine.js';
import type { HandoffAckClient, HandoffPeerClient } from './peer.js';
import { HOST_HANDOFF_VERB, type HandoffAck, type PeerResult } from './types.js';

export type PeerDispatch = (daemonId: string, verb: string, args: Record<string, unknown>) => Promise<PeerResult>;

function str(v: unknown): string { return typeof v === 'string' ? v.trim() : ''; }

/** Route one inbound peer verb. Unknown verbs and malformed arguments are refused, never guessed. */
export async function handlePeerVerb(
    engines: { source?: HostHandoffSource; target?: HostHandoffTarget; certificate?: (a: { meshId: string; certificate: unknown }, sender: string) => PeerResult },
    verb: string,
    args: Record<string, unknown>,
    sender: string,
): Promise<PeerResult> {
    const handoffId = str(args.handoffId);
    const meshId = str(args.meshId);
    if (verb === HOST_HANDOFF_VERB.certificate) {
        if (!sender) return { success: false, code: 'wrong_peer', error: 'no authenticated sender' };
        return engines.certificate && meshId ? engines.certificate({ meshId, certificate: args.certificate }, sender) : { success: false, code: 'peer_capability_unconfirmed' };
    }
    if (!sender) return { success: false, code: 'wrong_peer', error: 'no authenticated sender' };
    if (!handoffId || !meshId) return { success: false, code: 'invalid_args', error: 'handoffId and meshId are required' };
    const target = engines.target;
    const source = engines.source;
    switch (verb) {
        case HOST_HANDOFF_VERB.capability:
            return target ? target.capability({ handoffId, meshId, fromDaemonId: str(args.fromDaemonId), launchPlan: args.launchPlan as never }, sender) : { success: false, code: 'peer_capability_unconfirmed' };
        case HOST_HANDOFF_VERB.chunk: {
            if (!target) return { success: false, code: 'peer_capability_unconfirmed' };
            const op = str(args.op);
            if (op === 'manifest') return target.manifest({ handoffId, meshId, manifest: args.manifest as never }, sender);
            if (op === 'chunk') return target.chunk({ handoffId, meshId, seq: Number(args.seq), sha256: str(args.sha256), data: typeof args.data === 'string' ? args.data : '' }, sender);
            if (op === 'seal') return target.seal({ handoffId, meshId }, sender);
            return { success: false, code: 'invalid_args', error: 'op must be manifest, chunk or seal' };
        }
        case HOST_HANDOFF_VERB.ack:
            return source ? source.onAck(args.ack as HandoffAck, sender) : { success: false, code: 'handoff_unknown' };
        case HOST_HANDOFF_VERB.activate:
            return target ? target.activate({ handoffId, meshId, epoch: Number(args.epoch), certificate: args.certificate as never }, sender) : { success: false, code: 'not_staged', applied: false };
        case HOST_HANDOFF_VERB.status:
            return target ? target.status({ handoffId, meshId }, sender) : { success: false, code: 'peer_capability_unconfirmed' };
        case HOST_HANDOFF_VERB.discard:
            return target ? target.discard({ handoffId, meshId }, sender) : { success: true, duplicate: true };
        default:
            return { success: false, code: 'invalid_args', error: `unknown handoff verb ${verb}` };
    }
}

/** Source -> target client over the mesh transport. */
export function createWirePeerClient(dispatch: PeerDispatch, targetDaemonId: string): HandoffPeerClient {
    const send = (verb: string, args: Record<string, unknown>) => dispatch(targetDaemonId, verb, args);
    return {
        capability: (a) => send(HOST_HANDOFF_VERB.capability, a) as never,
        manifest: (a) => send(HOST_HANDOFF_VERB.chunk, { op: 'manifest', ...a }) as never,
        chunk: (a) => send(HOST_HANDOFF_VERB.chunk, { op: 'chunk', ...a }),
        seal: (a) => send(HOST_HANDOFF_VERB.chunk, { op: 'seal', ...a }),
        activate: (a) => send(HOST_HANDOFF_VERB.activate, a) as never,
        status: (a) => send(HOST_HANDOFF_VERB.status, a) as never,
        discard: (a) => send(HOST_HANDOFF_VERB.discard, a),
    };
}

/** Target -> source ACK over the mesh transport. */
export function createWireAckClient(dispatch: PeerDispatch): HandoffAckClient {
    return { ack: (sourceDaemonId, ack) => dispatch(sourceDaemonId, HOST_HANDOFF_VERB.ack, { handoffId: ack.handoffId, meshId: ack.meshId, ack }) };
}
