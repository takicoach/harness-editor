/** @vitest-environment jsdom */
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render} from '@testing-library/react';
import type {ComponentProps} from 'react';
import {NativeTimeline} from './NativeTimeline';
import type {SequenceDocument} from '../../core/sequence/model';
import {rational as r} from '../../core/sequence/time';
import {applySequenceCommand} from '../../core/sequence/commands';

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
function fixture():SequenceDocument{return {schemaVersion:2,id:'doc',name:'fixture',revision:0,fps:r(30),resolution:{width:320,height:180},sequenceEndFrame:3000,background:'#000',
  assets:[],transcripts:[],transitions:[],ducking:{enabled:false,strength:'mid'},tracks:[{id:'v',kind:'visual',name:'字幕',enabled:true}],
  clips:[{id:'c',trackId:'v',name:'字幕A',startFrame:300,durationFrames:100,clock:{offset:r(0),rate:r(1),duration:r(100)},content:{kind:'telop',data:{text:'A'}}}]};}
type Props=ComponentProps<typeof NativeTimeline>&{playing?:boolean;busy?:boolean;mode?:string;onZoomChange?:(value:number)=>void};
function setup(extra:Partial<Props>={}){
  // ripple:false を既定にする — この一式は「詰める」機能そのものではなくドラッグ／スクロール／キー操作の
  // 機構を検証する。NativeTimeline の ripple 既定が RT6 で true に昇格した後も、ここでの trim コマンドの
  // 期待値（frame・startFrame 等）が従来のまま比較できるよう明示的に固定する（互換の明示。ripple の意味論自体の
  // 検証は NativeTimeline.ripple.test.tsx が担当）。
  let props:Props={projectId:'p',document:fixture(),waveform:'standard',frame:0,selected:[],range:null,tool:'select',zoom:1,snap:false,ripple:false,
    onSelect:vi.fn(),onRange:vi.fn(),onSeek:vi.fn(),onDrop:vi.fn(),onCommand:vi.fn(async()=>true),onZoomChange:vi.fn(),...extra};
  const ui=render(<NativeTimeline {...props}/>),scroller=ui.getByLabelText('タイムライン');
  Object.defineProperties(scroller,{clientWidth:{configurable:true,value:1000},clientHeight:{configurable:true,value:300},scrollWidth:{configurable:true,value:4000}});
  scroller.getBoundingClientRect=()=>({left:0,right:1000,top:0,bottom:300,width:1000,height:300,x:0,y:0,toJSON(){}});
  return {ui,scroller,get props(){return props;},clip:()=>ui.container.querySelector<HTMLElement>('[data-native-clip-id="c"]')!,
    update(next:Partial<Props>){props={...props,...next};ui.rerender(<NativeTimeline {...props}/>);}};
}
function down(node:Element,x:number){fireEvent.pointerDown(node,{button:0,buttons:1,pointerId:1,clientX:x,clientY:60});}
function move(x:number){fireEvent.pointerMove(window,{buttons:1,pointerId:1,clientX:x,clientY:60});}
function up(x=990){fireEvent.pointerUp(window,{button:0,pointerId:1,clientX:x,clientY:60});}

function finishFixture(){
  const doc=applySequenceCommand(fixture(),{type:'ripple-delete',startFrame:330,endFrame:350});
  doc.clips.push({...structuredClone(fixture().clips[0]!),id:'overlay',name:'後追加字幕',startFrame:320,durationFrames:30,clock:{offset:r(0),rate:r(1),duration:r(30)}});
  return doc;
}
it('shows source playback at its archived local position and hides it outside the selected source usage',()=>{
  const doc=finishFixture(),entryId=doc.cutArchive!.entries[0]!.id;
  const t=setup({document:doc,mode:'finish',frame:335,zoom:2,archivedPlayhead:{entryId,localFrame:7}});
  expect((t.ui.container.querySelector('.native-playhead') as HTMLElement).style.left).toBe(`${132+337*2}px`);
  t.update({archivedPlayhead:null});expect(t.ui.container.querySelector('.native-playhead')).toBeNull();
});
it('projects a later subtitle across the deleted band as two live pieces without stretching its clock',()=>{
  const doc=finishFixture(),before=structuredClone(doc),t=setup({document:doc,mode:'finish',frame:335});
  const pieces=t.ui.container.querySelectorAll('[data-native-clip-id="overlay"] [data-native-display-start]');
  expect([...pieces].map(p=>[p.getAttribute('data-native-display-start'),p.getAttribute('data-native-completion-start'),(p as HTMLElement).style.width])).toEqual([['320','320','10px'],['350','330','20px']]);
  expect((t.ui.container.querySelector('.native-playhead') as HTMLElement).style.left).toBe('487px');
  expect(doc).toEqual(before);
});
it('seeks and splits a finish fragment using completion time rather than its expanded display position',()=>{
  const t=setup({document:finishFixture(),mode:'finish',tool:'razor'});
  const piece=t.ui.container.querySelector('[data-native-clip-id="overlay"] [data-native-display-start="350"]')!;
  down(piece,487);
  expect(t.props.onCommand).toHaveBeenCalledWith({type:'split',clipIds:['overlay'],frame:335});
});
it('moves a grabbed later fragment by the live distance and keeps its trim button mounted across a cut seam',async()=>{
  const t=setup({document:finishFixture(),mode:'finish',zoom:2});
  const piece=t.ui.container.querySelector('[data-native-clip-id="overlay"] [data-native-display-start="350"]')!;
  down(piece,842);move(872);await act(async()=>up(872));
  expect(t.props.onCommand).toHaveBeenCalledWith({type:'move',clipIds:['overlay'],deltaFrames:15});
  const end=t.ui.getByRole('button',{name:'後追加字幕の終了位置を調整'});
  down(end,872);move(782);
  expect(end.isConnected).toBe(true);expect(end.style.display).not.toBe('none');
  await act(async()=>up(782));
  expect(t.props.onCommand).toHaveBeenLastCalledWith({type:'trim',clipId:'overlay',edge:'end',frame:325});
});
it('snaps a moving end to the visible before-side of a saved cut boundary',async()=>{
  const doc=finishFixture(),overlay=doc.clips.find(clip=>clip.id==='overlay')!;
  overlay.startFrame=310;overlay.durationFrames=40;overlay.clock.duration=r(40);
  const t=setup({document:doc,mode:'finish',snap:true});
  const piece=t.ui.container.querySelector('[data-native-clip-id="overlay"] [data-native-display-start="350"]')!;
  down(piece,487);move(446);await act(async()=>up(446));
  expect(t.props.onCommand).toHaveBeenCalledWith({type:'move',clipIds:['overlay'],deltaFrames:-20});
});
it('reveals an offscreen saved cut on entering finish without moving an already visible selection',()=>{
  const doc=finishFixture(),entry=doc.cutArchive!.entries[0]!;
  const t=setup({document:doc,mode:'edit',activeCutId:entry.id});t.scroller.scrollLeft=2000;
  t.update({mode:'finish'});expect(t.scroller.scrollLeft).toBe(330);
  t.update({mode:'edit'});t.scroller.scrollLeft=300;
  t.update({mode:'finish'});expect(t.scroller.scrollLeft).toBe(300);
});

it.each(['right','left'] as const)('scrolls a confirmed drag %s and commits the scrolled distance with a stationary pointer',async direction=>{
  const t=setup();t.scroller.scrollLeft=direction==='left'?300:0;
  const start=direction==='left'?180:940,end=direction==='left'?142:990;
  down(t.clip(),start);move(end);advance(3);
  const scrollDelta=t.scroller.scrollLeft-(direction==='left'?300:0);
  expect(direction==='left'?scrollDelta<0:scrollDelta>0).toBe(true);
  const expected=Math.round(end-start+scrollDelta);
  expect(parseFloat(t.clip().style.left)).toBe(132+300+expected);
  await act(async()=>up(end));
  expect(t.props.onCommand).toHaveBeenCalledExactlyOnceWith({type:'move',clipIds:['c'],deltaFrames:expected});
  const stopped=t.scroller.scrollLeft;advance(3);expect(t.scroller.scrollLeft).toBe(stopped);
});
it('does not scroll or commit a pure edge click / subthreshold motion',async()=>{
  const t=setup();down(t.clip(),990);move(991);advance(3);expect(t.scroller.scrollLeft).toBe(0);
  await act(async()=>up(991));expect(t.props.onCommand).not.toHaveBeenCalled();
});
it.each(['escape','cancel','lost-capture','blur','revision','undo','zoom','mode','busy','project','unmount'] as const)('retires a scrolled gesture on %s without stale commit',async reason=>{
  const t=setup({mode:'edit'});down(t.clip(),940);move(990);advance(2);
  expect(t.scroller.scrollLeft).toBeGreaterThan(0);
  if(reason==='escape')fireEvent.keyDown(window,{key:'Escape'});
  else if(reason==='cancel')fireEvent.pointerCancel(window,{pointerId:1});
  else if(reason==='lost-capture')fireEvent.lostPointerCapture(t.clip(),{pointerId:1});
  else if(reason==='blur')fireEvent(window,new Event('blur'));
  else if(reason==='revision')t.update({document:{...t.props.document,revision:1}});
  else if(reason==='undo'){const doc=structuredClone(t.props.document);doc.revision=2;doc.clips[0]!.startFrame=50;t.update({document:doc});}
  else if(reason==='zoom')t.update({zoom:2});
  else if(reason==='mode')t.update({mode:'finish'});
  else if(reason==='busy')t.update({busy:true});
  else if(reason==='project')t.update({projectId:'other'});
  else t.ui.unmount();
  const stopped=t.scroller.scrollLeft;advance(3);await act(async()=>up());
  expect(t.scroller.scrollLeft).toBe(stopped);expect(t.props.onCommand).not.toHaveBeenCalled();
  if(reason!=='unmount')expect(t.clip().style.opacity).not.toBe('0.7');
});
it.each(['start','end'] as const)('commits %s trim after scroll through the existing clip clock command',async edge=>{
  const doc=fixture(),before=structuredClone(doc);let saved=doc;
  const t=setup({document:doc,onCommand:vi.fn(async command=>{if(command.type==='undo'||command.type==='redo')throw Error('unexpected');saved=applySequenceCommand(doc,command);return true;})});
  const handle=t.ui.getByRole('button',{name:`字幕Aの${edge==='start'?'開始':'終了'}位置を調整`});
  down(handle,940);move(970);advance(2);
  const delta=Math.round(30+t.scroller.scrollLeft);expect(delta).toBeGreaterThan(30);
  await act(async()=>up(970));
  expect(saved.clips[0]!.startFrame).toBe(edge==='start'?300+delta:300);
  expect(saved.clips[0]!.durationFrames).toBe(edge==='start'?100-delta:100+delta);
  expect(saved.clips[0]!.clock.offset).toEqual(r(edge==='start'?delta:0));
  expect(doc).toEqual(before);
});
it('keeps a captured trim edge while shrinking a long clip below the normal hit-area threshold',async()=>{
  const t=setup(),edge=t.ui.getByRole('button',{name:'字幕Aの終了位置を調整'});
  down(edge,530);move(435);expect((edge as HTMLElement).style.display).not.toBe('none');
  await act(async()=>up(435));expect(t.props.onCommand).toHaveBeenCalledWith({type:'trim',clipId:'c',edge:'end',frame:305});
});
it('does not run drag scrolling while playback owns the viewport',()=>{
  const t=setup({playing:true});down(t.clip(),940);move(990);advance(3);expect(t.scroller.scrollLeft).toBe(0);
  fireEvent.pointerCancel(window,{pointerId:1});
});
it('accounts for manual scrolling during a drag and does not hijack ordinary vertical wheels',async()=>{
  const t=setup();down(t.clip(),500);move(510);t.scroller.scrollLeft=80;fireEvent.scroll(t.scroller);
  const wheel=new WheelEvent('wheel',{bubbles:true,cancelable:true,deltaY:20});fireEvent(t.scroller,wheel);expect(wheel.defaultPrevented).toBe(false);
  await act(async()=>up(510));expect(t.props.onCommand).toHaveBeenCalledWith({type:'move',clipIds:['c'],deltaFrames:90});
});
it('keeps a ruler drag a scrub that follows the auto-scroll without committing a cut',()=>{
  const t=setup(),ruler=t.ui.container.querySelector('.native-ruler')!;down(ruler,940);advance(2);expect(t.scroller.scrollLeft).toBe(0);
  move(990);advance(2);const at=Math.round(990-132+t.scroller.scrollLeft);up(990);
  expect(t.props.onSeek).toHaveBeenLastCalledWith(at);
  expect(t.props.onRange).not.toHaveBeenCalledWith(expect.objectContaining({endFrame:expect.any(Number)}));
  expect(t.props.onCommand).not.toHaveBeenCalled();
});
it('still confirms a range from a track row when the range tool is selected',()=>{
  const t=setup({tool:'range'});const row=t.ui.container.querySelector('[data-native-track="v"]')!;
  down(row,940);move(990);up(990);
  expect(t.props.onRange).toHaveBeenLastCalledWith(expect.objectContaining({startFrame:808}));
});
it('serializes pending edge edits, handles rejection, and leaves source state untouched',async()=>{
  let reject!:(error:Error)=>void;const command=vi.fn(()=>new Promise<boolean>((_,fail)=>{reject=fail;}));
  const t=setup({onCommand:command}),before=structuredClone(t.props.document),edge=t.ui.getByRole('button',{name:'字幕Aの終了位置を調整'});
  fireEvent.keyDown(edge,{key:'ArrowRight'});fireEvent.keyDown(edge,{key:'ArrowRight'});expect(command).toHaveBeenCalledTimes(1);
  await act(async()=>reject(Error('更新競合')));expect(t.ui.getByRole('status').textContent).toContain('更新競合');expect(t.props.document).toEqual(before);
});
it.each([false,true])('does not seek a changed context when an older range-cut request finishes (ABA %s)',async aba=>{
  let release!:(ok:boolean)=>void;const t=setup({range:{startFrame:20,endFrame:40,trackId:null},onCommand:vi.fn(()=>new Promise<boolean>(done=>{release=done;}))});
  fireEvent.click(t.ui.getByRole('button',{name:/カット/}));t.update({projectId:'next'});if(aba)t.update({projectId:'p'});await act(async()=>release(true));expect(t.props.onSeek).not.toHaveBeenCalled();
});
it('ignores a second pointer and releases the original outside the element',async()=>{
  const t=setup();down(t.clip(),500);fireEvent.pointerMove(window,{pointerId:2,clientX:900,clientY:60,buttons:1});up(500);
  expect(t.props.onCommand).not.toHaveBeenCalled();
});
it('keeps a zoomed timeline following the displayed head only while playing',()=>{
  const t=setup();t.update({frame:1200,playing:true});expect(t.scroller.scrollLeft).toBe(882);
  t.update({frame:1800,playing:false});expect(t.scroller.scrollLeft).toBe(882);
});
it('anchors controlled slider zoom to the head and wheel zoom to the pointer; Shift-wheel pans',()=>{
  const t=setup({frame:600});t.scroller.scrollLeft=200;t.update({zoom:2});expect(t.scroller.scrollLeft).toBe(800);
  const wheel=new WheelEvent('wheel',{bubbles:true,cancelable:true,ctrlKey:true,deltaY:-1,clientX:700});fireEvent(t.scroller,wheel);
  expect(wheel.defaultPrevented).toBe(true);expect(t.props.onZoomChange).toHaveBeenCalledWith(2.4);
  t.update({zoom:2.4});expect(t.scroller.scrollLeft).toBeCloseTo(1073.6);
  fireEvent.wheel(t.scroller,{shiftKey:true,deltaY:45});expect(t.scroller.scrollLeft).toBeCloseTo(1118.6);
});
it('lets an edge button adjust one frame without bubbling to workspace seek, and blocks while busy',async()=>{
  const t=setup();const edge=t.ui.getByRole('button',{name:'字幕Aの終了位置を調整'}),bubble=vi.fn();window.addEventListener('keydown',bubble);
  await act(async()=>fireEvent.keyDown(edge,{key:'ArrowRight'}));
  expect(t.props.onCommand).toHaveBeenCalledWith({type:'trim',clipId:'c',edge:'end',frame:401});expect(bubble).not.toHaveBeenCalled();
  t.update({busy:true});await act(async()=>fireEvent.keyDown(edge,{key:'ArrowLeft'}));expect(t.props.onCommand).toHaveBeenCalledTimes(1);
  window.removeEventListener('keydown',bubble);
});
it('leaves a narrow clip body draggable instead of covering it with two handles',()=>{
  const doc=fixture();doc.clips[0]!.durationFrames=10;const t=setup({document:doc});
  const handles=t.clip().querySelectorAll<HTMLElement>('.native-trim');expect(handles).toHaveLength(2);
  for(const edge of handles)expect(edge.style.display).toBe('none');
});

it.each([false,true])('HTML asset drop in finish preserves completion coordinates with playing=%s',playing=>{
  const doc=finishFixture();doc.assets.push({id:'image',name:'image',kind:'image',file:'.harness/image.png',fingerprint:'a'.repeat(64),streams:[]});
  const t=setup({document:doc,mode:'finish',playing,zoom:2});
  const track=t.ui.container.querySelector('[data-native-track="v"]')!;
  const dispatch=(type:string,x:number)=>{const event=new MouseEvent(type,{bubbles:true,clientX:x,clientY:60});Object.defineProperty(event,'dataTransfer',{value:{types:['application/x-harness-asset'],getData:()=> 'image'}});fireEvent(track,event);};
  dispatch('dragstart',500);dispatch('dragover',842); // display 355, completion 335
  expect(t.ui.container.querySelector('.native-asset-drop-marker')?.getAttribute('data-drop-frame')).toBe('335');
  dispatch('drop',842);expect(t.props.onDrop).toHaveBeenCalledExactlyOnceWith('image',335,'v');
});

it('runs the hover edge-scroll loop only while the pointer is inside the timeline frame',()=>{
  const t=setup();
  // 枠を出入りしていないうちは 1 フレームも回さない（毎フレームの getBoundingClientRect は空転）。
  const rect=vi.fn(t.scroller.getBoundingClientRect.bind(t.scroller));t.scroller.getBoundingClientRect=rect;
  advance(3);expect(rect).not.toHaveBeenCalled();
  fireEvent.pointerMove(t.scroller,{clientX:990,clientY:60});
  const before=t.scroller.scrollLeft;advance(3);
  expect(rect).toHaveBeenCalled();expect(t.scroller.scrollLeft).toBeGreaterThan(before);
  fireEvent.pointerLeave(t.scroller);
  const parked=t.scroller.scrollLeft;rect.mockClear();advance(3);
  expect(rect).not.toHaveBeenCalled();expect(t.scroller.scrollLeft).toBe(parked);
});

it.each([false,true])('HTML edge scrolling uses the existing playback ownership with playing=%s',playing=>{
  const t=setup({playing});const track=t.ui.container.querySelector('[data-native-track="v"]')!;
  const event=new MouseEvent('dragover',{bubbles:true,clientX:990,clientY:60});Object.defineProperty(event,'dataTransfer',{value:{types:['application/x-harness-asset']}});
  const start=new Event('dragstart');Object.defineProperty(start,'dataTransfer',{value:{types:['application/x-harness-asset']}});fireEvent(window,start);fireEvent(track,event);
  const before=t.scroller.scrollLeft;advance(3);
  if(playing)expect(t.scroller.scrollLeft).toBe(before);else expect(t.scroller.scrollLeft).toBeGreaterThan(before);
  expect(Number(t.ui.container.querySelector('.native-asset-drop-marker')?.getAttribute('data-drop-frame'))).toBe(Math.round(990-132+t.scroller.scrollLeft));
});

it('shows the drag tooltip and a named snap line while a clip is dragged onto a neighbour edge',()=>{
  const doc=fixture();
  doc.clips.push({id:'n',trackId:'v',name:'字幕B',startFrame:600,durationFrames:60,clock:{offset:r(0),rate:r(1),duration:r(60)},content:{kind:'telop',data:{text:'B'}}});
  const t=setup({document:doc,snap:true,zoom:1});
  down(t.clip(),432);move(729);              // 300 → 597（字幕Bの先頭 600 へ 3 フレーム差で吸着）
  const tooltip=t.ui.container.querySelector('.native-drag-tooltip')!;
  expect(tooltip.textContent).toContain('+300f');
  expect(t.ui.container.querySelector('.native-snapline > span')!.textContent).toBe('字幕Bの先頭');
  fireEvent.pointerCancel(window,{pointerId:1});
});

it('collapses a dense caption track (F10) into a density lane, keeps a dense video track as clips, and seeks from the lane track\'s empty area',()=>{
  const telopClips=Array.from({length:10},(_,i)=>({id:`t${i}`,trackId:'v',name:`字幕${i}`,startFrame:i*100,durationFrames:50,clock:{offset:r(0),rate:r(1),duration:r(50)},content:{kind:'telop' as const,data:{text:`t${i}`}}}));
  const t=setup({document:{...fixture(),clips:telopClips},zoom:0.1});      // 50fr × 0.1 = 5px
  expect(t.ui.getByRole('img',{name:'10 件の字幕（拡大するとクリップになります）'})).not.toBeNull();
  expect(t.ui.container.querySelectorAll('[data-native-clip-id]').length).toBe(0);
  expect(t.ui.container.querySelector('.native-density-count')?.textContent).toBe('10 件');

  const track=t.ui.container.querySelector<HTMLElement>('[data-native-track="v"]')!;
  down(track,700);
  // T12: 「呼ばれた」ではなく値を見る（帯が座標を飲み込んでいれば別の位置になる）。
  // (700 - ラベル幅 132) / 0.1 = 5,680 → 尺 3,000 の最終フレーム 2,999 へ丸める。
  expect(t.props.onSeek).toHaveBeenLastCalledWith(2999);
  t.ui.unmount();

  const videoClips=telopClips.map(c=>({...c,content:{kind:'video' as const,assetId:'a',streamIndex:0,sourceIn:r(0),rate:r(1)}}));
  const tv=setup({document:{...fixture(),tracks:[{id:'v',kind:'visual' as const,name:'映像',enabled:true}],clips:videoClips},zoom:0.1});
  expect(tv.ui.container.querySelector('.native-density-lane')).toBeNull();
  expect(tv.ui.container.querySelectorAll('[data-native-clip-id]').length).toBe(10);
});

// T12: 仕上げ表示（finishMap）では密度帯へ倒さない。帯は live フレームで描くので、表示座標と食い違う。
it('keeps the caption clips as clips in finish mode even when they are dense',()=>{
  const telopClips=Array.from({length:10},(_,i)=>({id:`t${i}`,trackId:'v',name:`字幕${i}`,startFrame:i*100,durationFrames:50,clock:{offset:r(0),rate:r(1),duration:r(50)},content:{kind:'telop' as const,data:{text:`t${i}`}}}));
  const edit=setup({document:{...fixture(),clips:telopClips},zoom:0.1});
  expect(edit.ui.container.querySelector('.native-density-lane')).not.toBeNull();   // 前提: 編集では帯になる
  edit.ui.unmount();
  const finish=setup({document:{...fixture(),clips:telopClips},zoom:0.1,mode:'finish'});
  expect(finish.ui.container.querySelector('.native-density-lane')).toBeNull();
  expect(finish.ui.container.querySelectorAll('[data-native-clip-id]').length).toBe(10);
});

it('keeps a selected caption clip rendered as a clip instead of collapsing it into the density lane',()=>{
  const telopClips=Array.from({length:10},(_,i)=>({id:`t${i}`,trackId:'v',name:`字幕${i}`,startFrame:i*100,durationFrames:50,clock:{offset:r(0),rate:r(1),duration:r(50)},content:{kind:'telop' as const,data:{text:`t${i}`}}}));
  const t=setup({document:{...fixture(),clips:telopClips},zoom:0.1,selected:['t0']});
  expect(t.ui.container.querySelector('.native-density-lane')).toBeNull();
  expect(t.ui.container.querySelectorAll('[data-native-clip-id]').length).toBe(10);
});
