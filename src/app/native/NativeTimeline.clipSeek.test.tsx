/** @vitest-environment jsdom */
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render} from '@testing-library/react';
import type {ComponentProps} from 'react';
import {NativeTimeline} from './NativeTimeline';
import type {SequenceDocument} from '../../core/sequence/model';
import {rational as r} from '../../core/sequence/time';

beforeEach(()=>{
  vi.stubGlobal('requestAnimationFrame',()=>1);vi.stubGlobal('cancelAnimationFrame',()=>{});
  vi.stubGlobal('ResizeObserver',class{observe(){} disconnect(){}});
  vi.stubGlobal('PointerEvent',class extends MouseEvent{pointerId:number;constructor(type:string,init:PointerEventInit={}){super(type,init);this.pointerId=init.pointerId??1;}});
  HTMLElement.prototype.setPointerCapture=vi.fn();HTMLElement.prototype.releasePointerCapture=vi.fn();
  HTMLElement.prototype.hasPointerCapture=()=>true;
  Object.defineProperty(document,'elementFromPoint',{configurable:true,value:()=>null});
});
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();});
function fixture():SequenceDocument{return {schemaVersion:2,id:'doc',name:'seek',revision:0,fps:r(30),resolution:{width:320,height:180},sequenceEndFrame:3000,
  background:'#000',assets:[],transcripts:[],transitions:[],ducking:{enabled:false,strength:'mid'},tracks:[{id:'v',kind:'visual',name:'字幕',enabled:true}],
  clips:[{id:'c',trackId:'v',name:'字幕A',startFrame:300,durationFrames:100,clock:{offset:r(0),rate:r(1),duration:r(100)},content:{kind:'telop',data:{text:'A'}}}]};}
type Props=ComponentProps<typeof NativeTimeline>;
function setup(extra:Partial<Props>={}){
  const props:Props={projectId:'p',document:fixture(),waveform:'standard',frame:0,selected:[],range:null,tool:'select',zoom:1,snap:false,
    onSelect:vi.fn(),onRange:vi.fn(),onSeek:vi.fn(),onDrop:vi.fn(),onCommand:vi.fn(async()=>true),...extra};
  const ui=render(<NativeTimeline {...props}/>),scroller=ui.getByLabelText('タイムライン');
  Object.defineProperties(scroller,{clientWidth:{configurable:true,value:1000},clientHeight:{configurable:true,value:300},scrollWidth:{configurable:true,value:4000}});
  scroller.getBoundingClientRect=()=>({left:0,right:1000,top:0,bottom:300,width:1000,height:300,x:0,y:0,toJSON(){}});
  return {ui,props,clip:()=>ui.container.querySelector<HTMLElement>('[data-native-clip-id="c"]')!};
}
const down=(node:Element,x:number,init:Partial<PointerEventInit>={})=>fireEvent.pointerDown(node,{button:0,buttons:1,pointerId:1,clientX:x,clientY:60,...init});

it('クリック確定でクリップの可視中点へ送る',async()=>{
  const t=setup();down(t.clip(),440);
  expect(t.props.onSeek).not.toHaveBeenCalled();      // pointerdown では送らない
  await act(async()=>fireEvent.pointerUp(window,{button:0,pointerId:1,clientX:440,clientY:60}));
  expect(t.props.onSeek).toHaveBeenCalledWith(350);
});
it('ドラッグで動かしたときは送らない',async()=>{
  const t=setup();down(t.clip(),440);
  fireEvent.pointerMove(window,{buttons:1,pointerId:1,clientX:540,clientY:60});
  await act(async()=>fireEvent.pointerUp(window,{button:0,pointerId:1,clientX:540,clientY:60}));
  expect(t.props.onSeek).not.toHaveBeenCalled();
});
it('再生中は送らない',async()=>{
  const t=setup({playing:true});down(t.clip(),440);
  await act(async()=>fireEvent.pointerUp(window,{button:0,pointerId:1,clientX:440,clientY:60}));
  expect(t.props.onSeek).not.toHaveBeenCalled();
});
it('Shift の追加選択では送らない',async()=>{
  const t=setup({selected:['other']});down(t.clip(),440,{shiftKey:true});
  await act(async()=>fireEvent.pointerUp(window,{button:0,pointerId:1,clientX:440,clientY:60}));
  expect(t.props.onSeek).not.toHaveBeenCalled();
});
it('カット前を確認中は送らない（marker の有無ではなく active で判定。M-8）',async()=>{
  const t=setup({cutSourceActive:true});down(t.clip(),440);
  await act(async()=>fireEvent.pointerUp(window,{button:0,pointerId:1,clientX:440,clientY:60}));
  expect(t.props.onSeek).not.toHaveBeenCalled();
});

it('カット確認中は送らない',async()=>{
  const t=setup({activeCutId:'entry'});down(t.clip(),440);
  await act(async()=>fireEvent.pointerUp(window,{button:0,pointerId:1,clientX:440,clientY:60}));
  expect(t.props.onSeek).not.toHaveBeenCalled();
});
it('トリムハンドルでは送らない',async()=>{
  const t=setup();const edge=t.ui.getByRole('button',{name:'字幕Aの終了位置を調整'});
  down(edge,440);
  await act(async()=>fireEvent.pointerUp(window,{button:0,pointerId:1,clientX:440,clientY:60}));
  expect(t.props.onSeek).not.toHaveBeenCalled();
});
it('すでに区間内にいるときは送らない',async()=>{
  const t=setup({frame:350});down(t.clip(),440);
  await act(async()=>fireEvent.pointerUp(window,{button:0,pointerId:1,clientX:440,clientY:60}));
  expect(t.props.onSeek).not.toHaveBeenCalled();
});
