/** @vitest-environment jsdom */
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render} from '@testing-library/react';
import {NativeTimeline} from './NativeTimeline';
import type {SequenceDocument} from '../../core/sequence/model';
import {rational as r} from '../../core/sequence/time';

beforeEach(()=>{
  vi.stubGlobal('requestAnimationFrame',()=>1);vi.stubGlobal('cancelAnimationFrame',()=>undefined);
  vi.stubGlobal('ResizeObserver',class{observe(){}disconnect(){}});
  vi.stubGlobal('PointerEvent',class extends MouseEvent{pointerId:number;constructor(type:string,init:PointerEventInit={}){super(type,init);this.pointerId=init.pointerId??1;}});
  HTMLElement.prototype.setPointerCapture=vi.fn();HTMLElement.prototype.releasePointerCapture=vi.fn();
  HTMLElement.prototype.hasPointerCapture=()=>true;
  Object.defineProperty(document,'elementFromPoint',{configurable:true,value:()=>null});
});
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();});
function fixture():SequenceDocument{return {schemaVersion:2,id:'doc',name:'drag',revision:0,fps:r(30),resolution:{width:320,height:180},sequenceEndFrame:3000,
  background:'#000',assets:[],transcripts:[],transitions:[],ducking:{enabled:false,strength:'mid'},tracks:[{id:'v',kind:'visual',name:'字幕',enabled:true}],
  clips:[{id:'c',trackId:'v',name:'字幕A',startFrame:300,durationFrames:100,clock:{offset:r(0),rate:r(1),duration:r(100)},content:{kind:'telop',data:{text:'A'}}}]};}
function setup(){
  const onDragStateChange=vi.fn();
  let props={projectId:'p',document:fixture(),waveform:'standard' as const,frame:0,selected:[],range:null,tool:'select' as const,zoom:1,snap:false,
    onSelect:vi.fn(),onRange:vi.fn(),onSeek:vi.fn(),onDrop:vi.fn(),onCommand:vi.fn(async()=>true),onDragStateChange};
  const ui=render(<NativeTimeline {...props}/>),scroller=ui.getByLabelText('タイムライン');
  Object.defineProperties(scroller,{clientWidth:{configurable:true,value:1000},scrollWidth:{configurable:true,value:4000}});
  scroller.getBoundingClientRect=()=>({left:0,right:1000,top:0,bottom:300,width:1000,height:300,x:0,y:0,toJSON(){}});
  const clip=()=>ui.container.querySelector<HTMLElement>('[data-native-clip-id="c"]')!;
  const start=()=>{fireEvent.pointerDown(clip(),{button:0,buttons:1,pointerId:1,clientX:400,clientY:60});
    fireEvent.pointerMove(window,{buttons:1,pointerId:1,clientX:460,clientY:60});};
  return {ui,scroller,clip,start,onDragStateChange,update(next:Partial<typeof props>){props={...props,...next};ui.rerender(<NativeTimeline {...props}/>);}};
}

it.each([
  ['pointerup',()=>fireEvent.pointerUp(window,{button:0,pointerId:1,clientX:460,clientY:60})],
  ['lostpointercapture',(t:ReturnType<typeof setup>)=>fireEvent.lostPointerCapture(t.scroller,{pointerId:1})],
  ['blur',()=>fireEvent.blur(window)],
  ['escape',()=>fireEvent.keyDown(window,{key:'Escape'})],
])('reports the drag as finished after %s',async(_label,finish)=>{
  const t=setup();t.start();
  expect(t.onDragStateChange).toHaveBeenLastCalledWith(true);
  await act(async()=>{finish(t);});
  expect(t.onDragStateChange).toHaveBeenLastCalledWith(false);
});
it('reports the drag as finished when the project changes under a live gesture',()=>{
  const t=setup();t.start();expect(t.onDragStateChange).toHaveBeenLastCalledWith(true);
  t.update({projectId:'next'});
  expect(t.onDragStateChange).toHaveBeenLastCalledWith(false);
});
it('reports the drag as finished on unmount',()=>{
  const t=setup();t.start();expect(t.onDragStateChange).toHaveBeenLastCalledWith(true);
  t.ui.unmount();
  expect(t.onDragStateChange).toHaveBeenLastCalledWith(false);
});
