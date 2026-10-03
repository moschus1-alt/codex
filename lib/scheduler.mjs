import {toss,snapshot} from './toss.mjs';
import {canLive} from './execution.mjs';
import {read,write} from './store.mjs';
import {submitOrder} from './execution.mjs';
import {audit,terminal,windowFor,applyBroker} from './orders.mjs';
import {nyDate,plan} from './strategy.mjs';
// Execute at most one row per invocation. Six symbols need a polling scheduler.
export async function tick(){
 const {state:s}=await read();if(s.paused)return {status:'PAUSED'};
 const now=Date.now();
 const due=Object.values(s.plans).filter(p=>p.mode==='LIVE'&&p.status==='ACTIVE'&&p.schedule?.enabled&&p.schedule.at<=now).sort((a,b)=>a.schedule.at-b.schedule.at);
 for(const p of due){
  if(p.date!==nyDate()||p.schedule.expires<=now){await disable(p.key,'예약 만료 · 다음 거래일에 이월하지 않음');continue;}
  if(Object.values(p.execution).some(e=>['UNKNOWN','SUBMITTING','REJECTED','REPLACED'].includes(e.status))){await disable(p.key,'주문 오류 또는 불명 상태 · 남은 예약 중단');continue;}
  const row=p.rows.find(r=>!p.execution[r.id]);
  if(!row){await disable(p.key,'예약 주문 전송 완료 · 체결 상태를 확인하세요.');continue;}
  try{
   const out=await submitOrder({key:p.key,row:row.id,scheduled:true});
   const status=out.plans[p.key].execution[row.id].status;
   if(status!=='ACCEPTED')await disable(p.key,'주문 거절/불명 · 예약 중단');
   return {status,key:p.key,row:row.id};
  }catch(e){await disable(p.key,e.message);return {status:'STOPPED',reason:e.message};}
 }
 const old=Object.values(s.plans).find(p=>p.mode==='LIVE'&&p.date<nyDate()&&Object.values(p.execution).some(e=>e.orderId&&!terminal(e)&&e.status!=='REPLACED'&&(!e.updatedAt||now-e.updatedAt>300000)));
 if(old){
  for(const [id,e] of Object.entries(old.execution))if(e.orderId&&!terminal(e)){const broker=await toss('/api/v1/orders/'+encodeURIComponent(e.orderId));applyBroker(old,id,broker);break;}
  const current=await read();if(current.state.revision===s.revision){current.state.plans[old.key]=old;await write(current.raw,current.state);}return {status:'RECONCILED',key:old.key};
 }
 return await prepareAutomatic(s,now);
}
async function disable(key,reason){
 for(let i=0;i<3;i++){
  const current=await read(),p=current.state.plans[key];if(!p)return;
  p.schedule.enabled=false;p.schedule.result=reason;
  audit(current.state,{mode:'LIVE',symbol:p.symbol,reason,status:'SCHEDULE'});
  try{await write(current.raw,current.state);return;}catch(e){if(i===2)throw e;}
 }
}

async function prepareAutomatic(s,now){
 if(!canLive())return {status:'LOCKED'};
 const date=nyDate();
 const candidates=s.symbols.filter(x=>s.automation?.[x.symbol]?.enabled&&!s.plans[`LIVE:${date}:${x.symbol}`]&&s.automation[x.symbol].blockedDate!==date);
 if(!candidates.length)return {status:'IDLE'};
 const market=windowFor(await toss('/api/v1/market-calendar/US?date='+date),date,now);
 if(!market.open)return {status:'CLOSED',reason:market.reason};
 for(const item of candidates){
  const a=s.automation[item.symbol];
  const start=Math.max(market.start,market.end-a.minutesBeforeClose*60000);
  if(now<start||now>market.cutoff-30*60000)continue;
  try{
   if(Object.values(s.plans).some(p=>p.mode==='LIVE'&&p.symbol===item.symbol&&Object.values(p.execution).some(e=>!terminal(e))))throw Error('이전 주문 미종결');
   const position=await snapshot(item.symbol);if(!position.qty)throw Error('보유 없음: 최초 진입/새 사이클은 수동 주문표로 시작하세요.');
   const config=item.override||s.common,result=plan(config,position);
   if(result.phase==='QUARTER'||!result.rows.length)throw Error('쿼터손절 또는 생성 가능한 주문 없음');
   if(result.rows.some(r=>r.price*r.qty>config.maxOrder))throw Error('단일 주문 한도 초과');
   const current=await read();
   // Recheck persisted approvals/configuration after all network calls.
   if(current.state.revision!==s.revision||!current.state.automation?.[item.symbol]?.enabled||current.state.paused)throw Error('설정 변경 감지 · 이번 실행 중단');
   const key=`LIVE:${date}:${item.symbol}`;
   current.state.live[item.symbol]=position;
   current.state.plans[key]={...result,key,symbol:item.symbol,mode:'LIVE',date,position,config,status:'ACTIVE',created:Date.now(),execution:{},schedule:{enabled:true,at:now,expires:market.cutoff,approvedAt:a.approvedAt,automatic:true}};
   audit(current.state,{mode:'LIVE',symbol:item.symbol,reason:'자동 운용 · 잔고 기반 오늘 주문표 생성',status:'SCHEDULE'});
   await write(current.raw,current.state);return {status:'PREPARED',key};
  }catch(e){
   const c=await read();if(c.state.automation?.[item.symbol]){c.state.automation[item.symbol].blockedDate=date;c.state.automation[item.symbol].reason=e.message;audit(c.state,{mode:'LIVE',symbol:item.symbol,reason:'오늘 자동 운용 중단: '+e.message,status:'STOPPED'});await write(c.raw,c.state);}
   return {status:'STOPPED',reason:e.message};
  }
 }
 return {status:'WAITING'};
}
