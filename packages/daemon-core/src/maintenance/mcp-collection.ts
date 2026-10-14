/** Actual target MCP request/reply route over its existing daemon transport.
 * Registration is evidence of a participant, never proof of complete native
 * membership. Markers survive restart/disappearance; no retirement or pruning. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { authorizeMaintenanceCollection, type ActorObservationChallenge } from './actor-observation.js';
import type { CooperativeMaintenance } from './cooperative-gate.js';
const sha=(x:unknown)=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
export interface McpIdentity {pid:number;bootNonce:string;birth:string;startedAt:number;entryPath:string;entrySha256:string;nodePath:string;nodeSha256:string}
export function validateMcpIdentity(value:any): McpIdentity {
    if (!value || typeof value.birth!=='string'||!/^\w{3} \w{3} \d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/.test(value.birth)||!Number.isSafeInteger(value.pid)||value.pid<=0||! /^[a-f0-9-]{36}$/.test(value.bootNonce)||!Number.isSafeInteger(value.startedAt)||value.startedAt<=0
        || !path.isAbsolute(value.entryPath??'')||!path.isAbsolute(value.nodePath??'')||![value.entrySha256,value.nodeSha256].every(v=>/^[a-f0-9]{64}$/.test(v))) throw new Error('maintenance_mcp_identity_invalid');
    return {pid:value.pid,bootNonce:value.bootNonce,birth:value.birth,startedAt:value.startedAt,entryPath:value.entryPath,entrySha256:value.entrySha256,nodePath:value.nodePath,nodeSha256:value.nodeSha256};
}
const key=(r:McpIdentity)=>`${r.pid}-${r.bootNonce}`;
export function mcpMarkerDirectory(root:string) {return path.join(root,'cooperative-maintenance-mcp');}
interface Waiting {identity:McpIdentity;nonce:string;epoch:number;resolve:(value:any)=>void;timer:ReturnType<typeof setTimeout>}
const waiting=new Map<string,Waiting>();
export function mcpCollectionPoll(request:ActorObservationChallenge) {
    const auth=authorizeMaintenanceCollection(request,'mcp_poll'), body=request.body as any;
    const identity=validateMcpIdentity(body?.identity), dir=mcpMarkerDirectory(auth.root);
    // The exporter must first write its own durable private marker. This route
    // cannot turn a caller-only PID into an admitted/native process.
    const file=path.join(dir,`${key(identity)}.json`),s=fs.lstatSync(file);
    if(!s.isFile()||s.isSymbolicLink()||(s.mode&0o077)||s.uid!==process.getuid?.())throw new Error('maintenance_mcp_marker_untrusted');
    const marker=JSON.parse(fs.readFileSync(file,'utf8'));
    // eslint-disable-next-line no-restricted-syntax -- canon-ok: scope join against the exporter's own ownership/permission-verified private marker file, where daemonId is sealed content paired with planDigest — it must match the exact bytes this plan wrote, not any equivalent form of the machine
    if(marker.planDigest!==auth.state.planDigest||marker.daemonId!==auth.state.daemonId||sha(validateMcpIdentity(marker.identity))!==sha(identity))throw new Error('maintenance_mcp_marker_changed'); // canon-ok: see eslint-disable reason on the preceding line
    const w=waiting.get(`${auth.root}:${key(identity)}`);
    return auth.reply({challenge:w&&w.epoch===auth.state.epoch?{nonce:w.nonce,epoch:w.epoch}:null});
}
export function mcpCollectionReply(request:ActorObservationChallenge) {
    const auth=authorizeMaintenanceCollection(request,'mcp_reply'),body=request.body as any,identity=validateMcpIdentity(body?.identity);
    const name=`${auth.root}:${key(identity)}`,w=waiting.get(name);
    if(!w||w.epoch!==auth.state.epoch||body.challenge!==w.nonce||sha(identity)!==sha(w.identity))throw new Error('maintenance_mcp_reply_stale');
    // Only the metadata schema from the actual source adapter is admitted. No
    // payloads, credentials, notices text, environment or arbitrary body spread.
    const v=body.inventory;
    if(!v||v.schema!==1||v.pid!==identity.pid||!Array.isArray(v.entries)||!Array.isArray(v.acknowledgments)
        || !Array.isArray(v.temporaryFiles)||!Array.isArray(v.unknownFiles)
        || ![v.activeSubmits,v.pendingNoticeCount,v.quarantinedFileCount].every(n=>Number.isSafeInteger(n)&&n>=0)
        || !['durable','directoryReadable','diskSetMatchesMemory','memoryFallback','flushing','acknowledgmentsDurable'].every(k=>typeof v[k]==='boolean')) throw new Error('maintenance_mcp_inventory_invalid');
    const entries=v.entries.map((e:any)=>{
        if(!/^[A-Za-z0-9_.:-]{8,128}$/.test(e.id)||!['report','progress'].includes(e.kind)||!/^[a-f0-9]{64}$/.test(e.payloadHash)||!Number.isSafeInteger(e.attempts)||e.attempts<0)throw new Error('maintenance_mcp_inventory_invalid');
        return {id:e.id,kind:e.kind,payloadHash:e.payloadHash,attempts:e.attempts,quarantined:!!e.quarantined};
    });
    const acknowledgments=v.acknowledgments.map((a:any)=>{
        if(!/^[A-Za-z0-9_.:-]{8,128}$/.test(a.id)||!['report','progress'].includes(a.kind)||!['receipt','unproven'].includes(a.proof))throw new Error('maintenance_mcp_ack_invalid');
        if(a.proof==='receipt'&&(!/^[a-f0-9]{64}$/.test(a.digest)||!['ownerDaemonId','senderDaemonId','taskId','attemptId','sessionId'].every(k=>typeof a[k]==='string'&&/^[A-Za-z0-9_.:-]{1,256}$/.test(a[k]))||!Number.isSafeInteger(a.generation)||a.generation<0))throw new Error('maintenance_mcp_ack_invalid');
        return a.proof==='receipt'?{id:a.id,kind:a.kind,proof:a.proof,digest:a.digest,ownerDaemonId:a.ownerDaemonId,senderDaemonId:a.senderDaemonId,taskId:a.taskId,attemptId:a.attemptId,generation:a.generation,sessionId:a.sessionId}:{id:a.id,kind:a.kind,proof:a.proof};
    });
    const inventory={schema:1,pid:identity.pid,entries,acknowledgments,durable:v.durable,directoryReadable:v.directoryReadable,diskSetMatchesMemory:v.diskSetMatchesMemory,
        memoryFallback:v.memoryFallback,flushing:v.flushing,activeSubmits:v.activeSubmits,pendingNoticeCount:v.pendingNoticeCount,quarantinedFileCount:v.quarantinedFileCount,
        temporaryCount:v.temporaryFiles.length,unknownFileCount:v.unknownFiles.length,acknowledgmentsDurable:v.acknowledgmentsDurable};
    const reply=auth.reply({acknowledgedChallenge:w.nonce});
    clearTimeout(w.timer);waiting.delete(name);w.resolve({identity,observed:true,observedAt:Date.now(),challenge:w.nonce,inventory});return reply;
}
export async function collectMcpInventories(root:string,state:CooperativeMaintenance,deadlineMs=2000) {
    const dir=mcpMarkerDirectory(root);let names:string[];
    try{const s=fs.lstatSync(dir);if(!s.isDirectory()||s.isSymbolicLink()||fs.realpathSync(dir)!==dir||s.uid!==process.getuid?.())throw new Error('untrusted');names=fs.readdirSync(dir).sort();}
    catch(e){return {observed:false,reason:(e as NodeJS.ErrnoException).code==='ENOENT'?'mcp_native_membership_required':'mcp_registry_unreadable',members:[] as any[],nativeCensusRequired:true};}
    const readRecords=()=>names.map(name=>{
        if(!/^\d+-[a-f0-9-]{36}\.json$/.test(name))throw new Error('maintenance_mcp_registry_unknown_entry');
        const file=path.join(dir,name),s=fs.lstatSync(file);if(!s.isFile()||s.isSymbolicLink()||(s.mode&0o077)||s.size>16384||s.uid!==process.getuid?.())throw new Error('maintenance_mcp_registry_untrusted');
        const r=JSON.parse(fs.readFileSync(file,'utf8'));const identity=validateMcpIdentity(r.identity);
        // eslint-disable-next-line no-restricted-syntax -- canon-ok: same sealed-record scope join as the marker above, on a permission/ownership-verified private registry entry — the filename, planDigest and daemonId must all be the exact bytes this plan wrote
        if(name!==`${key(identity)}.json`||r.planDigest!==state.planDigest||r.daemonId!==state.daemonId)throw new Error('maintenance_mcp_registry_scope_changed');return identity; // canon-ok: see eslint-disable reason on the preceding line
    });
    const records=readRecords();
    if(new Set(records.map(r=>r.pid)).size!==records.length)throw new Error('maintenance_mcp_pid_incarnation_ambiguous');
    const membershipDigest=sha(records),members=await Promise.all(records.map(identity=>new Promise<any>(resolve=>{
        const name=`${root}:${key(identity)}`;if(waiting.has(name))throw new Error('maintenance_mcp_collection_in_flight');
        const nonce=randomUUID(),timer=setTimeout(()=>{waiting.delete(name);resolve({identity,observed:false,reason:'mcp_incarnation_unreachable',challenge:nonce});},deadlineMs);
        waiting.set(name,{identity,nonce,epoch:state.epoch,resolve,timer});
    })));
    // Registration appearing across await is never omitted from a prior roster.
    if(sha(fs.readdirSync(dir).sort())!==sha(names)||sha(readRecords())!==membershipDigest)throw new Error('maintenance_mcp_membership_changed');
    return {observed:members.every(m=>m.observed),reason:members.some(m=>!m.observed)?'mcp_incarnation_unreachable':undefined,membershipDigest,members,nativeCensusRequired:true};
}
