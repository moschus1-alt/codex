import {createHash} from 'node:crypto';
import {read,write,durable,lease} from './store.mjs';
import {connected,toss,snapshot} from './toss.mjs';
import {nyDate} from './strategy.mjs';
import {audit as log,windowFor} from './orders.mjs';
export const canLive=()=>durable()&&connected()&&process.env.LIVE_TRADING_ENABLED==='true'&&process.env.STRATEGY_RULES_CONFIRMED==='true';
export const output=s=>({...s,capabilities:{connected:connected(),live:canLive(),durable:durable()},date:nyDate()});
export async function submitOrder(b){
 const release=await lease('account');
 try{
 const {raw,state:s}=await read();
 if(b.revision!==undefined&&b.revision!==s.revision)throw Error('상태가 변경되었습니다. 새로고침하세요.');
   if(!canLive()||s.paused)throw Error('실거래 잠금 또는 일시정지');
   const p=s.plans[b.key],r=p?.rows.find(x=>x.id===b.row);
   if(!p||p.mode!=='LIVE'||p.status!=='ACTIVE'||p.date!==nyDate()||!r)throw Error('유효한 오늘 LIVE 주문표가 아닙니다.');
   if(!b.scheduled&&b.confirm!==`${p.symbol} ${r.side} ${r.qty}`)throw Error('종목·방향·수량 확인 문구가 일치하지 않습니다.');
   if(p.execution[r.id])throw Error('이미 전송을 시도한 주문입니다. 상태 조회를 사용하세요.');
   if(!b.scheduled&&Date.now()-p.created>15*60000)throw Error('주문표 유효시간 15분이 지났습니다. 미전송 주문표를 폐기 후 다시 만드세요.');
   if(!Object.keys(p.execution).length){const fresh=await snapshot(p.symbol);if(fresh.qty!==p.position.qty||Math.abs(fresh.avg-p.position.avg)>.0001)throw Error('주문표 확정 후 잔고가 바뀌었습니다. 미전송 주문표를 폐기하고 다시 만드세요.');}
   const open=await toss('/api/v1/orders?status=OPEN&symbol='+encodeURIComponent(p.symbol));
   const ours=new Set(Object.values(p.execution).map(x=>x.orderId));
   if(open.orders?.some(x=>!ours.has(x.orderId)))throw Error('외부 미체결 주문이 있습니다. 토스에서 확인하세요.');
   if(r.side==='BUY'){
    const cash=await toss('/api/v1/buying-power?currency=USD');if(!Number.isFinite(Number(cash?.cashBuyingPower)))throw Error('매수 가능금액 응답 오류');if(Number(cash.cashBuyingPower)<r.price*r.qty*(1+p.config.feePct/100))throw Error('매수 가능금액 부족');
   }else{const q=await toss('/api/v1/sellable-quantity?symbol='+encodeURIComponent(p.symbol));if(!Number.isFinite(Number(q?.sellableQuantity)))throw Error('매도 가능수량 응답 오류');if(Number(q.sellableQuantity)<r.qty)throw Error('매도 가능수량 부족');}
   // Persist the attempt BEFORE network I/O. Broker idempotency lasts only ten minutes.
   const calendar=await toss('/api/v1/market-calendar/US?date='+p.date);
   const market=windowFor(calendar,p.date);if(!market.open)throw Error(market.reason);
   if(b.scheduled&&(!p.schedule?.enabled||p.schedule.at>Date.now()||p.schedule.expires<Date.now()))throw Error('예약 실행이 승인되지 않았거나 만료되었습니다.');
   if(Object.values(p.execution).some(e=>['UNKNOWN','SUBMITTING','REPLACED','REJECTED','CANCEL_SUBMITTING','CANCEL_UNKNOWN','PENDING_CANCEL'].includes(e.status)))throw Error('불명 또는 정정 주문이 있어 추가 주문을 차단했습니다.');
   const id=createHash('sha256').update(p.key+':'+r.id).digest('hex').slice(0,32);
   p.execution[r.id]={status:'SUBMITTING',clientOrderId:id,attemptedAt:Date.now()};log(s,{mode:'LIVE',symbol:p.symbol,reason:r.reason,status:'SUBMITTING',side:r.side,qty:r.qty,price:r.price,key:p.key,row:r.id});
   await write(raw,s);
   let result,error;
   try{result=await toss('/api/v1/orders','POST',{clientOrderId:id,symbol:p.symbol,side:r.side,orderType:'LIMIT',timeInForce:r.tif,quantity:String(r.qty),price:r.price.toFixed(2)});if(!result?.orderId)throw Error('주문 식별자가 없는 응답');}catch(e){error=e;}
   // Never re-submit an ambiguous attempt; a crash leaves SUBMITTING permanently blocked.
   for(let i=0;i<3;i++){
    const current=await read(),target=current.state.plans[b.key];
    target.execution[r.id]={...target.execution[r.id],status:error?(error.definiteReject?'REJECTED':'UNKNOWN'):'ACCEPTED',clientOrderId:id,orderId:result?.orderId||null,error:error?.message||null};
    log(current.state,{mode:'LIVE',symbol:p.symbol,reason:error?'주문 결과 불명 · 자동 재전송 금지':r.reason,status:error?(error.definiteReject?'REJECTED':'UNKNOWN'):'ACCEPTED',orderId:result?.orderId,side:r.side,qty:r.qty,price:r.price,key:p.key,row:r.id});
    try{await write(current.raw,current.state);return {...output(current.state),notice:error?error.message:'접수 완료 · 체결은 상태 조회로 확인하세요.'};}catch(e){if(i===2)throw Error('결과 저장 충돌. 토스에서 주문 확인 후 새로고침하세요. 재전송하지 마세요.');}
   }
 }finally{await release();}
}
export async function cancelOrder(b){
 const release=await lease('account');
 try{
  const {raw,state:s}=await read();if(s.revision!==b.revision)throw Error('상태가 변경되었습니다. 새로고침하세요.');
  const p=s.plans[b.key],e=p?.execution[b.row];
  if(!p||p.mode!=='LIVE'||!e?.orderId||!['ACCEPTED','PENDING','PARTIAL_FILLED'].includes(e.status))throw Error('취소 가능한 주문이 아닙니다. 상태 조회를 먼저 하세요.');
  if(b.confirm!==`${p.symbol} 취소`)throw Error('취소 확인 문구가 일치하지 않습니다.');
  e.status='CANCEL_SUBMITTING';if(p.schedule)p.schedule.enabled=false;
  log(s,{mode:'LIVE',symbol:p.symbol,reason:'주문 취소 요청 기록',orderId:e.orderId,status:e.status});await write(raw,s);
  let error;try{await toss('/api/v1/orders/'+encodeURIComponent(e.orderId)+'/cancel','POST',{});}catch(err){error=err;}
  const current=await read(),ce=current.state.plans[b.key].execution[b.row];ce.status=error?'CANCEL_UNKNOWN':'PENDING_CANCEL';
  log(current.state,{mode:'LIVE',symbol:p.symbol,reason:error?'취소 결과 불명 · 상태 조회 필요':'취소 접수 · 최종 상태 조회 필요',orderId:e.orderId,status:ce.status});
  await write(current.raw,current.state);return output(current.state);
 }finally{await release();}
}
