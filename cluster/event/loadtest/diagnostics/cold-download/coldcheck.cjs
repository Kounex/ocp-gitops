// Anonymous HTML/static diagnostic through the public HTTPS Route. No sessions.
const https=require('node:https'),fs=require('node:fs');
const {performance}=require('node:perf_hooks');
const base=new URL(process.env.COLD_BASE||'https://ctfd-ctfd-loadtest.apps.cluster-gdl6f.dyn.redhatworkshops.io');
if(!base.hostname.startsWith('ctfd-ctfd-loadtest.'))throw Error('Disposable target required');
const paths=JSON.parse(fs.readFileSync(__dirname+'/asset-paths.json'));
const rows=[],users=[],start=Date.now()/1000;
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const pct=(a,p)=>a.sort((x,y)=>x-y)[Math.floor((a.length-1)*p)];
async function get(agent,path,user){
 const begin=performance.now();let status=0,bytes=0,connectMs=null;
 const row={user,path,status,bytes,latency_ms:0,unexpected:0};
 await new Promise(resolve=>{
  const req=https.get(new URL(path,base),{agent,headers:{'Accept-Encoding':'identity','User-Agent':'OTQ-cold-origin-diagnostic/20261106'}},res=>{
   status=res.statusCode;res.on('data',b=>bytes+=b.length);res.on('end',()=>{if(status!==200){row.unexpected=1;row.error='HTTP_'+status;}finish();});res.on('error',fail);
  });
  const total=setTimeout(()=>req.destroy(Error('total_deadline_12s')),12000);let connect;
  req.on('socket',socket=>{if(socket.connecting){connect=setTimeout(()=>req.destroy(Error('connect_deadline_5s')),5000);socket.once('secureConnect',()=>{connectMs=performance.now()-begin;clearTimeout(connect);});}});
  let done=false;
  function finish(){if(done)return;done=true;clearTimeout(total);clearTimeout(connect);Object.assign(row,{status,bytes,connect_ms:connectMs,latency_ms:performance.now()-begin});rows.push(row);resolve();}
  function fail(e){row.unexpected=1;row.error=e.code||e.message;finish();}
  req.on('error',fail);
 });
}
(async()=>{
 await Promise.all(Array.from({length:400},(_,user)=>(async()=>{
  await sleep(user*50);const begin=performance.now(),agent=new https.Agent({keepAlive:true,maxSockets:6});
  await get(agent,'/quest',user);
  let next=0;await Promise.all(Array.from({length:6},async()=>{while(next<paths.length)await get(agent,paths[next++],user);}));
  agent.destroy();users.push({user,duration_ms:performance.now()-begin});
 })()));
 const end=Date.now()/1000;
 console.log(JSON.stringify({start,end,duration_s:end-start,users:400,requests:rows.length,unexpected:rows.filter(r=>r.unexpected).length,response_mbps:rows.reduce((n,r)=>n+r.bytes,0)*8/(end-start)/1e6,user_asset_set_p95_ms:pct(users.map(x=>x.duration_ms),.95),user_asset_set_max_ms:Math.max(...users.map(x=>x.duration_ms)),rows,users_detail:users}));
})();
