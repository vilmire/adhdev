import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
const rpc = vi.hoisted(()=>({connect:vi.fn(),request:vi.fn(),close:vi.fn()}));
const procExe = vi.hoisted(()=>({nodePath:''}));
vi.mock('fs',async importOriginal=>{
 const actual=await importOriginal<typeof import('fs')>();
 const realpathSync=vi.fn(((p:fs.PathLike,options?:any)=>String(p)==='/proc/321/exe'&&procExe.nodePath?procExe.nodePath:actual.realpathSync(p,options)) as typeof actual.realpathSync);
 Object.assign(realpathSync,{native:actual.realpathSync.native});
 const patched={...actual,realpathSync};
 return {...patched,default:patched};
});
vi.mock('@adhdev/session-host-core',async importOriginal=>({...(await importOriginal<any>()),SessionHostClient:vi.fn(function(){return rpc;})}));
import * as native from '../../src/process/hidden-spawn.js';
import * as processFacts from '../../src/commands/process-lifecycle.js';
import { createManagedSessionHost } from '../../src/session-host/managed-host.js';
import { writeCooperativeMaintenance, type CooperativeMaintenance } from '../../src/maintenance/cooperative-gate.js';
import { resetProcessInstanceContextForTests } from '../../src/config/instance-context.js';
let root:string,state:CooperativeMaintenance,host:ReturnType<typeof createManagedSessionHost>,preamble:ReturnType<typeof vi.fn>;
beforeEach(()=>{
 root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cooperative-warm-host-test-')));vi.stubEnv('ADHDEV_CONFIG_DIR',root);resetProcessInstanceContextForTests();
 const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
 const prefix=path.join(root,'retained');fs.mkdirSync(prefix);
 const files=['session-host-daemon.js','old-node','old-addon.node'].map(name=>{const file=path.join(prefix,name);fs.writeFileSync(file,name);return {path:file,sha256:hash(name)};});
 procExe.nodePath=files[1].path;
 const realpath=fs.realpathSync.native;
 vi.spyOn(fs,'realpathSync').mockImplementation(((p:fs.PathLike,options?:any)=>String(p)==='/proc/321/exe'?files[1].path:realpath(p,options)) as typeof fs.realpathSync);
 preamble=vi.fn();host=createManagedSessionHost({appName:'synthetic',requiredRequestTypes:[],beforeEnsureReady:preamble});
 state={schema:1,rolloutId:'warm-fixture',daemonId:'self',planDigest:hash('plan'),epoch:0,roster:['self'],meshIds:['mesh'],nodeRoster:[{meshId:'mesh',nodeId:'node',daemonId:'self'}],phase:'held',targetSha256:hash('target'),retainedHost:{pid:321,birth:'native-birth',endpoint:host.endpoint.path,entryPath:files[0].path,nodePath:files[1].path,prefix,hostStartedAt:123,files,sessionSetDigest:hash('idle-owner-pty')}};
 writeCooperativeMaintenance(root,state);fs.writeFileSync(host.getPidFile(),'321');
 vi.spyOn(native,'hiddenExecFileSync').mockImplementation(((_file:string,args:string[])=>args.includes('lstart=')?'native-birth':args.includes('comm=')?files[1].path:'321') as any);
 vi.spyOn(processFacts,'getProcessCommandLine').mockReturnValue(`${files[1].path} ${files[0].path}`);
 rpc.connect.mockResolvedValue(undefined);rpc.close.mockResolvedValue(undefined);rpc.request.mockResolvedValue({success:true,result:{hostEntryPath:files[0].path,hostStartedAt:123,supportedRequestTypes:[]}});
});
afterEach(()=>{vi.restoreAllMocks();vi.clearAllMocks();vi.unstubAllEnvs();resetProcessInstanceContextForTests();fs.rmSync(root,{recursive:true,force:true});});
it('held POSIX target connects to the exact warm old host without quarantine, spawn, kill or retry',async()=>{
 const kill=vi.spyOn(process,'kill');expect(await host.ensureReady()).toEqual(host.endpoint);
 expect(kill).not.toHaveBeenCalled();expect(preamble).not.toHaveBeenCalled();expect(rpc.connect).toHaveBeenCalledTimes(1);
 expect(rpc.request).toHaveBeenCalledWith({type:'get_host_diagnostics',payload:{includeSessions:false}});
 expect(fs.readFileSync(host.getPidFile(),'utf8')).toBe('321');
 const original=Object.getOwnPropertyDescriptor(process,'platform')!;
 try{
  Object.defineProperty(process,'platform',{...original,value:'linux'});
  expect(await host.ensureReady()).toEqual(host.endpoint);
  expect(fs.realpathSync).toHaveBeenCalledWith('/proc/321/exe');
  expect(kill).not.toHaveBeenCalled();expect(preamble).not.toHaveBeenCalled();expect(rpc.connect).toHaveBeenCalledTimes(2);
 }finally{Object.defineProperty(process,'platform',original);}
});
for(const fault of ['wrong-pid','unreachable','foreign-prefix','addon-drift'])it(`retained ${fault} refuses before ordinary retry/reaping`,async()=>{
 const kill=vi.spyOn(process,'kill');
 if(fault==='wrong-pid')fs.writeFileSync(host.getPidFile(),'999');
 if(fault==='unreachable')rpc.connect.mockRejectedValue(new Error('synthetic unavailable'));
 if(fault==='foreign-prefix')rpc.request.mockResolvedValue({success:true,result:{hostEntryPath:'/foreign/host.js',hostStartedAt:123}});
 if(fault==='addon-drift')fs.writeFileSync(state.retainedHost.files[2].path,'changed');
 await expect(host.ensureReady()).rejects.toThrow();expect(kill).not.toHaveBeenCalled();expect(preamble).not.toHaveBeenCalled();expect(rpc.connect.mock.calls.length).toBeLessThanOrEqual(1);
});
it('Windows retained-session mode refuses before probes, quarantine or host mutation',async()=>{
 const original=Object.getOwnPropertyDescriptor(process,'platform')!;
 try{Object.defineProperty(process,'platform',{value:'win32'});await expect(host.ensureReady()).rejects.toThrow('maintenance_windows_retained_host_unsupported');expect(native.hiddenExecFileSync).not.toHaveBeenCalled();expect(rpc.connect).not.toHaveBeenCalled();expect(preamble).not.toHaveBeenCalled();}
 finally{Object.defineProperty(process,'platform',original);}
});
