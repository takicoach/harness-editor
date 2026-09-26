import { describe, it, expect, vi, afterEach } from 'vitest';
import { defaultProjectName } from './createProjectApi';
import { createNativeProject, NativeApiError } from './native/api';

afterEach(()=>vi.restoreAllMocks());
const FILE=new File(['x'],'take & 1.mp4',{type:'video/mp4'});
function reply(body:unknown,status=200){
  return vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}}));
}
describe('native creation client used by both home screens',()=>{
  it('uploads the file with an explicit native contract and encoded names',async()=>{
    const fetch=reply({id:'native-id'});expect(await createNativeProject('新作 & 1',FILE)).toEqual({id:'native-id'});
    const [raw,init]=fetch.mock.calls[0]!,url=new URL(String(raw),'http://localhost');
    expect(url.pathname).toBe('/api/create-project');expect(url.searchParams.get('native')).toBe('1');
    expect(url.searchParams.get('name')).toBe('新作 & 1');expect(url.searchParams.get('video')).toBe(FILE.name);
    expect(init).toMatchObject({method:'POST',body:FILE});expect(url.searchParams.has('copy')).toBe(false);
  });
  it('submits a local path for managed import without upload data',async()=>{
    const fetch=reply({id:'local-id'}),path='/Volumes/My SSD/元 & 動画.mp4';
    expect(await createNativeProject('local',path)).toEqual({id:'local-id'});
    const [raw,init]=fetch.mock.calls[0]!,url=new URL(String(raw),'http://localhost');
    expect(url.pathname).toBe('/api/create-project-link');expect(url.searchParams.get('native')).toBe('1');
    expect(url.searchParams.get('path')).toBe(path);expect(init?.method).toBe('POST');expect(init?.body).toBeUndefined();
  });
  it('preserves a rejected creation message and status',async()=>{
    reply({error:'同じ名前が存在します'},409);
    await expect(createNativeProject('existing',FILE)).rejects.toMatchObject({message:'同じ名前が存在します',status:409});
  });
  it('provides a fallback for an error JSON without an explanation',async()=>{
    reply({},422);await expect(createNativeProject('bad',FILE)).rejects.toBeInstanceOf(NativeApiError);
  });
});
describe('defaultProjectName',()=>{
  it('日付とファイル名（拡張子なし）から初期値を作る',()=>{
    expect(defaultProjectName('DJI_0688.mp4',new Date(2026,6,10))).toBe('2026-07-10-DJI_0688');
  });
});
