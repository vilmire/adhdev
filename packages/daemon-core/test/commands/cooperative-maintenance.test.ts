import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { MAINTENANCE_BOOT_NONCE, MAINTENANCE_FILE, assertMaintenanceAdmission, assertMaintenanceNode, assertMaintenanceDaemon, assertMaintenanceLifecycle, captureMaintenanceAdmission, maintenanceHeld,
    maintenanceDecisionDigest, readCooperativeMaintenance, verifyRetainedMaintenanceHost, withMaintenanceAdmission, withMaintenanceEffect,
    writeCooperativeMaintenance, type CooperativeMaintenance } from '../../src/maintenance/cooperative-gate.js';
import { bootDaemonRuntime } from '../../src/boot/daemon-runtime.js';
import { startLoops } from '../../src/boot/stages/loops.js';
import { DaemonCommandRouter } from '../../src/commands/router.js';
import { createSessionInputService } from '../../src/sessions/session-input-service.js';
import { tryAssignQueueTask } from '../../src/mesh/mesh-queue-assignment.js';
import { maybeAutoLaunchOneQueueSession } from '../../src/mesh/mesh-queue-autolaunch.js';
import { createManagedSessionHost } from '../../src/session-host/managed-host.js';
import { resetProcessInstanceContextForTests } from '../../src/config/instance-context.js';
const hash = (v: string) => createHash('sha256').update(v).digest('hex');
let root: string, state: CooperativeMaintenance;
const cleanup: Array<() => void> = [];
beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cooperative-maintenance-test-')));
    vi.stubEnv('ADHDEV_CONFIG_DIR', root); resetProcessInstanceContextForTests();
    const prefix = path.join(root, 'old-prefix'); fs.mkdirSync(prefix);
    const files = ['host.js','node','pty.node'].map(name => { const file = path.join(prefix,name); fs.writeFileSync(file,name); return { path:file,sha256:hash(name) }; });
    state = { schema:1,rolloutId:'synthetic',daemonId:'daemon-self',planDigest:hash('plan'),epoch:0,roster:['daemon-self','daemon-peer'],meshIds:['mesh'],nodeRoster:[{meshId:'mesh',nodeId:'node',daemonId:'daemon-self'}],phase:'held',targetSha256:hash('target'),
        retainedHost:{pid:321,birth:'native-birth',endpoint:'/synthetic/host.sock',entryPath:files[0].path,nodePath:files[1].path,prefix,hostStartedAt:123,files,sessionSetDigest:hash('idle-owner-set')} };
});
afterEach(() => { cleanup.splice(0).reverse().forEach(f=>f()); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); resetProcessInstanceContextForTests(); fs.rmSync(root,{recursive:true,force:true}); });
function open() {
    const ready = state.roster.map(daemonId=>({daemonId,bootNonce:daemonId===state.daemonId?MAINTENANCE_BOOT_NONCE:'peer-boot',artifactSha256:state.targetSha256,receipt:hash(daemonId)}));
    state={...state,phase:'open',release:{ready,committed:ready,decisionDigest:maintenanceDecisionDigest(state,ready)}};
    writeCooperativeMaintenance(root,state);
}

it('absent gate preserves ordinary operation; enrolled/missing/corrupt state stays closed', () => {
    expect(readCooperativeMaintenance()).toBeNull(); assertMaintenanceAdmission();
    writeCooperativeMaintenance(root,state); expect(maintenanceHeld()).toBe(true);
    fs.renameSync(path.join(root,MAINTENANCE_FILE),path.join(root,'preserved-state.json'));
    expect(()=>assertMaintenanceAdmission()).toThrow('maintenance_state_unavailable');
    fs.writeFileSync(path.join(root,MAINTENANCE_FILE),'broken',{mode:0o600});
    expect(()=>assertMaintenanceAdmission()).toThrow();
});
it('interrupted marker-first enrollment can resume only held, never open', () => {
    fs.writeFileSync(path.join(root,'cooperative-maintenance.enrolled'),JSON.stringify(state),{mode:0o600});
    expect(()=>assertMaintenanceAdmission()).toThrow();
    expect(()=>open()).toThrow(); state.phase='held'; delete state.release;
    writeCooperativeMaintenance(root,state); expect(maintenanceHeld()).toBe(true);
});
it('invalid gate refuses before the first injected boot stage', async () => {
    fs.writeFileSync(path.join(root,MAINTENANCE_FILE),'{}',{mode:0o600});
    const bootPlatform=vi.fn(); await expect(bootDaemonRuntime({} as any,{bootPlatform} as any)).rejects.toThrow();
    expect(bootPlatform).not.toHaveBeenCalled();
});
it('expected target maintenance plan refuses missing enrollment before boot, without granting any authority', async () => {
    vi.stubEnv('ADHDEV_COOPERATIVE_MAINTENANCE_PLAN',state.planDigest);
    const bootPlatform=vi.fn(); await expect(bootDaemonRuntime({} as any,{bootPlatform} as any)).rejects.toThrow('maintenance_state_unavailable');
    expect(bootPlatform).not.toHaveBeenCalled();
    writeCooperativeMaintenance(root,state); expect(maintenanceHeld()).toBe(true);
});
it('held boot arms no work loops, discovery, hosted restore or deferred producers', async () => {
    writeCooperativeMaintenance(root,state); vi.useFakeTimers();
    // The actual cloud CLI labels its foreground daemon entry cli_start.
    // It may enter held boot; updater/restart launchers remain refused.
    expect(()=>assertMaintenanceLifecycle('cli_start')).not.toThrow();
    expect(()=>assertMaintenanceLifecycle('cli_spawn')).toThrow('maintenance_external_driver_owns_lifecycle');
    const touched=vi.fn(); const dispose=await startLoops({cfg:{restoreHostedSessions:true},components:{},cdpInitializer:{startDiscovery:touched},cliManager:{restoreHostedSessions:touched}} as any);
    await vi.advanceTimersByTimeAsync(1000); expect(touched).not.toHaveBeenCalled(); dispose();
});
it('open needs every distinct ready/commit identity, correct pin and this fresh boot', () => {
    open(); expect(maintenanceHeld()).toBe(false);
    state.release!.committed=state.release!.committed.slice(1); expect(()=>writeCooperativeMaintenance(root,state)).toThrow('maintenance_release_invalid');
    state.release!.committed=state.release!.ready;
    state.release!.ready[0].bootNonce='previous-process'; state.release!.decisionDigest=maintenanceDecisionDigest(state,state.release!.ready);
    writeCooperativeMaintenance(root,state); expect(maintenanceHeld()).toBe(true);
});
it('mesh-less/direct/new mesh admissions remain closed; unknown meshes remain refused after release', async () => {
    writeCooperativeMaintenance(root,state);
    const router=new DaemonCommandRouter({commandHandler:{handle:vi.fn()} as any});
    cleanup.push(()=>{router.meshNodeStatePusher.stop();router.localMeshNodeGitWatch.stop();});
    for(const command of ['agent_command','send_chat','launch_cli','daemon_upgrade','mesh_enqueue_task']) {
        expect(await router.execute(command,{},'ipc')).toMatchObject({success:false,error:'cooperative_maintenance_held'});
    }
    open(); expect(()=>assertMaintenanceAdmission(['unseen-mesh'])).toThrow();
    expect(await router.execute('agent_command',{meshId:'mesh',nodeId:'newly-appearing-node'},'ipc')).toMatchObject({success:false,error:'maintenance_unknown_node_or_owner'});
    expect(()=>assertMaintenanceDaemon('newly-appearing-daemon')).toThrow('maintenance_unknown_daemon');
    expect(()=>assertMaintenanceNode('mesh','node','daemon-peer')).toThrow('maintenance_unknown_node_or_owner');
    expect(()=>assertMaintenanceLifecycle('auto_update')).toThrow('maintenance_external_driver_owns_lifecycle');
});
it('router rechecks maintenance after its awaited sender gate, before effects', async () => {
    open(); const router=new DaemonCommandRouter({commandHandler:{handle:vi.fn()} as any});
    cleanup.push(()=>{router.meshNodeStatePusher.stop();router.localMeshNodeGitWatch.stop();});
    let release!: (v:null)=>void;
    const waiting=new Promise<null>(resolve=>{release=resolve;});
    vi.spyOn(router as any,'gateMeshSender').mockReturnValue(waiting);
    const effect=vi.spyOn(router as any,'runSpec').mockResolvedValue({success:true});
    const result=router.execute('agent_command',{meshId:'mesh'},'mesh');
    state={...state,epoch:1,phase:'held',release:undefined}; writeCooperativeMaintenance(root,state); release(null);
    await expect(result).rejects.toThrow('cooperative_maintenance_held'); expect(effect).not.toHaveBeenCalled();
});
it('queue and auto-launch refuse before accessing producer dependencies', async () => {
    writeCooperativeMaintenance(root,state);
    expect(tryAssignQueueTask({} as any,'mesh','node','session','codex')).toBe(false);
    expect(await maybeAutoLaunchOneQueueSession({} as any,'mesh',{})).toBe(false);
});
it('direct submit refuses without resolving/writing a retained owner session', async () => {
    writeCooperativeMaintenance(root,state); const resolve=vi.fn();
    const input=createSessionInputService({resolveSession:resolve});
    const result=await input.submit({messageId:'synthetic',sessionId:'owner',origin:'mesh',policy:{mode:'queue'},input:{parts:[{type:'text',text:'synthetic'}],textFallback:'synthetic'}} as any);
    expect(result).toMatchObject({kind:'refused'}); expect(resolve).not.toHaveBeenCalled();
});
it('gate close cannot cross a native submit awaiting its ACK; retry closes after drain', async () => {
    open(); let finish!:()=>void;
    const pending=withMaintenanceAdmission(()=>new Promise<void>(resolve=>{finish=resolve;}));
    const closed={...state,epoch:1,phase:'held' as const,release:undefined};
    expect(()=>writeCooperativeMaintenance(root,closed)).toThrow('maintenance_operation_in_flight');
    expect(maintenanceHeld()).toBe(false); finish(); await pending;
    writeCooperativeMaintenance(root,closed); expect(maintenanceHeld()).toBe(true);
});
it('async native child retains the writer lock after a synchronous queue turn returns', async () => {
    open(); let finish!:()=>void, pending!:Promise<void>;
    withMaintenanceEffect(()=>{ pending=withMaintenanceAdmission(()=>new Promise<void>(resolve=>{finish=resolve;})); });
    expect(()=>writeCooperativeMaintenance(root,{...state,epoch:1,phase:'held',release:undefined})).toThrow('maintenance_operation_in_flight');
    finish(); await pending; writeCooperativeMaintenance(root,{...state,epoch:1,phase:'held',release:undefined});
});
it('close/reopen uses a new epoch; old await continuations cannot reenter', () => {
    open(); const check=captureMaintenanceAdmission();
    expect(()=>writeCooperativeMaintenance(root,{...state,phase:'held',release:undefined})).toThrow('maintenance_new_epoch_required');
    state={...state,phase:'held',epoch:1,release:undefined}; writeCooperativeMaintenance(root,state); open(); expect(check).toThrow('maintenance_epoch_changed');
});
it('retained host facts bind PID, socket owner, birth, Node, entry and every dependency', () => {
    const h=state.retainedHost; const facts={pid:h.pid,socketOwnerPid:h.pid,birth:h.birth,entryPath:h.entryPath,nodePath:h.nodePath,endpoint:h.endpoint,hostEntryPath:h.entryPath,hostStartedAt:h.hostStartedAt};
    verifyRetainedMaintenanceHost(state,facts);
    for(const field of ['pid','socketOwnerPid','birth','nodePath','hostStartedAt']) expect(()=>verifyRetainedMaintenanceHost(state,{...facts,[field]:'wrong'} as any)).toThrow();
    fs.writeFileSync(h.files[2].path,'drift'); expect(()=>verifyRetainedMaintenanceHost(state,facts)).toThrow('maintenance_retained_dependency_changed');
});
it('enrollment refuses host kill/spawn before any native effect, including after reopen', () => {
    writeCooperativeMaintenance(root,state); const kill=vi.spyOn(process,'kill');
    const host=createManagedSessionHost({appName:'synthetic',requiredRequestTypes:[]});
    expect(()=>host.killPid(321)).toThrow('maintenance_retained_host_mutation_refused');
    expect(()=>host.spawnHost()).toThrow('maintenance_retained_host_mutation_refused');
    open(); expect(()=>host.stopManagedSessionHostProcess()).toThrow('maintenance_retained_host_mutation_refused');
    expect(kill).not.toHaveBeenCalled();
});

it('router rejects nested launch/join identities, including reassignment to an enrolled daemon', async () => {
    open(); const router=new DaemonCommandRouter({commandHandler:{handle:vi.fn()} as any});
    cleanup.push(()=>{router.meshNodeStatePusher.stop();router.localMeshNodeGitWatch.stop();});
    const effect=vi.spyOn(router as any,'runSpec').mockResolvedValue({success:true});
    for(const args of [
        {settings:{meshNodeFor:'mesh',meshNodeId:'unknown'}},
        {settings:{meshCoordinatorFor:'mesh',meshNodeId:'unknown'}},
        {meshId:'mesh',memberNode:{id:'unknown',daemonId:'daemon-self'}},
        {meshId:'mesh',memberNode:{id:'node',daemonId:'daemon-peer'}},
        {meshId:'mesh',memberNodeId:'unknown'},
        {meshId:'mesh',settings:{meshNodeFor:'other',meshNodeId:'node'}},
    ]) {
        const result=await router.execute('memberNode' in args || 'memberNodeId' in args ? 'apply_mesh_host_join':'launch_cli',args,'ipc');
        expect(result.success).toBe(false);
    }
    expect(effect).not.toHaveBeenCalled();
});
it('final launch consumer refuses nested unknown node or changed owner before spawn', async () => {
    open(); const {startSession}=await import('../../src/commands/cli-manager-launch.js');
    const spawn=vi.fn(); const host={createAdapter:spawn} as any;
    for(const settings of [
        {meshNodeFor:'mesh',meshNodeId:'unknown'},
        {meshNodeFor:'mesh',meshNodeId:'node',daemonId:'daemon-peer'},
    ]) await expect(startSession(host,'synthetic',root,[],undefined,{settingsOverride:settings})).rejects.toThrow('maintenance_unknown_node_or_owner');
    expect(spawn).not.toHaveBeenCalled();
});
it('final pairing consumer refuses roster mutation with resolved mesh identity before token consumption', async () => {
    open(); const {applyMeshHostJoinRequest}=await import('../../src/config/mesh-config-host-pairing.js');
    const config=JSON.stringify({meshes:[{id:'mesh',name:'synthetic',nodes:[{id:'node',workspace:root,daemonId:'daemon-self'}]}]});
    fs.writeFileSync(path.join(root,'meshes.json'),config);
    for(const [id,daemonId,error] of [['unknown','daemon-self','maintenance_unknown_node_or_owner'],['node','daemon-peer','maintenance_unknown_node_or_owner'],['node','daemon-self','maintenance_roster_transition_required']]) {
        expect(()=>applyMeshHostJoinRequest('mesh',{token:'synthetic',memberNode:{id,daemonId,workspace:root} as any})).toThrow(error);
        expect(fs.readFileSync(path.join(root,'meshes.json'),'utf8')).toBe(config);
    }
});
it('hosted void stop owns admission until ACK; queued stale-epoch stop/resize/clear have no effects', async () => {
    open(); const {SessionHostClient}=await import('@adhdev/session-host-core');
    const {SessionHostPtyTransportFactory}=await import('../../src/cli-adapters/session-host-transport.js');
    vi.spyOn(SessionHostClient.prototype,'connect').mockResolvedValue(undefined);
    vi.spyOn(SessionHostClient.prototype,'onEvent').mockReturnValue(()=>{});
    vi.spyOn(SessionHostClient.prototype,'close').mockResolvedValue(undefined);
    let ack!:()=>void;
    const request=vi.spyOn(SessionHostClient.prototype,'request').mockImplementation(async (r:any)=>{
        if(r.type==='stop_session')await new Promise<void>(resolve=>{ack=resolve;});
        return {success:true,result:{sessionId:'runtime',attachedClients:[],meta:{}}} as any;
    });
    const net=await import('node:net');
    vi.spyOn(net.Socket.prototype,'connect').mockImplementation(function(){throw new Error('test_native_socket_forbidden');} as any);
    expect(vi.isMockFunction(SessionHostClient.prototype.request)).toBe(true);
    const endpoint={kind:'unix' as const,path:path.join(root,'nonexistent-test-host.sock')};
    expect(fs.existsSync(endpoint.path)).toBe(false);
    const factory=new SessionHostPtyTransportFactory({endpoint,clientId:'synthetic',runtimeId:'runtime',providerType:'synthetic',workspace:root});
    const transport=factory.spawn('synthetic',[],{cwd:root,env:{},cols:80,rows:24}) as any;
    await transport.ready; transport.kill();
    await vi.waitFor(()=>expect(ack).toBeTypeOf('function'));
    const closed={...state,epoch:1,phase:'held' as const,release:undefined};
    expect(()=>writeCooperativeMaintenance(root,closed)).toThrow('maintenance_operation_in_flight');
    ack(); await transport.operationChain;
    let release!:()=>void; transport.operationChain=new Promise<void>(resolve=>{release=resolve;});
    request.mockClear(); transport.kill(); transport.resize(120,40); transport.clearBuffer();
    writeCooperativeMaintenance(root,closed); state=closed; open(); release(); await transport.operationChain;
    expect(request).not.toHaveBeenCalled();
    // Detach and metadata remain safe without producer admission, even held.
    state={...state,epoch:2,phase:'held',release:undefined};writeCooperativeMaintenance(root,state);
    transport.detach();transport.updateMeta({label:'metadata'});await transport.operationChain;
    expect(request.mock.calls.map(c=>(c[0] as any).type)).toEqual(['release_write','detach_session','update_session_meta']);
});

it('resolved provider settings and actual local launch owner are checked after detection await', async () => {
    state.nodeRoster.push({meshId:'mesh',nodeId:'peer-node',daemonId:'daemon-peer'}); open();
    const detector=await import('../../src/detection/cli-detector.js');
    const {startSession}=await import('../../src/commands/cli-manager-launch.js');
    let finish!:(v:any)=>void;
    vi.spyOn(detector,'detectCLI').mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
    const spawn=vi.fn(); let settings:any={meshNodeFor:'mesh',meshNodeId:'node'};
    const host={createAdapter:spawn,providerLoader:{resolveAlias:()=> 'synthetic',getByAlias:()=>undefined,getSettings:()=>settings}} as any;
    const result=startSession(host,'synthetic',root);
    // Provider resolution changes during await: an enrolled remote owner is
    // still not the actual owner of a local PTY launch.
    settings={meshNodeFor:'mesh',meshNodeId:'peer-node',daemonId:'daemon-peer'};
    finish({version:'synthetic'});
    await expect(result).rejects.toThrow('maintenance_unknown_node_or_owner');expect(spawn).not.toHaveBeenCalled();
});
it('local PTY kill and resize refuse held state before harmless mocked native effects', async () => {
    open(); const {NodePtyTransportFactory,__setNodePtyLoaderForTests}=await import('../../src/cli-adapters/pty-transport.js');
    const handle={pid:1,kill:vi.fn(),resize:vi.fn()};
    __setNodePtyLoaderForTests(()=>({spawn:()=>handle})); cleanup.push(()=>__setNodePtyLoaderForTests(null));
    const transport=new NodePtyTransportFactory().spawn('synthetic',[],{cwd:root,env:{ADHDEV_CLI_CHILD_NICE:'0'},cols:80,rows:24});
    transport.resize(90,30);expect(handle.resize).toHaveBeenCalledTimes(1);handle.resize.mockClear();
    state={...state,epoch:1,phase:'held',release:undefined};writeCooperativeMaintenance(root,state);
    expect(()=>transport.kill()).toThrow('cooperative_maintenance_held');expect(()=>transport.resize(90,30)).toThrow('cooperative_maintenance_held');
    expect(handle.kill).not.toHaveBeenCalled();expect(handle.resize).not.toHaveBeenCalled();
});

it('outbound final join checks resolved owner after awaited membership and never sends a join', async () => {
    open(); const {meshHostPairingHandlers}=await import('../../src/commands/med-family/mesh-host-pairing.js');
    const send=vi.fn(); const ctx={deps:{statusInstanceId:'daemon-self',dispatchMeshCommand:send},getMeshForCommand:vi.fn()} as any;
    for(const [id,daemonId,error] of [['unknown','daemon-self','maintenance_unknown_node_or_owner'],['node','daemon-peer','maintenance_unknown_node_or_owner'],['node','daemon-self','maintenance_roster_transition_required']]) {
        ctx.getMeshForCommand.mockResolvedValue({mesh:{id:'mesh',nodes:[{id,daemonId,workspace:root}],meshHost:{role:'member',hostDaemonId:'daemon-peer'}}});
        const result=await meshHostPairingHandlers.join_mesh_host_pairing(ctx,{meshId:'mesh',token:'synthetic'});
        expect(result).toMatchObject({success:false,error});
    }
    let finish!:(v:any)=>void;ctx.getMeshForCommand.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
    const result=meshHostPairingHandlers.join_mesh_host_pairing(ctx,{meshId:'mesh',token:'synthetic'});
    state={...state,epoch:1,phase:'held',release:undefined};writeCooperativeMaintenance(root,state);open();finish({mesh:{id:'mesh'}});
    await expect(result).rejects.toThrow('maintenance_epoch_changed');expect(send).not.toHaveBeenCalled();
});
