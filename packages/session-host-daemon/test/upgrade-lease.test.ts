import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as net from 'node:net';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { SessionHostServer } from '../src/server.js';
import { HostUpgradeLease } from '../src/upgrade-lease.js';
const mac = process.platform === 'darwin';
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'worker-native-host-')));
const helper = path.join(root, 'lock-helper');
if (mac) execFileSync('/usr/bin/cc', ['-Wall', '-Wextra', '-Werror', path.resolve('native/instance-lock.c'), '-o', helper]);
const pin = mac ? createHash('sha256').update(fs.readFileSync(helper)).digest('hex') : '';
let seq = 0;
function binding() { return { helperPath: helper, helperSha256: pin, stateDir: path.join(root, `state-${seq++}`) }; }
const token = 'a'.repeat(64); const owner = 'rollout_test_01';
const settle = () => new Promise(resolve => setTimeout(resolve, 30));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test('kernel exclusion and release/reacquire keep the lock inode', { skip: !mac }, async () => {
 const b=binding(); const a=new HostUpgradeLease(b,'endpoint'); const c=new HostUpgradeLease(b,'endpoint'); await a.start();
 try { const ino=fs.statSync(path.join(b.stateDir,'instance.lock')).ino; await assert.rejects(c.start(),/instance_locked/); await a.close(); await c.start(); assert.equal(fs.statSync(path.join(b.stateDir,'instance.lock')).ino,ino); }
 finally { await a.close(); await c.close(); }
});
test('durable held lease, lost ACK reattach, boot/token/epoch fences', { skip: !mac }, async () => {
 const b=binding(); const a=new HostUpgradeLease(b,'endpoint'); await a.start(); const req={bootId:a.bootId,epoch:0,token,owner}; a.acquire(req,true); a.acquire(req,false);
 assert.ok(!fs.readFileSync(path.join(b.stateDir,'upgrade-lease.json'),'utf8').includes(token)); await a.close();
 const c=new HostUpgradeLease(b,'endpoint'); await c.start();
 try { assert.equal(c.proof().held,true); assert.throws(()=>c.assertMutable(),/lease_held/); assert.throws(()=>c.release(req),/identity_mismatch/);
 const fresh={...req,bootId:c.bootId}; assert.throws(()=>c.acquire({...fresh,token:'b'.repeat(64)},true),/lease_owned/); c.acquire(fresh,false);
 assert.equal(c.release(fresh).epoch,1); assert.throws(()=>c.acquire(fresh,true),/identity_mismatch/); c.acquire({...fresh,epoch:1},true); assert.throws(()=>c.release(fresh),/identity_mismatch/); }
 finally { await c.close(); }
});
test('corrupt journal, wrong endpoint, symlink and wrong helper pin fail closed', { skip: !mac }, async () => {
 const b=binding(); const a=new HostUpgradeLease(b,'endpoint'); await a.start(); await a.close();
 await assert.rejects(new HostUpgradeLease(b,'other').start(),/lease_corrupt/); fs.writeFileSync(path.join(b.stateDir,'upgrade-lease.json'),'{'); await assert.rejects(new HostUpgradeLease(b,'endpoint').start());
 const c=binding(); fs.mkdirSync(c.stateDir,{mode:0o700}); fs.symlinkSync(path.join(b.stateDir,'instance.lock'),path.join(c.stateDir,'instance.lock')); await assert.rejects(new HostUpgradeLease(c,'endpoint').start(),/instance_locked/);
 await assert.rejects(new HostUpgradeLease({...binding(),helperSha256:'0'.repeat(64)},'endpoint').start(),/pin_mismatch/);
});
test('real host IPC held lease blocks session mutations without creating sessions', { skip: !mac }, async () => {
 const b=binding(); const endpoint=path.join(root,`host-${seq}.sock`); const host=new SessionHostServer({endpoint:{kind:'unix',path:endpoint},storageRootDir:path.join(b.stateDir,'records'),upgradeBinding:b}); await host.start(); await settle();
 try { const socket=net.createConnection(endpoint); await new Promise<void>(r=>socket.once('connect',r));
 const ipc=(request:unknown)=>new Promise<any>(r=>{socket.once('data',data=>r(JSON.parse(String(data)).response)); socket.write(JSON.stringify({kind:'request',requestId:'synthetic',request})+'\n');});
 const proof=await ipc({type:'get_upgrade_lease'}); assert.equal(proof.success,true); const req={bootId:proof.result.bootId,epoch:0,token,owner}; assert.equal((await ipc({type:'acquire_upgrade_lease',payload:req})).success,true);
 for(const type of ['create_session','resume_session','restart_session','send_input','delete_session','send_signal','prune_duplicate_sessions','attach_session','update_session_meta']) assert.equal((await host.handleRequest({type,payload:{}} as any)).error,'native_host_idle_lease_held');
 assert.equal(host.registry.listSessions().length,0); assert.equal((await ipc({type:'release_upgrade_lease',payload:req})).success,true); socket.destroy(); }
 finally { await host.stop(); }
});
test('unknown recovery entries prevent idle admission', { skip: !mac }, async () => {
 const b=binding(); const records=path.join(b.stateDir,'records'); fs.mkdirSync(path.join(records,'runtimes'),{recursive:true,mode:0o700}); fs.chmodSync(b.stateDir,0o700); fs.writeFileSync(path.join(records,'runtimes','unknown'),'synthetic');
 const host=new SessionHostServer({endpoint:{kind:'unix',path:path.join(root,'unknown.sock')},storageRootDir:records,upgradeBinding:b}); await host.start(); await settle();
 try { const p=(await host.handleRequest({type:'get_upgrade_lease'})).result as any; assert.equal((await host.handleRequest({type:'acquire_upgrade_lease',payload:{bootId:p.bootId,epoch:0,token,owner}})).error,'native_host_not_proven_idle'); } finally { await host.stop(); }
});
test('occupied socket is never unlinked', { skip: !mac }, async () => {
 const endpoint=path.join(root,'occupied.sock'); const server=net.createServer(); await new Promise<void>(r=>server.listen(endpoint,r)); const ino=fs.statSync(endpoint).ino;
 try { const b=binding(); const host=new SessionHostServer({endpoint:{kind:'unix',path:endpoint},storageRootDir:path.join(b.stateDir,'records'),upgradeBinding:b}); await assert.rejects(host.start(),/endpoint_owner_unproved/); assert.equal(fs.statSync(endpoint).ino,ino); } finally { await new Promise<void>(r=>server.close(()=>r())); }
});
test('parent SIGKILL releases kernel lock but does not release durable idle fence', { skip: !mac }, async () => {
 const b=binding(); const script=`import hostModule from ${JSON.stringify(path.resolve('src/upgrade-lease.ts'))}; const {HostUpgradeLease}=hostModule; const a=new HostUpgradeLease(${JSON.stringify(b)},'endpoint'); await a.start(); a.acquire({bootId:a.bootId,epoch:0,token:${JSON.stringify(token)},owner:${JSON.stringify(owner)}},true); console.log('READY'); setInterval(()=>{},1000);`;
 const child=spawn(process.execPath,['--import','tsx','--input-type=module','-e',script],{stdio:['ignore','pipe','pipe']}); await new Promise<void>((r,j)=>{child.stdout.once('data',()=>r()); child.once('exit',()=>j(new Error('fixture exited')));}); await new Promise<void>(r=>{child.once('exit',()=>r()); child.kill('SIGKILL');}); await settle();
 const c=new HostUpgradeLease(b,'endpoint'); await c.start(); try {assert.equal(c.proof().held,true); assert.throws(()=>c.assertMutable(),/lease_held/);} finally {await c.close();}
});
test('missing journal after prior lock fails closed; storage failure poisons in-memory admission', {skip:!mac},async()=>{
 const b=binding(); const a=new HostUpgradeLease(b,'endpoint'); await a.start();
 try { fs.unlinkSync(path.join(b.stateDir,'upgrade-lease.json')); fs.mkdirSync(path.join(b.stateDir,'upgrade-lease.json'));
 assert.throws(()=>a.acquire({bootId:a.bootId,epoch:0,token,owner},true)); assert.throws(()=>a.assertMutable(),/storage_unavailable/); }
 finally {await a.close();}
 fs.rmdirSync(path.join(b.stateDir,'upgrade-lease.json')); await assert.rejects(new HostUpgradeLease(b,'endpoint').start(),/journal_missing/);
});
test('host without native binding cannot attest idle lease',async()=>{
 const host=new SessionHostServer({storageRootDir:path.join(root,'unbound')});
 assert.equal((await host.handleRequest({type:'get_upgrade_lease'})).error,'native_host_upgrade_binding_unavailable');
});
test('guardian death disables host mutation admission', {skip:!mac},async()=>{
 const a=new HostUpgradeLease(binding(),'endpoint'); await a.start();
 const child=(a as any).child;
 await new Promise<void>(resolve=>{child.once('exit',()=>resolve()); child.kill('SIGKILL');});
 assert.throws(()=>a.assertMutable(),/storage_unavailable/); await a.close();
});
test('supplemental win32 control refuses binding before creating files',()=>{
 const descriptor=Object.getOwnPropertyDescriptor(process,'platform')!; const b=binding();
 try { Object.defineProperty(process,'platform',{value:'win32'}); assert.throws(()=>new HostUpgradeLease(b,'endpoint'),/platform_unproved/); assert.equal(fs.existsSync(b.stateDir),false); }
 finally { Object.defineProperty(process,'platform',descriptor); }
});
