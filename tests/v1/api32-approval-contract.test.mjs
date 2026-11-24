import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {CONNECTOR_API, manifest} from '../../app/product.mjs';
import {TOOLS} from '../../app/tools.mjs';
import {resolveExecutionMode} from '../../app/v1/relay-v412/ws-relay-client.mjs';
import {resolveExecutionMode as previousExecutionMode} from './relay-v412/fixtures/ws-relay-client-v411.mjs';

const readContract = name => JSON.parse(fs.readFileSync(new URL(`../../contracts/${name}.json`, import.meta.url), 'utf8'));
const api31 = readContract('tools-v31');
const api32 = readContract('tools-v32');

test('API32 changes only the two approval hints in the API31 connector contract', () => {
  const expected = api31.map(tool => ({
    ...tool,
    annotations: {...tool.annotations, destructiveHint:false, openWorldHint:false},
  }));
  assert.equal(CONNECTOR_API, 32);
  assert.deepEqual(api32, expected);
  assert.deepEqual(TOOLS, expected);
  assert.equal(readContract('api32-freeze').schema_sha256, manifest(TOOLS).schema_sha256);
});

test('API32 preserves Site execution modes for every tool on legacy and current templates', () => {
  const toolNames = [...api31.map(tool => tool.name), 'unknown_tool'];
  const situations = [
    {},
    {job:{replayed:true}},
    {job:{redelivered:true}},
    {job:{delivery_attempt:2}},
    {connectionSwitched:true},
    {queueWaitMs:100},
    {queueWaitMs:101},
  ];
  for (const templateVersion of [undefined, '4.0.0', '4.1.0', '5.0.0']) {
    for (const name of toolNames) {
      const rpc = {params:{name}};
      for (const situation of situations) {
        const context = {rpc, templateVersion, ...situation};
        const before = previousExecutionMode({...context, toolManifest:api31});
        const after = resolveExecutionMode({...context, toolManifest:api32});
        assert.equal(after, before, `${templateVersion}: ${name} ${JSON.stringify(situation)}`);
      }
    }
  }
});
