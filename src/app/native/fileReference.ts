import {sha256} from '@noble/hashes/sha2.js';
import type {TransferProgress} from '../components/TaskProgress';
import {NativeApiError} from './api';

export type FileReference={path:string;expectedFingerprint:string};
declare global {
  interface Window { harnessDesktop?: {getPathForFile(file:File):string}; }
}
export function desktopFilePath(file:File):string {
  if(typeof window==='undefined')return '';
  return window.harnessDesktop?.getPathForFile(file)??'';
}
export async function fingerprintFile(file:File,signal:AbortSignal,onProgress?:(progress:TransferProgress)=>void):Promise<string>{
  signal.throwIfAborted();
  if(!file.size)throw new Error('空のファイルは取り込めません。');
  const hash=sha256.create(),reader=file.stream().getReader();let loaded=0,last=0;
  const cancel=()=>{void reader.cancel().catch(()=>{});};signal.addEventListener('abort',cancel,{once:true});
  try{
    onProgress?.({phase:'checking',loaded:0,total:file.size});
    for(;;){
      signal.throwIfAborted();const chunk=await reader.read();signal.throwIfAborted();if(chunk.done)break;
      hash.update(chunk.value);loaded+=chunk.value.length;
      const now=performance.now();if(now-last>=100||loaded===file.size){last=now;onProgress?.({phase:'checking',loaded,total:file.size});}
    }
    if(loaded!==file.size)throw new Error('読み込み中に素材が変わりました。もう一度選んでください。');
    return Array.from(hash.digest(),byte=>byte.toString(16).padStart(2,'0')).join('');
  }finally{signal.removeEventListener('abort',cancel);reader.releaseLock();hash.destroy();}
}

/** File inputs hide their absolute path. Match bytes before registering any reference. */
export async function resolveFileReference(file:File,signal:AbortSignal,chooseLocation:()=>Promise<string>,onProgress?:(progress:TransferProgress)=>void):Promise<FileReference>{
  const nativePath=desktopFilePath(file);
  const expectedFingerprint=await fingerprintFile(file,signal,onProgress);onProgress?.({phase:'preparing'});
  signal.throwIfAborted();
  if(nativePath)return {path:nativePath,expectedFingerprint};
  const response=await fetch('/api/sequence/reference-match',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:file.name,sizeBytes:file.size,fingerprint:expectedFingerprint}),signal});
  const result=await response.json();if(!response.ok)throw new NativeApiError(result.error??'素材の保存場所を確認できませんでした。',response.status);
  signal.throwIfAborted();
  const path=result.matched&&typeof result.path==='string'?result.path:await chooseLocation();
  signal.throwIfAborted();return {path,expectedFingerprint};
}
