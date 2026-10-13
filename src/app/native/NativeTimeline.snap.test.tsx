/** @vitest-environment jsdom */
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render} from '@testing-library/react';
import * as snapIndex from './snapIndex';
import {NativeTimeline} from './NativeTimeline';
import type {SequenceDocument} from '../../core/sequence/model';
import {rational as r} from '../../core/sequence/time';
import {applySequenceCommand} from '../../core/sequence/commands';

beforeEach(()=>{
  vi.stubGlobal('requestAnimationFrame',()=>1);vi.stubGlobal('cancelAnimationFrame',()=>undefined);
  vi.stubGlobal('requestIdleCallback',undefined);
  vi.stubGlobal('ResizeObserver',class{observe(){}disconnect(){}});
  vi.stubGlobal('PointerEvent',class extends MouseEvent{pointerId:number;constructor(type:string,init:PointerEventInit={}){super(type,init);this.pointerId=init.pointerId??1;}});
  HTMLElement.prototype.setPointerCapture=vi.fn();HTMLElement.prototype.releasePointerCapture=vi.fn();HTMLElement.prototype.hasPointerCapture=()=>true;
  Object.defineProperty(document,'elementFromPoint',{configurable:true,value:()=>null});
});
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();});
function fixture():SequenceDocument{return {schemaVersion:2,id:'doc',name:'snap',revision:0,fps:r(30),resolution:{width:320,height:180},sequenceEndFrame:900,
  background:'#000',assets:[],transcripts:[],transitions:[],ducking:{enabled:false,strength:'mid'},tracks:[{id:'v',kind:'visual',name:'字幕',enabled:true}],
  clips:[{id:'c',trackId:'v',name:'字幕A',startFrame:300,durationFrames:100,clock:{offset:r(0),rate:r(1),duration:r(100)},content:{kind:'telop',data:{text:'A'}}}]};}
function setup(extra:Record<string,unknown>={}){
  let props:any={projectId:'p',document:fixture(),waveform:'standard',frame:0,selected:[],range:null,tool:'select',zoom:1,snap:true,
    onSelect:vi.fn(),onRange:vi.fn(),onSeek:vi.fn(),onDrop:vi.fn(),onCommand:vi.fn(async()=>true),...extra};
  const ui=render(<NativeTimeline {...props}/>),scroller=ui.getByLabelText('タイムライン');
  Object.defineProperties(scroller,{clientWidth:{configurable:true,value:1000},scrollWidth:{configurable:true,value:4000}});
  scroller.getBoundingClientRect=()=>({left:0,right:1000,top:0,bottom:300,width:1000,height:300,x:0,y:0,toJSON(){}});
  return {ui,get props(){return props;},clip:()=>ui.container.querySelector<HTMLElement>('[data-native-clip-id="c"]')!,
    update(next:Record<string,unknown>){props={...props,...next};ui.rerender(<NativeTimeline {...props}/>);}};
}

const idle=()=>act(async()=>{await new Promise(resolve=>setTimeout(resolve,0));});
it('builds the snap index once per document object, off the render path, and not per playback frame',async()=>{
  const build=vi.spyOn(snapIndex,'buildSnapIndex');
  const t=setup();expect(build).not.toHaveBeenCalled();   // 描画の中では作らない（設計 §2-5）
  await idle();expect(build).toHaveBeenCalledTimes(1);
  t.update({frame:1});t.update({frame:2});t.update({frame:3});await idle();expect(build).toHaveBeenCalledTimes(1);
  t.update({document:{...t.props.document,revision:1}});await idle();expect(build).toHaveBeenCalledTimes(2);
});
it('the first drag right after an edit snaps to the new document, building its index once at pointer down',async()=>{
  const build=vi.spyOn(snapIndex,'buildSnapIndex');const t=setup();await idle();
  const edited:SequenceDocument={...t.props.document,revision:1,clips:[...t.props.document.clips,
    {id:'e',trackId:'v',name:'字幕E',startFrame:500,durationFrames:112,clock:{offset:r(0),rate:r(1),duration:r(112)},content:{kind:'telop',data:{text:'E'}}}]};
  t.update({document:edited});const before=build.mock.calls.length;
  fireEvent.pointerDown(t.clip(),{button:0,buttons:1,pointerId:1,clientX:432,clientY:60});   // 空き時間より先に掴む
  expect(build.mock.calls.length).toBe(before+1);
  fireEvent.pointerMove(window,{buttons:1,pointerId:1,clientX:742,clientY:60});   // 300 → 610（E の終わり 612 の近く）
  expect(t.ui.container.querySelector('.native-snapline > span')!.textContent).toBe('字幕Eの終わり');
  await idle();expect(build.mock.calls.length).toBe(before+1);   // 空き時間の作成は同じ文書を作り直さない
  await act(async()=>fireEvent.pointerUp(window,{button:0,pointerId:1,clientX:742,clientY:60}));
  expect(t.props.onCommand).toHaveBeenCalledWith({type:'move',clipIds:['c'],deltaFrames:312,trackId:undefined});
});
it('a quick press and release right after an edit commits nothing and does not throw',async()=>{
  const t=setup();t.update({document:{...t.props.document,revision:1}});
  fireEvent.pointerDown(t.clip(),{button:0,buttons:1,pointerId:1,clientX:432,clientY:60});
  await act(async()=>fireEvent.pointerUp(window,{button:0,pointerId:1,clientX:432,clientY:60}));
  expect(t.props.onCommand).not.toHaveBeenCalled();expect(t.props.onSelect).toHaveBeenCalledWith(['c']);
});
it('keeps the idle build out of a gesture in progress and runs it after release',async()=>{
  const build=vi.spyOn(snapIndex,'buildSnapIndex');const t=setup();
  t.update({document:{...t.props.document,revision:1}});
  const ruler=t.ui.container.querySelector<HTMLElement>('.native-ruler')!;   // スクラブは吸い付かないので掴んでも作らない
  fireEvent.pointerDown(ruler,{button:0,buttons:1,pointerId:1,clientX:300,clientY:10});
  await idle();expect(build).not.toHaveBeenCalled();
  await act(async()=>fireEvent.pointerUp(window,{button:0,pointerId:1,clientX:300,clientY:10}));
  await idle();expect(build).toHaveBeenCalledTimes(1);
});
it('keeps the idle build out of the time before the first preview picture',async()=>{
  const build=vi.spyOn(snapIndex,'buildSnapIndex');const t=setup({beforeFirstPicture:true});
  await idle();expect(build).not.toHaveBeenCalled();
  t.update({beforeFirstPicture:false});await idle();expect(build).toHaveBeenCalledTimes(1);
});
it('keeps the idle build out of an asset drag over the timeline',async()=>{
  const build=vi.spyOn(snapIndex,'buildSnapIndex');const t=setup();
  const drag=(target:Element|Window,type:string)=>{const event=new MouseEvent(type,{bubbles:true,clientX:500,clientY:60});Object.defineProperty(event,'dataTransfer',{value:{types:['application/x-harness-asset']}});fireEvent(target,event);};
  drag(window,'dragstart');drag(t.ui.container.querySelector('[data-native-track="v"]')!,'dragover');
  expect(t.ui.container.querySelector('.native-asset-drop-marker')).not.toBeNull();   // ドロップの予告が出ている＝操作中
  await idle();expect(build).not.toHaveBeenCalled();
  drag(window,'dragend');await idle();expect(build).toHaveBeenCalledTimes(1);
});
it('keeps the idle build out of a cut-row drag in the finish view',async()=>{
  const build=vi.spyOn(snapIndex,'buildSnapIndex');
  const t=setup({document:applySequenceCommand(fixture(),{type:'ripple-delete',startFrame:330,endFrame:350}),mode:'finish'});
  fireEvent.pointerDown(t.ui.container.querySelector('.tl-cut')!,{button:0,pointerId:7,clientX:132+340,clientY:40});
  fireEvent.pointerMove(window,{pointerId:7,clientX:132+380,clientY:40});
  await idle();expect(build).not.toHaveBeenCalled();
  await act(async()=>fireEvent.pointerUp(window,{pointerId:7,clientX:132+380,clientY:40}));
  await idle();expect(build).toHaveBeenCalledTimes(1);
});
it('builds nothing while snapping is off, even when a clip is grabbed and dragged',async()=>{
  const build=vi.spyOn(snapIndex,'buildSnapIndex');const t=setup({snap:false});await idle();
  fireEvent.pointerDown(t.clip(),{button:0,buttons:1,pointerId:1,clientX:432,clientY:60});expect(build).not.toHaveBeenCalled();
  fireEvent.pointerMove(window,{buttons:1,pointerId:1,clientX:742,clientY:60});await idle();expect(build).not.toHaveBeenCalled();
  await act(async()=>fireEvent.pointerUp(window,{button:0,pointerId:1,clientX:742,clientY:60}));
  expect(t.props.onCommand).toHaveBeenCalledWith({type:'move',clipIds:['c'],deltaFrames:310,trackId:undefined});
});
// 同じセッションの同じ版は同じオブジェクトのまま（useNativeSession の accept）。同じ id・版で別のオブジェクトが
// 届くのはセッションが替わった時（ライブ再読込）だけで、版が同じなら掴んだ操作は続く。その時は古い索引を使わない。
it('a same-revision document swap during a drag snaps to the new document, not the index taken at pointer down',async()=>{
  const t=setup();await idle();
  fireEvent.pointerDown(t.clip(),{button:0,buttons:1,pointerId:1,clientX:432,clientY:60});
  t.update({document:{...t.props.document,clips:[...t.props.document.clips,
    {id:'e',trackId:'v',name:'字幕E',startFrame:500,durationFrames:112,clock:{offset:r(0),rate:r(1),duration:r(112)},content:{kind:'telop',data:{text:'E'}}}]}});
  fireEvent.pointerMove(window,{buttons:1,pointerId:1,clientX:742,clientY:60});
  expect(t.ui.container.querySelector('.native-snapline > span')!.textContent).toBe('字幕Eの終わり');
  await act(async()=>fireEvent.pointerUp(window,{button:0,pointerId:1,clientX:742,clientY:60}));
  expect(t.props.onCommand).toHaveBeenCalledWith({type:'move',clipIds:['c'],deltaFrames:312,trackId:undefined});
});
it('snaps a dragged clip to a word boundary and names it on the snap line',async()=>{
  vi.spyOn(snapIndex,'buildSnapIndex').mockReturnValue([{frame:612,kind:'word',label:'「編集する」の先頭'}]);
  const t=setup();
  fireEvent.pointerDown(t.clip(),{button:0,buttons:1,pointerId:1,clientX:432,clientY:60});
  fireEvent.pointerMove(window,{buttons:1,pointerId:1,clientX:742,clientY:60});   // 300 → 610
  expect(t.ui.container.querySelector('.native-snapline > span')!.textContent).toBe('「編集する」の先頭');
  await act(async()=>fireEvent.pointerUp(window,{button:0,pointerId:1,clientX:742,clientY:60}));
  expect(t.props.onCommand).toHaveBeenCalledWith({type:'move',clipIds:['c'],deltaFrames:312,trackId:undefined});
});
it('frame 0 近くへドラッグすると「先頭」に付く（再生ヘッドが別の位置にあっても幽霊 playhead に負けない）',async()=>{
  const t=setup({frame:200}); // 再生ヘッドは 200。document 由来 index に紛れ込んだ playhead=0 があると frame 0 では常にこちらが勝つ。
  fireEvent.pointerDown(t.clip(),{button:0,buttons:1,pointerId:1,clientX:432,clientY:60}); // clip start=300
  fireEvent.pointerMove(window,{buttons:1,pointerId:1,clientX:132,clientY:60}); // -300 → start が 0 近辺
  expect(t.ui.container.querySelector('.native-snapline > span')!.textContent).toBe('先頭');
  await act(async()=>fireEvent.pointerUp(window,{button:0,pointerId:1,clientX:132,clientY:60}));
  expect(t.props.onCommand).toHaveBeenCalledWith({type:'move',clipIds:['c'],deltaFrames:-300,trackId:undefined});
});
it('つかんでいるクリップと同じフレーム値を持つ別クリップの端は誤って除外されない',async()=>{
  const withNeighbor=(doc:SequenceDocument):SequenceDocument=>({...doc,clips:[...doc.clips,
    {id:'e',trackId:'v',name:'字幕E',startFrame:200,durationFrames:100,clock:{offset:r(0),rate:r(1),duration:r(100)},content:{kind:'telop',data:{text:'E'}}}]});
    // e の終わり=300 は c（ドラッグ対象）の元の start=300 と値が一致する。値一致で除外すると e の端まで消える。
  const t=setup({document:withNeighbor(fixture())});
  fireEvent.pointerDown(t.clip(),{button:0,buttons:1,pointerId:1,clientX:432,clientY:60}); // clip c start=300
  fireEvent.pointerMove(window,{buttons:1,pointerId:1,clientX:437,clientY:60}); // 5px移動（moved判定を満たす最小・raw delta=5）→ 300近辺に留まる
  expect(t.ui.container.querySelector('.native-snapline > span')!.textContent).toBe('字幕Eの終わり');
  await act(async()=>fireEvent.pointerUp(window,{button:0,pointerId:1,clientX:437,clientY:60}));
  // 誤って除外されていれば吸着せず raw delta=5 のまま move が発火する。正しく除外されなければ
  // 300 へ吸着して delta=0 になり、move コマンドは（差分ゼロなので）発火しない。
  expect(t.props.onCommand).not.toHaveBeenCalled();
});
it('suspends snapping while Alt is held',async()=>{
  vi.spyOn(snapIndex,'buildSnapIndex').mockReturnValue([{frame:612,kind:'word',label:'「編集する」の先頭'}]);
  const t=setup();
  fireEvent.pointerDown(t.clip(),{button:0,buttons:1,pointerId:1,clientX:432,clientY:60,altKey:true});
  fireEvent.pointerMove(window,{buttons:1,pointerId:1,clientX:742,clientY:60,altKey:true});
  expect(t.ui.container.querySelector('.native-snapline')).toBeNull();
  await act(async()=>fireEvent.pointerUp(window,{button:0,pointerId:1,clientX:742,clientY:60}));
  expect(t.props.onCommand).toHaveBeenCalledWith({type:'move',clipIds:['c'],deltaFrames:310,trackId:undefined});
});
