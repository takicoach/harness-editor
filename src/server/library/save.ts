import {copyFile,lstat,mkdir,open,readFile,rename,stat,unlink,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {constants} from 'node:fs';
import {libraryExtensionAllowed,parseLibraryCatalog,readLibraryCatalog,resolveLibraryFile,LibraryError,type LibraryCatalog,type LibraryMedia,type LibraryMediaKind} from './catalog';

const FOLDER:Record<LibraryMediaKind,string>={se:'効果音',bgm:'BGM',image:'画像'};
const LOCK_MAX_AGE_MS=2*60_000;
export function libraryFileName(name:string,fingerprint:string,extension:string):string{
  const safe=Array.from(name.normalize('NFC').replace(/[\u0000-\u001f\u007f/\\:*?"<>|／]/g,'_').replace(/\s+/g,' ').trim()).slice(0,60).join('').replace(/^\.+/,m=>'_'.repeat(m.length))||'素材';
  return `${safe}__${fingerprint.slice(0,8)}${extension.toLowerCase()}`;
}
export const catalogScript=(catalog:LibraryCatalog)=>`window.CATALOG = ${JSON.stringify(catalog)};\n`;

const busy=()=>new LibraryError('ほかの保存が進行中です。少し待ってからやり直してください',409);
const alive=(pid:number)=>{try{process.kill(pid,0);return true;}catch(e){return (e as NodeJS.ErrnoException).code!=='ESRCH';}};

/** A lock is stale when its process is gone or it is older than two minutes (unreadable locks fall back to the file's mtime). */
async function lockIsStale(lock:string):Promise<boolean>{
  let pid:unknown,at:unknown;
  try{const v=JSON.parse(await readFile(lock,'utf8')) as {pid?:unknown;at?:unknown};pid=v.pid;at=v.at;}catch{/* unreadable: judged by age below */}
  if(typeof at!=='number'){try{at=(await stat(lock)).mtimeMs;}catch{return false;}}
  if(Date.now()-(at as number)>=LOCK_MAX_AGE_MS)return true;
  return typeof pid==='number'&&Number.isInteger(pid)&&pid>0&&!alive(pid);
}
const RECLAIM_MAX_AGE_MS=30_000;
async function reclaimStale(lock:string):Promise<void>{
  const guard=`${lock}.reclaim`;
  let handle;
  for(let attempt=0;!handle;attempt++){
    try{handle=await open(guard,'wx',0o600);}
    catch(e){
      if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;
      let at:unknown;try{at=(JSON.parse(await readFile(guard,'utf8')) as {at?:unknown}).at;}catch{/* unreadable: judged by mtime */}
      if(typeof at!=='number'){try{at=(await stat(guard)).mtimeMs;}catch{at=0;}}
      if(attempt>0||Date.now()-(at as number)<RECLAIM_MAX_AGE_MS)throw busy();
      await unlink(guard).catch(()=>undefined); // 30 秒以上古い補助ロックは落ちた回収者の残り
    }
  }
  try{
    await handle.writeFile(JSON.stringify({pid:process.pid,at:Date.now()}));
    if(await lockIsStale(lock)){
      const aside=`${lock}.stale.${randomUUID()}`;
      try{await rename(lock,aside);await unlink(aside).catch(()=>undefined);}
      catch(r){if((r as NodeJS.ErrnoException).code!=='ENOENT')throw r;}
    }
  }finally{await handle.close().catch(()=>undefined);await unlink(guard).catch(()=>undefined);}
}
async function acquire(lock:string):Promise<string>{
  const token=randomUUID();
  for(let attempt=0;;attempt++){
    try{
      const handle=await open(lock,'wx',0o600);
      try{await handle.writeFile(JSON.stringify({token,pid:process.pid,at:Date.now()}));}catch(e){await handle.close().catch(()=>undefined);await unlink(lock).catch(()=>undefined);throw e;}
      await handle.close();
      return token;
    }catch(e){
      if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;
      if(attempt>0||!(await lockIsStale(lock)))throw busy();
      // stale: 回収は補助ロックの中で、ロックの中身を読み直して古さを再判定してから行う（他者が回収して作った新しいロックを退避しないため）
      await reclaimStale(lock);
    }
  }
}
async function release(lock:string,token:string){
  try{const v=JSON.parse(await readFile(lock,'utf8')) as {token?:unknown};if(v.token===token)await unlink(lock);}catch{/* gone or not ours: leave it */}
}
export async function withLock<T>(dir:string,run:()=>Promise<T>):Promise<T>{
  const lock=join(dir,'catalog.lock'),token=await acquire(lock);
  try{return await run();}finally{await release(lock,token);}
}

async function writeAtomic(dir:string,name:string,text:string,mode?:number){
  const tmp=join(dir,`${name}.${randomUUID()}.tmp`);
  try{await writeFile(tmp,text,{flag:'wx',...(mode?{mode}:{})});await rename(tmp,join(dir,name));}
  catch(e){await unlink(tmp).catch(()=>undefined);throw e;}
}

export async function saveToLibrary(dir:string,input:{sourcePath:string;fingerprint:string;kind:LibraryMediaKind;name:string;desc:string;extension:string;durationSec?:number}):Promise<{item:LibraryMedia;created:boolean;warning?:string}>{
  const purpose=input.kind==='image'?'image':'audio';
  if(!/^[a-f0-9]{64}$/.test(input.fingerprint))throw new LibraryError('素材の指紋が不正です');
  if(!libraryExtensionAllowed(purpose,input.extension))throw new LibraryError('この形式のファイルは素材置場に保存できません');
  if(!input.name.trim())throw new LibraryError('名前が必要です');
  await readLibraryCatalog(dir); // 置場が無い時は 404 と理由を返す（ロック取得の ENOENT を生で出さない）
  return withLock(dir,async()=>{
    const catalog=await readLibraryCatalog(dir);
    const same=catalog.media.find(m=>m.kind===input.kind&&m.fingerprint===input.fingerprint);
    if(same)return {item:same,created:false};
    const folder=join(dir,FOLDER[input.kind]);await mkdir(folder,{recursive:true});
    const info=await lstat(folder);if(info.isSymbolicLink()||!info.isDirectory())throw new LibraryError('素材置場の保存先フォルダが不正です');
    let file='',n=0;
    for(;;){
      const base=libraryFileName(input.name,input.fingerprint,input.extension).replace(/(\.[a-z0-9]+)$/,n?`_${n}$1`:'$1');
      file=`${FOLDER[input.kind]}/${base}`;
      try{await copyFile(input.sourcePath,join(dir,file),constants.COPYFILE_EXCL);break;}
      catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST'||++n>50)throw e;}
    }
    try{await resolveLibraryFile(dir,file,purpose);}catch(e){await unlink(join(dir,file)).catch(()=>undefined);throw e;}
    const item:LibraryMedia={key:`${input.kind}:${input.fingerprint.slice(0,16)}`,kind:input.kind,name:input.name.normalize('NFC').trim().slice(0,120),desc:input.desc.normalize('NFC').slice(0,2000),
      file,fingerprint:input.fingerprint,...(input.durationSec?{durationSec:input.durationSec}:{}),...(input.kind==='image'?{preview:file}:{})};
    const next:LibraryCatalog={...catalog,media:[...catalog.media,item]};
    try{parseLibraryCatalog(next);await writeAtomic(dir,'catalog.json',JSON.stringify(next,null,1)+'\n',0o644);} // 確定点
    catch(e){await unlink(join(dir,file)).catch(()=>undefined);throw e;}
    try{await writeAtomic(dir,'catalog.js',catalogScript(next));return {item,created:true};}
    catch(e){return {item,created:true,warning:`一覧ページ用の catalog.js を更新できませんでした（${e instanceof Error?e.message:String(e)}）`};}
  });
}

/** Rebuilds catalog.js when it is missing or older than catalog.json. Only when the lock is free; never throws. */
export async function refreshCatalogScript(dir:string):Promise<void>{
  try{
    const json=await stat(join(dir,'catalog.json')),js=await stat(join(dir,'catalog.js')).catch(()=>undefined);
    if(js&&js.mtimeMs>=json.mtimeMs)return;
    await withLock(dir,async()=>writeAtomic(dir,'catalog.js',catalogScript(await readLibraryCatalog(dir))));
  }catch{/* best effort */}
}
