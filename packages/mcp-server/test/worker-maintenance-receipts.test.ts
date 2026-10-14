import test from 'node:test';import assert from 'node:assert/strict';import * as fs from 'node:fs';import * as path from 'node:path';
import {createSessionHostIsolation} from '../../daemon-core/test/helpers/session-host-isolation.js';
const fixture=createSessionHostIsolation();const modulePromise=import('../src/tools/worker-report-outbox.js');
let sequence=0;const deliveries:Array<{dispose():void}>=[];
const directory=()=>{const dir=path.join(fixture.root,String(++sequence));fs.mkdirSync(dir,{mode:0o700});return dir;};
function receipt(id:string){return {protocol:1,deliveryId:id,digest:'a'.repeat(64),ownerDaemonId:'owner',senderDaemonId:'sender',taskId:'task',attemptId:'attempt',generation:1,sessionId:'session'};}
async function delivery(dir:string,command?:(name:string,args:any)=>Promise<any>){const {WorkerReportDelivery}=await modulePromise;const d=new WorkerReportDelivery({dir,credentials:{} as any,autoSchedule:false,inlineAttempts:1,transport:{command:command??(async(_name,args)=>({success:true,deliveryReceipt:receipt(args.deliveryId),privateBody:'PRIVATE-ACK'}))} as any,log:()=>{}});deliveries.push(d);return d;}
test.afterEach(()=>{for(const d of deliveries.splice(0))d.dispose();});test.after(()=>fixture.cleanup());
test('actual report/progress ACKs survive restart and concurrent pre-existing MCP stores without losing either writer',async()=>{
 const dir=directory(),a=await delivery(dir),b=await delivery(dir);await a.submit('report',{privateBody:'PRIVATE-REPORT'});await b.submit('progress',{privateBody:'PRIVATE-PROGRESS'});
 assert.equal(a.maintenanceInventory().acknowledgments.length,2);assert.equal(b.maintenanceInventory().acknowledgments.length,2);
 const restarted=await delivery(dir),meta=restarted.maintenanceInventory();assert.equal(meta.acknowledgments.length,2);assert.equal(meta.acknowledgmentsDurable,true);assert.equal(meta.diskSetMatchesMemory,true);assert.equal(JSON.stringify(meta).includes('PRIVATE-'),false);
});
test('receiptPending/lost ACK retains the entry and never manufactures a persisted acknowledgement',async()=>{
 let calls=0;const d=await delivery(directory(),async(_name,args)=>++calls===1?{success:true,receiptPending:true}:{success:true,deliveryReceipt:receipt(args.deliveryId)});
 await d.submit('report',{privateBody:'PRIVATE-PENDING'});assert.equal(d.maintenanceInventory().entries.length,1);assert.equal(d.maintenanceInventory().acknowledgments.length,0);
 await d.flush();assert.equal(d.maintenanceInventory().entries.length,0);assert.equal(d.maintenanceInventory().acknowledgments.length,1);
});
test('ACK metadata persistence failure cannot lose the authoritative completion response or assert durable proof',async()=>{
 const dir=directory();fs.writeFileSync(path.join(dir,'.maintenance-acks'),'corrupt',{mode:0o600});const d=await delivery(dir);
 const result=await d.submit('report',{privateBody:'PRIVATE-RESPONSE'});assert.equal(result.status,'answered');if(result.status==='answered')assert.equal(result.result.success,true);
 assert.equal(d.maintenanceInventory().acknowledgmentsDurable,false);assert.equal(d.maintenanceInventory().receiptsProven,false);
});
test('fresh corruption/temp state is observed after startup and metadata exposes no pending payload',async()=>{
 const dir=directory(),d=await delivery(dir,async()=>{throw Error('unreachable');});await d.submit('progress',{privateBody:'PRIVATE-DISK'});
 const entry=d.maintenanceInventory().entries[0];fs.writeFileSync(path.join(dir,`${entry.id}.json`),'{');fs.writeFileSync(path.join(dir,'unfinished.tmp'),'PRIVATE-TEMP');const meta=d.maintenanceInventory();
 assert.equal(meta.diskSetMatchesMemory,false);assert.ok(meta.quarantinedFileCount>0);assert.equal(meta.temporaryFiles.length,1);assert.equal(JSON.stringify(meta).includes('PRIVATE-'),false);
});
test('changed or disappearing known ACK metadata refuses durable receipt observation without pruning',async()=>{
 const dir=directory(),d=await delivery(dir);await d.submit('report',{privateBody:'PRIVATE-ACK'});const folder=path.join(dir,'.maintenance-acks'),file=path.join(folder,fs.readdirSync(folder)[0]);
 const row=JSON.parse(fs.readFileSync(file,'utf8'));row.generation=2;fs.writeFileSync(file,JSON.stringify(row),{mode:0o600});assert.equal(d.maintenanceInventory().acknowledgmentsDurable,false);assert.equal(d.maintenanceInventory().acknowledgments[0].generation,1);assert.equal(fs.existsSync(file),true);
});
