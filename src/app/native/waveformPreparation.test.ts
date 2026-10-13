/** @vitest-environment jsdom */
import {afterEach,expect,it,vi} from 'vitest';
import {waitForWaveformPreparation,WAVEFORM_POLL_MS} from './waveformPreparation';
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();});
it('asks once per poll for every waiting preparation of a project, and settles each by its own state',async()=>{
  vi.useFakeTimers();const urls:string[]=[];
  vi.stubGlobal('fetch',vi.fn(async(input:string)=>{urls.push(input);const ids=new URL(input,'http://localhost').searchParams.get('preparation')!.split(',');
    return {ok:true,json:async()=>({preparations:Object.fromEntries(ids.map(id=>[id,id.startsWith('a')?{state:'ready'}:id.startsWith('b')?{state:'failed',error:'壊れた音声'}:{state:'missing'}]))})};}));
  const signal=new AbortController().signal,a='a'.repeat(32),b='b'.repeat(32),c='c'.repeat(32);
  const ready=waitForWaveformPreparation('p',a,signal),same=waitForWaveformPreparation('p',a,signal),failed=waitForWaveformPreparation('p',b,signal),missing=waitForWaveformPreparation('p',c,signal);
  const rejected=expect(failed).rejects.toThrow('壊れた音声');
  await vi.advanceTimersByTimeAsync(WAVEFORM_POLL_MS);
  expect(urls).toHaveLength(1);expect(new URL(urls[0]!,'http://localhost').searchParams.get('preparation')!.split(',').sort()).toEqual([a,b,c]);
  expect(await ready).toBe('ready');expect(await same).toBe('ready');expect(await missing).toBe('missing');await rejected;
});
it('stops asking for a preparation nobody waits for any more',async()=>{
  vi.useFakeTimers();const fetch=vi.fn(async()=>({ok:true,json:async()=>({preparations:{}})}));vi.stubGlobal('fetch',fetch);
  const controller=new AbortController(),waiting=waitForWaveformPreparation('p','d'.repeat(32),controller.signal);
  controller.abort(new Error('画面から外れた'));await expect(waiting).rejects.toThrow('画面から外れた');
  await vi.advanceTimersByTimeAsync(WAVEFORM_POLL_MS*2);expect(fetch).not.toHaveBeenCalled();
});
it('keeps a single status poll while an answer takes longer than the poll interval',async()=>{
  vi.useFakeTimers();const answers:Array<(value:unknown)=>void>=[],fetch=vi.fn(()=>new Promise(resolve=>{answers.push(resolve);}));vi.stubGlobal('fetch',fetch);
  const controller=new AbortController(),e='e'.repeat(32),f='f'.repeat(32),first=waitForWaveformPreparation('p',e,controller.signal);
  await vi.advanceTimersByTimeAsync(WAVEFORM_POLL_MS);expect(fetch).toHaveBeenCalledTimes(1);
  const second=waitForWaveformPreparation('p',f,controller.signal);
  await vi.advanceTimersByTimeAsync(WAVEFORM_POLL_MS*3);expect(fetch).toHaveBeenCalledTimes(1);
  answers[0]!({ok:true,json:async()=>({preparations:{[e]:{state:'ready'}}})});expect(await first).toBe('ready');
  await vi.advanceTimersByTimeAsync(WAVEFORM_POLL_MS);expect(fetch).toHaveBeenCalledTimes(2);
  const left=expect(second).rejects.toThrow('画面から外れた');controller.abort(new Error('画面から外れた'));await left;
  answers[1]!({ok:true,json:async()=>({preparations:{}})});await vi.advanceTimersByTimeAsync(WAVEFORM_POLL_MS*2);expect(fetch).toHaveBeenCalledTimes(2);
});
