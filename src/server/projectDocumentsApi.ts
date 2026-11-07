import {createReadStream} from 'node:fs';
import {lstat,rm} from 'node:fs/promises';
import type {IncomingMessage,ServerResponse} from 'node:http';
import {basename} from 'node:path';
import {MAX_DOCUMENT_BYTES} from '../shared/projectDocuments';
import {HttpError,sendJson} from './http';
import {documentRelPath,listProjectDocuments,projectDocumentPath,saveProjectDocument} from './projectDocuments';
import {resolveProjectDirAsync} from './projectRoot';
import {assertContentLengthWithin,streamBodyToTempFile} from './streamUpload';

const param=(url:URL,name:string):string=>{
  const value=url.searchParams.get(name);
  if(!value)throw new HttpError(400,`${name} を指定してください`);
  return value;
};
async function projectDir(root:string,url:URL):Promise<string>{
  const id=param(url,'id'),dir=await resolveProjectDirAsync(root,id),info=await lstat(dir).catch(()=>null);
  if(!info)throw new HttpError(404,`プロジェクトが見つかりません: ${id}`);
  return dir;
}

/** 書類の API（設計 4 章）。自分の宛先なら true を返す。 */
export async function handleProjectDocumentsApi(req:IncomingMessage,res:ServerResponse,url:URL,root:string,uploadDir:string):Promise<boolean>{
  if(url.pathname==='/api/project/documents'){
    if(req.method==='GET'){sendJson(res,200,{documents:await listProjectDocuments(await projectDir(root,url))});return true;}
    if(req.method!=='POST')throw new HttpError(405,'このエンドポイントは GET と POST のみ対応します');
    // 受信の前に断れるものは断る（大きな本文を受け切ってから 400 にしない）。
    const rel=documentRelPath(param(url,'path')),dir=await projectDir(root,url);
    assertContentLengthWithin(req,MAX_DOCUMENT_BYTES);
    const tmpPath=await streamBodyToTempFile(req,uploadDir,MAX_DOCUMENT_BYTES);
    try{sendJson(res,200,await saveProjectDocument(dir,rel,tmpPath));}
    finally{await rm(tmpPath,{force:true});}
    return true;
  }
  if(url.pathname==='/api/project/documents/file'){
    if(req.method!=='GET')throw new HttpError(405,'このエンドポイントは GET のみ対応します');
    const path=await projectDocumentPath(await projectDir(root,url),param(url,'path'));
    const stream=createReadStream(path);
    await new Promise<void>((resolve,reject)=>{
      stream.once('open',()=>{
        // 書類は読み込み用の本文。ブラウザに開かせない。
        res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Disposition':`attachment; filename*=UTF-8''${encodeURIComponent(basename(path))}`,
          'X-Content-Type-Options':'nosniff','Cache-Control':'no-store'});
        stream.pipe(res);
        resolve();
      });
      stream.once('error',reject);
    });
    return true;
  }
  return false;
}
