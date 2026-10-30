// usage.request.model is reported by the remote native adapter from model responses.
// Catalog defaults, effectiveModel and historical requests never establish this turn's model.
export function observeModel(previous,event,turnId,now=Date.now()){
  const request=event?.type==='usage.request'?event.request:null;
  if(!turnId||!request||request.historical||typeof request.model!=='string'||!request.model.trim()||request.model.length>512||/[\r\n\0]/.test(request.model)||request.model==='<synthetic>')return null;
  const models=previous?.turnId===turnId?[...previous.models]:[];
  if(models.includes(request.model))return null;
  if(models.length>=32)return null;
  models.push(request.model);
  return {turnId,models,source:'remote-response-usage',observedAt:new Date(now).toISOString()};
}
