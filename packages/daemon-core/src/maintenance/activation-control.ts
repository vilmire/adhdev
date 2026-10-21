/** Authenticated cooperative target decisions. No strict bridge state mutation,
 * process/service control, provider construction or caller readiness booleans. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {execFileSync} from 'node:child_process';
import {collectTargetDrain,MAINTENANCE_DRAIN_CHANNELS} from './drain-collection.js';
import {createHash,createHmac,timingSafeEqual,randomUUID} from 'node:crypto';
import {actorObservationChallengeBytes,authorizeMaintenanceCollection,type ActorObservationChallenge} from './actor-observation.js';
import {MAINTENANCE_BOOT_NONCE,maintenanceHeld,maintenanceDecisionDigest,writeCooperativeMaintenance,withMaintenanceObservation,type MaintenanceReady} from './cooperative-gate.js';
import {observeHeldHostedSessions,verifyPreparedObservation,verifyHeldObservationFleet} from './held-observation.js';
import {daemonIdsEquivalent} from '@adhdev/mesh-shared';
import type {DaemonComponents} from '../boot/daemon-components.js';
const sha=(b:Buffer|string)=>createHash('sha256').update(b).digest('hex');
const equal=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const fail=(s:string):never=>{throw Error(s);};
// A whole-machine `ps -A -ww` census outgrows Node's 1 MiB default buffer on hosts
// running agent CLIs whose argv carries a full system prompt (ENOBUFS = refusal).
const MAINTENANCE_CENSUS_MAX_BUFFER=256*1024*1024;
export async function authenticatedActivationControl(components:DaemonComponents,request:ActorObservationChallenge){
 const auth=authorizeMaintenanceCollection(request,'control',{allowOpen:true}),s=auth.state,b=request.body as any;
 if(!b||!['inspect','prepare','commit','verify-committed','open','verify-open','peer'].includes(b.action))fail('maintenance_control_operation_invalid');
 const c=auth.config,a=c.activation?.artifact,prefix=c.activation?.prefix;
 if(c.activation?.protocol!==1||!a||!path.isAbsolute(prefix??'')||a.sha256!==s.targetSha256||process.execPath!==c.retainedNode?.path||sha(fs.readFileSync(process.execPath))!==c.retainedNode?.sha256
    ||fs.realpathSync(process.argv[1])!==path.join(prefix,'dist/cli/index.js')||sha(fs.readFileSync(process.argv[1]))!==a.cliSha256||sha(fs.readFileSync(path.join(prefix,'dist/index.js')))!==a.executableSha256)fail('maintenance_control_build_changed');
 // Local runtime ownership: this daemon's own ledger must answer for the pinned
 // state's machine, which it may legitimately name in any equivalent id form.
 if(!components.turnLedger||!daemonIdsEquivalent(components.turnLedger.selfDaemonId,s.daemonId)||!components.cliManager?.deps.verifiedRetainedEndpoint||!components.cliManager.deps.getSessionRegistry?.())fail('maintenance_control_runtime_ports_required');
 if(b.expectedBoot!==undefined&&b.expectedBoot!==MAINTENANCE_BOOT_NONCE)fail('maintenance_control_boot_changed');
 if(!equal(b.roster,s.roster)||!equal(b.nodeRoster,s.nodeRoster))fail('maintenance_control_membership_changed');
 // Every required peer is contacted by this target's actual transport. The
 // authenticated response binds its own PID/boot/build; a connection boolean or
 // an actor echo of a peer pin cannot satisfy this route.
 // eslint-disable-next-line no-restricted-syntax -- canon-ok: exact-cardinality pinned-roster set proof, not an identity match — the roster is a uniqueness-validated raw-string set and maintenanceDecisionDigest() hashes those same raw strings sorted, so canonicalizing here would collapse two legitimately distinct roster entries into one and fail a valid peer set
 if(['commit','verify-committed','open','verify-open'].includes(b.action)&&(!Array.isArray(b.peerPins)||b.peerPins.length!==s.roster.length-1||new Set(b.peerPins.map((p:any)=>p.daemonId)).size!==s.roster.length-1||b.peerPins.some((p:any)=>!b.ready?.some((r:MaintenanceReady)=>r.daemonId===p.daemonId&&r.bootNonce===p.bootNonce&&r.artifactSha256===p.artifactSha256))))fail('maintenance_control_fleet_peer_set_required'); // canon-ok: see eslint-disable reason on the preceding line
 const peerProofs:Array<Record<string,unknown>>=[],peerObservations:Array<Awaited<ReturnType<typeof observeHeldHostedSessions>>>=[];
 for(const peer of b.peerPins??[]){
  // eslint-disable-next-line no-restricted-syntax -- canon-ok: self-exclusion plus exact pinned-roster membership of the same raw set the decision digest hashes — an equivalent-form id is a DIFFERENT roster entry here, so canonicalizing would admit a pin that is absent from the digested roster
  if(peer.daemonId===s.daemonId||!s.roster.includes(peer.daemonId)||!components.dispatchMeshCommand)fail('maintenance_control_peer_port_required'); // canon-ok: see eslint-disable reason on the preceding line
  // eslint-disable-next-line no-restricted-syntax -- canon-ok: lookup key into the pinned peerConfigs map, which the approved planner (scripts/cooperative-maintenance-activation.mjs) keys by this same raw daemonId — canonicalizing one side only would desynchronize the two and could select another peer's config/key
  const pin=c.activation.peerConfigs?.find((p:any)=>p.daemonId===peer.daemonId); // canon-ok: see eslint-disable reason on the preceding line
  if(!pin||sha(fs.readFileSync(pin.path))!==pin.sha256)fail('maintenance_control_peer_config_changed');
  const cfg=JSON.parse(fs.readFileSync(pin.path,'utf8')),peerConfigSha=sha(fs.readFileSync(cfg.actorConfigPath)),key=fs.readFileSync(cfg.observationKey.path);
  if(key.length!==32||sha(key)!==cfg.observationKey.sha256)fail('maintenance_control_peer_key_changed');
  const q={schema:1 as const,operation:'control' as const,daemonId:peer.daemonId,planDigest:s.planDigest,epoch:s.epoch,nonce:randomUUID(),sentAt:Date.now(),configSha256:peerConfigSha,
   body:{action:'peer',fleetChallenge:b.fleetChallenge,expectedBoot:peer.bootNonce,roster:s.roster,nodeRoster:s.nodeRoster}};
  const challenge={...q,bodyDigest:sha(JSON.stringify(q.body))};
  const answer=await components.dispatchMeshCommand!(peer.daemonId,'cooperative_maintenance_actor_control',{...challenge,mac:createHmac('sha256',key).update(actorObservationChallengeBytes(challenge)).digest('hex')});
  if(sha(fs.readFileSync(pin.path))!==pin.sha256||sha(fs.readFileSync(cfg.observationKey.path))!==cfg.observationKey.sha256||sha(fs.readFileSync(cfg.actorConfigPath))!==peerConfigSha)fail('maintenance_control_peer_config_changed');
  const r=answer?.reply;
  // eslint-disable-next-line no-restricted-syntax -- canon-ok: the reply is bound by timingSafeEqual over HMAC(JSON.stringify(r)) covering this exact raw daemonId, so the field must equal the byte-identical challenged value — canonicalizing would accept a reply whose authenticated bytes differ from the pin that was challenged
  if(!answer?.success||!r||r.nonce!==q.nonce||r.daemonId!==peer.daemonId||r.planDigest!==s.planDigest||r.epoch!==s.epoch||r.bootNonce!==peer.bootNonce||r.build?.artifactSha256!==peer.artifactSha256||!Number.isFinite(r.observedAt)||r.observedAt<q.sentAt||Date.now()-r.observedAt>10000||!equal(r.roster,s.roster)||!equal(r.nodeRoster,s.nodeRoster)||!/^[a-f0-9]{64}$/.test(answer.mac??'')||!timingSafeEqual(createHmac('sha256',key).update(JSON.stringify(r)).digest(),Buffer.from(answer.mac,'hex')))fail('maintenance_control_peer_continuity_changed'); // canon-ok: see eslint-disable reason on the preceding line
  if(['verify-committed','open','verify-open'].includes(b.action)&&(!r.commitment||r.commitment.epoch!==s.epoch||r.commitment.bootNonce!==peer.bootNonce||r.commitment.decisionDigest!==b.decisionDigest||!equal(r.commitment.ready,b.ready)))fail('maintenance_control_peer_commitment_missing');
  if(!r.observation)fail('maintenance_control_peer_observation_missing');peerObservations.push(r.observation);
  peerProofs.push({...peer,nonce:b.engineNonce});
 }
 auth.reply({preflight:true}); // Post-await config/key/epoch substitution fence.
 const db=components.turnLedger!.store.db,ledgerPath=fs.realpathSync((db as any).name);
 if(!ledgerPath.startsWith(auth.root+path.sep)||db.inTransaction)fail('maintenance_control_ledger_owner_unknown');
 const receipts=db.prepare('SELECT side,sender_id,delivery_id,digest,state FROM worker_bridge_delivery ORDER BY side,sender_id,delivery_id').all();
 const ledger={path:ledgerPath,receiptsDigest:sha(JSON.stringify(receipts))};
 const pinBuild=()=>{
  for(const f of [...(c.dependencies?.files??[]),...s.retainedHost.files,c.retainedNode]){const st=fs.lstatSync(f.path);if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||fs.realpathSync(f.path)!==f.path||sha(fs.readFileSync(f.path))!==f.sha256)fail('maintenance_control_dependency_changed');}
  const raw=fs.readFileSync(a.manifest.path);if(sha(raw)!==a.manifest.sha256)fail('maintenance_control_manifest_changed');const m=JSON.parse(raw.toString('utf8'));
  if(sha(fs.readFileSync(a.path))!==a.sha256||m.archiveSha256!==a.sha256||m.version!==a.version||m.commit!==a.commit||m.nodeSha256!==c.retainedNode.sha256||m.nodeAbi!==process.versions.modules)fail('maintenance_control_build_changed');
  for(const f of m.files){if(typeof f.path!=='string'||path.isAbsolute(f.path)||f.path.split('/').some((v:string)=>!v||v==='.'||v==='..'))fail('maintenance_control_manifest_path_invalid');const file=path.join(prefix,f.path),st=fs.lstatSync(file);if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||(st.mode&0o777)!==f.mode||fs.realpathSync(file)!==file||sha(fs.readFileSync(file))!==f.sha256)fail('maintenance_control_artifact_changed');}
 };
 pinBuild();
 const build={artifactSha256:a.sha256,executableSha256:a.executableSha256,cliSha256:a.cliSha256,version:a.version,commit:a.commit,installPrefix:prefix,bootNonce:MAINTENANCE_BOOT_NONCE};

 let state=s,observation:Awaited<ReturnType<typeof observeHeldHostedSessions>>;
 if(s.preparation?.bootNonce===MAINTENANCE_BOOT_NONCE){observation=await verifyPreparedObservation(components.cliManager,s.preparation.receipt);}
 else {if(!maintenanceHeld()||b.action!=='inspect'&&b.action!=='prepare'&&b.action!=='peer')fail('maintenance_prepared_observation_lost');observation=await observeHeldHostedSessions(components.cliManager,b.fleetChallenge);}
 pinBuild();
 if(b.action==='peer')return auth.reply({build,observation,commitment:s.commitment,roster:s.roster,nodeRoster:s.nodeRoster,gateHeld:maintenanceHeld()});
 // All these snapshots were independently re-observed in this request by this
 // target and its authenticated peer transports. Preserve the frozen receipt
 // for promotion; join a separate fresh projection only after integrity checks.
 const actualObservations=[observation,...peerObservations];
 const fresh=actualObservations.map(p=>{const {receipt,...raw}=p;if(sha(JSON.stringify(raw))!==receipt)fail('maintenance_control_observation_hash_changed');const proof={...raw,challenge:b.fleetChallenge,observedAt:Date.now()};return {...proof,receipt:sha(JSON.stringify(proof))};});
 const fleet=verifyHeldObservationFleet(fresh,{...s,phase:'held',roster:actualObservations.map(p=>p.daemonId)},b.fleetChallenge);
 if(['prepare','commit','verify-committed','open'].includes(b.action)){
  const drain=await withMaintenanceObservation(state=>collectTargetDrain(components,state,auth.root,request.nonce));
  if(!drain.mcp.observed||MAINTENANCE_DRAIN_CHANNELS.some(k=>!drain.channels[k]?.observed||drain.channels[k].pending.length))fail('maintenance_control_complete_drain_required');
  const tool=c.tools?.ps;if(!tool||sha(fs.readFileSync(tool.path))!==tool.sha256||!Array.isArray(c.mcpEntrypoints)||!c.mcpEntrypoints.length)fail('maintenance_control_native_mcp_port_required');
  const census=execFileSync(tool.path,['-A','-ww','-o','pid=,uid=,lstart=,command='],{encoding:'utf8',timeout:5000,maxBuffer:MAINTENANCE_CENSUS_MAX_BUFFER,windowsHide:true,env:{...process.env,LC_ALL:'C'}}).split('\n').filter(Boolean).map(line=>{const m=line.trim().match(/^(\d+)\s+(\d+)\s+(\w+\s+\w+\s+\d+\s+\d+:\d+:\d+\s+\d+)\s+(.+)$/);if(!m)fail('maintenance_control_native_census_unknown');return {pid:Number(m![1]),birth:m![3].replace(/\s+/g,' '),uid:Number(m![2]),command:m![4]};});
  const native=census.filter(p=>c.mcpEntrypoints.some((e:any)=>p.command.split(/\s+/).includes(e.path))||p.command.includes('mcp-server')&&p.command.includes(auth.root));
  if(native.length!==drain.mcp.members.length||native.some(p=>!drain.mcp.members.some(m=>m.observed&&m.identity.pid===p.pid&&m.identity.birth===p.birth&&c.mcpEntrypoints.some((e:any)=>e.path===m.identity.entryPath&&p.command.startsWith(e.nodePath+' '+e.path)))))fail('maintenance_control_native_mcp_membership_changed');
  pinBuild();auth.reply({preflight:true},state);
 }
 if(b.action==='prepare'){
  if(!maintenanceHeld())fail('maintenance_held_observation_required');
  state={...s,phase:'ready',release:undefined,commitment:undefined,preparation:{bootNonce:MAINTENANCE_BOOT_NONCE,receipt:observation.receipt,observation}};
  writeCooperativeMaintenance(auth.root,state);
 }
 auth.reply({preflight:true},state);
 const validReady=(rows:MaintenanceReady[])=>Array.isArray(rows)&&rows.length===s.roster.length&&new Set(rows.map(r=>r.daemonId)).size===rows.length&&rows.every(r=>s.roster.includes(r.daemonId)&&r.artifactSha256===s.targetSha256&&/^[a-f0-9]{64}$/.test(r.receipt)&&typeof r.bootNonce==='string'&&r.bootNonce.length>0);
 // eslint-disable-next-line no-restricted-syntax -- canon-ok: selects this target's own row out of the certificate whose decisionDigest is recomputed on the next clause from the same raw ready rows (maintenanceDecisionDigest sorts by raw daemonId), so the row must be the byte-identical one the digest covers
 const local=()=>{const row=b.ready?.find((r:MaintenanceReady)=>r.daemonId===s.daemonId);if(!validReady(b.ready)||!row||row.bootNonce!==MAINTENANCE_BOOT_NONCE||row.receipt!==state.preparation?.receipt||b.decisionDigest!==maintenanceDecisionDigest(s,b.ready))fail('maintenance_control_certificate_changed');return row as MaintenanceReady;}; // canon-ok: see eslint-disable reason on the preceding line
 if(b.action==='commit'){
  local();if(!maintenanceHeld()||!Array.isArray(b.observations))fail('maintenance_control_fleet_observations_required');
  if(actualObservations.length!==s.roster.length||b.observations.some((p:any)=>!actualObservations.some(a=>equal(a,p))))fail('maintenance_control_fleet_observations_changed');
  // eslint-disable-next-line no-restricted-syntax -- canon-ok: pairs each observation to the ready row carrying the same raw daemonId inside the digested certificate — the receipt/bootNonce tuple is only meaningful against the byte-identical row, so canonicalizing could pair an observation with another entry's receipt
  if(b.observations.some((p:any)=>!b.ready.some((r:MaintenanceReady)=>r.daemonId===p.daemonId&&r.bootNonce===p.bootNonce&&r.receipt===p.receipt)))fail('maintenance_control_observation_certificate_changed'); // canon-ok: see eslint-disable reason on the preceding line
  state={...state,commitment:{epoch:s.epoch,bootNonce:MAINTENANCE_BOOT_NONCE,decisionDigest:b.decisionDigest,ready:b.ready}};writeCooperativeMaintenance(auth.root,state);
 }
 let committedObservation:(MaintenanceReady&{epoch:number;decisionDigest:string})|undefined;
 if(['commit','verify-committed','open','verify-open'].includes(b.action)){
  const row=local(),commit=state.commitment;
  if(!commit||commit.epoch!==s.epoch||commit.bootNonce!==MAINTENANCE_BOOT_NONCE||commit.decisionDigest!==b.decisionDigest||!equal(commit.ready,b.ready))fail('maintenance_control_commitment_missing');
  committedObservation={...row,epoch:s.epoch,decisionDigest:commit!.decisionDigest};
 }
 if(b.action==='open'){
  if(!validReady(b.committed)||!equal(b.committed,b.ready))fail('maintenance_control_commit_ack_missing');
  // Native host/inventory is independently rechallenged above; the exact frozen
  // observation stays in memory for admission-lease protected promotion.
  state={...state,phase:'open',release:{ready:b.ready,committed:b.committed,decisionDigest:b.decisionDigest}};writeCooperativeMaintenance(auth.root,state);
 }
 if(b.action==='verify-open'&&(maintenanceHeld()||state.release?.decisionDigest!==b.decisionDigest))fail('maintenance_control_open_ack_missing');
 // Verify the actual ledger handle and durable receipt set, never caller hashes.
 const reply=()=>auth.reply({build,observation,ledger,peerProofs,fleet,gateHeld:maintenanceHeld(),...(committedObservation?{committedObservation,committedReceipt:state.preparation!.receipt}:{}),...(b.action==='prepare'?{readyReceipt:observation.receipt}:{}),...(['open','verify-open'].includes(b.action)?{openAck:state.release!.decisionDigest}:{})},state);
 return state.phase==='open'?reply():withMaintenanceObservation(async()=>reply());
}
