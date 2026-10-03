import test from 'node:test';import assert from 'node:assert/strict';import handler from '../api/cron.mjs';
test('cron requires independent secret; session cookie cannot authorize jobs',async()=>{
 process.env.CRON_SECRET='cron-test-secret-at-least-32-characters';
 async function req(headers){let status;await handler({method:'GET',headers},{setHeader(){},set statusCode(s){status=s;},end(){}});return status;}
 assert.equal(await req({cookie:'ib_session=anything'}),401);
 assert.equal(await req({authorization:'Bearer wrong'}),401);
 delete process.env.UPSTASH_REDIS_REST_URL;delete process.env.UPSTASH_REDIS_REST_TOKEN;
 assert.equal(await req({authorization:'Bearer '+process.env.CRON_SECRET}),503);
});
