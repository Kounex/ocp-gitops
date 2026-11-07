// Protocol clients using the exact production scheduler, without DOM rendering.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import {createPoller} from './polling.ts';
import {createQuestSession} from './quest-session.ts';
import {createAgent,requestText} from './http_transport.mjs';

const ROOT=process.env.OTQ_RUN_ROOT??path.dirname(fileURLToPath(import.meta.url));
const args=process.argv.slice(2);
const option=(name,fallback)=>args.includes(name)?args[args.indexOf(name)+1]:fallback;
const run=option('--run','client-12');
const hold=Number(option('--hold','120'));
const pollingOnly=args.includes('--polling-only');
const freshConnections=args.includes('--fresh-connections');
const BASE='https://ctfd-ctfd-loadtest.apps.cluster-gdl6f.dyn.redhatworkshops.io';
const CLEAN='https://ctfd-ctfd.apps.cluster-gdl6f.dyn.redhatworkshops.io';
const cfg=JSON.parse(fs.readFileSync(path.join(ROOT,'private-runtime.json')));
const folder=path.join(ROOT,run);fs.mkdirSync(folder,{recursive:true});
const csv=fs.openSync(path.join(folder,'requests.csv'),'w');
const events=fs.openSync(path.join(folder,'events.ndjson'),'w');
const fields=['phase','scheduled_at','started_at','ended_at','user','kind','method','path','status','outcome','unexpected','latency_ms','schedule_lag_ms','connector_wait_ms','request_body_bytes','request_header_bytes','response_body_bytes','response_header_bytes','transport_wire_errors','transport_retries'];
fs.writeSync(csv,fields.join(',')+'\n');
let phase='warmup',abort=null,mainHealthBad=0,stopGuard=false,finished=false;
let maxInflight=0,wallGapMax=0;
const rows=[],phases=[],pending=new Set();
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const now=()=>Date.now()/1000;
const percentile=(values,p)=>values.length?[...values].sort((a,b)=>a-b)[Math.floor((values.length-1)*p)]:null;
const event=(name,data={})=>fs.writeSync(events,JSON.stringify({timestamp:now(),event:name,...data})+'\n');
const counts=values=>Object.fromEntries([...new Set(values)].map(x=>[x,values.filter(v=>v===x).length]));
const flags=new Map(cfg.challenges.flatMap(r=>r.steps.map(s=>[s.id,s.flag])));
const flagExpectations=new Map();
const displayAgent=createAgent();
function safeErrorText(value,user){
 if(typeof value!=='string'&&typeof value!=='number')return null;
 let text=String(value).slice(0,1000);
 for(const secret of [cfg.password,user?.nonce,...Object.values(cfg.cookies??{})]){
  if(typeof secret==='string'&&secret.length>=8)text=text.replaceAll(secret,'[redacted]');
 }
 return text.replace(/\b(?:cookie|set-cookie|authorization|csrf-token)\b\s*[:=]\s*[^\r\n]*/gi,'[redacted header]').slice(0,300);
}
const isCancelled=row=>row.outcome==='cancelled_on_reload';
const isSuccessful=row=>!row.unexpected&&!isCancelled(row)&&row.status===200;


async function request(user,kind,urlPath,{method='GET',body,signal,owner}={}){
 const begin=now(),currentPhase=phase;
 let status=0,outcome='ok',unexpected=0,bytes=0,headerBytes=0,data,wireErrors=0,transportRetries=0,terminalFailureDisposal=null;
 const encoded=body===undefined?undefined:JSON.stringify(body);
 const headers={'Accept':'application/json','Accept-Encoding':'identity','X-Quest-Attendance-UI':'1','User-Agent':'OpenTechQuest-production-poller-load-test/20261107'};
 if(freshConnections)headers.Connection='close';
 if(user)headers.Cookie=cfg.cookie_name+'='+cfg.cookies[String(user.index)];
 if(encoded){headers['Content-Type']='application/json';headers['CSRF-Token']=user.nonce;headers['Content-Length']=String(Buffer.byteLength(encoded));}
 const reqBytes=Object.entries(headers).reduce((n,[k,v])=>n+k.length+String(v).length+4,0);
 const token={phase:currentPhase,kind,user:user?.index??-1};pending.add(token);maxInflight=Math.max(maxInflight,pending.size);
 if(pending.size>1200)abort??='outstanding_request_safety_limit';
 try{
  const response=await requestText(BASE+urlPath,{method,headers,body:encoded,signal:signal??AbortSignal.timeout(12000),agent:user?.httpAgent??displayAgent,onWireError:diagnostic=>{
   const disposed=Boolean(owner?.stopped&&signal?.aborted);
   if(!disposed)wireErrors++;if(diagnostic.will_retry)transportRetries++;
   if(!diagnostic.will_retry)terminalFailureDisposal=disposed;
   event('transport_wire_error',{phase:currentPhase,user:user?.index??-1,kind,method,path:urlPath,intentional_disposal:disposed,...diagnostic});
  }});
  status=response.status;const text=response.text;
  bytes=Number(response.headers['content-length']??Buffer.byteLength(text));
  headerBytes=Object.entries(response.headers).reduce((n,[k,v])=>n+k.length+String(v).length+4,0);
  if(kind==='reload_html'){
   if(status!==200)throw new Error('html_http_'+status);
  }else{
   const envelope=JSON.parse(text);data=envelope.data;
   if(status!==200||envelope.success!==true)throw new Error('http_or_application_'+status);
   if((kind==='bootstrap'||kind==='sync')&&user){
    if(!data.viewer.authenticated||data.viewer.team_id!==user.teamId)throw new Error('wrong_native_session_or_team');
   }
   if(kind==='onboarding'&&data.team?.id!==user.teamId)throw new Error('wrong_onboarding_team');
   if(kind==='flag'){
    outcome=data.status;
    if(!['correct','incorrect','already_solved'].includes(outcome))throw new Error('unexpected_flag_outcome');
   }
  }
 }catch(error){
  if(terminalFailureDisposal===true||(terminalFailureDisposal===null&&owner?.stopped&&signal?.aborted&&error===signal.reason)){outcome='cancelled_on_reload';}
  else{
   outcome=error.name+':'+safeErrorText(error.message,user);unexpected=1;
   event('request_error',{phase:currentPhase,user:user?.index??-1,kind,path:urlPath,status,
    error_name:error.name,error_message:safeErrorText(error.message,user),
    cause_code:safeErrorText(error.cause?.code??error.code,user),cause_message:safeErrorText(error.cause?.message,user)});
  }
 }finally{
  pending.delete(token);
  const end=now();
  const row={phase:currentPhase,scheduled_at:begin,started_at:begin,ended_at:end,user:user?.index??-1,kind,method,path:urlPath,status,outcome,unexpected,latency_ms:(end-begin)*1000,schedule_lag_ms:0,connector_wait_ms:0,request_body_bytes:encoded?Buffer.byteLength(encoded):0,request_header_bytes:reqBytes*(1+transportRetries),response_body_bytes:bytes,response_header_bytes:headerBytes,transport_wire_errors:wireErrors,transport_retries:transportRetries};
  rows.push(row);fs.writeSync(csv,fields.map(k=>'"'+String(row[k]).replaceAll('"','""')+'"').join(',')+'\n');
 }
 if(unexpected)throw new Error(outcome);
 return data;
}

class User{
 constructor(index){
  this.httpAgent=createAgent();this.index=index;this.teamId=Math.floor(index/8)+1;this.roomIndex=index%5;
  this.rooms=[];this.nonce='';this.resources={};this.stopped=false;this.reloads=0;this.ready=false;
 }
 resource(kind,url,interval,accept=()=>{}){
  const owner={stopped:false};
  const poller=createPoller({interval,active:()=>!this.stopped,
   load:signal=>request(this,kind,url,{signal,owner}),
   accept:value=>{if(!owner.stopped){owner.acceptedAt=now();accept(value);this.checkReady();}},
   reject:()=>{},
  });
  const r={poller,owner,url};this.resources[kind]=r;poller.start();return r;
 }
 roomChoice(room){
  this.room=room;
  if(this.index%10===9)return;
  const step=room.steps.find(s=>s.state==='available')??room.steps.find(s=>s.state==='solved');
  if(!step)return;
  const url='/api/v1/challenges/'+step.id;
  if(this.resources.challenge?.url===url)return;
  this.stopResource('challenge');this.challengeReady=false;this.challengeId=step.id;
  this.resource('challenge',url,60000,()=>{this.challengeReady=true;});
 }
 checkReady(){this.ready=Boolean(this.bootstrapReady&&this.onboardingReady&&(this.index%10===9?this.standingsReady:this.roomReady&&this.challengeReady));}
 start(){
  this.stopped=false;this.ready=false;
  this.bootstrapReady=this.onboardingReady=this.standingsReady=this.roomReady=this.challengeReady=false;
  this.sessionOwner={stopped:false};this.lastLive=null;this.lastFullRooms=null;
  this.session=createQuestSession({
   active:()=>!this.stopped,
   loadBootstrap:signal=>request(this,'bootstrap','/api/v1/quest/bootstrap',{signal,owner:this.sessionOwner}),
   loadSync:signal=>request(this,'sync','/api/v1/quest/sync',{signal,owner:this.sessionOwner}),
   publish:state=>{
    if(this.stopped)return;
    if(state.live&&state.live!==this.lastLive){
     this.lastLive=state.live;this.nonce=state.live.csrfNonce;this.syncAcceptedAt=now();
     this.onboardingReady=state.live.onboarding?.team?.id===this.teamId;
    }
    const data=state.data;
    if(data&&data.rooms!==this.lastFullRooms){
     this.lastFullRooms=data.rooms;this.rooms=data.rooms;this.bootstrapReady=true;this.bootstrapAcceptedAt=now();
     const room=this.rooms[this.roomIndex];this.slug=room.slug;
     if(this.index%10===9){
      if(!this.resources.standings)this.resource('standings','/api/v1/quest/standings',10000,()=>{this.standingsReady=true;});
     }else if(!this.resources.room)this.resource('room','/api/v1/quest/rooms/'+this.slug,7000,data=>{this.roomReady=true;this.roomChoice(data);});
    }
    this.checkReady();
   }
  });
  this.session.start();
 }
 stopResource(kind){const r=this.resources[kind];if(r){r.owner.stopped=true;r.poller.stop();delete this.resources[kind];}}
 stop(){this.stopped=true;if(this.sessionOwner)this.sessionOwner.stopped=true;this.session?.stop();for(const kind of Object.keys(this.resources))this.stopResource(kind);}
 reconnect(){
  // One network return often emits all three browser events. The production
  // scheduler coalesces them rather than issuing three copies per resource.
  this.reconnectedAt=now();
  for(let i=0;i<3;i++){this.session.activity();for(const r of Object.values(this.resources))r.poller.activity();}
 }
 async reload(){
  this.stop();await request(this,'reload_html','/quest/rooms/'+this.slug);
  this.start();this.reloads++;
 }
 async prepareFlag(){
  await this.session.navigation();
  const available=r=>r.steps.some(s=>s.state==='available');
  const room=this.rooms.find(r=>r.slug===this.slug&&available(r))??this.rooms.find(available);
  if(!room)throw new Error('No fresh challenge for team '+this.teamId);
  if(room.slug!==this.slug){
   this.roomIndex=this.rooms.findIndex(r=>r.id===room.id);this.slug=room.slug;
   this.stopResource('room');this.stopResource('challenge');
   this.roomReady=this.challengeReady=this.ready=false;
   this.resource('room','/api/v1/quest/rooms/'+this.slug,7000,data=>{this.roomReady=true;this.roomChoice(data);});
  }else await this.resources.room.poller.refresh();
  const until=now()+20;
  while(!abort&&now()<until){
   const step=this.room?.steps.find(s=>s.state==='available');
   if(this.ready&&step&&this.challengeReady&&this.challengeId===step.id){
    this.preparedFlag={team_id:this.teamId,room_id:this.room.id,challenge_id:step.id};return;
   }
   await sleep(50);
  }
  throw new Error('Displayed challenge did not become ready for team '+this.teamId);
 }
 async flag(){
  const step=this.room?.steps.find(s=>s.state==='available');
  if(!this.preparedFlag||!step||step.id!==this.preparedFlag.challenge_id||this.challengeId!==step.id)throw new Error('Prepared displayed challenge changed for team '+this.teamId);
  const content=this.resources.challenge;
  const expected={...this.preparedFlag,sent_at:now()};flagExpectations.set(this.teamId,expected);
  const result=await request(this,'flag','/api/v1/challenges/attempt',{method:'POST',body:{challenge_id:step.id,submission:flags.get(step.id)}});
  expected.status=result.status;expected.acknowledged_at=now();
  if(result.status==='correct'){
   await content?.poller.refresh();
   await Promise.all([this.resources.room?.poller.refresh(),this.session.refresh()]);
  }
 }

}
const users=Array.from({length:400},(_,i)=>new User(i));
const displays=[];
function refreshSummaries(){
 for(const out of phases){
  const selected=rows.filter(r=>r.phase===out.name),duration=out.ended_at-out.started_at,by={};
  for(const kind of new Set(selected.map(r=>r.kind))){
   const a=selected.filter(r=>r.kind===kind),observed=a.filter(r=>!isCancelled(r)),lat=observed.map(r=>r.latency_ms);
   const successful=a.filter(isSuccessful),inWindow=successful.filter(r=>r.ended_at<=out.ended_at);
   by[kind]={requests:a.length,successful:successful.length,cancelled:a.filter(isCancelled).length,
    late_completions:a.filter(r=>r.ended_at>out.ended_at).length,rps:inWindow.length/duration,
    p50_ms:percentile(lat,.5),p95_ms:percentile(lat,.95),p99_ms:percentile(lat,.99),max_ms:lat.length?Math.max(...lat):null,
    wire_errors:a.reduce((n,r)=>n+r.transport_wire_errors,0),transport_retries:a.reduce((n,r)=>n+r.transport_retries,0),unexpected:a.reduce((n,r)=>n+r.unexpected,0),outcomes:counts(a.map(r=>r.outcome)),status:counts(a.map(r=>r.status))};
  }
  const successful=selected.filter(isSuccessful),actualRate=successful.filter(r=>r.ended_at<=out.ended_at).length/duration;
  const errors=selected.reduce((n,r)=>n+r.unexpected,0);
  const performancePassed=errors===0&&(out.name!=='polling_400'||(actualRate>=134.6&&Object.values(by).every(x=>x.p95_ms!==null&&x.p95_ms<=2000&&x.p99_ms!==null&&x.p99_ms<=2000)));
  Object.assign(out,{duration_s:duration,offered_duration_s:duration,requests:selected.length,
   successful_requests:successful.length,cancelled_requests:selected.filter(isCancelled).length,
   late_completions:selected.filter(r=>r.ended_at>out.ended_at).length,
   pending_requests:[...pending].filter(r=>r.phase===out.name).length,
   completed_rps:actualRate,wire_errors:selected.reduce((n,r)=>n+r.transport_wire_errors,0),transport_retries:selected.reduce((n,r)=>n+r.transport_retries,0),unexpected:errors,dropped_schedules:0,by_kind:by,
   request_bytes:selected.reduce((n,r)=>n+r.request_header_bytes+r.request_body_bytes,0),
   response_bytes:selected.reduce((n,r)=>n+r.response_header_bytes+r.response_body_bytes,0),
   schedule_lag_p99_ms:0,performance_passed:performancePassed,
   validation_passed:errors===0&&out.functional_validation_passed!==false,
   finalized:finished&&pending.size===0});
  if(errors)abort??='unexpected_request_failure';
  if(!performancePassed)abort??='steady_latency_or_throughput_target_failed';
 }
}
function saveSummary(){
 refreshSummaries();
 fs.writeFileSync(path.join(folder,'summary.json'),JSON.stringify({run,base:BASE,client:'production-quest-session.ts+polling.ts',transport:freshConnections?'http1_fresh_connections':'http1_per_user_six_socket_pool_reused_get_retry_once',users:400,abort,max_inflight:maxInflight,generator_wall_clock_gap_max_s:wallGapMax,finalized:finished&&pending.size===0,pending_requests:pending.size,phases},null,2));
}
function summarize(name,start,end,selected,extra={}){
 const out={name,started_at:start,ended_at:end,...extra};
 phases.push(out);saveSummary();console.log(JSON.stringify({phase_complete:name,rps:out.completed_rps,errors:out.unexpected,performance_passed:out.performance_passed,by_kind:out.by_kind,...extra}));
}
async function prepareFlags(){
 phase='flag_preparation';const start=now();
 const results=await Promise.allSettled(users.filter(u=>u.index%8===0).map(u=>u.prepareFlag()));
 const failures=results.filter(r=>r.status==='rejected').length;
 if(failures)abort??='flag_preparation_failed';
 summarize(phase,start,now(),[],{captains_prepared:50-failures,action_failures:failures,functional_validation_passed:failures===0});
}

async function wait(ms){
 const until=now()+ms/1000;let last=now();
 while(now()<until&&!abort){await sleep(100);const t=now();wallGapMax=Math.max(wallGapMax,t-last);if(t-last>2.5)abort='load_generator_wall_clock_gap';last=t;}
}
async function phaseRun(name,duration,{soft=false,reload=false,flag=false}={}){
 phase=name;const start=now();event('phase_start',{name,duration_s:duration});
 let actions=[];
 if(soft||reload||flag){
  actions=(flag?users.filter(u=>u.index%8===0):users).map((u,i)=>(async()=>{
   await sleep(10000+(flag?0:i*25));if(abort)return;
   if(flag)return u.flag();if(reload)return u.reload();u.reconnect();
  })());
 }
 await wait(duration*1000);
 const actionResults=await Promise.allSettled(actions);
 // Include accepted responses after the offered period without manufacturing
 // another poll stream for a page that was replaced by reload.
 await sleep(1000);
 const end=now(),selected=rows.filter(r=>r.phase===name&&r.ended_at<=end);
 const actionFailures=actionResults.filter(x=>x.status==='rejected').length;
 const freshUsers=users.filter(u=>u.ready&&(!soft||(u.syncAcceptedAt>=u.reconnectedAt&&Object.values(u.resources).every(r=>(r.owner.acceptedAt??0)>=u.reconnectedAt)))).length;
 const flagRows=selected.filter(r=>r.kind==='flag');
 const sharedProgress=flag?users.filter(u=>{
  const expected=flagExpectations.get(u.teamId);
  return expected?.status==='correct'&&u.bootstrapAcceptedAt>=expected.sent_at&&u.rooms.some(r=>r.id===expected.room_id&&r.steps.some(s=>s.id===expected.challenge_id&&s.state==='solved'));
 }).length:null;
 const validationFailed=actionFailures>0||freshUsers!==400||(flag&&(flagRows.length!==50||flagRows.some(r=>r.outcome!=='correct')||sharedProgress!==400))||(reload&&users.reduce((n,u)=>n+u.reloads,0)!==400);
 if(validationFailed)abort??='functional_phase_validation_failed';
 summarize(name,start,end,selected,{ready_users:users.filter(u=>u.ready).length,fresh_users:freshUsers,reloads_completed:users.reduce((n,u)=>n+u.reloads,0),action_failures:actionFailures,functional_validation_passed:!validationFailed,teammates_observing_submitted_solves:sharedProgress,...(flag?{submitted_challenges:[...flagExpectations.values()]}:{})});
}
async function guard(){
 while(!stopGuard){
  const t=now();
  try{
   const response=await fetch(CLEAN+'/login',{signal:AbortSignal.timeout(5000)});await response.arrayBuffer();
   const latency=now()-t;mainHealthBad=response.status===200&&latency<=2?0:mainHealthBad+1;
   event('clean_health',{status:response.status,latency_s:latency});
  }catch{mainHealthBad++;}
  if(mainHealthBad>=3)abort??='clean_health_guard';
  if(rows.length>100&&rows.slice(-100).reduce((n,r)=>n+r.unexpected,0)>10)abort??='unexpected_errors_over_10_percent_last_100';
  await sleep(5000);
 }
}
const started=now();const guardPromise=guard();
const progress=setInterval(()=>console.log(JSON.stringify({phase,inflight:pending.size,ready_users:users.filter(u=>u.ready).length,requests:rows.length,abort})),10000);
try{
 event('run_start',{client:'production-quest-session.ts+polling.ts',hold,fresh_connections:freshConnections});
 const warmStart=now();
 await Promise.all(users.map((u,i)=>(async()=>{await sleep(i*25);if(!abort)u.start();})()));
 for(let i=0;i<300&&!users.every(u=>u.ready)&&!abort;i++)await wait(100);
 if(!users.every(u=>u.ready))abort??='cohort_did_not_become_ready';
 summarize('warmup',warmStart,now(),rows.filter(r=>r.phase==='warmup'),{ready_users:users.filter(u=>u.ready).length,functional_validation_passed:users.every(u=>u.ready)});
 const stageOwner={stopped:false};
 const stageSession=createQuestSession({active:()=>true,
  loadBootstrap:signal=>request(null,'stage_bootstrap','/api/v1/quest/bootstrap',{signal,owner:stageOwner}),
  loadSync:signal=>request(null,'stage_sync','/api/v1/quest/sync',{signal,owner:stageOwner}),publish:()=>{}});
 displays.push({owner:stageOwner,poller:{stop:()=>stageSession.stop()}});stageSession.start();
 for(const kind of ['standings','projector']){
  const owner={stopped:false};const poller=createPoller({interval:8000,active:()=>true,load:signal=>request(null,kind,'/api/v1/quest/'+kind,{signal,owner}),accept:()=>{},reject:()=>{}});displays.push({poller,owner});poller.start();
 }
 if(!abort)await phaseRun('polling_400',hold);
 if(!abort&&!pollingOnly)await prepareFlags();
 if(!abort&&!pollingOnly)await phaseRun('flag_burst_50_teams',30,{flag:true});
 if(!abort&&!pollingOnly)await phaseRun('soft_reconnect_400',40,{soft:true});
 if(!abort&&!pollingOnly)await phaseRun('reload_400',60,{reload:true});
}finally{
 users.forEach(u=>u.stop());displays.forEach(({owner,poller})=>{owner.stopped=true;poller.stop();});
 stopGuard=true;clearInterval(progress);await guardPromise;
 const settleUntil=now()+16;while(pending.size&&now()<settleUntil)await sleep(50);
 if(pending.size)abort??='requests_unsettled_on_shutdown';
 users.forEach(u=>u.httpAgent.destroy());displayAgent.destroy();
 finished=true;saveSummary();
 event('run_end',{abort,duration_s:now()-started});fs.closeSync(csv);fs.closeSync(events);
}
