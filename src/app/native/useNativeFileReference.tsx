import {useEffect,useRef,useState} from 'react';
import {MediaPicker} from '../panels/MediaPicker';
import type {TransferProgress} from '../components/TaskProgress';
import {resolveFileReference} from './fileReference';

/** Reuse the established picker when a dropped file's location cannot be identified. */
export function useNativeFileReference(){
  const active=useRef<AbortController|null>(null),mounted=useRef(true);
  const [choice,setChoice]=useState<{name:string;pick(path:string):void}|null>(null);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;active.current?.abort();active.current=null;};},[]);
  const resolve=async(file:File,onProgress?:(progress:TransferProgress)=>void)=>{
    if(!mounted.current)throw new DOMException('素材の追加を中止しました。','AbortError');
    if(active.current)throw new Error('素材の確認が終わるまでお待ちください。');
    const controller=new AbortController();active.current=controller;
    try{return await resolveFileReference(file,controller.signal,()=>new Promise<string>((accept,reject)=>{
      controller.signal.throwIfAborted();
      const abort=()=>{reject(new DOMException('素材の追加を中止しました。','AbortError'));};
      controller.signal.addEventListener('abort',abort,{once:true});
      setChoice({name:file.name,pick:path=>{if(active.current!==controller||controller.signal.aborted)return;controller.signal.removeEventListener('abort',abort);setChoice(null);accept(path);}});
    }),onProgress);
    }finally{if(active.current===controller){active.current=null;setChoice(null);}}
  };
  return {resolve,cancel:()=>active.current?.abort(),picker:choice&&<MediaPicker media="all" title="元の素材の保存場所を選ぶ" note={`「${choice.name}」の保存場所を選んでください。同じ内容か確認し、コピーせずに取り込みます。`} onPick={file=>choice.pick(file.path)} onCancel={()=>active.current?.abort()}/>};
}
