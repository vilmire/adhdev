/** Held metadata restoration. No ordinary adapter/instance or lifecycle bus is
 * constructed here. A local continuity receipt is not fleet release authority. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getConfigDir } from '../config/config.js';
import { createHash } from 'node:crypto';
import { SessionHostClient, type SessionHostRecord } from '@adhdev/session-host-core';
import { daemonIdsEquivalent } from '@adhdev/mesh-shared';
import { MAINTENANCE_BOOT_NONCE, withMaintenanceObservation, readCooperativeMaintenance, assertMaintenanceAdmission, type CooperativeMaintenance } from './cooperative-gate.js';
import { listCoordinatorsForMesh } from '../mesh/coordinator-registry.js';
import type { CliRestoreHost } from '../commands/cli-manager-restore.js';
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const text = (v: unknown): string => typeof v === 'string' ? v.trim() : '';

/** Fresh metadata, never a missing/unreadable file silently served from the
 * startup registry cache. An observed absence is not coordinator readiness. */
function freshCoordinators(state: CooperativeMaintenance) {
    const select = (e: any) => ({sessionId:e.sessionId,meshId:e.meshId,workspace:e.workspace,cliType:e.cliType,startedAt:e.startedAt});
    const cached = state.meshIds.flatMap(meshId=>listCoordinatorsForMesh(meshId)).map(select).sort((a,b)=>a.sessionId.localeCompare(b.sessionId));
    const file = path.join(getConfigDir(),'daemon','mesh-coordinators.json');
    let entries: any[];
    try {
        const stat=fs.lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4*1024*1024) throw new Error('maintenance_coordinator_inventory_unavailable');
        const raw:unknown=JSON.parse(fs.readFileSync(file,'utf8'));
        if (!Array.isArray(raw)) throw new Error('maintenance_coordinator_inventory_unavailable');
        entries=raw;
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT' || cached.length) throw new Error('maintenance_coordinator_inventory_unavailable',{cause:e});
        entries=[];
    }
    if (entries.some(e=>!e || !text(e.sessionId) || !state.meshIds.includes(e.meshId) || !text(e.workspace) || !text(e.cliType) || !Number.isSafeInteger(e.startedAt) || e.startedAt <= 0)
        || new Set(entries.map(e=>e.sessionId)).size !== entries.length) throw new Error('maintenance_coordinator_inventory_unavailable');
    const selected=entries.map(select).sort((a,b)=>a.sessionId.localeCompare(b.sessionId));
    if (JSON.stringify(selected) !== JSON.stringify(cached)) throw new Error('maintenance_coordinator_inventory_changed');
    return selected;
}

export function retainedRuntimeInventory(records: SessionHostRecord[], state: CooperativeMaintenance) {
    if (!Array.isArray(records) || new Set(records.map(r => r.sessionId)).size !== records.length) throw new Error('maintenance_complete_inventory_required');
    if (new Set(records.map(r=>r.osPid)).size !== records.length || new Set(records.map(r=>JSON.stringify([r.providerType,r.workspace,text(r.meta?.providerSessionId)]))).size !== records.length) throw new Error('maintenance_ambiguous_runtime_binding');
    const coordinatorInventory = freshCoordinators(state);
    return records.map(r => {
        if (!text(r.sessionId) || !text(r.providerType) || !text(r.workspace) || !r.meta || !Number.isSafeInteger(r.startedAt) || !r.startedAt || r.startedAt > Date.now() || !Number.isSafeInteger(r.osPid) || r.osPid! <= 0
            || r.category !== 'cli' || r.lifecycle !== 'running' || !text(r.meta.providerSessionId)) throw new Error('maintenance_runtime_inventory_incomplete');
        const meshId = text(r.meta.meshNodeFor), nodeId = text(r.meta.meshNodeId);
        // Local runtime ownership: the session-host record was stamped by this
        // machine's own runtime, which may name it in any equivalent id form.
        const runtimeOwner = text(r.meta.daemonId);
        if (runtimeOwner && !daemonIdsEquivalent(runtimeOwner, state.daemonId)) throw new Error('maintenance_unknown_runtime_owner');
        if ((meshId || nodeId) && !state.nodeRoster.some(n => n.meshId === meshId && n.nodeId === nodeId && n.daemonId === state.daemonId)) throw new Error('maintenance_unknown_runtime_owner'); // canon-ok: the nodeRoster side is the pinned raw roster that maintenanceDecisionDigest() hashes, so this entry must be the exact digested one; the record's own owner id is normalized on the line above
        const entry = coordinatorInventory.find(e=>e.sessionId===r.sessionId);
        const coordinatorMeshId = text(entry?.meshId);
        if (!text(r.meta.daemonId) && !meshId && !coordinatorMeshId) throw new Error('maintenance_unknown_runtime_owner');
        if (entry && (!Number.isFinite(entry.startedAt) || entry.startedAt <= 0 || !state.meshIds.includes(coordinatorMeshId) || entry.workspace !== r.workspace || entry.cliType !== r.providerType)) throw new Error('maintenance_coordinator_binding_drift');
        if (text(r.meta.meshCoordinatorFor) && r.meta.meshCoordinatorFor !== coordinatorMeshId) throw new Error('maintenance_coordinator_binding_missing');
        const workOwner = text(r.meta.meshCoordinatorDaemonId);
        if (workOwner && !state.roster.includes(workOwner)) throw new Error('maintenance_unknown_runtime_owner');
        return { runtimeId:r.sessionId, providerType:r.providerType, providerSessionId:text(r.meta.providerSessionId), workspace:r.workspace,
            startedAt:r.startedAt, pid:r.osPid!, daemonId:state.daemonId, meshId, nodeId, coordinatorMeshId, coordinatorRegisteredAt:entry?.startedAt ?? null, workOwner, ownerSource:text(r.meta.daemonId)?'native_record':meshId?'enrolled_node':'coordinator_registry' };
    }).sort((a,b) => a.runtimeId.localeCompare(b.runtimeId));
}
export const retainedRuntimeInventoryDigest = (records: SessionHostRecord[], state: CooperativeMaintenance) => digest(retainedRuntimeInventory(records, state));

const observed = new WeakMap<CliRestoreHost, {epoch:number;bootNonce:string;inventoryDigest:string;receipt:string;observation?:unknown;sessions:ReturnType<typeof retainedRuntimeInventory>}>();

export async function observeHeldHostedSessions(host: CliRestoreHost, challenge: string) {
    if (!text(challenge) || challenge.length > 256) throw new Error('maintenance_observation_challenge_required');
    return withMaintenanceObservation(async state => {
        const registry = host.deps.getSessionRegistry?.();
        if (!registry || !host.deps.verifiedRetainedEndpoint) throw new Error('maintenance_verified_endpoint_required');
        const endpoint = await host.deps.verifiedRetainedEndpoint();
        if (endpoint.path !== state.retainedHost.endpoint) throw new Error('maintenance_retained_endpoint_drift');
        // Explicit endpoint only. Never use the default endpoint or ensureReady
        // fallback/retry path inside an ordinary runtime transport.
        const client = new SessionHostClient({endpoint});
        try {
            await client.connect();
            const list = async () => {
                const reply = await client.request<SessionHostRecord[]>({type:'list_sessions',payload:{}});
                if (!reply.success || !Array.isArray(reply.result)) throw new Error('maintenance_complete_inventory_required');
                return reply.result;
            };
            const records = await list(), inventory = retainedRuntimeInventory(records,state);
            if (digest(inventory) !== state.retainedHost.sessionSetDigest) throw new Error('maintenance_retained_inventory_drift');
            for (const record of records) {
                if (record.meta.managedBy !== host.deps.hostedRuntimeManagerTag || host.providerLoader.getMeta(record.providerType)?.category !== 'cli') throw new Error('maintenance_unknown_runtime_provider');
            }
            // No workspace fallback, inferred coordinator, or pruning. Every
            // persisted local coordinator must have its exact native runtime.
            const coordinators = state.meshIds.flatMap(meshId => {
                const expected = listCoordinatorsForMesh(meshId);
                if (expected.length > 1) throw new Error('maintenance_coordinator_binding_missing_or_ambiguous');
                if (!expected.length) return []; // remote coordinator must be observed on its own daemon in the fleet join
                const actual = inventory.filter(r => r.coordinatorMeshId === meshId && r.runtimeId === expected[0].sessionId);
                if (actual.length !== 1) throw new Error('maintenance_coordinator_binding_missing_or_ambiguous');
                return actual;
            });
            for (const r of records) {
                const clientId = `maintenance-observer:${state.daemonId}:${MAINTENANCE_BOOT_NONCE}`;
                const reply = await client.request<SessionHostRecord>({type:'attach_session',payload:{sessionId:r.sessionId,clientId,clientType:'daemon',readOnly:true}});
                if (!reply.result?.attachedClients?.some(c=>c.clientId===clientId && c.readOnly===true) || JSON.stringify(reply.result.writeOwner) !== JSON.stringify(r.writeOwner)) throw new Error('maintenance_readonly_attach_required');
                if (!reply.success || !reply.result || digest(retainedRuntimeInventory([reply.result],state)[0]) !== digest(inventory.find(x=>x.runtimeId===r.sessionId))) throw new Error('maintenance_observation_attach_drift');
            }
            if (digest(retainedRuntimeInventory(await list(),state)) !== digest(inventory)) throw new Error('maintenance_retained_inventory_drift');
            const finalEndpoint = await host.deps.verifiedRetainedEndpoint();
            if (finalEndpoint.path !== endpoint.path) throw new Error('maintenance_retained_endpoint_drift');
            if (digest(retainedRuntimeInventory(records,state)) !== digest(inventory)) throw new Error('maintenance_coordinator_binding_drift');
            // Commit only the complete validated batch. This emits no registered,
            // binding, turn, transcript or cleanup callbacks and preserves any
            // metadata absent from an incomplete/unreachable inventory.
            for (const r of inventory) registry.registerObservation({sessionId:r.runtimeId,parentSessionId:null,providerType:r.providerType,transport:'pty',workspace:r.workspace,
                spawnedAtMs:r.startedAt,providerSessionId:r.providerSessionId || undefined,
                maintenanceObservation:{observedAt:Date.now(),epoch:state.epoch,bootNonce:MAINTENANCE_BOOT_NONCE,meshId:r.coordinatorMeshId || r.meshId || undefined,nodeId:r.nodeId || undefined,daemonId:state.daemonId,coordinator:!!r.coordinatorMeshId}});
            const bindings = inventory.map(r=>{
                const binding = registry.get(r.runtimeId);
                if (!binding?.maintenanceObservation) throw new Error('maintenance_observation_binding_missing');
                return {sessionId:binding.sessionId,providerType:binding.providerType,providerSessionId:binding.providerSessionId,
                    workspace:binding.workspace,spawnedAtMs:binding.spawnedAtMs,maintenanceObservation:binding.maintenanceObservation};
            });
            const proof = {challenge,epoch:state.epoch,bootNonce:MAINTENANCE_BOOT_NONCE,planDigest:state.planDigest,artifactSha256:state.targetSha256,daemonId:state.daemonId,
                endpoint:endpoint.path,hostPid:state.retainedHost.pid,hostBirth:state.retainedHost.birth,observedAt:Date.now(),sessions:inventory,coordinators,bindings};
            const receipt = digest(proof);
            observed.set(host,{epoch:state.epoch,bootNonce:MAINTENANCE_BOOT_NONCE,inventoryDigest:digest(inventory),receipt,observation:{...proof,receipt},sessions:inventory});
            return {...proof,receipt};
        } finally { await client.close().catch(()=>{}); }
    });
}

/** Join actual per-daemon observations, never a caller's coordinator boolean.
 * The external native driver must collect these on the authenticated pinned
 * fleet routes; a receipt hash is integrity binding, not a signature. */
export function verifyHeldObservationFleet(observations: Awaited<ReturnType<typeof observeHeldHostedSessions>>[], state: CooperativeMaintenance, challenge: string) {
    if (!text(challenge)) throw new Error('maintenance_observation_challenge_required');
    if (state.phase === 'open') throw new Error('maintenance_held_observation_required');
    const sessions = observations.flatMap(p=>p.sessions);
    if (new Set(sessions.map(r=>r.runtimeId)).size !== sessions.length) throw new Error('maintenance_ambiguous_runtime_binding');
    if (observations.length !== state.roster.length || new Set(observations.map(p=>p.daemonId)).size !== state.roster.length) throw new Error('maintenance_observation_fleet_incomplete');
    for (const p of observations) {
        const {receipt,...proof} = p;
        if (!state.roster.includes(p.daemonId) || p.challenge !== challenge || p.epoch !== state.epoch || p.planDigest !== state.planDigest || p.artifactSha256 !== state.targetSha256 || !text(p.bootNonce) || !Number.isFinite(p.observedAt) || p.observedAt <= 0 || p.observedAt > Date.now() || Date.now()-p.observedAt > 10_000 || digest(proof) !== receipt) throw new Error('maintenance_observation_fleet_stale'); // canon-ok: p.daemonId is inside `proof`, whose digest must equal the receipt on this same line, and line 136 already requires one UNIQUE observation per raw roster entry — expanding forms would collapse that per-entry cardinality and void the receipt binding
        if (p.bindings.length !== p.sessions.length || new Set(p.bindings.map(b=>b.sessionId)).size !== p.sessions.length) throw new Error('maintenance_observation_binding_missing');
        for (const r of p.sessions) {
            const binding = p.bindings.find(b=>b?.sessionId===r.runtimeId);
            if (r.daemonId !== p.daemonId || binding?.maintenanceObservation?.daemonId !== p.daemonId || binding.maintenanceObservation.bootNonce !== p.bootNonce || binding.maintenanceObservation.epoch !== p.epoch) throw new Error('maintenance_observation_binding_missing'); // canon-ok: both sides live inside the one receipt-digested observation verified above, so the session row and its binding must carry that proof's exact id — a normalized match would let a binding from a different stamping pass as this proof's
            if (binding.providerType !== r.providerType || binding.providerSessionId !== r.providerSessionId || binding.workspace !== r.workspace || binding.spawnedAtMs !== r.startedAt
                || binding.maintenanceObservation.meshId !== (r.coordinatorMeshId || r.meshId || undefined) || binding.maintenanceObservation.nodeId !== (r.nodeId || undefined) || binding.maintenanceObservation.coordinator !== !!r.coordinatorMeshId) throw new Error('maintenance_observation_binding_missing');
            if (r.coordinatorMeshId && !state.meshIds.includes(r.coordinatorMeshId)) throw new Error('maintenance_unknown_runtime_owner');
            if ((r.meshId || r.nodeId) && !state.nodeRoster.some(n=>n.meshId===r.meshId && n.nodeId===r.nodeId && n.daemonId===p.daemonId)) throw new Error('maintenance_unknown_runtime_owner'); // canon-ok: joins the receipt-digested observation's id to the pinned raw nodeRoster that the decision digest hashes, so the entry must be the exact digested one
        }
    }
    const coordinators = observations.flatMap(p=>p.coordinators);
    for (const meshId of state.meshIds) {
        const found=coordinators.filter(r=>r.coordinatorMeshId===meshId);
        if (found.length !== 1 || !observations.some(p=>p.daemonId===found[0].daemonId && p.sessions.some(r=>JSON.stringify(r)===JSON.stringify(found[0])))) throw new Error('maintenance_coordinator_binding_missing_or_ambiguous'); // canon-ok: requires the sole coordinator row to appear verbatim (JSON-identical) inside the receipt-digested observation that declares that exact id — the whole point is an unambiguous exact-bytes attribution, which normalization would blur
    }
    for (const p of observations) for (const r of p.sessions) {
        if (r.meshId && r.workOwner !== coordinators.find(c=>c.coordinatorMeshId===r.meshId)?.daemonId) throw new Error('maintenance_coordinator_route_drift');
    }
    return {challenge,epoch:state.epoch,planDigest:state.planDigest,boots:observations.map(p=>({daemonId:p.daemonId,bootNonce:p.bootNonce,receipt:p.receipt})),coordinators};
}

/** Called inside the released admission lease immediately before ordinary
 * writable attach. No observation can itself authorize promotion. */
export async function verifyHeldObservationPromotion(host: CliRestoreHost, session?: {runtimeId:string;providerType:string;workspace:string;providerSessionId?:string;startedAt?:number;binding?:{meshId:string;nodeId:string;coordinatorMeshId:string;workOwner:string}}) {
    const state = readCooperativeMaintenance();
    if (!state) return;
    assertMaintenanceAdmission();
    const proof = observed.get(host);
    if (!proof || proof.epoch !== state.epoch || proof.bootNonce !== MAINTENANCE_BOOT_NONCE || state.release?.ready.find(r=>r.daemonId===state.daemonId)?.receipt !== proof.receipt) throw new Error('maintenance_fresh_observation_required'); // canon-ok: fetches this state's OWN validated release row to compare its frozen receipt against the in-memory proof; validateCooperativeMaintenance already proved one unique row per raw roster entry, so the lookup must use that exact key
    if (!host.deps.verifiedRetainedEndpoint) throw new Error('maintenance_verified_endpoint_required');
    const endpoint = await host.deps.verifiedRetainedEndpoint();
    if (endpoint.path !== state.retainedHost.endpoint) throw new Error('maintenance_retained_endpoint_drift');
    const client = new SessionHostClient({endpoint});
    try {
        await client.connect();
        const reply = await client.request<SessionHostRecord[]>({type:'list_sessions',payload:{}});
        if (!reply.success || !Array.isArray(reply.result) || digest(retainedRuntimeInventory(reply.result,state)) !== proof.inventoryDigest) throw new Error('maintenance_retained_inventory_drift');
        const actual = session && proof.sessions.find(r=>r.runtimeId===session.runtimeId);
        // The writable constructor stamps this ID into native runtime metadata.
        // Bind it before construction; held inventory already requires a known ID.
        if (session && (!actual || actual.providerSessionId !== session.providerSessionId || actual.providerType !== session.providerType || actual.workspace !== session.workspace || actual.startedAt !== session.startedAt)) throw new Error('maintenance_promotion_binding_drift');
        if (session?.binding && actual && Object.entries(session.binding).some(([key,value])=>actual[key as keyof typeof actual] !== value)) throw new Error('maintenance_promotion_binding_drift');
        assertMaintenanceAdmission();
        return proof.sessions;
    } finally { await client.close().catch(()=>{}); }
}

/** Rechallenge native inventory without replacing the prepared observation used
 * by writable promotion. An inspect after prepare must not launder its receipt. */
export async function verifyPreparedObservation(host: CliRestoreHost, receipt:string) {
    const state=readCooperativeMaintenance(),p=observed.get(host);
    if(!state||!p||p.epoch!==state.epoch||p.bootNonce!==MAINTENANCE_BOOT_NONCE||p.receipt!==receipt||!p.observation||!host.deps.verifiedRetainedEndpoint)throw Error('maintenance_prepared_observation_lost');
    const endpoint=await host.deps.verifiedRetainedEndpoint();
    if(endpoint.path!==state.retainedHost.endpoint)throw Error('maintenance_retained_endpoint_drift');
    const client=new SessionHostClient({endpoint});
    try{await client.connect();const reply=await client.request<SessionHostRecord[]>({type:'list_sessions',payload:{}});
        if(!reply.success||!Array.isArray(reply.result)||digest(retainedRuntimeInventory(reply.result,state))!==p.inventoryDigest)throw Error('maintenance_retained_inventory_drift');
        const after=await host.deps.verifiedRetainedEndpoint();if(after.path!==endpoint.path||JSON.stringify(readCooperativeMaintenance())!==JSON.stringify(state))throw Error('maintenance_epoch_changed');
        return p.observation as Awaited<ReturnType<typeof observeHeldHostedSessions>>;
    }finally{await client.close().catch(()=>{});}
}
