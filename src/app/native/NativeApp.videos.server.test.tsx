/** @vitest-environment jsdom */
// ホームの複数動画の作成を、本物のサーバ（handleApi → importApi → importBatches）に通して確かめる。
// 偽の窓口の応答（作成時の項目の段）を取り違えると、画面とサーバの食い違いが試験で隠れる（2026-10-04 の不具合）。そのための結合の試験。
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterAll,afterEach,beforeAll,beforeEach,expect,it,vi} from 'vitest';
import {mkdtemp,realpath,rm} from 'node:fs/promises';
import {createServer,type Server} from 'node:http';
import type {AddressInfo} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {NativeHome} from './NativeApp';
import {handleApi} from '../../server/plugin';
import {sendApiError} from '../../server/http';
import {importBatches} from '../../server/sequence/importBatches';
import {makeVideoSamples,type VideoSamples} from '../../server/sequence/__fixtures__/videoSamples';

// jsdom の環境は Uint8Array を jsdom 側のものに差し替える。サーバの読み込み（scanProjects → esbuild）は Node の TextEncoder の結果が
// Uint8Array であることを読み込み時に確かめるので、サーバを読み込む前に Node の Uint8Array へ戻す（この試験ファイルの中だけ）。
const spy=vi.hoisted(()=>{const jsdomUint8Array=globalThis.Uint8Array;globalThis.Uint8Array=Object.getPrototypeOf(Buffer.prototype).constructor;return {resolve:vi.fn(),jsdomUint8Array};});
vi.mock('../panels/HomeDashboard',async importOriginal=>{const actual=await importOriginal<typeof import('../panels/HomeDashboard')>();return {...actual,HomeDashboardWithAgentBoard:actual.HomeDashboard};});
// 画面側の全体ハッシュ（ブラウザ版の参照）。デスクトップ版のリンクでは呼ばれないこと。
vi.mock('./useNativeFileReference',()=>({useNativeFileReference:()=>({resolve:(...a:unknown[])=>spy.resolve(...a),picker:null,cancel:()=>{}})}));
vi.mock('./videoDuration',()=>({readVideoDurations:async()=>new Map()}));
vi.mock('./NativeWorkspace',()=>({NativeWorkspace:()=>null}));
vi.mock('../useProjectsWatch',()=>({useProjectsWatch:()=>{}}));
vi.mock('../layout/useTheme',()=>({useTheme:()=>({theme:'dark',toggle:()=>{}})}));

const realFetch=globalThis.fetch;
let samples:VideoSamples,root:string,server:Server,origin:string;
beforeAll(async()=>{samples=makeVideoSamples(await mkdtemp(join(await realpath(tmpdir()),'native-home-media-')));},30000);
afterAll(async()=>{await rm(samples.dir,{recursive:true,force:true});globalThis.Uint8Array=spy.jsdomUint8Array;});
beforeEach(async()=>{
  localStorage.clear();sessionStorage.clear();
  vi.stubEnv('SME_BROWSE_ROOTS',samples.dir);vi.stubEnv('SME_TUTORIAL','0');
  root=await mkdtemp(join(await realpath(tmpdir()),'native-home-'));
  server=createServer((req,res)=>{void handleApi(req,res,new URL(req.url!,'http://localhost'),root).catch(error=>sendApiError(res,error));});
  await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));origin=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // 画面の相対 URL を試験用のサーバへ向ける（jsdom の AbortSignal は Node の fetch に渡せないので外す）。
  vi.stubGlobal('fetch',(input:string,init?:RequestInit)=>{const {signal:_signal,...rest}=init??{};return realFetch(new URL(String(input),origin),rest);});
  spy.resolve.mockReset().mockImplementation(async(file:File)=>({path:join(samples.dir,file.name),expectedFingerprint:'f'.repeat(64)}));
  Object.defineProperty(window,'harnessDesktop',{configurable:true,value:{getPathForFile:(file:File)=>join(samples.dir,file.name)}});
});
afterEach(async()=>{
  cleanup();vi.unstubAllGlobals();vi.unstubAllEnvs();Reflect.deleteProperty(window,'harnessDesktop');
  server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));await rm(root,{recursive:true,force:true});
});

it('desktop link: the real server takes the videos with their paths, and the home opens the project without handing them over again',async()=>{
  const navigate=vi.fn();render(<NativeHome navigate={navigate}/>);await screen.findByText('まだプロジェクトがありません');
  const input=screen.getByTestId('home-create-file') as HTMLInputElement;
  Object.defineProperty(input,'files',{value:[new File(['b'],'third-25.mp4'),new File(['a'],'second-60.mp4')],configurable:true});fireEvent.change(input);
  fireEvent.click(screen.getByRole('button',{name:'作成'}));
  // 開く・断られるのどちらかになるまで待つ（断られた時はその理由で落とす）。
  await waitFor(()=>expect(navigate.mock.calls.length>0||screen.queryByText('この素材は受け付け済みです')!==null).toBe(true),{timeout:10000});
  expect(screen.queryByText('この素材は受け付け済みです')).toBeNull();
  expect(navigate).toHaveBeenCalledTimes(1);expect(spy.resolve).not.toHaveBeenCalled();
  const id=navigate.mock.calls[0]![0] as string,directory=join(root,id);
  // 作品はゴミ箱へ移らず一覧に残り、束は取り消されずに両方の動画の準備を終える。
  const listed=await (await realFetch(`${origin}/api/projects`)).json() as {projects:Array<{id:string}>};
  expect(listed.projects.map(project=>project.id)).toContain(id);
  const [batch]=importBatches.list(directory);expect(batch).toMatchObject({origin:{kind:'home'},mode:'link'});
  await importBatches.idle(directory,batch!.batchId);
  expect(importBatches.list(directory)[0]).toMatchObject({phase:'ready',items:[{name:'second-60.mp4',phase:'ready',durationSeconds:2},{name:'third-25.mp4',phase:'ready',durationSeconds:1}]});
},30000);
