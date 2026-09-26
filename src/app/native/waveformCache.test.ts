import {expect,it,vi} from 'vitest';
import {acquireWaveform} from './waveformCache';
import type {WaveformResponse} from '../../server/sequence/waveform';
it('shares concurrent work and retains completed envelopes when consumers leave',async()=>{
 let finish!:(data:WaveformResponse)=>void;
 const fetcher=vi.fn(()=>new Promise<WaveformResponse>(resolve=>{finish=resolve;}));
 const a=acquireWaveform('shared',fetcher),b=acquireWaveform('shared',fetcher);
 expect(fetcher).toHaveBeenCalledTimes(1);a.release();expect(fetcher.mock.calls[0]).toBeDefined();
 const data={bins:[]} as unknown as WaveformResponse;finish(data);
 expect(await b.promise).toBe(data);b.release();const c=acquireWaveform('shared',fetcher);
 expect(await c.promise).toBe(data);expect(fetcher).toHaveBeenCalledTimes(1);c.release();
});
it('aborts obsolete work only after all owners release and allows retry',async()=>{
 const fetcher=vi.fn((signal:AbortSignal)=>new Promise<WaveformResponse>((_,reject)=>signal.addEventListener('abort',()=>reject(new Error('aborted')))));
 const a=acquireWaveform('cancel',fetcher),b=acquireWaveform('cancel',fetcher);
 const result=a.promise.catch(error=>error.message);
 a.release();expect(fetcher.mock.calls[0]![0].aborted).toBe(false);b.release();expect(await result).toBe('aborted');
 const c=acquireWaveform('cancel',fetcher),end=c.promise.catch(error=>error.message);expect(fetcher).toHaveBeenCalledTimes(2);c.release();await end;
});
