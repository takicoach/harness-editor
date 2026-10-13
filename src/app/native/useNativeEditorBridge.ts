import { useRef, useState } from 'react';
import { isAgentEditBlocked } from '../isModalOpen';
import { nativeRequest, NativeApiError } from './api';
import type { useNativeSession } from './useNativeSession';
import { createNativeEditorBridge } from './nativeEditorBridge';

/** mode は heartbeat に載せる今のモード（AI タブの土台）。呼び出し側は ref で最新を返す。 */
export function useNativeEditorBridge(projectId:string,session:ReturnType<typeof useNativeSession>,draftBusy=false,mode:()=>'video'|'thumbnail'=()=>'video') {
  const latest=useRef(session);latest.current=session;
  const drafting=useRef(draftBusy);drafting.current=draftBusy;
  const modeRef=useRef(mode);modeRef.current=mode;
  const [busy,setBusy]=useState(false);
  const [autoSavePaused,setAutoSavePaused]=useState(false);
  const bridge=useRef<ReturnType<typeof createNativeEditorBridge>|null>(null);
  if(!bridge.current) bridge.current=createNativeEditorBridge({projectId,sessionId:crypto.randomUUID(),
    read:()=>latest.current.readCurrent(),accept:value=>latest.current.accept(value),saving:()=>latest.current.busy,
    humanBusy:()=>drafting.current||isAgentEditBlocked(),busy:setBusy,mode:()=>modeRef.current(),request:async(route,body,headers)=>{
      try {return await nativeRequest(projectId,route,body,undefined,undefined,headers);}
      catch(error){if(error instanceof NativeApiError && error.code)throw new Error(`${error.code}: ${error.message}`);throw error;}
    }});
  return {bridge:bridge.current,busy,autoSavePaused,release:()=>setBusy(false),
    pauseAutoSave:()=>{setBusy(false);setAutoSavePaused(true);},resumeAutoSave:()=>setAutoSavePaused(false)};
}
