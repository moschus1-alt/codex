import {same} from '../lib/auth.mjs';
import {durable} from '../lib/store.mjs';
import {tick} from '../lib/scheduler.mjs';
export default async function handler(req,res){
 res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');
 const send=(s,d)=>{res.statusCode=s;res.end(JSON.stringify(d));};
 if(!['GET','POST'].includes(req.method))return send(405,{error:'Method not allowed'});
 const secret=process.env.CRON_SECRET;
 if(!secret||secret.length<32||!same(req.headers.authorization||'',`Bearer ${secret}`))return send(401,{error:'Unauthorized'});
 if(!durable())return send(503,{error:'Durable storage required'});
 try{return send(200,await tick());}catch{return send(503,{error:'Scheduled execution stopped; inspect app logs'});}
}
