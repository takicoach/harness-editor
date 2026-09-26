/** @vitest-environment jsdom */
import {afterEach,expect,it,vi} from 'vitest';
import {act,cleanup,render} from '@testing-library/react';
import {NativeWaveform} from './NativeWaveform';
import {ScenePlan} from '../../core/sequence/scenePlan';
import type {SequenceDocument} from '../../core/sequence/model';

vi.mock('../layout/useThemeValue',()=>({useThemeValue:()=> 'light'}));
afterEach(()=>{cleanup();vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllGlobals();});

function setup(){
  vi.useFakeTimers();
  const document:SequenceDocument={schemaVersion:2,id:'request-order',name:'Request order',revision:0,
    fps:{num:30,den:1},resolution:{width:640,height:360},sequenceEndFrame:300,background:'#000000',
    ducking:{enabled:false,strength:'mid'},transitions:[],transcripts:[],
    assets:[{id:'source',kind:'media',file:'public/source.wav',name:'source',fingerprint:'source',
      streams:[{index:1,kind:'audio',codec:'pcm',duration:{num:10,den:1},sampleRate:48000,channels:2}]}],
    tracks:[{id:'sound',name:'Sound',kind:'audio',enabled:true}],
    clips:[{id:'sound-1',name:'Sound 1',trackId:'sound',startFrame:0,durationFrames:300,
      clock:{offset:{num:0,den:1},rate:{num:1,den:1},duration:{num:300,den:1}},
      content:{kind:'audio',assetId:'source',streamIndex:1,sourceIn:{num:0,den:1},rate:{num:1,den:1},role:'music',loop:false,
        settings:{gainDb:0,muted:false,fadeInFrames:0,fadeOutFrames:0}}}]};
  const fillRect=vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype,'getContext').mockReturnValue({clearRect:vi.fn(),fillRect,fillStyle:''} as unknown as CanvasRenderingContext2D);
  // Deliberately ignore abort: a server/body may finish after cancellation.
  const pending:{url:string;signal:AbortSignal;resolve:(value:unknown)=>void;reject:(error:Error)=>void}[]=[];
  vi.stubGlobal('fetch',vi.fn((url:string,options:{signal:AbortSignal})=>new Promise((resolve,reject)=>{
    pending.push({url,signal:options.signal,resolve,reject});
  })));
  const props={projectId:crypto.randomUUID(),clip:document.clips[0]!,plan:new ScenePlan(document),
    viewport:{startFrame:0,frameCount:30,bins:2,left:0,width:60},height:20,displayGain:1,sourceOffsetFrames:0,displayDuration:300};
  const finish=(index:number,peak:number)=>{
    const item=pending[index]!,q=new URL(item.url,'http://localhost').searchParams,n=(key:string)=>Number(q.get(key));
    item.resolve({ok:true,json:async()=>({version:1,precision:'prepared-pcm-sample-floor',sampleRate:48000,sourceSampleCount:480000,
      request:{assetId:q.get('asset'),streamIndex:n('stream'),rate:{num:n('rateNum'),den:n('rateDen')},sourceIn:{num:n('sourceInNum'),den:n('sourceInDen')},
        fps:{num:n('fpsNum'),den:n('fpsDen')},startFrame:n('startFrame'),frameCount:n('frameCount'),clipFrames:n('clipFrames'),bins:n('bins'),loop:q.get('loop')==='1'},
      bins:Array.from({length:n('bins')},()=>({peak,rms:peak/2,samples:24000}))})});
  };
  return {props,pending,finish,fillRect};
}

it.each(['success','failure'] as const)('ignores an obsolete %s arriving after the new visible interval',async outcome=>{
  const {props,pending,finish,fillRect}=setup(),view=render(<NativeWaveform {...props}/>);
  await act(async()=>{await vi.advanceTimersByTimeAsync(121);});
  expect(pending).toHaveLength(1);
  view.rerender(<NativeWaveform {...props} viewport={{...props.viewport,startFrame:60,left:120}}/>);
  expect(pending[0]!.signal.aborted).toBe(true);
  await act(async()=>{await vi.advanceTimersByTimeAsync(121);});
  expect(pending).toHaveLength(2);
  await act(async()=>{finish(1,.25);});
  expect(view.getByRole('img').getAttribute('data-native-waveform')).toBe('ready');
  expect(fillRect.mock.calls.map(call=>call[3])).toEqual([5,5,2.5,2.5]);
  const currentPaint=fillRect.mock.calls.slice();
  await act(async()=>{if(outcome==='success')finish(0,.9);else pending[0]!.reject(new Error('obsolete failure'));});
  expect(fillRect.mock.calls).toEqual(currentPaint);
  expect(view.getByRole('img').getAttribute('data-waveform-start')).toBe('60');
  expect(view.getByRole('img').getAttribute('data-native-waveform')).toBe('ready');
  expect(view.queryByRole('button')).toBeNull();
});

it('clears the previous project wave while loading and cancels the new request on unmount',async()=>{
  const {props,pending,finish,fillRect}=setup(),view=render(<NativeWaveform {...props}/>);
  await act(async()=>{await vi.advanceTimersByTimeAsync(121);finish(0,.75);});
  expect(view.getByRole('img').getAttribute('data-native-waveform')).toBe('ready');
  fillRect.mockClear();
  view.rerender(<NativeWaveform {...props} projectId="second-project"/>);
  expect(view.getByRole('img').getAttribute('data-native-waveform')).toBe('loading');
  expect(fillRect).not.toHaveBeenCalled();
  await act(async()=>{await vi.advanceTimersByTimeAsync(121);});
  expect(new URL(pending[1]!.url,'http://localhost').searchParams.get('id')).toBe('second-project');
  view.unmount();expect(pending[1]!.signal.aborted).toBe(true);
  await act(async()=>{finish(1,.9);});
  expect(fillRect).not.toHaveBeenCalled();
});
