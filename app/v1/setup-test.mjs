import crypto from 'node:crypto';
import {fail} from '../../engine/src/core.mjs';
/** A short-lived challenge; verified is a separate, configuration-bound fact. */
export class SetupTest {
 constructor({now=Date.now,binding=()=>null,verified=()=>false,onPassed=()=>{},deviceName=()=>"这台电脑"}={}){this.now=now;this.binding=binding;this.verified=verified;this.onPassed=onPassed;this.deviceName=deviceName;this.issued=new Map();this.secret=crypto.randomBytes(32);this.current=null;}
 start(){if(this.current)this.issued.set(this.current.nonce,this.current.expires);while(this.issued.size>32)this.issued.delete(this.issued.keys().next().value);this.current={nonce:crypto.randomBytes(6).toString('hex'),expires:this.now()+10*60*1000,read:false,write:false,session:null,binding:this.binding()};return this.snapshot();}
 record(kind,nonce,session,principal){
  const c=this.current;if(!c||nonce!==c.nonce){if(this.issued.has(nonce)&&this.now()>=this.issued.get(nonce))fail('SETUP_TEST_EXPIRED','这个测试码过期了。回到 ChatHand，用那里新的那句再发一次。');fail('SETUP_TEST_OTHER_DEVICE',`这里是「${this.deviceName()}」上的 ChatHand，这个测试码不是它发的。账号里有好几个 ChatHand 的话，换另一个再试。`);}if(this.now()>=c.expires)fail('SETUP_TEST_EXPIRED','这个测试码过期了。回到 ChatHand，用那里新的那句再发一次。');
  if(typeof principal!=='string'||!principal||typeof session!=='string'||!session.trim()||session.length>4096)fail('SETUP_SESSION_MISSING','没有收到可核对的 ChatGPT 会话，请从新对话测试。');
  const digest=crypto.createHmac('sha256',this.secret).update(JSON.stringify([principal,session])).digest('hex');
  if(c.session&&c.session!==digest)fail('SETUP_SESSION_MISMATCH','两次测试不在同一对话，请重新测试。');
  if(kind==='write'&&!c.read)fail('SETUP_READ_REQUIRED','请先调用 connection_check，再测试写入。');
  if(c.binding!==this.binding())fail('SETUP_TEST_REQUIRED','连接配置已改变，请重新测试。');
  // Persist first. A failed save must not create an in-memory successful write.
  if(kind==='write'&&!c.write)this.onPassed({binding:c.binding,principal,expires_at:c.expires});
  c.session=digest;c[kind]=true;return {nonce:c.nonce,recorded:true,read:c.read,write:c.write};
 }
 snapshot(){const c=this.current,verified=this.verified()===true;if(!c)return {status:'not_started',verified};const complete=c.read&&c.write,expired=!complete&&this.now()>=c.expires;return {nonce:c.nonce,expires_at:c.expires,expired,read:c.read,write:c.write,status:expired?'expired':c.read&&c.write?'read_write':c.read?'read_only':'not_received',verified};}
}
