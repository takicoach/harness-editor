/** @vitest-environment jsdom */
import {createRef} from 'react';
import {act,cleanup,fireEvent,render,waitFor} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {NativeInspector,type NativeInspectorHandle} from './NativeInspector';
import {applySequenceCommand} from '../../core/sequence/commands';
import type {SequenceDocument} from '../../core/sequence/model';
import {rational as r} from '../../core/sequence/time';
import type {SceneFadeTarget} from '../../core/sequence/sceneFadeEdits';
import type {NativeCommand} from './api';
import {NativeTimeline} from './NativeTimeline';
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
function harness(){
  let document:SequenceDocument={schemaVersion:2,id:'doc',name:'test',revision:0,fps:r(30),resolution:{width:320,height:180},sequenceEndFrame:90,background:'#000000',ducking:{enabled:false,strength:'mid'},assets:[],tracks:[],clips:[],transitions:[],transcripts:[]};
  const ref=createRef<NativeInspectorHandle>(),commands:NativeCommand[]=[];let target:SceneFadeTarget={kind:'head'},beforeCommit:(()=>Promise<void>)|undefined,beforeTarget:(()=>Promise<boolean>)|undefined;
  const dispatch=async(command:NativeCommand)=>{
    commands.push(command);const revision=document.revision;await beforeCommit?.();
    if(revision!==document.revision)return false;
    if(command.type==='undo'||command.type==='redo')throw new Error('Unexpected history command');
    document=applySequenceCommand(document,command);view.rerender(element());return true;
  };
  const element=()=><NativeInspector ref={ref} projectId="test" document={document} readDocument={()=>document} frame={0} onSeek={()=>{}} selected={[]} disabled={false} bypassLut={false} onBypass={()=>{}} onCommand={dispatch} onUploadLut={()=>{}} onPrepareTextStyles={async()=>true} showSceneFades sceneFadeTarget={target} onSceneFadeTargetChange={async next=>{if(!await ref.current!.flush())return false;if(beforeTarget&&!await beforeTarget())return false;target=next;view.rerender(element());return true;}}/>;
  const view=render(element());
  return {view,ref,commands,get doc(){return document;},hold(work?:()=>Promise<void>){beforeCommit=work;},holdTarget(work?:()=>Promise<boolean>){beforeTarget=work;},external(){document={...document,revision:document.revision+1,name:'external'};view.rerender(element());}};
}
it.each([true,false])('prevents editing the old fade while target activation waits, and restores controls after success=%s',async success=>{
  const h=harness();
  const kind=()=>h.view.getByLabelText('フェードの種類');
  const number=()=>h.view.getByLabelText('フェードの長さ（fr）') as HTMLInputElement;
  const target=()=>h.view.getByLabelText('フェードの対象') as HTMLSelectElement;
  await act(async()=>fireEvent.change(kind(),{target:{value:'fadeBlack'}}));
  await act(async()=>fireEvent.change(target(),{target:{value:'tail'}}));
  await act(async()=>fireEvent.change(kind(),{target:{value:'fadeWhite'}}));
  await act(async()=>{number().focus();fireEvent.change(number(),{target:{value:'31'}});number().blur();await h.ref.current!.flush();});
  await act(async()=>fireEvent.change(target(),{target:{value:'head'}}));
  let entered=false,release!:(value:boolean)=>void;const gate=new Promise<boolean>(resolve=>{release=resolve;});
  h.holdTarget(()=>{entered=true;return gate;});
  fireEvent.change(target(),{target:{value:'tail'}});
  await waitFor(()=>expect(entered).toBe(true));
  try{
    expect(target().value).toBe('tail');
    expect(number().value).toBe('15');
    expect(number().matches(':disabled')).toBe(true);
    expect(kind().matches(':disabled')).toBe(true);
  }finally{await act(async()=>{release(success);});}
  expect(number().matches(':disabled')).toBe(false);
  expect(target().value).toBe(success?'tail':'head');
  expect(number().value).toBe(success?'31':'15');
  await act(async()=>{number().focus();fireEvent.change(number(),{target:{value:'23'}});await h.ref.current!.flush();});
  expect(h.doc.clips.find(c=>c.content.kind==='scene-fade'&&c.content.phase===(success?'tail':'head'))!.clock.duration).toEqual(r(23));
  expect(h.doc.clips.find(c=>c.content.kind==='scene-fade'&&c.content.phase===(success?'head':'tail'))!.clock.duration).toEqual(r(success?15:31));
});
it('creates and edits with no selected clip through the shared queue, retaining both delayed number and select intents',async()=>{
  const h=harness();await act(async()=>fireEvent.change(h.view.getByLabelText('フェードの種類'),{target:{value:'fadeBlack'}}));
  expect(h.doc.clips).toHaveLength(1);
  let release!:()=>void;const gate=new Promise<void>(done=>{release=done;});h.hold(()=>gate);
  const number=h.view.getByLabelText('フェードの長さ（fr）');fireEvent.focus(number);fireEvent.change(number,{target:{value:'31'}});fireEvent.blur(number);
  fireEvent.change(h.view.getByLabelText('フェードの種類'),{target:{value:'fadeWhite'}});
  await waitFor(()=>expect(h.commands).toHaveLength(2));
  await act(async()=>{release();await h.ref.current!.flush();});
  expect(h.commands).toHaveLength(3);expect(h.doc.revision).toBe(3);expect(h.doc.clips[0]!.clock.duration).toEqual(r(31));expect(h.doc.clips[0]!.content).toMatchObject({color:'#FFFFFF'});
});
it('flushes the old target before switching and commits new input to the selected endpoint',async()=>{
  const h=harness();await act(async()=>fireEvent.change(h.view.getByLabelText('フェードの種類'),{target:{value:'fadeBlack'}}));
  const number=h.view.getByLabelText('フェードの長さ（fr）') as HTMLInputElement;number.focus();fireEvent.change(number,{target:{value:'31'}});
  await act(async()=>fireEvent.change(h.view.getByLabelText('フェードの対象'),{target:{value:'tail'}}));
  expect(h.doc.clips[0]!.clock.duration).toEqual(r(31));
  await act(async()=>fireEvent.change(h.view.getByLabelText('フェードの種類'),{target:{value:'fadeWhite'}}));
  expect(h.doc.clips).toHaveLength(2);expect(h.doc.clips[1]!.content).toMatchObject({phase:'tail',color:'#FFFFFF'});
});
it('commits a 90 frame duration without silently shortening it, and rejects an unsafe integer without changing the fade',async()=>{
  const h=harness();await act(async()=>fireEvent.change(h.view.getByLabelText('フェードの種類'),{target:{value:'fadeBlack'}}));
  const number=h.view.getByLabelText('フェードの長さ（fr）');
  fireEvent.change(number,{target:{value:'90'}});await act(async()=>fireEvent.blur(number));
  expect(h.doc.clips[0]!.clock.duration).toEqual(r(90));expect(h.doc.revision).toBe(2);
  fireEvent.change(number,{target:{value:'9007199254740992'}});await act(async()=>fireEvent.blur(number));
  expect(h.doc.clips[0]!.clock.duration).toEqual(r(90));expect(h.doc.revision).toBe(2);expect(h.view.getAllByRole('alert').length).toBeGreaterThan(0);
});
it('identifies displaced fades by human readable number and timing instead of internal IDs',async()=>{
  const h=harness();await act(async()=>fireEvent.change(h.view.getByLabelText('フェードの種類'),{target:{value:'fadeBlack'}}));
  const fade=h.doc.clips[0]!;fade.startFrame=3;act(()=>h.external());
  expect(h.view.container.textContent).not.toContain(fade.id);
  expect(h.view.getByRole('option',{name:/既存の場面フェード 1.*開始 3fr.*長さ 15fr/})).toBeTruthy();
});
it('rejects moving a general clip into another fade track but permits same-track time moves and explicit fade moves',async()=>{
  vi.stubGlobal('ResizeObserver',class {observe(){}disconnect(){}});vi.stubGlobal('PointerEvent',MouseEvent);
  const h=harness();const base=h.doc;cleanup();
  const doc=applySequenceCommand(base,{type:'set-scene-fades',targets:[{kind:'head'}],change:{enabled:true}});
  const fade=doc.clips[0]!,fadeTrack=doc.tracks[0]!.id;
  doc.tracks.unshift({id:'general',name:'general',kind:'visual',enabled:true});
  doc.clips.push({id:'general-clip',name:'general',trackId:'general',startFrame:0,durationFrames:10,clock:{offset:r(0),rate:r(1),duration:r(10)},content:{kind:'telop',data:{text:'text'}}});
  const command=vi.fn(async()=>true);
  const element=()=><NativeTimeline document={doc} projectId="p" waveform="standard" frame={0} selected={[]} range={null} tool="select" zoom={1} snap={false} onSelect={()=>{}} onRange={()=>{}} onSeek={()=>{}} onCommand={command} onDrop={()=>{}}/>;
  const view=render(element());
  const drag=async(id:string,track:string)=>{
    const clip=view.container.querySelector<HTMLElement>(`[data-native-clip-id="${id}"]`)!;
    Object.defineProperty(clip,'setPointerCapture',{value:()=>{},configurable:true});
    Object.defineProperty(document,'elementFromPoint',{value:()=>view.container.querySelector(`[data-native-track="${track}"]`),configurable:true});
    await act(async()=>{
      fireEvent.pointerDown(clip,{button:0,clientX:150,clientY:50});
      fireEvent.pointerMove(clip,{clientX:155,clientY:100});
      // Pointer-up is the final pointer sample, and the async command must settle
      // before the next independent drag starts.
      fireEvent.pointerUp(clip,{clientX:155,clientY:100});
    });
  };
  await drag('general-clip',fadeTrack);expect(command).not.toHaveBeenCalled();expect(view.getByRole('status').textContent).toContain('場面フェード');
  doc.clips[1]!.trackId=fadeTrack;view.rerender(element());
  await drag('general-clip',fadeTrack);expect(command).toHaveBeenLastCalledWith({type:'move',clipIds:['general-clip'],deltaFrames:5,trackId:fadeTrack});
  await drag(fade.id,'general');expect(command).toHaveBeenLastCalledWith({type:'move',clipIds:[fade.id],deltaFrames:5,trackId:'general'});
});
it('does not rebase queued edits across an external revision, and permits a later fresh correction',async()=>{
  const h=harness();await act(async()=>fireEvent.change(h.view.getByLabelText('フェードの種類'),{target:{value:'fadeBlack'}}));
  let release!:()=>void;const gate=new Promise<void>(done=>{release=done;});h.hold(()=>gate);
  const number=h.view.getByLabelText('フェードの長さ（fr）');fireEvent.change(number,{target:{value:'31'}});fireEvent.blur(number);
  fireEvent.change(h.view.getByLabelText('フェードの種類'),{target:{value:'fadeWhite'}});await waitFor(()=>expect(h.commands).toHaveLength(2));
  act(()=>h.external());await act(async()=>{release();await h.ref.current!.flush();});
  expect(h.doc.name).toBe('external');expect(h.doc.clips[0]!.clock.duration).toEqual(r(15));expect(h.doc.clips[0]!.content).toMatchObject({color:'#000000'});expect(h.commands).toHaveLength(2);
  expect(h.view.getAllByRole('alert').length).toBeGreaterThan(0);h.hold();
  await act(async()=>fireEvent.change(h.view.getByLabelText('フェードの種類'),{target:{value:'fadeColor'}}));
  expect(h.doc.clips[0]!.content).toMatchObject({color:'#FF3B30'});
});
it('reports a displaced existing tail instead of silently presenting none or creating a second plane',async()=>{
  const h=harness();await act(async()=>fireEvent.change(h.view.getByLabelText('フェードの対象'),{target:{value:'tail'}}));
  await act(async()=>fireEvent.change(h.view.getByLabelText('フェードの種類'),{target:{value:'fadeBlack'}}));
  const fade=h.doc.clips[0]!;fade.startFrame-=3;act(()=>h.external());
  expect(h.view.getByRole('status').textContent).toContain('位置がずれた');expect(h.view.queryByLabelText('フェードの種類')).toBeNull();
  await act(async()=>fireEvent.click(h.view.getByRole('button',{name:'この位置へ移す'})));
  expect(h.doc.clips).toHaveLength(1);expect(h.doc.clips[0]!.id).toBe(fade.id);expect(h.doc.clips[0]!.startFrame).toBe(75);
});
it('keeps nonstandard clocks editable by color without offering a destructive duration reset',async()=>{
  const h=harness();await act(async()=>fireEvent.change(h.view.getByLabelText('フェードの種類'),{target:{value:'fadeBlack'}}));
  const fade=h.doc.clips[0]!;fade.clock.rate=r(2);act(()=>h.external());
  expect(h.view.queryByLabelText('フェードの長さ（fr）')).toBeNull();expect(h.view.getByText(/標準外の時計/)).toBeTruthy();
  const color=h.view.getByLabelText('フェードの色');fireEvent.change(color,{target:{value:'#123456'}});
  await act(async()=>fireEvent.blur(color));expect(h.doc.clips[0]!.clock.rate).toEqual(r(2));expect(h.doc.clips[0]!.content).toMatchObject({color:'#123456'});
});
it('routes timeline edge and connection buttons to settings without seeking, dragging or mutating the document',()=>{
  vi.stubGlobal('ResizeObserver',class {observe(){}disconnect(){}});
  const doc:SequenceDocument={schemaVersion:2,id:'timeline',name:'timeline',revision:0,fps:r(30),resolution:{width:320,height:180},sequenceEndFrame:60,background:'#000000',assets:[],tracks:[{id:'v',name:'映像',kind:'visual',enabled:true}],clips:[0,1].map(i=>({id:`v${i}`,name:`映像${i}`,trackId:'v',startFrame:i*30,durationFrames:30,clock:{offset:r(0),rate:r(1),duration:r(30)},content:{kind:'video',assetId:'source',streamIndex:0,sourceIn:r(0),rate:r(1)}})),transitions:[],transcripts:[],ducking:{enabled:false,strength:'mid'}};
  const chosen=vi.fn(),seek=vi.fn(),command=vi.fn(async()=>true),selected=vi.fn();
  const view=render(<NativeTimeline document={doc} projectId="p" waveform="standard" frame={0} selected={[]} range={null} tool="select" zoom={1} snap onSelect={selected} onRange={()=>{}} onSeek={seek} onCommand={command} onDrop={()=>{}} onSceneFade={chosen}/>);
  for(const name of ['動画の最初のフェードを設定','動画の最後のフェードを設定','映像 · 映像0 → 映像1（30fr） のフェードを設定']){
    const button=view.getByRole('button',{name});fireEvent.pointerDown(button,{button:0});fireEvent.click(button);
  }
  expect(chosen.mock.calls.map(c=>c[0])).toEqual([{kind:'head'},{kind:'tail'},{kind:'join',trackId:'v',outClipId:'v0',inClipId:'v1'}]);
  expect(seek).not.toHaveBeenCalled();expect(command).not.toHaveBeenCalled();expect(selected).not.toHaveBeenCalled();
});
it('shows scene-fade settings throughout finishing mode regardless of selection, and only for the project or a scene-fade clip in editing mode',()=>{
  const doc:SequenceDocument={schemaVersion:2,id:'doc',name:'kind',revision:0,fps:r(30),resolution:{width:320,height:180},sequenceEndFrame:90,background:'#000000',
    assets:[],tracks:[{id:'t',name:'t',kind:'visual',enabled:true}],transitions:[],transcripts:[],ducking:{enabled:false,strength:'mid'},
    clips:[
      {id:'fade',trackId:'t',name:'場面フェード',startFrame:0,durationFrames:15,clock:{offset:r(0),rate:r(1),duration:r(15)},content:{kind:'scene-fade',phase:'head',color:'#000000'}},
      {id:'shape',trackId:'t',name:'図形',startFrame:30,durationFrames:30,clock:{offset:r(0),rate:r(1),duration:r(30)},content:{kind:'shape',data:{kind:'rect',x1:.1,y1:.2,x2:.4,y2:.6,color:'#ffffff',thickness:'medium'}}},
    ]};
  const props=(selected:string[],showSceneFades:boolean)=>({projectId:'p',document:doc,readDocument:()=>doc,frame:0,onSeek:()=>{},selected,disabled:false,
    bypassLut:false,onBypass:()=>{},onCommand:async()=>true,onUploadLut:()=>{},onPrepareTextStyles:async()=>true,showSceneFades});
  // 仕上げモード＋未選択（案件全体）→ 表示
  const finishingUnselected=render(<NativeInspector {...props([],true)}/>);
  expect(finishingUnselected.queryByLabelText('フェードの種類')).not.toBeNull();finishingUnselected.unmount();
  // 仕上げモード＋映像系クリップ（図形）選択中 → 表示（T13 回帰の裁定：仕上げモードは選択に関わらず常時表示）
  const finishingOtherSelected=render(<NativeInspector {...props(['shape'],true)}/>);
  expect(finishingOtherSelected.queryByLabelText('フェードの種類')).not.toBeNull();finishingOtherSelected.unmount();
  // 編集モード＋未選択（案件全体）→ 表示
  const editingUnselected=render(<NativeInspector {...props([],false)}/>);
  expect(editingUnselected.queryByLabelText('フェードの種類')).not.toBeNull();editingUnselected.unmount();
  // 編集モード＋scene-fadeクリップ選択 → 表示
  const editingFadeSelected=render(<NativeInspector {...props(['fade'],false)}/>);
  expect(editingFadeSelected.queryByLabelText('フェードの種類')).not.toBeNull();editingFadeSelected.unmount();
  // 編集モード＋他クリップ（図形）選択 → 非表示
  const editingOtherSelected=render(<NativeInspector {...props(['shape'],false)}/>);
  expect(editingOtherSelected.queryByLabelText('フェードの種類')).toBeNull();editingOtherSelected.unmount();
});
