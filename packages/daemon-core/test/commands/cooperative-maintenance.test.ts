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
