const clickable=new Set(['link','button']);
const contains=(a,b)=>a&&b&&['x','y','width','height'].every(k=>Number.isFinite(a[k])&&Number.isFinite(b[k]))&&a.width>0&&a.height>0&&b.width>0&&b.height>0&&a.x<=b.x&&a.y<=b.y&&a.x+a.width>=b.x+b.width&&a.y+a.height>=b.y+b.height;
const url=x=>{try{const u=new URL(x.href||x.url);return u.origin==='https://chatgpt.com'&&u.pathname.startsWith('/settings/plugins-settings/')&&!u.username&&!u.password?u.href:null;}catch{return null;}};
const parent=(a,b)=>b.parent_ref===a.ref||(Array.isArray(b.ancestor_refs)&&b.ancestor_refs.includes(a.ref));
export function dedupeRefreshEntries(elements){
 const groups=elements.map((_,i)=>i),root=i=>groups[i]===i?i:groups[i]=root(groups[i]),join=(a,b)=>groups[root(b)]=root(a);
 const related=(a,b)=>{const ua=url(a),ub=url(b);if(ua&&ub&&ua!==ub)return false;if(ua&&ua===ub&&a.name===b.name)return true;if(a.frame_id&&b.frame_id&&a.frame_id!==b.frame_id||a.document_id&&b.document_id&&a.document_id!==b.document_id)return false;return parent(a,b)||parent(b,a)||contains(a.box,b.box)||contains(b.box,a.box)||(ua&&ua===ub&&a.name===b.name);};
 const hits=elements.map((x,i)=>clickable.has(x.role)?i:-1).filter(i=>i>=0);
 for(let i=0;i<hits.length;i++)for(let j=i+1;j<hits.length;j++)if(related(elements[hits[i]],elements[hits[j]]))join(hits[i],hits[j]);
 const ignored=new Set();
 for(let i=0;i<elements.length;i++)if(!clickable.has(elements[i].role)){const descendants=hits.filter(j=>related(elements[i],elements[j])),targets=new Set(descendants.map(root));if(targets.size===1)join(descendants[0],i);else if(targets.size>1)ignored.add(i);}
 for(let i=0;i<elements.length;i++)for(let j=i+1;j<elements.length;j++)if(!ignored.has(i)&&!ignored.has(j)&&!clickable.has(elements[i].role)&&!clickable.has(elements[j].role)&&related(elements[i],elements[j]))join(i,j);
 const result=new Map();for(let i=0;i<elements.length;i++){if(ignored.has(i))continue;const key=root(i),prior=result.get(key),x=elements[i];if(!prior||clickable.has(x.role)&&!clickable.has(prior.role)||x.role==='link'&&prior.role==='button')result.set(key,x);}
 return [...result.values()];
}
export const wholeAppName=(name,app)=>new RegExp('(?:^|[^a-z0-9])'+app.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'(?:$|[^a-z0-9])','i').test(name);
