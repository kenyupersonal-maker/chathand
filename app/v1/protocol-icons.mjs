import fs from 'node:fs';

// Same vector master, rasterized at the protocol's display size. The opaque
// brand background works in both themes. Keep the repeated Site envelope small
// enough for the existing 12k full-output budget, without shrinking its pages.
const png=fs.readFileSync(new URL('../../plugins/chathand/assets/server-icon-32.png',import.meta.url));
const icons=Object.freeze([Object.freeze({src:'data:image/png;base64,'+png.toString('base64'),mimeType:'image/png',sizes:Object.freeze(['32x32'])})]);
export function protocolIcons(protocolVersion){
 if(typeof protocolVersion!=='string'||protocolVersion<'2025-11-25')return [];
 return icons.map(icon=>({...icon,sizes:[...icon.sizes]}));
}
