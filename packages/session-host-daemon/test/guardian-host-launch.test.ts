import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import * as net from 'node:net';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { getDefaultSessionHostEndpoint, resolveSessionHostIpcKey } from '@adhdev/session-host-core';
import { packageNativeGuardian } from '../scripts/package-native-guardian.mjs';
const sha=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
test('exact built host process launches pinned guardian and serves real idle lease IPC',{skip:process.platform!=='darwin'},async()=>{
 let root='';
 let child: ReturnType<typeof spawn> | undefined;
 try {
 // Prefer the caller's temp root; use a short private root when Darwin's socket budget requires it.
 const appName='gh';
 const endpointFor=(root:string)=>path.join(root,path.basename(getDefaultSessionHostEndpoint(appName,{ipcKey:resolveSessionHostIpcKey(path.join(root,'instance'))}).path));
 root=fs.mkdtempSync(path.join(tmpdir(),'gh-'));root=fs.realpathSync(root);
 if(Buffer.byteLength(endpointFor(root),'utf8')>=104){
  fs.rmdirSync(root);root='';
  root=fs.mkdtempSync('/tmp/gh-');root=fs.realpathSync(root);
 }
 fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({name:'guardian-host-fixture',version:'1.0.81-fixture'}));const configDir=path.join(root,'instance');fs.mkdirSync(configDir,{mode:0o700});
 const host=path.join(root,'host.js');fs.copyFileSync(path.resolve('dist/index.js'),host);fs.writeFileSync(path.join(root,'daemon.js'),'synthetic daemon bytes');fs.writeFileSync(path.join(root,'cli.js'),'synthetic CLI bytes');
 const nodePath=fs.realpathSync(process.execPath);const files=Object.fromEntries(['host','daemon','cli'].map(kind=>[kind,{path:`${kind}.js`,sha256:sha(fs.readFileSync(path.join(root,`${kind}.js`)))}]));
 const built=packageNativeGuardian(root,{platform:'darwin',arch:process.arch,version:'1.0.81-fixture',commit:'f'.repeat(40),files,nodePath,nodeSha256:sha(fs.readFileSync(nodePath))});
 const pins={packageRoot:root,manifestPath:built.manifestPath,manifestSha256:built.manifestSha256,version:'1.0.81-fixture',commit:'f'.repeat(40),nodePath,hostEntryPath:host,daemonEntryPath:path.join(root,'daemon.js'),cliEntryPath:path.join(root,'cli.js'),stateDir:path.join(configDir,'session-host')};
 const pinFile=path.join(root,'launch-pins.json');fs.writeFileSync(pinFile,JSON.stringify(pins),{mode:0o600});
 const endpoint={path:endpointFor(root)};
 assert.ok(Buffer.byteLength(endpoint.path,'utf8')<104,'fixture Unix socket path must reserve Darwin NUL byte');
 child=spawn(nodePath,[host,'serve'],{stdio:['ignore','pipe','pipe'],env:{TMPDIR:root,PATH:process.env.PATH,NODE_PATH:path.resolve('../../../node_modules'),ADHDEV_CONFIG_DIR:configDir,ADHDEV_SESSION_HOST_NAME:appName,ADHDEV_WORKER_GUARDIAN_PINS_FILE:pinFile}});
 let stderr='';child.stderr?.on('data',b=>{stderr+=String(b);});
  for(let i=0;i<100 && !fs.existsSync(endpoint.path);i++){if(child.exitCode!==null)throw new Error(`fixture exited: ${stderr}`);await new Promise(r=>setTimeout(r,30));}
  assert.equal(fs.existsSync(endpoint.path),true,stderr);await new Promise(r=>setTimeout(r,30));
  const socket=net.createConnection(endpoint.path);await new Promise<void>((r,j)=>{socket.once('connect',r);socket.once('error',j);});
  const ipc=(request:unknown)=>new Promise<any>(r=>{socket.once('data',data=>r(JSON.parse(String(data)).response));socket.write(JSON.stringify({kind:'request',requestId:'synthetic',request})+'\n');});
  const proof=await ipc({type:'get_upgrade_lease'});assert.equal(proof.success,true);assert.equal(proof.result.pid,child.pid);
  const req={bootId:proof.result.bootId,epoch:proof.result.epoch,owner:'fixture_owner_01',token:'a'.repeat(64)};assert.equal((await ipc({type:'acquire_upgrade_lease',payload:req})).success,true);
  assert.equal((await ipc({type:'release_upgrade_lease',payload:req})).success,true);socket.destroy();
  console.log(`BUILT_HOST_SHA256=${files.host.sha256} GUARDIAN_MANIFEST_SHA256=${built.manifestSha256} HELPER_SHA256=${built.manifest.files.helper.sha256}`);
 }finally{
  const runningChild=child;
  try {
   if(runningChild && runningChild.exitCode===null && runningChild.signalCode===null)await new Promise<void>(r=>{runningChild.once('exit',()=>r());runningChild.kill('SIGTERM');});
  }finally{if(root)fs.rmSync(root,{recursive:true,force:true});}
 }
});
