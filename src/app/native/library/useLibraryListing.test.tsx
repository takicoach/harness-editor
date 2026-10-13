/** @vitest-environment jsdom */
import {act,cleanup,renderHook,waitFor} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {useLibraryListing} from './libraryApi';
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
const stub=()=>{const f=vi.fn(async()=>({ok:true,status:200,json:async()=>({ok:false,directory:'d',reason:'r'})}));vi.stubGlobal('fetch',f);return f;};
it('does not fetch until first shown, then fetches once and on reload',async()=>{
 const f=stub();
 const v=renderHook((p:{a:boolean})=>useLibraryListing(p.a),{initialProps:{a:false}});
 expect(f).not.toHaveBeenCalled();
 v.rerender({a:true});await waitFor(()=>expect(v.result.current.listing).not.toBeNull());expect(f).toHaveBeenCalledTimes(1);
 v.rerender({a:false});v.rerender({a:true});expect(f).toHaveBeenCalledTimes(1);
 act(()=>v.result.current.reload());await waitFor(()=>expect(f).toHaveBeenCalledTimes(2));
});
