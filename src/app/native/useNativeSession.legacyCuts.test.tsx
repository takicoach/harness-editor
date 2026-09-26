/** @vitest-environment jsdom */
import {act,cleanup,renderHook,waitFor} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {useNativeSession} from './useNativeSession';
import type {NativeSession} from './api';
import {rational} from '../../core/sequence/time';
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
function setup(){
 const state:NativeSession={sessionId:'session-a',document:{schemaVersion:2,id:'a',name:'old',revision:4,fps:rational(30),resolution:{width:640,height:360},sequenceEndFrame:0,background:'#000',clips:[],tracks:[],assets:[],transitions:[],transcripts:[],ducking:{enabled:false,strength:'mid'}},savedRevision:4,savedContentHash:'saved',dirty:false,canUndo:false,canRedo:false};
 const plan={planId:'plan-a',planDigest:'digest-a',documentId:'a',revision:4,sourceFingerprint:'a'.repeat(64),entries:[{id:'old-cut',durationFrames:30,originalStart:60,originalEnd:90,frame:60}]};
 const prepare=vi.fn(async()=>plan),adopt=vi.fn(async()=>({...state,document:{...state.document,revision:5},dirty:true,canUndo:true}));
 const requests:Array<{route:string;body:Record<string,unknown>}>=[];
 vi.stubGlobal('fetch',vi.fn(async(url:string,options?:RequestInit)=>{
  const route=new URL(url,'http://localhost').pathname,body=options?.body?JSON.parse(String(options.body)):{};requests.push({route,body});
  const value=route.endsWith('/legacy-cuts/prepare')?await prepare():route.endsWith('/legacy-cuts/adopt')?await adopt():route.endsWith('/session')?state:{document:state.document};
  return {ok:true,json:async()=>value};
 }));
 const view=renderHook(({id})=>useNativeSession(id),{initialProps:{id:'a'}});
 return {view,state,prepare,adopt,requests};
}
it('adopts a server prepared plan using the captured owner and revision, accepting one session update',async()=>{
 const h=setup();await waitFor(()=>expect(h.view.result.current.state?.document.revision).toBe(4));
 await act(async()=>{expect(await h.view.result.current.importLegacyCutHistory()).toBe(true);});
 expect(h.requests.find(r=>r.route.endsWith('/legacy-cuts/adopt'))?.body).toMatchObject({sessionId:'session-a',expectedRevision:4,planId:'plan-a',planDigest:'digest-a'});
 expect(h.view.result.current.state?.document.revision).toBe(5);expect(h.adopt).toHaveBeenCalledTimes(1);
});
it('does not adopt a prepared old plan after the document changes while preparation is pending',async()=>{
 const h=setup();await waitFor(()=>expect(h.view.result.current.state).not.toBeNull());
 let release!:(value:Awaited<ReturnType<typeof h.prepare>>)=>void;const plan=await h.prepare();h.prepare.mockImplementationOnce(()=>new Promise(resolve=>{release=resolve;}));
 let task!:Promise<boolean>;act(()=>{task=h.view.result.current.importLegacyCutHistory();});await waitFor(()=>expect(h.prepare).toHaveBeenCalledTimes(2));
 act(()=>h.view.result.current.accept({...h.state,document:{...h.state.document,revision:5}}));
 await act(async()=>{release(plan);expect(await task).toBe(false);});expect(h.adopt).not.toHaveBeenCalled();
});
it('retries an uncertain adoption with the identical execution id and plan rather than preparing another copy',async()=>{
 const h=setup();await waitFor(()=>expect(h.view.result.current.state).not.toBeNull());h.adopt.mockRejectedValueOnce(new TypeError('connection lost'));
 await act(async()=>{expect(await h.view.result.current.importLegacyCutHistory()).toBe(false);});
 await act(async()=>{expect(await h.view.result.current.importLegacyCutHistory()).toBe(true);});
 const sends=h.requests.filter(r=>r.route.endsWith('/legacy-cuts/adopt'));expect(sends).toHaveLength(2);expect(sends[1]!.body).toEqual(sends[0]!.body);expect(h.prepare).toHaveBeenCalledTimes(1);
});
it('retires an old project preparation before it can adopt after switching projects',async()=>{
 const h=setup();await waitFor(()=>expect(h.view.result.current.state).not.toBeNull());
 const plan=await h.prepare();let release!:(value:typeof plan)=>void;h.prepare.mockImplementationOnce(()=>new Promise(resolve=>{release=resolve;}));
 let task!:Promise<boolean>;act(()=>{task=h.view.result.current.importLegacyCutHistory();});await waitFor(()=>expect(h.prepare).toHaveBeenCalledTimes(2));
 h.view.rerender({id:'b'});await act(async()=>{release(plan);expect(await task).toBe(false);});expect(h.adopt).not.toHaveBeenCalled();
});
