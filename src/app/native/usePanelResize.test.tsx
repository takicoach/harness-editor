/** @vitest-environment jsdom */
import {useState} from 'react';
import {cleanup,fireEvent,render} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {usePanelResize} from './usePanelResize';
function Panel(){
  const resize=usePanelResize();const [width,setWidth]=useState(200);
  return <div role="separator" data-width={width}
    onPointerDown={event=>{const x=event.clientX,start=width;resize.start(event,move=>setWidth(start+move.clientX-x));}}
    onPointerMove={resize.onPointerMove} onLostPointerCapture={resize.onLostPointerCapture}/>;
}
beforeEach(()=>{
  vi.stubGlobal('PointerEvent',class extends MouseEvent {pointerId:number;constructor(type:string,init:PointerEventInit={}){super(type,init);this.pointerId=init.pointerId??1;}});
  HTMLElement.prototype.setPointerCapture=vi.fn();HTMLElement.prototype.hasPointerCapture=vi.fn(()=>false);HTMLElement.prototype.releasePointerCapture=vi.fn();
});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
const down=(element:HTMLElement,extra={})=>fireEvent.pointerDown(element,{pointerId:1,button:0,buttons:1,clientX:100,...extra});
const move=(element:HTMLElement,extra={})=>fireEvent.pointerMove(element,{pointerId:1,buttons:1,clientX:150,...extra});
it('resizes while held; hover after release never changes the size',()=>{
  const element=render(<Panel/>).getByRole('separator');down(element);move(element);
  expect(element.dataset.width).toBe('250');fireEvent.pointerUp(window,{pointerId:1});move(element,{buttons:0,clientX:180});expect(element.dataset.width).toBe('250');
});
it.each(['cancel','capture','blur','escape','released'])('ends an interrupted gesture: %s',reason=>{
  const element=render(<Panel/>).getByRole('separator');down(element);move(element);
  if(reason==='cancel')fireEvent.pointerCancel(window,{pointerId:1});
  if(reason==='capture')fireEvent.lostPointerCapture(element,{pointerId:1});
  if(reason==='blur')fireEvent.blur(window);
  if(reason==='escape')fireEvent.keyDown(window,{key:'Escape'});
  if(reason==='released')move(element,{buttons:0,clientX:180});
  move(element,{clientX:190});expect(element.dataset.width).toBe('250');
  down(element);move(element);expect(element.dataset.width).toBe('300');
});
it('ignores right button and unrelated pointers',()=>{
  const element=render(<Panel/>).getByRole('separator');down(element,{button:2});move(element);expect(element.dataset.width).toBe('200');
  down(element);move(element,{pointerId:2});fireEvent.pointerUp(window,{pointerId:2});expect(element.dataset.width).toBe('200');move(element);expect(element.dataset.width).toBe('250');
});
