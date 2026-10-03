import {createHash,randomUUID} from 'node:crypto';
import {read,write,durable,loginLimit} from '../lib/store.mjs';
import {plan,validateConfig,validatePosition,nyDate,simulate,num} from '../lib/strategy.mjs';
import {connected,toss,snapshot} from '../lib/toss.mjs';
import {same,issue,authenticated,sameOrigin} from '../lib/auth.mjs';
const canLive=()=>durable()&&connected()&&process.env.LIVE_TRADING_ENABLED==='true'&&process.env.STRATEGY_RULES_CONFIRMED==='true';
const config=(s,symbol)=>s.symbols.find(x=>x.symbol===symbol)?.override||s.common;
function symbolCheck(s,symbol){if(!s.symbols.some(x=>x.symbol===symbol))throw Error('등록되지 않은 종목입니다.');}
const log=(s,x)=>{s.logs.push({id:randomUUID(),at:new Date().toISOString(),...x});};
const output=s=>({...s,capabilities:{connected:connected(),live:canLive(),durable:durable()},date:nyDate()});
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
   s.common=validateConfig(b.common);
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
   if(b.mode==='LIVE'&&Object.values(s.plans).some(p=>p.mode==='LIVE'&&p.symbol===b.symbol&&Object.values(p.execution).some(e=>!['FILLED','CANCELED','REJECTED','REPLACED'].includes(e.status))))throw Error('이전 주문이 미체결 또는 결과 불명입니다. 먼저 상태를 확인하세요.');
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
   const p=s.plans[b.key];if(!p||Object.keys(p.execution).length||p.status!=='ACTIVE')throw Error('전송 이력이 있는 주문표는 폐기할 수 없습니다.');
   delete s.plans[b.key];log(s,{mode:p.mode,symbol:p.symbol,reason:'미전송 주문표 폐기'});
  }
  else if(action==='submit'){
   if(!canLive()||s.paused)throw Error('실거래 잠금 또는 일시정지');
   const p=s.plans[b.key],r=p?.rows.find(x=>x.id===b.row);
   if(!p||p.mode!=='LIVE'||p.status!=='ACTIVE'||p.date!==nyDate()||!r)throw Error('유효한 오늘 LIVE 주문표가 아닙니다.');
   if(b.confirm!==`${p.symbol} ${r.side} ${r.qty}`)throw Error('종목·방향·수량 확인 문구가 일치하지 않습니다.');
   if(p.execution[r.id])throw Error('이미 전송을 시도한 주문입니다. 상태 조회를 사용하세요.');
   if(Date.now()-p.created>15*60000)throw Error('주문표 유효시간 15분이 지났습니다. 미전송 주문표를 폐기 후 다시 만드세요.');
   if(!Object.keys(p.execution).length){const fresh=await snapshot(p.symbol);if(fresh.qty!==p.position.qty||Math.abs(fresh.avg-p.position.avg)>.0001)throw Error('주문표 확정 후 잔고가 바뀌었습니다. 미전송 주문표를 폐기하고 다시 만드세요.');}
   const open=await toss('/api/v1/orders?status=OPEN&symbol='+encodeURIComponent(p.symbol));
   const ours=new Set(Object.values(p.execution).map(x=>x.orderId));
   if(open.orders?.some(x=>!ours.has(x.orderId)))throw Error('외부 미체결 주문이 있습니다. 토스에서 확인하세요.');
   if(r.side==='BUY'){
    const cash=await toss('/api/v1/buying-power?currency=USD');if(Number(cash.cashBuyingPower)<r.price*r.qty*(1+p.config.feePct/100))throw Error('매수 가능금액 부족');
   }else{const q=await toss('/api/v1/sellable-quantity?symbol='+encodeURIComponent(p.symbol));if(Number(q.sellableQuantity)<r.qty)throw Error('매도 가능수량 부족');}
   // Persist the attempt BEFORE network I/O. Broker idempotency lasts only ten minutes.
   const id=createHash('sha256').update(p.key+':'+r.id).digest('hex').slice(0,32);
   p.execution[r.id]={status:'SUBMITTING',clientOrderId:id};log(s,{mode:'LIVE',symbol:p.symbol,reason:r.reason,status:'SUBMITTING',side:r.side,qty:r.qty,price:r.price,key:p.key,row:r.id});
   await write(raw,s);
   let result,error;
   try{result=await toss('/api/v1/orders','POST',{clientOrderId:id,symbol:p.symbol,side:r.side,orderType:'LIMIT',timeInForce:r.tif,quantity:String(r.qty),price:r.price.toFixed(2)});}catch(e){error=e;}
   // Never re-submit an ambiguous attempt; a crash leaves SUBMITTING permanently blocked.
   for(let i=0;i<3;i++){
    const current=await read(),target=current.state.plans[b.key];
    target.execution[r.id]={status:error?'UNKNOWN':'ACCEPTED',clientOrderId:id,orderId:result?.orderId||null};
    log(current.state,{mode:'LIVE',symbol:p.symbol,reason:error?'주문 결과 불명 · 자동 재전송 금지':r.reason,status:error?'UNKNOWN':'ACCEPTED',orderId:result?.orderId,side:r.side,qty:r.qty,price:r.price,key:p.key,row:r.id});
    try{await write(current.raw,current.state);return send(200,{...output(current.state),notice:error?error.message:'접수 완료 · 체결은 상태 조회로 확인하세요.'});}catch(e){if(i===2)throw Error('결과 저장 충돌. 토스에서 주문 확인 후 새로고침하세요. 재전송하지 마세요.');}
   }
  }
  else if(action==='reconcile'){
   const p=s.plans[b.key];if(!p||p.mode!=='LIVE')throw Error('LIVE 주문표가 아닙니다.');
   for(const e of Object.values(p.execution))if(e.orderId){
    const r=await toss('/api/v1/orders/'+encodeURIComponent(e.orderId));e.status=r.status;e.filledQty=r.execution?.filledQuantity;e.averageFilledPrice=r.execution?.averageFilledPrice;e.commission=r.execution?.commission;
   }
   if(Object.keys(p.execution).length===p.rows.length&&Object.values(p.execution).every(e=>['FILLED','CANCELED','REJECTED','REPLACED'].includes(e.status)))p.status='COMPLETED';
   log(s,{mode:'LIVE',symbol:p.symbol,reason:'주문 상태 조회 완료 · UNKNOWN은 토스 앱에서 확인',status:'SYNCED'});
  }
  else throw Error('알 수 없는 작업입니다.');
  await write(raw,s);return send(200,output(s));
 }catch(e){return send(400,{error:e.message||'요청 처리 실패'});}
}
