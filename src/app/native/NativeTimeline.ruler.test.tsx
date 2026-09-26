/** @vitest-environment jsdom */
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {cleanup,render} from '@testing-library/react';
import {NativeTimeline} from './NativeTimeline';
import type {SequenceDocument} from '../../core/sequence/model';
import {rational as r} from '../../core/sequence/time';

beforeEach(()=>{
  vi.stubGlobal('requestAnimationFrame',()=>1);vi.stubGlobal('cancelAnimationFrame',()=>{});
  vi.stubGlobal('ResizeObserver',class{observe(){} disconnect(){}});
});
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();});
function doc(endFrame:number):SequenceDocument{return {schemaVersion:2,id:'doc',name:'ruler',revision:0,fps:r(30),resolution:{width:320,height:180},sequenceEndFrame:endFrame,
  background:'#000',assets:[],transcripts:[],transitions:[],ducking:{enabled:false,strength:'mid'},tracks:[{id:'v',kind:'visual',name:'字幕',enabled:true}],clips:[]};}
function ticks(zoom:number,endFrame=25200){
  const ui=render(<NativeTimeline projectId="p" document={doc(endFrame)} waveform="standard" frame={0} selected={[]} range={null} tool="select" zoom={zoom} snap={false}
    onSelect={vi.fn()} onRange={vi.fn()} onSeek={vi.fn()} onDrop={vi.fn()} onCommand={vi.fn(async()=>true)}/>);
  return [...ui.container.querySelectorAll<HTMLElement>('.native-ruler>span')];
}

it('全体表示でも隣接ラベルの間隔が 72px 以上になる',()=>{
  const lefts=ticks(0.05).map(node=>parseFloat(node.style.left));
  expect(lefts.length).toBeGreaterThan(1);
  for(let i=1;i<lefts.length;i++)expect(lefts[i]!-lefts[i-1]!).toBeGreaterThanOrEqual(72);
});
it('表示総フレームが 0 なら目盛りを 1 つも描かない',()=>{
  expect(ticks(1.5,0)).toHaveLength(0);
});
it('1 時間以上の案件ではすべてのラベルが h:mm:ss になる',()=>{
  expect(ticks(0.05,30*3600).every(node=>/^\d+:\d{2}:\d{2}$/.test(node.textContent??''))).toBe(true);
});
it('1 時間未満の案件では m:ss になる',()=>{
  expect(ticks(1.5,30*600).every(node=>/^\d+:\d{2}$/.test(node.textContent??''))).toBe(true);
});
