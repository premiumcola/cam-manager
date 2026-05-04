// ─── camedit/coral-test/device-info.js ─────────────────────────────────────
// R12 — extracted from coral-test.js. Fetches /api/system once and renders
// the optional Coral device line (USB chip identifier + violet styling) in
// the Coral-Test panel. Silent on missing endpoint or empty payload.
import { byId, esc } from "../../core/dom.js";
import { j } from "../../core/api.js";

export async function _updateCoralDeviceInfo(){
  const panel=byId('coralDeviceInfo'); if(!panel) return;
  try{
    const s=await j('/api/system');
    if(s.coral_device){
      panel.innerHTML=`<div class="field-help" style="margin-top:2px;color:#a78bfa">🔌 ${esc(s.coral_device)}</div>`;
    }else{
      panel.innerHTML='';
    }
  }catch(e){panel.innerHTML='';}
}
