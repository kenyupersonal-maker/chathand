import fs from 'node:fs';

// Existing conversations retain their frozen tool template URI. Only hashes
// actually published in a bundled contract may resolve to the current widget.
const published=new Map(),contracts=new URL('../../contracts/',import.meta.url);
for(const file of fs.readdirSync(contracts).filter(name=>/^tools-v\d+\.json$/.test(name))){
 const tools=JSON.parse(fs.readFileSync(new URL(file,contracts),'utf8'));
 for(const tool of tools)for(const uri of [tool._meta?.ui?.resourceUri,tool._meta?.['openai/outputTemplate']]){
  const match=typeof uri==='string'&&/^ui:\/\/chathand\/(task|image-batch)-[a-f0-9]{10}\.html$/.exec(uri);
  if(match)published.set(uri,match[1]);
 }
}
export const publishedWidgetKind=uri=>published.get(uri);

// Only published content hashes are accepted. Carry every frozen alias so old
// conversations work on both local and Site routes after a widget update.
export const SITE_WIDGET_ALIASES=Object.freeze([...published.keys()]);
