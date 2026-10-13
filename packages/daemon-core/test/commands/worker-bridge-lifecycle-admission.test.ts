import { afterEach,beforeEach,expect,it,vi } from 'vitest';
import { MeshRuntimeStore } from '../../src/mesh/mesh-runtime-store.js';
import { setBridgePolicy } from '../../src/mesh/worker-bridge.js';
import { DaemonCommandRouter } from '../../src/commands/router.js';
import * as helper from '../../src/commands/upgrade-helper.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { LOG } from '../../src/logging/logger.js';
import * as surface from '../../src/commands/upgrade-install-surface.js';
const close:Array<()=>void>=[];
beforeEach(()=>vi.useFakeTimers());afterEach(()=>{close.splice(0).reverse().forEach(fn=>fn());vi.restoreAllMocks();vi.useRealTimers();});
for(const source of ['ipc','standalone'])for(const command of ['daemon_restart','daemon_upgrade'])it(`${source} ${command} refuses strict bridge before npm/helper/exit scheduling`,async()=>{
 const store=new (MeshRuntimeStore as any)(':memory:') as MeshRuntimeStore;close.push(()=>store.close());vi.spyOn(MeshRuntimeStore,'getInstance').mockReturnValue(store);
 setBridgePolicy(store.db,{meshId:'synthetic-lifecycle',rolloutId:'synthetic-rollout',frozen:true,builds:[{commit:'b'.repeat(40),version:'1.0.81-test'}]});
 const spawn=vi.spyOn(helper,'spawnDetachedDaemonUpgradeHelper').mockImplementation(()=>{});
 const lookup=vi.spyOn(surface,'resolveNpmPublishedVersion').mockReturnValue('9.0.0');vi.spyOn(surface,'resolveCurrentGlobalInstallSurface').mockReturnValue({} as any);vi.spyOn(surface,'execNpmCommandSync').mockReturnValue('{}');
 const router=new DaemonCommandRouter({commandHandler:{handle:vi.fn(async()=>({success:false}))} as any,statusVersion:'1.0.81',instanceManager:{collectAllStates:()=>[],listInstanceIds:()=>[],getInstance:()=>null} as any});close.push(()=>{router.meshNodeStatePusher.stop();router.localMeshNodeGitWatch.stop();});
 vi.spyOn(LOG,'error').mockImplementation(()=>{});
 const timers=vi.spyOn(globalThis,'setTimeout');expect(await router.execute(command,{killSessionHost:true,force:true,allowDowngrade:true,bridgeAuthority:{ready:true}},source)).toMatchObject({success:false,error:'strict_bridge_lifecycle_authority_unavailable'});
 expect(spawn).not.toHaveBeenCalled();expect(lookup).not.toHaveBeenCalled();expect(timers.mock.calls.some(([,delay])=>delay===3000)).toBe(false);
});

it('detached helper and environment recovery refuse before scheduling, consuming payload or rollback',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'worker-helper-admission-'));fs.mkdirSync(path.join(root,'mesh-ledger'));close.push(()=>fs.rmSync(root,{recursive:true,force:true}));
 const store=new (MeshRuntimeStore as any)(path.join(root,'mesh-ledger/mesh-runtime.db')) as MeshRuntimeStore;close.push(()=>store.close());
 setBridgePolicy(store.db,{meshId:'synthetic-helper',rolloutId:'synthetic-helper-rollout',frozen:true,builds:[{commit:'b'.repeat(40),version:'1.0.81-test'}]});
 const payload={configDir:root,packageName:'adhdev',targetVersion:'1.0.0',parentPid:1,restartArgv:['daemon'],skipInstall:true,killSessionHost:true};
 const exit=vi.spyOn(process,'exit').mockImplementation((()=>{throw new Error('unexpected exit');}) as any);
 expect(()=>helper.spawnDetachedDaemonUpgradeHelper(payload)).toThrow('strict_bridge_lifecycle_authority_unavailable');
 const raw=JSON.stringify({...payload,bridgeAuthority:{ready:true,oldRollback:true}});process.env.ADHDEV_DAEMON_UPGRADE_HELPER=raw;
 try {await expect(helper.maybeRunDaemonUpgradeHelperFromEnv()).rejects.toThrow('strict_bridge_lifecycle_authority_unavailable');expect(process.env.ADHDEV_DAEMON_UPGRADE_HELPER).toBe(raw);expect(exit).not.toHaveBeenCalled();}finally{delete process.env.ADHDEV_DAEMON_UPGRADE_HELPER;}
});
