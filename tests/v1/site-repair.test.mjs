import test from 'node:test';
import assert from 'node:assert/strict';
import {Repair} from '../../app/v1/repair.mjs';

async function diagnose({site = {},settings = {},relay = {},credentials = {},tools = {state:'current'}} = {}) {
  let restores = 0;
  const snapshot = () => ({enabled:true,settings:{access_enabled:true,browser_enabled:false,
    desktop_enabled:false,...settings},credentials:{healthy:true,site_b:true,...credentials},
    site_b:{selected:'site',routes:{site:{configured:true,state:'healthy',health_fresh:true,...site}}},
    connection:{process_running:false,ready:false,healthy:false},relay:{online:false,...relay},
    tools_list_status:tools,setup_test:{status:'read_write',verified:true}});
  const repair = new Repair({snapshot,mayReconnect:()=>false,
    restoreTunnel:()=>{restores++;throw Error('must not restart standby OpenAI');},
    systemProxy:()=>null,cleanupUpgrade:()=>({cleaned:0}),browserHost:{},
    openChromeInBackground:()=>{throw Error('browser is disabled');}});
  const result = repair.start();
  const deadline = Date.now()+1000;
  while (result.status === 'running' && Date.now()<deadline)
    await new Promise(resolve=>setImmediate(resolve));
  assert.equal(result.status,'done');
  assert.equal(restores,0);
  return {result,item:id=>result.items.find(item=>item.id===id)};
}

test('healthy Site-only configuration passes connection settings/cloud without asking for an OpenAI key',async()=>{
  const d = await diagnose();
  assert.equal(d.item('credentials').status,'ok');
  assert.equal(d.item('cloud').status,'ok');
  for (const id of ['tunnel','proxy_match']) {
    assert.equal(d.item(id).status,'skipped');
    assert.equal(d.item(id).message,'');
  }
  assert.equal(d.result.summary.action_needed,0);
  assert.equal(d.result.summary.failed,0);
});

test('selected Site takes precedence over a stale online relay snapshot',async()=>{
  const d = await diagnose({site:{health_fresh:false},relay:{online:true},
    settings:{connection_preference:'relay'}});
  assert.equal(d.item('cloud').status,'failed');
  assert.equal(d.item('cloud').message_key,'repair.cloud.relayOffline.message');
  assert.equal(d.item('credentials').status,'ok');
});

for (const credentials of [{healthy:false},{site_b:false}])
test('configured Site requires verified credentials '+JSON.stringify(credentials),async()=>{
  const d = await diagnose({credentials});
  assert.equal(d.item('credentials').status,'action');
  assert.equal(d.item('credentials').action.kind,'open_wizard');
});

for (const site of [{health_fresh:false},{state:'reconnecting'},{state:'auth_required'},
  {configured:false}])
test('Site cloud diagnosis requires current configured healthy evidence '+JSON.stringify(site),async()=>{
  const d = await diagnose({site});
  assert.equal(d.item('cloud').status,'failed');
  assert.equal(d.item('cloud').message_key,'repair.cloud.relayOffline.message');
  assert.doesNotMatch(d.item('cloud').message,/OpenAI|你关掉了/);
  if (site.configured === false) {
    assert.equal(d.item('credentials').status,'action');
    assert.equal(d.item('credentials').action.kind,'open_wizard');
  }
});

test('explicit access pause stays distinct from Site forbidding standby tunnel restart',async()=>{
  const d = await diagnose({settings:{access_enabled:false}});
  assert.equal(d.item('cloud').status,'skipped');
  assert.equal(d.item('cloud').message_key,'repair.common.off.message');
  assert.equal(d.item('credentials').status,'ok');
});

test('fresh Site transport does not prove ChatGPT tools or read/write acceptance',async()=>{
  const d = await diagnose({tools:{state:'stale',message:'fixture tool list is stale',
    message_key:'fixture.tools.stale',message_params:{}}});
  assert.equal(d.item('cloud').status,'ok');
  assert.equal(d.item('chatgpt_tools').status,'action');
  assert.equal(d.item('chatgpt_tools').action.kind,'open_chatgpt');
});
