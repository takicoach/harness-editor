/** @vitest-environment jsdom */
import {act,cleanup,renderHook,waitFor} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import type {SequenceAsset} from '../../core/sequence/model';
import {referenceUnavailable,useNativeReferenceStatus} from './useNativeReferenceStatus';
const asset={id:'linked',file:'.harness/references/source.mp4'} as SequenceAsset;
afterEach(()=>{cleanup();vi.unstubAllGlobals();vi.useRealTimers();vi.restoreAllMocks();});
it('checks linked media, warns on disconnect, and reloads once on reconnection',async()=>{
 let state='ok';const fetch=vi.fn(async()=>({ok:true,json:async()=>({state})}));vi.stubGlobal('fetch',fetch);
 const recovered=vi.fn(),view=renderHook(()=>useNativeReferenceStatus('project',[asset,{id:'copy',file:'.harness/assets/copy.mp4'} as SequenceAsset],0,recovered));
 await waitFor(()=>expect(view.result.current.linked?.state).toBe('ok'));expect(fetch).toHaveBeenCalledTimes(1);
 state='missing';act(()=>window.dispatchEvent(new Event('focus')));await waitFor(()=>expect(view.result.current.linked?.state).toBe('missing'));
 state='ok';act(()=>window.dispatchEvent(new Event('focus')));await waitFor(()=>expect(view.result.current.linked?.state).toBe('ok'));expect(recovered).toHaveBeenCalledOnce();
 act(()=>window.dispatchEvent(new Event('focus')));await waitFor(()=>expect(fetch).toHaveBeenCalledTimes(4));expect(recovered).toHaveBeenCalledOnce();
});
it('detects a disconnected drive on the periodic check without changing focus',async()=>{
 vi.useFakeTimers();let state='ok';vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,json:async()=>({state})})));
 const view=renderHook(()=>useNativeReferenceStatus('project',[asset],0,vi.fn()));
 await act(async()=>{});expect(view.result.current.linked?.state).toBe('ok');state='missing';
 await act(async()=>{await vi.advanceTimersByTimeAsync(5000);});expect(view.result.current.linked?.state).toBe('missing');
});
it('discards a late response after switching projects',async()=>{
 let finish!:(response:unknown)=>void;vi.stubGlobal('fetch',vi.fn(()=>new Promise(r=>{finish=r;})));
 const view=renderHook(({id,assets})=>useNativeReferenceStatus(id,assets,0,vi.fn()),{initialProps:{id:'old',assets:[asset]}});
 view.rerender({id:'new',assets:[]});await act(async()=>finish({ok:true,json:async()=>({state:'missing'})}));expect(view.result.current).toEqual({});
});
// 照合中（checking）: サーバは中身の照合を裏で続けてすぐ答える。
it('shows checking, checks again after 2 seconds while checking (5 seconds otherwise), and reloads media when checking turns ok',async()=>{
 vi.useFakeTimers();let state='checking';const fetch=vi.fn(async()=>({ok:true,json:async()=>({state})}));vi.stubGlobal('fetch',fetch);
 const recovered=vi.fn(),view=renderHook(()=>useNativeReferenceStatus('project',[asset],0,recovered));
 await act(async()=>{});expect(view.result.current.linked?.state).toBe('checking');expect(fetch).toHaveBeenCalledTimes(1);
 await act(async()=>{await vi.advanceTimersByTimeAsync(2000);});expect(fetch).toHaveBeenCalledTimes(2);expect(recovered).not.toHaveBeenCalled();
 state='ok';await act(async()=>{await vi.advanceTimersByTimeAsync(2000);});expect(view.result.current.linked?.state).toBe('ok');expect(recovered).toHaveBeenCalledOnce();
 await act(async()=>{await vi.advanceTimersByTimeAsync(2000);});expect(fetch).toHaveBeenCalledTimes(3);   // ok だけなら 5 秒間隔
 await act(async()=>{await vi.advanceTimersByTimeAsync(3000);});expect(fetch).toHaveBeenCalledTimes(4);
});
it('treats a status request cut off after 15 seconds as still checking, and only server errors or problems as invalid',async()=>{
 const timeouts:{ms:number;controller:AbortController}[]=[];
 vi.spyOn(AbortSignal,'timeout').mockImplementation(ms=>{const controller=new AbortController();timeouts.push({ms,controller});return controller.signal;});
 // 答えが返らないまま、要求の 15 秒の打ち切りが来る
 vi.stubGlobal('fetch',vi.fn((_url:string,init:RequestInit)=>new Promise((_resolve,reject)=>{init.signal!.addEventListener('abort',()=>reject(init.signal!.reason),{once:true});})));
 const view=renderHook(()=>useNativeReferenceStatus('project',[asset],0,vi.fn()));
 await waitFor(()=>expect(timeouts).toHaveLength(1));expect(timeouts[0]!.ms).toBe(15000);
 act(()=>timeouts[0]!.controller.abort(new DOMException('時間切れ','TimeoutError')));
 await waitFor(()=>expect(view.result.current.linked?.state).toBe('checking'));
 vi.restoreAllMocks();
 const respond=(response:unknown)=>vi.stubGlobal('fetch',vi.fn(async()=>response));
 respond({ok:false,status:500,json:async()=>({})});act(()=>window.dispatchEvent(new Event('focus')));await waitFor(()=>expect(view.result.current.linked?.state).toBe('invalid'));
 respond({ok:true,json:async()=>({state:'checking'})});act(()=>window.dispatchEvent(new Event('focus')));await waitFor(()=>expect(view.result.current.linked?.state).toBe('checking'));
 respond({ok:true,json:async()=>({state:'mismatch',message:'参照素材の内容が保存時と一致しません'})});act(()=>window.dispatchEvent(new Event('focus')));await waitFor(()=>expect(view.result.current.linked).toEqual({state:'mismatch',message:'参照素材の内容が保存時と一致しません'}));
});
it('raises a link to invalid when its status request is cut off three times in a row (the drive itself does not answer), and counts again after an answer',async()=>{
 const timeouts:AbortController[]=[];
 vi.spyOn(AbortSignal,'timeout').mockImplementation(()=>{const controller=new AbortController();timeouts.push(controller);return controller.signal;});
 let answer:unknown=null;   // null: 答えないまま打ち切られる
 vi.stubGlobal('fetch',vi.fn((_url:string,init:RequestInit)=>answer?Promise.resolve(answer):new Promise((_resolve,reject)=>{init.signal!.addEventListener('abort',()=>reject(init.signal!.reason),{once:true});})));
 const view=renderHook(()=>useNativeReferenceStatus('project',[asset],0,vi.fn()));
 const slow={state:'checking',message:'素材の確認に時間がかかっています。'},silent={state:'invalid',message:'素材の接続を確認できません。ドライブの接続を確認してください。'};
 /** n 本目の要求を打ち切り（打ち切りの後始末まで流す）、表示を確かめる。 */
 const cutOff=async(n:number,expected:unknown)=>{await waitFor(()=>expect(timeouts.length).toBe(n));await act(async()=>{timeouts[n-1]!.abort(new DOMException('時間切れ','TimeoutError'));});
  expect(view.result.current.linked).toEqual(expected);};
 const focus=()=>act(async()=>{window.dispatchEvent(new Event('focus'));});
 await cutOff(1,slow);await focus();await cutOff(2,slow);await focus();await cutOff(3,silent);
 answer={ok:true,json:async()=>({state:'checking'})};await focus();expect(view.result.current.linked).toEqual({state:'checking'});
 answer=null;await focus();await cutOff(5,slow);   // 答えがあれば数え直す
});
it('keeps checking while the window is hidden only when a link is still being checked (so the server keeps its queued check)',async()=>{
 vi.useFakeTimers();let state='checking';const fetch=vi.fn(async()=>({ok:true,json:async()=>({state})}));vi.stubGlobal('fetch',fetch);
 const visibility=vi.spyOn(document,'visibilityState','get');
 const view=renderHook(()=>useNativeReferenceStatus('project',[asset],0,vi.fn()));
 await act(async()=>{});expect(view.result.current.linked?.state).toBe('checking');visibility.mockReturnValue('hidden');
 await act(async()=>{await vi.advanceTimersByTimeAsync(2000);});expect(fetch).toHaveBeenCalledTimes(2);
 state='ok';await act(async()=>{await vi.advanceTimersByTimeAsync(2000);});expect(fetch).toHaveBeenCalledTimes(3);
 await act(async()=>{await vi.advanceTimersByTimeAsync(10000);});expect(fetch).toHaveBeenCalledTimes(3);   // 照合中が無くなれば、隠れている間は確かめない
});
// コピー中（copying）: 速いドライブへコピーしている（設計 §5）。エラーにせず、バナーにも数えない（表示は Task 14）。
it('takes copying as a state of its own, not an error and not unavailable',async()=>{
 vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,json:async()=>({state:'copying',message:'速いドライブへコピーしています'})})));
 const view=renderHook(()=>useNativeReferenceStatus('project',[asset],0,vi.fn()));
 await waitFor(()=>expect(view.result.current.linked?.state).toBe('copying'));
 expect(referenceUnavailable(view.result.current.linked)).toBe(false);expect(referenceUnavailable({state:'checking'})).toBe(false);expect(referenceUnavailable({state:'missing'})).toBe(true);
});
// コピー中（copying）: 速いドライブへコピーしている。接続の問題ではない（設計 §5）。
// 素材の読み直しはコピーの作業の終わりにまとめて1回（useMediaCopyJobs）。1本ごとの コピー中→ok では読み直さない（プレビュー・タイムラインを作り直さない）。
it('treats copying like checking: not a connection problem, checked again after 2 seconds; turning ok leaves the reload to the end of the copy job',async()=>{
 vi.useFakeTimers();let state='copying';const fetch=vi.fn(async()=>({ok:true,json:async()=>({state})}));vi.stubGlobal('fetch',fetch);
 const recovered=vi.fn(),view=renderHook(()=>useNativeReferenceStatus('project',[asset],0,recovered));
 await act(async()=>{});expect(view.result.current.linked?.state).toBe('copying');expect(referenceUnavailable(view.result.current.linked)).toBe(false);
 await act(async()=>{await vi.advanceTimersByTimeAsync(2000);});expect(fetch).toHaveBeenCalledTimes(2);
 state='ok';await act(async()=>{await vi.advanceTimersByTimeAsync(2000);});expect(view.result.current.linked?.state).toBe('ok');expect(recovered).not.toHaveBeenCalled();
 state='missing';await act(async()=>{await vi.advanceTimersByTimeAsync(5000);});state='ok';await act(async()=>{await vi.advanceTimersByTimeAsync(5000);});expect(recovered).toHaveBeenCalledOnce();   // 未接続から戻った時は今まで通り
});
it('does not keep checking while the window is hidden only because a link is being copied',async()=>{
 vi.useFakeTimers();const fetch=vi.fn(async()=>({ok:true,json:async()=>({state:'copying'})}));vi.stubGlobal('fetch',fetch);
 const visibility=vi.spyOn(document,'visibilityState','get');
 const view=renderHook(()=>useNativeReferenceStatus('project',[asset],0,vi.fn()));
 await act(async()=>{});expect(view.result.current.linked?.state).toBe('copying');visibility.mockReturnValue('hidden');
 await act(async()=>{await vi.advanceTimersByTimeAsync(10000);});expect(fetch).toHaveBeenCalledTimes(1);
});
