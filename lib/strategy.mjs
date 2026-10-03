export const defaults={seed:10000,feePct:0.1,maxOrder:2000};
export const num=(x,min=0,max=1e9)=>typeof x==='number'&&Number.isFinite(x)&&x>=min&&x<=max;
export function validateConfig(c){
 if(!c||!num(c.seed,100,1e7)||!num(c.feePct,0,2)||!num(c.maxOrder,1,1e7))throw Error('투자금·수수료·주문 한도를 확인하세요.');
 return {seed:c.seed,feePct:c.feePct,maxOrder:c.maxOrder};
}
export function validatePosition(p){
 if(!p||!num(p.qty,0,1e7)||!Number.isInteger(p.qty)||!num(p.avg,0,1e6)||!num(p.cost,0,1e9)||!num(p.cash,0,1e9)||(p.qty>0&&p.avg<=0)||(p.qty===0&&(p.avg!==0||p.cost!==0))||Math.abs(p.cost-p.avg*p.qty)>Math.max(.02,p.qty*.0001))throw Error('보유수량·평단·잔여 매입원가를 확인하세요. 원가는 수량 × 평단입니다.');
 return {qty:p.qty,avg:p.avg,cost:p.cost,cash:p.cash};
}
export function nyDate(now=new Date()){return new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);}
const down=x=>Math.floor((x+1e-9)*100)/100;
const up=x=>Math.ceil((x-1e-9)*100)/100;
export function plan(config,position,firstPrice=0){
 const c=validateConfig(config),p=validatePosition(position),unit=c.seed/40;
 p.cash=Math.min(p.cash,Math.max(0,c.seed-p.cost));
 const t=Math.ceil((p.cost/unit)*10-1e-9)/10;
 const starPct=10-t/2,star=p.avg*(1+starPct/100),rows=[],warnings=[];
 const add=(id,side,price,qty,tif,reason)=>{if(qty>0)rows.push({id,side,price,qty,tif,reason});};
 const buy=(id,budget,price,reason)=>{
  price=down(price);if(price<1)throw Error('현재 버전은 주가 1달러 이상 종목만 지원합니다.');
  add(id,'BUY',price,Math.floor((budget+1e-9)/(price*(1+c.feePct/100))),'CLS',reason);
 };
 if(t>=39.1)return {t,starPct,star:up(star),unit,phase:'QUARTER',rows:[],warnings:['쿼터손절 구간: 토스 API의 MOC 미지원으로 주문을 중단합니다. 토스 앱에서 원문 규칙에 따른 처리가 필요합니다.']};
 if(p.qty===0){
  if(!num(firstPrice,1,1e6))return {t,starPct,star:0,unit,phase:'FIRST',rows:[],warnings:['최초 매수 LOC 한도가를 직접 입력하세요. 자동으로 시장가를 대체하지 않습니다.']};
  buy('first',Math.min(unit,p.cash),firstPrice,'최초 진입 · 직접 지정 LOC');
 } else {
  if(star<1)throw Error('별지점이 1달러 미만입니다. 주문을 중단합니다.');
  if(t<20){buy('avg',Math.min(unit/2,p.cash/2),p.avg,'전반전 · 평단 LOC');buy('star',Math.min(unit/2,p.cash/2),down(star)-.01,'전반전 · 별지점 − $0.01 LOC');}
  else buy('star',Math.min(unit,p.cash),down(star)-.01,'후반전 · 별지점 − $0.01 LOC');
  const quarter=Math.floor(p.qty/4);
  add('quarter','SELL',up(star),quarter,'CLS',star<p.avg?'별지점 부분매도 · 손실 실현 가능':'별지점 부분매도');
  add('target','SELL',up(p.avg*1.1),p.qty-quarter,'DAY','평단 +10% 지정가 익절');
 }
 for(const r of rows)if(r.price*r.qty>c.maxOrder)warnings.push(`${r.id}: 주문 한도 초과`);
 if(!rows.some(r=>r.side==='BUY'))warnings.push('매수 여력 또는 1회 금액이 부족해 매수 주문이 없습니다.');
 return {t,starPct,star:up(star),unit,phase:p.qty===0?'FIRST':t<20?'EARLY':'LATE',rows,warnings};
}
export function simulate(c,p,rows,bar){
 if(!num(bar.close,1,1e6)||!num(bar.high,bar.close,1e6))throw Error('고가는 종가 이상이어야 합니다.');
 let next={...p},fills=[];
 // DAY sell may execute intraday; LOC rows execute at the closing price.
 for(const r of [...rows].sort((a,b)=>(a.tif==='DAY'?-1:1)-(b.tif==='DAY'?-1:1))){
  const price=r.tif==='DAY'?r.price:bar.close;
  const hit=r.tif==='DAY'?bar.high>=r.price:r.side==='BUY'?bar.close<=r.price:bar.close>=r.price;
  if(!hit)continue;
  const fee=price*r.qty*c.feePct/100;
  if(r.side==='BUY'){
   if(next.cash+1e-8<price*r.qty+fee)throw Error('모의계좌 잔액 부족');
   next.cost+=price*r.qty;next.qty+=r.qty;next.avg=next.cost/next.qty;next.cash-=price*r.qty+fee;
   fills.push({...r,fillPrice:price,fee,pnl:0});
  }else{
   if(next.qty<r.qty)throw Error('모의계좌 매도 수량 초과');
   const pnl=(price-next.avg)*r.qty-fee;
   next.cost-=next.avg*r.qty;next.qty-=r.qty;next.cash+=price*r.qty-fee;
   if(!next.qty){next.avg=0;next.cost=0;}
   fills.push({...r,fillPrice:price,fee,pnl});
  }
 }
 return {position:next,fills};
}
