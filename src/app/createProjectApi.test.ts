import { describe, it, expect, vi, afterEach } from 'vitest';
import { defaultProjectName, uniqueFolderProjectNames,uniqueProjectNames } from './createProjectApi';
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

it('makes one name per video: dated, at most 80 characters, numbered when it repeats an existing or earlier name',()=>{
  const now=new Date(2026,10,4),long='あ'.repeat(100)+'.mp4';
  const names=uniqueProjectNames(['a.mp4','a.mov','b.mp4',long],['2026-11-04-b'],now);
  expect(names.slice(0,3)).toEqual(['2026-11-04-a','2026-11-04-a (2)','2026-11-04-b (2)']);
  expect(names[3]!.length).toBe(80);expect(names[3]!.startsWith('2026-11-04-あ')).toBe(true);
});
it('keeps the number inside the 80 characters when a long name repeats',()=>{
  const now=new Date(2026,10,4),long='あ'.repeat(100)+'.mp4',[first,second]=uniqueProjectNames([long,long],[],now);
  expect(second!.length).toBe(80);expect(second!.endsWith(' (2)')).toBe(true);expect(second).not.toBe(first);
});
it('avoids characters the server refuses in a project name',()=>{
  expect(uniqueProjectNames(['take..1.mp4','a\\b.mp4'],[],new Date(2026,10,4))).toEqual(['2026-11-04-take.1','2026-11-04-a_b']);
});

describe('uniqueProjectNames: 大文字と小文字だけの違い', () => {
  const now = new Date(2026, 10, 7);
  // Mac と Windows の標準のフォルダは大文字と小文字を区別しないので、別の名前のつもりでも同じ保存先になり、2 本目が重複で断られる。
  it('同じ回の動画が大文字と小文字だけ違っても番号を付ける', () => {
    expect(uniqueProjectNames(['Clip.mp4', 'clip.mov'], [], now)).toEqual(['2026-11-07-Clip', '2026-11-07-clip (2)']);
  });
  it('既存のプロジェクトと大文字と小文字だけ違っても番号を付ける', () => {
    expect(uniqueProjectNames(['clip.mp4'], ['2026-11-07-CLIP'], now)).toEqual(['2026-11-07-clip (2)']);
  });
});

describe('uniqueFolderProjectNames',()=>{
  it('uses the folder name as it is, without a date or trimming what looks like an extension',()=>{
    expect(uniqueFolderProjectNames(['撮影','v1.2'],[])).toEqual(['撮影','v1.2']);
  });
  it('numbers names that overlap, ignoring case',()=>{
    expect(uniqueFolderProjectNames(['Trip','trip','既存'],['既存'])).toEqual(['Trip','trip (2)','既存 (2)']);
  });
  it('replaces characters the server refuses and keeps to 80 characters',()=>{
    expect(uniqueFolderProjectNames(['a/b..c'],[])).toEqual(['a_b.c']);
    expect(uniqueFolderProjectNames(['あ'.repeat(90)],[])[0]).toHaveLength(80);
  });
});

