/** @vitest-environment jsdom */
import {act,cleanup,renderHook} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {useNativeNavigation} from './useNativeNavigation';
afterEach(()=>{cleanup();history.replaceState(null,'','/');});
it('changes projects without reloading and waits for drafts to save',async()=>{
 history.replaceState(null,'','/?project=a');const h=renderHook(()=>useNativeNavigation());
 let finish!:(ok:boolean)=>void;h.result.current.beforeLeave.current=vi.fn(()=>new Promise<boolean>(resolve=>{finish=resolve;}));
 const root=document.documentElement;let task!:Promise<boolean>;
 act(()=>{task=h.result.current.navigate('b');});expect(h.result.current.projectId).toBe('a');expect(location.search).toBe('?project=a');
 await act(async()=>{finish(true);expect(await task).toBe(true);});
 expect(h.result.current.projectId).toBe('b');expect(location.search).toBe('?project=b');expect(document.documentElement).toBe(root);
});
it('keeps the current project when a draft or save cannot be committed',async()=>{
 history.replaceState(null,'','/?project=a');const h=renderHook(()=>useNativeNavigation());
 h.result.current.beforeLeave.current=vi.fn(async()=>false);
 await act(async()=>{expect(await h.result.current.navigate('b')).toBe(false);});
 expect(h.result.current.projectId).toBe('a');expect(location.search).toBe('?project=a');
});
it('uses the same save guard for browser back and recovers the URL on failure',async()=>{
 history.replaceState(null,'','/?project=b');const h=renderHook(()=>useNativeNavigation());
 const guard=vi.fn(async()=>false);h.result.current.beforeLeave.current=guard;
 await act(async()=>{history.replaceState(null,'','/?project=a');window.dispatchEvent(new PopStateEvent('popstate'));});
 expect(guard).toHaveBeenCalledOnce();expect(h.result.current.projectId).toBe('b');expect(location.search).toBe('?project=b');
 guard.mockResolvedValue(true);
 await act(async()=>{history.replaceState(null,'','/?project=a');window.dispatchEvent(new PopStateEvent('popstate'));});
 expect(h.result.current.projectId).toBe('a');
});
