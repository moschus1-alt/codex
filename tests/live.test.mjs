import test from 'node:test';import assert from 'node:assert/strict';import handler from '../api/app.mjs';import {nyDate} from '../lib/strategy.mjs';import {tick} from '../lib/scheduler.mjs';
Object.assign(process.env,{APP_PASSWORD:'test-password-12345678',SESSION_SECRET:'test-secret-more-than-32-characters',UPSTASH_REDIS_REST_URL:'https://mock.redis',UPSTASH_REDIS_REST_TOKEN:'fake',TOSS_CLIENT_ID:'fake',TOSS_CLIENT_SECRET:'fake',TOSS_ACCOUNT_SEQ:'fake',LIVE_TRADING_ENABLED:'true',STRATEGY_RULES_CONFIRMED:'true',CRON_SECRET:'test-cron-secret-at-least-32-characters'});
let raw=null,cookie,orders=[],fail=false;const redisValues=new Map();
const response=result=>new Response(JSON.stringify(result),{status:200,headers:{'Content-Type':'application/json'}});
globalThis.fetch=async(url,options={})=>{
 if(url==='https://mock.redis'){
  const c=JSON.parse(options.body);if(c[0]==='GET')return response({result:c[1]==='infinite-buy:v1:state'?raw:redisValues.get(c[1])||null});
  if(c[0]==='SET'){if(c.includes('NX')&&redisValues.has(c[1]))return response({result:null});redisValues.set(c[1],c[2]);return response({result:'OK'});}
  if(c[0]==='EVAL'&&c[3].startsWith('infinite-buy:lock:')){if(redisValues.get(c[3])===c[4]){redisValues.delete(c[3]);return response({result:1});}return response({result:0});}
  if(c[0]==='EVAL'&&c[3]==='infinite-buy:login')return response({result:1});
  assert.equal(c[0],'EVAL');if((raw??'')!==c[4])return response({result:0});raw=c[5];return response({result:1});
 }
 assert.ok(url.startsWith('https://openapi.tossinvest.com/'),'no unexpected network access');
 if(url.endsWith('/oauth2/token'))return response({access_token:'fake-token',expires_in:3600});
 if(url.includes('/market-calendar/US'))return response({result:{today:{date:nyDate(),regularMarket:{startTime:new Date(Date.now()-3600000).toISOString(),endTime:new Date(Date.now()+7200000).toISOString()}}}});
 if(url.includes('/holdings'))return response({result:{items:[{symbol:'TQQQ',quantity:'40',averagePurchasePrice:'50'}]}});
 if(url.includes('/buying-power'))return response({result:{cashBuyingPower:'8000'}});
 if(url.includes('/sellable-quantity'))return response({result:{sellableQuantity:'40'}});
 if(options.method==='POST'&&url.endsWith('/cancel'))return response({result:{orderId:'order-1'}});
 if(options.method==='POST'&&url.endsWith('/orders')){orders.push(JSON.parse(options.body));if(fail)throw Error('simulated timeout');return response({result:{orderId:'order-1'}});}
 if(url.includes('/orders?'))return response({result:{orders:[]}});
 if(url.endsWith('/orders/recover-1')){const o=orders.at(-1);return response({result:{...o,orderId:'recover-1',currency:'USD',orderedAt:new Date().toISOString(),status:'PENDING',execution:{filledQuantity:'0'}}});}
 if(url.endsWith('/orders/order-1'))return response({result:{status:'PARTIAL_FILLED',execution:{filledQuantity:'1',averageFilledPrice:'49',commission:'.049'}}});
 throw Error('unmocked URL '+url);
};
async function req(action,body){let data,status,headers={};await handler({url:'/api/app?action='+action,method:body?'POST':'GET',body,headers:{host:'local',origin:'http://local',cookie}},{setHeader:(k,v)=>headers[k]=v,set statusCode(v){status=v;},end:x=>data=JSON.parse(x)});return {data,status,headers};}
test('LIVE sends exact CLS payload once; partial fill and timeout remain distinct from fills',async()=>{
 const login=await req('login',{password:process.env.APP_PASSWORD});cookie=login.headers['Set-Cookie'].split(';')[0];let s=(await req('state')).data;
 s=(await req('sync',{revision:s.revision,symbol:'TQQQ'})).data;
 let r=await req('plan',{revision:s.revision,symbol:'TQQQ',mode:'LIVE'});assert.equal(r.status,200,JSON.stringify(r.data));s=r.data;const key=Object.keys(s.plans)[0],row=s.plans[key].rows[0];
 r=await req('submit',{revision:s.revision,key,row:row.id,confirm:`TQQQ BUY ${row.qty}`});assert.equal(r.status,200,JSON.stringify(r.data));s=r.data;assert.equal(orders.length,1);assert.equal(orders[0].timeInForce,'CLS');assert.equal(orders[0].orderType,'LIMIT');assert.equal(orders[0].quantity,String(row.qty));assert.equal(orders[0].clientOrderId.length,32);
 r=await req('submit',{revision:s.revision,key,row:row.id,confirm:`TQQQ BUY ${row.qty}`});assert.equal(r.status,400);assert.equal(orders.length,1);
 s=(await req('reconcile',{revision:s.revision,key})).data;assert.equal(s.plans[key].execution[row.id].status,'PARTIAL_FILLED');assert.equal(s.plans[key].execution[row.id].filledQty,'1');
 const row2=s.plans[key].rows[1];fail=true;r=await req('submit',{revision:s.revision,key,row:row2.id,confirm:`TQQQ BUY ${row2.qty}`});assert.equal(r.status,200,JSON.stringify(r.data));s=r.data;assert.equal(s.plans[key].execution[row2.id].status,'UNKNOWN');
 r=await req('submit',{revision:s.revision,key,row:row2.id,confirm:`TQQQ BUY ${row2.qty}`});assert.equal(r.status,400);assert.equal(orders.length,2);
 r=await req('recover',{revision:s.revision,key,row:row2.id,orderId:'recover-1'});assert.equal(r.status,200,JSON.stringify(r.data));assert.equal(r.data.plans[key].execution[row2.id].orderId,'recover-1');
});

test('automation prepares one daily plan, scheduler submits one row and never repeats it',async()=>{
 raw=null;orders=[];fail=false;let s=(await req('state')).data;
 let r=await req('automation',{revision:s.revision,symbol:'TQQQ',enabled:true,minutesBeforeClose:180,confirm:'TQQQ 자동운용 승인'});assert.equal(r.status,200,JSON.stringify(r.data));
 assert.equal((await tick()).status,'PREPARED');
 s=(await req('state')).data;const key=Object.keys(s.plans)[0];
 // A browser cannot claim to be the scheduler and bypass the confirmation field.
 r=await req('submit',{revision:s.revision,key,row:'avg',scheduled:true});assert.equal(r.status,400);assert.equal(orders.length,0);
 assert.equal((await tick()).status,'ACCEPTED');assert.equal(orders.length,1);
 assert.equal((await tick()).status,'ACCEPTED');assert.equal(orders.length,2);assert.notEqual(orders[0].clientOrderId,orders[1].clientOrderId);
 s=(await req('state')).data;await req('pause',{revision:s.revision,paused:true});assert.equal((await tick()).status,'PAUSED');assert.equal(orders.length,2);
});
test('expired scheduled plans do not roll to next trading day',async()=>{
 const s=JSON.parse(raw);s.paused=false;for(const p of Object.values(s.plans)){p.schedule.enabled=true;p.schedule.expires=Date.now()-1;}raw=JSON.stringify(s);
 await tick();assert.equal(orders.length,2);assert.equal(Object.values(JSON.parse(raw).plans)[0].schedule.enabled,false);
});

test('cancel persists intent and reports pending cancellation, not a completed cancellation',async()=>{
 let s=(await req('state')).data;s.paused=false;raw=JSON.stringify(s);
 const key=Object.keys(s.plans)[0],row=s.plans[key].rows[0].id;
 let r=await req('cancel',{revision:s.revision,key,row,confirm:'TQQQ 취소'});assert.equal(r.status,200,JSON.stringify(r.data));s=r.data;
 assert.equal(s.plans[key].execution[row].status,'PENDING_CANCEL');assert.equal(s.plans[key].schedule.enabled,false);
 r=await req('cancel',{revision:s.revision,key,row,confirm:'TQQQ 취소'});assert.equal(r.status,400);
});
