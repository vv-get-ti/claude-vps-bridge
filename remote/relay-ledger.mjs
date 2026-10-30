// Acknowledged replies release modern IDs; the monotonic watermark still
// rejects late duplicate frames. Legacy clients retain IDs until relay exit.
export class RelayLedger{
  constructor({maxRequests=4096}={}){this.maxRequests=maxRequests;this.requests=new Map();this.highest=0;this.retiredThrough=0;}
  accept(frame){
    const prior=this.requests.get(frame.id);
    if(prior){if(prior.requestNo!==frame.requestNo)return 'REQUEST_ID_CONFLICT';return 'duplicate';}
    if(typeof frame.id!=='string'||!frame.id.length||frame.id.length>100)return 'INVALID_REQUEST_ID';
    if(frame.requestNo!==undefined){
      if(!Number.isSafeInteger(frame.requestNo)||frame.requestNo<1)return 'INVALID_REQUEST_NUMBER';
      if(frame.requestNo<=this.retiredThrough||frame.requestNo<=this.highest)return 'RETIRED_REQUEST';
    }
    if(this.requests.size>=this.maxRequests)return 'RELAY_CAPACITY';
    this.requests.set(frame.id,{requestNo:frame.requestNo,responseSeq:null});
    if(frame.requestNo!==undefined)this.highest=frame.requestNo;
    return 'accepted';
  }
  responded(id,seq){const entry=this.requests.get(id);if(entry&&entry.responseSeq===null)entry.responseSeq=seq;}
  acknowledge(seq){
    let oldest=this.highest+1;
    for(const [id,entry] of this.requests){
      if(entry.requestNo===undefined)continue;
      if(entry.responseSeq!==null&&entry.responseSeq<=seq)this.requests.delete(id);
      else oldest=Math.min(oldest,entry.requestNo);
    }
    this.retiredThrough=Math.max(this.retiredThrough,oldest-1);
  }
}
