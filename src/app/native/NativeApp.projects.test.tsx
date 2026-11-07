/** @vitest-environment jsdom */
// 複数の動画 → 1 本ずつ別のプロジェクト（設計 3-3）。単発の作成を順に呼び、どれも開かず、結果を返してホームに留まる。
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {NativeHome} from './NativeApp';
const api=vi.hoisted(()=>({create:vi.fn(),resolve:vi.fn()}));
vi.mock('../panels/HomeDashboard',async importOriginal=>{const actual=await importOriginal<typeof import('../panels/HomeDashboard')>();return {...actual,HomeDashboardWithAgentBoard:actual.HomeDashboard};});
vi.mock('./api',async importOriginal=>({...(await importOriginal<typeof import('./api')>()),createNativeProject:(...a:unknown[])=>api.create(...a)}));
vi.mock('./useNativeFileReference',()=>({useNativeFileReference:()=>({resolve:(...a:unknown[])=>api.resolve(...a),picker:null,cancel:()=>{}})}));
vi.mock('./NativeWorkspace',()=>({NativeWorkspace:()=>null}));
vi.mock('../useProjectsWatch',()=>({useProjectsWatch:()=>{}}));
vi.mock('../layout/useTheme',()=>({useTheme:()=>({theme:'dark',toggle:()=>{}})}));
let listed=0;
beforeEach(()=>{
  localStorage.clear();sessionStorage.clear();listed=0;
  api.create.mockReset();api.resolve.mockReset().mockImplementation(async(file:File)=>({path:`/ssd/${file.name}`,expectedFingerprint:'f'.repeat(64)}));
  vi.stubGlobal('fetch',vi.fn(async(url:string)=>{if(String(url).startsWith('/api/projects'))listed++;return {ok:true,json:async()=>(String(url).startsWith('/api/config')?{tutorialEnabled:false}:{projects:[]})};}));
});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
const f=(name:string)=>new File(['x'],name);
const start=async(files:File[],navigate=vi.fn())=>{render(<NativeHome navigate={navigate}/>);await screen.findByText('まだプロジェクトがありません');
  const input=screen.getByTestId('home-create-file') as HTMLInputElement;Object.defineProperty(input,'files',{value:files,configurable:true});fireEvent.change(input);return navigate;};
it('links each video as its own project in name order, never opens one, reloads the list and reports',async()=>{
  api.create.mockResolvedValueOnce({id:'p1'}).mockResolvedValueOnce({id:'p2'});
  const navigate=await start([f('clip10.mp4'),f('clip2.mp4')]);const before=listed;
  fireEvent.click(screen.getByRole('button',{name:'作成'}));
  await waitFor(()=>expect(screen.getByRole('status').textContent).toBe('2 本のプロジェクトを作りました'));
  expect(api.create.mock.calls.map(call=>[String(call[0]).replace(/^\d{4}-\d{2}-\d{2}-/,''),call[1],call[3]])).toEqual([['clip2','/ssd/clip2.mp4','f'.repeat(64)],['clip10','/ssd/clip10.mp4','f'.repeat(64)]]);
  expect(navigate).not.toHaveBeenCalled();expect(listed).toBeGreaterThan(before);expect(screen.queryByRole('button',{name:'作成'})).toBeNull();
});
it('goes on after a failed video, and stops at a cancelled location choice',async()=>{
  api.create.mockResolvedValueOnce({id:'p1'}).mockRejectedValueOnce(new Error('同じ名前のプロジェクトがすでにあります'));
  api.resolve.mockImplementationOnce(async()=>({path:'/m/a.mp4',expectedFingerprint:'f'})).mockImplementationOnce(async()=>({path:'/m/b.mp4',expectedFingerprint:'f'})).mockImplementationOnce(async()=>{throw new DOMException('素材の追加を中止しました。','AbortError');});
  const navigate=await start([f('a.mp4'),f('b.mp4'),f('c.mp4'),f('d.mp4')]);
  fireEvent.click(screen.getByRole('button',{name:'作成'}));
  const report=await screen.findByTestId('home-create-report');
  expect(report.textContent).toMatch(/4 本中 1 本を作りました。作れなかった動画: .*-b（同じ名前のプロジェクトがすでにあります）。取り消したため作らなかった動画: .*-c、.*-d/);
  expect(api.create).toHaveBeenCalledTimes(2);expect(api.resolve).toHaveBeenCalledTimes(3);expect(navigate).not.toHaveBeenCalled();
});
it('copies each video when asked, without looking for its location',async()=>{
  api.create.mockResolvedValue({id:'p'});
  await start([f('a.mp4'),f('b.mp4')]);
  fireEvent.click(screen.getByTestId('home-create-copy'));fireEvent.click(screen.getByRole('button',{name:'作成'}));
  await waitFor(()=>expect(screen.getByRole('status').textContent).toBe('2 本のプロジェクトを作りました'));
  expect(api.resolve).not.toHaveBeenCalled();expect(api.create.mock.calls[0]![1]).toBeInstanceOf(File);
});
