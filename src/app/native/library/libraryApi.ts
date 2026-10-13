import {useCallback,useEffect,useState} from 'react';
import type {SequenceAsset} from '../../../core/sequence/model';
import type {SequenceCommand} from '../../../core/sequence/commands';
import {NativeApiError,nativeRequest} from '../api';

// サーバー側 src/server/library/catalog.ts と同じ形（画面からサーバーのコードは import しない）。
export type LibraryMediaKind='se'|'bgm'|'image';
export interface LibraryPack{packId:string;name:string;component:string;asset:string}
export interface LibraryTemplate{key:string;packId:string;template:number;name:string;group:string;use:string;preview:string;sample:string;durationSec:number}
export interface LibraryMedia{key:string;kind:LibraryMediaKind;name:string;desc:string;file:string;preview?:string;fingerprint:string;durationSec?:number;gainDb?:number}
export interface LibraryCatalog{version:2;packs:LibraryPack[];templates:LibraryTemplate[];media:LibraryMedia[]}
export type LibraryListing={ok:true;directory:string;catalog:LibraryCatalog;missing:string[]}|{ok:false;directory:string;reason:string};

async function readJson<T>(response:Response,fallback:string):Promise<T>{
  const result=await response.json().catch(()=>({}));
  if(!response.ok)throw new NativeApiError((result as {error?:string}).error??fallback,response.status);
  return result as T;
}

export async function fetchLibrary(signal?:AbortSignal):Promise<LibraryListing>{
  return readJson<LibraryListing>(await fetch('/api/library',{signal}),'素材置場を読み込めません');
}

export const libraryFileUrl=(key:string,part:'preview'|'media'):string=>`/api/library/file?${new URLSearchParams({key,part})}`;

export async function saveToLibrary(input:{projectId:string;assetId:string;kind:LibraryMediaKind;name:string;desc:string}):Promise<{item:LibraryMedia;created:boolean;warning?:string}>{
  const response=await fetch('/api/library/save',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)});
  return readJson(response,'素材置場に保存できません');
}

/** 置場の項目を案件に取り込む（文書は変えない）。返った asset は配置の組み立てに使う。 */
export async function prepareLibraryItem(projectId:string,key:string,signal?:AbortSignal):Promise<SequenceAsset>{
  return (await nativeRequest<{asset:SequenceAsset}>(projectId,'/library/prepare',{key},signal)).asset;
}

/** 登録＋配置を 1 回の編集として実行する。同じ操作の再送は同じ executionId を使う。 */
export async function placeLibraryItems<S>(projectId:string,input:{sessionId:string;expectedRevision:number;executionId:string;keys:string[];commands:SequenceCommand[]},signal?:AbortSignal):Promise<S>{
  return nativeRequest<S>(projectId,'/library/place',input,signal);
}

/** 置場の一覧。初めて表示した時に読み、reload()（保存後・再読み込みボタン）で読み直す。失敗は ok:false の一覧として返す。 */
export function useLibraryListing(active=true):{listing:LibraryListing|null;loading:boolean;reload():void}{
  const [listing,setListing]=useState<LibraryListing|null>(null),[loading,setLoading]=useState(false),[serial,setSerial]=useState(0),[opened,setOpened]=useState(active);
  if(active&&!opened)setOpened(true);
  useEffect(()=>{
    if(!opened)return;
    const controller=new AbortController();setLoading(true);
    void fetchLibrary(controller.signal).then(value=>{if(!controller.signal.aborted)setListing(value);})
      .catch(error=>{if(!controller.signal.aborted)setListing({ok:false,directory:'',reason:error instanceof Error?error.message:String(error)});})
      .finally(()=>{if(!controller.signal.aborted)setLoading(false);});
    return()=>controller.abort();
  },[serial,opened]);
  return {listing,loading,reload:useCallback(()=>setSerial(value=>value+1),[])};
}
