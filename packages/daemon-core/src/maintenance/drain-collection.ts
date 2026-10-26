/** Target process metadata census. No forgiving status defaults, bodies, timers
 * drained by the collector, lifecycle controls, or strict bridge state writes. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {createHash} from 'node:crypto';
import {daemonIdsEquivalent} from '@adhdev/mesh-shared';
import type {DaemonComponents} from '../boot/daemon-components.js';
import {maintenanceQueueLaunches} from '../mesh/mesh-queue-trigger.js';
import {maintenanceAutoLaunches} from '../mesh/mesh-queue-autolaunch.js';
import {maintenanceDeferredRestarts} from '../commands/med-family/mesh-restart.js';
import {authorizeMaintenanceCollection,type ActorObservationChallenge} from './actor-observation.js';
import {collectLifecycleSource} from './lifecycle-source-inventory.js';
import {collectMcpInventories} from './mcp-collection.js';
import {withMaintenanceObservation,MAINTENANCE_BOOT_NONCE,type CooperativeMaintenance} from './cooperative-gate.js';
import {isNewWorkHeld,TERMINAL_MESH_QUEUE_STATUSES} from './new-work-hold.js';
export const MAINTENANCE_DRAIN_CHANNELS=['runnableQueue','claims','launches','submits','attempts','corrections','livenessHolds','reportOutboxes','progressOutboxes','unreadableOutboxes','temporaryOutboxes','memoryOnlyOutboxes','coordinatorNotices','pendingNotifications','adapterOutbound','adapterSubmit','turnEvents','deferredLifecycle','refineJobs'] as const;
export const MAINTENANCE_BLACKOUT_SOURCES=['queue','autoLaunch','direct','sessionInput','nativeOwnerInput','deferredLifecycle','reconnect','newMembership'] as const;
const digest=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
interface Channel {evidence?:unknown;observed:boolean;source:string;inventoryDigest:string;pending:unknown[];reason?:string;identity:Record<string,unknown>}
function census(components:DaemonComponents,state:CooperativeMaintenance,root:string,nonce:string) {
    const identity={daemonId:state.daemonId,pid:process.pid,bootNonce:MAINTENANCE_BOOT_NONCE,planDigest:state.planDigest,epoch:state.epoch,nonce};
    const channels={} as Record<string,Channel>;
    const set=(name:string,source:string,inventory:unknown,pending:unknown[],reason?:string)=>channels[name]={observed:!reason,source,inventoryDigest:digest(inventory),pending,...(reason?{reason}:{}),identity};
    const read=(names:string[],source:string,fn:()=>void)=>{try{fn();}catch{for(const name of names)set(name,source,{unavailable:true},[],'source_inventory_unavailable');}};
    let db=components.turnLedger?.store.db;
    // Local runtime ownership: this daemon's own ledger answering for the pinned
    // state's machine, which it may legitimately name in any equivalent id form.
    try{if(!daemonIdsEquivalent(components.turnLedger?.selfDaemonId,state.daemonId) || !fs.realpathSync((db as any)?.name).startsWith(root+path.sep))db=undefined;}catch{db=undefined;}
    let revision:unknown=null,receipts:any[]=[];
    const sql=(query:string):any[]=>{
        if(!db||db.inTransaction)throw new Error('live_ledger_handle_required');
        const rows=db.prepare(`${query} LIMIT 100001`).all() as any[];
        if(rows.length>100000)throw new Error('metadata_inventory_truncated');return rows;
    };
    const scoped=(rows:any[])=>rows.some(r=>r.mesh_id&&!state.meshIds.includes(r.mesh_id))?'unenrolled_mesh_work':undefined;
    read(['runnableQueue','claims'],'MeshRuntimeStore.db/mesh_queue',()=>{
        const rows=sql('SELECT id,mesh_id,status,assigned_node_id,assigned_session_id,updated_at FROM mesh_queue ORDER BY id');
        const nonTerminal=rows.filter(r=>!(TERMINAL_MESH_QUEUE_STATUSES as readonly string[]).includes(r.status));
        const activeClaims=rows.filter(r=>r.status==='assigned'),heldPendingQueue=rows.filter(r=>r.status==='pending');
        const pending=isNewWorkHeld()?activeClaims:nonTerminal;
        set('runnableQueue','mesh_queue',rows,pending,scoped(nonTerminal));channels.runnableQueue.evidence={heldPendingQueue,activeClaims};set('claims','mesh_queue/assigned',rows,activeClaims,scoped(nonTerminal));
    });
    read(['attempts','corrections','livenessHolds','turnEvents','coordinatorNotices','pendingNotifications'],'TurnLedger.store.db',()=>{
        revision=db!.prepare('SELECT total_changes() AS revision').get();
        const attempts=sql('SELECT attempt_id,mesh_id,owner_daemon_id,generation,state,terminal_outcome,updated_at FROM turn_attempts ORDER BY attempt_id');
        const open=attempts.filter(r=>r.terminal_outcome===null);set('attempts','turn_attempts',attempts,open,scoped(open));
        const corrections=sql("SELECT attempt_id,mesh_id,generation,json_extract(data_json,'$.reportCorrection.generation') AS correction_generation,json_extract(data_json,'$.reportCorrection.until') AS correction_until FROM turn_attempts WHERE json_extract(data_json,'$.reportCorrection.generation')=generation AND terminal_outcome IS NULL ORDER BY attempt_id");
        set('corrections','turn_attempts/data.reportCorrection',corrections,corrections);
        const holds=sql("SELECT hold_id,attempt_id,generation,reason,status,until_ms FROM turn_holds WHERE status='active' ORDER BY hold_id");
        set('livenessHolds','turn_holds (all active holds, no expiry/prune)',holds,holds);
        const events=sql('SELECT event_id,mesh_id,attempt_id,generation,kind,publish_state,src_writer,src_seq,published_seq,recorded_at FROM turn_events ORDER BY event_id');
        set('turnEvents','turn_events/publish_state',events,events.filter(r=>r.publish_state==='pending'));
        const notices=sql("SELECT n.event_id,n.mesh_id,n.publish_state,n.src_writer,n.published_seq FROM turn_events n WHERE n.kind='notify' AND (n.publish_state!='published' OR NOT EXISTS(SELECT 1 FROM turn_events d WHERE d.kind='delivered' AND (d.event_id='delivered:'||n.mesh_id||':'||n.src_writer||':'||n.published_seq OR (d.event_id='delivered:'||n.src_writer||':'||n.published_seq AND d.mesh_id=n.mesh_id)))) ORDER BY n.event_id");
        const progress=sql("SELECT event_id,mesh_id,state FROM worker_bridge_progress_notice WHERE state!='delivered' ORDER BY event_id");
        set('coordinatorNotices','turn_events + worker_bridge_progress_notice', [notices,progress],[...notices,...progress]);
        // A delivered claim is a consumption intent, not the native submit ACK.
        // Preserve exact metadata and identify the missing owning interface.
        set('pendingNotifications','turn-ledger/deliver.ts native submit ACK',notices,notices,'notice_delivery_ACK_inventory_not_exported');
    });
    read(['livenessHolds','turnEvents'],'actual scheduler/late-probe/publisher promises',()=>{
        const scheduler=components.turnScheduler?.maintenanceInventory();
        const probe=components.turnProbePort?.maintenanceInventory?.();
        const publisher=components.turnLedger?.maintenanceInventory();
        const old=channels.livenessHolds;
        const pending=[...old.pending,...(scheduler?.forced??[]),...(probe?.early??[]),...(scheduler?.inFlight||scheduler?.wakeQueued?[{schedulerInFlight:true}]:[])];
        const reason=old.reason||(!scheduler?'scheduler_inventory_missing':!probe?'late_probe_inventory_missing':undefined);
        channels.livenessHolds={...old,pending,inventoryDigest:digest([old.inventoryDigest,scheduler,probe]),...(reason?{observed:false,reason}:{})};
        const events=channels.turnEvents;
        channels.turnEvents={...events,pending:[...events.pending,...(publisher?.flushing||publisher?.flushAgain?[{publisherInFlight:true}]:[])],inventoryDigest:digest([events.inventoryDigest,publisher]),...(!publisher?{observed:false,reason:'publisher_inventory_missing'}:{})};
    });
    read(['pendingNotifications'],'turn.deliver/native observer ACK inventory',()=>{
        const native=components.meshTurn?.noticeSubmitInventory();
        if(!native||!daemonIdsEquivalent(native.daemonId,state.daemonId)||native.pid!==process.pid||native.bootNonce!==MAINTENANCE_BOOT_NONCE)throw Error('notice_owner_unavailable');
        const claims=sql("SELECT event_id,mesh_id,src_writer,src_seq,session_id,json_extract(payload_json,'$.outcome') AS outcome FROM turn_events WHERE kind='delivered' ORDER BY event_id");
        // eslint-disable-next-line no-restricted-syntax -- canon-ok: joins a durable turn_events claim row to the native submit row on the exact stored column tuple (mesh/writer/seq/session/daemon_id) — the daemon_id is persisted provenance, so a canonicalizing match could pair a claim with another incarnation's submit and hide a missing ACK
        const missing=claims.filter(r=>['delivered','queued','duplicate'].includes(r.outcome)||!r.outcome).filter(r=>!native.rows.some((n:any)=>n.mesh_id===r.mesh_id&&n.writer===r.src_writer&&n.seq===r.src_seq&&n.session_id===r.session_id&&n.daemon_id===state.daemonId&&n.state==='submitted')); // canon-ok: see eslint-disable reason on the preceding line
        const previous=channels.pendingNotifications;
        set('pendingNotifications','turn.deliver durable intent + actual SessionInputService/native write ACK',{native,claims},[...previous.pending,...native.active.map(id=>({handling:id})),...native.pending,...missing.map(r=>({...r,reason:'native_ACK_or_external_old_entry_evidence_required'}))],missing.length?'native_notice_ACK_unconfirmed':undefined);
        channels.pendingNotifications.evidence={native,claims};
    });
    read(['launches'],'mesh-queue-trigger + mesh-queue-autolaunch',()=>{
        const background=maintenanceQueueLaunches(),locks=maintenanceAutoLaunches();
        set('launches','inFlightAutoLaunches/autoLaunchInProgress/autoLaunchTaskInProgress',{background,locks},[...background.filter(x=>x.count>0),...locks.nodes,...locks.tasks]);
    });
    read(['submits','adapterSubmit','adapterOutbound'],'DaemonCliManager.adapters/getStatus(allowParse:false)',()=>{
        const submits:any[]=[],outbound:any[]=[],unknown:string[]=[];
        for(const [sessionId,adapter]of components.cliManager.adapters){
            if(typeof adapter.hasInFlightSubmit!=='function'){unknown.push(sessionId);continue;}
            const pending=adapter.hasInFlightSubmit();if(typeof pending!=='boolean'){unknown.push(sessionId);continue;}
            submits.push({sessionId,pending});
            const status=adapter.getStatus({allowParse:false});const count=(status as any)?.pendingOutboundCount;
            if(!Number.isSafeInteger(count)||count<0){unknown.push(sessionId);continue;}outbound.push({sessionId,count});
        }
        for(const name of ['submits','adapterSubmit'])set(name,'actual adapter.hasInFlightSubmit',submits,submits.filter(x=>x.pending),unknown.length?'adapter_metadata_port_missing':undefined);
        set('adapterOutbound','actual adapter.getStatus({allowParse:false}).pendingOutboundCount',outbound,outbound.filter(x=>x.count>0),unknown.length?'adapter_metadata_port_missing':undefined);
    });
    read(['deferredLifecycle'],'state.json + live mesh restart timers',()=>{
        let persisted:any={deferredRestartSchedules:{}};
        try{const file=path.join(root,'state.json'),s=fs.lstatSync(file);if(!s.isFile()||s.isSymbolicLink()||s.size>8*1024*1024)throw new Error('unknown');persisted=JSON.parse(fs.readFileSync(file,'utf8'));}
        catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
        if(!persisted.deferredRestartSchedules||typeof persisted.deferredRestartSchedules!=='object'||Array.isArray(persisted.deferredRestartSchedules))throw new Error('unknown');
        const timers=maintenanceDeferredRestarts(),schedules=Object.keys(persisted.deferredRestartSchedules).sort();
        const helpers=collectLifecycleSource(root);
        const outer=components.maintenanceLifecycleInventory?.() as (ReturnType<typeof collectLifecycleSource>&{currentOperationId?:string})|undefined;
        const current=outer?.rows.find((r:any)=>r.operationId===outer.currentOperationId);
        const complete=helpers.observed&&outer?.observed===true&&current?.owner.pid===process.pid&&current?.owner.bootNonce===MAINTENANCE_BOOT_NONCE&&digest(helpers.rows)===digest(outer.rows);
        set('deferredLifecycle','mesh-restart timers/state.json + live DaemonUpdateController + durable detached helper/native incarnation',
            {timers,schedules,helpers,outer},[...timers,...schedules,...helpers.pending,...(outer?.pending??[])],complete?undefined:outer?'lifecycle_owner_or_orphan_unknown':'outer_lifecycle_owner_unavailable');
        channels.deferredLifecycle.evidence={timers,schedules,helpers,...(outer?{outer}:{})};
        channels.deferredLifecycle.inventoryDigest=digest(channels.deferredLifecycle.evidence);
    });
    read(['refineJobs'],'router refine maps + mesh_local_records',()=>{
        const router=components.router;
        const live=[...router.runningRefineJobs.values(),...router.runningRefineBatchJobs.values()].map(v=>({jobId:v.jobId,status:v.status}));
        const leases=[...router.refineBaseLeases.values()];
        const rows=sql("SELECT event_id,mesh_id,node_id,kind,json_extract(payload_json,'$.source') AS source,json_extract(payload_json,'$.refineJob.jobId') AS job_id FROM mesh_local_records WHERE kind IN ('task_dispatched','task_completed','task_failed') ORDER BY event_id");
        const terminal=new Set(rows.filter(r=>r.kind!=='task_dispatched').map(r=>`${r.mesh_id}:${r.node_id}:${r.job_id}`));
        // Dispatch-source vocabulary, stated explicitly and fail-closed. A bare equality
        // test on the refine source silently EXCLUDES any dispatch row whose source this
        // census does not know, and an excluded row reads as settled — the same
        // silent-exclusion shape the external rc12 witness driver already refuses.
        // Measured on the real live ledger (readonly snapshot, 2026-10-15), `task_dispatched`
        // sources are {null: 380, direct: 135, refine_mesh_node_async_job: 20, queue: 2};
        // every one of the 380 null-source rows is an ordinary dispatch (routingDecision
        // .source autoLaunch 253 / queue 127) and the number of rows bearing a
        // `refineJob.jobId` under a null/non-refine source is ZERO. So widening or dropping
        // the filter would fabricate ~517 phantom jobs, while leaving it bare hides unknown
        // work. Neither is acceptable: an unrecognised source refuses the channel.
        const REFINE_JOB_SOURCE='refine_mesh_node_async_job';
        // Non-refine dispatch sources, from the writer's own declared union
        // (mesh-routing-decision.ts `source: 'queue' | 'autoLaunch' | 'direct'`, plus the
        // top-level `source:'direct'` buildDirectTaskPayload stamps), and `null` for rows
        // that carry no source field at all. These are KNOWN to be jobless.
        const JOBLESS_SOURCES:Array<string|null>=[null,'direct','queue','autoLaunch'];
        // The vocabulary governs DISPATCHED rows only: those are the rows classified by
        // source to decide what is an open job. Terminal rows are matched by
        // mesh+node+job identity, never by source — and on the real ledger a terminal row
        // legitimately carries no source at all (measured: 20 `task_completed` rows with
        // source=null), so gating them would refuse that normal shape.
        const dispatched=rows.filter(r=>r.kind==='task_dispatched');
        // An UNKNOWN source is uncertainty, not a settled row. A dispatch row carrying a
        // refine job under a source declared jobless contradicts the vocabulary itself
        // (measured: ZERO such rows) — this census does not guess which half is right.
        const unknownSource=dispatched.some(r=>r.source!==REFINE_JOB_SOURCE&&!JOBLESS_SOURCES.includes(r.source??null))
            ||dispatched.some(r=>r.job_id&&r.source!==REFINE_JOB_SOURCE);
        const open=dispatched.filter(r=>r.source===REFINE_JOB_SOURCE&&(!r.job_id||!terminal.has(`${r.mesh_id}:${r.node_id}:${r.job_id}`)));
        set('refineJobs',`runningRefineJobs/runningRefineBatchJobs/refineBaseLeases/mesh_local_records (dispatch source vocabulary: ${REFINE_JOB_SOURCE} bears jobs; direct|queue|autoLaunch|none are jobless; anything else refuses)`,{live,leases,rows},[...live,...leases,...open],unknownSource?'dispatch_source_vocabulary_unknown':undefined);
    });
    let receiptsObserved=true;
    try{receipts=sql(`SELECT side,sender_id,delivery_id,mesh_id,digest,state,
        json_extract(envelope_json,'$.kind') AS kind,
        json_extract(receipt_json,'$.deliveryReceipt.digest') AS receipt_digest,
        json_extract(receipt_json,'$.deliveryReceipt.protocol') AS receipt_protocol,
        json_extract(receipt_json,'$.deliveryReceipt.deliveryId') AS receipt_delivery_id,
        json_extract(envelope_json,'$.ownerDaemonId') AS envelope_owner,
        json_extract(envelope_json,'$.senderDaemonId') AS envelope_sender,
        json_extract(envelope_json,'$.taskId') AS envelope_task,
        json_extract(envelope_json,'$.attemptId') AS envelope_attempt,
        json_extract(envelope_json,'$.generation') AS envelope_generation,
        json_extract(envelope_json,'$.sessionId') AS envelope_session,
        json_extract(receipt_json,'$.deliveryReceipt.ownerDaemonId') AS ownerDaemonId,
        json_extract(receipt_json,'$.deliveryReceipt.senderDaemonId') AS senderDaemonId,
        json_extract(receipt_json,'$.deliveryReceipt.taskId') AS taskId,
        json_extract(receipt_json,'$.deliveryReceipt.attemptId') AS attemptId,
        json_extract(receipt_json,'$.deliveryReceipt.generation') AS generation,
        json_extract(receipt_json,'$.deliveryReceipt.sessionId') AS sessionId
        FROM worker_bridge_delivery ORDER BY side,sender_id,delivery_id`);}catch{receiptsObserved=false;}
    const stableChannels=Object.fromEntries(Object.entries(channels).map(([name,{identity:_identity,...value}])=>[name,value]));
    return {identity,channels,revision,receipts,receiptsObserved,digest:digest({channels:stableChannels,receipts,receiptsObserved})};
}
export async function collectTargetDrain(components:DaemonComponents,state:CooperativeMaintenance,root:string,nonce:string,deadlineMs=2000) {
    const before=census(components,state,root,nonce);
    let mcp:Awaited<ReturnType<typeof collectMcpInventories>>;
    try{mcp=await collectMcpInventories(root,state,deadlineMs);}catch{mcp={observed:false,reason:'mcp_registry_unknown_or_changed',members:[],nativeCensusRequired:true};}
    // A second challenged read detects MCP entry/ACK/flush and roster changes
    // while other participants are being collected. This is not producer exclusion.
    let confirmed:typeof mcp;
    try{confirmed=await collectMcpInventories(root,state,deadlineMs);}catch{confirmed={observed:false,reason:'mcp_registry_unknown_or_changed',members:[],nativeCensusRequired:true};}
    const select=(v:typeof mcp)=>v.members.map(m=>({identity:m.identity,observed:m.observed,inventory:m.inventory}));
    const mcpStable=digest(select(mcp))===digest(select(confirmed));
    if(!mcp.observed||!mcpStable||!confirmed.observed||mcp.membershipDigest!==confirmed.membershipDigest)mcp={...confirmed,observed:false,reason:confirmed.reason||mcp.reason||'mcp_inventory_changed_during_collection'};
    else mcp=confirmed;
    const after=census(components,state,root,nonce),channels=after.channels;
    const members=mcp.members.filter(m=>m.observed),incomplete=!mcp.observed||members.length!==mcp.members.length;
    const mcpChannel=(name:string,pending:unknown[],reason?:string)=>channels[name]={observed:!reason&&!incomplete,source:'fresh challenged target MCP adapters + worker_bridge_delivery',pending,inventoryDigest:digest({members,receipts:after.receipts}),identity:after.identity,...(reason||incomplete?{reason:reason||mcp.reason||'mcp_inventory_unknown'}:{})};
    const matchesAck=(r:any,ack:any)=>ack.proof==='receipt'&&r.kind===ack.kind&&r.receipt_protocol===1&&r.receipt_delivery_id===r.delivery_id&&r.sender_id===ack.senderDaemonId&&r.envelope_sender===ack.senderDaemonId&&r.envelope_owner===ack.ownerDaemonId&&r.envelope_task===ack.taskId&&r.envelope_attempt===ack.attemptId&&r.envelope_generation===ack.generation&&r.envelope_session===ack.sessionId&&r.state==='receipted'&&r.delivery_id===ack.id&&r.digest===ack.digest&&r.receipt_digest===r.digest // canon-ok: receipt-proof predicate matching a stored delivery row against the peer's ACK envelope field-for-field; sender/owner ids are part of the signed envelope tuple the digest covers, so they must compare byte-exactly or a forged/mismatched ACK would satisfy the proof
        && ['ownerDaemonId','senderDaemonId','taskId','attemptId','generation','sessionId'].every(k=>r[k]===ack[k]);
    const invalidAck:any[]=[];
    for(const m of members)for(const ack of m.inventory.acknowledgments){
        if(!after.receipts.some(r=>matchesAck(r,ack)))invalidAck.push({pid:m.identity.pid,id:ack.id,kind:ack.kind});
    }
    // eslint-disable-next-line no-restricted-syntax -- canon-ok: selects stored receipts whose persisted sender_id column is this plan's own exact id, then demands a matching member ACK — canonicalizing would pull in rows written under a different stored form and wrongly treat them as needing (or having) our ACK evidence
    for(const r of after.receipts)if(r.sender_id===state.daemonId&&r.state==='receipted'&&!members.some(m=>m.inventory.acknowledgments.some((ack:any)=>matchesAck(r,ack))))invalidAck.push({id:r.delivery_id,kind:r.kind,reason:'source_ACK_or_external_old_entry_evidence_required'}); // canon-ok: see eslint-disable reason on the preceding line
    const pendingBridge=after.receipts.filter(r=>r.state!=='receipted'||r.receipt_protocol!==1||r.receipt_delivery_id!==r.delivery_id||r.receipt_digest!==r.digest||r.sender_id!==r.senderDaemonId||r.envelope_sender!==r.senderDaemonId||r.envelope_owner!==r.ownerDaemonId||r.envelope_task!==r.taskId||r.envelope_attempt!==r.attemptId||r.envelope_generation!==r.generation||r.envelope_session!==r.sessionId); // canon-ok: self-consistency check that each stored receipt's envelope_* columns equal the row's own signed fields — a within-row byte comparison of persisted provenance, not a machine match, so any normalization would mask exactly the envelope tampering this detects
    for(const [channel,kind] of [['reportOutboxes','report'],['progressOutboxes','progress']]as const){
        const entries=members.flatMap(m=>m.inventory.entries.filter((e:any)=>e.kind===kind).map((e:any)=>({pid:m.identity.pid,...e})));
        mcpChannel(channel,[...entries,...pendingBridge.filter(r=>r.kind===kind||!['report','progress'].includes(r.kind)),...invalidAck.filter(a=>a.kind===kind)],!after.receiptsObserved?'receipt_store_unavailable':invalidAck.length?'exact_delivery_ACK_unconfirmed':undefined);
    }
    const statuses=(fn:(v:any)=>boolean)=>members.filter(m=>fn(m.inventory)).map(m=>({pid:m.identity.pid,bootNonce:m.identity.bootNonce}));
    mcpChannel('unreadableOutboxes',statuses(v=>!v.directoryReadable||!v.diskSetMatchesMemory||v.quarantinedFileCount>0||v.unknownFileCount>0||!v.acknowledgmentsDurable));
    mcpChannel('temporaryOutboxes',statuses(v=>v.temporaryCount>0));mcpChannel('memoryOnlyOutboxes',statuses(v=>v.memoryFallback||!v.durable));
    const active=statuses(v=>v.activeSubmits>0||v.flushing||v.pendingNoticeCount>0);
    if(active.length)channels.submits={...channels.submits,pending:[...channels.submits.pending,...active]};
    if(before.digest!==after.digest||JSON.stringify(before.revision)!==JSON.stringify(after.revision))for(const ch of Object.values(channels)){ch.observed=false;ch.reason='producer_changed_during_collection';}
    const blackout=Object.fromEntries(MAINTENANCE_BLACKOUT_SOURCES.map(source=>[source,{source:source==='nativeOwnerInput'?'external old-entry/native owner ingress witness':source==='deferredLifecycle'?'current target lifecycle source inventory; native old-entry exclusion still external':'cooperative-gate held admission writer',excluded:['nativeOwnerInput','deferredLifecycle'].includes(source)?null:true,identity:after.identity,...(source==='nativeOwnerInput'?{reason:'external_blackout_or_already_cold_prerequisite'}:source==='deferredLifecycle'?{reason:'native_helper_census_or_external_old_entry_prerequisite'}:{})}]));
    const unknown=MAINTENANCE_DRAIN_CHANNELS.filter(k=>!channels[k]?.observed);
    return {schema:1,...after.identity,observedAt:Date.now(),scope:'current-target-instance',oldEntryEvidenceRequired:true,
        channels,blackout,mcp,receiptsDigest:digest(after.receipts),ledgerDigest:after.digest,deliverySetDigest:digest(members.map(m=>({identity:m.identity,acks:m.inventory.acknowledgments}))),
        unknown,drained:false,nativeMcpCensusRequired:true};
}
export async function authenticatedDrainCollection(components:DaemonComponents,request:ActorObservationChallenge) {
    const auth=authorizeMaintenanceCollection(request,'drain');
    const drain=await withMaintenanceObservation(state=>collectTargetDrain(components,state,auth.root,request.nonce));
    return auth.reply({drain});
}
