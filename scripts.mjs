import {execFileSync} from 'node:child_process';
import {readdirSync} from 'node:fs';
for(const dir of ['lib','api','public'])for(const f of readdirSync(dir))if(f.endsWith('.mjs'))execFileSync(process.execPath,['--check',`${dir}/${f}`]);
console.log('Build verified: static public/ + Vercel Node API');
