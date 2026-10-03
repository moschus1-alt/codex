import http from 'node:http';import fs from 'node:fs/promises';import path from 'node:path';import handler from './api/app.mjs';
const root=path.resolve('public');
http.createServer(async(req,res)=>{try{
 if(req.url.startsWith('/api/app')){let b='';for await(const x of req){b+=x;if(b.length>64000){res.writeHead(413);res.end();return;}}req.body=b?JSON.parse(b):{};return await handler(req,res);}
 const pathname=new URL(req.url,'http://localhost').pathname;const f=path.resolve(root,'.'+(pathname==='/'?'/index.html':pathname));if(!f.startsWith(root+'/')){res.writeHead(403);res.end();return;}
 const mime={'.html':'text/html','.css':'text/css','.mjs':'text/javascript'};res.setHeader('Content-Type',mime[path.extname(f)]||'text/plain');res.end(await fs.readFile(f));
}catch{res.writeHead(404);res.end('Not found');}}).listen(Number(process.env.PORT||3000),'0.0.0.0',()=>console.log('http://localhost:3000'));
