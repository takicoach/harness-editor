import {describe,it,expect,vi,afterEach} from 'vitest';
import {createNativeProject,uploadNativeAsset} from './api';
import type {TransferProgress} from '../components/TaskProgress';
afterEach(()=>vi.unstubAllGlobals());
function request(){
  let xhr:any;
  vi.stubGlobal('XMLHttpRequest',class {upload:any={};status=200;response:any;open=vi.fn();send=vi.fn();constructor(){xhr=this;}});
  return ()=>xhr;
}
describe('native transfer progress',()=>{
  it('reports measured upload bytes then an unmeasured preparation stage until the server replies',async()=>{
    const get=request(),updates:TransferProgress[]=[];
    const promise=createNativeProject('実写',new File(['abcdefgh'],'撮影.mp4'),p=>updates.push(p));
    const xhr=get();expect(updates).toEqual([{phase:'uploading',loaded:0,total:8}]);
    xhr.upload.onprogress({loaded:4,total:8,lengthComputable:true});expect(updates.at(-1)).toEqual({phase:'uploading',loaded:4,total:8});
    xhr.upload.onload();expect(updates.at(-1)).toEqual({phase:'preparing'});
    xhr.response={id:'new-project'};xhr.onload();await expect(promise).resolves.toEqual({id:'new-project'});
  });
  it('does not fabricate a total when the browser cannot measure it and preserves server errors',async()=>{
    const get=request(),updates:TransferProgress[]=[];
    const promise=uploadNativeAsset('p',new File(['音'],'bgm.wav'),p=>updates.push(p));
    get().upload.onprogress({loaded:3,total:0,lengthComputable:false});expect(updates.at(-1)).toEqual({phase:'uploading',loaded:3});
    get().status=400;get().response={error:'音声を確認してください'};get().onload();await expect(promise).rejects.toThrow('音声を確認してください');
  });
});
