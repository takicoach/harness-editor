/** @vitest-environment jsdom */
import {afterEach,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,renderHook,screen,waitFor} from '@testing-library/react';
import {File as NodeFile} from 'node:buffer';
import {useNativeFileReference} from './useNativeFileReference';
vi.mock('../panels/MediaPicker',()=>({MediaPicker:(p:any)=><section aria-label="location"><button onClick={()=>p.onPick({path:'/chosen/source.mp4'})}>choose original</button><button onClick={p.onCancel}>cancel location</button></section>}));
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
function fixture(){
 vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,json:async()=>({matched:false,reason:'ambiguous'})})));
 const resolved=vi.fn(),rejected=vi.fn(),source=new NodeFile(['content'],'source.mp4') as unknown as File;
 function Harness(){const ref=useNativeFileReference();return <><button onClick={()=>{void ref.resolve(source).then(resolved,rejected);}}>drop file</button>{ref.picker}</>;}
 return {resolved,rejected,...render(<Harness/>)};
}
it('cancels a location choice without returning a stale path, and permits a new attempt',async()=>{
 const v=fixture();fireEvent.click(screen.getByText('drop file'));await screen.findByLabelText('location');
 fireEvent.click(screen.getByText('cancel location'));await waitFor(()=>expect(v.rejected).toHaveBeenCalledOnce());expect(v.resolved).not.toHaveBeenCalled();expect(screen.queryByLabelText('location')).toBeNull();
 fireEvent.click(screen.getByText('drop file'));await screen.findByLabelText('location');fireEvent.click(screen.getByText('choose original'));
 await waitFor(()=>expect(v.resolved).toHaveBeenCalledOnce());expect(v.resolved.mock.calls[0]![0].path).toBe('/chosen/source.mp4');
});
it('retires a pending location choice when leaving the project',async()=>{
 const v=fixture();fireEvent.click(screen.getByText('drop file'));await screen.findByLabelText('location');v.unmount();
 await act(async()=>{});expect(v.rejected).toHaveBeenCalledOnce();expect(v.resolved).not.toHaveBeenCalled();
});
it('refuses a stale resolve call that starts only after leaving the project',async()=>{
 const fetch=vi.fn(async()=>({ok:true,json:async()=>({matched:true,path:'/old/source.mp4'})}));vi.stubGlobal('fetch',fetch);
 const view=renderHook(()=>useNativeFileReference()),staleResolve=view.result.current.resolve;view.unmount();
 const source=new NodeFile(['content'],'source.mp4') as unknown as File;
 await expect(staleResolve(source)).rejects.toMatchObject({name:'AbortError'});expect(fetch).not.toHaveBeenCalled();
});
