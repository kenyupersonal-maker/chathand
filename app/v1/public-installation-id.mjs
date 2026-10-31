import crypto from 'node:crypto';

const UUID=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const unavailable=()=>{throw Object.assign(Error('PUBLIC_INSTALLATION_ID_UNAVAILABLE'),{code:'PUBLIC_INSTALLATION_ID_UNAVAILABLE'});};

/** Public diagnostics identity. Never reuse or change the private Site/pilot identity. */
export function loadPublicInstallationId({local}={}){
 try{
  if(!UUID.test(local?.installationId)||typeof local?.tx!=='function')unavailable();
  return local.tx(()=>{
   local.db.exec(`CREATE TABLE IF NOT EXISTS public_installation_identity(
    installation TEXT PRIMARY KEY NOT NULL,public_id TEXT NOT NULL UNIQUE);`);
   let row=local.db.prepare('SELECT public_id FROM public_installation_identity WHERE installation=?').get(local.installationId);
   if(!row){
    const id=crypto.randomUUID();
    if(!UUID.test(id)||id===local.installationId)unavailable();
    local.db.prepare('INSERT INTO public_installation_identity(installation,public_id) VALUES(?,?)').run(local.installationId,id);
    row=local.db.prepare('SELECT public_id FROM public_installation_identity WHERE installation=?').get(local.installationId);
   }
   if(!UUID.test(row?.public_id)||row.public_id===local.installationId)unavailable();
   return row.public_id;
  });
 }catch{unavailable();}
}
