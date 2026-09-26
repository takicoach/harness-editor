import {useEffect,useLayoutEffect,useRef,useState,type DragEvent,type RefObject} from 'react';

const ASSET_TYPE='application/x-harness-asset';
interface Point {x:number;y:number;trackId:string}
interface Options {
  scroller:RefObject<HTMLDivElement>;ownerKey:string;disabled:boolean;
  position(clientX:number):number;
  valid(assetId:string,trackId:string):boolean;
  drop(assetId:string,frame:number,trackId:string):void;
}
/** HTML drag events do not share the captured-pointer lifecycle of clip editing. */
export function useNativeAssetDrop(options:Options){
  const live=useRef(options);live.current=options;
  const previous=useRef({ownerKey:options.ownerKey,disabled:options.disabled});
  const point=useRef<Point|null>(null),retired=useRef(false),mounted=useRef(true);
  const [preview,setPreview]=useState<{frame:number;trackId:string}|null>(null);
  const leave=()=>{point.current=null;setPreview(null);};
  const cancel=()=>{retired.current=true;leave();};
  const refresh=()=>{
    const current=point.current;if(!mounted.current||!current)return;
    const frame=live.current.position(current.x);
    setPreview(old=>old?.frame===frame&&old.trackId===current.trackId?old:{frame,trackId:current.trackId});
  };
  useLayoutEffect(()=>{
    const old=previous.current;previous.current={ownerKey:options.ownerKey,disabled:options.disabled};
    if(old.ownerKey!==options.ownerKey||old.disabled!==options.disabled)cancel();
  },[options.ownerKey,options.disabled]);
  useLayoutEffect(()=>{
    const element=options.scroller.current;if(!element||!preview)return;
    const value=element.style.getPropertyValue('overflow-x'),priority=element.style.getPropertyPriority('overflow-x');
    element.style.setProperty('overflow-x','hidden');
    return()=>{if(value)element.style.setProperty('overflow-x',value,priority);else element.style.removeProperty('overflow-x');};
  },[!!preview,options.scroller]);
  useEffect(()=>{
    mounted.current=true;
    const start=(event:globalThis.DragEvent)=>{if(event.dataTransfer?.types.includes(ASSET_TYPE))retired.current=false;};
    const end=()=>{leave();retired.current=false;};
    const outside=(event:globalThis.DragEvent)=>{
      const track=event.target instanceof Element?event.target.closest('[data-native-track]'):null;
      if(point.current&&(!track||!live.current.scroller.current?.contains(track)))leave();
    };
    const key=(event:KeyboardEvent)=>{if(event.key==='Escape')cancel();};
    window.addEventListener('dragstart',start);window.addEventListener('dragend',end);window.addEventListener('drop',end);
    window.addEventListener('dragover',outside);window.addEventListener('keydown',key,true);window.addEventListener('blur',cancel);
    return()=>{mounted.current=false;point.current=null;window.removeEventListener('dragstart',start);window.removeEventListener('dragend',end);window.removeEventListener('drop',end);window.removeEventListener('dragover',outside);window.removeEventListener('keydown',key,true);window.removeEventListener('blur',cancel);};
  },[]);
  return {
    preview,refresh,cancel,
    pointer:()=>point.current?{x:point.current.x,y:point.current.y,moved:true}:null,
    over(event:DragEvent,trackId:string){
      if(!mounted.current||live.current.disabled||retired.current||!event.dataTransfer.types.includes(ASSET_TYPE))return;
      event.preventDefault();event.dataTransfer.dropEffect='copy';
      point.current={x:event.clientX,y:event.clientY,trackId};refresh();
    },
    leave(event:DragEvent){if(!(event.relatedTarget instanceof Node)||!live.current.scroller.current?.contains(event.relatedTarget))leave();},
    drop(event:DragEvent,trackId:string){
      if(!mounted.current||!event.dataTransfer.types.includes(ASSET_TYPE))return;
      event.preventDefault();const assetId=event.dataTransfer.getData(ASSET_TYPE);
      const allowed=!!point.current&&!retired.current&&!live.current.disabled&&live.current.valid(assetId,trackId);
      const frame=allowed?live.current.position(event.clientX):0;
      leave();retired.current=true;
      if(allowed)live.current.drop(assetId,frame,trackId);
    },
  };
}
