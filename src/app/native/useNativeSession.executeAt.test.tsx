/** @vitest-environment jsdom */
import {act,cleanup,renderHook,waitFor} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {useNativeSession} from './useNativeSession';
import type {NativeSession} from './api';
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
type Reply=(body:any)=>{status:number;json:unknown}|never;
function setup(...replies:Reply[]){
 const state:NativeSession={sessionId:'session-a',document:{schemaVersion:2,id:'a',name:'x',revision:9,fps:{num:30,den:1},resolution:{width:640,height:360},sequenceEndFrame:0,background:'#000',clips:[],tracks:[],assets:[],transitions:[],transcripts:[],ducking:{enabled:false,strength:'mid'}},savedRevision:9,savedContentHash:'h',dirty:false,canUndo:true,canRedo:false};
 const bodies:any[]=[],queue=[...replies];
 vi.stubGlobal('fetch',vi.fn(async(url:string,options?:RequestInit)=>{
  const route=new URL(url,'http://localhost').pathname;
  if(route.endsWith('/command')){const body=JSON.parse(String(options?.body));bodies.push(body);const r=queue.shift()!(body);return {ok:r.status<400,status:r.status,json:async()=>r.json};}
  return {ok:true,json:async()=>route.endsWith('/session')?structuredClone(state):{document:state.document}};
 }));
 const okSession=(revision:number)=>({status:200,json:{...structuredClone(state),document:{...state.document,revision}}});
 return {bodies,okSession,view:renderHook(()=>useNativeSession('p'))};
}
const base={sessionId:'session-a',revision:3};
async function ready(h:ReturnType<typeof setup>){await waitFor(()=>expect(h.view.result.current.state).not.toBeNull());}
it('sends at the base revision, not the latest one',async()=>{
 const h=setup(()=>h.okSession(10));await ready(h);
 let outcome;await act(async()=>{outcome=await h.view.result.current.executeAt({type:'undo'},base);});
 expect(outcome).toBe('ok');expect(h.view.result.current.state?.document.revision).toBe(10);expect(h.bodies).toHaveLength(1);expect(h.bodies[0]).toMatchObject({sessionId:'session-a',expectedRevision:3,command:{type:'undo'}});
});
it('returns conflict on 409',async()=>{
 const h=setup(()=>({status:409,json:{error:'古い版です'}}));await ready(h);
 let outcome;await act(async()=>{outcome=await h.view.result.current.executeAt({type:'undo'},base);});
 expect(outcome).toBe('conflict');expect(h.bodies).toHaveLength(1);
 // 実ブラウザ監査（Task 6）: 共有のエラーに 409 の文言が入ると、画面は session.error を知らせより先に出すため、
 // 試しの「内容が更新されたため採用できませんでした…」が隠れていた。conflict の文言は呼び出し側（useTrialSwap）が出す。
 expect(h.view.result.current.error).toBeNull();
});
it('returns failed on a non-409 API error without resending',async()=>{
 const h=setup(()=>({status:400,json:{error:'不正'}}));await ready(h);
 let outcome;await act(async()=>{outcome=await h.view.result.current.executeAt({type:'undo'},base);});
 expect(outcome).toBe('failed');expect(h.bodies).toHaveLength(1);expect(h.view.result.current.error).toContain('不正');
});
it('resends once with the same execution ID after a lost response',async()=>{
 const h=setup(()=>{throw new TypeError('Failed to fetch');},()=>h.okSession(10));await ready(h);
 let outcome;await act(async()=>{outcome=await h.view.result.current.executeAt({type:'undo'},base);});
 expect(outcome).toBe('ok');expect(h.bodies).toHaveLength(2);
 expect(h.view.result.current.state?.document.revision).toBe(10);expect(h.bodies[1].executionId).toBe(h.bodies[0].executionId);expect(h.bodies[0].expectedRevision).toBe(3);expect(h.bodies[1].expectedRevision).toBe(3);
});
it('returns unknown when both attempts get no response',async()=>{
 const h=setup(()=>{throw new TypeError('Failed to fetch');},()=>{throw new TypeError('Failed to fetch');});await ready(h);
 let outcome;await act(async()=>{outcome=await h.view.result.current.executeAt({type:'undo'},base);});
 expect(outcome).toBe('unknown');expect(h.bodies).toHaveLength(2);
 // conflict と同じ理由で、unknown の案内（「採用できたか確認できませんでした…」）は呼び出し側が出す。通信の生の文言で隠さない。
 expect(h.view.result.current.error).toBeNull();
});
it('returns cancelled without sending when the project changes before the work runs',async()=>{
 const h=setup(()=>h.okSession(10));await ready(h);
 let outcome;await act(async()=>{const pending=h.view.result.current.executeAt({type:'undo'},base);h.view.unmount();outcome=await pending;});
 expect(outcome).toBe('cancelled');expect(h.bodies).toHaveLength(0);
});
it('refreshStatus re-reads the session status right after an unknown result, so a command the server applied shows up',async()=>{
 const h=setup(()=>{throw new TypeError('Failed to fetch');},()=>{throw new TypeError('Failed to fetch');});await ready(h);
 const fetchMock=vi.mocked(fetch),inner=fetchMock.getMockImplementation()!;
 const statuses:string[]=[];
 fetchMock.mockImplementation(async(url:any,options?:RequestInit)=>{
  if(new URL(String(url),'http://localhost').pathname.endsWith('/session/status')){statuses.push('status');return {ok:true,status:200,json:async()=>h.okSession(10).json} as never;}
  return inner(url,options);
 });
 let outcome;
 await act(async()=>{outcome=await h.view.result.current.executeAt({type:'undo'},base);await h.view.result.current.refreshStatus();});
 expect(outcome).toBe('unknown');
 await waitFor(()=>expect(h.view.result.current.state?.document.revision).toBe(10),{timeout:500});
 expect(statuses.length).toBeGreaterThan(0);
});
