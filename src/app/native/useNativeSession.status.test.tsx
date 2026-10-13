/** @vitest-environment jsdom */
import {act,cleanup,renderHook,waitFor} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {useNativeSession} from './useNativeSession';
import type {NativeSession} from './api';
const channels=vi.hoisted(()=>new Map<string,(value:unknown)=>void>());
vi.mock('../eventBus',()=>({useEventChannel:(ch:string,fn:(value:unknown)=>void)=>channels.set(ch,fn)}));
afterEach(()=>{cleanup();vi.unstubAllGlobals();channels.clear();});
function setup(deferExternal=false){
  const state:NativeSession={sessionId:'one',document:{schemaVersion:2,id:'doc',name:'before',revision:0,fps:{num:30,den:1},resolution:{width:640,height:360},sequenceEndFrame:0,background:'#000',clips:[],tracks:[],assets:[],transitions:[],transcripts:[],ducking:{enabled:false,strength:'mid'}},
    savedRevision:0,savedContentHash:'saved',canUndo:false,canRedo:false,dirty:false};
  let status:unknown={unchanged:true,sessionId:'one'};const bodies:unknown[]=[];
  vi.stubGlobal('fetch',vi.fn(async(url:string,options?:RequestInit)=>{
    if(url.includes('/session/status'))bodies.push(JSON.parse(String(options?.body)));
    return {ok:true,json:async()=>url.includes('/session/status')?status:url.includes('/session')?state:{document:state.document}};
  }));
  const view=renderHook(()=>useNativeSession('a',deferExternal));
  return {view,state,bodies,setStatus:(next:unknown)=>{status=next;},event:async()=>{await act(async()=>{channels.get('sequence')?.({type:'change'});});}};
}
it('tells the server what the screen shows and keeps the same state object when nothing changed',async()=>{
  const h=setup();await waitFor(()=>expect(h.view.result.current.state).not.toBeNull());
  const before=h.view.result.current.state;await h.event();await waitFor(()=>expect(h.bodies.length).toBeGreaterThan(0));
  expect(h.bodies.at(-1)).toEqual({sessionId:'one',known:{revision:0,savedRevision:0,savedContentHash:'saved',canUndo:false,canRedo:false,historyError:null}});
  expect(h.view.result.current.state).toBe(before);
});
it('adopts the whole state when the server sends it',async()=>{
  const h=setup();await waitFor(()=>expect(h.view.result.current.state).not.toBeNull());
  h.setStatus({...h.state,document:{...h.state.document,revision:1,name:'AI edit'},dirty:true});await h.event();
  await waitFor(()=>expect(h.view.result.current.state?.document.name).toBe('AI edit'));
});
it('asks for the whole state while an external change is shown, so the clean reload keeps working',async()=>{
  const h=setup(true);await waitFor(()=>expect(h.view.result.current.state).not.toBeNull());
  h.setStatus({...h.state,externalChange:{savedRevision:1,contentHash:'new',summary:'changed'}});await h.event();
  await waitFor(()=>expect(h.view.result.current.state?.externalChange).toBeDefined());
  const count=h.bodies.length;await h.event();
  await waitFor(()=>expect(h.bodies.length).toBeGreaterThan(count));expect(h.bodies.at(-1)).toEqual({sessionId:'one'});
});
