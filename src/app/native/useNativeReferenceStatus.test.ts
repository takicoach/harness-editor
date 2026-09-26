/** @vitest-environment jsdom */
import {act,cleanup,renderHook,waitFor} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import type {SequenceAsset} from '../../core/sequence/model';
import {useNativeReferenceStatus} from './useNativeReferenceStatus';
const asset={id:'linked',file:'.harness/references/source.mp4'} as SequenceAsset;
afterEach(()=>{cleanup();vi.unstubAllGlobals();vi.useRealTimers();});
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
