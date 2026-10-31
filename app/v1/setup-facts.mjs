/** Durable configuration facts, independent of temporary host-card capabilities.
 * The existing B SQLite database remains the single local route authority. */
export class SetupFacts {
 constructor({local,installationId,now=Date.now,appBinding=()=>({})}){
  this.local=local;this.db=local.db;this.installationId=installationId;this.now=now;this.appBinding=appBinding;
  this.db.exec(`CREATE TABLE IF NOT EXISTS b_setup_intent(installation TEXT PRIMARY KEY,route TEXT NOT NULL CHECK(route IN ('site','openai')),updated_at INTEGER NOT NULL,selection_revision INTEGER NOT NULL DEFAULT -1);
   CREATE TABLE IF NOT EXISTS b_setup_verified(installation TEXT NOT NULL,site_id TEXT NOT NULL,owner_subject TEXT NOT NULL,verified_at INTEGER NOT NULL,application_id TEXT NOT NULL DEFAULT '',verification_revision INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(installation,site_id,owner_subject));`);
  const columns=new Set(this.db.prepare('PRAGMA table_info(b_setup_verified)').all().map(c=>c.name));
  if(!columns.has('application_id'))this.db.exec("ALTER TABLE b_setup_verified ADD COLUMN application_id TEXT NOT NULL DEFAULT ''");
  if(!columns.has('verification_revision'))this.db.exec('ALTER TABLE b_setup_verified ADD COLUMN verification_revision INTEGER NOT NULL DEFAULT 0');
  if(!this.db.prepare('PRAGMA table_info(b_setup_intent)').all().some(c=>c.name==='selection_revision'))this.db.exec('ALTER TABLE b_setup_intent ADD COLUMN selection_revision INTEGER NOT NULL DEFAULT -1');
 }
 binding(){const value=this.appBinding();return {application_id:value.application_id||'',revision:Number.isSafeInteger(value.revision)&&value.revision>=0?value.revision:0};}
 choose(route){
  if(!['site','openai'].includes(route))throw Object.assign(Error('SETUP_ROUTE_INVALID'),{code:'ARG_INVALID'});
  this.db.prepare('INSERT INTO b_setup_intent(installation,route,updated_at,selection_revision) VALUES(?,?,?,?) ON CONFLICT(installation) DO UPDATE SET route=excluded.route,updated_at=excluded.updated_at,selection_revision=excluded.selection_revision').run(this.installationId,route,this.now(),this.local.selection().revision);
  return {selected_route:route};
 }
 selectedRoute(state={}){
  const selected=this.local.selection(),route=this.local.route(selected.selected);
  const intent=this.db.prepare('SELECT route,selection_revision FROM b_setup_intent WHERE installation=?').get(this.installationId);
  if(intent)return selected.revision>intent.selection_revision&&route.configured===1?selected.selected:intent.route;
  // Retain configured legacy installations and real choices; revision-zero A
  // without configuration is only a bootstrap row, not the user's selection.
  return selected.revision>0||route.configured===1||state.setup_test_passed===true||state.setup_complete===true?selected.selected:'none';
 }
 recordSite(identity){
  const r=this.local.route('site');
  if(identity?.installation_id!==this.installationId||!this.local.fresh(r)||
   identity.site_id!==r.site_id||identity.owner_subject!==r.owner_subject||identity.binding_id!==r.binding_id||identity.generation!==r.generation)
   throw Object.assign(Error('B_SETUP_IDENTITY_CHANGED'),{code:'B_SETUP_IDENTITY_CHANGED'});
  const binding=this.binding();
  this.db.prepare('INSERT INTO b_setup_verified(installation,site_id,owner_subject,verified_at,application_id,verification_revision) VALUES(?,?,?,?,?,?) ON CONFLICT(installation,site_id,owner_subject) DO UPDATE SET verified_at=excluded.verified_at,application_id=excluded.application_id,verification_revision=excluded.verification_revision').run(this.installationId,r.site_id,r.owner_subject,this.now(),binding.application_id,binding.revision);
 }
 siteProof(){
  const r=this.local.route('site');if(!r?.configured||!r.site_id||!r.owner_subject)return null;
  const binding=this.binding();
  const proof=this.db.prepare('SELECT verified_at FROM b_setup_verified WHERE installation=? AND site_id=? AND owner_subject=? AND application_id=? AND verification_revision=?').get(this.installationId,r.site_id,r.owner_subject,binding.application_id,binding.revision);
  return proof?{route:'site',site_id:r.site_id,verified:true,verified_at:proof.verified_at}:null;
 }
}
