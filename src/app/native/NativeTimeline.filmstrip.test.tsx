/** @vitest-environment jsdom */
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,waitFor} from '@testing-library/react';
import {NativeTimeline} from './NativeTimeline';
import {resetThumbs} from './frameThumbnails';
import type {SequenceDocument} from '../../core/sequence/model';
import {rational as r} from '../../core/sequence/time';
import {applySequenceCommand} from '../../core/sequence/commands';
import type {ImportFrame} from './importFrames';

vi.mock('../audio/useWaveformSamples',()=>({useWaveformSamples:()=>({samples:null,failed:false})}));
const width=Object.getOwnPropertyDescriptor(HTMLElement.prototype,'clientWidth');
beforeEach(()=>{
  vi.stubGlobal('requestAnimationFrame',()=>1);vi.stubGlobal('cancelAnimationFrame',()=>{});vi.stubGlobal('ResizeObserver',class{observe(){}disconnect(){}});
  vi.stubGlobal('PointerEvent',class extends MouseEvent{pointerId:number;constructor(type:string,init:PointerEventInit={}){super(type,init);this.pointerId=init.pointerId??1;}});
  HTMLElement.prototype.setPointerCapture=vi.fn();HTMLElement.prototype.releasePointerCapture=vi.fn();HTMLElement.prototype.hasPointerCapture=()=>true;
  Object.defineProperty(document,'elementFromPoint',{configurable:true,value:()=>null});
  vi.spyOn(HTMLCanvasElement.prototype,'getContext').mockReturnValue(null);
  // jsdom は幅 0 を返す。コマ絵は見えている幅でだけ要求するので、タイムラインの幅を与える。
  Object.defineProperty(HTMLElement.prototype,'clientWidth',{configurable:true,get:()=>1600});
});
afterEach(()=>{cleanup();resetThumbs();vi.restoreAllMocks();vi.unstubAllGlobals();
  if(width)Object.defineProperty(HTMLElement.prototype,'clientWidth',width);else Reflect.deleteProperty(HTMLElement.prototype,'clientWidth');});

const clock=(n:number)=>({offset:r(0),rate:r(1),duration:r(n)});
/** メインに別素材の2本（B は映像ストリームが 0・1 の2本で、1 を使う）。その後ろに読み込み中の枠。 */
function doc():SequenceDocument{
  return {schemaVersion:2,id:'d',name:'x',revision:0,fps:r(30),resolution:{width:320,height:180},sequenceEndFrame:270,background:'#000',transcripts:[],transitions:[],ducking:{enabled:false,strength:'mid'},
    assets:[{id:'take-a',kind:'media',file:'.harness/assets/take-a.mp4',name:'take-a.mp4',fingerprint:'a'.repeat(64),streams:[{index:0,kind:'video',codec:'h264',duration:r(10),frameRate:r(30000,1001),width:320,height:180}]},
      {id:'take-b',kind:'media',file:'.harness/assets/take-b.mp4',name:'take-b.mp4',fingerprint:'b'.repeat(64),streams:[{index:0,kind:'video',codec:'h264',duration:r(10),frameRate:r(30),width:320,height:180},{index:1,kind:'video',codec:'h264',duration:r(10),frameRate:r(30),width:320,height:180},{index:2,kind:'audio',codec:'aac',sampleRate:48000,channels:2,duration:r(10)}]}],
    tracks:[{id:'v-main',kind:'visual',name:'映像1',enabled:true}],main:{videoTrackId:'v-main'},
    clips:[{id:'a',name:'A',trackId:'v-main',startFrame:0,durationFrames:150,clock:clock(150),content:{kind:'video',assetId:'take-a',streamIndex:0,sourceIn:r(0),rate:r(1)}},
      {id:'b',name:'B',trackId:'v-main',startFrame:150,durationFrames:120,clock:clock(120),content:{kind:'video',assetId:'take-b',streamIndex:1,sourceIn:r(1),rate:r(1)}}]};
}
const frames:ImportFrame[]=[{batchId:'imp-aaaaaaaaaaaaaaaaaaaa',itemId:'i0',name:'take-c.mp4',phase:'probing',startFrame:270,durationFrames:60,estimated:false,first:true,batchSize:1}];
const base={projectId:'p',waveform:'standard' as const,frame:0,selected:[],range:null,tool:'select' as const,zoom:2,snap:false,ripple:false,onSelect:vi.fn(),onRange:vi.fn(),onSeek:vi.fn(),onDrop:vi.fn(),onCommand:vi.fn(async()=>true),onZoomChange:vi.fn()};
/** 応答の絵に「どの素材・ストリームのどの時刻か」を入れて返す。 */
function serve(){
  const fetch=vi.fn(async(input:string)=>{const url=new URL(input,'http://localhost'),asset=url.searchParams.get('asset'),stream=url.searchParams.get('stream');
    return {ok:true,json:async()=>({version:1,frames:url.searchParams.get('times')!.split(',').map((time,frame)=>({time,frame,data:`data:image/jpeg;base64,${btoa(`${asset}#${stream}@${time}`)}`})),failed:[]})};});
  vi.stubGlobal('fetch',fetch);
  return {fetch,calls:()=>fetch.mock.calls.map(([input])=>new URL(input,'http://localhost')).filter(url=>url.pathname==='/api/sequence/frames')};
}
const settle=(ms:number)=>act(async()=>{await new Promise(resolve=>setTimeout(resolve,ms));});
const strip=(view:ReturnType<typeof render>,id:string)=>view.container.querySelector<HTMLElement>(`[data-native-clip-id="${id}"] [data-native-filmstrip]`)!;
const shown=(view:ReturnType<typeof render>,id:string)=>[...strip(view,id).querySelectorAll('img')].map(img=>({time:img.getAttribute('data-native-filmstrip-time'),from:atob(img.src.slice(img.src.indexOf(',')+1))}));

it.each(['edit','finish'] as const)('%s: asks nothing before the first preview picture, then each clip of the main asks its own asset and stream; the loading frame draws none',async mode=>{
  const s=serve(),view=render(<NativeTimeline {...base} mode={mode} document={doc()} importFrames={frames} beforeFirstPicture/>);
  await settle(300);expect(s.calls()).toEqual([]);
  expect([strip(view,'a').getAttribute('data-native-filmstrip'),strip(view,'b').getAttribute('data-native-filmstrip')]).toEqual(['held','held']);
  view.rerender(<NativeTimeline {...base} mode={mode} document={doc()} importFrames={frames}/>);
  await waitFor(()=>expect([strip(view,'a').getAttribute('data-native-filmstrip'),strip(view,'b').getAttribute('data-native-filmstrip')]).toEqual(['ready','ready']));
  const calls=s.calls().map(url=>({asset:url.searchParams.get('asset'),stream:url.searchParams.get('stream'),times:url.searchParams.get('times')!.split(',')}));
  expect(calls.map(call=>[call.asset,call.stream]).sort()).toEqual([['take-a','0'],['take-b','1']]);
  for(const [id,asset,stream] of [['a','take-a','0'],['b','take-b','1']] as const){
    const images=shown(view,id),call=calls.find(c=>c.asset===asset)!;
    // 存在検査: 絵が実在し、各セルが自分の素材・ストリームの自分の時刻の応答であること。
    expect(images.length).toBeGreaterThan(0);expect(images.map(image=>image.time)).toEqual(call.times);
    expect(images.map(image=>image.from)).toEqual(call.times.map(time=>`${asset}#${stream}@${time}`));
  }
  // B は素材の 1 秒目から（ストリーム 1・30fps）。A の時刻と混ざっていない。
  const [num,den]=calls.find(c=>c.asset==='take-b')!.times[0]!.split('/').map(Number);expect(num!/den!).toBeGreaterThanOrEqual(1);
  const frame=view.container.querySelector('[data-import-frame="i0"]')!;
  expect(frame).toBeTruthy();expect(frame.querySelectorAll('[data-native-filmstrip],img')).toHaveLength(0);
});
it('freezes only the dragged clip: no request while dragging its start, the other clip keeps its frames, one request after the trim lands',async()=>{
  const s=serve(),onCommand=vi.fn(async()=>true),view=render(<NativeTimeline {...base} document={doc()} onCommand={onCommand}/>);
  await waitFor(()=>expect([strip(view,'a').getAttribute('data-native-filmstrip'),strip(view,'b').getAttribute('data-native-filmstrip')]).toEqual(['ready','ready']));
  const before=s.calls().length,a=shown(view,'a'),b=shown(view,'b');
  const handle=view.getByRole('button',{name:'Aの開始位置を調整'});
  fireEvent.pointerDown(handle,{button:0,buttons:1,pointerId:1,clientX:140,clientY:40});
  for(let x=150;x<=200;x+=10)fireEvent.pointerMove(window,{buttons:1,pointerId:1,clientX:x,clientY:40});
  await settle(300);
  // 存在検査: ドラッグが効いて A のセルの時刻が動き、取得済みのコマで埋まっている（取りに行っていない）。
  const dragged=shown(view,'a');expect(dragged.length).toBeGreaterThan(0);expect(dragged.map(image=>image.time)).not.toEqual(a.map(image=>image.time));
  expect(dragged.every(image=>a.some(old=>old.from===image.from))).toBe(true);
  expect(strip(view,'a').getAttribute('data-native-filmstrip')).toBe('ready');expect(s.calls()).toHaveLength(before);expect(shown(view,'b')).toEqual(b);
  await act(async()=>{fireEvent.pointerUp(window,{button:0,pointerId:1,clientX:200,clientY:40});});
  await waitFor(()=>expect(onCommand).toHaveBeenCalled());
  const trimmed=doc(),clip=trimmed.clips[0]!;clip.startFrame=30;clip.durationFrames=120;clip.clock=clock(120);if(clip.content.kind==='video')clip.content.sourceIn=r(1);
  view.rerender(<NativeTimeline {...base} document={{...trimmed,revision:1}} onCommand={onCommand}/>);
  await waitFor(()=>expect(s.calls()).toHaveLength(before+1));
  expect(s.calls().at(-1)!.searchParams.get('asset')).toBe('take-a');
  await waitFor(()=>expect(strip(view,'a').getAttribute('data-native-filmstrip')).toBe('ready'));
});
it('after release the trimmed clip draws the frames of its settled width (not its original place), and the confirmed document reuses them without asking again',async()=>{
  let finish!:(ok:boolean)=>void;
  const s=serve(),onCommand=vi.fn(()=>new Promise<boolean>(done=>{finish=done;})),view=render(<NativeTimeline {...base} document={doc()} onCommand={onCommand}/>);
  await waitFor(()=>expect(strip(view,'a').getAttribute('data-native-filmstrip')).toBe('ready'));
  const original=shown(view,'a').map(image=>image.time);
  fireEvent.pointerDown(view.getByRole('button',{name:'Aの開始位置を調整'}),{button:0,buttons:1,pointerId:1,clientX:140,clientY:40});
  fireEvent.pointerMove(window,{buttons:1,pointerId:1,clientX:200,clientY:40});
  await act(async()=>{fireEvent.pointerUp(window,{button:0,pointerId:1,clientX:200,clientY:40});});
  expect(onCommand).toHaveBeenCalledWith({type:'trim',clipId:'a',edge:'start',frame:30});
  // 確定待ちの間: 確定後の位置（30〜150・素材 1 秒目から）の絵を、正確な時刻で取りに行って出す。
  await waitFor(()=>expect(strip(view,'a').getAttribute('data-native-filmstrip')).toBe('ready'));
  const settled=shown(view,'a');expect(settled.length).toBeGreaterThan(0);expect(settled.map(image=>image.time)).not.toEqual(original);
  expect(settled.map(image=>image.from)).toEqual(settled.map(image=>`take-a#0@${image.time}`));
  const asked=s.calls().length;
  const trimmed=doc(),clip=trimmed.clips[0]!;clip.startFrame=30;clip.durationFrames=120;clip.clock=clock(120);if(clip.content.kind==='video')clip.content.sourceIn=r(1);
  view.rerender(<NativeTimeline {...base} document={{...trimmed,revision:1}} onCommand={onCommand}/>);await act(async()=>{finish(true);});
  await settle(300);
  expect(shown(view,'a')).toEqual(settled);expect(s.calls()).toHaveLength(asked);
});
it('finish: holds the saved (cut) piece drawn in its band as well, and asks for it once released',async()=>{
  const s=serve(),cut=applySequenceCommand(doc(),{type:'ripple-delete',startFrame:30,endFrame:60});
  const view=render(<NativeTimeline {...base} mode="finish" document={cut} beforeFirstPicture/>),saved=()=>view.container.querySelector<HTMLElement>('[data-archive-entry] [data-native-filmstrip]');
  await settle(300);expect(saved()).toBeTruthy();expect(saved()!.getAttribute('data-native-filmstrip')).toBe('held');expect(s.calls()).toEqual([]);
  view.rerender(<NativeTimeline {...base} mode="finish" document={cut}/>);
  await waitFor(()=>expect(saved()!.getAttribute('data-native-filmstrip')).toBe('ready'));
  expect(saved()!.querySelectorAll('img').length).toBeGreaterThan(0);expect(s.calls().some(url=>url.searchParams.get('asset')==='take-a')).toBe(true);
});
