/** @vitest-environment jsdom */
// ホームの複数動画の作成を、本物のサーバ（handleApi → importApi → importBatches）に通して確かめる。
// 偽の窓口の応答（作成時の項目の段）を取り違えると、画面とサーバの食い違いが試験で隠れる（2026-10-04 の不具合）。そのための結合の試験。
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterAll,afterEach,beforeAll,beforeEach,expect,it,vi} from 'vitest';
import {existsSync} from 'node:fs';
import {mkdtemp,realpath,rm,stat} from 'node:fs/promises';
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

it('desktop link: the real server takes a dropped folder with real paths as a materials batch, and the home opens the project without handing them over again',async()=>{
  const navigate=vi.fn();render(<NativeHome navigate={navigate}/>);await screen.findByText('まだプロジェクトがありません');
  const files=[new File(['b'],'third-25.mp4'),new File(['a'],'second-60.mp4')];
  const entry={isFile:false,isDirectory:true,name:'素材',createReader:()=>{let done=false;return {readEntries:(ok:(e:unknown[])=>void)=>{const chunk=done?[]:files.map(file=>({isFile:true,isDirectory:false,name:file.name,file:(f:(x:File)=>void)=>f(file)}));done=true;ok(chunk);}};}};
  fireEvent.drop(document.querySelector('.home')!,{dataTransfer:{types:['Files'],files:[],items:[{kind:'file',webkitGetAsEntry:()=>entry}]}});
  fireEvent.click(await screen.findByRole('button',{name:'作成'}));
  // 開く・断られるのどちらかになるまで待つ（断られた時はその理由で落とす）。
  await waitFor(()=>expect(navigate.mock.calls.length>0||screen.queryByText('この素材は受け付け済みです')!==null).toBe(true),{timeout:10000});
  expect(screen.queryByText('この素材は受け付け済みです')).toBeNull();
  expect(navigate).toHaveBeenCalledTimes(1);expect(spy.resolve).not.toHaveBeenCalled();
  const id=navigate.mock.calls[0]![0] as string,directory=join(root,id);
  // 作品はゴミ箱へ移らず一覧に残り、束は取り消されずに両方の動画の準備を終える。
  const listed=await (await realFetch(`${origin}/api/projects`)).json() as {projects:Array<{id:string}>};
  expect(listed.projects.map(project=>project.id)).toContain(id);
  const [batch]=importBatches.list(directory);expect(batch).toMatchObject({origin:{kind:'home'},mode:'link',placement:'materials'});
  await importBatches.idle(directory,batch!.batchId);
  expect(importBatches.list(directory)[0]).toMatchObject({phase:'ready',items:[{name:'second-60.mp4',phase:'ready',durationSeconds:2},{name:'third-25.mp4',phase:'ready',durationSeconds:1}]});
},30000);

const folderEntry=(name:string,files:File[])=>{let done=false;return {isFile:false,isDirectory:true,name,createReader:()=>({readEntries:(ok:(e:unknown[])=>void)=>{const chunk=done?[]:files.map(file=>({isFile:true,isDirectory:false,name:file.name,file:(f:(x:File)=>void)=>f(file)}));done=true;ok(chunk);}})};};
const dropFolders=(...entries:unknown[])=>fireEvent.drop(document.querySelector('.home')!,{dataTransfer:{types:['Files'],files:[],items:entries.map(entry=>({kind:'file',webkitGetAsEntry:()=>entry}))}});
const listProjects=async()=>((await (await realFetch(`${origin}/api/projects`)).json()) as {projects:Array<{id:string}>}).projects.map(project=>project.id);

it('several folders: the real server makes one project each with its videos prepared and its documents kept, and the home stays',async()=>{
  const navigate=vi.fn();render(<NativeHome navigate={navigate}/>);await screen.findByText('まだプロジェクトがありません');
  dropFolders(folderEntry('撮影',[new File(['a'],'second-60.mp4'),new File(['本文'],'台本.txt')]),folderEntry('外ロケ',[new File(['b'],'third-25.mp4')]));
  fireEvent.click(await screen.findByRole('button',{name:'作成'}));
  await waitFor(async()=>expect(await listProjects()).toEqual(expect.arrayContaining(['撮影','外ロケ'])),{timeout:10000});
  await screen.findByText(/2 件のプロジェクトを作りました/,undefined,{timeout:20000});
  expect(navigate).not.toHaveBeenCalled();
  // 待ち終えた時には準備が済んでいる（再起動しても残り、開いた時に素材欄へ入る）。
  expect(importBatches.list(join(root,'撮影'))[0]).toMatchObject({origin:{kind:'home'},placement:'materials',phase:'ready'});
  expect(importBatches.list(join(root,'外ロケ'))[0]).toMatchObject({phase:'ready'});
  expect((await stat(join(root,'撮影','資料','台本.txt'))).isFile()).toBe(true);
  expect(existsSync(join(root,'外ロケ','資料'))).toBe(false);
},40000);
it('several folders: one failing does not stop the next',async()=>{
  const navigate=vi.fn();render(<NativeHome navigate={navigate}/>);await screen.findByText('まだプロジェクトがありません');
  const pass=globalThis.fetch;
  vi.stubGlobal('fetch',(input:string,init?:RequestInit)=>String(input).includes('create-project-empty')&&String(input).includes(encodeURIComponent('壊れ'))?Promise.resolve(new Response(JSON.stringify({error:'作れません'}),{status:500})):pass(input,init));
  dropFolders(folderEntry('壊れ',[new File(['a'],'second-60.mp4')]),folderEntry('外ロケ',[new File(['b'],'third-25.mp4')]));
  fireEvent.click(await screen.findByRole('button',{name:'作成'}));
  await screen.findByText(/2 個のフォルダのうち 1 個から作りました。作れなかったフォルダ: 壊れ（作れません）/,undefined,{timeout:20000});
  expect(await listProjects()).toEqual(['外ロケ']);expect(navigate).not.toHaveBeenCalled();
},40000);
it('one folder: opens the project when its documents were kept, and stays to say so when they were not',async()=>{
  const navigate=vi.fn();render(<NativeHome navigate={navigate}/>);await screen.findByText('まだプロジェクトがありません');
  dropFolders(folderEntry('撮影',[new File(['a'],'second-60.mp4'),new File(['本文'],'台本.txt')]));
  fireEvent.click(await screen.findByRole('button',{name:'作成'}));
  await waitFor(()=>expect(navigate).toHaveBeenCalledWith('撮影'),{timeout:10000});
  expect((await stat(join(root,'撮影','資料','台本.txt'))).isFile()).toBe(true);
  await importBatches.idle(join(root,'撮影'),importBatches.list(join(root,'撮影'))[0]!.batchId);
  cleanup();
  const stay=vi.fn(),pass=globalThis.fetch;render(<NativeHome navigate={stay}/>);
  vi.stubGlobal('fetch',(input:string,init?:RequestInit)=>String(input).includes('/api/project/documents')?Promise.resolve(new Response(JSON.stringify({error:'空きがありません'}),{status:500})):pass(input,init));
  await screen.findAllByText(/撮影/);
  dropFolders(folderEntry('外ロケ',[new File(['b'],'third-25.mp4'),new File(['x'],'構成.md')]));
  fireEvent.click(await screen.findByRole('button',{name:'作成'}));
  await screen.findByText(/書類を保管できませんでした（構成.md: 空きがありません）/,undefined,{timeout:20000});
  expect(stay).not.toHaveBeenCalled();expect(await listProjects()).toContain('外ロケ');
  // 開かずに留まる時も、通知の前に動画の準備を待つ（再起動で準備中の動画が失敗に変わらないように）。
  expect(importBatches.list(join(root,'外ロケ'))[0]).toMatchObject({phase:'ready',items:[{name:'third-25.mp4',phase:'ready'}]});
},40000);

