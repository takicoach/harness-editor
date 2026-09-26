/** @vitest-environment jsdom */
// src/app/native/NativePreview.manipulationStage.test.tsx
// 修正ラウンド4: NativePreview が NativePreviewManipulation に渡す stage が、
// 「.native-preview-stage 外枠」ではなく「transform: scale() を持つ合成面 div」であることを固定する回帰ガード。
import {forwardRef} from 'react';
import {cleanup,render,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {NativePreview} from './NativePreview';
import type {NativeManipulationBindings} from './NativePreviewManipulation';
import type {SequenceDocument} from '../../core/sequence/model';
import {rational as r} from '../../core/sequence/time';

const captured=vi.hoisted(()=>({stage:null as HTMLElement|null}));
vi.mock('./NativePreviewManipulation',async original=>{
  const actual=await original<typeof import('./NativePreviewManipulation')>();
  return {...actual,
    NativePreviewManipulation:forwardRef<unknown,{stage:{current:HTMLElement|null}}>((props,_ref)=>{
      captured.stage=props.stage.current;
      return null;
    }),
  };
});
vi.mock('../../preview/native/previewBridge',()=>({NativePreviewBridge:class {
  async render(plan:{document:SequenceDocument},frame:number){return {documentId:plan.document.id,revision:plan.document.revision,frame,resolution:plan.document.resolution,videos:[]};}
  dispose(){}clear(){}
}}));
vi.mock('../../preview/native/audioTransport',()=>({NativeAudioTransport:class {
  sample=0;isPlaying=false;
  constructor(readonly context:{sampleRate:number},_plan:unknown,_pcm:unknown,_error:(error:Error)=>void,readonly playbackRate=1){}
  seek(sample:number){this.sample=sample;}currentSample(){return this.sample;}presentationSample(){return this.sample;}
  async play(){this.isPlaying=true;}pause(){this.isPlaying=false;}dispose(){this.pause();}
}}));
const document:SequenceDocument={schemaVersion:2,id:'manip-stage',name:'検証',revision:0,fps:r(30),resolution:{width:320,height:180},sequenceEndFrame:300,
  background:'#000000',assets:[],tracks:[],clips:[],transitions:[],transcripts:[],ducking:{enabled:false,strength:'mid'}};
const manipulation:NativeManipulationBindings={selected:[],disabled:false,externalBusy:false,
  readDocument:()=>null,onBusy:()=>{},prepare:async()=>true,commit:async()=>true,commitShape:async()=>true};
beforeEach(()=>{
  vi.stubGlobal('ResizeObserver',class {observe(){}disconnect(){}});
  vi.stubGlobal('requestAnimationFrame',()=>1);
  vi.stubGlobal('cancelAnimationFrame',()=>{});
  vi.stubGlobal('AudioContext',class {sampleRate=48000;resume(){}async close(){}});
});
afterEach(()=>{cleanup();captured.stage=null;vi.unstubAllGlobals();vi.resetAllMocks();});

it('NativePreviewManipulation には transform 済みの合成面 div を渡す（丸め残差のある外枠ではない）',async()=>{
  const view=render(<NativePreview projectId="manip-stage" document={document} onFrame={()=>{}} bypassLut={false} manipulation={manipulation}/>);
  await waitFor(()=>expect((view.getByLabelText('再生') as HTMLButtonElement).disabled).toBe(false));
  expect(captured.stage).not.toBeNull();
  // 合成面: transform: scale(...) を持つ
  expect(captured.stage!.style.transform).toMatch(/^scale\(/);
  // 外枠 .native-preview-stage の子であること
  expect(captured.stage!.parentElement!.className).toContain('native-preview-stage');
  // 自分自身は外枠クラスを持たない（外枠を誤って渡していないこと）
  expect(captured.stage!.className).not.toContain('native-preview-stage');
});

it('M-7: 実測が取れる環境では合成面の倍率を縦横別に置く（scale(x, y) で x≠y を許容する）',async()=>{
  // jsdom の getBoundingClientRect は 0 を返すため、実測経路（surface）は通常フォールバックのままになる。
  // 外枠を 1/64px の端数込みで実測できるようにして、縦横別倍率が実際に反映されることを固定する。
  const rect=(width:number,height:number)=>({width,height,x:0,y:0,top:0,left:0,right:width,bottom:height,toJSON(){}}) as DOMRect;
  const spy=vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockReturnValue(rect(640.25,360));
  try {
    const view=render(<NativePreview projectId="manip-stage" document={document} onFrame={()=>{}} bypassLut={false} manipulation={manipulation}/>);
    await waitFor(()=>expect((view.getByLabelText('再生') as HTMLButtonElement).disabled).toBe(false));
    expect(captured.stage).not.toBeNull();
    const transform=captured.stage!.style.transform;
    expect(transform).toMatch(/^scale\(/);
    const parsed=transform.match(/^scale\(([-\d.e]+)(?:,\s*([-\d.e]+))?\)$/);
    expect(parsed,`2 引数形ではない: ${transform}`).not.toBeNull();
    expect(parsed![2],`縦倍率が無い: ${transform}`).toBeDefined();
    const x=Number(parsed![1]), y=Number(parsed![2]);
    expect(x).toBeCloseTo(640.25/320,10);
    expect(y).toBeCloseTo(360/180,10);
    expect(x).not.toBe(y);   // 外枠の丸め残差で縦横は一致しない
  } finally { spy.mockRestore(); }
});
