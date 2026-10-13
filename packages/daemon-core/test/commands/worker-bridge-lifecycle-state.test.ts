import { afterEach,expect,it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { assertWorkerBridgeLifecycleAdmission } from '../../src/commands/worker-bridge-lifecycle-admission.js';
import { loadBetterSqlite3 } from '../../src/system/load-better-sqlite3.js';
import { gatePosixUpgradeRestart } from '../../src/commands/posix-upgrade-health-gate.js';
import { performWindowsAtomicUpgrade } from '../../src/commands/windows-atomic-upgrade.js';
const roots:string[]=[];
const original=process.env.ADHDEV_CONFIG_DIR;
afterEach(()=>{process.env.ADHDEV_CONFIG_DIR=original;for(const root of roots.splice(0))fs.rmSync(root,{recursive:true,force:true});});
function fresh(){const root=fs.mkdtempSync(path.join(os.tmpdir(),'worker-lifecycle-state-'));roots.push(root);process.env.ADHDEV_CONFIG_DIR=root;return root;}
it('provably absent bridge state and readable ordinary ledger preserve ordinary admission',()=>{
 const root=fresh();expect(()=>assertWorkerBridgeLifecycleAdmission('ordinary')).not.toThrow();
 fs.mkdirSync(path.join(root,'mesh-ledger'));const Ctor=loadBetterSqlite3();const db=new Ctor(path.join(root,'mesh-ledger/mesh-runtime.db'));db.exec('CREATE TABLE unrelated(id TEXT)');db.close();expect(()=>assertWorkerBridgeLifecycleAdmission('ordinary')).not.toThrow();
});
for(const state of ['released','corrupt','missing-db','symlink','strict-unfrozen'])it(`${state} cannot downgrade to ordinary admission`,()=>{
 const root=fresh();
 if(state==='released'||state==='corrupt')fs.writeFileSync(path.join(root,'worker-bridge-supervisor.json'),state==='corrupt'?'broken':'{"released":true,"ready":true}');
 else {fs.mkdirSync(path.join(root,'mesh-ledger'));if(state==='symlink')fs.symlinkSync('/nonexistent/synthetic',path.join(root,'mesh-ledger/mesh-runtime.db'));if(state==='strict-unfrozen'){const Ctor=loadBetterSqlite3();const db=new Ctor(path.join(root,'mesh-ledger/mesh-runtime.db'));db.exec('CREATE TABLE worker_bridge_policy(frozen INTEGER); INSERT INTO worker_bridge_policy VALUES(0)');db.close();}}
 expect(()=>assertWorkerBridgeLifecycleAdmission('upgrade')).toThrow('strict_bridge_lifecycle_authority_unavailable');
 if(state==='released'){fs.unlinkSync(path.join(root,'worker-bridge-supervisor.json'));expect(()=>assertWorkerBridgeLifecycleAdmission('restart')).toThrow('strict_bridge_lifecycle_authority_unavailable');}
});
it('POSIX and Windows real upgrade/rollback consumers refuse before hooks or install mutation',async()=>{
 const root=fresh();fs.writeFileSync(path.join(root,'worker-bridge-supervisor.json'),'{}');
 let effects=0;const hooks=new Proxy({}, {get(){return ()=>{effects++;throw new Error('unexpected effect');};}});
 await expect(gatePosixUpgradeRestart({hooks} as any)).rejects.toThrow('strict_bridge_lifecycle_authority_unavailable');
 await expect(performWindowsAtomicUpgrade({hooks} as any)).rejects.toThrow('strict_bridge_lifecycle_authority_unavailable');expect(effects).toBe(0);
});
it('a strict fence appearing during POSIX health probe prevents stop and legacy rollback',async()=>{
 const root=fresh();let effects=0;
 const hooks={now:()=>0,log:()=>{},sleep:async()=>{},spawnDaemon:()=>({pid:424242,exitStatus:()=>({code:1,signal:null})}),probe:async()=>{fs.writeFileSync(path.join(root,'worker-bridge-supervisor.json'),'{}');return {alive:false};},stopPid:async()=>{effects++;return true;},restorePrevious:async()=>{effects++;return 'snapshot';}};
 await expect(gatePosixUpgradeRestart({hooks,port:19222,targetVersion:'1.0.82',previousVersion:'1.0.0',restartArgv:['synthetic'],healthTimeoutMs:1} as any)).rejects.toThrow('strict_bridge_lifecycle_authority_unavailable');expect(effects).toBe(0);
});
it('ordinary caller cannot schedule or execute helper against strict target namespace',async()=>{
 fresh();const target=fs.mkdtempSync(path.join(os.tmpdir(),'worker-lifecycle-target-'));roots.push(target);fs.mkdirSync(path.join(target,'mesh-ledger'));
 const Ctor=loadBetterSqlite3();const db=new Ctor(path.join(target,'mesh-ledger/mesh-runtime.db'));db.exec('CREATE TABLE worker_bridge_policy(frozen INTEGER); INSERT INTO worker_bridge_policy VALUES(1)');db.close();
 const {spawnDetachedDaemonUpgradeHelper,maybeRunDaemonUpgradeHelperFromEnv}=await import('../../src/commands/upgrade-helper.js');
 const payload={configDir:target,packageName:'adhdev',targetVersion:'1.0.0',parentPid:1,restartArgv:['synthetic'],skipInstall:true,killSessionHost:true};
 expect(()=>spawnDetachedDaemonUpgradeHelper(payload)).toThrow('strict_bridge_lifecycle_authority_unavailable');
 const raw=JSON.stringify(payload);process.env.ADHDEV_DAEMON_UPGRADE_HELPER=raw;
 try{await expect(maybeRunDaemonUpgradeHelperFromEnv()).rejects.toThrow('strict_bridge_lifecycle_authority_unavailable');expect(process.env.ADHDEV_DAEMON_UPGRADE_HELPER).toBe(raw);}finally{delete process.env.ADHDEV_DAEMON_UPGRADE_HELPER;}
});
it('Windows install completion cannot activate, restart, roll back or clean up after strict state appears',async()=>{
 const root=fresh();const stable=path.join(root,'stable');fs.mkdirSync(stable);let effects=0;
 const hooks={log:()=>{},install:async()=>{fs.writeFileSync(path.join(root,'worker-bridge-supervisor.json'),'{}');},restart:()=>{effects++;},restartOld:()=>{effects++;},stopProcess:()=>{effects++;},cleanup:()=>{effects++;}};
 await expect(performWindowsAtomicUpgrade({layout:{installRoot:root,stablePrefix:stable,activePrefix:stable,activeVersionName:'old'},packageName:'adhdev',targetVersion:'1.0.82',portableNode:'synthetic-node',hooks} as any)).rejects.toThrow('strict_bridge_lifecycle_authority_unavailable');
 expect(effects).toBe(0);expect(fs.readFileSync(path.join(root,'worker-bridge-supervisor.json'),'utf8')).toBe('{}');
});
