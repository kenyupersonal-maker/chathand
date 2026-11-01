import test from 'node:test';import assert from 'node:assert/strict';
import {setupRouteSelection} from '../../app/v1/setup-route-selection.mjs';
import {Tools} from '../../app/tools.mjs';
test('fresh bootstrap defaults OpenAI; explicit and existing A or Site are preserved without changing selection',()=>{
 const selection={selected:'openai',revision:0},base={selection,openai:{configured:0},site:{configured:0},state:{connection_preference:'none',tunnel:null}};
 assert.equal(setupRouteSelection(base),'openai');assert.equal(selection.selected,'openai');
 assert.equal(setupRouteSelection({...base,explicit:'openai'}),'openai');assert.equal(setupRouteSelection({...base,explicit:'site'}),'site');
 assert.equal(setupRouteSelection({...base,openai:{configured:1,state:'healthy'}}),'openai');assert.equal(setupRouteSelection({...base,openai:{configured:1,state:'failed'}}),'openai');
 assert.equal(setupRouteSelection({...base,selection:{selected:'openai',revision:2}}),'openai');
 assert.equal(setupRouteSelection({...base,state:{connection_preference:'tunnel'}}),'openai');
 assert.equal(setupRouteSelection({...base,selection:{selected:'site',revision:1}}),'site');
 assert.equal(setupRouteSelection({...base,site:{configured:1}}),'site');
 assert.throws(()=>setupRouteSelection({...base,explicit:'wrong'}),{code:'ARG_INVALID'});
});
test('wrong-route receipt directs the conversation to its selected connection without local switching',()=>{
 for(const selected of ['site','openai']){const self={bSiteLocalStore:{selection:()=>({selected})}},source=selected==='site'?'local_http':'site_b',r=Tools.prototype.routeRefusal.call(self,source,'write_text');
 assert.equal(r.error_code,'ROUTE_NOT_SELECTED');assert.equal(r.selected,selected);assert.equal(r.executed,false);assert.equal(r.can_execute,false);assert.equal(r.next_action,'select_current_conversation_connection');}
});
