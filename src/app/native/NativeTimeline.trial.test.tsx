/** @vitest-environment jsdom */
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render} from '@testing-library/react';
import {NativeTimeline} from './NativeTimeline';
import type {SequenceDocument} from '../../core/sequence/model';
import {rational as r} from '../../core/sequence/time';

vi.mock('../timeline/useFilmstrip',()=>({useFilmstrip:()=>[],STRIP_THUMB_PX:80}));
vi.mock('../audio/useWaveformSamples',()=>({useWaveformSamples:()=>({samples:null,failed:false})}));
beforeEach(()=>{
  vi.stubGlobal('requestAnimationFrame',()=>1);vi.stubGlobal('cancelAnimationFrame',()=>{});
  vi.stubGlobal('ResizeObserver',class{observe(){}disconnect(){}});
  vi.spyOn(HTMLCanvasElement.prototype,'getContext').mockReturnValue(null);
});
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();});

function fixture():SequenceDocument{
  const clock=(n:number)=>({offset:r(0),rate:r(1),duration:r(n)});
  return {schemaVersion:2,id:'doc',name:'fixture',revision:0,fps:r(30),resolution:{width:320,height:180},sequenceEndFrame:180,background:'#000',
    transcripts:[],transitions:[],ducking:{enabled:false,strength:'mid'},
    assets:[{id:'img',kind:'image',file:'public/images/a.png',name:'図',fingerprint:'a'.repeat(64),streams:[]},
      {id:'song',kind:'media',file:'public/BGM/a.m4a',name:'曲',fingerprint:'b'.repeat(64),streams:[{index:0,kind:'audio',codec:'aac',sampleRate:48000,channels:2,duration:r(10)}]}],
    tracks:[{id:'v',kind:'visual',name:'挿入',enabled:true},{id:'m',kind:'audio',name:'音楽',enabled:true}],
    clips:[{id:'pic',trackId:'v',name:'図',startFrame:60,durationFrames:60,clock:clock(60),content:{kind:'image',assetId:'img',style:'plain'}},
      {id:'bgm',trackId:'m',name:'BGM',startFrame:0,durationFrames:180,clock:clock(180),content:{kind:'audio',assetId:'song',streamIndex:0,sourceIn:r(0),rate:r(1),role:'music',loop:false,
        settings:{gainDb:-12,muted:false,fadeInFrames:0,fadeOutFrames:0}}}]};
}

it.each(['edit','finish'])('%s: 試し中のクリップに印（class と読み上げ名の末尾）を付け、他は付けない',mode=>{
  const view=render(<NativeTimeline projectId="p" document={fixture()} waveform="standard" frame={0} selected={['pic']} range={null} tool="select" zoom={1} snap={false} mode={mode}
    trialClipIds={['pic']} onSelect={vi.fn()} onRange={vi.fn()} onSeek={vi.fn()} onDrop={vi.fn()} onCommand={vi.fn(async()=>true)} onZoomChange={vi.fn()}/>);
  const trial=view.getByRole('button',{name:'図 60〜120フレーム（試し中）'});
  expect(trial.classList.contains('native-clip-trial')).toBe(true);
  const other=view.getByRole('button',{name:'BGM 0〜180フレーム'});
  expect(other.classList.contains('native-clip-trial')).toBe(false);
});

it('trialClipIds が無ければ印を付けない',()=>{
  const view=render(<NativeTimeline projectId="p" document={fixture()} waveform="standard" frame={0} selected={[]} range={null} tool="select" zoom={1} snap={false}
    onSelect={vi.fn()} onRange={vi.fn()} onSeek={vi.fn()} onDrop={vi.fn()} onCommand={vi.fn(async()=>true)} onZoomChange={vi.fn()}/>);
  expect(view.getByRole('button',{name:'図 60〜120フレーム'}).classList.contains('native-clip-trial')).toBe(false);
  expect(view.container.querySelector('.native-clip-trial')).toBeNull();
});

/** 試し中（editLocked）: クリップの移動・伸縮・分割・トラック編集は止めて知らせ、選択・再生位置の移動・スクラブは通す（設計 §3-8）。 */
function locked(extra:Record<string,unknown>={}){
  vi.stubGlobal('PointerEvent',class extends MouseEvent{pointerId:number;constructor(type:string,init:PointerEventInit={}){super(type,init);this.pointerId=init.pointerId??1;}});
  HTMLElement.prototype.setPointerCapture=vi.fn();HTMLElement.prototype.releasePointerCapture=vi.fn();HTMLElement.prototype.hasPointerCapture=()=>true;
  Object.defineProperty(document,'elementFromPoint',{configurable:true,value:()=>null});
  const props={projectId:'p',document:fixture(),waveform:'standard' as const,frame:0,selected:[] as string[],range:null,tool:'select' as const,zoom:1,snap:false,ripple:false,
    onSelect:vi.fn(),onRange:vi.fn(),onSeek:vi.fn(),onDrop:vi.fn(),onCommand:vi.fn(async()=>true),onZoomChange:vi.fn(),editLocked:true,onEditLocked:vi.fn(),...extra};
  const ui=render(<NativeTimeline {...props}/>),scroller=ui.getByLabelText('タイムライン');
  Object.defineProperties(scroller,{clientWidth:{configurable:true,value:1000},clientHeight:{configurable:true,value:300},scrollWidth:{configurable:true,value:4000}});
  scroller.getBoundingClientRect=()=>({left:0,right:1000,top:0,bottom:300,width:1000,height:300,x:0,y:0,toJSON(){}});
  return {ui,props,clip:()=>ui.container.querySelector<HTMLElement>('[data-native-clip-id="pic"]')!};
}
const down=(node:Element,x:number)=>fireEvent.pointerDown(node,{button:0,buttons:1,pointerId:1,clientX:x,clientY:60});
const move=(x:number)=>fireEvent.pointerMove(window,{buttons:1,pointerId:1,clientX:x,clientY:60});
const up=(x:number)=>fireEvent.pointerUp(window,{button:0,pointerId:1,clientX:x,clientY:60});

it('editLocked: クリップのドラッグ・端の調整（ポインタとキー）・分割・トラックの編集は送らずに知らせる',()=>{
  const t=locked();
  down(t.clip(),200);move(320);
  // 動かした時点で取り消して知らせる（離すまでゴーストが付いて動いたように見せない）。
  expect(t.props.onEditLocked).toHaveBeenCalledTimes(1);expect(t.clip().style.opacity).toBe('');
  up(320);
  expect(t.props.onEditLocked).toHaveBeenCalledTimes(1);expect(t.props.onCommand).not.toHaveBeenCalled();
  const trim=t.ui.getByRole('button',{name:'図の開始位置を調整'}) as HTMLButtonElement;
  expect(trim.disabled).toBe(false);
  down(trim,150);expect(t.props.onEditLocked).toHaveBeenCalledTimes(2);up(150);
  fireEvent.keyDown(trim,{key:'ArrowRight'});expect(t.props.onEditLocked).toHaveBeenCalledTimes(3);
  expect((t.ui.getByRole('button',{name:'挿入を無効にする'}) as HTMLButtonElement).disabled).toBe(true);
  expect(t.props.onCommand).not.toHaveBeenCalled();
  cleanup();
  const razor=locked({tool:'razor'});
  down(razor.clip(),razor.clip().getBoundingClientRect().left+5);
  expect(razor.props.onEditLocked).toHaveBeenCalledTimes(1);expect(razor.props.onCommand).not.toHaveBeenCalled();
});

it('editLocked: クリップのクリックでの選択と再生位置の移動、目盛りのスクラブは通す',()=>{
  const t=locked();
  down(t.clip(),200);up(200);
  expect(t.props.onSelect).toHaveBeenCalledWith(['pic']);expect(t.props.onSeek).toHaveBeenCalled();
  t.props.onSeek.mockClear();
  down(t.ui.container.querySelector('.native-ruler')!,500);move(600);up(600);
  expect(t.props.onSeek).toHaveBeenCalled();
  expect(t.props.onEditLocked).not.toHaveBeenCalled();expect(t.props.onCommand).not.toHaveBeenCalled();
});
