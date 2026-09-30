/** @vitest-environment jsdom */
import {act,cleanup,renderHook,waitFor} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {useNativeSession} from './useNativeSession';
import type {NativeSession} from './api';
const channels=vi.hoisted(()=>new Map<string,(value:unknown)=>void>());
vi.mock('../eventBus',()=>({useEventChannel:(ch:string,fn:(value:unknown)=>void)=>channels.set(ch,fn)}));
afterEach(()=>{cleanup();vi.unstubAllGlobals();channels.clear();});
function setup(dirty=false){
 const state:NativeSession={sessionId:'one',document:{schemaVersion:2,id:'doc',name:'before',revision:0,fps:{num:30,den:1},resolution:{width:640,height:360},sequenceEndFrame:0,background:'#000',clips:[],tracks:[],assets:[],transitions:[],transcripts:[],ducking:{enabled:false,strength:'mid'}},savedRevision:0,savedContentHash:'old',dirty,canUndo:false,canRedo:false};
 let status=structuredClone(state);
 const fetch=vi.fn(async(url:string,_options?:RequestInit)=>({ok:true,json:async()=>url.includes('/session/status')?status:url.includes('/session/reload')?{...state,sessionId:'two',savedRevision:1,savedContentHash:'new',document:{...state.document,revision:1,name:'external'}}:url.includes('/session')?state:{document:state.document}}));
 vi.stubGlobal('fetch',fetch);
 const view=renderHook<ReturnType<typeof useNativeSession>,{blocked:boolean;id?:string}>(({blocked,id})=>useNativeSession(id??'a',blocked),{initialProps:{blocked:false}});
 return {view,state,fetch,setStatus:(next:NativeSession)=>{status=next;},event:async(ch:string)=>{await act(async()=>{channels.get(ch)?.({type:'change'});});}};
}
it('reflects an AI command on notification without waiting for the polling interval',async()=>{
 const h=setup();await waitFor(()=>expect(h.view.result.current.state).not.toBeNull());
 h.setStatus({...h.state,document:{...h.state.document,revision:1,name:'AI edit'},dirty:true});
 await h.event('sequence');
 await waitFor(()=>expect(h.view.result.current.state?.document.name).toBe('AI edit'),{timeout:700});
});
it('adopts a clean external save in place, with an atomic clean-session guard',async()=>{
 const h=setup();await waitFor(()=>expect(h.view.result.current.state).not.toBeNull());
 h.setStatus({...h.state,externalChange:{savedRevision:1,contentHash:'new',summary:'changed'}});
 await h.event('watch');
 await waitFor(()=>expect(h.view.result.current.state?.document.name).toBe('external'),{timeout:700});
 expect(h.fetch.mock.calls.some(([url])=>url.includes('/session/reload'))).toBe(true);
 expect(JSON.parse(String(h.fetch.mock.calls.find(([url])=>url.includes('/session/reload'))![1]?.body))).toMatchObject({onlyIfClean:true,sessionId:'one',expectedRevision:0,contentHash:'new'});
});
it('ignores a delayed status response after changing projects',async()=>{
 const h=setup();await waitFor(()=>expect(h.view.result.current.state).not.toBeNull());
 let respond!:(value:NativeSession)=>void;
 h.fetch.mockImplementationOnce(async()=>({ok:true,json:()=>new Promise<NativeSession>(resolve=>{respond=resolve;})}));
 await h.event('sequence');
 h.view.rerender({blocked:false,id:'b'});await waitFor(()=>expect(h.view.result.current.loading).toBe(false));
 await act(async()=>{respond({...h.state,document:{...h.state.document,revision:3,name:'old project'}});});
 expect(h.view.result.current.state?.document.name).toBe('before');
});
it('recovers from a partial disk write without retaining a stale synchronization error',async()=>{
 const h=setup();await waitFor(()=>expect(h.view.result.current.state).not.toBeNull());
 h.fetch.mockRejectedValueOnce(new Error('incomplete JSON'));await h.event('watch');
 expect(h.view.result.current.error).toBe('incomplete JSON');expect(h.view.result.current.state?.document.name).toBe('before');
 await h.event('watch');expect(h.view.result.current.error).toBeNull();
});
it('keeps unsaved changes and reports the external save instead of discarding them',async()=>{
 const h=setup(true);await waitFor(()=>expect(h.view.result.current.state).not.toBeNull());
 h.setStatus({...h.state,externalChange:{savedRevision:1,contentHash:'new',summary:'changed'}});
 await h.event('watch');
 await waitFor(()=>expect(h.view.result.current.state?.externalChange).toBeDefined(),{timeout:700});
 expect(h.view.result.current.state?.document.name).toBe('before');
 expect(h.fetch.mock.calls.some(([url])=>url.includes('/session/reload'))).toBe(false);
});
it('defers external updates during a field draft and catches up when it ends',async()=>{
 const h=setup();await waitFor(()=>expect(h.view.result.current.state).not.toBeNull());
 h.view.rerender({blocked:true});h.setStatus({...h.state,externalChange:{savedRevision:1,contentHash:'new',summary:'changed'}});
 await h.event('watch');expect(h.view.result.current.state?.document.name).toBe('before');
 h.view.rerender({blocked:false});
 await waitFor(()=>expect(h.view.result.current.state?.document.name).toBe('external'),{timeout:700});
});
// 図形位置の実操作監査（dirty-position-*）の回帰: 入力中もこのセッション内のコマンド（AI/API・別タブ）は
// 読み込む。調整パネルは入力途中の値を新しい版の上に載せ直す。保留するのは外部保存の読み直しだけ。
it('keeps reading same-session command updates during a field draft; only an external save waits',async()=>{
 const h=setup();await waitFor(()=>expect(h.view.result.current.state).not.toBeNull());
 h.view.rerender({blocked:true});
 h.setStatus({...h.state,document:{...h.state.document,revision:1,name:'command'}});
 await h.event('sequence');
 await waitFor(()=>expect(h.view.result.current.state?.document.name).toBe('command'),{timeout:700});
 h.setStatus({...h.state,document:{...h.state.document,revision:1,name:'command'},externalChange:{savedRevision:1,contentHash:'new',summary:'changed'}});
 const before=h.fetch.mock.calls.length;
 await h.event('watch');await new Promise(resolve=>setTimeout(resolve,300));
 expect(h.fetch.mock.calls.some(([url])=>String(url).includes('/session/reload'))).toBe(false);
 expect(h.fetch.mock.calls.length-before,'保留中に状態確認を空回りさせない').toBeLessThanOrEqual(2);
 h.view.rerender({blocked:false});
 await waitFor(()=>expect(h.view.result.current.state?.document.name).toBe('external'),{timeout:700});
});
