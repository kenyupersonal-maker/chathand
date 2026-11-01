// Synthetic, test-owned service/host attestations. Never production authority.
import {TOOLS} from '../../app/tools.mjs';
import {manifest} from '../../app/product.mjs';
export const refreshExpected=()=>({...manifest(TOOLS),build:1052,instance_id:'isolated-refresh-install',connection_tag:'fixture-connection',principal_tag:'fixture-principal',route:'relay'});
export const refreshProof=(at,page_id,plugin_url,extra={})=>{const e=refreshExpected();return {kind:'tools_list',at,source:'trusted_server',authenticated:true,caller:'chatgpt',route:e.route,installation:{build:e.build,instance_id:e.instance_id},contract:{connector_api:e.connector_api,tool_count:e.tool_count,schema_sha256:e.schema_sha256},connection_tag:e.connection_tag,principal_tag:e.principal_tag,host_binding:{attested_by:'trusted_host',page_id,plugin_url},...extra};};
