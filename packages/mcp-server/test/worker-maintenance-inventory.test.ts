import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {createSessionHostIsolation} from '../../daemon-core/test/helpers/session-host-isolation.js';
const fixture=createSessionHostIsolation();
// Consumer imports occur only after disposable config/name and inherited native fence.
const outboxModule=import('../src/tools/worker-report-outbox.js');
test.after(()=>fixture.cleanup());
for(const kind of ['report','progress'] as const)test(`actual ${kind} outbox metadata preserves pending ACK and excludes private bodies`,async()=>{
 const {WorkerReportDelivery}=await outboxModule;
 const dir=path.join(fixture.root,kind);fs.mkdirSync(dir);
 let ack!:(reply:any)=>void,entered!:()=>void;const started=new Promise<void>(r=>entered=r);
 const delivery=new WorkerReportDelivery({dir,credentials:{} as any,autoSchedule:false,inlineAttempts:1,transport:{command:async()=>{entered();return new Promise(r=>{ack=r;});}} as any});
 const pending=delivery.submit(kind,{privateBody:'PRIVATE-MUST-NOT-LEAK'});await started;
 const snapshot=delivery.maintenanceInventory();assert.equal(snapshot.activeSubmits,1);assert.equal(snapshot.entries.length,1);assert.equal(snapshot.entries[0].kind,kind);assert.equal(snapshot.diskSetMatchesMemory,true);assert.equal(JSON.stringify(snapshot).includes('PRIVATE-MUST-NOT-LEAK'),false);
 ack({success:true});await pending;assert.equal(delivery.maintenanceInventory().activeSubmits,0);assert.equal(delivery.maintenanceInventory().entries.length,0);assert.equal(delivery.maintenanceInventory().receiptsProven,false);delivery.dispose();
});
test('actual memory fallback, unreadable and temporary outbox inventories never become empty-disk proof',async()=>{
 const {WorkerReportDelivery}=await outboxModule;
 const dir=path.join(fixture.root,'corrupt');fs.mkdirSync(dir);fs.writeFileSync(path.join(dir,'unreadable.json'),'{');fs.writeFileSync(path.join(dir,'entry.json.1.tmp'),'unconfirmed');
 const transport={command:async()=>{throw Error('unreachable');}} as any;
 const delivery=new WorkerReportDelivery({dir,credentials:{} as any,autoSchedule:false,transport});const inventory=delivery.maintenanceInventory();assert.equal(inventory.quarantinedFileCount,1);assert.equal(inventory.temporaryFiles.length,1);assert.equal(inventory.diskSetMatchesMemory,false);delivery.dispose();
 const memory=new WorkerReportDelivery({dir:null,credentials:{} as any,autoSchedule:false,inlineAttempts:1,transport});await memory.submit('progress',{privateBody:'MEMORY-PRIVATE'});const m=memory.maintenanceInventory();assert.equal(m.memoryFallback,true);assert.equal(m.directoryReadable,false);assert.equal(m.entries.length,1);assert.equal(JSON.stringify(m).includes('MEMORY-PRIVATE'),false);memory.dispose();
});
test('background ACK and downstream delivery notice remain visible without consuming either',async()=>{
 const {WorkerReportDelivery}=await outboxModule;const dir=path.join(fixture.root,'background');fs.mkdirSync(dir);
 let calls=0,ack!:(reply:any)=>void,entered!:()=>void;const sending=new Promise<void>(r=>entered=r);
 const delivery=new WorkerReportDelivery({dir,credentials:{} as any,autoSchedule:false,inlineAttempts:1,transport:{command:async()=>{if(++calls===1)throw Error('lost ACK');entered();return new Promise(r=>{ack=r;});}} as any});
 await delivery.submit('report',{privateBody:'BACKGROUND-PRIVATE'});const flushing=delivery.flush();await sending;
 assert.equal(delivery.maintenanceInventory().flushing,true);assert.equal(delivery.maintenanceInventory().entries.length,1);
 ack({success:true});await flushing;const after=delivery.maintenanceInventory();assert.equal(after.pendingNoticeCount,1);assert.equal(after.flushing,false);assert.equal(after.entries.length,0);assert.equal(after.receiptsProven,false);assert.equal(delivery.maintenanceInventory().pendingNoticeCount,1);assert.equal(JSON.stringify(after).includes('BACKGROUND-PRIVATE'),false);delivery.dispose();
});
