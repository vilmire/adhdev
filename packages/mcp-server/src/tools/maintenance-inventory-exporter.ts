/** Target-only cooperative metadata route. Uses the existing command transport;
 * no new socket/default resolver/owner inputs, bodies or credentials. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {execFileSync} from 'node:child_process';
import { createHash,createHmac,randomUUID,timingSafeEqual } from 'node:crypto';
import {readCooperativeMaintenance,getConfigDir} from '@adhdev/daemon-core';
import type {WorkerReportDelivery} from './worker-report-outbox.js';
const hash=(b:Buffer|string)=>createHash('sha256').update(b).digest('hex');
function privateBytes(file:string) {
    const s=fs.lstatSync(file);
    if(!s.isFile()||s.isSymbolicLink()||(s.mode&0o077)||s.uid!==process.getuid?.())throw new Error('maintenance_exporter_private_pin_required');
    return fs.readFileSync(file);
}
export async function startMaintenanceInventoryExporter(transport:{command(name:string,args:any):Promise<any>},delivery:WorkerReportDelivery) {
    let stopped=false,timer:ReturnType<typeof setTimeout>|undefined;
    const root=fs.realpathSync(getConfigDir()),initial=readCooperativeMaintenance(root);
    if(process.platform==='win32'||!initial?.actorConfigSha256)return {stop(){},async poll(){return false;}};
    const birth=execFileSync('/bin/ps',['-o','lstart=','-p',String(process.pid)],{encoding:'utf8',timeout:5000,windowsHide:true,env:{...process.env,LC_ALL:'C'}}).trim().replace(/\s+/g,' ');
    const identity={pid:process.pid,bootNonce:randomUUID(),birth,startedAt:Date.now(),entryPath:fs.realpathSync(process.argv[1]),entrySha256:hash(fs.readFileSync(process.argv[1])),nodePath:fs.realpathSync(process.execPath),nodeSha256:hash(fs.readFileSync(process.execPath))};
    const dir=path.join(root,'cooperative-maintenance-mcp');fs.mkdirSync(dir,{recursive:true,mode:0o700});
    const dirStat=fs.lstatSync(dir);if(!dirStat.isDirectory()||dirStat.isSymbolicLink()||fs.realpathSync(dir)!==dir||dirStat.uid!==process.getuid?.())throw new Error('maintenance_exporter_registry_untrusted');
    const file=path.join(dir,`${identity.pid}-${identity.bootNonce}.json`),fd=fs.openSync(file,'wx',0o600);
    try{fs.writeFileSync(fd,JSON.stringify({schema:1,planDigest:initial.planDigest,daemonId:initial.daemonId,identity}));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    const parent=fs.openSync(dir,'r');try{fs.fsyncSync(parent);}finally{fs.closeSync(parent);}
    async function call(operation:'mcp_poll'|'mcp_reply',body:unknown){
        const state=readCooperativeMaintenance(root);if(!state||state.planDigest!==initial!.planDigest||state.actorConfigSha256!==initial!.actorConfigSha256)throw new Error('maintenance_exporter_scope_changed');
        const configBytes=privateBytes(path.join(root,'cooperative-maintenance-actor.json'));
        if(hash(configBytes)!==state.actorConfigSha256)throw new Error('maintenance_exporter_config_changed');
        const config=JSON.parse(configBytes.toString()),key=privateBytes(config.observationKey.path);
        if(key.length!==32||hash(key)!==config.observationKey.sha256)throw new Error('maintenance_exporter_key_changed');
        const r={schema:1,operation,daemonId:state.daemonId,planDigest:state.planDigest,epoch:state.epoch,nonce:randomUUID(),sentAt:Date.now(),configSha256:state.actorConfigSha256,body,bodyDigest:hash(JSON.stringify(body))};
        const mac=createHmac('sha256',key).update(JSON.stringify([r.schema,r.operation,r.daemonId,r.planDigest,r.epoch,r.nonce,r.sentAt,r.configSha256,r.bodyDigest])).digest('hex');
        const answer=await transport.command(operation==='mcp_poll'?'cooperative_maintenance_mcp_poll':'cooperative_maintenance_mcp_reply',{...r,mac});
        if(!answer?.success||!answer.reply||!/^[a-f0-9]{64}$/.test(answer.mac??''))throw new Error('maintenance_exporter_reply_invalid');
        const expected=createHmac('sha256',key).update(JSON.stringify(answer.reply)).digest();
        if(!timingSafeEqual(expected,Buffer.from(answer.mac,'hex'))||answer.reply.nonce!==r.nonce||answer.reply.epoch!==r.epoch||answer.reply.planDigest!==r.planDigest||answer.reply.daemonId!==r.daemonId||answer.reply.observedAt<r.sentAt||answer.reply.observedAt>Date.now()||Date.now()-answer.reply.observedAt>10000)throw new Error('maintenance_exporter_reply_invalid');
        return answer.reply;
    }
    async function poll(){
        if(stopped)return false;
        const reply=await call('mcp_poll',{identity});
        if(reply.challenge){await call('mcp_reply',{identity,challenge:reply.challenge.nonce,inventory:delivery.maintenanceInventory()});}
        return true;
    }
    async function loop(){try{await poll();}catch{/* Absence is NOT zero: marker remains and collector times out. */}finally{if(!stopped){timer=setTimeout(()=>void loop(),250);timer.unref?.();}}}
    void loop();
    return {stop(){stopped=true;if(timer)clearTimeout(timer);},poll};
}
