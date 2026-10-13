import { afterEach, expect, it, vi } from 'vitest';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';
import { setBridgePolicy } from '../../src/mesh/worker-bridge.js';
import { workerBridgeHandlers } from '../../src/commands/low-family/worker-bridge.js';
const stores: MeshRuntimeStore[] = [];
afterEach(() => { stores.splice(0).forEach(store=>store.close()); vi.restoreAllMocks(); });
function fixture() {
 const store=new (MeshRuntimeStore as any)(':memory:') as MeshRuntimeStore;stores.push(store);
 vi.spyOn(MeshRuntimeStore,'getInstance').mockReturnValue(store);
 const meshId='synthetic-verification-mesh',owner='daemon_test_owner',peer='daemon_test_peer',commit='b'.repeat(40),version='1.0.81-test';
 setBridgePolicy(store.db,{meshId,rolloutId:'synthetic-rollout',frozen:true,ownerDaemonId:owner,roster:[{nodeId:'peer-node',daemonId:peer}],builds:[{commit,version}]});
 const calls: any[]=[];let alter: (command:string,reply:any)=>void=()=>{};
 const ctx:any={deps:{dispatchMeshCommand:async(_id:string,command:string,args:any)=>{calls.push({command,args});const reply=command==='worker_bridge_capabilities'?{success:true,protocol:1,daemonId:peer,commit,version,meshId,rolloutId:'synthetic-rollout',nonce:args.nonce,frozen:true}:{success:true,bootId:'peer-boot',status:{instanceId:peer,version},daemonBuild:{commit}};alter(command,reply);return reply;}}};
 const args={meshId,nonce:'supervisor-challenge',expectedHostDaemonId:owner,peerBuilds:[{daemonId:peer,commit,version,bootId:'peer-boot'}]};
 return {ctx,args,calls,alter:(next:typeof alter)=>{alter=next;},verify:()=>workerBridgeHandlers.worker_bridge_verify(ctx,args)};
}
it('fresh authenticated capability and exact peer boot precede a reconnect proof',async()=>{const f=fixture();expect(await f.verify()).toMatchObject({success:true,nonce:f.args.nonce,p2p:true,verifiedPeers:['daemon_test_peer']});expect(f.calls.map(c=>c.command)).toEqual(['worker_bridge_capabilities','get_status_metadata']);expect(f.calls[0].args.nonce).not.toBe(f.args.nonce);});
for(const field of ['nonce','commit','version','frozen'])it(`reconnect refuses mismatched capability ${field}`,async()=>{const f=fixture();f.alter((command,reply)=>{if(command==='worker_bridge_capabilities')reply[field]=false;});expect(await f.verify()).toMatchObject({success:false});expect(f.calls).toHaveLength(1);});
it('a same-build peer with a changed boot does not satisfy the pinned incarnation',async()=>{const f=fixture();f.alter((command,reply)=>{if(command==='get_status_metadata')reply.bootId='replacement-boot';});expect(await f.verify()).toMatchObject({success:false,error:'bridge_peer_identity_unconfirmed'});});
it('missing boot proof and duplicate peers fail before any dispatch',async()=>{const f=fixture();delete (f.args.peerBuilds[0] as any).bootId;expect(await f.verify()).toMatchObject({success:false});expect(f.calls).toHaveLength(0);f.args.peerBuilds.push(f.args.peerBuilds[0]);expect(await f.verify()).toMatchObject({success:false});expect(f.calls).toHaveLength(0);});
it('an isolated owner bootstrap does not claim P2P verification',async()=>{const f=fixture();f.args.peerBuilds=[];expect(await f.verify()).toMatchObject({success:true,p2p:false,verifiedPeers:[]});expect(f.calls).toHaveLength(0);});

it('malformed peer entries are refused without a dispatch or exception',async()=>{const f=fixture();f.args.peerBuilds=[null] as any;expect(await f.verify()).toMatchObject({success:false,error:'bridge_peer_manifest_mismatch'});expect(f.calls).toHaveLength(0);});
