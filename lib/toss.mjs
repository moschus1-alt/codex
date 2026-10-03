const BASE='https://openapi.tossinvest.com';
let cached;
export const connected=()=>!!(process.env.TOSS_CLIENT_ID&&process.env.TOSS_CLIENT_SECRET&&process.env.TOSS_ACCOUNT_SEQ);
async function token(){
 if(cached&&cached.until>Date.now())return cached.value;
 if(!connected())throw Error('토스 API 환경변수를 설정하세요.');
 const r=await fetch(`${BASE}/oauth2/token`,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'client_credentials',client_id:process.env.TOSS_CLIENT_ID,client_secret:process.env.TOSS_CLIENT_SECRET}),signal:AbortSignal.timeout(8000)});
 if(!r.ok)throw Error(`토스 인증 실패 (${r.status})`);
 const d=await r.json();if(!d.access_token)throw Error('토스 토큰 응답 오류');cached={value:d.access_token,until:Date.now()+Math.max(0,Number(d.expires_in||0)-60)*1000};return cached.value;
}
export async function toss(path,method='GET',body){
 const r=await fetch(BASE+path,{method,headers:{Authorization:`Bearer ${await token()}`,'X-Tossinvest-Account':process.env.TOSS_ACCOUNT_SEQ,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(10000)});
 const d=await r.json();if(!r.ok||d.error){const e=Error(`토스 요청 실패 (${r.status}, ${d.error?.code||'response-error'})`);e.status=r.status;throw e;}return d.result;
}
export async function snapshot(symbol){
 const h=await toss(`/api/v1/holdings?symbol=${encodeURIComponent(symbol)}`);
 const p=await toss('/api/v1/buying-power?currency=USD');
 const item=h.items?.find(x=>x.symbol===symbol);
 const qty=Number(item?.quantity||0),avg=Number(item?.averagePurchasePrice||0);
 if(!Number.isInteger(qty))throw Error('소수점 보유 종목은 이 전략에서 지원하지 않습니다.');
 return {qty,avg,cost:qty*avg,cash:Number(p.cashBuyingPower),at:Date.now()};
}
