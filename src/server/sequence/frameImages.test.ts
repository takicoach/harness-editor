import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {copyFile,mkdir,mkdtemp,readFile,readdir,rm,utimes,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {SequenceAsset} from '../../core/sequence/model';
import {rational as r,type Rational} from '../../core/sequence/time';
import {resolveFfmpegBin} from '../resolveFfmpeg';
import {createSequenceProject} from './create';
import {SequenceStore} from './store';
import {FrameCacheBudget,frameExtractions,prepareSequenceFrames,type FrameRequest} from './frameImages';
import {FRAME_CACHE_VERSION,frameCacheFolder,frameExtractionArgs,framePresentationIndex,forgetFramePresentations} from './framePresentation';
import {keyframeBoundaryFrames,makeFrameNumberVideos,readFrameNumber,readGray,type FrameNumberVideos} from './__fixtures__/frameNumberVideos';

let media:string,root:string,videos:FrameNumberVideos;
const projects=new Map<string,{directory:string;asset:SequenceAsset}>();
async function project(source:string){
  const hit=projects.get(source);if(hit)return hit;
  const {id}=await createSequenceProject(root,{name:`p${projects.size}`,videoName:'source.mp4',sourcePath:source}),directory=join(root,id);
  const entry={directory,asset:new SequenceStore(directory).load()!.document.assets.find(a=>a.streams.some(s=>s.kind==='video'))!};projects.set(source,entry);return entry;
}
const request=(asset:SequenceAsset,times:Rational[],stream=0,height=72):FrameRequest=>({assetId:asset.id,streamIndex:stream,height,times:times.map(time=>({key:`${time.num}/${time.den}`,time}))});
const decode=(data:string)=>Buffer.from(data.slice(data.indexOf(',')+1),'base64');
beforeAll(async()=>{media=await mkdtemp(join(tmpdir(),'harness-frames-media-'));root=await mkdtemp(join(tmpdir(),'harness-frames-'));videos=makeFrameNumberVideos(media);},60000);
afterAll(async()=>{await rm(media,{recursive:true,force:true});await rm(root,{recursive:true,force:true});});

describe('the same frame (burned-in frame numbers)',()=>{
  it('29.97fps: the frame shown at or before each time, and the last frame past the source end',async()=>{
    const {directory,asset}=await project(videos.cfr2997);
    const result=await prepareSequenceFrames(directory,asset,request(asset,[r(0),r(1001,30000),r(1002,30000),r(137*1001,30000),r(299*1001,30000),r(20)]));
    expect(result.failed).toEqual([]);expect(result.frames.map(f=>f.frame)).toEqual([0,1,1,137,299,299]);
    expect(result.frames.map(f=>readFrameNumber(decode(f.data)))).toEqual([0,1,1,137,299,299]);
  },60000);
  it('variable frame rate: gaps of 1/30 and 2/30 s keep the earlier frame until the next one is shown',async()=>{
    const {directory,asset}=await project(videos.vfr);   // 表示時刻 0, 1/30, 3/30, 4/30, 6/30 …
    const result=await prepareSequenceFrames(directory,asset,request(asset,[r(1,30),r(2,30),r(3,30),r(5,30),r(6,30)]));
    expect(result.frames.map(f=>readFrameNumber(decode(f.data)))).toEqual([1,1,2,3,4]);
  },60000);
  it('two video streams: the explicit stream number decides the picture',async()=>{
    const {directory,asset}=await project(videos.twoStreams);
    const first=await prepareSequenceFrames(directory,asset,request(asset,[r(1)],0)),second=await prepareSequenceFrames(directory,asset,request(asset,[r(1)],1));
    expect(readFrameNumber(decode(first.frames[0]!.data))).toBe(30);expect(readFrameNumber(decode(second.frames[0]!.data))).toBe(1030);
  },60000);
  it('an edit list starting inside a frame (lossless cut): the frame the export shows first, then the following ones',async()=>{
    const {directory,asset}=await project(videos.editList);   // 1.5 秒の編集開始は 44 番の途中。書き出しは 44 番を 0 秒から出す
    const result=await prepareSequenceFrames(directory,asset,request(asset,[r(0),r(1001,30000),r(10010,30000)]));
    expect(result.failed).toEqual([]);expect(result.frames.map(f=>f.frame)).toEqual([0,1,10]);
    expect(result.frames.map(f=>readFrameNumber(decode(f.data)))).toEqual([44,45,54]);
  },60000);
  it('frames just before each keyframe (B-frames) and the frame an edit list starts inside',async()=>{
    for(const [file,first] of [[videos.cfr2997,0],[videos.editList,44]] as const){
      const {directory,asset}=await project(file),index=await framePresentationIndex(directory,asset,0),frames=keyframeBoundaryFrames(index);
      const result=await prepareSequenceFrames(directory,asset,request(asset,frames.map(frame=>r(index.pts[frame]!*index.timeBase.num,index.timeBase.den))));
      expect(result.failed).toEqual([]);expect(result.frames.map(f=>f.frame)).toEqual(frames);
      expect(result.frames.map(f=>readFrameNumber(decode(f.data)))).toEqual(frames.map(frame=>first+frame));
    }
  },60000);
  it('an empty edit of 0.5 s with audio: source time counts from the movie start, not from the container start',async()=>{
    const {directory,asset}=await project(videos.offsetAudio);
    const result=await prepareSequenceFrames(directory,asset,request(asset,[r(3),r(5005,10000)]));
    expect(result.frames.map(f=>readFrameNumber(decode(f.data)))).toEqual([74,0]);
  },60000);
  it('rotation: the thumbnail is upright for display and still the requested frame',async()=>{
    const {directory,asset}=await project(videos.rotated);
    const image=decode((await prepareSequenceFrames(directory,asset,request(asset,[r(1)]))).frames[0]!.data),gray=readGray(image);
    expect(gray.width).toBeLessThan(gray.height);expect(readFrameNumber(image,90)).toBe(30);
  },60000);
});
describe('the same pixels',()=>{
  it('matches an independent full decode of that frame with the same scaling',async()=>{
    const {directory,asset}=await project(videos.cfr2997),ffmpeg=resolveFfmpegBin();if(!ffmpeg.ok)throw new Error(ffmpeg.message);
    const ours=readGray(decode((await prepareSequenceFrames(directory,asset,request(asset,[r(137*1001,30000)]))).frames[0]!.data));
    const reference=readGray(execFileSync(ffmpeg.bin,['-hide_banner','-loglevel','error','-i',videos.cfr2997,'-vf',`select=eq(n\\,137),scale=w='max(2,trunc(72*dar/2)*2)':h=72:flags=bilinear,setsar=1`,
      '-fps_mode','passthrough','-frames:v','1','-c:v','mjpeg','-q:v','5','-f','image2pipe','pipe:1']));
    expect([ours.width,ours.height]).toEqual([reference.width,reference.height]);
    let total=0,worst=0;for(let i=0;i<ours.pixels.length;i++){const d=Math.abs(ours.pixels[i]!-reference.pixels[i]!);total+=d;worst=Math.max(worst,d);}
    expect(total/ours.pixels.length).toBeLessThanOrEqual(.5);expect(worst).toBeLessThanOrEqual(8);
  },60000);
  it('square pixels: a 2:1 sample-aspect source becomes a 16:9 thumbnail',async()=>{
    const {directory,asset}=await project(videos.anamorphic);
    const gray=readGray(decode((await prepareSequenceFrames(directory,asset,request(asset,[r(0)]))).frames[0]!.data));
    expect([gray.width,gray.height]).toEqual([128,72]);
  },60000);
});
describe('frame cache',()=>{
  it('reuses each frame across different time sets and joins concurrent extraction of the same frame',async()=>{
    const {directory,asset}=await project(videos.cfr2997),before=frameExtractions.count;
    await Promise.all([prepareSequenceFrames(directory,asset,request(asset,[r(3),r(4)],0,48)),prepareSequenceFrames(directory,asset,request(asset,[r(4),r(3)],0,48))]);
    expect(frameExtractions.count-before).toBe(2);
    const again=await prepareSequenceFrames(directory,asset,request(asset,[r(3001,1000)],0,48));   // 3.001 秒もフレーム 89
    expect(again.frames[0]!.frame).toBe(89);expect(frameExtractions.count-before).toBe(2);
  },60000);
  it('drops the least recently used frames beyond the budget, other versions, and temporary files left by an earlier process',async()=>{
    const cache=await mkdtemp(join(tmpdir(),'harness-frame-budget-')),folder=join(cache,'frames-v1','f','s0','h72');await mkdir(folder,{recursive:true});await mkdir(join(cache,'frames-v0','old'),{recursive:true});
    for(const [name,age] of [['1.jpg',3],['2.jpg',2],['3.jpg',1]] as const){const file=join(folder,name);await writeFile(file,Buffer.alloc(30));const at=new Date(Date.now()-age*1000);await utimes(file,at,at);}
    const stale=join(folder,'4.jpg.a.tmp'),old=new Date(Date.now()-3_600_000);await writeFile(stale,'partial');await utimes(stale,old,old);
    await writeFile(join(folder,'5.jpg.b.tmp'),'in progress');   // このプロセスの作りかけは消さない
    const staleIndex=join(cache,'frames-v1','f','s0','index.json.c.tmp');await writeFile(staleIndex,'{');await utimes(staleIndex,old,old);   // 索引の作りかけ（Task 6）
    const budget=new FrameCacheBudget(cache,100,80);await budget.touch(join(folder,'1.jpg'));await budget.ready;   // 1 がいちばん新しく使われた
    expect((await readdir(cache)).sort()).toEqual(['frames-v1']);expect(await readdir(join(cache,'frames-v1','f','s0'))).toEqual(['h72']);
    await writeFile(join(folder,'6.jpg'),Buffer.alloc(30));await budget.add(join(folder,'6.jpg'),30);   // 120 > 100 → 80 以下まで古い順に消す
    expect((await readdir(folder)).sort()).toEqual(['1.jpg','5.jpg.b.tmp','6.jpg']);expect(budget.bytes).toBe(60);
    await rm(cache,{recursive:true,force:true});
  });
});
/** JPEG の番号の意味を決めるもの: 索引の版・試料の索引の中身・取り出しの引数。どれかが変わったのに FRAME_CACHE_VERSION も索引の版も
 * 上げないと、作り直さなかった索引の下に前の番号付けの絵が残る。値が変わったら、どちらかの版を上げてから、ここを新しい値に書き換える。 */
const PINNED={cacheVersion:'frames-v1',indexVersion:3,index:{cfr2997:'bd2ac6f53924e663',editList:'4b21883bba86fa3f',vfr:'3d514f073c2af751',mkv:'9cf5919f7582646e'},args:'42a9c71aaa8fee33'};
describe('cache versioning',()=>{
  it('rebuilding the frame index drops the pictures cached under the old numbering',async()=>{
    const {directory,asset}=await project(videos.cfr2997),folder=await frameCacheFolder(directory,asset,0),index=join(folder,'index.json');
    for(const damage of ['missing','broken','older version'] as const){
      await prepareSequenceFrames(directory,asset,request(asset,[r(100*1001,30000)]));
      await copyFile(join(folder,'h72','100.jpg'),join(folder,'h72','5.jpg'));   // 前の番号付けでは 5 番に別の絵が入っていた状態
      if(damage==='missing')await rm(index);else if(damage==='broken')await writeFile(index,'{');
      else await writeFile(index,JSON.stringify({...JSON.parse(await readFile(index,'utf8')),version:2}));
      forgetFramePresentations();
      const result=await prepareSequenceFrames(directory,asset,request(asset,[r(5*1001,30000)]));
      expect(readFrameNumber(decode(result.frames[0]!.data)),damage).toBe(5);
    }
  },60000);
  it('pins the index version, the indexes of the samples and the extraction arguments',async()=>{
    const ffmpeg=resolveFfmpegBin();if(!ffmpeg.ok)throw new Error(ffmpeg.message);
    const mkv=join(media,'cfr2997.mkv');execFileSync(ffmpeg.bin,['-hide_banner','-loglevel','error','-y','-i',videos.cfr2997,'-c','copy',mkv]);
    const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0,16),indexes:Record<string,unknown>={},args:string[][]=[];let version=0;
    for(const [name,file] of [['cfr2997',videos.cfr2997],['editList',videos.editList],['vfr',videos.vfr],['mkv',mkv]] as const){
      const {directory,asset}=await project(file),index=await framePresentationIndex(directory,asset,0);version=index.version;indexes[name]=hash(index);
      for(const frame of keyframeBoundaryFrames(index))args.push(frameExtractionArgs(index,frame,0,72,'out.jpg'));
    }
    expect({cacheVersion:FRAME_CACHE_VERSION,indexVersion:version,index:indexes,args:hash(args)},
      'コマの番号の意味が変わりました。FRAME_CACHE_VERSION か索引の版を上げてから、PINNED を新しい値にしてください').toEqual(PINNED);
  },60000);
});
