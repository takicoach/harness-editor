/** @vitest-environment jsdom */
import {act,cleanup,renderHook,waitFor} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {useNativeSession} from './useNativeSession';
import type {NativeSession} from './api';
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
type Reply={status:number;json:unknown}|(()=>never);
const ASSET={id:'asset-1',kind:'media'} as never;
function setup(opts:{place:Reply[];status?:(revision:number)=>NativeSession;prepareGate?:Promise<void>}){
 const doc=(revision:number)=>({schemaVersion:2,id:'a',name:'x',revision,fps:{num:30,den:1},resolution:{width:640,height:360},sequenceEndFrame:0,background:'#000',clips:[],tracks:[],assets:[],transitions:[],transcripts:[],ducking:{enabled:false,strength:'mid'}});
 const session=(revision:number)=>({sessionId:'session-a',document:doc(revision),savedRevision:revision,savedContentHash:'h',dirty:false,canUndo:true,canRedo:false}) as unknown as NativeSession;
 const places:any[]=[],routes:string[]=[],queue=[...opts.place];
 vi.stubGlobal('fetch',vi.fn(async(url:string,options?:RequestInit)=>{
  const route=new URL(url,'http://localhost').pathname.replace('/api/sequence','');routes.push(route);
  if(route==='/library/prepare'){await opts.prepareGate;return {ok:true,status:200,json:async()=>({asset:ASSET})};}
  if(route==='/library/place'){places.push(JSON.parse(String(options?.body)));const r=queue.shift()!;if(typeof r==='function')r();const x=r as {status:number;json:unknown};return {ok:x.status<400,status:x.status,json:async()=>x.json};}
  if(route==='/session/status')return {ok:true,status:200,json:async()=>session(12)};
  return {ok:true,status:200,json:async()=>session(9)};
 }));
 return {places,routes,session,view:renderHook((props:{id:string})=>useNativeSession(props.id),{initialProps:{id:'p'}})};
}
async function ready(h:ReturnType<typeof setup>){await waitFor(()=>expect(h.view.result.current.state).not.toBeNull());}
const built=(doc:{revision:number})=>({commands:[{type:'noop'}] as never,selectId:`clip-r${doc.revision}`});

it('prepares, builds from the latest document and places',async()=>{
 const ok={status:200,json:null as unknown};
 const h2=setup({place:[ok]});await ready(h2);ok.json=h2.session(10);
 const build=vi.fn((doc:{revision:number})=>built(doc));let r;
 await act(async()=>{r=await h2.view.result.current.placeFromLibrary('k',build as never);});
 expect(r).toEqual({ok:true,selectId:'clip-r9'});expect(build).toHaveBeenCalledTimes(1);
 expect(h2.places[0]).toMatchObject({sessionId:'session-a',expectedRevision:9,keys:['k']});expect(h2.view.result.current.state?.document.revision).toBe(10);
});
it('on 409 refreshes the status, rebuilds once with a new executionId',async()=>{
 const ok={status:200,json:null as unknown};
 const h=setup({place:[{status:409,json:{error:'古い版です'}},ok]});await ready(h);ok.json=h.session(13);
 const build=vi.fn((doc:{revision:number})=>built(doc));let r;
 await act(async()=>{r=await h.view.result.current.placeFromLibrary('k',build as never);});
 expect(r).toEqual({ok:true,selectId:'clip-r12'});expect(build).toHaveBeenCalledTimes(2);
 expect(h.routes).toContain('/session/status');expect(h.places).toHaveLength(2);
 expect(h.places[1].executionId).not.toBe(h.places[0].executionId);expect(h.places[1].expectedRevision).toBe(12);
});
it('returns the reason when the second attempt also conflicts',async()=>{
 const h=setup({place:[{status:409,json:{error:'古い版です'}},{status:409,json:{error:'また古い版です'}}]});await ready(h);
 let r;await act(async()=>{r=await h.view.result.current.placeFromLibrary('k',((d:{revision:number})=>built(d)) as never);});
 expect(r).toEqual({ok:false,message:'また古い版です'});expect(h.places).toHaveLength(2);expect(h.view.result.current.error).toBeNull();
});
it('does not resend on a non-409 failure',async()=>{
 const h=setup({place:[{status:400,json:{error:'不正'}}]});await ready(h);
 let r;await act(async()=>{r=await h.view.result.current.placeFromLibrary('k',((d:{revision:number})=>built(d)) as never);});
 expect(r).toEqual({ok:false,message:'不正'});expect(h.places).toHaveLength(1);expect(h.routes).not.toContain('/session/status');
});
it('does not send when build returns an error',async()=>{
 const h=setup({place:[]});await ready(h);
 let r;await act(async()=>{r=await h.view.result.current.placeFromLibrary('k',(()=>({error:'置けません'})) as never);});
 expect(r).toEqual({ok:false,message:'置けません'});expect(h.places).toHaveLength(0);expect(h.view.result.current.error).toBeNull();
});
it('resends with the same executionId after a lost response',async()=>{
 const ok={status:200,json:null as unknown};
 const h=setup({place:[(()=>{throw new TypeError('Failed to fetch');}) as never,ok]});await ready(h);ok.json=h.session(10);
 const build=vi.fn((doc:{revision:number})=>built(doc));let r;
 await act(async()=>{r=await h.view.result.current.placeFromLibrary('k',build as never);});
 expect(r).toMatchObject({ok:true});expect(h.places).toHaveLength(2);expect(h.places[1].executionId).toBe(h.places[0].executionId);expect(build).toHaveBeenCalledTimes(1);
});
it('aborts without placing when the project changes while preparing',async()=>{
 let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});
 const h=setup({place:[{status:200,json:{}}],prepareGate:gate});await ready(h);
 let pending!:Promise<unknown>;
 await act(async()=>{pending=h.view.result.current.placeFromLibrary('k',((d:{revision:number})=>built(d)) as never);});
 h.view.rerender({id:'q'});await ready(h);
 let r;await act(async()=>{release();r=await pending;});
 expect(r).toEqual({ok:false,message:'案件が切り替わったため配置を中止しました'});expect(h.places).toHaveLength(0);
});
it('reports a reason when there is no edit data',async()=>{
 const h=setup({place:[]});
 let r;await act(async()=>{r=await h.view.result.current.placeFromLibrary('k',((d:{revision:number})=>built(d)) as never);});
 expect(r).toMatchObject({ok:false});expect((r as unknown as {message:string}).message).not.toBe('');expect(h.places).toHaveLength(0);
});
it('does not send when the guard returns a reason',async()=>{
 const h=setup({place:[]});await ready(h);
 let r;await act(async()=>{r=await h.view.result.current.placeFromLibrary('k',((d:{revision:number})=>built(d)) as never,()=>'試し中です');});
 expect(r).toEqual({ok:false,message:'試し中です'});expect(h.places).toHaveLength(0);
});
