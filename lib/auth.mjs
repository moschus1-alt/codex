import {createHmac,timingSafeEqual,randomBytes} from 'node:crypto';
export function same(a,b){const x=Buffer.from(String(a)),y=Buffer.from(String(b));return x.length===y.length&&timingSafeEqual(x,y);}
function secret(){const s=process.env.SESSION_SECRET;if(!s||s.length<32)throw Error('SESSION_SECRET을 32자 이상으로 설정하세요.');return s;}
export function issue(){const data=`${Date.now()+8*3600000}.${randomBytes(16).toString('hex')}`;return `${data}.${createHmac('sha256',secret()).update(data).digest('hex')}`;}
export function authenticated(req){const cookie=req.headers.cookie?.match(/(?:^|; )ib_session=([^;]+)/)?.[1];if(!cookie)return false;const [exp,nonce,sig]=cookie.split('.');return Number(exp)>Date.now()&&same(sig,createHmac('sha256',secret()).update(`${exp}.${nonce}`).digest('hex'));}
export function sameOrigin(req){if(!req.headers.origin)return false;try{return new URL(req.headers.origin).host===req.headers.host;}catch{return false;}}
