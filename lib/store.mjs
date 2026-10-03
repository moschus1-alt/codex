import {defaults} from './strategy.mjs';
let memory=null;
export function initial(){return {revision:0,paused:false,common:{...defaults},symbols:[{symbol:'TQQQ',override:null}],paper:{TQQQ:{qty:0,avg:0,cost:0,cash:defaults.seed}},live:{},plans:{},logs:[]};}
export const durable=()=>!!(process.env.UPSTASH_REDIS_REST_URL&&process.env.UPSTASH_REDIS_REST_TOKEN);
export async function redis(command){
 const u=process.env.UPSTASH_REDIS_REST_URL;
 if(!u?.startsWith('https://'))throw Error('Redis HTTPS 설정이 필요합니다.');
 const r=await fetch(u,{method:'POST',headers:{Authorization:`Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}`,'Content-Type':'application/json'},body:JSON.stringify(command),signal:AbortSignal.timeout(8000)});
 if(!r.ok)throw Error('저장소 연결 실패');const d=await r.json();if(d.error)throw Error('저장소 처리 실패');return d.result;
}
const key='infinite-buy:v1:state';
export async function read(){
 if(durable()){const raw=await redis(['GET',key]);return {raw,state:raw?JSON.parse(raw):initial()};}
 if(process.env.VERCEL)throw Error('Vercel에서는 영구 저장소 Redis 설정이 필수입니다.');
 return {raw:memory,state:memory?JSON.parse(memory):initial()};
}
export async function write(raw,state){
 state.revision++;
 const value=JSON.stringify(state);
 if(durable()){
  const script="local v=redis.call('GET',KEYS[1]); if (v or '')~=ARGV[1] then return 0 end; redis.call('SET',KEYS[1],ARGV[2]); return 1";
  if(await redis(['EVAL',script,1,key,raw??'',value])!==1)throw Error('다른 요청이 상태를 변경했습니다. 새로고침하세요.');
 }else{if(memory!==raw)throw Error('동시 변경 충돌');memory=value;}
}
export async function loginLimit(){
 if(!durable())return;
 const n=await redis(['EVAL',"local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],60) end; return n",1,'infinite-buy:login']);
 if(n>10)throw Error('로그인 시도가 많습니다. 1분 후 다시 시도하세요.');
}

// A lease serializes account mutations across Vercel instances. Never bypass on errors.
export async function lease(name,ttl=90000){
 if(!durable())return ()=>{};
 const token=crypto.randomUUID(),key='infinite-buy:lock:'+name;
 if(await redis(['SET',key,token,'NX','PX',ttl])!=='OK')throw Error('다른 주문 요청이 처리 중입니다. 잠시 후 다시 시도하세요.');
 return async()=>redis(['EVAL',"if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end; return 0",1,key,token]);
}
