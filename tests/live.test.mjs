import test from 'node:test';import assert from 'node:assert/strict';import handler from '../api/app.mjs';
Object.assign(process.env,{APP_PASSWORD:'test-password-12345678',SESSION_SECRET:'test-secret-more-than-32-characters',UPSTASH_REDIS_REST_URL:'https://mock.redis',UPSTASH_REDIS_REST_TOKEN:'fake',TOSS_CLIENT_ID:'fake',TOSS_CLIENT_SECRET:'fake',TOSS_ACCOUNT_SEQ:'fake',LIVE_TRADING_ENABLED:'true',STRATEGY_RULES_CONFIRMED:'true'});
let raw=null,cookie,orders=[],fail=false;
const response=result=>new Response(JSON.stringify(result),{status:200,headers:{'Content-Type':'application/json'}});
globalThis.fetch=async(url,options={})=>{
 if(url==='https://mock.redis'){
  const c=JSON.parse(options.body);if(c[0]==='GET')return response({result:raw});
  if(c[0]==='EVAL'&&c[3]==='infinite-buy:login')return response({result:1});
  assert.equal(c[0],'EVAL');if((raw??'')!==c[4])return response({result:0});raw=c[5];return response({result:1});
 }
 assert.ok(url.startsWith('https://openapi.tossinvest.com/'),'no unexpected network access');
 if(url.endsWith('/oauth2/token'))return response({access_token:'fake-token',expires_in:3600});
 if(url.includes('/holdings'))return response({result:{items:[{symbol:'TQQQ',quantity:'40',averagePurchasePrice:'50'}]}});
 if(url.includes('/buying-power'))return response({result:{cashBuyingPower:'8000'}});
 if(url.includes('/sellable-quantity'))return response({result:{sellableQuantity:'40'}});
 if(options.method==='POST'&&url.endsWith('/orders')){orders.push(JSON.parse(options.body));if(fail)throw Error('simulated timeout');return response({result:{orderId:'order-1'}});}
 if(url.includes('/orders?'))return response({result:{orders:[]}});
 if(url.endsWith('/orders/order-1'))return response({result:{status:'PARTIAL_FILLED',execution:{filledQuantity:'1',averageFilledPrice:'49',commission:'.049'}}});
 throw Error('unmocked URL '+url);
};
async function req(action,body){let data,status,headers={};await handler({url:'/api/app?action='+action,method:body?'POST':'GET',body,headers:{host:'local',origin:'http://local',cookie}},{setHeader:(k,v)=>headers[k]=v,set statusCode(v){status=v;},end:x=>data=JSON.parse(x)});return {data,status,headers};}
test('LIVE sends exact CLS payload once; partial fill and timeout remain distinct from fills',async()=>{
 const login=await req('login',{password:process.env.APP_PASSWORD});cookie=login.headers['Set-Cookie'].split(';')[0];let s=(await req('state')).data;
 s=(await req('sync',{revision:s.revision,symbol:'TQQQ'})).data;
 let r=await req('plan',{revision:s.revision,symbol:'TQQQ',mode:'LIVE'});assert.equal(r.status,200);s=r.data;const key=Object.keys(s.plans)[0],row=s.plans[key].rows[0];
 r=await req('submit',{revision:s.revision,key,row:row.id,confirm:`TQQQ BUY ${row.qty}`});assert.equal(r.status,200);s=r.data;assert.equal(orders.length,1);assert.equal(orders[0].timeInForce,'CLS');assert.equal(orders[0].orderType,'LIMIT');assert.equal(orders[0].quantity,String(row.qty));assert.equal(orders[0].clientOrderId.length,32);
 r=await req('submit',{revision:s.revision,key,row:row.id,confirm:`TQQQ BUY ${row.qty}`});assert.equal(r.status,400);assert.equal(orders.length,1);
 s=(await req('reconcile',{revision:s.revision,key})).data;assert.equal(s.plans[key].execution[row.id].status,'PARTIAL_FILLED');assert.equal(s.plans[key].execution[row.id].filledQty,'1');
 const row2=s.plans[key].rows[1];fail=true;r=await req('submit',{revision:s.revision,key,row:row2.id,confirm:`TQQQ BUY ${row2.qty}`});assert.equal(r.status,200);s=r.data;assert.equal(s.plans[key].execution[row2.id].status,'UNKNOWN');
 r=await req('submit',{revision:s.revision,key,row:row2.id,confirm:`TQQQ BUY ${row2.qty}`});assert.equal(r.status,400);assert.equal(orders.length,2);
});
