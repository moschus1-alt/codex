import fs from 'node:fs';
const enabled=process.argv.includes('--enable');
const file='vercel.json',config=JSON.parse(fs.readFileSync(file,'utf8'));
if(enabled)config.crons=[{path:'/api/cron',schedule:'* * * * *'}];else delete config.crons;
fs.writeFileSync(file,JSON.stringify(config,null,2)+'\n');
console.log(enabled?'1-minute Vercel Cron configured. Requires a compatible paid Vercel plan and CRON_SECRET; deploy to apply.':'Vercel Cron removed. External scheduler can still call /api/cron.');
