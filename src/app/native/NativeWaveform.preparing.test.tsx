/** @vitest-environment jsdom */
import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,render,waitFor} from '@testing-library/react';
import {NativeWaveform} from './NativeWaveform';
import {ScenePlan} from '../../core/sequence/scenePlan';
import type {SequenceDocument} from '../../core/sequence/model';
import {rational as r} from '../../core/sequence/time';
vi.mock('../layout/useThemeValue',()=>({useThemeValue:()=>'light'}));
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();});
function doc():SequenceDocument{const content={kind:'audio' as const,assetId:'source',streamIndex:0,rate:r(1),sourceIn:r(0),role:'music' as const,loop:false,settings:{gainDb:0,muted:false,fadeInFrames:0,fadeOutFrames:0}};
  return {schemaVersion:2,id:'wave',name:'wave',revision:0,fps:r(30),resolution:{width:640,height:360},sequenceEndFrame:60,background:'#000000',ducking:{enabled:false,strength:'mid'},transitions:[],transcripts:[],
    tracks:[{id:'a',name:'audio',kind:'audio',enabled:true}],assets:[{id:'source',kind:'media',file:'public/source.wav',name:'source',fingerprint:'source',streams:[{index:0,kind:'audio',codec:'pcm',duration:r(60),sampleRate:48000,channels:2}]}],
    clips:['one','two'].map((id,i)=>({id,name:id,trackId:'a',startFrame:i*30,durationFrames:30,clock:{offset:r(0),rate:r(1),duration:r(30)},content}))};}
it('releases the connection while preparing and asks once per poll for both clips of that source',async()=>{
  vi.spyOn(HTMLCanvasElement.prototype,'getContext').mockReturnValue({clearRect:vi.fn(),fillRect:vi.fn(),fillStyle:''} as unknown as CanvasRenderingContext2D);
  let ready=false;const paths:string[]=[];
  vi.stubGlobal('fetch',vi.fn(async(input:string)=>{const url=new URL(input,'http://localhost');paths.push(url.pathname);
    if(url.pathname==='/api/sequence/waveform/status'){const state=ready?'ready':'preparing';return {ok:true,json:async()=>({preparations:{[url.searchParams.get('preparation')!]:{state}}})};}
    if(!ready)return {ok:true,json:async()=>({state:'preparing',preparationId:'a'.repeat(32)})};
    const q=url.searchParams,n=(key:string)=>Number(q.get(key));
    const request={assetId:q.get('asset'),streamIndex:n('stream'),rate:r(n('rateNum'),n('rateDen')),sourceIn:r(n('sourceInNum'),n('sourceInDen')),fps:r(n('fpsNum'),n('fpsDen')),startFrame:n('startFrame'),frameCount:n('frameCount'),clipFrames:n('clipFrames'),bins:n('bins'),loop:q.get('loop')==='1'};
    return {ok:true,json:async()=>({state:'ready',version:1,precision:'prepared-pcm-sample-floor',sampleRate:48000,sourceSampleCount:192000,request,bins:Array.from({length:request.bins},()=>({peak:.5,rms:.25,samples:1600}))})};
  }));
  const document=doc(),plan=new ScenePlan(document),status=()=>paths.filter(path=>path==='/api/sequence/waveform/status').length;
  const view=render(<>{document.clips.map((clip,i)=><NativeWaveform key={clip.id} projectId="p" clip={clip} plan={plan} viewport={{startFrame:0,frameCount:30,left:0,width:60,bins:2+i}} height={20} displayGain={1} sourceOffsetFrames={0} displayDuration={30}/>)}</>);
  await waitFor(()=>expect(status()).toBeGreaterThan(0),{timeout:3000});
  expect(view.getAllByRole('img').map(canvas=>canvas.getAttribute('data-native-waveform'))).toEqual(['loading','loading']);
  const before=status();ready=true;
  await waitFor(()=>expect(view.getAllByRole('img').map(canvas=>canvas.getAttribute('data-native-waveform'))).toEqual(['ready','ready']),{timeout:3000});
  expect(status()-before).toBe(1);
});
function readyBody(url:URL){
  const q=url.searchParams,n=(key:string)=>Number(q.get(key));
  const request={assetId:q.get('asset'),streamIndex:n('stream'),rate:r(n('rateNum'),n('rateDen')),sourceIn:r(n('sourceInNum'),n('sourceInDen')),fps:r(n('fpsNum'),n('fpsDen')),startFrame:n('startFrame'),frameCount:n('frameCount'),clipFrames:n('clipFrames'),bins:n('bins'),loop:q.get('loop')==='1'};
  return {state:'ready',version:1,precision:'prepared-pcm-sample-floor',sampleRate:48000,sourceSampleCount:192000,request,bins:Array.from({length:request.bins},()=>({peak:.5,rms:.25,samples:1600}))};
}
it('waits and asks again when the server is busy (503) instead of showing a failure',async()=>{
  vi.spyOn(HTMLCanvasElement.prototype,'getContext').mockReturnValue({clearRect:vi.fn(),fillRect:vi.fn(),fillStyle:''} as unknown as CanvasRenderingContext2D);
  // 前の試験の波形はブラウザ側で共有されているので、別の区間（ビン数5）で問う。
  let busy=1;const paths:string[]=[];
  vi.stubGlobal('fetch',vi.fn(async(input:string)=>{const url=new URL(input,'http://localhost');paths.push(url.pathname);
    if(busy-->0)return {ok:false,status:503,json:async()=>({error:'処理が混み合っています。少し待ってからもう一度お試しください'})};
    return {ok:true,status:200,json:async()=>readyBody(url)};}));
  const document=doc(),plan=new ScenePlan(document);
  const view=render(<NativeWaveform projectId="p" clip={document.clips[0]!} plan={plan} viewport={{startFrame:0,frameCount:30,left:0,width:60,bins:5}} height={20} displayGain={1} sourceOffsetFrames={0} displayDuration={30}/>);
  await waitFor(()=>expect(view.getByRole('img').getAttribute('data-native-waveform')).toBe('ready'),{timeout:3000});
  expect(paths).toEqual(['/api/sequence/waveform','/api/sequence/waveform']);
});
