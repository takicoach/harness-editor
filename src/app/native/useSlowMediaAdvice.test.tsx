/** @vitest-environment jsdom */
import {afterEach,expect,it,vi} from 'vitest';
import {act,cleanup,renderHook,waitFor} from '@testing-library/react';
import {MAX_COPY_ITEMS,type SlowMediaAdvice} from '../../shared/mediaCopy';
import {SLOW_ADVICE_REFRESH_MS,useSlowMediaAdvice} from './useSlowMediaAdvice';
import type {ReferenceStatus} from './useNativeReferenceStatus';
afterEach(()=>{cleanup();vi.unstubAllGlobals();vi.useRealTimers();});
const advice:SlowMediaAdvice={targets:[{assetId:'a',name:'a.mp4',sizeBytes:100,seconds:100},{assetId:'b',name:'b.mp4',sizeBytes:50,seconds:80}],totalBytes:150,totalSeconds:180,unmeasured:1};
function stub(answer:unknown=advice,suppress:(assetId:string)=>{ok:boolean;status?:number;json:unknown}=()=>({ok:true,json:{ok:true}})){
  const fetch=vi.fn(async(url:string,init?:RequestInit)=>{
    if(String(url).includes('/media-copy/suppress')){const result=suppress(JSON.parse(String(init!.body)).assetId);return {ok:result.ok,status:result.status??200,json:async()=>result.json};}
    return {ok:true,json:async()=>answer};});
  vi.stubGlobal('fetch',fetch);return fetch;
}
const suppressed=(fetch:ReturnType<typeof stub>)=>fetch.mock.calls.filter(([url])=>String(url).includes('/media-copy/suppress')).map(([,init])=>JSON.parse(String(init!.body)).assetId);

it('hides "今回はこのまま" targets until the page is closed, even after switching projects and back',async()=>{
  stub();const view=renderHook(({id})=>useSlowMediaAdvice(id,{a:{state:'checking'}},true),{initialProps:{id:'p1'}});
  await waitFor(()=>expect(view.result.current.advice?.targets).toHaveLength(2));
  act(()=>view.result.current.keepOnce(['a']));expect(view.result.current.advice).toMatchObject({targets:[{assetId:'b'}],totalBytes:50,totalSeconds:80,unmeasured:1});
  view.rerender({id:'p2'});expect(view.result.current.advice).toBeNull();   // 前の案件の案内は出さない
  await waitFor(()=>expect(view.result.current.advice?.targets).toHaveLength(2));
  view.rerender({id:'p1'});await waitFor(()=>expect(view.result.current.advice?.targets.map(target=>target.assetId)).toEqual(['b']));
});
it('"今後この場所では出さない" asks the server for each asset and hides them',async()=>{
  const fetch=stub(),view=renderHook(()=>useSlowMediaAdvice('p3',{a:{state:'checking'}},true));
  await waitFor(()=>expect(view.result.current.advice?.targets).toHaveLength(2));await act(()=>view.result.current.keepAlways(['a','b']));
  expect(suppressed(fetch)).toEqual(['a','b']);
  expect(view.result.current.advice?.targets).toEqual([]);
});
it('asks again every 5 seconds while an asset is still being checked or copied, and stops when none is',async()=>{
  vi.useFakeTimers();const fetch=stub(),view=renderHook(({statuses})=>useSlowMediaAdvice('p4',statuses,true),{initialProps:{statuses:{a:{state:'checking'}} as Record<string,ReferenceStatus>}});
  await act(async()=>{});expect(fetch).toHaveBeenCalledTimes(1);await act(async()=>{await vi.advanceTimersByTimeAsync(SLOW_ADVICE_REFRESH_MS);});expect(fetch).toHaveBeenCalledTimes(2);
  view.rerender({statuses:{a:{state:'ok'}}});await act(async()=>{});const calls=fetch.mock.calls.length;
  await act(async()=>{await vi.advanceTimersByTimeAsync(SLOW_ADVICE_REFRESH_MS*3);});expect(fetch.mock.calls.length).toBe(calls);
});

// ---- Task 6 のレビュー: ドライブを識別できない素材（canRemember:false）は「今後出さない」を記録できない ----
it('records "not again" only for the assets whose drive can be told apart, and keeps the others hidden for this time',async()=>{
  const fetch=stub({...advice,targets:[advice.targets[0]!,{...advice.targets[1]!,canRemember:false}]}),view=renderHook(()=>useSlowMediaAdvice('p5',{a:{state:'checking'}},true));
  await waitFor(()=>expect(view.result.current.advice?.targets).toHaveLength(2));await act(()=>view.result.current.keepAlways(['a','b']));
  expect(suppressed(fetch)).toEqual(['a']);expect(view.result.current.advice?.targets).toEqual([]);
});
it('keeps what was recorded hidden and the rest shown when recording fails part way, and passes the reason on',async()=>{
  const fetch=stub(advice,assetId=>assetId==='b'?{ok:false,status:409,json:{error:'素材のドライブを識別できないため、「今後この場所では出さない」を記録できません'}}:{ok:true,json:{ok:true}});
  const view=renderHook(()=>useSlowMediaAdvice('p6',{a:{state:'checking'}},true));
  await waitFor(()=>expect(view.result.current.advice?.targets).toHaveLength(2));
  let failure:unknown;await act(async()=>{await view.result.current.keepAlways(['a','b']).catch(error=>{failure=error;});});
  expect(suppressed(fetch)).toEqual(['a','b']);expect((failure as Error).message).toBe('素材のドライブを識別できないため、「今後この場所では出さない」を記録できません');
  expect(view.result.current.advice?.targets.map(target=>target.assetId)).toEqual(['b']);
});
it('does not ask while disabled or while the document has no linked asset, and ignores an answer of the wrong shape',async()=>{
  const fetch=stub({status:'unchanged'});
  const view=renderHook(({statuses,enabled})=>useSlowMediaAdvice('p7',statuses,enabled),{initialProps:{statuses:{} as Record<string,ReferenceStatus>,enabled:true}});
  await act(async()=>{});expect(fetch).not.toHaveBeenCalled();
  view.rerender({statuses:{a:{state:'checking'}},enabled:false});await act(async()=>{});expect(fetch).not.toHaveBeenCalled();
  view.rerender({statuses:{a:{state:'checking'}},enabled:true});await waitFor(()=>expect(fetch).toHaveBeenCalledTimes(1));await act(async()=>{});
  expect(view.result.current.advice).toBeNull();
});

// ---- Codex レビュー: 案内はコピーの上限（1回 50 本）までを並べ、残りは本数だけ伝える。並べた分を判断すると次の分が出る ----
it('lists at most the copy limit and counts the rest, which come next once the listed ones are decided',async()=>{
  const many=Array.from({length:MAX_COPY_ITEMS+1},(_,i)=>({assetId:`m${i}`,name:`m${i}.mp4`,sizeBytes:10,seconds:60}));
  stub({targets:many,totalBytes:10*many.length,totalSeconds:60*many.length,unmeasured:0});const view=renderHook(()=>useSlowMediaAdvice('p-many',{m0:{state:'checking'}},true));
  await waitFor(()=>expect(view.result.current.advice?.targets).toHaveLength(MAX_COPY_ITEMS));
  expect(view.result.current.advice).toMatchObject({more:1,totalBytes:10*MAX_COPY_ITEMS,totalSeconds:60*MAX_COPY_ITEMS});
  act(()=>view.result.current.keepOnce(view.result.current.advice!.targets.map(target=>target.assetId)));
  expect(view.result.current.advice).toMatchObject({targets:[{assetId:`m${MAX_COPY_ITEMS}`}],more:0,totalBytes:10});
});
