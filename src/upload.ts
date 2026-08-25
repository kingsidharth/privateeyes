import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import Busboy from 'busboy';
import { nanoid } from 'nanoid';
import type { Context } from 'hono';
import type { DB } from './db.js';
import { config, tmpDir } from './config.js';
import { mimeFor, isAttachment } from './mime.js';
import { putFile } from './r2.js';

export function sanitizeName(input: string) { const s=input.replace(/[\\/]/g,'').replace(/[\u0000-\u001f\u007f]/g,'').replace(/^\.+/,'').trim(); return s || 'file'; }
export function uploadRequest(c: Context, db: DB, tokenId: number) {
  return new Promise<Response>((resolve, reject) => {
    const contentType=c.req.header('content-type') || ''; const match=contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i); if (!match) return resolve(c.json({error:'invalid_multipart',message:'multipart/form-data required'},400));
    fs.mkdirSync(tmpDir,{recursive:true}); const temp=path.join(tmpDir,crypto.randomUUID()); let stream: fs.WriteStream|undefined; let fileName='file', override:string|undefined, fileMime='application/octet-stream', size=0, failed=false; const sha=crypto.createHash('sha256');
    const cleanup=async()=>{ if(stream) stream.destroy(); await fsp.rm(temp,{force:true}).catch(()=>{}); };
    const fail=async(status:number, body:object)=>{ if(failed)return; failed=true; await cleanup(); resolve(c.json(body,status as 400)); };
    const bb=Busboy({headers:{'content-type':contentType}, limits:{files:1,fields:10}});
    bb.on('field',(name,value)=>{if(name==='name')override=value;});
    bb.on('file',(name,file,info)=>{ if(name!=='file'){file.resume(); return;} fileName=info.filename||'file'; fileMime=mimeFor(fileName); stream=fs.createWriteStream(temp); file.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>config.maxFileBytes) { file.resume(); void fail(413,{error:'file_too_large',message:'file exceeds MAX_FILE_MB'}); return;} sha.update(chunk); stream?.write(chunk); }); file.on('end',()=>stream?.end()); file.on('error',()=>void fail(400,{error:'upload_aborted',message:'upload interrupted'})); });
    bb.on('error',()=>void fail(400,{error:'invalid_upload',message:'invalid multipart body'}));
    bb.on('finish',async()=>{ if(failed)return; if(!stream) return fail(400,{error:'missing_file',message:'file field required'}); await new Promise<void>(r=>stream?.once('close',()=>r())); try { const safe=sanitizeName(override||fileName), digest=sha.digest('hex'); const existing=db.prepare('SELECT * FROM files WHERE sha256=? AND deleted=0').get(digest) as any; if(existing){await cleanup();return resolve(c.json(fileResponse(existing,true),200));} const id=nanoid(12), r2Key=`f/${id}/${encodeURIComponent(safe)}`, mime=mimeFor(safe), disposition=`${isAttachment(mime)?'attachment':'inline'}; filename="${safe.replace(/"/g,'')}"`; await putFile(temp,r2Key,mime,disposition); const uploadedAt=new Date().toISOString(); db.prepare('INSERT INTO files (id,original_name,mime,bytes,sha256,r2_key,token_id,uploaded_at) VALUES (?,?,?,?,?,?,?,?)').run(id,safe,mime,size,digest,r2Key,tokenId,uploadedAt); await cleanup(); resolve(c.json({url:`${config.publicBaseUrl}/f/${id}/${encodeURIComponent(safe)}`,id,name:safe,sha256:digest,bytes:size,mime,deduped:false},201)); } catch(error){await cleanup();reject(error);} });
    const body=c.req.raw.body; if(!body)return void fail(400,{error:'missing_body',message:'request body required'}); Readable.fromWeb(body as any).pipe(bb);
  });
}
function fileResponse(file:any,deduped:boolean) { return {url:`${config.publicBaseUrl}/f/${file.id}/${encodeURIComponent(file.original_name)}`,id:file.id,name:file.original_name,sha256:file.sha256,bytes:file.bytes,mime:file.mime,deduped}; }
