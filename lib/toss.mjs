import {durable,redis,lease} from './store.mjs';
const BASE='https://openapi.tossinvest.com';
let cached;
export const connected=()=>!!(process.env.TOSS_CLIENT_ID&&process.env.TOSS_CLIENT_SECRET&&process.env.TOSS_ACCOUNT_SEQ);
async function token(){
 if(!connected())throw Error('토스 API 환경변수를 설정하세요.');
 const cacheKey='infinite-buy:broker-token';
 async function get(){return durable()?JSON.parse(await redis(['GET',cacheKey])||'null'):cached;}
 let entry=await get();if(entry&&entry.until>Date.now())return entry.value;
 const release=await lease('broker-token',30000);
 try{
  entry=await get();if(entry&&entry.until>Date.now())return entry.value;
  const r=await fetch(`${BASE}/oauth2/token`,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'client_credentials',client_id:process.env.TOSS_CLIENT_ID,client_secret:process.env.TOSS_CLIENT_SECRET}),signal:AbortSignal.timeout(8000)});
  if(!r.ok)throw Error(`토스 인증 실패 (${r.status})`);
  const d=await r.json();if(!d.access_token||!Number.isFinite(Number(d.expires_in)))throw Error('토스 토큰 응답 오류');
  cached={value:d.access_token,until:Date.now()+Math.max(0,Number(d.expires_in)-60)*1000};
  if(durable())await redis(['SET',cacheKey,JSON.stringify(cached),'PX',Math.max(1000,Number(d.expires_in)*1000)]);
  return cached.value;
 }finally{await release();}
}
export async function toss(path,method='GET',body){
 const r=await fetch(BASE+path,{method,headers:{Authorization:`Bearer ${await token()}`,'X-Tossinvest-Account':process.env.TOSS_ACCOUNT_SEQ,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(10000)});
 const d=await r.json();if(!r.ok||d.error){const e=Error(`토스 요청 실패 (${r.status}, ${d.error?.code||'response-error'})`);e.status=r.status;e.definiteReject=[400,401,403,404,422,429].includes(r.status)&&!!d.error?.code;throw e;}return d.result;
}
export async function snapshot(symbol){
 const h=await toss(`/api/v1/holdings?symbol=${encodeURIComponent(symbol)}`);
 const p=await toss('/api/v1/buying-power?currency=USD');
 if(!Array.isArray(h?.items)||!Number.isFinite(Number(p?.cashBuyingPower)))throw Error('잔고 응답 형식 오류');
 const item=h.items.find(x=>x.symbol===symbol);
 const qty=Number(item?.quantity||0),avg=Number(item?.averagePurchasePrice||0);
 if(!Number.isFinite(avg)||avg<0||qty<0||!Number.isInteger(qty))throw Error('소수점 보유 종목은 이 전략에서 지원하지 않습니다.');
 return {qty,avg,cost:qty*avg,cash:Number(p.cashBuyingPower),at:Date.now()};
}
