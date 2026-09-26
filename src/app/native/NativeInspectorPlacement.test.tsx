/** @vitest-environment jsdom */
import {createRef} from 'react';
import {afterEach,expect,it} from 'vitest';
import {act,cleanup,fireEvent,render} from '@testing-library/react';
import {NativeInspector,type NativeInspectorHandle} from './NativeInspector';
import {NativeVisualSettings} from './NativeVisualSettings';
import {NativePositionField} from './NativePositionField';
import {DEFAULT_MAIN_LAYOUT} from '../../core/mainLayout';
import type {ClipContent,SequenceDocument} from '../../core/sequence/model';
import type {NativeCommand} from './api';
import {rational as r} from '../../core/sequence/time';

afterEach(cleanup);
it.each(['telop','title','shape'] as const)('edits %s outer placement through the input queue without overwriting content or keys',async kind=>{
  const content:ClipContent=kind==='telop'?{kind,textMode:'free',data:{text:'文字',position:{x:0,y:-.5},scale:.6}}
    :kind==='title'?{kind,data:{text:'タイトル'},style:{top:10,left:20,fontSize:32}}
    :{kind,data:{kind:'rect',x1:.1,y1:.2,x2:.4,y2:.6,color:'#ffffff',thickness:'medium'}};
  const keys=[{frame:r(0),value:{position:{x:.1,y:.2}}},{frame:r(20),value:{scale:1.5}}];
  let doc:SequenceDocument={schemaVersion:2,id:'doc',name:'fixture',revision:1,fps:r(30),resolution:{width:320,height:180},sequenceEndFrame:30,
    background:'#000000',assets:[],tracks:[{id:'track',name:'内容',kind:'visual',enabled:true}],transitions:[],transcripts:[],ducking:{enabled:false,strength:'mid'},
    clips:[{id:'clip',trackId:'track',name:'内容',startFrame:0,durationFrames:30,clock:{offset:r(0),rate:r(1),duration:r(30)},content,
      visual:{layout:structuredClone(DEFAULT_MAIN_LAYOUT),opacity:.75,keyframes:structuredClone(keys)}}]};
  let release!:()=>void;const first=new Promise<void>(done=>{release=done;}),commands:NativeCommand[]=[];
  const dispatch=async(command:NativeCommand)=>{
    commands.push(command);if(commands.length===1)await first;
    if(command.type!=='update-clip')throw new Error('Unexpected command');
    doc={...doc,revision:doc.revision+1,clips:doc.clips.map(clip=>clip.id===command.clipId?{...clip,...command.patch}:clip)};
    return true;
  };
  const ref=createRef<NativeInspectorHandle>();
  const element=()=><NativeInspector ref={ref} projectId="fixture" document={doc} readDocument={()=>doc} frame={10} onSeek={()=>{}} selected={['clip']} disabled={false}
    bypassLut={false} onBypass={()=>{}} onCommand={dispatch} onUploadLut={()=>{}} onPrepareTextStyles={async()=>true}/>;
  const view=render(element());
  expect(view.getByLabelText('レイヤーの横位置（%）')).toHaveProperty('value','0');
  expect(view.getByLabelText('レイヤーのスケール（%）')).toHaveProperty('value','100');
  expect(view.container.textContent).toContain('この欄は基本配置です');
  await act(async()=>{const input=view.getByLabelText('レイヤーの横位置（%）');fireEvent.change(input,{target:{value:'322'}});fireEvent.blur(input);});
  await act(async()=>{const input=view.getByLabelText('レイヤーのスケール（%）');fireEvent.change(input,{target:{value:'140'}});fireEvent.blur(input);});
  expect(commands).toHaveLength(1);expect(doc.revision).toBe(1);
  await act(async()=>{release();expect(await ref.current!.flush()).toBe(true);});
  expect(commands).toHaveLength(2);expect(doc.revision).toBe(3);
  expect(doc.clips[0]!.visual!.layout.position).toEqual({x:3.22,y:0});expect(doc.clips[0]!.visual!.layout.scale).toBe(1.4);
  expect(doc.clips[0]!.visual!.keyframes).toEqual(keys);expect(doc.clips[0]!.content).toEqual(content);
  view.rerender(element());expect(view.getByLabelText('レイヤーの横位置（%）')).toHaveProperty('value','322');
  expect(view.getByLabelText('レイヤーのスケール（%）')).toHaveProperty('value','140');
  await act(async()=>{const input=view.getByLabelText('点 1 縦位置（%）');fireEvent.change(input,{target:{value:'-425'}});fireEvent.blur(input);expect(await ref.current!.flush()).toBe(true);});
  expect(doc.clips[0]!.visual!.keyframes[0]!.value.position).toEqual({x:.1,y:-4.25});
  // A finite persisted position can exceed percentage representation. It must
  // still be visible and recoverable without Infinity becoming an empty input.
  doc={...doc,revision:doc.revision+1,clips:doc.clips.map(clip=>({...clip,visual:{...clip.visual!,layout:{...clip.visual!.layout,position:{x:Number.MAX_VALUE,y:0}}}}))};
  view.rerender(element());
  const extreme=view.getByLabelText('レイヤーの横位置（画面半幅=1）');expect(extreme).toHaveProperty('value',String(Number.MAX_VALUE));
  await act(async()=>{fireEvent.change(extreme,{target:{value:'0'}});fireEvent.blur(extreme);expect(await ref.current!.flush()).toBe(true);});
  expect(doc.clips[0]!.visual!.layout.position.x).toBe(0);
  expect(doc.clips[0]!.content).toEqual(content);
});

it.each(['shape','title','telop'] as const)('uses the outer motion position policy for %s and keeps inner text bounded',async kind=>{
  const content:ClipContent=kind==='shape'?{kind,data:{kind:'rect',x1:0,y1:0,x2:1,y2:1,color:'#fff',thickness:'medium'}}
    :kind==='title'?{kind,data:{text:'title'},style:{top:10,left:10,fontSize:30}}
    :{kind,textMode:'free',data:{text:'inner',motion:{preset:'custom',from:{x:0}}}};
  const visual={layout:structuredClone(DEFAULT_MAIN_LAYOUT),opacity:1,keyframes:[],motion:{preset:'custom' as const,from:{x:0}}};
  const clip={id:'a',name:'a',trackId:'v',startFrame:0,durationFrames:30,clock:{offset:r(0),rate:r(1),duration:r(30)},content,visual};
  const view=render(<NativeVisualSettings clip={clip} visual={visual} resolution={{width:320,height:180}}
    onContent={async(_kind,change)=>{change(content as never);return true;}}
    onVisual={async change=>{change(visual);return true;}}/>);
  const input=view.getByLabelText('開始 横位置（%）');
  await act(async()=>{fireEvent.change(input,{target:{value:'450'}});fireEvent.blur(input);});
  if(content.kind==='telop')expect(content.data.motion!.from!.x).toBe(1.5);else expect(visual.motion.from.x).toBe(4.5);
});

it('shows an extreme key position without loss and rejects nonfinite drafts before recovery',async()=>{
  let saved=Number.MAX_VALUE;
  const view=render(<NativePositionField label="点 1 縦位置" value={saved} policy="finite" onCommit={async value=>{saved=value;return true;}}/>);
  const field=view.getByLabelText('点 1 縦位置（画面半高=1）');
  expect(field).toHaveProperty('value',String(Number.MAX_VALUE));
  await act(async()=>{fireEvent.change(field,{target:{value:'1e309'}});fireEvent.blur(field);});
  expect(saved).toBe(Number.MAX_VALUE);
  await act(async()=>{fireEvent.change(field,{target:{value:'0'}});fireEvent.blur(field);});
  expect(saved).toBe(0);
});

it.each([{start:0,external:Number.MAX_VALUE,unit:'%',expected:5},{start:Number.MAX_VALUE,external:0,unit:'画面半幅=1',expected:500}])('retains the draft unit $unit and focus when an external position changes the displayed unit',async({start,external,unit,expected})=>{
  const saved:number[]=[];const commit=async(value:number)=>{saved.push(value);return true;};
  const element=(value:number)=><NativePositionField label="レイヤーの横位置" value={value} policy="finite" onCommit={commit}/>;
  const view=render(element(start)),input=view.getByRole('spinbutton');input.focus();
  fireEvent.change(input,{target:{value:'500'}});view.rerender(element(external));
  expect(document.activeElement).toBe(input);expect(input).toHaveProperty('value','500');
  expect(view.getByLabelText(`レイヤーの横位置（${unit}）`)).toBe(input);
  await act(async()=>{fireEvent.blur(input);});expect(saved).toEqual([expected]);
});

it('Escape discards only the draft and displays the latest external value in its appropriate unit',async()=>{
  const saved:number[]=[];const element=(value:number)=><NativePositionField label="点 1 横位置" value={value} policy="finite" onCommit={async value=>{saved.push(value);return true;}}/>;
  const view=render(element(0)),input=view.getByRole('spinbutton');input.focus();fireEvent.change(input,{target:{value:'500'}});
  view.rerender(element(Number.MAX_VALUE));
  await act(async()=>{fireEvent.keyDown(input,{key:'Escape'});});
  expect(saved).toEqual([]);expect(view.getByLabelText('点 1 横位置（画面半幅=1）')).toHaveProperty('value',String(Number.MAX_VALUE));
});

it.each([true,false])('keeps a new draft and its unit while an earlier save settles (%s)',async accepted=>{
  let finish!:(ok:boolean)=>void;const pending=new Promise<boolean>(resolve=>{finish=resolve;}),saved:number[]=[];
  const element=(value:number)=><NativePositionField label="レイヤーの横位置" value={value} policy="finite" onCommit={value=>{saved.push(value);return saved.length===1?pending:Promise.resolve(true);}}/>;
  const view=render(element(0)),input=view.getByRole('spinbutton');input.focus();
  fireEvent.change(input,{target:{value:'500'}});fireEvent.blur(input);view.rerender(element(Number.MAX_VALUE));
  input.focus();fireEvent.change(input,{target:{value:'650'}});
  await act(async()=>{finish(accepted);});
  expect(input).toHaveProperty('value','650');expect(view.getByLabelText('レイヤーの横位置（%）')).toBe(input);expect(document.activeElement).toBe(input);
  await act(async()=>{fireEvent.blur(input);});expect(saved).toEqual([5,6.5]);
});
