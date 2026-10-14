/** Authenticated, metadata-only local actor observation. This is not a drain,
 * lifecycle, installer or release authority. No ordinary IPC trust is assumed. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { getConfigDir } from '../config/config.js';
import { readCooperativeMaintenance, maintenanceHeld, MAINTENANCE_BOOT_NONCE } from './cooperative-gate.js';
import type { CliRestoreHost } from '../commands/cli-manager-restore.js';
import { observeHeldHostedSessions } from './held-observation.js';

export const ACTOR_CONFIG_FILE = 'cooperative-maintenance-actor.json';
const used = new Map<string, number>();
const hash = (s: Buffer | string) => createHash('sha256').update(s).digest('hex');
function privateFile(file: string): Buffer {
    const s = fs.lstatSync(file);
    if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || s.size > 256 * 1024 || (s.mode & 0o077) || (process.getuid && s.uid !== process.getuid()) || fs.realpathSync(file) !== file) throw new Error('maintenance_actor_private_pin_required');
    return fs.readFileSync(file);
}
export interface ActorObservationChallenge {
    schema: 1; operation: 'observe' | 'drain' | 'mcp_poll' | 'mcp_reply' | 'control'; daemonId: string; planDigest: string; epoch: number;
    nonce: string; sentAt: number; configSha256: string; mac: string; body?: unknown; bodyDigest?: string;
}
export function actorObservationChallengeBytes(r: Omit<ActorObservationChallenge, 'mac'>): string {
    return JSON.stringify([r.schema,r.operation,r.daemonId,r.planDigest,r.epoch,r.nonce,r.sentAt,r.configSha256,...(r.bodyDigest === undefined ? [] : [r.bodyDigest])]);
}
/** Secret provisioned separately for this maintenance plan. Never derived from
 * owner credentials, peer tokens or any strict bridge journal. */
export function authorizeMaintenanceCollection(request: ActorObservationChallenge, operation: ActorObservationChallenge['operation'], {allowOpen=false}: {allowOpen?:boolean}={}) {
    const state = readCooperativeMaintenance(), root = fs.realpathSync(getConfigDir());
    if (!state?.actorConfigSha256 || (!allowOpen && !maintenanceHeld())) throw new Error('maintenance_actor_enrollment_required');
    const bytes = privateFile(path.join(root,ACTOR_CONFIG_FILE));
    if (hash(bytes) !== state.actorConfigSha256 || request?.configSha256 !== state.actorConfigSha256) throw new Error('maintenance_actor_config_changed');
    const config = JSON.parse(bytes.toString('utf8'));
    if (config.schema !== 1 || config.daemonId !== state.daemonId || config.rolloutId !== state.rolloutId || config.configDir !== root) throw new Error('maintenance_actor_scope_changed'); // canon-ok: the config bytes are sha256-pinned to state.actorConfigSha256 just above, so this field is sealed content that must match byte-exactly — canonicalizing would accept a pinned config naming a different id form than the enrolled state
    const key = privateFile(config.observationKey?.path);
    if (key.length !== 32 || hash(key) !== config.observationKey?.sha256) throw new Error('maintenance_actor_key_changed');
    if (request.schema !== 1 || request.operation !== operation || request.daemonId !== state.daemonId || request.planDigest !== state.planDigest || request.epoch !== state.epoch // canon-ok: request.daemonId is element 3 of actorObservationChallengeBytes(), whose HMAC is timingSafeEqual-verified below — the field must equal the exact bytes that were authenticated, so canonicalizing would admit a challenge whose MAC'd id differs from the enrolled one
        || !/^[a-f0-9-]{36}$/.test(request.nonce) || !Number.isSafeInteger(request.sentAt) || Math.abs(Date.now()-request.sentAt) > 10_000
        || !/^[a-f0-9]{64}$/.test(request.mac)) throw new Error('maintenance_actor_challenge_invalid');
    if ((request.body !== undefined || request.bodyDigest !== undefined) && (request.bodyDigest !== hash(JSON.stringify(request.body)) || JSON.stringify(request.body).length > 256*1024)) throw new Error('maintenance_collection_body_invalid');
    const expected = createHmac('sha256',key).update(actorObservationChallengeBytes(request)).digest();
    if (!timingSafeEqual(expected,Buffer.from(request.mac,'hex'))) throw new Error('maintenance_actor_authentication_required');
    for (const [nonce,at] of used) if (Date.now()-at > 20_000) used.delete(nonce);
    const replayKey = `${root}:${request.nonce}`;
    if (used.has(replayKey) || used.size >= 4096) throw new Error('maintenance_actor_challenge_replayed');
    used.set(replayKey,Date.now());
    return {state,config,root,reply(fields: Record<string,unknown>, expectedState=state) {
        if (hash(privateFile(config.observationKey.path)) !== config.observationKey.sha256 || hash(privateFile(path.join(root,ACTOR_CONFIG_FILE))) !== request.configSha256 || JSON.stringify(readCooperativeMaintenance()) !== JSON.stringify(expectedState)) throw new Error('maintenance_actor_scope_changed');
        const reply = {...fields,schema:1,nonce:request.nonce,planDigest:expectedState.planDigest,epoch:expectedState.epoch,daemonId:expectedState.daemonId,bootNonce:MAINTENANCE_BOOT_NONCE,
            pid:process.pid,nodePath:process.execPath,entryPath:process.argv[1],observedAt:Date.now()};
        return {success:true,reply,mac:createHmac('sha256',key).update(JSON.stringify(reply)).digest('hex')};
    }};
}
export async function authenticatedActorObservation(host: CliRestoreHost, request: ActorObservationChallenge) {
    const auth=authorizeMaintenanceCollection(request,'observe');
    const observation=await observeHeldHostedSessions(host,request.nonce);
    return auth.reply({observation});
}
