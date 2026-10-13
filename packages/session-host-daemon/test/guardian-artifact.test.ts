import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { packageNativeGuardian } from '../scripts/package-native-guardian.mjs';
import { resolveGuardianArtifact } from '../src/guardian-artifact.js';
import { HostUpgradeLease } from '../src/upgrade-lease.js';
const mac=process.platform==='darwin'; const sha=(b:Buffer|string)=>createHash('sha256').update(b).digest('hex');
const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'worker-guardian-package-')));
test.after(()=>fs.rmSync(root,{recursive:true,force:true}));
function fixture(){
 const dir=fs.mkdtempSync(path.join(root,'package-')); const files:any={}; fs.writeFileSync(path.join(dir,'package.json'),JSON.stringify({name:'guardian-disposable-fixture',version:'1.0.81-fixture',files:['*.js','worker-native']}));
 for(const kind of ['daemon','cli','host']){const name=`${kind}.js`;fs.writeFileSync(path.join(dir,name),`/* synthetic ${kind} bytes */`);files[kind]={path:name,sha256:sha(fs.readFileSync(path.join(dir,name)))};}
 const nodePath=fs.realpathSync(process.execPath); const identity={platform:'darwin',arch:process.arch,version:'1.0.81-fixture',commit:'a'.repeat(40),files,nodePath,nodeSha256:sha(fs.readFileSync(nodePath))};
 const packaged=packageNativeGuardian(dir,identity);
 const pins={packageRoot:dir,manifestPath:packaged.manifestPath,manifestSha256:packaged.manifestSha256,version:identity.version,commit:identity.commit,nodePath,daemonEntryPath:path.join(dir,'daemon.js'),cliEntryPath:path.join(dir,'cli.js'),hostEntryPath:path.join(dir,'host.js'),stateDir:path.join(dir,'private')};
 return {dir,identity,packaged,pins};
}
test('package helper attestation, exact payload pins and real guardian launch', {skip:!mac},async()=>{
 const f=fixture(); const b=resolveGuardianArtifact(f.pins); const lease=new HostUpgradeLease(b,'synthetic-endpoint'); await lease.start();
 try {assert.equal(lease.proof().held,false);assert.equal(String(execFileSync(b.helperPath,['--attest'])).trim(),'adhdev-host-guardian/1');}finally{await lease.close();}

 const cache=path.join(f.dir,'cache');fs.mkdirSync(cache); const globalConfig=path.join(f.dir,'global.npmrc');fs.writeFileSync(globalConfig,'');
 const result=JSON.parse(String(execFileSync('npm',['pack','--json','--offline','--ignore-scripts','--userconfig','/dev/null','--cache',cache,'--pack-destination',f.dir],{cwd:f.dir,env:{...process.env,NPM_CONFIG_GLOBALCONFIG:globalConfig},stdio:'pipe'})))[0];
 assert.ok(result.files.some((e:any)=>e.path.endsWith('instance-lock')));assert.ok(result.files.some((e:any)=>e.path.endsWith('manifest.json')));
 console.log(`OFFLINE_FIXTURE_TAR_SHA256=${sha(fs.readFileSync(path.join(f.dir,result.filename)))} MANIFEST_SHA256=${f.packaged.manifestSha256} HELPER_SHA256=${b.helperSha256}`);
});
test('version, manifest, Node and intended host identity mismatch fail closed',{skip:!mac},()=>{
 const f=fixture(); assert.throws(()=>resolveGuardianArtifact({...f.pins,version:'1.0.82-rc.13'}),/build_mismatch/);
 assert.throws(()=>resolveGuardianArtifact({...f.pins,manifestSha256:'0'.repeat(64)}),/manifest_pin_mismatch/);
 assert.throws(()=>resolveGuardianArtifact({...f.pins,nodePath:f.pins.hostEntryPath}),/node_pin_mismatch/);
 assert.throws(()=>resolveGuardianArtifact({...f.pins,hostEntryPath:f.pins.cliEntryPath}),/payload_pin_mismatch/);
});
test('binary replacement and symlink helper refused before guardian admission',{skip:!mac},async()=>{
 const f=fixture(); const b=resolveGuardianArtifact(f.pins);fs.chmodSync(b.helperPath,0o755);fs.writeFileSync(b.helperPath,'replaced');
 await assert.rejects(new HostUpgradeLease(b,'endpoint').start(),/pin_mismatch|file_identity_changed/);
 fs.unlinkSync(b.helperPath);fs.symlinkSync(f.pins.hostEntryPath,b.helperPath);assert.throws(()=>resolveGuardianArtifact(f.pins),/path_untrusted|payload_pin_mismatch/);
});
test('builder refuses mutable/missing build identity, wrong input bytes, existing output',{skip:!mac},()=>{
 const f=fixture();assert.throws(()=>packageNativeGuardian(f.dir,{...f.identity,commit:'next'}),/build_identity/);
 assert.throws(()=>packageNativeGuardian(f.dir,{...f.identity,files:{...f.identity.files,daemon:{path:'daemon.js',sha256:'0'.repeat(64)}}}),/pin_mismatch/);
 assert.throws(()=>packageNativeGuardian(f.dir,f.identity),/output_already_exists/);
});

test('same bytes on a replacement inode and wrong protocol version refuse',{skip:!mac},async()=>{
 const f=fixture();const b=resolveGuardianArtifact(f.pins); const copy=`${b.helperPath}.copy`;fs.copyFileSync(b.helperPath,copy);fs.chmodSync(copy,0o555);fs.renameSync(copy,b.helperPath);
 await assert.rejects(new HostUpgradeLease(b,'endpoint').start(),/file_identity_changed/);
 const script=path.join(f.dir,'wrong-version');fs.writeFileSync(script,'#!/bin/sh\necho wrong-guardian-version\n',{mode:0o555});
 await assert.rejects(new HostUpgradeLease({helperPath:script,helperSha256:sha(fs.readFileSync(script)),helperProtocol:1,stateDir:path.join(f.dir,'wrong-state')},'endpoint').start(),/protocol_mismatch/);
});
