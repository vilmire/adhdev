import {beforeEach,afterEach,afterAll,it,expect,vi} from 'vitest';
const isolated=await vi.hoisted(async()=>{const {createSessionHostIsolation}=await import('../helpers/session-host-isolation.js');return createSessionHostIsolation();});
vi.mock('@adhdev/session-host-core',async original=>({...await original<any>(),getDefaultSessionHostEndpoint:vi.fn(()=>{throw Error('default_endpoint_forbidden');}),SessionHostClient:vi.fn(function(){throw Error('native_client_forbidden');})}));
import * as fs from 'node:fs';import * as path from 'node:path';import {randomUUID} from 'node:crypto';
import {SessionHostClient} from '@adhdev/session-host-core';
import {MeshRuntimeStore} from '../../src/mesh/mesh-runtime-store.js';
import {createTurnLedger} from '../../src/mesh/turn-ledger/ledger.js';
import {createTurnDeliverHandler,createDeliverEdgeWaiter} from '../../src/mesh/turn-ledger/deliver.js';
import {createNoticeSubmitInventory} from '../../src/mesh/turn-ledger/notice-submit-inventory.js';
import {createSessionInputService} from '../../src/sessions/session-input-service.js';
import {resetProcessInstanceContextForTests} from '../../src/config/instance-context.js';
let root:string,store:MeshRuntimeStore;
beforeEach(()=>{expect(vi.isMockFunction(SessionHostClient)).toBe(true);isolated.assertEndpoint(isolated.endpoint);expect(process.env.NODE_OPTIONS).toContain('--require');root=path.join(isolated.root,randomUUID());fs.mkdirSync(root);process.env.ADHDEV_CONFIG_DIR=root;resetProcessInstanceContextForTests();MeshRuntimeStore.resetForTests();store=MeshRuntimeStore.getInstance();});
afterEach(()=>{MeshRuntimeStore.resetForTests();resetProcessInstanceContextForTests();});afterAll(()=>isolated.cleanup());
const tick=()=>new Promise<void>(r=>setImmediate(r));
type WriteState='started'|'submitted'|'uncertain';
function target(){let ack:((s:WriteState)=>void)|undefined;const writes:any[]=[];return {writes,get ack(){return ack;},getStatus:()=>({status:'idle'}),observeSendWrite:(_id:string,fn:(s:WriteState)=>void)=>{ack=fn;},sendMessage:async(_text:string,options:any)=>{writes.push(options);return {status:'queued' as const};}};}
function message(sessionId='A',id='same-notice'){return {messageId:id,sessionId,origin:'mesh' as const,policy:{mode:'queue' as const},input:{parts:[{type:'text' as const,text:'PRIVATE-NOTICE'}],textFallback:'PRIVATE-NOTICE'},createdAt:Date.now()};}
it('concurrent actual handlers A/B: only original A sends and owns its native ACK; unsent duplicate B never inherits proof',async()=>{
 const ledger=createTurnLedger({db:store.db,selfDaemonId:'self',autoFlush:false}),metadata=createNoticeSubmitInventory(ledger),a=target(),b=target();
 let resolveA!:(value:typeof a)=>void;const resolved:string[]=[];
 const input=createSessionInputService({resolveSession:async session=>{resolved.push(session);if(session==='A')return new Promise<typeof a>(r=>resolveA=r);return b;}});
 const {eventId}=ledger.notifyMeshEvent({meshId:'mesh',event:'notice',eventId:'concurrent-notice',payload:{coordinatorMessage:'PRIVATE-NOTICE'},targetDaemonId:'self'});
 const entry={meshId:'mesh',writer:'writer',seq:1,kind:'turn.notify',own:true,payload:{eventId,targetDaemonId:'self',notify:'mesh_event',at:Date.now()}};
 const handler=(sessionId:string)=>createTurnDeliverHandler({ledger,selfDaemonIds:()=>['self'],port:input,submitInventory:metadata,coordinators:()=>[{sessionId,idle:true,modalParked:false}],waiter:createDeliverEdgeWaiter({now:Date.now})});
 const first=handler('A')(entry,new AbortController().signal);await tick();
 const duplicate=handler('B')(entry,new AbortController().signal);await tick();expect(metadata.inventory().pending).toHaveLength(2);expect(resolved).toEqual(['A']);resolveA(a);
 expect((await first).outcome).toBe('queued');expect((await duplicate).outcome).toBe('duplicate');expect(a.writes).toHaveLength(1);expect(b.writes).toHaveLength(0);expect(b.ack).toBeUndefined();
 a.ack!('started');a.ack!('uncertain');expect(metadata.inventory().pending).toHaveLength(2);
 a.ack!('submitted');const rows=metadata.inventory().rows;expect(rows.find(r=>r.session_id==='A')?.state).toBe('submitted');expect(rows.find(r=>r.session_id==='B')?.state).not.toBe('submitted');expect(metadata.inventory().pending).toHaveLength(1);expect(JSON.stringify(rows)).not.toContain('PRIVATE-');
});
it('late queued ACK stays with original observer across same-session and conflicting-session duplicate calls',async()=>{
 const a=target(),resolve=vi.fn(()=>a),input=createSessionInputService({resolveSession:resolve});const original=vi.fn(),same=vi.fn(),other=vi.fn();
 expect((await input.submitNotice(message(),original)).kind).toBe('queued');expect((await input.submitNotice(message(),same)).kind).toBe('duplicate');expect((await input.submitNotice(message('B'),other)).kind).toBe('duplicate');
 a.ack!('submitted');expect(original).toHaveBeenCalledExactlyOnceWith('submitted');expect(same).not.toHaveBeenCalled();expect(other).not.toHaveBeenCalled();expect(a.writes).toHaveLength(1);
});
it('notice duplicate cannot install proof on an ordinary submit already awaiting resolution',async()=>{
 const a=target();let resolve!:(value:typeof a)=>void;const input=createSessionInputService({resolveSession:()=>new Promise<typeof a>(r=>resolve=r)}),duplicateObserver=vi.fn();
 const first=input.submit(message());await tick();const duplicate=input.submitNotice(message('B'),duplicateObserver);resolve(a);expect((await first).kind).toBe('queued');expect((await duplicate).kind).toBe('duplicate');expect(a.ack).toBeUndefined();expect(duplicateObserver).not.toHaveBeenCalled();expect(a.writes).toHaveLength(1);
});
it('notice attempt captures session/message identity before awaiting resolver; caller mutation cannot retarget ACK ownership',async()=>{
 const a=target(),observer=vi.fn();let resolve!:(value:typeof a)=>void;const sessions:string[]=[];const input=createSessionInputService({resolveSession:session=>{sessions.push(session);return new Promise<typeof a>(r=>resolve=r);}});
 const msg=message('A','original-id'),pending=input.submitNotice(msg,observer);await tick();msg.sessionId='B';msg.messageId='changed-id';resolve(a);expect((await pending).kind).toBe('queued');expect(sessions).toEqual(['A']);expect(a.writes[0].messageId).toBe('original-id');a.ack!('submitted');expect(observer).toHaveBeenCalledExactlyOnceWith('submitted');
});
it('resolver refusal does not donate an observer to the next admitted retry or dedupe call',async()=>{
 const a=target(),first=vi.fn(),retry=vi.fn(),duplicate=vi.fn();let fail=true;const input=createSessionInputService({resolveSession:()=>{if(fail)throw Error('fixture resolver unavailable');return a;}});
 expect((await input.submitNotice(message(),first)).kind).toBe('refused');fail=false;expect((await input.submitNotice(message(),retry)).kind).toBe('queued');expect((await input.submitNotice(message(),duplicate)).kind).toBe('duplicate');a.ack!('submitted');expect(first).not.toHaveBeenCalled();expect(duplicate).not.toHaveBeenCalled();expect(retry).toHaveBeenCalledExactlyOnceWith('submitted');expect(a.writes).toHaveLength(1);
});
