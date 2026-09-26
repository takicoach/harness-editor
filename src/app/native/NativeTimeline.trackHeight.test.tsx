/** @vitest-environment jsdom */
import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {cleanup,fireEvent,render} from '@testing-library/react';
import {NativeTimeline} from './NativeTimeline';
import {fixture} from '../../core/sequence/fixtures';

beforeEach(()=>{
  localStorage.clear();
  vi.stubGlobal('ResizeObserver',class{observe(){}disconnect(){}});
  vi.stubGlobal('PointerEvent',class extends MouseEvent{pointerId:number;constructor(type:string,init:PointerEventInit={}){super(type,init);this.pointerId=init.pointerId??1;}});
  HTMLElement.prototype.setPointerCapture=vi.fn();HTMLElement.prototype.hasPointerCapture=vi.fn(()=>false);HTMLElement.prototype.releasePointerCapture=vi.fn();
});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
const document=fixture();
function setup(){
  const command=vi.fn(async()=>true);
  const props={projectId:'height-test',document,waveform:'standard' as const,frame:0,selected:[],range:null,tool:'select' as const,zoom:1,snap:false,onSelect:vi.fn(),onRange:vi.fn(),onSeek:vi.fn(),onDrop:vi.fn(),onCommand:command};
  return {props,command};
}
it('individual sizing keeps other rows and edits unchanged; whole-timeline scaling preserves the difference',()=>{
  const {props,command}=setup();const view=render(<NativeTimeline {...props} trackHeight={46}/>);
  const label=`${document.tracks[0]!.name}のトラック高さ`;
  const separator=view.getByRole('separator',{name:label});
  fireEvent.pointerDown(separator,{pointerId:1,button:0,buttons:1,clientY:100});
  fireEvent.pointerMove(separator,{pointerId:1,buttons:1,clientY:140});
  fireEvent.pointerUp(window,{pointerId:1});
  expect(separator.getAttribute('aria-valuenow')).toBe('86');
  const second=view.getByRole('separator',{name:`${document.tracks[1]!.name}のトラック高さ`});
  const secondHeight=second.getAttribute('aria-valuenow');expect(secondHeight).toBe(document.tracks[1]!.kind==='audio'?'58':'28'); // F7: tracks[1] は字幕トラック（telop クリップのみ）で既定 28px
  view.rerender(<NativeTimeline {...props} trackHeight={28}/>);
  expect(separator.getAttribute('aria-valuenow')).toBe('52');
  expect(command).not.toHaveBeenCalled();expect(props.onSeek).not.toHaveBeenCalled();
  fireEvent.doubleClick(separator);expect(separator.getAttribute('aria-valuenow')).toBe('28');
});
it('テロップだけのトラックの行は 28px、映像は 46px',()=>{
  const {props}=setup();const view=render(<NativeTimeline {...props} trackHeight={46}/>);
  expect(view.getByRole('separator',{name:'映像1のトラック高さ'}).getAttribute('aria-valuenow')).toBe('46');
  expect(view.getByRole('separator',{name:'字幕のトラック高さ'}).getAttribute('aria-valuenow')).toBe('28');
});
it('retains individual sizes for the document and isolates another project using the same track IDs',()=>{
  const {props}=setup();const view=render(<NativeTimeline {...props} trackHeight={46}/>);
  const label=`${document.tracks[0]!.name}のトラック高さ`;
  fireEvent.keyDown(view.getByRole('separator',{name:label}),{key:'ArrowDown',shiftKey:true});
  expect(view.getByRole('separator',{name:label}).getAttribute('aria-valuenow')).toBe('66');
  view.unmount();const next=render(<NativeTimeline {...props} trackHeight={46}/>);
  expect(next.getByRole('separator',{name:label}).getAttribute('aria-valuenow')).toBe('66');
  next.rerender(<NativeTimeline {...props} projectId="another" trackHeight={46}/>);
  expect(next.getByRole('separator',{name:label}).getAttribute('aria-valuenow')).toBe('46');
  next.rerender(<NativeTimeline {...props} trackHeight={46}/>);
  expect(next.getByRole('separator',{name:label}).getAttribute('aria-valuenow')).toBe('66');
});
