import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import {existsSync} from 'node:fs';
import {mkdir,mkdtemp,rm,stat,truncate,utimes,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {rational as r} from '../../core/sequence/time';
import {createSequenceProject} from './create';
import {SequenceStore} from './store';
import {FRAME_CACHE_LIMIT_BYTES,FrameCacheBudget,prepareSequenceFrames} from './frameImages';
import {frameCacheFolder,framePresentationIndex} from './framePresentation';
import {makeFrameNumberVideos,readFrameNumber,type FrameNumberVideos} from './__fixtures__/frameNumberVideos';

/** 指定したパスの readdir・unlink を、開けるまで止める（掃除が遅い・ディスクが詰まった状態を作る）。 */
const hooks=vi.hoisted(()=>({hold:new Map<string,Promise<void>>()}));
vi.mock('node:fs/promises',async original=>{
  const actual=await original<typeof import('node:fs/promises')>();
  const held=<T extends (path:never,...rest:never[])=>Promise<unknown>>(fn:T)=>(async(path:unknown,...rest:unknown[])=>{await hooks.hold.get(String(path));return (fn as unknown as (...args:unknown[])=>Promise<unknown>)(path,...rest);}) as unknown as T;
  const readdir=held(actual.readdir),unlink=held(actual.unlink);
  return {...actual,default:{...actual,readdir,unlink},readdir,unlink};
});
function gate(path:string){let open!:()=>void;hooks.hold.set(path,new Promise<void>(resolve=>{open=()=>{hooks.hold.delete(path);resolve();};}));return open;}
const within=<T>(work:Promise<T>,ms:number)=>Promise.race([work,new Promise<'timed out'>(resolve=>setTimeout(()=>resolve('timed out'),ms))]);
let media:string,root:string,videos:FrameNumberVideos;
beforeAll(async()=>{media=await mkdtemp(join(tmpdir(),'harness-frames-cleanup-media-'));root=await mkdtemp(join(tmpdir(),'harness-frames-cleanup-'));videos=makeFrameNumberVideos(media);},60000);
afterAll(async()=>{await rm(media,{recursive:true,force:true});await rm(root,{recursive:true,force:true});});

it('a cache hit does not wait for the startup scan, and the scan still learns which frame was used last',async()=>{
  const cache=await mkdtemp(join(tmpdir(),'harness-frame-scan-')),folder=join(cache,'frames-v1','f','s0','h72');await mkdir(folder,{recursive:true});
  for(const [name,age] of [['1.jpg',3],['2.jpg',2]] as const){const file=join(folder,name);await writeFile(file,Buffer.alloc(30));const at=new Date(Date.now()-age*1000);await utimes(file,at,at);}
  const open=gate(cache),started=Date.now();
  try{
    const budget=new FrameCacheBudget(cache,70,60);
    expect(await within(budget.touch(join(folder,'1.jpg')),2000)).not.toBe('timed out');
    expect((await stat(join(folder,'1.jpg'))).mtimeMs).toBeGreaterThanOrEqual(started-1000);
    open();await budget.ready;
    await writeFile(join(folder,'3.jpg'),Buffer.alloc(30));await budget.add(join(folder,'3.jpg'),30);   // 90 > 70 → 2 だけ消える
    expect(existsSync(join(folder,'2.jpg'))).toBe(false);expect(existsSync(join(folder,'1.jpg'))).toBe(true);
  }finally{open();await rm(cache,{recursive:true,force:true});}
},30000);
it('a response does not wait for the cache to delete old frames',async()=>{
  const {id}=await createSequenceProject(root,{name:'cleanup',videoName:'source.mp4',sourcePath:videos.cfr2997}),directory=join(root,id);
  const asset=new SequenceStore(directory).load()!.document.assets.find(a=>a.streams.some(s=>s.kind==='video'))!;
  await framePresentationIndex(directory,asset,0);   // 索引を先に作る（作る時に h* を消すので、古いコマはその後に置く）
  // 上限ちょうど手前の古いコマ（疎なファイル）。新しい 1 コマで上限を超え、これが消される
  const old=join(await frameCacheFolder(directory,asset,0,72),'old.jpg');await writeFile(old,'');await truncate(old,FRAME_CACHE_LIMIT_BYTES-100);
  const at=new Date(Date.now()-3_600_000);await utimes(old,at,at);
  const open=gate(old);
  try{
    const result=await within(prepareSequenceFrames(directory,asset,{assetId:asset.id,streamIndex:0,height:72,times:[{key:'0/1',time:r(0)}]}),5000);
    expect(result).not.toBe('timed out');if(result==='timed out')return;
    expect(readFrameNumber(Buffer.from(result.frames[0]!.data.slice(result.frames[0]!.data.indexOf(',')+1),'base64'))).toBe(0);
    expect(existsSync(old)).toBe(true);   // 削除はまだ止まっている
    open();for(let i=0;i<100&&existsSync(old);i++)await new Promise(resolve=>setTimeout(resolve,20));
    expect(existsSync(old)).toBe(false);   // 応答の後に消える
  }finally{open();}
},60000);
