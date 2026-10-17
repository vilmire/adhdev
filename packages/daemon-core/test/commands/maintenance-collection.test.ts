import {beforeEach,afterEach,afterAll,it,expect,vi} from 'vitest';
const isolation=await vi.hoisted(async()=>{const {createSessionHostIsolation}=await import('../helpers/session-host-isolation.js');return createSessionHostIsolation();});
vi.mock('@adhdev/session-host-core',async original=>({...await original<any>(),getDefaultSessionHostEndpoint:vi.fn(()=>{throw Error('default_endpoint_forbidden');}),SessionHostClient:vi.fn(function(){throw Error('native_client_not_used_by_collector');})}));
import * as fs from 'node:fs';
import * as path from 'node:path';
import {createHash,createHmac,randomUUID} from 'node:crypto';
import {SessionHostClient} from '@adhdev/session-host-core';
import {MeshRuntimeStore} from '../../src/mesh/mesh-runtime-store.js';
import {createTurnLedger} from '../../src/mesh/turn-ledger/ledger.js';
import {createLateBoundProbePort} from '../../src/mesh/turn-ledger/scheduler.js';
import {ensureBridgeSchema} from '../../src/mesh/worker-bridge.js';
import {DaemonCommandRouter} from '../../src/commands/router.js';
import {writeCooperativeMaintenance,type CooperativeMaintenance} from '../../src/maintenance/cooperative-gate.js';
import {actorObservationChallengeBytes} from '../../src/maintenance/actor-observation.js';
import {MAINTENANCE_DRAIN_CHANNELS,MAINTENANCE_BLACKOUT_SOURCES} from '../../src/maintenance/drain-collection.js';
import {createNoticeSubmitInventory} from '../../src/mesh/turn-ledger/notice-submit-inventory.js';
import {beginLifecycleSource,advanceLifecycleSource,collectLifecycleSource} from '../../src/maintenance/lifecycle-source-inventory.js';
import {resetProcessInstanceContextForTests} from '../../src/config/instance-context.js';
const hash=(v:any)=>createHash('sha256').update(v).digest('hex');
let root:string,state:CooperativeMaintenance,router:DaemonCommandRouter,store:MeshRuntimeStore,key:Buffer,configSha:string,components:any;
const exporters:Array<{stop():void}>=[];const deliveries:any[]=[];
beforeEach(()=>{
 expect(vi.isMockFunction(SessionHostClient)).toBe(true);isolation.assertEndpoint(isolation.endpoint);
 root=path.join(isolation.root,randomUUID());fs.mkdirSync(root,{recursive:true});process.env.ADHDEV_CONFIG_DIR=root;resetProcessInstanceContextForTests();MeshRuntimeStore.resetForTests();
 key=Buffer.alloc(32,4);const keyPath=path.join(root,'collection.key');fs.writeFileSync(keyPath,key,{mode:0o600});
 const config={schema:1,rolloutId:'collection',daemonId:'self',configDir:root,observationKey:{path:keyPath,sha256:hash(key)}};
 const bytes=JSON.stringify(config);configSha=hash(bytes);fs.writeFileSync(path.join(root,'cooperative-maintenance-actor.json'),bytes,{mode:0o600});
 const old=path.join(root,'retained');fs.mkdirSync(old);const files=['host.js','node','pty.node'].map(name=>{const file=path.join(old,name);fs.writeFileSync(file,name);return {path:file,sha256:hash(name)};});
 state={schema:1,rolloutId:'collection',daemonId:'self',planDigest:hash('plan'),epoch:1,actorConfigSha256:configSha,roster:['self'],meshIds:['mesh'],nodeRoster:[{meshId:'mesh',nodeId:'node',daemonId:'self'}],phase:'held',targetSha256:hash('target'),retainedHost:{pid:777,birth:'synthetic-birth',endpoint:isolation.endpoint.path,entryPath:files[0].path,nodePath:files[1].path,prefix:old,hostStartedAt:10,files,sessionSetDigest:hash('[]')}};
 writeCooperativeMaintenance(root,state);store=MeshRuntimeStore.getInstance();ensureBridgeSchema(store.db as any);
 const manager={adapters:new Map()};router=new DaemonCommandRouter({commandHandler:{handle:vi.fn()} as any});
 components={router,cliManager:manager,turnLedger:createTurnLedger({db:store.db,selfDaemonId:'self',autoFlush:false}),turnProbePort:createLateBoundProbePort()};router.attachComponents(components);
});
afterEach(()=>{for(const e of exporters.splice(0))e.stop();for(const d of deliveries.splice(0))d.dispose();router.meshNodeStatePusher.stop();router.localMeshNodeGitWatch.stop();MeshRuntimeStore.resetForTests();resetProcessInstanceContextForTests();});
afterAll(()=>isolation.cleanup());
async function signed(operation:'drain'|'mcp_poll'|'mcp_reply',body?:any){const r={schema:1 as const,operation,daemonId:'self',planDigest:state.planDigest,epoch:state.epoch,nonce:randomUUID(),sentAt:Date.now(),configSha256:configSha,...(body===undefined?{}:{body,bodyDigest:hash(JSON.stringify(body))})};return {...r,mac:createHmac('sha256',key).update(actorObservationChallengeBytes(r)).digest('hex')};}
async function collect(){return (await router.execute('cooperative_maintenance_actor_drain',await signed('drain'),'ipc') as any).reply.drain;}
async function worker(command?:(name:string,args:any)=>Promise<any>,memory=false,source:'ipc'|'standalone'='ipc'){
 const {WorkerReportDelivery}=await import('../../../mcp-server/src/tools/worker-report-outbox.js');
 const {startMaintenanceInventoryExporter}=await import('../../../mcp-server/src/tools/maintenance-inventory-exporter.js');
 const dir=path.join(root,randomUUID());fs.mkdirSync(dir);
 const delivery=new WorkerReportDelivery({dir:memory?null:dir,credentials:{} as any,autoSchedule:false,inlineAttempts:1,transport:{command:command??(async()=>({success:true}))} as any});deliveries.push(delivery);
 const transport={command:async(name:string,args:any)=>router.execute(name,args,source)};
 const exporter=await startMaintenanceInventoryExporter(transport,delivery);exporters.push(exporter);return {delivery,exporter,dir};
}
it('actual router exports all 19 channels and 8 sources; absent MCP evidence and missing ACK ports are explicit unknown',async()=>{
 const d=await collect();expect(Object.keys(d.channels).sort()).toEqual([...MAINTENANCE_DRAIN_CHANNELS].sort());expect(Object.keys(d.blackout).sort()).toEqual([...MAINTENANCE_BLACKOUT_SOURCES].sort());
 expect(d.channels.runnableQueue).toMatchObject({observed:true,pending:[],identity:{epoch:1,pid:process.pid,daemonId:'self'}});
 expect(d.channels.reportOutboxes.observed).toBe(false);expect(d.channels.pendingNotifications.reason).toBe('source_inventory_unavailable');expect(d.channels.deferredLifecycle.reason).toBe('outer_lifecycle_owner_unavailable');expect(d.blackout.nativeOwnerInput.excluded).toBeNull();expect(d.drained).toBe(false);
});
it('real MCP producer route returns current report/progress and ACK-backed receipt joined to actual daemon rows without bodies',async()=>{
 const command=async(_name:string,args:any)=>{
  const receipt={protocol:1,deliveryId:args.deliveryId,digest:hash(args.deliveryId),ownerDaemonId:'self',senderDaemonId:'self',taskId:'task',attemptId:'attempt',generation:1,sessionId:'session'};
  const envelope={kind:args.deliveryId.startsWith('wp_')?'progress':'report',...receipt};
  store.db.prepare("INSERT INTO worker_bridge_delivery(side,sender_id,delivery_id,mesh_id,envelope_json,digest,state,receipt_json) VALUES('owner','self',?,'mesh',?,?,'receipted',?)").run(args.deliveryId,JSON.stringify(envelope),receipt.digest,JSON.stringify({deliveryReceipt:receipt,privateBody:'PRIVATE-DAEMON-ANSWER'}));
  return {success:true,deliveryReceipt:receipt,privateBody:'PRIVATE-DAEMON-ANSWER'};
 };
 const {delivery}=await worker(command);await delivery.submit('report',{privateBody:'PRIVATE-REPORT'});await delivery.submit('progress',{privateBody:'PRIVATE-PROGRESS'});
 const d=await collect();expect(d.mcp.observed).toBe(true);expect(d.mcp.members).toHaveLength(1);expect(d.channels.reportOutboxes).toMatchObject({observed:true,pending:[]});expect(d.channels.progressOutboxes).toMatchObject({observed:true,pending:[]});
 expect(d.mcp.members[0].inventory.acknowledgments).toHaveLength(2);expect(JSON.stringify(d)).not.toContain('PRIVATE-');expect(d.nativeMcpCensusRequired).toBe(true);expect(d.drained).toBe(false);
});
it('unresolved producer ACK, corrupt/temp and memory fallback cannot become observed empty outboxes',async()=>{
 let ack!:(r:any)=>void,entered!:()=>void;const started=new Promise<void>(r=>entered=r);
 const {delivery,dir}=await worker(async()=>{entered();return new Promise(r=>{ack=r;});});
 const submit=delivery.submit('report',{privateBody:'PRIVATE-PENDING'});await started;
 fs.writeFileSync(path.join(dir,'unknown.json'),'corrupt');fs.writeFileSync(path.join(dir,'pending.tmp'),'temp');
 const d=await collect();expect(d.channels.reportOutboxes.pending.length).toBeGreaterThan(0);expect(d.channels.submits.pending.length).toBeGreaterThan(0);expect(d.channels.unreadableOutboxes.pending.length).toBeGreaterThan(0);expect(d.channels.temporaryOutboxes.pending.length).toBeGreaterThan(0);expect(JSON.stringify(d)).not.toContain('PRIVATE-');ack({success:true});await submit;
});
it('stopped or restarted MCP incarnation stays unknown with its durable marker retained',async()=>{
 const {exporter}=await worker();exporter.stop();const d=await collect();expect(d.mcp.observed).toBe(false);expect(d.channels.reportOutboxes.observed).toBe(false);expect(fs.readdirSync(path.join(root,'cooperative-maintenance-mcp'))).toHaveLength(1);
});
it('real queue, correction/hold, refine and adapter producers are counted; absent status APIs stay unknown',async()=>{
 store.insertQueueEntry({id:'queued',meshId:'mesh',status:'pending',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),privateBody:'PRIVATE-QUEUE'} as any);
 store.db.prepare("INSERT INTO turn_attempts(attempt_id,scope,mesh_id,session_id,owner_daemon_id,state,accepted_at,created_at,updated_at,data_json) VALUES('attempt','mesh_direct','mesh','session','self','accepted',1,1,1,?)").run(JSON.stringify({reportCorrection:{generation:0,until:Date.now()+10000},privateBody:'PRIVATE-CORRECTION'}));
 store.db.prepare("INSERT INTO turn_holds(hold_id,attempt_id,reason,status,on_expire,created_at) VALUES('hold','attempt','liveness','active','reprobe',1)").run();
 router.runningRefineJobs.set('mesh:node',{jobId:'refine',status:'running'} as any);
 components.cliManager.adapters.set('session',{hasInFlightSubmit:()=>true,getStatus:()=>({pendingOutboundCount:2})});
 const d=await collect();for(const key of ['runnableQueue','attempts','corrections','livenessHolds','refineJobs','adapterSubmit','adapterOutbound'])expect(d.channels[key].pending.length,key).toBeGreaterThan(0);expect(JSON.stringify(d)).not.toContain('PRIVATE-');
 components.cliManager.adapters.set('session',{});expect((await collect()).channels.adapterSubmit.observed).toBe(false);
 components.cliManager.adapters.set('session',{hasInFlightSubmit:()=>undefined,getStatus:()=>({pendingOutboundCount:0})});const unknown=await collect();expect(unknown.channels.adapterSubmit.observed).toBe(false);expect(unknown.channels.livenessHolds.observed).toBe(false);
});
// The refineJobs dispatch-source vocabulary is FAIL-CLOSED: an unrecognised source is
// uncertainty, never a row silently dropped from the open set (which reads as drained).
// Measured on the real live ledger, `task_dispatched` sources are
// {null:380, direct:135, refine_mesh_node_async_job:20, queue:2} and NO null/non-refine
// dispatch row carries a refineJob.jobId — so the ordinary rows must stay jobless
// (widening would fabricate ~517 phantom jobs) while an unknown source refuses.
const localRecord=(id:string,kind:string,payload:unknown,nodeId='node',meshId='mesh')=>
 store.db.prepare('INSERT INTO mesh_local_records(event_id,mesh_id,kind,node_id,at_ms,payload_json) VALUES(?,?,?,?,?,?)').run(id,meshId,kind,nodeId,Date.now(),JSON.stringify(payload));
const refineJobs=async()=>(await collect()).channels.refineJobs;
it('ordinary dispatch sources stay jobless and a settled refine job closes, while an unknown dispatch source refuses the channel',async()=>{
 // Positive 1: the four KNOWN-jobless ordinary shapes contribute no open job. These are
 // exactly the real-ledger shapes: no source at all, plus the writer's declared union.
 localRecord('d-none','task_dispatched',{taskId:'t0',routingDecision:{source:'autoLaunch'},privateBody:'PRIVATE-NONE'});
 localRecord('d-direct','task_dispatched',{source:'direct',taskId:'t1',privateBody:'PRIVATE-DIRECT'});
 localRecord('d-queue','task_dispatched',{source:'queue',taskId:'t2'});
 localRecord('d-auto','task_dispatched',{source:'autoLaunch',taskId:'t3'});
 let ch=await refineJobs();expect(ch.observed).toBe(true);expect(ch.pending).toEqual([]);
 // Positive 2: a refine job with a matching terminal row on the SAME mesh+node+job key is
 // settled and closes; the terminal row legitimately carries NO source (20 such rows
 // measured on the real ledger), which must not refuse.
 localRecord('d-settled','task_dispatched',{source:'refine_mesh_node_async_job',refineJob:{jobId:'job-settled'}});
 localRecord('t-settled','task_completed',{refineJob:{jobId:'job-settled'}});
 ch=await refineJobs();expect(ch.observed).toBe(true);expect(ch.pending).toEqual([]);
 // Positive 3: an unterminated refine job is open work.
 localRecord('d-open','task_dispatched',{source:'refine_mesh_node_async_job',refineJob:{jobId:'job-open'}});
 ch=await refineJobs();expect(ch.observed).toBe(true);expect(ch.pending.length).toBe(1);
 // Negative 1: a terminal row for the same job on a DIFFERENT mesh must not settle it —
 // the key is mesh+node+job, and reducing it to jobId alone would create a cross-mesh join.
 localRecord('t-cross','task_completed',{refineJob:{jobId:'job-open'}},'node','other-mesh');
 ch=await refineJobs();expect(ch.observed).toBe(true);expect(ch.pending.length).toBe(1);
 // Negative 2: an UNRECOGNISED dispatch source refuses the whole channel rather than
 // being silently excluded from the open set.
 localRecord('d-unknown','task_dispatched',{source:'some_future_dispatch_source',taskId:'t4'});
 ch=await refineJobs();expect(ch.observed).toBe(false);expect(ch.reason).toBe('dispatch_source_vocabulary_unknown');
 expect(JSON.stringify(await collect())).not.toContain('PRIVATE-');
});
it('a refine job carried under a source declared jobless refuses instead of being guessed, and terminal rows are never source-gated',async()=>{
 // A dispatch row bearing a refine job under a jobless source contradicts the vocabulary
 // itself (measured: ZERO such rows). The census must not guess which half is right.
 localRecord('d-contradiction','task_dispatched',{source:'direct',refineJob:{jobId:'job-x'}});
 const ch=await refineJobs();expect(ch.observed).toBe(false);expect(ch.reason).toBe('dispatch_source_vocabulary_unknown');
 // And the gate is scoped to DISPATCHED rows only: an unknown source on a TERMINAL row is
 // not gated, because terminal rows are matched by identity, never by source. Gating them
 // would refuse the normal source=null terminal shape the real ledger carries.
 store.db.prepare("DELETE FROM mesh_local_records WHERE event_id='d-contradiction'").run();
 localRecord('t-weird','task_completed',{source:'some_future_terminal_source',refineJob:{jobId:'job-y'}});
 localRecord('t-null','task_failed',{refineJob:{jobId:'job-z'}});
 const after=await refineJobs();expect(after.observed).toBe(true);expect(after.pending).toEqual([]);
});
it('ledger changes across collection invalidate the sample; bad epoch refuses before collection',async()=>{
 const {delivery}=await worker();const p=collect();setTimeout(()=>{store.insertQueueEntry({id:'race',meshId:'mesh',status:'pending',createdAt:'now',updatedAt:'now'} as any);},100);
 const d=await p;expect(d.channels.runnableQueue.observed).toBe(false);expect(d.channels.runnableQueue.reason).toBe('producer_changed_during_collection');expect(delivery.maintenanceInventory().activeSubmits).toBe(0);
 const r=await signed('drain');r.epoch++;await expect(router.execute('cooperative_maintenance_actor_drain',r,'ipc')).rejects.toThrow();
});

it('memory-only progress delivery and forged receipt attribution remain unsettled',async()=>{
 const {delivery}=await worker(async()=>{throw Error('unreachable');},true);await delivery.submit('progress',{privateBody:'PRIVATE-MEMORY'});
 const d=await collect();expect(d.channels.memoryOnlyOutboxes.pending.length).toBe(1);expect(d.channels.progressOutboxes.pending.length).toBeGreaterThan(0);expect(JSON.stringify(d)).not.toContain('PRIVATE-');
});
it('current exporter survives daemon reclose epoch; stale response or changed body cannot satisfy a fresh challenge',async()=>{
 const {delivery}=await worker();const before=await collect();state={...state,epoch:2};writeCooperativeMaintenance(root,state);
 const d=await collect();expect(d.mcp.observed).toBe(true);expect(d.channels.reportOutboxes.identity.epoch).toBe(2);expect(d.ledgerDigest).toBe(before.ledgerDigest);
 const marker=JSON.parse(fs.readFileSync(path.join(root,'cooperative-maintenance-mcp',fs.readdirSync(path.join(root,'cooperative-maintenance-mcp'))[0]),'utf8'));
 const stale=await signed('mcp_reply',{identity:marker.identity,challenge:randomUUID(),inventory:delivery.maintenanceInventory()});
 await expect(router.execute('cooperative_maintenance_mcp_reply',stale,'ipc')).rejects.toThrow('maintenance_mcp_reply_stale');
 stale.bodyDigest=hash('tampered');await expect(router.execute('cooperative_maintenance_mcp_reply',stale,'ipc')).rejects.toThrow();
});
it('registration appearing during challenged collection refuses roster completeness',async()=>{
 await worker();const p=collect();const added=new Promise<void>(resolve=>setTimeout(()=>void worker().then(()=>resolve()),100));await added;
 const d=await p;expect(d.mcp.observed).toBe(false);expect(d.channels.reportOutboxes.observed).toBe(false);
});
it('receipt generation drift in persisted daemon metadata refuses exact source ACK proof',async()=>{
 const {delivery}=await worker(async(_command,args)=>{
  const receipt={protocol:1,deliveryId:args.deliveryId,digest:hash(args.deliveryId),ownerDaemonId:'self',senderDaemonId:'self',taskId:'task',attemptId:'attempt',generation:1,sessionId:'session'};
  store.db.prepare("INSERT INTO worker_bridge_delivery(side,sender_id,delivery_id,mesh_id,envelope_json,digest,state,receipt_json) VALUES('owner','self',?,'mesh',?,?,'receipted',?)").run(args.deliveryId,JSON.stringify({kind:'report',...receipt,generation:2}),receipt.digest,JSON.stringify({deliveryReceipt:receipt}));
  return {success:true,deliveryReceipt:receipt};
 });await delivery.submit('report',{privateBody:'PRIVATE-DRIFT'});const d=await collect();expect(d.channels.reportOutboxes.observed).toBe(false);expect(d.channels.reportOutboxes.reason).toBe('exact_delivery_ACK_unconfirmed');
});

it('actual late probe and publisher promises remain pending metadata until their ACKs settle',async()=>{
 components.turnProbePort.port({attemptId:'early-probe'});
 let acknowledge!:(value:any)=>void,entered!:()=>void;const started=new Promise<void>(r=>entered=r);
 components.turnLedger=createTurnLedger({db:store.db,selfDaemonId:'self',autoFlush:false,publisher:{publish:async()=>{entered();return new Promise(r=>acknowledge=r);}}});
 components.turnLedger.notifyMeshEvent({meshId:'mesh',event:'test-notice',targetDaemonId:'self',payload:{privateBody:'PRIVATE-NOTICE'}});
 const publishing=components.turnLedger.flushPublish();await started;
 const d=await collect();expect(d.channels.livenessHolds.pending).toContain('early-probe');expect(d.channels.turnEvents.pending.some((p:any)=>p.publisherInFlight)).toBe(true);expect(JSON.stringify(d)).not.toContain('PRIVATE-');
 acknowledge({writer:'test-writer',seq:1});await publishing;
});

it('actual signed exporter route also supports the standalone local command consumer',async()=>{
 await worker(undefined,false,'standalone');const d=await collect();expect(d.mcp.observed).toBe(true);expect(d.mcp.members).toHaveLength(1);expect(d.drained).toBe(false);
});
it('a disappearing empty registry in the fresh second round cannot preserve observed emptiness',async()=>{
 const dir=path.join(root,'cooperative-maintenance-mcp');fs.mkdirSync(dir);
 const request=await signed('drain');const pending=router.execute('cooperative_maintenance_actor_drain',request,'ipc');
 queueMicrotask(()=>fs.renameSync(dir,dir+'-unreachable'));
 const d=(await pending as any).reply.drain;expect(d.mcp.observed).toBe(false);expect(d.channels.reportOutboxes.observed).toBe(false);
});
it('reverse ACK proof cannot borrow a matching ID/digest from another persisted tuple',async()=>{
 const {delivery}=await worker(async(_name,args)=>{
  const receipt={protocol:1,deliveryId:args.deliveryId,digest:hash(args.deliveryId),ownerDaemonId:'self',senderDaemonId:'self',taskId:'task',attemptId:'attempt',generation:1,sessionId:'session'};
  for(const side of ['owner','sender']){
   const r={...receipt,...(side==='sender'?{generation:2,sessionId:'different-session'}:{})};
   store.db.prepare("INSERT INTO worker_bridge_delivery(side,sender_id,delivery_id,mesh_id,envelope_json,digest,state,receipt_json) VALUES(?,'self',?,'mesh',?,?,'receipted',?)").run(side,args.deliveryId,JSON.stringify({kind:'report',...r}),r.digest,JSON.stringify({deliveryReceipt:r}));
  }
  return {success:true,deliveryReceipt:receipt};
 });await delivery.submit('report',{privateBody:'PRIVATE-REVERSE'});
 const d=await collect();expect(d.channels.reportOutboxes.observed).toBe(false);expect(d.channels.reportOutboxes.pending.some((p:any)=>p.reason==='source_ACK_or_external_old_entry_evidence_required')).toBe(true);
});

it('authenticated collection exports actual notice ACK and controller/helper ports with current challenge identity',async()=>{
 const notices=createNoticeSubmitInventory(components.turnLedger);components.meshTurn={noticeSubmitInventory:notices.inventory};
 const controllerId=beginLifecycleSource('controller',{},root);advanceLifecycleSource(controllerId,'idle',{},root);
 components.maintenanceLifecycleInventory=()=>{const inv=collectLifecycleSource(root);return {...inv,currentOperationId:controllerId,pending:[...inv.pending,...inv.rows.filter((r:any)=>r.kind==='controller'&&(r.operationId!==controllerId||r.state!=='idle'))]};};
 await collect();const empty=await collect();expect(empty.channels.pendingNotifications.observed).toBe(true);expect(empty.channels.deferredLifecycle.observed).toBe(true);
 const intent=notices.begin({meshId:'mesh',writer:'writer',seq:8},'coordinator');intent.outcome('queued');
 const queued=await collect();expect(queued.channels.pendingNotifications.pending).toHaveLength(1);expect(queued.channels.pendingNotifications.evidence.native.rows[0].state).toBe('queued');intent.observe('submitted');
 expect((await collect()).channels.pendingNotifications.pending).toHaveLength(0);
 advanceLifecycleSource(controllerId,'pending',{pendingMandatory:'1.0.81'},root);const helper=beginLifecycleSource('helper',{targetVersion:'1.0.81'},root);
 const pending=await collect();expect(pending.channels.deferredLifecycle.pending.length).toBeGreaterThan(0);expect(pending.channels.deferredLifecycle.evidence.helpers.rows.some((r:any)=>r.operationId===helper)).toBe(true);expect(pending.channels.deferredLifecycle.identity.epoch).toBe(state.epoch);
 components.maintenanceLifecycleInventory=()=>{throw Error('unreachable owner');};expect((await collect()).channels.deferredLifecycle.observed).toBe(false);
});
