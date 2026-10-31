// App registration is independent for the two connection routes. The legacy
// fields remain enumerable compatibility projections, never a second store.
export const APP_ROUTE_FIELDS=Object.freeze(['chatgpt_app_identity','chatgpt_app_name','chatgpt_app_missing','chatgpt_app_retest_required','setup_retest_revision']);
const routes=['site','openai'];
const copy=value=>value===undefined?undefined:structuredClone(value);
const record=value=>value&&typeof value==='object'&&!Array.isArray(value);
export class ChatGPTAppRoutes {
 constructor({state,selected,current=selected}){
  this.state=state;this.selected=selected;this.current=current;
  const data=state.data,legacy=Object.fromEntries(APP_ROUTE_FIELDS.filter(key=>Object.hasOwn(data,key)).map(key=>[key,copy(data[key])]));
  // Presence is the migration marker: an existing map is authoritative even if
  // empty, and an old serialized compatibility projection cannot overwrite it.
  this.migrationPending=!Object.hasOwn(data,'chatgpt_app_routes');
  if(this.migrationPending)data.chatgpt_app_routes={[this.route(selected())]:legacy};
  if(!record(data.chatgpt_app_routes))throw Object.assign(Error('Invalid route app registrations'),{code:'CHATGPT_APP_ROUTES_INVALID'});
  for(const route of routes){const source=data.chatgpt_app_routes[route];if(source!==undefined&&!record(source))throw Object.assign(Error('Invalid route app registration'),{code:'CHATGPT_APP_ROUTES_INVALID'});data.chatgpt_app_routes[route]=Object.fromEntries(APP_ROUTE_FIELDS.filter(key=>source?.[key]!==undefined).map(key=>[key,copy(source[key])]));}
  for(const key of APP_ROUTE_FIELDS)Object.defineProperty(data,key,{enumerable:true,configurable:false,get:()=>this.entry(this.currentRoute())[key],set:value=>this.set(this.currentRoute(),key,value)});
 }
 // Persist after SetupFacts is constructed: serialization reads compatibility
 // getters whose route callback depends on it. Do this before starting routes.
 persistMigration(){if(!this.migrationPending)return;this.state.save();this.migrationPending=false;}
 route(route){if(!routes.includes(route))throw Object.assign(Error('Invalid app route'),{code:'ARG_INVALID'});return route;}
 currentRoute(){const route=this.current();return routes.includes(route)?route:this.route(this.selected());}
 entry(route){return this.state.data.chatgpt_app_routes[this.route(route)];}
 set(route,key,value){if(!APP_ROUTE_FIELDS.includes(key))throw Object.assign(Error('Invalid app registration field'),{code:'ARG_INVALID'});const entry=this.entry(route);if(value===undefined)delete entry[key];else entry[key]=value;}
 snapshot(route){return copy(this.entry(route));}
 restore(route,snapshot){const entry=this.entry(route);for(const key of APP_ROUTE_FIELDS)delete entry[key];Object.assign(entry,copy(snapshot));}
 capture(){const route=this.currentRoute(),entry=this.entry(route);return Object.freeze({route,revision:entry.setup_retest_revision,identity:JSON.stringify(entry.chatgpt_app_identity??null)});}
 assertCurrent(context){if(!context)return;const entry=this.entry(context.route);if(context.route!==this.currentRoute()||context.revision!==entry.setup_retest_revision||context.identity!==JSON.stringify(entry.chatgpt_app_identity??null))throw Object.assign(Error('ChatGPT plugin registration changed; refresh stopped.'),{code:'TOOLS_REFRESH_IDENTITY_MISMATCH'});}
}
