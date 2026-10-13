import { afterEach, expect, it, vi } from 'vitest';
import { DaemonCommandRouter } from '../../src/commands/router.js';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';
import { bridgeDrainState, readBridgePolicy, setBridgePolicy } from '../../src/mesh/worker-bridge.js';
const cleanup:Array<()=>void>=[];
afterEach(()=>{cleanup.splice(0).reverse().forEach(f=>f());vi.restoreAllMocks();});
function fixture(){
 const store=new (MeshRuntimeStore as any)(':memory:') as MeshRuntimeStore;cleanup.push(()=>store.close());vi.spyOn(MeshRuntimeStore,'getInstance').mockReturnValue(store);
 const policy={meshId:'synthetic-reopen-mesh',rolloutId:'synthetic-rollout',ownerDaemonId:'daemon_synthetic_owner',frozen:true,roster:[{nodeId:'synthetic-owner-node',daemonId:'daemon_synthetic_owner'}],builds:[{commit:'b'.repeat(40),version:'1.0.81-test'}]};setBridgePolicy(store.db,policy);
 const dispatch=vi.fn();const router=new DaemonCommandRouter({commandHandler:{handle:vi.fn(async()=>({success:false}))} as any,statusInstanceId:policy.ownerDaemonId,dispatchMeshCommand:dispatch,instanceManager:{collectAllStates:()=>[],listInstanceIds:()=>[],getInstance:()=>null} as any});
 router.inlineMeshCache.set(policy.meshId,{id:policy.meshId,nodes:[{id:'synthetic-owner-node',daemonId:policy.ownerDaemonId}]} as any);
 cleanup.push(()=>{router.meshNodeStatePusher.stop();router.localMeshNodeGitWatch.stop();});
 return {store,policy,router,dispatch,args:{policy:{...policy,frozen:false},verification:{ledgerDigest:bridgeDrainState(store.db,policy.meshId).ledgerDigest}}};
}
for(const source of ['ipc','standalone'])for(const proof of ['exact-drain','wrong-digest','asserted-authority'])it(`${source} reopen refuses ${proof} before any policy change`,async()=>{
 const f=fixture();if(proof==='wrong-digest')f.args.verification.ledgerDigest='0'.repeat(64);
 if(proof==='asserted-authority')Object.assign(f.args,{supervisorAuthority:{authenticated:true,nativeHostLeaseReleased:true,serviceExcluded:true,incarnation:'claimed',reconnected:true}});
 expect(await f.router.execute('worker_bridge_control',f.args,source)).toMatchObject({success:false,error:'bridge_reopen_native_supervisor_authority_unavailable'});
 expect(readBridgePolicy(f.store.db,f.policy.meshId)?.frozen).toBe(true);expect(f.dispatch).not.toHaveBeenCalled();
});
it('direct freeze remains available',async()=>{const f=fixture();expect(await f.router.execute('worker_bridge_control',{policy:f.policy},'ipc')).toMatchObject({success:true,frozen:true});});
