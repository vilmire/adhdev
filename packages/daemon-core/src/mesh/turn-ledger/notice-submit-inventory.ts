/** Owned by turn.deliver. A delivery claim/queued result is not a native ACK.
 * Intent precedes submit; only the input funnel's exact native observer settles it.
 * Rows survive crash, including unavailable observers and pending native retries. */
import {randomUUID} from 'node:crypto';
import {MAINTENANCE_BOOT_NONCE} from '../../maintenance/cooperative-gate.js';
import type {TurnLedger} from './ledger.js';
import {isApplicationAck,type InputConsumeAck} from '../../sessions/input-consume-ack.js';
export type NoticeWriteState='started'|'submitted'|'uncertain';
export function createNoticeSubmitInventory(ledger:Pick<TurnLedger,'store'|'selfDaemonId'>,consume?:Pick<InputConsumeAck,'read'>){
 const db=ledger.store.db,active=new Set<string>();
 db.exec(`CREATE TABLE IF NOT EXISTS turn_notice_submit_metadata(
  operation_id TEXT PRIMARY KEY,message_id TEXT NOT NULL,mesh_id TEXT NOT NULL,writer TEXT NOT NULL,seq INTEGER NOT NULL,
  session_id TEXT NOT NULL,daemon_id TEXT NOT NULL,pid INTEGER NOT NULL,boot_nonce TEXT NOT NULL,
  state TEXT NOT NULL,outcome TEXT,revision INTEGER NOT NULL,updated_at INTEGER NOT NULL)`);
 function begin(entry:{meshId:string;writer:string;seq:number},sessionId:string){
  const operationId=randomUUID(),messageId=`notify:${entry.meshId}:${entry.writer}:${entry.seq}`;
  db.prepare('INSERT INTO turn_notice_submit_metadata VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(operationId,messageId,entry.meshId,entry.writer,entry.seq,sessionId,ledger.selfDaemonId,process.pid,MAINTENANCE_BOOT_NONCE,'intent',null,1,Date.now());
  const update=(state:string,outcome?:string)=>{
   // Native submitted proof is terminal. A later queued/duplicate response must
   // not erase it, and callbacks close over this exact attempt/session identity.
   db.prepare("UPDATE turn_notice_submit_metadata SET state=?,outcome=COALESCE(?,outcome),revision=revision+1,updated_at=? WHERE operation_id=? AND state!='submitted'").run(state,outcome??null,Date.now(),operationId);
  };
  return {observe:(state:NoticeWriteState)=>update(state),outcome:(kind:string)=>update(kind==='queued'?'queued':'unknown',kind),failed:()=>update('unknown','submit_threw')};
 }
 return {begin,async handling<T>(run:()=>Promise<T>):Promise<T>{const id=randomUUID();active.add(id);try{return await run();}finally{active.delete(id);}},
  inventory(){const rows=db.prepare('SELECT operation_id,message_id,mesh_id,writer,seq,session_id,daemon_id,pid,boot_nonce,state,outcome,revision,updated_at FROM turn_notice_submit_metadata ORDER BY operation_id LIMIT 100001').all() as any[];
   if(rows.length>100000||rows.some(r=>!['intent','started','submitted','uncertain','queued','unknown'].includes(r.state)||!/^[-a-f0-9]{36}$/.test(r.operation_id)||!Number.isSafeInteger(r.seq)||!Number.isSafeInteger(r.pid)||r.pid<=0||!Number.isSafeInteger(r.revision)||r.revision<1||r.message_id!==`notify:${r.mesh_id}:${r.writer}:${r.seq}`||typeof r.session_id!=='string'||r.daemon_id!==ledger.selfDaemonId))throw Error('notice_submit_inventory_unknown');
   // A durable native-write receipt is not consumption/application ACK.
   // A restored queued row has no surviving FIFO/observer authority. Never
   // infer a safe resend from process death or an old delivery claim.
   const evidence=rows.map(r=>({operationId:r.operation_id,messageId:r.message_id,sessionId:r.session_id,
    durableIntent:true as const,nativeSubmission:r.state==='submitted'?'confirmed' as const:'unknown' as const,
    ...consumeEvidence(consume,r.message_id),
    restored:r.pid!==process.pid||r.boot_nonce!==MAINTENANCE_BOOT_NONCE,
    retry:retryFor(consume,r.message_id)}));
   return {schema:1,evidence,daemonId:ledger.selfDaemonId,pid:process.pid,bootNonce:MAINTENANCE_BOOT_NONCE,active:[...active].sort(),rows,pending:rows.filter(r=>r.state!=='submitted')};
  }};
}
export type NoticeSubmitInventory=ReturnType<typeof createNoticeSubmitInventory>;

/** Only the durable consume-ACK journal can lift `consumed`/`applicationAck` out of `unknown`. */
function consumeEvidence(consume:Pick<InputConsumeAck,'read'>|undefined,messageId:string){
 let v;try{v=consume?.read(messageId);}catch{v=undefined;}
 return {consumed:(v?.state==='consumed'?'confirmed':v?.state==='not_consumed'?'refuted':'unknown') as 'confirmed'|'refuted'|'unknown',
  applicationAck:(isApplicationAck(v)?'confirmed':'unknown') as 'confirmed'|'unknown'};
}
function retryFor(consume:Pick<InputConsumeAck,'read'>|undefined,messageId:string){
 let v;try{v=consume?.read(messageId);}catch{v=undefined;}
 return (v?.state==='not_consumed'&&v.retries<1?'allowed_once_proven_not_consumed':'requires_exact_not_consumed_proof') as 'allowed_once_proven_not_consumed'|'requires_exact_not_consumed_proof';
}
