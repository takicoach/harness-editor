/** @vitest-environment jsdom */
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render} from '@testing-library/react';
import {NativeTimeline} from './NativeTimeline';
import type {SequenceDocument} from '../../core/sequence/model';
import {rational as r} from '../../core/sequence/time';
import {applySequenceCommand} from '../../core/sequence/commands';

beforeEach(()=>{
  vi.stubGlobal('requestAnimationFrame',()=>1);vi.stubGlobal('cancelAnimationFrame',()=>undefined);
  vi.stubGlobal('ResizeObserver',class{observe(){}disconnect(){}});
  vi.stubGlobal('PointerEvent',class extends MouseEvent{pointerId:number;constructor(type:string,init:PointerEventInit={}){super(type,init);this.pointerId=init.pointerId??1;}});
  HTMLElement.prototype.setPointerCapture=vi.fn();HTMLElement.prototype.releasePointerCapture=vi.fn();HTMLElement.prototype.hasPointerCapture=()=>true;
});
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();});
function fixture():SequenceDocument{return {schemaVersion:2,id:'doc',name:'range',revision:0,fps:r(30),resolution:{width:320,height:180},sequenceEndFrame:600,
  background:'#000',assets:[],transcripts:[],transitions:[],ducking:{enabled:false,strength:'mid'},
  tracks:[{id:'v1',kind:'visual',name:'映像1',enabled:true},{id:'v2',kind:'visual',name:'映像2',enabled:true}],clips:[]};}
function setup(range:{startFrame:number;endFrame:number;trackId:string|null}|null,overrides:{document?:SequenceDocument;mode?:string}={}){
  const onCommand=vi.fn(async()=>true),onRange=vi.fn();
  const ui=render(<NativeTimeline projectId="p" document={overrides.document??fixture()} waveform="standard" frame={0} selected={[]} range={range} tool="range" zoom={2} snap={false}
    onSelect={vi.fn()} onRange={onRange} onSeek={vi.fn()} onDrop={vi.fn()} onCommand={onCommand} mode={overrides.mode}/>);
  const scroller=ui.getByLabelText('タイムライン');
  Object.defineProperties(scroller,{clientWidth:{configurable:true,value:1000},scrollWidth:{configurable:true,value:4000}});
  scroller.getBoundingClientRect=()=>({left:0,right:1000,top:0,bottom:300,width:1000,height:300,x:0,y:0,toJSON(){}});
  return {ui,onCommand,onRange,scroller};
}

it('floats the cut button host at the horizontal centre of the band, above the pointed track',()=>{
  const a=setup({startFrame:100,endFrame:200,trackId:'v1'}),firstHost=a.ui.container.querySelector<HTMLElement>('.native-range-cut-host')!;
  // 帯は left=132+100*2、幅 200px（zoom=2）。中央は帯の内側 100px（ピース基準の left は無効な CSS の static ボタンではなく host が持つ）。
  expect(firstHost.style.left).toBe('100px');
  const topOnFirstTrack=firstHost.style.top;
  // ボタン自身は position:static（CSS）なので inline の left/top は付けない。
  const firstButton=a.ui.container.querySelector<HTMLElement>('.native-range-cut')!;
  expect(firstButton.style.left).toBe('');
  expect(firstButton.style.top).toBe('');
  cleanup();
  const b=setup({startFrame:100,endFrame:200,trackId:'v2'}),secondHost=b.ui.container.querySelector<HTMLElement>('.native-range-cut-host')!;
  expect(secondHost.style.top).not.toBe(topOnFirstTrack);
});
it('places the host at the whole-band midpoint even when a cut boundary splits the range into two pieces',()=>{
  // v1 に completion フレーム 330〜350 を ripple-delete でアーカイブし、以後の表示座標を -20 ずらす。
  const base=fixture();
  base.tracks=[{id:'v1',kind:'visual',name:'映像1',enabled:true}];
  base.clips=[{id:'c',trackId:'v1',name:'A',startFrame:0,durationFrames:400,clock:{offset:r(0),rate:r(1),duration:r(400)},content:{kind:'telop',data:{text:'A'}}}];
  const doc=applySequenceCommand(base,{type:'ripple-delete',startFrame:330,endFrame:350});
  // 選択範囲 300〜360（completion＝ripple-delete 後の編集座標）はカット帯（completion 330）をまたぎ、
  // 2 ピースに割れる: ピース1 completion[300,330]->display[300,330] / ピース2 completion[330,360]->display[350,380]
  // （display はカット前の元位置を保つため、350〜380 に +20 ずれる。カット帯 330-350 は表示上の隙間）。
  const t=setup({startFrame:300,endFrame:360,trackId:'v1'},{document:doc,mode:'finish'});
  const host=t.ui.container.querySelector<HTMLElement>('.native-range-cut-host')!;
  // 帯全体（表示座標 300〜380）の中点は 340。host は境界を含むピース1（表示 300 起点）の子なので、
  // 相対 left は (340-300)*zoom(2) = 80px。ピース単体の 50%（旧実装: (330-300)/2*2=30px）ではない。
  expect(host.style.left).toBe('80px');
  const pieces=t.ui.container.querySelectorAll('.native-range');
  expect(pieces.length).toBe(2);
});
it('shows the keyboard hint next to the button',()=>{
  const t=setup({startFrame:100,endFrame:200,trackId:'v1'});
  expect(t.ui.getByText('Delete でカット・Esc で解除')).toBeTruthy();
});
it('runs exactly the command Delete runs',async()=>{
  const t=setup({startFrame:100,endFrame:200,trackId:'v1'});
  await act(async()=>{fireEvent.click(t.ui.getByRole('button',{name:/カット/}));});
  expect(t.onCommand).toHaveBeenCalledWith({type:'ripple-delete',startFrame:100,endFrame:200});
});
it('records the track under the pointer when the band is drawn',async()=>{
  const t=setup(null),row=t.ui.container.querySelector<HTMLElement>('[data-native-track="v2"]')!;
  Object.defineProperty(document,'elementFromPoint',{configurable:true,value:()=>row});
  fireEvent.pointerDown(row,{button:0,buttons:1,pointerId:1,clientX:332,clientY:120});
  fireEvent.pointerMove(window,{buttons:1,pointerId:1,clientX:532,clientY:120});
  await act(async()=>fireEvent.pointerUp(window,{button:0,pointerId:1,clientX:532,clientY:120}));
  expect(t.onRange).toHaveBeenLastCalledWith({startFrame:100,endFrame:200,trackId:'v2'});
});
