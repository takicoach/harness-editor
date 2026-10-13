import {afterAll,beforeAll,expect,it} from 'vitest';
import {execFileSync} from 'node:child_process';
import {mkdtemp,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {resolveFfmpegBin} from '../resolveFfmpeg';
import {SequenceStore} from './store';
import {nativeApiProject} from './__fixtures__/nativeApiProject';
import {FFMPEG_MAX_WAITING,FFMPEG_SLOTS,FfmpegBusyError,ffmpegGate,ffmpegLane} from './ffmpegGate';
let media:string,project:Awaited<ReturnType<typeof nativeApiProject>>;
beforeAll(async()=>{
  media=await mkdtemp(join(tmpdir(),'harness-waveform-media-'));const ffmpeg=resolveFfmpegBin();if(!ffmpeg.ok)throw new Error(ffmpeg.message);
  execFileSync(ffmpeg.bin,['-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc2=size=128x72:rate=30','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','2','-c:v','libx264','-c:a','aac',join(media,'main.mp4')]);
  project=await nativeApiProject(join(media,'main.mp4'));
},30000);
afterAll(async()=>{delete process.env.HARNESS_TEST_FFMPEG_DELAY_MS;await project.close();await rm(media,{recursive:true,force:true});});
it('returns "preparing" without holding the connection, then bins after the preparation id reports ready',async()=>{
  process.env.HARNESS_TEST_FFMPEG_DELAY_MS='800';   // 取り出しを遅らせ、準備中を確実に作る
  const asset=new SequenceStore(project.directory).load()!.document.assets.find(a=>a.kind==='media')!;
  const query=`id=${project.id}&asset=${asset.id}&stream=1&rateNum=1&rateDen=1&sourceInNum=0&sourceInDen=1&fpsNum=30&fpsDen=1&startFrame=0&frameCount=30&clipFrames=60&bins=4&loop=0`;
  const started=performance.now(),first=await (await fetch(`${project.origin}/api/sequence/waveform?${query}`)).json();
  expect(performance.now()-started).toBeLessThan(600);expect(first).toMatchObject({state:'preparing'});expect(first.preparationId).toMatch(/^[a-f0-9]{32}$/);
  let status='preparing';for(let i=0;i<50&&status==='preparing';i++){await new Promise(resolve=>setTimeout(resolve,100));
    status=(await (await fetch(`${project.origin}/api/sequence/waveform/status?id=${project.id}&preparation=${first.preparationId}`)).json()).preparations[first.preparationId].state;}
  expect(status).toBe('ready');
  const ready=await (await fetch(`${project.origin}/api/sequence/waveform?${query}`)).json();expect(ready.state).toBe('ready');expect(ready.bins).toHaveLength(4);
  expect((await fetch(`${project.origin}/api/sequence/waveform/status?id=${project.id}&preparation=nope`)).status).toBe(400);
},30000);
it('answers 503 with the busy message while the FFmpeg queue is full',async()=>{
  // 速度2倍は未準備なので、取り出しが共通実行枠の待ち行列に並ぼうとして混雑で断られる。
  const asset=new SequenceStore(project.directory).load()!.document.assets.find(a=>a.kind==='media')!,lane=ffmpegLane('preview');
  const held=await Promise.all(Array.from({length:FFMPEG_SLOTS},()=>ffmpegGate.acquire(lane))),controller=new AbortController();
  const queued=Array.from({length:FFMPEG_MAX_WAITING},()=>ffmpegGate.acquire(lane,controller.signal).catch(()=>undefined));
  try{
    const response=await fetch(`${project.origin}/api/sequence/waveform?id=${project.id}&asset=${asset.id}&stream=1&rateNum=2&rateDen=1&sourceInNum=0&sourceInDen=1&fpsNum=30&fpsDen=1&startFrame=0&frameCount=30&clipFrames=60&bins=4&loop=0`);
    expect(response.status).toBe(503);expect((await response.json()).error).toBe(new FfmpegBusyError().message);
  }finally{controller.abort();await Promise.all(queued);for(const release of held)release();}
},30000);
it('rebuilds a prepared PCM that vanished from the cache instead of failing',async()=>{
  const asset=new SequenceStore(project.directory).load()!.document.assets.find(a=>a.kind==='media')!,audio=join(project.directory,'.harness','cache','audio');
  const query=`id=${project.id}&asset=${asset.id}&stream=1&rateNum=1&rateDen=1&sourceInNum=0&sourceInDen=1&fpsNum=30&fpsDen=1&startFrame=0&frameCount=30&clipFrames=60&bins=4&loop=0`;
  const pcm=(await readdir(audio)).filter(name=>name.endsWith('.f32le'));expect(pcm.length).toBeGreaterThan(0);for(const name of pcm)await rm(join(audio,name));
  const response=await fetch(`${project.origin}/api/sequence/waveform?${query}`),body=await response.json();
  expect(response.status,JSON.stringify(body)).toBe(200);expect(['preparing','ready']).toContain(body.state);
  if(body.state==='preparing'){let status='preparing';for(let i=0;i<50&&status==='preparing';i++){await new Promise(resolve=>setTimeout(resolve,100));
    status=(await (await fetch(`${project.origin}/api/sequence/waveform/status?id=${project.id}&preparation=${body.preparationId}`)).json()).preparations[body.preparationId].state;}
    expect(status).toBe('ready');}
  const ready=await (await fetch(`${project.origin}/api/sequence/waveform?${query}`)).json();expect(ready.state).toBe('ready');expect(ready.bins).toHaveLength(4);
},30000);
