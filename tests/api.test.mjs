import test from 'node:test';import assert from 'node:assert/strict';import handler from '../api/app.mjs';
process.env.APP_PASSWORD='test-only-password-long';process.env.SESSION_SECRET='test-only-session-secret-32-characters-long';
let cookie;
async function request(action,body,auth=true,origin='http://local'){
 let status,headers={},result;const req={url:'/api/app?action='+action,method:body?'POST':'GET',body,headers:{host:'local',origin,...(auth?{cookie}: {})}};
 await handler(req,{setHeader:(k,v)=>headers[k]=v,set statusCode(v){status=v;},end:x=>result=JSON.parse(x)});return {status,headers,data:result};
}
test('full paper API lifecycle, duplicate prevention, LIVE gate and CSRF',async()=>{
 assert.equal((await request('state',null,false)).status,401);
 const login=await request('login',{password:process.env.APP_PASSWORD},false);assert.equal(login.status,200);cookie=login.headers['Set-Cookie'].split(';')[0];
 let s=(await request('state')).data;
 assert.equal((await request('pause',{revision:s.revision,paused:true},true,'http://evil')).status,403);
 let r=await request('plan',{revision:s.revision,symbol:'TQQQ',mode:'PAPER',firstPrice:50});assert.equal(r.status,200);s=r.data;
 assert.equal((await request('plan',{revision:s.revision,symbol:'TQQQ',mode:'PAPER',firstPrice:50})).status,400);
 const key=Object.keys(s.plans)[0];r=await request('paperFill',{revision:s.revision,key,bar:{high:52,close:49}});assert.equal(r.status,200);s=r.data;assert.equal(s.paper.TQQQ.qty,4);
 assert.equal((await request('paperFill',{revision:s.revision,key,bar:{high:52,close:49}})).status,400);
 assert.equal((await request('submit',{revision:s.revision,key,row:'first',confirm:'TQQQ BUY 4'})).status,400);
 r=await request('pause',{revision:s.revision,paused:true});assert.equal(r.status,200);
 assert.equal((await request('settings',{revision:s.revision,common:s.common,symbols:s.symbols})).status,400);
});
