/** @vitest-environment jsdom */
// src/app/native/NativePreview.transport.test.tsx
import {createRef} from 'react';
import {act,cleanup,fireEvent,render,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {NativePreview,type NativePreviewHandle} from './NativePreview';
import type {SequenceDocument} from '../../core/sequence/model';
import {rational as r} from '../../core/sequence/time';

// NativePreview.playbackRate.test.tsx と同じ最小モック（描画ブリッジと音声トランスポートを差し替える）。
const state=vi.hoisted(()=>({resume:vi.fn(),renderGate:vi.fn(),tick:null as FrameRequestCallback|null,transports:[] as Array<{playbackRate:number;sample:number;isPlaying:boolean}>}));
vi.mock('../../preview/native/previewBridge',()=>({NativePreviewBridge:class {
  async render(plan:{document:SequenceDocument},frame:number){await state.renderGate();return {documentId:plan.document.id,revision:plan.document.revision,frame,resolution:plan.document.resolution,videos:[]};}
  dispose(){}clear(){}
}}));
vi.mock('../../preview/native/audioTransport',()=>({NativeAudioTransport:class {
  sample=0;isPlaying=false;
  constructor(readonly context:{sampleRate:number},_plan:unknown,_pcm:unknown,_error:(error:Error)=>void,readonly playbackRate=1){state.transports.push(this);}
  seek(sample:number){this.sample=sample;}currentSample(){return this.sample;}presentationSample(){return this.sample;}
  async play(){this.isPlaying=true;}pause(){this.isPlaying=false;}dispose(){this.pause();}
}}));
const document:SequenceDocument={schemaVersion:2,id:'transport',name:'検証',revision:0,fps:r(30),resolution:{width:320,height:180},sequenceEndFrame:300,
  background:'#000000',assets:[],tracks:[],clips:[],transitions:[],transcripts:[],ducking:{enabled:false,strength:'mid'}};
beforeEach(()=>{
  vi.stubGlobal('ResizeObserver',class {observe(){}disconnect(){}});
  vi.stubGlobal('requestAnimationFrame',(callback:FrameRequestCallback)=>{state.tick=callback;return 1;});
  vi.stubGlobal('cancelAnimationFrame',()=>{});
  vi.stubGlobal('AudioContext',class {sampleRate=48000;resume(){return state.resume();}async close(){}});
});
afterEach(()=>{cleanup();state.transports=[];state.tick=null;vi.unstubAllGlobals();vi.resetAllMocks();});
async function mount(onShuttle?:(key:'j'|'l')=>void){
  const ref=createRef<NativePreviewHandle>();
  const view=render(<NativePreview ref={ref} projectId="transport" document={document} onFrame={()=>{}} bypassLut={false} onShuttle={onShuttle}/>);
  await waitFor(()=>expect((view.getByLabelText('再生') as HTMLButtonElement).disabled).toBe(false));
  return {ref,view};
}

it('7 つのトランスポートボタンとシークバーを常に出す',async()=>{
  const {view}=await mount();
  for(const name of ['先頭へ','逆再生','再生','順再生','末尾へ'])expect(view.getByLabelText(name)).toBeTruthy();
  for(const title of ['1フレーム戻る（←）','1フレーム進む（→）'])expect(view.getByTitle(title)).toBeTruthy();
  expect(view.getByLabelText('シークバー')).toBeTruthy();
  expect(view.queryByLabelText('確認用の再生速度')).toBeNull();
});

it('タイムコードは MM:SS:FF のまま、総尺（300 フレーム＝10 秒）を同じ書式で隣に出す',async()=>{
  const {view}=await mount();
  expect(view.getByLabelText('再生位置').textContent).toBe('00:00:00');
  expect(view.container.querySelector('.native-timecode-total')!.textContent).toBe('/ 00:10:00');
});

it('速度バッジは再生中だけ出て、向きと倍率を示す',async()=>{
  const {ref,view}=await mount();
  const badge=()=>view.container.querySelector<HTMLElement>('.native-rate-badge')!;
  expect(badge().dataset['direction']).toBeUndefined();
  await act(async()=>{ref.current!.setPlaybackRate(4);await ref.current!.play();});
  expect(badge().textContent).toBe('▶▶ 4x');expect(badge().dataset['direction']).toBe('forward');
  expect(view.container.querySelector('.native-rate-overlay')!.textContent).toBe('▶▶ 4x');
  await act(async()=>{ref.current!.setPlaybackRate(-1);});
  expect(badge().textContent).toBe('◀◀ 1x');expect(badge().dataset['direction']).toBe('reverse');
  await act(async()=>{ref.current!.setPlaybackRate(0.5);});
  expect(badge().textContent).toBe('▶ 0.5x');
  await act(async()=>{ref.current!.pause();});
  expect(badge().dataset['direction']).toBeUndefined();
  expect(view.container.querySelector('.native-rate-overlay')).toBeNull();
});

it('再生ボタンは再生中に data-playing を持ち、J / L ボタンは onShuttle を呼ぶ',async()=>{
  const onShuttle=vi.fn();const {ref,view}=await mount(onShuttle);
  expect(view.getByLabelText('再生').getAttribute('data-playing')).toBe('false');
  await act(async()=>ref.current!.play());
  expect(view.getByLabelText('一時停止').getAttribute('data-playing')).toBe('true');
  fireEvent.click(view.getByLabelText('順再生'));fireEvent.click(view.getByLabelText('逆再生'));
  expect(onShuttle.mock.calls).toEqual([['l'],['j']]);
});

it('onShuttle が無い経路（legacy ブリッジ）では J / L ボタンを無効にする',async()=>{
  const {view}=await mount();
  expect((view.getByLabelText('逆再生') as HTMLButtonElement).disabled).toBe(true);
  expect((view.getByLabelText('順再生') as HTMLButtonElement).disabled).toBe(true);
  cleanup();
  const wired=await mount(()=>{});
  expect((wired.view.getByLabelText('順再生') as HTMLButtonElement).disabled).toBe(false);
});
