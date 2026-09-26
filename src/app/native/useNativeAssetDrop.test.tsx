/** @vitest-environment jsdom */
import {act,cleanup,renderHook} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import type {DragEvent} from 'react';
import {useNativeAssetDrop} from './useNativeAssetDrop';

afterEach(()=>{cleanup();document.body.replaceChildren();});
function setup(){
  const element=document.createElement('div');document.body.append(element);
  const props={scroller:{current:element},ownerKey:'A:1',disabled:false,position:(x:number)=>x+element.scrollLeft-132,valid:(id:string,track:string)=>id==='asset'&&track==='track',drop:vi.fn()};
  const hook=renderHook(()=>useNativeAssetDrop(props));
  const event=(x=150,id='asset')=>({clientX:x,clientY:50,preventDefault:vi.fn(),relatedTarget:null,dataTransfer:{types:['application/x-harness-asset'],getData:()=>id,dropEffect:''}} as unknown as DragEvent);
  const start=()=>act(()=>{const e=new Event('dragstart');Object.defineProperty(e,'dataTransfer',{value:{types:['application/x-harness-asset']}});window.dispatchEvent(e);});
  const over=()=>act(()=>hook.result.current.over(event(),'track'));
  return {props,hook,event,start,over,element};
}
it('recomputes a stationary HTML pointer after scrolling and commits once from final coordinates',()=>{
  const h=setup();h.start();h.over();expect(h.hook.result.current.preview).toEqual({frame:18,trackId:'track'});
  act(()=>{h.element.scrollLeft=240;h.hook.result.current.refresh();});
  expect(h.hook.result.current.preview?.frame).toBe(258);expect(h.hook.result.current.pointer()?.x).toBe(150);
  act(()=>h.hook.result.current.drop(h.event(),'track'));
  act(()=>h.hook.result.current.drop(h.event(),'track'));
  expect(h.props.drop).toHaveBeenCalledExactlyOnceWith('asset',258,'track');expect(h.hook.result.current.preview).toBeNull();
});
it.each(['Escape','blur','dragend','outside'] as const)('retires HTML scrolling on %s and permits a later new drag',type=>{
  const h=setup();h.start();h.over();
  act(()=>{
    if(type==='Escape')window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}));
    else if(type==='outside')document.body.dispatchEvent(new Event('dragover',{bubbles:true}));
    else window.dispatchEvent(new Event(type));
  });
  expect(h.hook.result.current.pointer()).toBeNull();expect(h.hook.result.current.preview).toBeNull();
  act(()=>h.hook.result.current.drop(h.event(),'track'));expect(h.props.drop).not.toHaveBeenCalled();
  h.start();h.over();act(()=>h.hook.result.current.drop(h.event(),'track'));expect(h.props.drop).toHaveBeenCalledTimes(1);
});
it('leaving permits re-entry, but revision or session retirement rejects the ongoing old drag',()=>{
  const h=setup();h.start();h.over();act(()=>h.hook.result.current.leave(h.event()));h.over();expect(h.hook.result.current.preview).not.toBeNull();
  h.props.ownerKey='B:2';h.hook.rerender();h.over();act(()=>h.hook.result.current.drop(h.event(),'track'));expect(h.props.drop).not.toHaveBeenCalled();
  h.start();h.over();act(()=>h.hook.result.current.drop(h.event(),'track'));expect(h.props.drop).toHaveBeenCalledTimes(1);
});
it('rejects disabled and foreign assets without an insertion',()=>{
  const h=setup();h.props.disabled=true;h.hook.rerender();h.start();h.over();expect(h.hook.result.current.preview).toBeNull();
  h.props.disabled=false;h.hook.rerender();h.start();h.over();act(()=>h.hook.result.current.drop(h.event(150,'foreign'),'track'));expect(h.props.drop).not.toHaveBeenCalled();
});

it('unmount retires the captured pointer and stale callbacks cannot restart or insert',()=>{
  const h=setup();h.start();h.over();const stale=h.hook.result.current;h.hook.unmount();
  act(()=>{stale.over(h.event(),'track');stale.refresh();stale.drop(h.event(),'track');});
  expect(stale.pointer()).toBeNull();expect(h.props.drop).not.toHaveBeenCalled();
});

it.each(['cancel','leave','drop','unmount'] as const)('restores the original horizontal overflow on %s and keeps vertical policy',reason=>{
  const h=setup();h.element.style.setProperty('overflow-x','scroll','important');h.element.style.overflowY='auto';h.start();h.over();
  expect(h.element.style.overflowX).toBe('hidden');expect(h.element.style.overflowY).toBe('auto');
  if(reason==='unmount')h.hook.unmount();else act(()=>{if(reason==='drop')h.hook.result.current.drop(h.event(),'track');else if(reason==='leave')h.hook.result.current.leave(h.event());else h.hook.result.current.cancel();});
  expect(h.element.style.overflowX).toBe('scroll');expect(h.element.style.getPropertyPriority('overflow-x')).toBe('important');expect(h.element.style.overflowY).toBe('auto');
});

it('moving from track to ruler within the scroller retires the stale edge pointer',()=>{
  const h=setup(),ruler=document.createElement('div');h.element.append(ruler);h.start();h.over();
  act(()=>ruler.dispatchEvent(new Event('dragover',{bubbles:true})));
  expect(h.hook.result.current.pointer()).toBeNull();expect(h.hook.result.current.preview).toBeNull();
});

it('moving inside the current track does not retire its placement cursor',()=>{
  const h=setup(),track=document.createElement('div'),child=document.createElement('span');track.dataset.nativeTrack='track';track.append(child);h.element.append(track);h.start();h.over();
  act(()=>child.dispatchEvent(new Event('dragover',{bubbles:true})));
  expect(h.hook.result.current.preview).toEqual({frame:18,trackId:'track'});
});
