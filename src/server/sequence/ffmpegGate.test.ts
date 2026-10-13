import {describe,expect,it} from 'vitest';
import {FfmpegBusyError,FfmpegGate,ffmpegLane,type FfmpegLane,type FfmpegPriority} from './ffmpegGate';
import {SharedPreparations} from './sharedPreparation';

const recorder=(gate:FfmpegGate)=>{const started:string[]=[];
  return {started,take:(name:string,priority:FfmpegPriority,signal?:AbortSignal)=>gate.acquire(ffmpegLane(priority),signal).then(release=>{started.push(name);return release;})};};
describe('shared FFmpeg slots (設計 §2-1)',()=>{
  it('starts waiting work by priority: preview/audio, then waveform, then filmstrip; oldest first within a priority',async()=>{
    const gate=new FfmpegGate(1,1,8),q=recorder(gate),running=await q.take('running','filmstrip');
    const film=q.take('film','filmstrip'),wave=q.take('wave','waveform'),audio=q.take('audio','audio'),preview=q.take('preview','preview');
    running();(await audio)();(await preview)();(await wave)();(await film)();
    expect(q.started).toEqual(['running','audio','preview','wave','film']);
  });
  it('keeps one slot free from filmstrip work so playback never waits behind thumbnails',async()=>{
    const gate=new FfmpegGate(3,2,8),q=recorder(gate),a=await q.take('a','filmstrip'),b=await q.take('b','filmstrip');
    let third=false;const c=q.take('c','filmstrip').then(release=>{third=true;return release;});
    const audio=await q.take('audio','audio');await Promise.resolve();
    expect(third).toBe(false);expect(gate.stats).toEqual({active:3,waiting:1});
    audio();a();(await c)();b();expect(third).toBe(true);
  });
  it('removes a request cancelled by the browser from the queue',async()=>{
    const gate=new FfmpegGate(1,1,8),q=recorder(gate),running=await q.take('running','audio'),controller=new AbortController();
    const cancelled=q.take('cancelled','filmstrip',controller.signal);controller.abort(new Error('ブラウザが取り消しました'));
    await expect(cancelled).rejects.toThrow('ブラウザが取り消しました');expect(gate.stats.waiting).toBe(0);running();
  });
  it('bounds the queue: more urgent work evicts the least urgent waiter, equally urgent work is refused',async()=>{
    const gate=new FfmpegGate(1,1,2),q=recorder(gate),running=await q.take('running','audio');
    const film=q.take('film','filmstrip'),wave=q.take('wave','waveform');
    await expect(q.take('film-2','filmstrip')).rejects.toBeInstanceOf(FfmpegBusyError);
    const audio=q.take('audio','audio');await expect(film).rejects.toBeInstanceOf(FfmpegBusyError);
    running();(await audio)();(await wave)();expect(q.started).toEqual(['running','audio','wave']);
  });
  it('moves a shared preparation forward when playback joins work a waveform started',async()=>{
    const gate=new FfmpegGate(1,1,8),registry=new SharedPreparations<string>(),started:string[]=[],running=await gate.acquire(ffmpegLane('audio'));
    const work=(name:string)=>(signal:AbortSignal,lane:FfmpegLane)=>gate.acquire(lane,signal).then(release=>{started.push(name);release();return name;});
    const other=registry.get('other',work('other'),undefined,'waveform'),pcm=registry.get('pcm',work('pcm'),undefined,'waveform');
    await Promise.resolve();
    const playback=registry.get('pcm',work('pcm'),undefined,'audio');
    running();await Promise.all([other,pcm,playback]);expect(started).toEqual(['pcm','other']);
  });
});
