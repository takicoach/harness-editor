/** @vitest-environment jsdom */
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render} from '@testing-library/react';
import {readFileSync} from 'node:fs';
import {NativeTimeline,TRACK_LABEL_WIDTH} from './NativeTimeline';
import type {SequenceDocument} from '../../core/sequence/model';
import {rational as r} from '../../core/sequence/time';
import type {ImportFrame} from './importFrames';
vi.mock('../timeline/useFilmstrip',()=>({useFilmstrip:()=>[],STRIP_THUMB_PX:80}));
vi.mock('../audio/useWaveformSamples',()=>({useWaveformSamples:()=>({samples:null,failed:false})}));
beforeEach(()=>{vi.stubGlobal('requestAnimationFrame',()=>1);vi.stubGlobal('cancelAnimationFrame',()=>{});vi.stubGlobal('ResizeObserver',class{observe(){}disconnect(){}});vi.spyOn(HTMLCanvasElement.prototype,'getContext').mockReturnValue(null);});
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();});
const doc=(tracks:SequenceDocument['tracks']):SequenceDocument=>({schemaVersion:2,id:'d',name:'x',revision:0,fps:r(30),resolution:{width:320,height:180},sequenceEndFrame:0,background:'#000',
  transcripts:[],transitions:[],ducking:{enabled:false,strength:'mid'},assets:[],tracks,clips:[]});
const frames:ImportFrame[]=[{batchId:'imp-aaaaaaaaaaaaaaaaaaaa',itemId:'i0',name:'take1.mp4',phase:'probing',startFrame:0,durationFrames:30,estimated:false,first:true,batchSize:2},
  {batchId:'imp-aaaaaaaaaaaaaaaaaaaa',itemId:'i1',name:'take2.mp4',phase:'failed',error:'壊れています',startFrame:30,durationFrames:150,estimated:true,first:false,batchSize:2}];
const props={projectId:'p',waveform:'standard' as const,frame:0,selected:[],range:null,tool:'select' as const,zoom:2,snap:false,onSelect:vi.fn(),onRange:vi.fn(),onSeek:vi.fn(),onDrop:vi.fn(),onCommand:vi.fn(async()=>true),onZoomChange:vi.fn()};
it('draws the frames on the main video row and cancels the batch from the first frame',()=>{
  const onCancelImport=vi.fn();
  const view=render(<NativeTimeline {...props} document={doc([{id:'v-main',kind:'visual',name:'映像1',enabled:true}])} importFrames={frames} onCancelImport={onCancelImport}/>);
  const row=view.container.querySelector('[data-native-track="v-main"]')!,items=row.querySelectorAll<HTMLElement>('[data-import-frame]');
  expect(items).toHaveLength(2);expect(items[1]!.style.left).toBe(`${TRACK_LABEL_WIDTH+60}px`);expect(items[1]!.textContent).toContain('失敗: 壊れています');
  fireEvent.click(view.getByRole('button',{name:'読み込み中の2本を取り消す'}));expect(onCancelImport).toHaveBeenCalledWith('imp-aaaaaaaaaaaaaaaaaaaa');
});
it('says on a frame waiting for a decision where to choose, and still cancels the batch from it',()=>{
  const onCancelImport=vi.fn(),waiting:ImportFrame[]=[{...frames[0]!,phase:'awaiting-decision',batchSize:1}];
  const view=render(<NativeTimeline {...props} document={doc([{id:'v-main',kind:'visual',name:'映像1',enabled:true}])} importFrames={waiting} onCancelImport={onCancelImport}/>);
  const frame=view.container.querySelector<HTMLElement>('[data-import-frame="i0"]')!;
  expect(frame.textContent).toContain('コピーするか確認待ち');expect(frame.title).toBe('take1.mp4（コピーするか確認待ち。素材の欄で選んでください）');
  fireEvent.click(view.getByRole('button',{name:'読み込み中の1本を取り消す'}));expect(onCancelImport).toHaveBeenCalledWith('imp-aaaaaaaaaaaaaaaaaaaa');
});
it('names the cancel button after the failed items when every item of the batch failed',()=>{
  const failed:ImportFrame[]=[{...frames[1]!,itemId:'i0',first:true,batchSize:2,startFrame:0},{...frames[1]!,itemId:'i1',first:false,batchSize:2,startFrame:150}];
  const view=render(<NativeTimeline {...props} document={doc([{id:'v-main',kind:'visual',name:'映像1',enabled:true}])} importFrames={failed} onCancelImport={vi.fn()}/>);
  expect(view.getByRole('button',{name:'失敗した2本を取り消す'})).toBeTruthy();
});
it('shows a temporary main lane when the project has no main video track',()=>{
  const view=render(<NativeTimeline {...props} document={doc([{id:'a-main',kind:'audio',name:'原音1',enabled:true}])} importFrames={frames}/>);
  expect(view.container.querySelector('[data-import-lane]')!.querySelectorAll('[data-import-frame]')).toHaveLength(2);
});
const rule=(css:string,selector:string)=>new RegExp(`(?:^|\\})\\s*${selector.replace(/[.[\]=-]/g,'\\$&')}\\s*\\{([^}]*)\\}`,'m').exec(css)?.[1];
it('lets pointer events through the frames to the row, except for the cancel button',()=>{
  const css=readFileSync('src/app/native/native-import.css','utf8').replace(/\/\*[\s\S]*?\*\//g,'');
  const frame=rule(css,'.native-import-frame'),cancel=rule(css,'.native-import-cancel');
  expect(frame).toBeDefined();expect(cancel).toBeDefined();
  expect(frame!.replace(/\s/g,'')).toContain('pointer-events:none');expect(cancel!.replace(/\s/g,'')).toContain('pointer-events:auto');
  // 存在検査: 規則の名前は実際に描いた枠とボタンのもの
  const view=render(<NativeTimeline {...props} document={doc([{id:'v-main',kind:'visual',name:'映像1',enabled:true}])} importFrames={frames} onCancelImport={vi.fn()}/>);
  expect(view.container.querySelectorAll('[data-import-frame].native-import-frame')).toHaveLength(2);expect(view.container.querySelectorAll('button.native-import-cancel')).toHaveLength(1);
});
it('counts the temporary main lane in the row positions below it',()=>{
  const tracks:SequenceDocument['tracks']=[{id:'a-main',kind:'audio',name:'原音1',enabled:true}],range={startFrame:0,endFrame:30,trackId:'a-main'};
  const hostTop=(withFrames:boolean)=>{const view=render(<NativeTimeline {...props} document={doc(tracks)} range={range} {...(withFrames?{importFrames:frames}:{})}/>);
    const host=view.container.querySelector<HTMLElement>('.native-range-cut-host'),lane=view.container.querySelector<HTMLElement>('[data-import-lane]');
    const result={top:host?parseFloat(host.style.top):NaN,lane:lane?parseFloat(lane.style.getPropertyValue('--native-visual-track-height')):undefined};cleanup();return result;};
  const before=hostTop(false),after=hostTop(true);
  expect(Number.isFinite(before.top)).toBe(true);expect(before.lane).toBeUndefined();expect(after.lane).toBeGreaterThan(0);
  expect(after.top-before.top).toBe(after.lane);
});
