/** @vitest-environment jsdom */
import {act,cleanup,renderHook,waitFor} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {useNativeSession} from './useNativeSession';
import type {NativeSession} from './api';
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
function setup(){
 const state:NativeSession={sessionId:'session-a',document:{schemaVersion:2,id:'a',name:'save',revision:4,fps:{num:30,den:1},resolution:{width:640,height:360},sequenceEndFrame:0,background:'#000',clips:[],tracks:[],assets:[],transitions:[],transcripts:[],ducking:{enabled:false,strength:'mid'}},savedRevision:3,savedContentHash:'old',dirty:true,canUndo:true,canRedo:false};
 const saved=()=>structuredClone({...state,savedRevision:4,savedContentHash:'new',dirty:false});
 const send=vi.fn(async()=>({ok:true,status:200,json:async()=>saved()}));
 const requests:Record<string,unknown>[]=[];
 vi.stubGlobal('fetch',vi.fn(async(url:string,options?:RequestInit)=>{
  const route=new URL(url,'http://localhost').pathname;
  if(route.endsWith('/save')){requests.push(JSON.parse(String(options?.body)));return send();}
  return {ok:true,json:async()=>route.endsWith('/session')?structuredClone(state):{document:state.document}};
 }));
 return {view:renderHook(({id})=>useNativeSession(id),{initialProps:{id:'a'}}),state,saved,send,requests};
}
it('updates saved metadata without rebuilding an unchanged document and preview',async()=>{
 const h=setup();await waitFor(()=>expect(h.view.result.current.state).not.toBeNull());const document=h.view.result.current.state!.document;
 await act(async()=>{expect(await h.view.result.current.save()).toBe(true);});
 expect(h.view.result.current.state).toMatchObject({savedRevision:4,savedContentHash:'new',dirty:false});
 expect(h.view.result.current.state!.document).toBe(document);
 act(()=>h.view.result.current.accept({...h.saved(),document:{...document,revision:5},dirty:true}));
 expect(h.view.result.current.state!.document).not.toBe(document);
});
it('coalesces saves and reaches 100 only after the response has been accepted',async()=>{
 const h=setup();await waitFor(()=>expect(h.view.result.current.state).not.toBeNull());
 let respond!:(value:Awaited<ReturnType<typeof h.send>>)=>void,decode!:(value:NativeSession)=>void;
 h.send.mockImplementationOnce(()=>new Promise(resolve=>{respond=resolve;}));
 let task!:Promise<boolean>;act(()=>{task=h.view.result.current.save();expect(h.view.result.current.save()).toBe(task);});
 await waitFor(()=>expect(h.send).toHaveBeenCalledOnce());expect(h.view.result.current.saveProgress).toBe(30);
 await act(async()=>{respond({ok:true,status:200,json:()=>new Promise(resolve=>{decode=resolve;})});});
 expect(h.view.result.current.saveProgress).toBe(80);expect(h.view.result.current.state!.dirty).toBe(true);
 await act(async()=>{decode(h.saved());expect(await task).toBe(true);});
 expect(h.view.result.current.saveProgress).toBe(100);expect(h.view.result.current.state!.dirty).toBe(false);
});
it('never reports completion on failure and retries an uncertain save with its original ID',async()=>{
 const h=setup();await waitFor(()=>expect(h.view.result.current.state).not.toBeNull());h.send.mockRejectedValueOnce(new TypeError('connection lost'));
 await act(async()=>{expect(await h.view.result.current.save()).toBe(false);});
 expect(h.view.result.current.saveProgress).toBeNull();expect(h.view.result.current.state!.dirty).toBe(true);
 await act(async()=>{expect(await h.view.result.current.save()).toBe(true);});
 expect(h.requests[1]).toEqual(h.requests[0]);expect(h.view.result.current.saveProgress).toBe(100);
});
it('retires old progress and responses when the project changes',async()=>{
 const h=setup();await waitFor(()=>expect(h.view.result.current.state).not.toBeNull());
 let respond!:(value:Awaited<ReturnType<typeof h.send>>)=>void;h.send.mockImplementationOnce(()=>new Promise(resolve=>{respond=resolve;}));
 let task!:Promise<boolean>;act(()=>{task=h.view.result.current.save();});await waitFor(()=>expect(h.send).toHaveBeenCalledOnce());
 h.view.rerender({id:'b'});await waitFor(()=>expect(h.view.result.current.loading).toBe(false));
 await act(async()=>{respond({ok:true,status:200,json:async()=>h.saved()});await task;});
 expect(h.view.result.current.saveProgress).toBeNull();expect(h.view.result.current.state!.dirty).toBe(true);expect(h.view.result.current.busy).toBe(false);
});
