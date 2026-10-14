import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
const fixture = await vi.hoisted(async()=>{
    const {createSessionHostIsolation}=await import('../helpers/session-host-isolation.js');
    return createSessionHostIsolation();
});
const rpc=vi.hoisted(()=>({connect:vi.fn(),request:vi.fn(),close:vi.fn()}));
vi.mock('@adhdev/session-host-core',async original=>({...(await original<any>()),SessionHostClient:vi.fn(function(options:any){fixture.assertEndpoint(options?.endpoint);return rpc;})}));
const writable = vi.hoisted(()=>({adapter:{updateRuntimeMeta:vi.fn()},construct:vi.fn()}));
vi.mock('../../src/providers/cli-provider-instance.js',()=>({CliProviderInstance:vi.fn(function(_p:any,_w:any,_a:any,id:string){writable.construct();return {instanceId:id,getAdapter:()=>writable.adapter};})}));
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as net from 'node:net';
import {createHash} from 'node:crypto';
import {SessionHostClient,type SessionHostRecord} from '@adhdev/session-host-core';
import {DaemonCliManager} from '../../src/commands/cli-manager.js';
import {SessionRegistry} from '../../src/sessions/registry.js';
import {createSessionLifecycleBus} from '../../src/sessions/lifecycle-bus.js';
import {registerMeshCoordinator,loadMeshCoordinatorRegistry} from '../../src/mesh/coordinator-registry.js';
import {observeHeldHostedSessions,retainedRuntimeInventoryDigest,verifyHeldObservationFleet,verifyHeldObservationPromotion} from '../../src/maintenance/held-observation.js';
import {MAINTENANCE_BOOT_NONCE,maintenanceDecisionDigest,writeCooperativeMaintenance,withMaintenanceAdmission,type CooperativeMaintenance} from '../../src/maintenance/cooperative-gate.js';
import {resetProcessInstanceContextForTests} from '../../src/config/instance-context.js';
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
let state:CooperativeMaintenance,manager:DaemonCliManager,registry:SessionRegistry,records:SessionHostRecord[],events:any[],verify:ReturnType<typeof vi.fn>;
beforeEach(()=>{
    // If ESM resolution ever changes, fail BEFORE constructing a transport.
    expect(vi.isMockFunction(SessionHostClient)).toBe(true);fixture.assertEndpoint(fixture.endpoint);
    vi.spyOn(net.Socket.prototype,'connect').mockImplementation(function(){throw new Error('test_native_socket_forbidden');} as any);
    resetProcessInstanceContextForTests();vi.clearAllMocks();
    const prefix=path.join(fixture.root,'retained');fs.mkdirSync(prefix,{recursive:true});
    const files=['host.js','node','pty.node'].map(name=>{const file=path.join(prefix,name);fs.writeFileSync(file,name);return {path:file,sha256:hash(name)};});
    // Preserve enrollment identity across tests; epochs only increase.
    state={schema:1,rolloutId:'held-observer',daemonId:'self',planDigest:hash('plan'),epoch:Date.now(),roster:['self'],meshIds:['mesh'],nodeRoster:[{meshId:'mesh',nodeId:'node',daemonId:'self'}],phase:'held',targetSha256:hash('target'),retainedHost:{pid:123,birth:'native-birth',endpoint:fixture.endpoint.path,entryPath:files[0].path,nodePath:files[1].path,prefix,hostStartedAt:10,files,sessionSetDigest:hash('pending')}};
    fs.mkdirSync(path.join(fixture.root,'daemon'),{recursive:true});
    fs.writeFileSync(path.join(fixture.root,'daemon','mesh-coordinators.json'),'[]');loadMeshCoordinatorRegistry();
    registerMeshCoordinator({meshId:'mesh',sessionId:'coord',cliType:'synthetic-cli',workspace:fixture.root,startedAt:100});
    records=[{sessionId:'coord',runtimeKey:'coord',providerType:'synthetic-cli',category:'cli',transport:'pty',workspace:fixture.root,startedAt:100,osPid:999,lifecycle:'running',meta:{managedBy:'test',providerSessionId:'provider-1'},attachedClients:[],writeOwner:null} as any];
    state.retainedHost.sessionSetDigest=retainedRuntimeInventoryDigest(records,state);writeCooperativeMaintenance(fixture.root,state);
    events=[];const bus=createSessionLifecycleBus();bus.on('registered',e=>events.push(e));bus.on('binding',e=>events.push(e));bus.on('terminated',e=>events.push(e));registry=new SessionRegistry(bus);
    verify=vi.fn().mockResolvedValue(fixture.endpoint);
    manager=new DaemonCliManager({getP2p:()=>null,getInstanceManager:()=>null,getSessionRegistry:()=>registry,hostedRuntimeManagerTag:'test',verifiedRetainedEndpoint:verify}, {getMeta:()=>({category:'cli'}),getByCategory:()=>[]} as any);
    rpc.connect.mockResolvedValue(undefined);rpc.close.mockResolvedValue(undefined);
    rpc.request.mockImplementation(async(r:any)=>{
        if(r.type==='list_sessions')return {success:true,result:structuredClone(records)};
        if(r.type==='attach_session') {expect(r.payload.readOnly).toBe(true);const record=structuredClone(records.find(x=>x.sessionId===r.payload.sessionId))!;record.attachedClients=[{clientId:r.payload.clientId,readOnly:true,type:'daemon',attachedAt:1,lastSeenAt:1}];return {success:true,result:record};}
        throw new Error(`forbidden producer/private request: ${r.type}`);
    });
});
afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();});afterAll(()=>{resetProcessInstanceContextForTests();fixture.cleanup();});
async function open(){const observation=await manager.observeHeldHostedSessions('release-ready');const ready=[{daemonId:'self',bootNonce:MAINTENANCE_BOOT_NONCE,artifactSha256:state.targetSha256,receipt:observation.receipt}];state={...state,phase:'open',release:{ready,committed:ready,decisionDigest:maintenanceDecisionDigest(state,ready)}};writeCooperativeMaintenance(fixture.root,state);}
it('held real manager restore installs silent actual registry/routing metadata with only readonly attaches',async()=>{
    const prune=vi.spyOn(registry,'terminate');const claim=vi.fn();registry.setTranscriptTopicRelease(claim);
    expect(await manager.restoreHostedSessions()).toBe(1);
    const proof=await manager.observeHeldHostedSessions('challenge');
    expect(proof.bindings[0]).toMatchObject({sessionId:'coord',providerSessionId:'provider-1',spawnedAtMs:100,maintenanceObservation:{coordinator:true,meshId:'mesh',daemonId:'self',epoch:state.epoch,bootNonce:MAINTENANCE_BOOT_NONCE}});
    expect(verifyHeldObservationFleet([proof],state,'challenge').coordinators[0].runtimeId).toBe('coord');
    expect(events).toEqual([]);expect(claim).not.toHaveBeenCalled();expect(prune).not.toHaveBeenCalled();expect(manager.adapters.size).toBe(0);
    expect(rpc.request.mock.calls.every(([r]:any)=>['list_sessions','attach_session'].includes(r.type))).toBe(true);expect(verify).toHaveBeenCalledTimes(4);
});
for(const fault of ['missing','unknownOwner','incomplete','unreachable','drift','provider'])it(`held observation refuses ${fault} without pruning existing metadata`,async()=>{
    await observeHeldHostedSessions(manager,'first');
    const before=registry.get('coord');
    if(fault==='missing')records=[];
    if(fault==='unknownOwner')records[0].meta.daemonId='other';
    if(fault==='incomplete')delete records[0].startedAt;
    if(fault==='unreachable')rpc.connect.mockRejectedValue(new Error('unreachable'));
    if(fault==='drift')verify.mockRejectedValue(new Error('native host birth drift'));
    if(fault==='provider')records[0].meta.managedBy='foreign';
    await expect(observeHeldHostedSessions(manager,'next')).rejects.toThrow();expect(registry.get('coord')).toBe(before);expect(events).toEqual([]);
});
it('missing coordinator cannot yield fleet readiness even with complete valid runtime observations',async()=>{
    fs.mkdirSync(path.join(fixture.root,'daemon'),{recursive:true});
    fs.writeFileSync(path.join(fixture.root,'daemon','mesh-coordinators.json'),'[]');loadMeshCoordinatorRegistry();
    state={...state,epoch:state.epoch+1,retainedHost:{...state.retainedHost,sessionSetDigest:retainedRuntimeInventoryDigest(records,state)}};writeCooperativeMaintenance(fixture.root,state);
    const proof=await observeHeldHostedSessions(manager,'missing');expect(proof.coordinators).toEqual([]);
    expect(()=>verifyHeldObservationFleet([proof],state,'missing')).toThrow('maintenance_coordinator_binding_missing_or_ambiguous');
});
it('restart/reclose hides stale routing metadata and rejects old promotion/proof',async()=>{
    const proof=await observeHeldHostedSessions(manager,'old');
    await open();expect(registry.get('coord')).toBeUndefined();
    await withMaintenanceAdmission(()=>verifyHeldObservationPromotion(manager,{runtimeId:'coord',providerType:'synthetic-cli',workspace:fixture.root,startedAt:100}));
    state={...state,epoch:state.epoch+1,phase:'held',release:undefined};writeCooperativeMaintenance(fixture.root,state);
    expect(registry.get('coord')).toBeUndefined();expect(()=>verifyHeldObservationFleet([proof],state,'old')).toThrow('stale');
    await expect(manager.registerCliInstance('coord','synthetic-cli','synthetic-cli',fixture.root,[],{}, {},true,{attachStartedAtMs:100})).rejects.toThrow('cooperative_maintenance_held');
    await observeHeldHostedSessions(manager,'new');await open();
    const restarted=new DaemonCliManager(manager.deps,manager.providerLoader);
    await expect(withMaintenanceAdmission(()=>verifyHeldObservationPromotion(restarted,{runtimeId:'coord',providerType:'synthetic-cli',workspace:fixture.root,startedAt:100}))).rejects.toThrow('maintenance_fresh_observation_required');
});
it('release promotion checks live inventory and exact original binding inside admission lease',async()=>{
    await observeHeldHostedSessions(manager,'ready');await open();
    await expect(withMaintenanceAdmission(()=>verifyHeldObservationPromotion(manager,{runtimeId:'coord',providerType:'synthetic-cli',workspace:fixture.root,startedAt:101}))).rejects.toThrow('binding_drift');
    records[0].osPid=1000;
    await expect(withMaintenanceAdmission(()=>verifyHeldObservationPromotion(manager,{runtimeId:'coord',providerType:'synthetic-cli',workspace:fixture.root,startedAt:100}))).rejects.toThrow('inventory_drift');
});
it('held partial restore callbacks and direct writable attach cannot bypass complete observation',async()=>{
    await expect(manager.restoreHostedSessions([])).rejects.toThrow('complete_inventory');
    await expect(manager.registerCliInstance('coord','synthetic-cli','synthetic-cli',fixture.root,[],{}, {},true)).rejects.toThrow('cooperative_maintenance_held');
    expect(rpc.request).not.toHaveBeenCalled();
});
it('actual held S8 boot observes sessions without entering producer loops',async()=>{
    const {startLoops}=await import('../../src/boot/stages/loops.js');
    const start=vi.fn();const dispose=await startLoops({cfg:{restoreHostedSessions:true},components:{},cliManager:manager,poller:{start},instanceManager:{startTicking:start},cdpInitializer:{startPeriodicScan:start}} as any);
    expect(registry.get('coord')?.maintenanceObservation?.coordinator).toBe(true);expect(start).not.toHaveBeenCalled();dispose();
});
it('native endpoint is reverified after inventory and any drift refuses registry commit',async()=>{
    verify.mockResolvedValueOnce(fixture.endpoint).mockRejectedValueOnce(new Error('fresh native birth drift'));
    await expect(observeHeldHostedSessions(manager,'drift-after-attach')).rejects.toThrow('birth drift');expect(registry.list()).toEqual([]);expect(events).toEqual([]);
});
it('close is excluded during observation ACK; wrong readOnly/owner ACK refuses without producer effects',async()=>{
    let finish!:(v:any)=>void;const original=rpc.request.getMockImplementation()!;
    rpc.request.mockImplementation(async(r:any)=>r.type==='attach_session'?new Promise(resolve=>{finish=resolve;}):original(r));
    const pending=observeHeldHostedSessions(manager,'ACK');await vi.waitFor(()=>expect(finish).toBeTypeOf('function'));
    expect(()=>writeCooperativeMaintenance(fixture.root,{...state,epoch:state.epoch+1})).toThrow('maintenance_operation_in_flight');
    finish({success:true,result:{...records[0],attachedClients:[{clientId:'unexpected',readOnly:false}]}});
    await expect(pending).rejects.toThrow('readonly_attach');expect(registry.list()).toEqual([]);
});
it('held Windows observation refuses before any native endpoint or IPC effect',async()=>{
    const descriptor=Object.getOwnPropertyDescriptor(process,'platform')!;Object.defineProperty(process,'platform',{value:'win32'});
    try{await expect(observeHeldHostedSessions(manager,'win')).rejects.toThrow('held_observation_required');expect(verify).not.toHaveBeenCalled();expect(rpc.request).not.toHaveBeenCalled();}finally{Object.defineProperty(process,'platform',descriptor);}
});
it('release certificate must commit the actual held observation receipt',async()=>{
    await observeHeldHostedSessions(manager,'ready');await open();
    const ready=state.release!.ready.map(r=>({...r,receipt:hash('unrelated-ready')}));state={...state,release:{ready,committed:ready,decisionDigest:maintenanceDecisionDigest(state,ready)}};
    writeCooperativeMaintenance(fixture.root,state);
    await expect(withMaintenanceAdmission(()=>verifyHeldObservationPromotion(manager,{runtimeId:'coord',providerType:'synthetic-cli',workspace:fixture.root,startedAt:100}))).rejects.toThrow('fresh_observation');
});
it('S3 IDE callbacks and outer control cannot attach producers or fetch snapshots while held',async()=>{
    const {bootSessionCore}=await import('../../src/boot/stages/session-core.js');
    const {DaemonCdpInitializer}=await import('../../src/cdp/initializer.js');
    const {SessionHostController}=await import('../../src/session-host/session-host-controller.js');
    const connect=vi.spyOn(DaemonCdpInitializer.prototype,'connectAll').mockResolvedValue(undefined);
    const stage=await bootSessionCore({cfg:{sessionHost:{}},providerLoader:manager.providerLoader,channelBootSync:Promise.resolve({activated:0}),stalenessProbe:{onStale:vi.fn(),onActivated:vi.fn()},detectedIdes:{value:[]}} as any);
    expect(connect).not.toHaveBeenCalled();
    const callbacks=(stage.cdpInitializer as any).config;
    await callbacks.onConnected('synthetic',{},'key');await callbacks.onDisconnected('synthetic',{},'key');
    expect(stage.instanceManager.listInstanceIds()).toEqual([]);
    const control=new SessionHostController(fixture.endpoint);
    await expect(control.getSnapshot('coord')).rejects.toThrow('cooperative_maintenance_held');
    await expect(control.acquireWrite({sessionId:'coord',clientId:'synthetic',ownerType:'agent'})).rejects.toThrow('cooperative_maintenance_held');
    expect(rpc.request).not.toHaveBeenCalled();
    stage.disposeLiveness();await stage.disposeSessionCore();
});

it('actual released manager promotion registers routing only under ACK-spanning admission and reclose refuses reattach',async()=>{
    await manager.observeHeldHostedSessions('prepare');await open();vi.useFakeTimers();
    let acknowledge!:()=>void, entered!:()=>void;
    const entering=new Promise<void>(resolve=>{entered=resolve;});
    const add=vi.fn(async()=>{entered();await new Promise<void>(resolve=>{acknowledge=resolve;});});
    manager.deps.getInstanceManager=()=>({addInstance:add,removeInstance:vi.fn()}) as any;
    const pending=manager.registerCliInstance('coord','synthetic-cli','synthetic-cli',fixture.root,[],{}, {meshCoordinatorFor:'mesh'},true,{attachStartedAtMs:100,providerSessionId:'provider-1'});
    await entering;expect(()=>writeCooperativeMaintenance(fixture.root,{...state,phase:'held',epoch:state.epoch+1,release:undefined})).toThrow('maintenance_operation_in_flight');
    acknowledge();await pending;expect(add).toHaveBeenCalledTimes(1);expect(registry.get('coord')?.maintenanceObservation).toBeUndefined();expect(events.some(e=>e.kind==='registered')).toBe(true);
    state={...state,epoch:state.epoch+1,phase:'held',release:undefined};writeCooperativeMaintenance(fixture.root,state);
    await expect(manager.registerCliInstance('coord','synthetic-cli','synthetic-cli',fixture.root,[],{}, {meshCoordinatorFor:'mesh'},true,{attachStartedAtMs:100})).rejects.toThrow('cooperative_maintenance_held');expect(add).toHaveBeenCalledTimes(1);
});
it('released incomplete ordinary restore inventory preserves coordinator/session metadata',async()=>{
    await manager.observeHeldHostedSessions('prepare');await open();
    manager.deps.getInstanceManager=()=>({getInstance:()=>undefined}) as any;manager.deps.listHostedCliRuntimes=async()=>[];
    await expect(manager.restoreHostedSessions()).rejects.toThrow('complete_promotion_inventory');
    const persisted=JSON.parse(fs.readFileSync(path.join(fixture.root,'daemon','mesh-coordinators.json'),'utf8'));expect(persisted[0].sessionId).toBe('coord');
});
it('outer host event callback is suppressed while held and observer endpoint uses native ensure on every challenge',async()=>{
    const {bootSessionHost}=await import('../../src/session-host/host-bootstrap.js');
    let callback!:(e:any)=>void;const seen=vi.fn();const ensure=vi.fn().mockResolvedValue(fixture.endpoint);
    const handle=await bootSessionHost({ensureReady:ensure,clientId:'self',managedBy:'adhdev-cloud',onHostEvent:seen,createController:(_endpoint,cb)=>{callback=cb;return {start:vi.fn(),stop:vi.fn()} as any;}});
    callback({type:'runtime_transition'});expect(seen).not.toHaveBeenCalled();
    await handle.bootConfig().verifiedRetainedEndpoint!();expect(ensure).toHaveBeenCalledTimes(2);await handle.stop();
});

it('actual router serves fresh held challenge proof without granting producer admission',async()=>{
    const {DaemonCommandRouter}=await import('../../src/commands/router.js');
    const router=new DaemonCommandRouter({commandHandler:{handle:vi.fn()} as any});
    router.attachComponents({router,cliManager:manager,sessionRegistry:registry} as any);
    try {
        const result=await router.execute('cooperative_maintenance_observe',{nonce:'router-challenge'},'ipc');
        expect(result).toMatchObject({success:true,observation:{challenge:'router-challenge',epoch:state.epoch,bootNonce:MAINTENANCE_BOOT_NONCE}});
        expect(await router.execute('launch_cli',{},'ipc')).toMatchObject({success:false,error:'cooperative_maintenance_held'});
    } finally {router.meshNodeStatePusher.stop();router.localMeshNodeGitWatch.stop();}
});
it('fleet proof refuses stale challenge/boot-binding or a coordinator boolean inconsistent with actual registry binding',async()=>{
    const proof=await observeHeldHostedSessions(manager,'fresh');
    expect(()=>verifyHeldObservationFleet([proof],state,'other')).toThrow('stale');
    for(const fault of ['boot','coordinator','provider']){
        const changed=structuredClone(proof);
        if(fault==='boot')changed.bindings[0].maintenanceObservation.bootNonce='old-boot';
        if(fault==='coordinator')changed.bindings[0].maintenanceObservation.coordinator=false;
        if(fault==='provider')changed.bindings[0].providerSessionId='other';
        const {receipt,...body}=changed;changed.receipt=createHash('sha256').update(JSON.stringify(body)).digest('hex');
        expect(()=>verifyHeldObservationFleet([changed],state,'fresh')).toThrow('binding_missing');
    }
});

it('real held observers on host/member yield exact fleet coordinator routing; remote owner drift fails the join',async()=>{
    const originalRecords=records;
    const collect=async(daemonId:string)=>{
        const config=path.join(fixture.root,`fleet-${daemonId}`), endpoint=fixture.endpointFor(daemonId);
        fs.mkdirSync(path.join(config,'daemon'),{recursive:true});process.env.ADHDEV_CONFIG_DIR=config;resetProcessInstanceContextForTests();
        fs.writeFileSync(path.join(config,'daemon','mesh-coordinators.json'),'[]');loadMeshCoordinatorRegistry();
        if(daemonId==='self')registerMeshCoordinator({meshId:'mesh',sessionId:'coord',cliType:'synthetic-cli',workspace:fixture.root,startedAt:100});
        records=daemonId==='self'?structuredClone(originalRecords):[{...structuredClone(originalRecords[0]),sessionId:'worker',runtimeKey:'worker',osPid:1001,meta:{managedBy:'test',providerSessionId:'worker-native',meshNodeFor:'mesh',meshNodeId:'peer-node',meshCoordinatorDaemonId:'self'}}];
        const local:CooperativeMaintenance={...state,daemonId,epoch:1,roster:['self','peer'],nodeRoster:[...state.nodeRoster,{meshId:'mesh',nodeId:'peer-node',daemonId:'peer'}],retainedHost:{...state.retainedHost,endpoint:endpoint.path}};
        local.retainedHost.sessionSetDigest=retainedRuntimeInventoryDigest(records,local);writeCooperativeMaintenance(config,local);
        const localManager=new DaemonCliManager({...manager.deps,getSessionRegistry:()=>new SessionRegistry(),verifiedRetainedEndpoint:async()=>endpoint},manager.providerLoader);
        // A real registry must be stable throughout a challenge.
        const localRegistry=new SessionRegistry();localManager.deps.getSessionRegistry=()=>localRegistry;
        return {local,proof:await observeHeldHostedSessions(localManager,'fleet-challenge')};
    };
    try {
        const host=await collect('self'),member=await collect('peer');
        expect(member.proof.coordinators).toEqual([]);
        const joined=verifyHeldObservationFleet([host.proof,member.proof],host.local,'fleet-challenge');expect(joined.coordinators[0].runtimeId).toBe('coord');
        const drift=structuredClone(member.proof);drift.sessions[0].workOwner='peer';const {receipt,...body}=drift;drift.receipt=createHash('sha256').update(JSON.stringify(body)).digest('hex');
        expect(()=>verifyHeldObservationFleet([host.proof,drift],host.local,'fleet-challenge')).toThrow('coordinator_route_drift');
    } finally {process.env.ADHDEV_CONFIG_DIR=fixture.root;resetProcessInstanceContextForTests();records=originalRecords;}
});
it('actual held provider boot skips channel activation/version probes and deferred availability callback refuses',async()=>{
    const {ProviderLoader}=await import('../../src/providers/provider-loader.js');
    const {bootProviders}=await import('../../src/boot/stages/providers.js');
    const detector=await import('../../src/detection/cli-detector.js');
    vi.spyOn(ProviderLoader.prototype,'loadAll').mockImplementation(()=>{});
    const first=vi.spyOn(ProviderLoader.prototype,'maybeFirstSyncVerifiedChannel');
    const update=vi.spyOn(ProviderLoader.prototype,'maybeSyncVerifiedChannelOnDaemonUpdate');
    const auto=vi.spyOn(ProviderLoader.prototype,'runAutoUpdate');
    const detect=vi.spyOn(detector,'detectCLIs');
    const stage=await bootProviders({cfg:{sessionHost:{},statusVersion:'synthetic'},appConfig:{}} as any);
    try {
        expect(await stage.channelBootSync).toEqual({activated:0});
        await expect(stage.refreshProviderAvailability()).rejects.toThrow('cooperative_maintenance_held');
        expect(first).not.toHaveBeenCalled();expect(update).not.toHaveBeenCalled();expect(auto).not.toHaveBeenCalled();expect(detect).not.toHaveBeenCalled();
    } finally {stage.stalenessProbe.stop();}
});
it('S7 held ledger wiring does not republish pending rows or deliver backlog on restore bus edges',async()=>{
    const {wireTurnLedger}=await import('../../src/boot/stages/mesh-runtime.js');
    const runtimeLedger=await import('../../src/mesh/turn-ledger/runtime-ledger.js');
    const original=runtimeLedger.createMeshRuntimeTurnLedger;const republish=vi.fn().mockRejectedValue(new Error('held republish forbidden'));
    vi.spyOn(runtimeLedger,'createMeshRuntimeTurnLedger').mockImplementation((...args:any[])=>{const ledger=original(...args as Parameters<typeof original>);ledger.republishPending=republish;return ledger;});
    const bus=createSessionLifecycleBus();const submit=vi.fn();
    const components={bus,instanceManager:{setTurnEvidencePort:vi.fn(),listInstanceIds:()=>[],getInstance:()=>undefined},cliManager:{input:{submit}},seqscribe:null,statusInstanceId:'self'} as any;
    const wiring=wireTurnLedger(components,{runMigration:false});
    try {await wiring.republished;expect(await wiring.deliverBacklog()).toBe(0);bus.emit({kind:'registered',sessionId:'coord',at:Date.now(),origin:'restore',session:{sessionId:'coord'}} as any);expect(republish).not.toHaveBeenCalled();expect(submit).not.toHaveBeenCalled();}finally{wiring.dispose();}
});

it('S8 promotion failure precedes every producer and orphan/binding cleanup',async()=>{
    await manager.observeHeldHostedSessions('prepare');await open();const {startLoops}=await import('../../src/boot/stages/loops.js');
    const effect=vi.fn();const cleanup=vi.spyOn(registry,'terminate');
    const stage={cfg:{restoreHostedSessions:true},components:{},cliManager:{restoreHostedSessions:vi.fn().mockRejectedValue(new Error('incomplete native inventory'))},poller:{start:effect},instanceManager:{startTicking:effect},cdpInitializer:{startPeriodicScan:effect}} as any;
    await expect(startLoops(stage)).rejects.toThrow('incomplete native inventory');expect(effect).not.toHaveBeenCalled();expect(cleanup).not.toHaveBeenCalled();
});
for(const failure of ['register','existing'])it(`released ${failure} binding cannot become a partial successful restore or prune metadata`,async()=>{
    await manager.observeHeldHostedSessions('prepare');await open();
    manager.deps.getInstanceManager=()=>({getInstance:()=>undefined}) as any;
    manager.deps.listHostedCliRuntimes=async()=>[{runtimeId:'coord',cliType:'synthetic-cli',workspace:fixture.root,startedAtMs:100,providerSessionId:'provider-1',managedBy:'test',lifecycle:'running'}];
    Object.assign(manager.providerLoader,{resolveAlias:(v:string)=>v,resolve:()=>({type:'synthetic-cli',category:'cli'}),getSettings:()=>({})});
    if(failure==='existing')manager.adapters.set('coord',{} as any);else vi.spyOn(manager,'registerCliInstance').mockRejectedValue(new Error('synthetic native ACK failure'));
    await expect(manager.restoreHostedSessions()).rejects.toThrow(failure==='existing'?'requires_reconciliation':'native ACK failure');
    expect(JSON.parse(fs.readFileSync(path.join(fixture.root,'daemon','mesh-coordinators.json'),'utf8'))[0].sessionId).toBe('coord');
});
it('held observation routing expires without deleting metadata and requires a new actual challenge',async()=>{
    vi.useFakeTimers();await observeHeldHostedSessions(manager,'initial');expect(registry.has('coord')).toBe(true);
    vi.advanceTimersByTime(10_001);expect(registry.has('coord')).toBe(false);expect(registry.resolveAlias('provider-1')).toBeNull();
    expect((registry as any).bySessionId.has('coord')).toBe(true);
    await observeHeldHostedSessions(manager,'fresh');expect(registry.has('coord')).toBe(true);expect(events).toEqual([]);
});
