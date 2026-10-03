import {randomUUID} from 'node:crypto';
import {submitOrder,cancelOrder,canLive,output} from '../lib/execution.mjs';
import {applyBroker,matchOrder,terminal,windowFor} from '../lib/orders.mjs';
import {read,write,durable,loginLimit} from '../lib/store.mjs';
import {plan,validateConfig,validatePosition,nyDate,simulate,num} from '../lib/strategy.mjs';
import {connected,toss,snapshot} from '../lib/toss.mjs';
import {same,issue,authenticated,sameOrigin} from '../lib/auth.mjs';
const config=(s,symbol)=>s.symbols.find(x=>x.symbol===symbol)?.override||s.common;
function symbolCheck(s,symbol){if(!s.symbols.some(x=>x.symbol===symbol))throw Error('등록되지 않은 종목입니다.');}
const log=(s,x)=>{s.logs.push({id:randomUUID(),at:new Date().toISOString(),...x});};
export default async function handler(req,res){
 res.setHeader('Cache-Control','no-store');res.setHeader('Content-Type','application/json; charset=utf-8');
 const send=(status,data)=>{res.statusCode=status;res.end(JSON.stringify(data));};
 try{
  if(req.method!=='POST'&&req.method!=='GET')return send(405,{error:'허용되지 않은 방식'});
  const action=new URL(req.url,'https://local').searchParams.get('action')||'state';
  if(req.method==='POST'&&!sameOrigin(req))return send(403,{error:'요청 출처 확인 실패'});
  if(JSON.stringify(req.body||{}).length>64000)throw Error('요청 크기 초과');
  const b=typeof req.body==='string'?JSON.parse(req.body):req.body||{};
  if(action==='login'&&req.method==='POST'){
   await loginLimit();if(!process.env.APP_PASSWORD||process.env.APP_PASSWORD.length<16)throw Error('APP_PASSWORD를 16자 이상으로 설정하세요.');
   if(!same(b.password,process.env.APP_PASSWORD))return send(401,{error:'비밀번호를 확인하세요.'});
   res.setHeader('Set-Cookie',`ib_session=${issue()}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${process.env.VERCEL?'; Secure':''}`);return send(200,{ok:true});
  }
  if(!authenticated(req))return send(401,{error:'로그인이 필요합니다.'});
  if(action==='logout'&&req.method==='POST'){res.setHeader('Set-Cookie','ib_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');return send(200,{ok:true});}
  const {raw,state:s}=await read();
  if(action==='state'&&req.method==='GET')return send(200,output(s));
  if(action==='quotes'&&req.method==='GET')return send(200,await toss('/api/v1/prices?symbols='+encodeURIComponent(s.symbols.map(x=>x.symbol).join(','))));
  if(req.method!=='POST')return send(405,{error:'POST가 필요합니다.'});
  if(b.revision!==s.revision)throw Error('상태가 변경되었습니다. 새로고침 후 다시 시도하세요.');
  if(action==='pause'){s.paused=!!b.paused;log(s,{mode:'SYSTEM',reason:s.paused?'전체 신규주문 일시정지 (기존 주문은 유지)':'신규주문 재개'});}
  else if(action==='settings'){
   if(Object.values(s.plans).some(p=>p.mode==='LIVE'&&p.status==='ACTIVE'))throw Error('진행 중인 LIVE 주문표가 있습니다.');
   s.common=validateConfig(b.common);s.automation={};
   if(!Array.isArray(b.symbols)||b.symbols.length<1||b.symbols.length>6)throw Error('종목 수는 1~6개입니다.');
   const seen=new Set();s.symbols=b.symbols.map(x=>{if(!/^[A-Z][A-Z0-9.-]{0,9}$/.test(x.symbol)||seen.has(x.symbol))throw Error('티커 중복 또는 형식 오류');seen.add(x.symbol);return {symbol:x.symbol,override:x.override?validateConfig(x.override):null};});
   for(const x of s.symbols)s.paper[x.symbol]??={qty:0,avg:0,cost:0,cash:config(s,x.symbol).seed};
   log(s,{mode:'SYSTEM',reason:'공통·종목별 설정 저장 (기존 계좌 잔액 유지)'});
  }
  else if(action==='position'){
   symbolCheck(s,b.symbol);if(b.mode!=='PAPER')throw Error('실거래 잔고는 토스 동기화를 사용하세요.');
   s.paper[b.symbol]=validatePosition(b.position);log(s,{mode:'PAPER',symbol:b.symbol,reason:'모의계좌 잔고 수동 입력'});
  }
  else if(action==='sync'){
   symbolCheck(s,b.symbol);s.live[b.symbol]=await snapshot(b.symbol);log(s,{mode:'LIVE',symbol:b.symbol,reason:'토스 잔고 동기화 · 해당 종목 전체 보유분 기준'});
  }
  else if(action==='plan'){
   symbolCheck(s,b.symbol);if(s.paused)throw Error('신규주문 일시정지 상태입니다.');
   if(!['PAPER','LIVE'].includes(b.mode))throw Error('모드 오류');
   const key=`${b.mode}:${nyDate()}:${b.symbol}`;
   if(s.plans[key])throw Error('오늘 주문표가 이미 있습니다. 주문·체결 탭에서 확인하세요.');
   if(b.mode==='LIVE'&&Object.values(s.plans).some(p=>p.mode==='LIVE'&&p.symbol===b.symbol&&Object.values(p.execution).some(e=>!terminal(e))))throw Error('이전 주문이 미체결 또는 결과 불명입니다. 먼저 상태를 확인하세요.');
   const p=s[b.mode.toLowerCase()][b.symbol];if(!p)throw Error('잔고를 먼저 동기화하세요.');
   if(b.mode==='LIVE'&&(Date.now()-p.at>60000||!canLive()))throw Error('실거래 잠금 또는 잔고 유효시간 초과 (60초)');
   const c=config(s,b.symbol),result=plan(c,p,Number(b.firstPrice||0));
   if(result.phase==='QUARTER'||!result.rows.length)throw Error(result.warnings.join(' / '));
   if(result.rows.some(r=>r.price*r.qty>c.maxOrder))throw Error('주문 한도를 초과했습니다. 설정을 확인하세요.');
   s.plans[key]={...result,key,symbol:b.symbol,mode:b.mode,date:nyDate(),position:{...p},config:{...c},status:'ACTIVE',created:Date.now(),execution:{}};
   log(s,{mode:b.mode,symbol:b.symbol,reason:'오늘 주문표 확정',key});
  }
  else if(action==='paperFill'){
   const p=s.plans[b.key];if(!p||p.mode!=='PAPER'||p.status!=='ACTIVE')throw Error('처리할 모의 주문표가 없습니다.');
   if(s.paused)throw Error('일시정지 상태입니다.');
   if(JSON.stringify(s.paper[p.symbol])!==JSON.stringify(p.position))throw Error('주문표 확정 후 잔고가 바뀌었습니다.');
   const result=simulate(p.config,p.position,p.rows,b.bar);s.paper[p.symbol]=result.position;p.status='COMPLETED';
   for(const f of result.fills)log(s,{mode:'PAPER',symbol:p.symbol,reason:f.reason,status:'FILLED',side:f.side,qty:f.qty,price:f.fillPrice,pnl:f.pnl,fee:f.fee});
   log(s,{mode:'PAPER',symbol:p.symbol,reason:`종가 시뮬레이션 완료 · ${result.fills.length}건 체결`,status:'COMPLETED'});
  }
  else if(action==='discard'){
   const p=s.plans[b.key];if(!p||p.schedule?.enabled||Object.keys(p.execution).length||p.status!=='ACTIVE')throw Error('전송 이력이 있는 주문표는 폐기할 수 없습니다.');
   delete s.plans[b.key];log(s,{mode:p.mode,symbol:p.symbol,reason:'미전송 주문표 폐기'});
  }
  else if(action==='submit'){return send(200,await submitOrder({...b,scheduled:false}));}
  else if(action==='cancel'){return send(200,await cancelOrder(b));}
  else if(action==='automation'){
   symbolCheck(s,b.symbol);s.automation??={};
   if(b.enabled){
    if(!canLive()||s.paused||!process.env.CRON_SECRET||process.env.CRON_SECRET.length<32)throw Error('LIVE와 예약 실행 인증 설정이 필요합니다.');
    if(b.confirm!==`${b.symbol} 자동운용 승인`)throw Error('자동운용 확인 문구가 일치하지 않습니다.');
    if(!Number.isInteger(b.minutesBeforeClose)||b.minutesBeforeClose<120||b.minutesBeforeClose>360)throw Error('장 종료 120~360분 전으로 설정하세요.');
    s.automation[b.symbol]={enabled:true,minutesBeforeClose:b.minutesBeforeClose,approvedAt:Date.now()};
   }else{
    s.automation[b.symbol]={...s.automation[b.symbol],enabled:false};
    for(const p of Object.values(s.plans))if(p.symbol===b.symbol&&p.schedule?.automatic)p.schedule.enabled=false;
   }
   log(s,{mode:'LIVE',symbol:b.symbol,reason:b.enabled?'일별 자동운용 승인':'자동운용 해제',status:'AUTOMATION'});
  }
  else if(action==='schedule'){
   const p=s.plans[b.key];if(!p||p.mode!=='LIVE'||p.status!=='ACTIVE'||p.date!==nyDate())throw Error('오늘 LIVE 주문표가 필요합니다.');
   if(!b.enabled){if(p.schedule)p.schedule.enabled=false;}
   else{
    if(!canLive()||s.paused||!process.env.CRON_SECRET||process.env.CRON_SECRET.length<32)throw Error('실거래·예약 인증 설정이 필요합니다.');
    if(b.confirm!==`${p.symbol} 전체 예약`)throw Error('전체 예약 확인 문구가 일치하지 않습니다.');
    if(Object.keys(p.execution).length)throw Error('전송 이력이 없는 주문표만 예약할 수 있습니다.');
    const market=windowFor(await toss('/api/v1/market-calendar/US?date='+p.date),p.date);
    const at=Number(b.at);if(!Number.isFinite(at)||at<Math.max(Date.now(),market.start)||at>market.cutoff-30*60000)throw Error('정규장 시작 이후부터 앱 마감 30분 전 사이로 예약하세요.');
    if(!market.start)throw Error(market.reason);
    p.schedule={enabled:true,at,expires:market.cutoff,approvedAt:Date.now()};
   }
   log(s,{mode:'LIVE',symbol:p.symbol,reason:b.enabled?'오늘 주문표 전체 예약 승인':'예약 실행 해제',status:'SCHEDULE'});
  }
  else if(action==='recover'){
   const p=s.plans[b.key],e=p?.execution[b.row];
   if(!p||p.mode!=='LIVE'||!['UNKNOWN','SUBMITTING'].includes(e?.status)||e.orderId)throw Error('복구할 불명 주문이 아닙니다.');
   if(typeof b.orderId!=='string'||b.orderId.length<1||b.orderId.length>256)throw Error('증권사 주문ID를 입력하세요.');
   if(Object.values(s.plans).some(p=>Object.values(p.execution).some(e=>e.orderId===b.orderId)))throw Error('이미 연결된 주문ID입니다.');
   const broker=await toss('/api/v1/orders/'+encodeURIComponent(b.orderId));
   matchOrder(p,b.row,broker);e.orderId=b.orderId;applyBroker(p,b.row,broker);
   log(s,{mode:'LIVE',symbol:p.symbol,reason:'불명 주문을 증권사 주문ID와 대조해 복구',status:e.status,orderId:e.orderId});
  }
  else if(action==='retire'){
   const p=s.plans[b.key];if(!p||p.date>=nyDate()||Object.values(p.execution).some(e=>!terminal(e)))throw Error('지난 거래일이며 모든 전송 주문이 종결된 경우에만 마감할 수 있습니다.');
   p.status='COMPLETED';if(p.schedule)p.schedule.enabled=false;
   log(s,{mode:p.mode,symbol:p.symbol,reason:'지난 주문표의 미전송 행 마감'});
  }
  else if(action==='reconcile'){
   const p=s.plans[b.key];if(!p||p.mode!=='LIVE')throw Error('LIVE 주문표가 아닙니다.');
   for(const e of Object.values(p.execution))if(e.orderId){
    const r=await toss('/api/v1/orders/'+encodeURIComponent(e.orderId));const id=Object.keys(p.execution).find(k=>p.execution[k]===e);const delta=applyBroker(p,id,r);if(delta>0)log(s,{mode:'LIVE',symbol:p.symbol,reason:'추가 체결 확인',qty:delta,price:Number(r.execution.averageFilledPrice),status:r.status,orderId:e.orderId});
   }
   if(Object.keys(p.execution).length===p.rows.length&&Object.values(p.execution).every(e=>terminal(e)))p.status='COMPLETED';
   log(s,{mode:'LIVE',symbol:p.symbol,reason:'주문 상태 조회 완료',status:'SYNCED'});
  }
  else throw Error('알 수 없는 작업입니다.');
  await write(raw,s);return send(200,output(s));
 }catch(e){return send(400,{error:e.message||'요청 처리 실패'});}
}
