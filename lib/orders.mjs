import {randomUUID} from 'node:crypto';
import {nyDate} from './strategy.mjs';
export const terminal=e=>['FILLED','CANCELED','REJECTED'].includes(e?.status);
export const unresolved=e=>!terminal(e);
export function audit(s,x){s.logs.push({id:randomUUID(),at:new Date().toISOString(),...x});}
export function matchOrder(p,row,broker){
 const r=p.rows.find(x=>x.id===row);
 if(!r||broker.symbol!==p.symbol||broker.side!==r.side||broker.orderType!=='LIMIT'||broker.timeInForce!==r.tif||Number(broker.quantity)!==r.qty||Math.abs(Number(broker.price)-r.price)>.00001||broker.currency!=='USD'||nyDate(new Date(broker.orderedAt))!==p.date||Date.parse(broker.orderedAt)<p.created-5000)throw Error('증권사 주문의 종목·가격·수량·방식·시각이 주문표와 다릅니다.');
 return r;
}
export function applyBroker(p,id,broker){
 const e=p.execution[id];if(!e)throw Error('주문 시도 이력이 없습니다.');
 const qty=Number(broker.execution?.filledQuantity||0),old=Number(e.filledQty||0);
 if(!Number.isFinite(qty)||qty<old)throw Error('체결 수량이 이전 조회보다 작습니다. 상태를 확인하세요.');
 Object.assign(e,{status:broker.status,filledQty:String(qty),averageFilledPrice:broker.execution?.averageFilledPrice,commission:broker.execution?.commission,tax:broker.execution?.tax,updatedAt:Date.now()});
 if(p.rows.every(r=>terminal(p.execution[r.id])))p.status='COMPLETED';
 return qty-old;
}
export function windowFor(calendar,date,now=Date.now()){
 const d=calendar?.today;if(d?.date!==date||!d.regularMarket)return {open:false,reason:'미국 휴장일 또는 캘린더 날짜 불일치'};
 const start=Date.parse(d.regularMarket.startTime),end=Date.parse(d.regularMarket.endTime),cutoff=end-30*60000;
 if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start)throw Error('시장 운영시간 응답 오류');
 return {open:now>=start&&now<cutoff,start,end,cutoff,reason:now<start?'정규장 시작 전':now>=cutoff?'앱 주문 마감 (장 종료 30분 전)':'정규장 주문 가능'};
}
