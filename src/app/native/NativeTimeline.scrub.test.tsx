/** @vitest-environment jsdom */
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render} from '@testing-library/react';
import {createRef,type ComponentProps} from 'react';
import {NativeTimeline,type NativeTimelineHandle} from './NativeTimeline';
import type {SequenceDocument} from '../../core/sequence/model';
import {rational as r} from '../../core/sequence/time';

let frames:Map<number,FrameRequestCallback>,serial:number;
beforeEach(()=>{
  frames=new Map();serial=0;
  vi.stubGlobal('requestAnimationFrame',(fn:FrameRequestCallback)=>{frames.set(++serial,fn);return serial;});
  vi.stubGlobal('cancelAnimationFrame',(id:number)=>frames.delete(id));
  vi.stubGlobal('ResizeObserver',class{observe(){} disconnect(){}});
  vi.stubGlobal('PointerEvent',class extends MouseEvent{pointerId:number;constructor(type:string,init:PointerEventInit={}){super(type,init);this.pointerId=init.pointerId??1;}});
  HTMLElement.prototype.setPointerCapture=vi.fn();HTMLElement.prototype.releasePointerCapture=vi.fn();
  HTMLElement.prototype.hasPointerCapture=()=>true;
  Object.defineProperty(document,'elementFromPoint',{configurable:true,value:()=>null});
});
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();});
function advance(count=1){for(let i=0;i<count;i++)act(()=>{const queued=[...frames.values()];frames.clear();queued.forEach(fn=>fn((serial+1)*16.667));});}
function fixture(endFrame=3000):SequenceDocument{return {schemaVersion:2,id:'doc',name:'scrub',revision:0,fps:r(30),resolution:{width:320,height:180},sequenceEndFrame:endFrame,
  background:'#000',assets:[],transcripts:[],transitions:[],ducking:{enabled:false,strength:'mid'},tracks:[{id:'v',kind:'visual',name:'字幕',enabled:true}],clips:[]};}
type Props=ComponentProps<typeof NativeTimeline>;
function setup(extra:Partial<Props>={}){
  const props:Props={projectId:'p',document:fixture(),waveform:'standard',frame:0,selected:[],range:null,tool:'select',zoom:1,snap:false,
    onSelect:vi.fn(),onRange:vi.fn(),onSeek:vi.fn(),onDrop:vi.fn(),onCommand:vi.fn(async()=>true),...extra};
  const ui=render(<NativeTimeline {...props}/>),scroller=ui.getByLabelText('タイムライン');
  Object.defineProperties(scroller,{clientWidth:{configurable:true,value:1000},clientHeight:{configurable:true,value:300},scrollWidth:{configurable:true,value:4000}});
  scroller.getBoundingClientRect=()=>({left:0,right:1000,top:0,bottom:300,width:1000,height:300,x:0,y:0,toJSON(){}});
  return {ui,props,scroller,
    ruler:()=>ui.container.querySelector<HTMLElement>('.native-ruler')!,
    track:()=>ui.container.querySelector<HTMLElement>('[data-native-track="v"]')!};
}
const down=(node:Element,x:number,button=0)=>fireEvent.pointerDown(node,{button,buttons:button===0?1:2,pointerId:1,clientX:x,clientY:60});
const move=(x:number)=>fireEvent.pointerMove(window,{buttons:1,pointerId:1,clientX:x,clientY:60});
const up=(x:number)=>fireEvent.pointerUp(window,{button:0,pointerId:1,clientX:x,clientY:60});

it('ルーラーの単クリックで pointerdown の時点でシークする',()=>{
  const t=setup();down(t.ruler(),432);
  expect(t.props.onSeek).toHaveBeenCalledWith(300);
  up(432);expect(t.props.onRange).not.toHaveBeenCalledWith(expect.objectContaining({startFrame:expect.any(Number)}));
});
it('右クリックでは何も起きない',()=>{
  const t=setup();down(t.ruler(),432,2);
  expect(t.props.onSeek).not.toHaveBeenCalled();
});
it('busy 中は選択解除もシークも起きない',()=>{
  const t=setup({busy:true});down(t.track(),432);
  expect(t.props.onSeek).not.toHaveBeenCalled();
  expect(t.props.onSelect).not.toHaveBeenCalled();
});
it('素材のない空案件ではフレーム 0 のままで例外を出さない',()=>{
  const t=setup({document:fixture(0)});down(t.ruler(),432);
  expect(t.props.onSeek).toHaveBeenCalledWith(0);
});
it('スクラブしたまま端へ寄せると端スクロールが続く',()=>{
  const t=setup();down(t.ruler(),432);move(994);advance(3);
  expect(t.scroller.scrollLeft).toBeGreaterThan(0);
  up(994);
});
it('選択ツールではトラックの空き領域が選択解除＋シークで、範囲は始まらない',()=>{
  const t=setup();down(t.track(),432);move(632);up(632);
  expect(t.props.onSelect).toHaveBeenCalledWith([]);
  expect(t.props.onSeek).toHaveBeenCalledWith(300);
  expect(t.props.onRange).not.toHaveBeenCalledWith(expect.objectContaining({endFrame:expect.any(Number)}));
});
it('なぞってカットではトラックの空き領域が範囲選択になる',async()=>{
  const t=setup({tool:'range'});down(t.track(),432);move(632);
  await act(async()=>up(632));
  expect(t.props.onRange).toHaveBeenLastCalledWith({startFrame:300,endFrame:500,trackId:'v'});
});
it('ルーラーはなぞってカットでもスクラブする',()=>{
  const t=setup({tool:'range'});down(t.ruler(),432);move(632);
  expect(t.props.onSeek).toHaveBeenLastCalledWith(500);
  up(632);
});
it('スクラブ中の Esc では再生位置を戻さない',()=>{
  const t=setup();down(t.ruler(),432);move(632);
  expect(t.props.onSeek).toHaveBeenLastCalledWith(500);
  fireEvent.keyDown(window,{key:'Escape'});
  expect(t.props.onSeek).toHaveBeenLastCalledWith(500);
});

it('カット込み確認では保存帯の途中をクリック・ドラッグでき、編集は送らない',()=>{
  const document=fixture(300);document.cutArchive={version:1,entries:[{id:'cut',durationFrames:200,completionFloorFrames:200,origin:{cutId:'cut',startFrame:100,endFrame:300},boundary:{hintFrame:100,ambiguous:false,references:[]},clips:[],tracks:[]}]};
  const onDisplaySeek=vi.fn(),t=setup({document,mode:'finish',tool:'range',onDisplaySeek});
  down(t.ruler(),282);expect(onDisplaySeek).toHaveBeenLastCalledWith(150);
  move(532);expect(onDisplaySeek).toHaveBeenLastCalledWith(400);up(532);
  down(t.track(),322);expect(onDisplaySeek).toHaveBeenLastCalledWith(190);up(322);
  expect(t.props.onSeek).not.toHaveBeenCalled();expect(t.props.onRange).not.toHaveBeenCalled();expect(t.props.onCommand).not.toHaveBeenCalled();expect(t.props.onSelect).not.toHaveBeenCalled();
});
it('カット込み確認でも実処理中のbusyではシークしない',()=>{
  const onDisplaySeek=vi.fn(),t=setup({mode:'finish',onDisplaySeek,busy:true});down(t.ruler(),282);move(532);up(532);expect(onDisplaySeek).not.toHaveBeenCalled();
});

it('カット込み確認のカット帯ではなぞった部分だけを復元し、シークしない',async()=>{
  const document=fixture(300);document.cutArchive={version:1,entries:[{id:'cut',durationFrames:200,completionFloorFrames:200,origin:{cutId:'cut',startFrame:100,endFrame:300},boundary:{hintFrame:100,ambiguous:false,references:[]},clips:[],tracks:[]}]};
  const ref=createRef<NativeTimelineHandle>(),onDisplaySeek=vi.fn(),onCutCommand=vi.fn(async()=>true);
  const t=setup({ref,document,mode:'finish',onDisplaySeek,onCutCommand,activeCutId:'cut',onSelectCut:vi.fn()});
  const band=t.ui.container.querySelector('.tl-cut')!;down(band,282);move(302);up(302);
  expect(onDisplaySeek).not.toHaveBeenCalled();expect(t.ui.getByLabelText('戻すカット範囲')).toBeTruthy();expect(window.document.activeElement).toBe(t.ui.getByLabelText('保存カットの境界'));
  await act(async()=>{expect(await ref.current!.restoreCut()).toBe(true);});
  expect(onCutCommand).toHaveBeenCalledWith({type:'batch',commands:[{type:'restore-cut',entryId:'cut',range:{startFrame:50,endFrame:70}}]},expect.any(Object));
  expect(t.props.onCommand).not.toHaveBeenCalled();
});
