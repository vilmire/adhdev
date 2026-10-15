/** Cooperative target-owned lifecycle metadata. No argv/environment/payloads.
 * Intent precedes detached spawn; absent processes never erase orphan intents. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {getConfigDir} from '../config/config.js';
import {MAINTENANCE_BOOT_NONCE} from './cooperative-gate.js';
const sha=(v:Buffer)=>createHash('sha256').update(v).digest('hex');
export function lifecycleProcessIdentity(){
 const nodePath=fs.realpathSync(process.execPath),entryPath=fs.realpathSync(process.argv[1]);
 const birth=execFileSync('/bin/ps',['-o','lstart=','-p',String(process.pid)],{encoding:'utf8',timeout:3000,windowsHide:true,env:{LC_ALL:'C'}}).trim().replace(/\s+/g,' ');
 if(!birth)throw Error('lifecycle_birth_unknown');
 return {pid:process.pid,birth,bootNonce:MAINTENANCE_BOOT_NONCE,nodePath,nodeSha256:sha(fs.readFileSync(nodePath)),entryPath,entrySha256:sha(fs.readFileSync(entryPath))};
}
function directory(root:string,create=false){
 root=fs.realpathSync(root);const dir=path.join(root,'cooperative-lifecycle-source');
 if(create){fs.mkdirSync(dir,{mode:0o700});const parent=fs.openSync(root,'r');try{fs.fsyncSync(parent);}finally{fs.closeSync(parent);}}
 const s=fs.lstatSync(dir);if(!s.isDirectory()||s.isSymbolicLink()||(s.mode&0o077)||s.uid!==process.getuid?.()||fs.realpathSync(dir)!==dir)throw Error('lifecycle_source_directory_untrusted');return dir;
}
function ensureDirectory(root:string){try{return directory(root);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;return directory(root,true);}}
function read(file:string){const s=fs.lstatSync(file);if(!s.isFile()||s.isSymbolicLink()||(s.mode&0o077)||s.uid!==process.getuid?.()||s.size>32768)throw Error('lifecycle_source_record_untrusted');const r=JSON.parse(fs.readFileSync(file,'utf8'));
 const allowed=new Set(['schema','operationId','kind','owner','state','revision','updatedAt','targetVersion','packageName','parentPid','childPid','helper','pendingMandatory','pendingOptional','inFlight','retryScheduled','exitScheduled','retryAttempt']);
 if(Object.keys(r).some(k=>!allowed.has(k)))throw Error('lifecycle_source_unknown_fields');
 for(const native of [r.owner,...(r.helper?[r.helper]:[])])if(!native||Object.keys(native).some(k=>!['pid','birth','bootNonce','nodePath','nodeSha256','entryPath','entrySha256'].includes(k))||!Number.isSafeInteger(native.pid)||native.pid<=0||typeof native.birth!=='string'||!/^[-a-f0-9]{36}$/.test(native.bootNonce)||!path.isAbsolute(native.nodePath??'')||!path.isAbsolute(native.entryPath??'')||![native.nodeSha256,native.entrySha256].every(v=>/^[a-f0-9]{64}$/.test(v)))throw Error('lifecycle_source_incarnation_unknown');
 if(['targetVersion','packageName','pendingMandatory','pendingOptional'].some(k=>r[k]!=null&&(typeof r[k]!=='string'||!/^[@A-Za-z0-9_./+-]{1,256}$/.test(r[k])))||['inFlight','retryScheduled','exitScheduled'].some(k=>r[k]!==undefined&&typeof r[k]!=='boolean')||['parentPid','childPid','retryAttempt'].some(k=>r[k]!==undefined&&(!Number.isSafeInteger(r[k])||r[k]<0)))throw Error('lifecycle_source_metadata_invalid');
 if(r.schema!==1||!/^[-a-f0-9]{36}$/.test(r.operationId)||!['controller','helper'].includes(r.kind)||!['intent','scheduled','executing','completed','failed','idle','pending'].includes(r.state)||!Number.isSafeInteger(r.revision)||!r.owner?.birth)throw Error('lifecycle_source_record_unknown');return r;}
function durable(file:string,r:unknown){const temp=file+'.'+randomUUID()+'.tmp',fd=fs.openSync(temp,'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify(r));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(temp,file);const parent=fs.openSync(path.dirname(file),'r');try{fs.fsyncSync(parent);}finally{fs.closeSync(parent);}}
/** WRITE/READ ASYMMETRY: read() rejects a non-null targetVersion/packageName that
 * fails /^[@A-Za-z0-9_./+-]{1,256}$/, so an EMPTY STRING — non-null but
 * zero-length — is written happily and then fails validation forever, making
 * every later restart/upgrade refuse with lifecycle_source_metadata_invalid.
 * Observed 2026-10-16: a helper record persisted targetVersion:"" and bricked
 * daemon restart entirely. Normalize blank to absent at the WRITER so what we
 * persist is always readable by our own validator; the validator stays strict. */
function omitBlankLifecycleFields<T extends Record<string, unknown>>(fields: T): T {
 const out = { ...fields };
 for (const k of ['targetVersion', 'packageName'] as const) {
  if (typeof out[k] === 'string' && !(out[k] as string).trim()) delete out[k];
 }
 return out;
}
export function beginLifecycleSource(kind:'controller'|'helper',fields:{targetVersion?:string;packageName?:string;parentPid?:number},root=getConfigDir()){
 const dir=ensureDirectory(root),operationId=randomUUID();const r={schema:1,operationId,kind,owner:lifecycleProcessIdentity(),state:'intent',revision:1,updatedAt:Date.now(),...omitBlankLifecycleFields(fields)};durable(path.join(dir,operationId+'.json'),r);return operationId;
}
export function advanceLifecycleSource(operationId:string,state:'scheduled'|'executing'|'completed'|'failed'|'idle'|'pending',fields:{childPid?:number;helper?:ReturnType<typeof lifecycleProcessIdentity>;pendingMandatory?:string|null;pendingOptional?:string|null;inFlight?:boolean;retryScheduled?:boolean;exitScheduled?:boolean;retryAttempt?:number}={},root=getConfigDir()){
 if(!/^[-a-f0-9]{36}$/.test(operationId))throw Error('lifecycle_operation_invalid');const file=path.join(directory(root),operationId+'.json'),r=read(file);
 if(state==='scheduled'&&r.state!=='intent')return;
 if(fields.helper&&r.helper&&JSON.stringify(fields.helper)!==JSON.stringify(r.helper))throw Error('lifecycle_helper_incarnation_conflict');
 if(r.kind==='controller'&&(r.owner.pid!==process.pid||r.owner.bootNonce!==MAINTENANCE_BOOT_NONCE))throw Error('lifecycle_controller_owner_changed');
 if(state==='completed'&&(!r.helper||r.helper.pid!==process.pid||r.helper.bootNonce!==MAINTENANCE_BOOT_NONCE))throw Error('lifecycle_helper_completion_owner_changed');
 if(state==='completed'&&JSON.stringify(read(path.join(directory(root),operationId+'.claim.json')).helper)!==JSON.stringify(r.helper))throw Error('lifecycle_helper_claim_changed');
 durable(file,{...r,...fields,state,revision:r.revision+1,updatedAt:Date.now()});
}
/** The helper must consume its exact scheduled source intent before effects. */
export function claimLifecycleHelper(operationId:string,expected:{targetVersion:string;packageName:string;parentPid:number},root=getConfigDir()){
 if(!/^[-a-f0-9]{36}$/.test(operationId))throw Error('lifecycle_operation_invalid');
 const r=read(path.join(directory(root),operationId+'.json'));
 if(r.kind!=='helper'||Object.entries(expected).some(([k,v])=>r[k]!==v))throw Error('lifecycle_helper_target_changed');
 const helper=lifecycleProcessIdentity();
 if(['entryPath','entrySha256','nodePath','nodeSha256'].some(k=>r.owner[k]!==helper[k as keyof typeof helper]))throw Error('lifecycle_helper_executable_changed');
 const dir=directory(root),claim=path.join(dir,operationId+'.claim.json');
 // One immutable cooperative claim per scheduled operation. A second helper
 // must never overwrite the first incarnation and disappear from inventory.
 const fd=fs.openSync(claim,'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify({...r,state:'executing',helper}));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
 const parent=fs.openSync(dir,'r');try{fs.fsyncSync(parent);}finally{fs.closeSync(parent);}
 advanceLifecycleSource(operationId,'executing',{helper},root);
}
export function collectLifecycleSource(root=getConfigDir()){
 let dir:string;try{dir=directory(root);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return {schema:1,observed:false,reason:'lifecycle_source_not_enrolled',rows:[],pending:[],nativeCensusRequired:true};throw e;}
 const names=fs.readdirSync(dir).sort();if(names.length>10000)throw Error('lifecycle_source_inventory_oversized');const pins=new Map<string,string>();if(names.some(n=>!/^[-a-f0-9]{36}(?:\.claim)?\.json$/.test(n)))throw Error('lifecycle_source_temporary_or_unknown_record');
 const recordNames=names.filter(n=>!n.endsWith('.claim.json'));
 if(names.some(n=>n.endsWith('.claim.json')&&!recordNames.includes(n.replace('.claim.json','.json'))))throw Error('lifecycle_orphan_claim_unknown');
 const claims=new Map<string,any>();
 const rows=recordNames.map(name=>{const r=read(path.join(dir,name));if(name!==r.operationId+'.json')throw Error('lifecycle_source_record_changed');
  // Current controller state is reconciled by its actual live callback, never
  // by a persisted empty snapshot. A detached helper needs exact native birth.
  const claimName=name.replace('.json','.claim.json');if(names.includes(claimName)){const claim=read(path.join(dir,claimName));if(claim.operationId!==r.operationId||claim.kind!=='helper'||!claim.helper||['owner','targetVersion','packageName','parentPid'].some(k=>JSON.stringify(claim[k])!==JSON.stringify(r[k])))throw Error('lifecycle_claim_scope_changed');claims.set(claimName,claim);}
  let native='unknown';const identity=r.helper??claims.get(claimName)?.helper??r.owner;
  try{const birth=execFileSync('/bin/ps',['-o','lstart=','-p',String(identity.pid)],{encoding:'utf8',timeout:3000,windowsHide:true,env:{LC_ALL:'C'}}).trim().replace(/\s+/g,' ');native=birth===identity.birth?'same_incarnation':birth?'identity_drift':'unknown';}
  catch(e){if((e as any).status===1&&String((e as any).stdout??'').trim()===''&&String((e as any).stderr??'').trim()==='')native='absent';}
  try{for(const [file,expected]of [[identity.nodePath,identity.nodeSha256],[identity.entryPath,identity.entrySha256]]){if(!pins.has(file))pins.set(file,sha(fs.readFileSync(fs.realpathSync(file))));if(pins.get(file)!==expected)native='identity_drift';}}catch{native='unknown';}
  if(r.helper&&(!claims.has(claimName)||JSON.stringify(claims.get(claimName).helper)!==JSON.stringify(r.helper)))native='unknown';
  return {...r,claim:claims.get(claimName)?.helper??null,native};});
 const recordsChanged=rows.some((r,i)=>JSON.stringify(read(path.join(dir,recordNames[i])))!==JSON.stringify(Object.fromEntries(Object.entries(r).filter(([k])=>!['native','claim'].includes(k)))));
 const claimsChanged=[...claims].some(([name,r])=>JSON.stringify(read(path.join(dir,name)))!==JSON.stringify(r));
 if(JSON.stringify(fs.readdirSync(dir).sort())!==JSON.stringify(names)||recordsChanged||claimsChanged)throw Error('lifecycle_source_membership_changed');
 return {schema:1,observed:rows.every(r=>r.native==='same_incarnation'||r.native==='absent'),reason:rows.some(r=>r.native==='unknown'||r.native==='identity_drift')?'lifecycle_native_incarnation_unknown':undefined,rows,pending:rows.filter(r=>r.kind==='helper'&&(r.state!=='completed'||r.native!=='absent')),nativeCensusRequired:true};
}
