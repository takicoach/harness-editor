/** @vitest-environment jsdom */
import {useState} from 'react';
import {cleanup,fireEvent,render} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {NativeCutWords} from './NativeCutWords';
beforeEach(()=>vi.stubGlobal('PointerEvent',class extends MouseEvent {pointerId:number;constructor(type:string,init:PointerEventInit){super(type,init);this.pointerId=init.pointerId??1;}}));
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
const words=['最初','次','最後'].map((text,index)=>({id:String(index),text,startFrame:10*index,endFrame:10*(index+1)}));
function setup(){
  const change=vi.fn();function Harness(){const [value,set]=useState({startFrame:5,endFrame:25});return <NativeCutWords words={words} value={value} disabled={false} onChange={next=>{set(next);change(next);}}/>;}
  const view=render(<Harness/>);return {view,change,first:view.getByText('最初'),next:view.getByText('次'),last:view.getByText('最後')};
}
it.each(['Escape','pointercancel','blur'])('cancels a word drag with %s and ignores the later release',kind=>{
  const h=setup();fireEvent.pointerDown(h.first,{button:0,pointerId:7});fireEvent.pointerEnter(h.last,{buttons:1,pointerId:7});
  expect(h.change).toHaveBeenLastCalledWith({startFrame:0,endFrame:30});
  if(kind==='Escape')fireEvent.keyDown(window,{key:'Escape'});else if(kind==='pointercancel')fireEvent.pointerCancel(window,{pointerId:7});else fireEvent.blur(window);
  fireEvent.pointerEnter(h.next,{buttons:1,pointerId:7});fireEvent.pointerUp(h.last,{pointerId:7});
  expect(h.change).toHaveBeenLastCalledWith({startFrame:5,endFrame:25});
});
it('retires on release outside the words and ignores other pointers and right clicks',()=>{
  const h=setup();fireEvent.pointerDown(h.first,{button:2,pointerId:7});expect(h.change).not.toHaveBeenCalled();
  fireEvent.pointerDown(h.first,{button:0,pointerId:7});fireEvent.pointerCancel(window,{pointerId:8});fireEvent.pointerEnter(h.last,{buttons:1,pointerId:8});
  expect(h.change).toHaveBeenLastCalledWith({startFrame:0,endFrame:10});
  fireEvent.pointerEnter(h.next,{buttons:1,pointerId:7});fireEvent.pointerUp(window,{pointerId:7});fireEvent.pointerEnter(h.last,{buttons:1,pointerId:7});
  expect(h.change).toHaveBeenLastCalledWith({startFrame:0,endFrame:20});
});
it('keeps a keyboard anchor for Shift selection and starts a new range on an ordinary click',()=>{
  const h=setup();fireEvent.click(h.first,{detail:0});fireEvent.click(h.last,{detail:0,shiftKey:true});expect(h.change).toHaveBeenLastCalledWith({startFrame:0,endFrame:30});
  fireEvent.click(h.next,{detail:0});expect(h.change).toHaveBeenLastCalledWith({startFrame:10,endFrame:20});
  fireEvent.click(h.last,{detail:0,shiftKey:true});expect(h.change).toHaveBeenLastCalledWith({startFrame:10,endFrame:30});
});
