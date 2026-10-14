import {beforeEach,afterEach,afterAll,it,expect,vi} from 'vitest';
const isolated=await vi.hoisted(async()=>{const {createSessionHostIsolation}=await import('../helpers/session-host-isolation.js');return createSessionHostIsolation();});
vi.mock('@adhdev/session-host-core',async original=>({...await original<any>(),getDefaultSessionHostEndpoint:vi.fn(()=>{throw Error('default_endpoint_forbidden');}),SessionHostClient:vi.fn(function(){throw Error('native_client_forbidden');})}));
const spawnState=vi.hoisted(()=>({calls:0,psFailure:false}));
vi.mock('child_process',async original=>{const actual=await original<any>();return {...actual,execFileSync:(...args:any[])=>{if(spawnState.psFailure&&args[0]==='/bin/ps')throw Object.assign(Error('unreachable native observer'),{status:1,stdout:'',stderr:'permission denied'});return actual.execFileSync(...args);},spawn:vi.fn(()=>{spawnState.calls++;return {pid:999999,once:vi.fn(),unref:vi.fn()};})};});
vi.mock('@adhdev/daemon-core',async original=>({...await original<any>(),...await import('../../src/maintenance/lifecycle-source-inventory.js'),getConfigDir:(await import('../../src/config/config.js')).getConfigDir}));
import * as fs from 'node:fs';
import * as path from 'node:path';
import {randomUUID} from 'node:crypto';
import {SessionHostClient} from '@adhdev/session-host-core';
import {MeshRuntimeStore} from '../../src/mesh/mesh-runtime-store.js';
import {createTurnLedger} from '../../src/mesh/turn-ledger/ledger.js';
import {createTurnDeliverHandler,createDeliverEdgeWaiter} from '../../src/mesh/turn-ledger/deliver.js';
import {createNoticeSubmitInventory} from '../../src/mesh/turn-ledger/notice-submit-inventory.js';
import {createSessionInputService} from '../../src/sessions/session-input-service.js';
import {beginLifecycleSource,advanceLifecycleSource,claimLifecycleHelper,collectLifecycleSource,lifecycleProcessIdentity} from '../../src/maintenance/lifecycle-source-inventory.js';
import {spawnDetachedDaemonUpgradeHelper} from '../../src/commands/upgrade-helper.js';
import {resetProcessInstanceContextForTests} from '../../src/config/instance-context.js';
import {DaemonUpdateController} from '../../../../../packages/daemon-cloud/src/daemon-update-controller.js';
let root:string,store:MeshRuntimeStore;
beforeEach(()=>{expect(vi.isMockFunction(SessionHostClient)).toBe(true);isolated.assertEndpoint(isolated.endpoint);root=path.join(isolated.root,randomUUID());fs.mkdirSync(root);process.env.ADHDEV_CONFIG_DIR=root;resetProcessInstanceContextForTests();MeshRuntimeStore.resetForTests();store=MeshRuntimeStore.getInstance();spawnState.calls=0;spawnState.psFailure=false;});
afterEach(()=>{MeshRuntimeStore.resetForTests();resetProcessInstanceContextForTests();});afterAll(()=>isolated.cleanup());
const tick=()=>new Promise<void>(r=>setImmediate(r));
function noticeHarness(mode:'queued'|'delayed'|'missing'='queued',seq=1){
 const ledger=createTurnLedger({db:store.db,selfDaemonId:'self',autoFlush:false}),metadata=createNoticeSubmitInventory(ledger);
 let observe!:(s:'started'|'submitted'|'uncertain')=>void,release!:(v:any)=>void;
 const target={getStatus:()=>({status:'idle'}),...(mode==='missing'?{}:{observeSendWrite:(_id:string,fn:typeof observe)=>{observe=fn;}}),sendMessage:async()=>mode==='delayed'?new Promise<any>(r=>release=r):{status:'queued' as const}};
 const input=createSessionInputService({resolveSession:()=>target});
 const row=ledger.notifyMeshEvent({meshId:'mesh',event:'notice',eventId:`notice-${seq}`,payload:{coordinatorMessage:'PRIVATE-NOTICE'},targetDaemonId:'self'});
 const entry={meshId:'mesh',writer:'writer',seq,kind:'turn.notify',own:true,payload:{eventId:row.eventId,targetDaemonId:'self',notify:'mesh_event',at:Date.now()}};
 const handler=createTurnDeliverHandler({ledger,selfDaemonIds:()=>['self'],port:input,submitInventory:metadata,coordinators:()=>[{sessionId:'coord',idle:true,modalParked:false}],waiter:createDeliverEdgeWaiter({now:Date.now})});
 return {ledger,metadata,run:()=>handler(entry,new AbortController().signal),ack:(s:'started'|'submitted'|'uncertain')=>observe(s),release:(v:any)=>release(v)};
}
it('real turn.deliver + input funnel retain queued intent until exact native ACK; no bodies exported',async()=>{
 const h=noticeHarness();expect((await h.run()).outcome).toBe('queued');expect(h.ledger.store.isDeliveryClaimed('mesh','writer',1)).toBe(true);
 expect(h.metadata.inventory().pending).toHaveLength(1);h.ack('started');expect(h.metadata.inventory().pending).toHaveLength(1);h.ack('uncertain');expect(h.metadata.inventory().pending).toHaveLength(1);
 h.ack('submitted');expect(h.metadata.inventory().pending).toHaveLength(0);expect(h.metadata.inventory().rows[0].state).toBe('submitted');expect(JSON.stringify(h.metadata.inventory())).not.toContain('PRIVATE-');
});
it('unresolved submit promise and missing native observer never become drained; crash reconstructs pending metadata',async()=>{
 const h=noticeHarness('delayed'),pending=h.run();await tick();expect(h.metadata.inventory().active).toHaveLength(1);expect(h.metadata.inventory().pending).toHaveLength(1);
 h.release({status:'queued'});await pending;const restored=createNoticeSubmitInventory(h.ledger);expect(restored.inventory().pending).toHaveLength(1);expect(restored.inventory().active).toHaveLength(0);
 const h2=noticeHarness('missing');await h2.run();expect(h2.metadata.inventory().pending.length).toBeGreaterThan(0);
});
it('native ACK arriving before queued return is terminal; late response cannot erase it',async()=>{
 const h=noticeHarness('delayed'),pending=h.run();await tick();h.ack('submitted');h.release({status:'queued'});await pending;expect(h.metadata.inventory().pending).toHaveLength(0);
});
it('actual detached spawn persists intent/PID before returning; controller death cannot remove it',()=>{
 spawnDetachedDaemonUpgradeHelper({packageName:'adhdev',targetVersion:'1.0.81-rc13',parentPid:process.pid,restartArgv:['fixture.js'],configDir:root});
 expect(spawnState.calls).toBe(1);const first=collectLifecycleSource(root);expect(first.pending).toHaveLength(1);expect(first.rows[0]).toMatchObject({kind:'helper',state:'scheduled',childPid:999999});
 expect(collectLifecycleSource(root).pending[0].operationId).toBe(first.pending[0].operationId);expect(JSON.stringify(first)).not.toContain('ADHDEV_DAEMON_UPGRADE_HELPER');
});
it('helper completion is bound to native incarnation; scheduled result/failed/orphan are not ACKs',()=>{
 const expected={targetVersion:'1.0.81-rc13',packageName:'adhdev',parentPid:process.pid};const id=beginLifecycleSource('helper',expected,root);advanceLifecycleSource(id,'scheduled',{childPid:999999},root);expect(collectLifecycleSource(root).pending).toHaveLength(1);
 expect(()=>advanceLifecycleSource(id,'completed',{},root)).toThrow('completion_owner');const identity=lifecycleProcessIdentity();expect(()=>claimLifecycleHelper(id,{...expected,targetVersion:'wrong'},root)).toThrow('target_changed');claimLifecycleHelper(id,expected,root);expect(()=>claimLifecycleHelper(id,expected,root)).toThrow();
 expect(()=>advanceLifecycleSource(id,'executing',{helper:{...identity,bootNonce:randomUUID()}},root)).toThrow('incarnation_conflict');advanceLifecycleSource(id,'completed',{},root);
 // ACK persisted, but this exact helper incarnation is still alive: not absent.
 expect(collectLifecycleSource(root).pending).toHaveLength(1);advanceLifecycleSource(id,'failed',{},root);expect(collectLifecycleSource(root).pending).toHaveLength(1);
});
it('actual controller retry inventory captures failed verify, pending timer and restart orphan without spawning',async()=>{
 const scheduled:Array<()=>void>=[];const make=()=>new DaemonUpdateController({collectAllStates:()=>[],getUpgradePackageName:()=> 'adhdev',pkgVersion:'1.0.80',evaluateUpgradeCooldown:()=>({suppressed:false}),verifyPublishedTarget:()=>{throw Error('offline fixture');},scheduleRetry:fn=>{scheduled.push(fn);return {cancel(){}};},exit:()=>{throw Error('exit_forbidden');}});
 const c=make();expect(c.maintenanceInventory().pending).toHaveLength(0);c.onForceUpdateRequired({targetVersion:'1.0.81',reason:'force_update_below'});await tick();
 let inventory=c.maintenanceInventory();expect(inventory.observed).toBe(true);expect(inventory.pending.length).toBeGreaterThan(0);expect(inventory.live.retryScheduled).toBe(true);expect(spawnState.calls).toBe(0);
 scheduled[0]();await tick();expect(c.maintenanceInventory().live.retryAttempt).toBe(2);
 const afterRestart=make().maintenanceInventory();expect(afterRestart.observed).toBe(false);expect(afterRestart.reason).toBe('prior_controller_requires_reconciliation');expect(afterRestart.pending.length).toBeGreaterThan(0);
});
it('corrupt/temp lifecycle inventory refuses instead of replacing unknown with zero',()=>{
 expect(collectLifecycleSource(root).observed).toBe(false);beginLifecycleSource('helper',{},root);const dir=path.join(root,'cooperative-lifecycle-source');fs.writeFileSync(path.join(dir,'unfinished.tmp'),'PRIVATE-UNKNOWN');expect(()=>collectLifecycleSource(root)).toThrow('temporary_or_unknown');
});

it('native receipt callback cannot settle another notice attempt sharing its coordinator',async()=>{
 const first=noticeHarness('queued',1),second=noticeHarness('queued',2);await first.run();await second.run();
 first.ack('submitted');expect(first.metadata.inventory().pending).toHaveLength(1);expect(first.metadata.inventory().pending[0].seq).toBe(2);
 second.ack('uncertain');expect(second.metadata.inventory().pending).toHaveLength(1);second.ack('submitted');expect(second.metadata.inventory().pending).toHaveLength(0);
});
it('disposable guarded helper completion needs independently observed native exit; crash intent survives process loss',async()=>{
 const {execFile}=await import('node:child_process');
 expect(process.env.NODE_OPTIONS).toContain('--require');
 const script=path.join(root,'disposable-helper.ts');
 const source=path.resolve('src/maintenance/lifecycle-source-inventory.ts');
 fs.writeFileSync(script,`import {beginLifecycleSource,advanceLifecycleSource,claimLifecycleHelper} from ${JSON.stringify(source)};
 const expected={targetVersion:'1.0.81',packageName:'adhdev',parentPid:process.pid};const id=beginLifecycleSource('helper',expected);claimLifecycleHelper(id,expected);
 if(process.argv[2]==='completed')advanceLifecycleSource(id,'completed');process.stdout.write(id);`);
 const run=(phase:string)=>new Promise<string>((resolve,reject)=>execFile(process.execPath,['--import','tsx',script,phase],{env:{...process.env},timeout:10000},(error,stdout)=>error?reject(error):resolve(stdout.trim())));
 const completed=await run('completed');let inventory=collectLifecycleSource(root);expect(inventory.rows.find((r:any)=>r.operationId===completed)).toMatchObject({state:'completed',native:'absent'});expect(inventory.pending).toHaveLength(0);
 fs.appendFileSync(script,'\n// entry drift');expect(collectLifecycleSource(root).observed).toBe(false);
 const crashed=await run('crashed');inventory=collectLifecycleSource(root);expect(inventory.pending.find((r:any)=>r.operationId===crashed)).toMatchObject({state:'executing',native:'absent'});
});
it('unverified Windows inventory refuses without imposing POSIX journal probes on ordinary controls',()=>{
 const prior=Object.getOwnPropertyDescriptor(process,'platform')!;Object.defineProperty(process,'platform',{...prior,value:'win32'});
 try{
  const c=new DaemonUpdateController({collectAllStates:()=>[],getUpgradePackageName:()=> 'adhdev',pkgVersion:'1.0.80'});c.onAuthOk();expect(c.maintenanceInventory()).toMatchObject({observed:false,reason:'windows_lifecycle_inventory_unverified'});
  spawnDetachedDaemonUpgradeHelper({packageName:'adhdev',targetVersion:'1.0.81',parentPid:process.pid,restartArgv:['fixture.js'],configDir:root});expect(spawnState.calls).toBe(1);expect(fs.existsSync(path.join(root,'cooperative-lifecycle-source'))).toBe(false);
 }finally{Object.defineProperty(process,'platform',prior);}
});

it('unreachable native process facts cannot turn a completed helper receipt into absence',()=>{
 const expected={targetVersion:'1.0.81',packageName:'adhdev',parentPid:process.pid};const id=beginLifecycleSource('helper',expected,root);claimLifecycleHelper(id,expected,root);advanceLifecycleSource(id,'completed',{},root);
 spawnState.psFailure=true;try{const d=collectLifecycleSource(root);expect(d.observed).toBe(false);expect(d.pending[0]).toMatchObject({operationId:id,state:'completed',native:'unknown'});}finally{spawnState.psFailure=false;}
});
