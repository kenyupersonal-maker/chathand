'use strict';
// Actual UI sources + deterministic browser fake. Only this server's in-memory skin is saved.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const ROOT=path.resolve(__dirname,'../..'),UI=path.join(ROOT,'ui');
const MIME={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json','.png':'image/png','.webp':'image/webp','.svg':'image/svg+xml'};
async function start(){
 let skin='default';const FIX=fs.readFileSync(path.join(__dirname,'fixtures.js'),'utf8');
 const server=http.createServer(async(req,res)=>{
  try{
   const url=new URL(req.url,'http://local');
   if(url.pathname==='/__skin'){
    if(req.method==='POST'){let body='';for await(const part of req)body+=part;const id=JSON.parse(body).skin;
     if(id!=='default'&&(!/^[a-z0-9][a-z0-9-]{0,31}$/.test(id)||!fs.existsSync(path.join(UI,'skins',id+'.css')))){res.writeHead(400);return res.end('{}');}skin=id;
    }
    res.writeHead(200,{'Content-Type':'application/json'});return res.end(JSON.stringify({skin}));
   }
   if(url.pathname==='/favicon.ico'){res.writeHead(204);return res.end();}
   let body,type;
   if(url.pathname==='/__fixtures.js'){type=MIME['.js'];body=`window.__F=(function(){const module={exports:{}};${FIX}\nreturn module.exports;})();`;}
   else if(url.pathname==='/__fake.js'){type=MIME['.js'];body=fs.readFileSync(path.join(__dirname,'fake.js'));}
   else{
    const rel=decodeURIComponent(url.pathname==='/'?'/index.html':url.pathname),file=path.resolve(UI,'.'+rel);
    if(!file.startsWith(UI+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404);return res.end('not found');}
    body=fs.readFileSync(file);type=MIME[path.extname(file)]||'application/octet-stream';
    if(rel==='/index.html')body=body.toString().replace('<html lang="zh-CN"',`<html lang="zh-CN" data-skin-saved="${skin}"`).replace('<script src="/app.js">','<script src="/__fixtures.js"></script><script src="/__fake.js"></script><script src="/app.js">');
   }
   res.writeHead(200,{'Content-Type':type,'Cache-Control':'no-store'});res.end(body);
  }catch(e){res.writeHead(500);res.end(e.message);}
 });
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 return{url:`http://127.0.0.1:${server.address().port}`,close:()=>new Promise(r=>{server.close(r);server.closeAllConnections();})};
}
module.exports={start};
