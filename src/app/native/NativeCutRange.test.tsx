/** @vitest-environment jsdom */
import {useState} from 'react';
import {cleanup,fireEvent,render} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {NativeCutRange,type CutRange} from './NativeCutRange';
beforeEach(()=>{
  vi.stubGlobal('PointerEvent',class extends MouseEvent {pointerId:number;constructor(type:string,init:PointerEventInit){super(type,init);this.pointerId=init.pointerId??1;}});
  HTMLElement.prototype.setPointerCapture=vi.fn();HTMLElement.prototype.releasePointerCapture=vi.fn();HTMLElement.prototype.hasPointerCapture=()=>false;
});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
function setup(initial:CutRange={startFrame:20,endFrame:80}){
  const change=vi.fn();function Harness(){const [value,set]=useState(initial);return <NativeCutRange value={value} duration={100} disabled={false} onChange={next=>{set(next);change(next);}}/>;}
  const view=render(<Harness/>),track=view.container.querySelector('.native-cut-range-track')!;
  vi.spyOn(track,'getBoundingClientRect').mockReturnValue({left:100,width:200,right:300,top:0,bottom:32,height:32,x:100,y:0,toJSON:()=>({})});
  return {view,change,start:view.getByRole('slider',{name:'戻す範囲の開始つまみ'}),end:view.getByRole('slider',{name:'戻す範囲の終了つまみ'})};
}
it('drags either handle with bounds and keeps one frame even when both ends meet',()=>{
  const h=setup();fireEvent.pointerDown(h.start,{button:0,pointerId:1,clientX:140});fireEvent.pointerMove(window,{pointerId:1,clientX:200});fireEvent.pointerUp(window,{pointerId:1});
  expect(h.start.getAttribute('aria-valuenow')).toBe('50');
  fireEvent.pointerDown(h.end,{button:0,pointerId:2,clientX:260});fireEvent.pointerMove(window,{pointerId:2,clientX:90});fireEvent.pointerUp(window,{pointerId:2});
  expect(h.end.getAttribute('aria-valuenow')).toBe('51');
});
it.each(['Escape','pointercancel','blur'])('restores selection on %s and does not resume after release',kind=>{
  const h=setup();fireEvent.pointerDown(h.start,{button:0,pointerId:1,clientX:140});fireEvent.pointerMove(window,{pointerId:1,clientX:200});
  if(kind==='Escape')fireEvent.keyDown(window,{key:'Escape'});else if(kind==='pointercancel')fireEvent.pointerCancel(window,{pointerId:1});else fireEvent.blur(window);
  fireEvent.pointerMove(window,{pointerId:1,clientX:220});fireEvent.pointerUp(window,{pointerId:1});expect(h.start.getAttribute('aria-valuenow')).toBe('20');
});
it('supports precise keyboard adjustment and separated handles for a one-frame selection',()=>{
  const h=setup({startFrame:20,endFrame:21});fireEvent.keyDown(h.start,{key:'ArrowRight'});expect(h.start.getAttribute('aria-valuenow')).toBe('20');
  fireEvent.keyDown(h.end,{key:'ArrowRight',shiftKey:true});expect(h.end.getAttribute('aria-valuenow')).toBe('31');
  fireEvent.keyDown(h.start,{key:'Home'});expect(h.start.getAttribute('aria-valuenow')).toBe('0');
  fireEvent.keyDown(h.end,{key:'End'});expect(h.end.getAttribute('aria-valuenow')).toBe('100');
});
