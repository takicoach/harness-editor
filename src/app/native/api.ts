import type { SequenceDocument, SequenceAsset } from '../../core/sequence/model';
import type { SequenceCommand } from '../../core/sequence/commands';
import type { SequenceSessionState } from '../../server/sequence/service';
import type {TransferProgress} from '../components/TaskProgress';
import {imageUploadPrefix} from '../../shared/imageUploadFrame';

function uploadWithProgress<T>(url:string,file:Blob,onProgress:(progress:TransferProgress)=>void):Promise<T>{
  return new Promise((resolve,reject)=>{
    const xhr=new XMLHttpRequest();xhr.open('POST',url);xhr.responseType='json';
    xhr.upload.onprogress=event=>onProgress({phase:'uploading',loaded:event.loaded,...(event.lengthComputable?{total:event.total}:{})});
    xhr.upload.onload=()=>onProgress({phase:'preparing'});
    xhr.onerror=()=>reject(new NativeApiError('接続が切れました。取り込み結果を確認してから再試行してください。',0));
    xhr.onabort=()=>reject(new NativeApiError('取り込みを中止しました。',0));
    xhr.onload=()=>{const result=xhr.response;if(xhr.status>=200&&xhr.status<300&&result)resolve(result);else reject(new NativeApiError(result?.error??'素材を取り込めません',xhr.status));};
    onProgress({phase:'uploading',loaded:0,total:file.size});xhr.send(file);
  });
}

export function nativeCommandErrorMessage(error:unknown):string {
  if(error&&typeof error==='object'&&'code' in error&&error.code==='TIME_OVERFLOW')return '時間の設定を正確に保存できません。倍率や位置の値を調整して、もう一度操作してください。';
  return error instanceof Error?error.message:'変更を保存できませんでした。内容を確認して、もう一度入力してください。';
}
export class NativeApiError extends Error { constructor(message: string, readonly status: number, readonly code?:string, readonly targets:readonly string[] = []) { super(code==='TIME_OVERFLOW'?nativeCommandErrorMessage({code}):message); } }
export async function nativeRequest<T>(projectId: string, route: string, body?: unknown, signal?: AbortSignal, params?: Record<string, string>, headers?:Record<string,string>): Promise<T> {
  const response = await fetch(`/api/sequence${route}?${new URLSearchParams({ ...params, id: projectId })}`, {
    ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json',...headers }, body: JSON.stringify(body) }), signal,
  });
  const result = await response.json();
  if (!response.ok) throw new NativeApiError(result.error ?? '編集データを読み込めません', response.status, result.code, Array.isArray(result.targets)?result.targets.filter((id:unknown)=>typeof id==='string'):[]);
  return result as T;
}
export type NativeCommand = SequenceCommand | { type: 'undo' } | { type: 'redo' };
export type NativeSession = SequenceSessionState;
/** Confirmed workflow milestones, not an estimate of disk bytes or time remaining. */
export async function saveNativeSequence(projectId:string,body:unknown,onProgress:(percent:number)=>void):Promise<NativeSession>{
  onProgress(30);
  const response=await fetch(`/api/sequence/save?${new URLSearchParams({id:projectId})}`,{
    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),
  });
  if(response.ok)onProgress(80);
  const result=await response.json();
  if(!response.ok)throw new NativeApiError(result.error??'保存できませんでした',response.status,result.code,Array.isArray(result.targets)?result.targets.filter((id:unknown)=>typeof id==='string'):[]);
  onProgress(95);
  return result as NativeSession;
}
export async function createNativeProject(name:string,source:File|string,onProgress?:(progress:TransferProgress)=>void,expectedFingerprint?:string):Promise<{id:string}> {
  const linked=typeof source==='string',query=new URLSearchParams({name,native:'1',...(linked?{path:source}:{video:source.name})});
  if(onProgress&&!linked)return uploadWithProgress(`/api/create-project?${query}`,source,onProgress);
  onProgress?.({phase:'preparing'});
  const response=await fetch(`/api/${linked?'create-project-link':'create-project'}?${query}`,{method:'POST',...(linked&&expectedFingerprint?{headers:{'Content-Type':'application/json'},body:JSON.stringify({expectedFingerprint})}:{body:linked?undefined:source})});
  const result=await response.json();if(!response.ok)throw new NativeApiError(result.error??'動画を作成できません',response.status);return result;
}
/** Ordered manifest followed by the File objects, without reading their bytes into app memory. */
export function imageUploadBody(files:readonly File[]):Blob{
  return new Blob([imageUploadPrefix(files.map(file=>({name:file.name,size:file.size}))),...files]);
}
export async function createNativeImageProject(name:string,images:readonly File[]|readonly string[],onProgress?:(progress:TransferProgress)=>void):Promise<{id:string}>{
  const query=new URLSearchParams({name,native:'1'});
  if(images.every((image):image is string=>typeof image==='string')){
    onProgress?.({phase:'preparing'});
    const response=await fetch(`/api/create-project-image-paths?${query}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({paths:images})});
    const result=await response.json();if(!response.ok)throw new NativeApiError(result.error??'画像から作成できません',response.status);return result;
  }
  const body=imageUploadBody(images as readonly File[]);
  if(onProgress)return uploadWithProgress(`/api/create-project-images?${query}`,body,onProgress);
  const response=await fetch(`/api/create-project-images?${query}`,{method:'POST',body});
  const result=await response.json();if(!response.ok)throw new NativeApiError(result.error??'画像から作成できません',response.status);return result;
}
export async function openNativeSequence(projectId: string, signal?: AbortSignal): Promise<NativeSession | null> {
  const saved = await nativeRequest<{ document: SequenceDocument | null }>(projectId, '', undefined, signal);
  return saved.document ? nativeRequest<NativeSession>(projectId, '/session', {}, signal) : null;
}
export async function uploadNativeAsset(projectId: string, file: File,onProgress?:(progress:TransferProgress)=>void,role?:'music'|'effect'): Promise<SequenceAsset> {
  const query=new URLSearchParams({id:projectId,name:file.name,...(role?{role}:{})});
  if(onProgress)return (await uploadWithProgress<{asset:SequenceAsset}>(`/api/sequence/upload?${query}`,file,onProgress)).asset;
  const response = await fetch(`/api/sequence/upload?${query}`, { method: 'POST', body: file });
  const result = await response.json();
  if (!response.ok) throw new NativeApiError(result.error ?? '素材を取り込めません', response.status);
  return result.asset;
}
