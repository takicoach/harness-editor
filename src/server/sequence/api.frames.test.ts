import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import {mkdtemp,realpath,rename,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SequenceStore} from './store';
import {nativeApiProject} from './__fixtures__/nativeApiProject';
import {makeFrameNumberVideos,readFrameNumber} from './__fixtures__/frameNumberVideos';
import {FFMPEG_MAX_WAITING,FFMPEG_SLOTS,FfmpegBusyError,ffmpegGate,ffmpegLane} from './ffmpegGate';
import {frameExtractions} from './frameImages';
import {FRAME_HEIGHTS,FRAME_THUMB_HEIGHT} from '../../shared/filmstripHeight';
import {ThumbLoadError,thumbRetry} from '../../app/native/frameThumbnails';
let media:string,project:Awaited<ReturnType<typeof nativeApiProject>>;
beforeAll(async()=>{media=await mkdtemp(join(tmpdir(),'harness-frames-api-'));project=await nativeApiProject(makeFrameNumberVideos(media).cfr2997);},60000);
afterAll(async()=>{await project.close();await rm(media,{recursive:true,force:true});});
const query=()=>{const asset=new SequenceStore(project.directory).load()!.document.assets.find(a=>a.streams.some(s=>s.kind==='video'))!;return `id=${project.id}&asset=${asset.id}`;};
const until=async(done:()=>boolean,what:string)=>{for(let i=0;i<100&&!done();i++)await new Promise(resolve=>setTimeout(resolve,50));if(!done())throw new Error(`待ちきれませんでした: ${what}`);};
it('GET /frames answers each requested time with the frame burned into it, and refuses malformed input',async()=>{
  const asset=new SequenceStore(project.directory).load()!.document.assets.find(a=>a.streams.some(s=>s.kind==='video'))!,base=`id=${project.id}&asset=${asset.id}`;
  const response=await fetch(`${project.origin}/api/sequence/frames?${base}&stream=0&height=72&times=${encodeURIComponent('0/1,30030/30000,99/1')}`);
  expect(response.status,await response.clone().text()).toBe(200);const body=await response.json();
  expect(body.frames.map((f:{time:string;frame:number})=>[f.time,f.frame])).toEqual([['0/1',0],['30030/30000',30],['99/1',299]]);
  expect(body.frames.map((f:{data:string})=>readFrameNumber(Buffer.from(f.data.slice(f.data.indexOf(',')+1),'base64')))).toEqual([0,30,299]);
  for(const bad of ['stream=0&height=72&times=','stream=0&height=72&times=1.5','stream=0&height=4&times=0%2F1','stream=x&height=72&times=0%2F1'])
    expect((await fetch(`${project.origin}/api/sequence/frames?${base}&${bad}`)).status,bad).toBe(400);
},60000);
it('is a read-only route (the saved document is not reread) and accepts only the heights the timeline asks for',async()=>{
  expect(FRAME_HEIGHTS).toEqual([FRAME_THUMB_HEIGHT]);   // ブラウザ（Task 8）が要求する高さと、サーバが受ける高さは同じ所から出す
  const base=query(),load=vi.spyOn(SequenceStore.prototype,'load');
  try{const response=await fetch(`${project.origin}/api/sequence/frames?${base}&stream=0&height=${FRAME_THUMB_HEIGHT}&times=1%2F1`);expect(response.status,await response.clone().text()).toBe(200);await response.json();expect(load).not.toHaveBeenCalled();}
  finally{load.mockRestore();}
  for(const height of ['48','240','73'])expect((await fetch(`${project.origin}/api/sequence/frames?${base}&stream=0&height=${height}&times=0%2F1`)).status,height).toBe(400);
},60000);
it('answers 503 with the busy message when no frame could queue, and keeps the frames it had when only some could not',async()=>{
  const base=query(),lane=ffmpegLane('preview');
  const held=await Promise.all(Array.from({length:FFMPEG_SLOTS},()=>ffmpegGate.acquire(lane))),controller=new AbortController();
  const queued=Array.from({length:FFMPEG_MAX_WAITING},()=>ffmpegGate.acquire(lane,controller.signal).catch(()=>undefined));
  try{
    const busy=await fetch(`${project.origin}/api/sequence/frames?${base}&stream=0&height=72&times=${encodeURIComponent('5/1,6/1')}`);
    expect(busy.status).toBe(503);expect((await busy.json()).error).toBe(new FfmpegBusyError().message);
    const partial=await fetch(`${project.origin}/api/sequence/frames?${base}&stream=0&height=72&times=${encodeURIComponent('0/1,5/1')}`);   // 0/1 は保存済み
    expect(partial.status).toBe(200);const body=await partial.json();
    expect(body.frames.map((f:{time:string})=>f.time)).toEqual(['0/1']);expect(body.failed).toEqual([{time:'5/1',error:new FfmpegBusyError().message,busy:true}]);   // 混雑で落ちた印（画面は 503 と同じく取り直し続ける）
  }finally{controller.abort();await Promise.all(queued);for(const release of held)release();}
},60000);
it('a request the browser cancels leaves the FFmpeg queue without extracting',async()=>{
  const base=query(),lane=ffmpegLane('preview'),before=frameExtractions.count;
  const held=await Promise.all(Array.from({length:FFMPEG_SLOTS},()=>ffmpegGate.acquire(lane)));
  try{
    const controller=new AbortController(),pending=fetch(`${project.origin}/api/sequence/frames?${base}&stream=0&height=72&times=${encodeURIComponent('7/1,8/1')}`,{signal:controller.signal}).catch(()=>'aborted');
    await until(()=>ffmpegGate.stats.waiting===2,'2 コマが待ち行列に並ぶ');
    controller.abort();expect(await pending).toBe('aborted');
    await until(()=>ffmpegGate.stats.waiting===0,'取り消した 2 コマが待ち行列から外れる');
  }finally{for(const release of held)release();}
  await new Promise(resolve=>setTimeout(resolve,200));expect(frameExtractions.count).toBe(before);
  const after=await (await fetch(`${project.origin}/api/sequence/frames?${base}&stream=0&height=72&times=7%2F1`)).json();
  expect(after.frames.map((f:{data:string})=>readFrameNumber(Buffer.from(f.data.slice(f.data.indexOf(',')+1),'base64')))).toEqual([209]);
},60000);
it('a cached frame whose source is gone answers like the audio route (422 with its message), which the filmstrip does not keep retrying',async()=>{
  const asset=new SequenceStore(project.directory).load()!.document.assets.find(a=>a.streams.some(s=>s.kind==='video'))!,base=`id=${project.id}&asset=${asset.id}`;
  const frames=()=>fetch(`${project.origin}/api/sequence/frames?${base}&stream=0&height=72&times=0%2F1`);   // 0/1 は保存済み
  expect((await frames()).status).toBe(200);
  const file=await realpath(join(project.directory,asset.file)),away=`${file}.away`;await rename(file,away);
  try{
    const [missing,audio]=await Promise.all([frames(),fetch(`${project.origin}/api/sequence/audio?${base}&stream=0`)]);
    const answer=async(response:Response)=>({status:response.status,error:(await response.json()).error});
    const body=await answer(missing);expect(body).toEqual(await answer(audio));expect(body.status).toBe(422);
    expect(thumbRetry(new ThumbLoadError(body.error,body.status))).toBe('stop');   // 画面は取り直し続けない（400番台）
  }finally{await rename(away,file);}
  expect((await frames()).status).toBe(200);
},60000);
