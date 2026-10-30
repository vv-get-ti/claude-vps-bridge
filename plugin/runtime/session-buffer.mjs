// Bound plugin-side state independently of transport queues. Overflow is an
// explicit session fault; native history is the recovery source, never a silent drop.
export class SessionChannel {
  constructor(onOverflow,{maxItems=2048,maxBytes=8*1024*1024}={}){this.onOverflow=onOverflow;this.maxItems=maxItems;this.maxBytes=maxBytes;this.values=[];this.bytes=0;this.waiter=null;this.ended=false;}
  push(value){
    if(this.ended)return;
    const size=Buffer.byteLength(JSON.stringify(value));
    if(size>this.maxBytes||this.values.length>=this.maxItems||this.bytes+size>this.maxBytes){this.onOverflow('The desktop event backlog exceeded its bounded buffer.');return;}
    if(this.waiter){const waiter=this.waiter;this.waiter=null;waiter({done:false,value});}
    else{this.values.push({value,size});this.bytes+=size;}
  }
  fault(message){
    if(this.ended)return;this.values=[];this.bytes=0;
    const value={kind:'event',event:{type:'session.faulted',error:{code:'unavailable',message,retryable:false}}};
    if(this.waiter){const waiter=this.waiter;this.waiter=null;waiter({done:false,value});}else this.values.push({value,size:0});
    this.end();
  }
  end(){this.ended=true;if(this.waiter){this.waiter({done:true});this.waiter=null;}}
  [Symbol.asyncIterator](){return this;}
  next(){if(this.values.length){const {value,size}=this.values.shift();this.bytes-=size;return Promise.resolve({done:false,value});}if(this.ended)return Promise.resolve({done:true});return new Promise(resolve=>{this.waiter=resolve;});}
}

export class SessionRequests {
  constructor({limit=10000,recoveryLimit=128}={}){this.ids=new Set();this.recovery=new Set();this.limit=limit;this.recoveryLimit=recoveryLimit;this.epoch=null;this.highest=0;}
  accept(id,{recovery=false,sequence,epoch}={}){
    if(sequence!==undefined||epoch!==undefined){
      if(typeof id!=='string'||!id.length||id.length>256||!Number.isSafeInteger(sequence)||sequence<1||typeof epoch!=='string'||!epoch.length||epoch.length>100)throw new Error('Invalid sequenced control request');
      if(this.epoch!==null&&this.epoch!==epoch)throw new Error('Control epoch changed without confirmed idle recovery');
      if(sequence<=this.highest)throw new Error('Retired control request; no replay was submitted');
      this.epoch=epoch;this.highest=sequence;return;
    }
    if(this.epoch!==null)throw new Error('Cannot downgrade a sequenced session to legacy controls');
    if(typeof id!=='string'||id.length>256||!id.length||this.ids.has(id)||this.recovery.has(id))throw new Error('Duplicate or invalid control request; no replay was submitted');
    if(this.ids.size<this.limit){this.ids.add(id);return;}
    if(recovery&&this.recovery.size<this.recoveryLimit){this.recovery.add(id);return;}
    throw Object.assign(new Error('This session reached its request tracking limit.'),{code:'SESSION_REQUEST_LIMIT'});
  }
  clear(){this.ids.clear();this.recovery.clear();this.epoch=null;this.highest=0;}
}
