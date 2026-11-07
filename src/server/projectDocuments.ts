import {constants} from 'node:fs';
import {copyFile,lstat,mkdir,readdir,realpath,rename,rm} from 'node:fs/promises';
import {join,sep} from 'node:path';
import {DOCUMENTS_FOLDER,MAX_DOCUMENTS,isDocumentName,type ProjectDocument} from '../shared/projectDocuments';
import {HttpError} from './http';
import {watchedFs} from './sequence/fsWatch';

/**
 * プロジェクトに保管する台本や書類（`<プロジェクト>/資料/`）。public/ の外なので、書き出しや素材欄には混ざらない。
 * リンクは保存にも一覧にも本文にも使わない。プロジェクトの置き場が応答しない外付けでも他の API を止めないよう、同期のファイル操作を使わない。
 */
const MAX_DEPTH=6;
const entry=(path:string)=>watchedFs('lstat',path,()=>lstat(path)).catch((error:NodeJS.ErrnoException)=>{if(error.code==='ENOENT')return null;throw error;});
const toAbsolute=(dir:string,rel:string)=>join(dir,DOCUMENTS_FOLDER,...rel.split('/'));

/** 画面から来た相対パスを検査する。区切りは / のみで、外へ出る要素と隠し項目を断る。 */
export function documentRelPath(raw:string):string{
  const parts=raw.split('/');
  const bad=raw===''||raw.includes('\\')||raw.includes('\0')||/^[A-Za-z]:/.test(raw)||parts.length>MAX_DEPTH||parts.some(part=>part===''||part.startsWith('.'));
  if(bad)throw new HttpError(400,`書類のパスが不正です: ${raw}`);
  if(!isDocumentName(parts[parts.length-1]!))throw new HttpError(400,`保管できない形式です: ${raw}`);
  return raw;
}

/** 資料/ から目的地の手前までに、リンクや通常のフォルダ以外が無いことを確かめる。 */
async function assertPlainFolders(dir:string,rel:string):Promise<void>{
  let current=join(dir,DOCUMENTS_FOLDER);
  const folders=rel.split('/').slice(0,-1);
  for(const name of ['',...folders]){
    if(name!=='')current=join(current,name);
    const info=await entry(current);
    if(info===null)return;
    if(!info.isDirectory()||info.isSymbolicLink())throw new HttpError(400,`書類のパスが不正です: ${rel}`);
  }
}

/** 1 プロジェクトの保存は順番に行う（件数と同名の確認を、確定と分けない）。 */
const queues=new Map<string,Promise<unknown>>();
function inTurn<T>(dir:string,task:()=>Promise<T>):Promise<T>{
  const run=(queues.get(dir)??Promise.resolve()).then(task,task);
  const settled=run.catch(()=>undefined);
  queues.set(dir,settled);
  void settled.then(()=>{if(queues.get(dir)===settled)queues.delete(dir);});
  return run;
}

/** 受信済みの一時ファイルを資料へ移す。同名は上書きしない。一時ファイルの後始末は呼び出し側が行う。 */
export function saveProjectDocument(dir:string,rel:string,tmpPath:string):Promise<ProjectDocument>{
  const safe=documentRelPath(rel);
  return inTurn(dir,async()=>{
    await assertPlainFolders(dir,safe);
    const absolutePath=toAbsolute(dir,safe);
    if(await entry(absolutePath))throw new HttpError(409,`同じ名前の書類があります: ${safe}`);
    if((await listProjectDocuments(dir)).length>=MAX_DOCUMENTS)throw new HttpError(400,`書類は1プロジェクト${MAX_DOCUMENTS}件まで保管できます`);
    await mkdir(join(absolutePath,'..'),{recursive:true});
    try{await rename(tmpPath,absolutePath);}
    catch(error){
      if((error as NodeJS.ErrnoException).code!=='EXDEV')throw error;
      try{await copyFile(tmpPath,absolutePath,constants.COPYFILE_EXCL);}
      catch(copyError){if((copyError as NodeJS.ErrnoException).code!=='EEXIST')await rm(absolutePath,{force:true});throw copyError;}
    }
    return {path:safe,sizeBytes:(await lstat(absolutePath)).size,absolutePath};
  });
}

/** 保管している書類の一覧（通常のファイルのみ・相対パス順）。資料が無ければ空。 */
export async function listProjectDocuments(dir:string):Promise<ProjectDocument[]>{
  const root=join(dir,DOCUMENTS_FOLDER),found:ProjectDocument[]=[];
  const info=await entry(root);
  if(!info?.isDirectory()||info.isSymbolicLink())return found;
  const walk=async(folder:string,prefix:string,depth:number):Promise<void>=>{
    for(const item of await watchedFs('readdir',folder,()=>readdir(folder,{withFileTypes:true}))){
      if(item.name.startsWith('.'))continue;
      const absolutePath=join(folder,item.name),path=`${prefix}${item.name}`;
      if(item.isDirectory()){if(depth<MAX_DEPTH)await walk(absolutePath,`${path}/`,depth+1);}
      else if(item.isFile()&&isDocumentName(item.name)){
        const stat=await entry(absolutePath);
        if(stat?.isFile())found.push({path,sizeBytes:stat.size,absolutePath});
      }
    }
  };
  await walk(root,'',1);
  return found.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
}

/** 本文を返す前の確認。資料の中の通常のファイルなら絶対パスを返す。 */
export async function projectDocumentPath(dir:string,rel:string):Promise<string>{
  const safe=documentRelPath(rel);
  await assertPlainFolders(dir,safe);
  const absolutePath=toAbsolute(dir,safe),info=await entry(absolutePath);
  if(!info)throw new HttpError(404,`書類が見つかりません: ${safe}`);
  if(!info.isFile())throw new HttpError(400,`書類のパスが不正です: ${safe}`);
  const [realFile,realRoot]=await Promise.all([watchedFs('realpath',absolutePath,()=>realpath(absolutePath)),watchedFs('realpath',join(dir,DOCUMENTS_FOLDER),()=>realpath(join(dir,DOCUMENTS_FOLDER)))]);
  if(!realFile.startsWith(realRoot+sep))throw new HttpError(400,`書類のパスが不正です: ${safe}`);
  return absolutePath;
}
