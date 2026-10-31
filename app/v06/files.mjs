import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {fail,digest} from '../../engine/src/core.mjs';
const HERE=path.dirname(fileURLToPath(import.meta.url));
const encodings=new Set(['utf-8','utf-16le','utf-16be','gbk','gb18030','windows-1252']);
const stamp=st=>`${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
const imageTypes={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif'};
export function inspectFile(store,input){
  store.checkActive();const file=store.resolve(input),st=fs.statSync(file);
  const result={path:input,name:path.basename(file),type:st.isDirectory()?'directory':'file',bytes:st.size,modified_at:st.mtime.toISOString(),fingerprint:stamp(st)};
  const snapshot=store.pathInfo(input);
  Object.assign(result,{sha256:snapshot.sha256,hash_kind:snapshot.hash_kind,path_entries:snapshot.entries});
  return result;
}
function runAdapter(command,args,fd,children,control=null){
  return new Promise((resolve,reject)=>{
    const child=spawn(command,args,{shell:false,env:{PATH:'/usr/bin:/bin',LANG:'en_US.UTF-8'},stdio:control?['pipe','pipe','pipe',fd,...control.fds,'pipe']:['ignore','pipe','pipe',fd]});
    children.add(child);let out=[],bytes=0,error='',done=false;
    const finish=(e,value)=>{if(done)return;done=true;clearTimeout(timer);children.delete(child);e?reject(e):resolve(value);};
    const timer=setTimeout(()=>{child.kill('SIGKILL');finish(Object.assign(Error('文件解析超时。'),{code:'DOCUMENT_TIMEOUT'}));},10000);
    if(control){
      let ready='';
      child.stdin.on('error',()=>{});
      child.stdio[7].on('data',b=>{
        ready+=b.toString();if(ready!=='ready\n')return;
        try{control.validate();child.stdin.end('1');}
        catch(e){child.kill('SIGKILL');finish(e);}
      });
    }
    child.stdout.on('data',b=>{bytes+=b.length;if(bytes>1100*1024){child.kill('SIGKILL');finish(Object.assign(Error('结果过大，请缩小读取范围。'),{code:'DOCUMENT_OUTPUT_LIMIT'}));}else out.push(b);});
    child.stderr.on('data',b=>{if(error.length<500)error+=b.toString();});
    child.on('error',e=>finish(e));
    child.on('close',code=>{try{const text=Buffer.concat(out).toString();const data=JSON.parse(text);if(code!==0||data.error)throw Object.assign(Error(data.error?.detail||'文件解析失败。'),{code:data.error?.code||'DOCUMENT_READ_FAILED'});finish(null,data);}catch(e){finish(Object.assign(e,{code:e.code||'DOCUMENT_READ_FAILED'}));}});
  });
}
export class FileReader {
  constructor(store){this.store=store;this.children=new Set();this.generation=0;}
  cancel(){this.generation++;for(const child of this.children)child.kill('SIGKILL');}
  async read(o){
    const store=this.store,gen=this.generation;store.checkActive();
    const {fd,path:file,stat}=store.openRead(o.path);const fingerprint=stamp(stat);
    try{
      if(o.fingerprint&&o.fingerprint!==fingerprint)fail('FILE_CHANGED','文件已变化，请重新开始读取。');
      const ext=path.extname(file).toLowerCase();const limit=o.limit??100,offset=o.offset??0;
      if(!Number.isInteger(offset)||offset<0||!Number.isInteger(limit)||limit<1||limit>1000)fail('ARG_INVALID','读取范围无效。');
      const explicit=o.format||'auto';
      const format=explicit==='auto'?imageTypes[ext]?'image':({'.docx':'docx','.xlsx':'xlsx','.xlsm':'xlsx','.csv':'csv','.plist':'plist','.sqlite':'sqlite','.sqlite3':'sqlite','.db':'sqlite','.pdf':'pdf'}[ext]||'text'):explicit;
      let data;
      if(format==='text'){
        const encoding=o.encoding||'utf-8';if(!encodings.has(encoding))fail('ENCODING_UNSUPPORTED','不支持此编码。');
        const size=o.max_bytes??65536;if(!Number.isInteger(size)||size<4||size>131072)fail('ARG_INVALID','每次读取 4–131072 字节。');
        if(offset>stat.size)fail('OFFSET_INVALID','读取位置超过文件大小。');
        const buf=Buffer.alloc(Math.min(size,Math.max(0,stat.size-offset)));let n=fs.readSync(fd,buf,0,buf.length,offset);
        if(!encoding.startsWith('utf-16')&&buf.subarray(0,n).includes(0))fail('BINARY_BLOCKED','这是二进制文件，请指定其实际格式。');
        let content='',used=n,lastError;
        for(let cut=0;cut<=Math.min(4,n);cut++){
          try{used=n-cut;content=new TextDecoder(encoding,{fatal:true}).decode(buf.subarray(0,used));lastError=null;break;}catch(e){lastError=e;if(offset+n>=stat.size)break;}
        }
        if(lastError||n>0&&used===0)fail('ENCODING_INVALID','解码失败，请提供文件的实际编码，或从返回的 next_offset 继续。');
        data={format:'text',encoding,content,offset,bytes_read:used,next_offset:offset+used<stat.size?offset+used:null,truncated:offset+used<stat.size,chunk_sha256:digest(buf.subarray(0,used))};
      }else if(format==='image'){
        if(stat.size>4*1024*1024)fail('IMAGE_TOO_LARGE','图片超过 4 MiB，请先生成较小预览。');
        const buf=fs.readFileSync(fd),mime=imageTypes[ext];
        const valid=mime==='image/png'?buf.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])):mime==='image/jpeg'?buf[0]===255&&buf[1]===216:mime==='image/webp'?buf.toString('ascii',0,4)==='RIFF'&&buf.toString('ascii',8,12)==='WEBP':mime==='image/gif'?/^GIF8[79]a/.test(buf.toString('ascii',0,6)):false;
        if(!valid)fail('IMAGE_FORMAT_INVALID','图片内容与文件格式不匹配。');
        data={format:'image',mimeType:mime,bytes:buf.length,image_base64:buf.toString('base64')};
      }else if(format==='sqlite'){
        const helper=path.resolve(HERE,'../../bin/ken-document-reader');
        if(!fs.existsSync(helper))fail('DOCUMENT_RUNTIME_MISSING','SQLite 原生读取器尚未编译，请运行本包构建步骤。');
        const sidecars=[];
        const current=input=>{
          try{return store.openRead(input);}
          catch(e){if(e.code!=='ENOENT')throw e;store.resolve(input,{missing:true});return null;}
        };
        try{
          for(const suffix of ['-wal','-shm','-journal'])sidecars.push(current(file+suffix));
          const captured=[{fd,path:file,stat},...sidecars];
          const validate=()=>{
            store.checkActive();if(gen!==this.generation)fail('READ_CANCELLED','连接或权限已改变，读取结果已丢弃。');
            for(let i=0;i<captured.length;i++){
              const live=current(file+['','-wal','-shm','-journal'][i]);
              try{const old=captured[i];if(Boolean(old)!==Boolean(live)||old&&(old.path!==live.path||old.stat.dev!==live.stat.dev||old.stat.ino!==live.stat.ino))fail('FILE_CHANGED','数据库文件在打开过程中变化，请重试。');}
              finally{if(live)fs.closeSync(live.fd);}
            }
          };
          const descriptor_mask=captured.reduce((mask,item,i)=>mask|(item?1<<i:0),0);
          data=await runAdapter(helper,['--sqlite',JSON.stringify({...o,format,path:file,offset,limit,descriptor_mask})],fd,this.children,{fds:sidecars.map(item=>item?.fd??'ignore'),validate});
        }finally{for(const item of sidecars)if(item)fs.closeSync(item.fd);}
      }else if(['docx','xlsx','csv','plist'].includes(format)){
        if(format!=='csv'&&stat.size>64*1024*1024)fail('DOCUMENT_TOO_LARGE','文档超过解析上限，请拆分后读取。');
        const python=['/usr/bin/python3','/opt/homebrew/bin/python3'].find(p=>fs.existsSync(p));
        if(!python)fail('DOCUMENT_RUNTIME_MISSING','本机缺少文档解析需要的 Python 3。');
        data=await runAdapter(python,[path.join(HERE,'document-reader.py'),JSON.stringify({...o,format,path:file,offset,limit})],fd,this.children);
      }else if(format==='pdf'){
        const helper=path.resolve(HERE,'../../bin/ken-document-reader');
        if(!fs.existsSync(helper))fail('PDF_RUNTIME_MISSING','PDF 原生读取器尚未编译，请运行本包构建步骤。');
        data=await runAdapter(helper,[String(offset),String(Math.min(limit,20))],fd,this.children);
      }else fail('FORMAT_UNSUPPORTED','支持 text、docx、xlsx、csv、plist、sqlite、pdf 与 image。');
      store.checkActive();if(gen!==this.generation)fail('READ_CANCELLED','连接或权限已改变，读取结果已丢弃。');
      if(stamp(fs.fstatSync(fd))!==fingerprint)fail('FILE_CHANGED','文件在读取过程中变化，请重试。');
      store.audit({event:'read_file',path:o.path,format,bytes:stat.size});
      return {path:o.path,fingerprint,total_bytes:stat.size,...data};
    }finally{fs.closeSync(fd);}
  }
}
