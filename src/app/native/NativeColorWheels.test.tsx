/** @vitest-environment jsdom */
import {createRef,StrictMode} from 'react';
import {flushSync} from 'react-dom';
import {afterEach,beforeAll,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render} from '@testing-library/react';
import {NativeInspector,type NativeInspectorHandle} from './NativeInspector';
import {INSPECTOR_GROUPS} from './inspectorSections';
import {SequenceSession} from '../../core/sequence/session';
import type {SequenceDocument,ClipVisual} from '../../core/sequence/model';
import type {NativeCommand} from './api';
import {DEFAULT_MAIN_LAYOUT} from '../../core/mainLayout';
import {rational as r} from '../../core/sequence/time';
afterEach(cleanup);
beforeAll(()=>{window.PointerEvent=MouseEvent as typeof PointerEvent;});
function fixture():SequenceDocument {
 const doc:SequenceDocument={schemaVersion:2,id:'motion',name:'動き',revision:0,fps:r(30),resolution:{width:320,height:180},sequenceEndFrame:180,background:'#000',ducking:{enabled:false,strength:'mid'},transcripts:[],transitions:[],
  assets:[{id:'asset',kind:'media',file:'media/input.mp4',name:'素材',fingerprint:'private',streams:[{index:0,kind:'video',codec:'h264',duration:r(100),frameRate:r(30),width:320,height:180},{index:1,kind:'audio',codec:'aac',duration:r(100),sampleRate:48000,channels:2}]}],
  tracks:[{id:'v',kind:'visual',name:'映像',enabled:true},{id:'a',kind:'audio',name:'原音',enabled:true}],
  clips:[{id:'v0',trackId:'v',name:'挿入',startFrame:60,durationFrames:120,linkGroupId:'pair',clock:{offset:r(-15),rate:r(1),duration:r(120)},visual:{layout:structuredClone(DEFAULT_MAIN_LAYOUT),opacity:1,keyframes:[{frame:r(15),value:{opacity:0}},{frame:r(75),value:{opacity:1}}]},content:{kind:'video',assetId:'asset',streamIndex:0,sourceIn:r(1),rate:r(1)}},
   {id:'a0',trackId:'a',name:'原音',startFrame:60,durationFrames:120,linkGroupId:'pair',clock:{offset:r(0),rate:r(1),duration:r(120)},content:{kind:'audio',assetId:'asset',streamIndex:1,sourceIn:r(1),rate:r(1),role:'speech',loop:false,settings:{gainDb:0,muted:false,fadeInFrames:0,fadeOutFrames:0}}}]};
 return doc;
}

/** F14: 調整タブの群は既定で畳まれる。この検証は群の開閉が主題ではないので全群を開いて描く。 */
const OPEN_ALL=Object.fromEntries(INSPECTOR_GROUPS.flatMap(group=>(['none','telop','title','video','image','audio','shape','scene-fade','multi'] as const).map(kind=>[`${kind}:${group.id}`,true])));
function harness(strict=false){
 const session=new SequenceSession('color',fixture()),ref=createRef<NativeInspectorHandle>(),commands:NativeCommand[]=[],previews:Array<{clipId:string;visual:ClipVisual|null}>=[];
 let selected=['v0'],projectId='color',disabled=false,id=0,delay:Promise<void>|undefined;
 const dispatch=async(command:NativeCommand)=>{commands.push(command);const wait=delay;delay=undefined;await wait;session.execute({sessionId:session.id,expectedRevision:session.document.revision,executionId:`c${++id}`,command});view.rerender(rendered());return true;};
 const element=()=> <NativeInspector ref={ref} groupOpen={OPEN_ALL} projectId={projectId} document={session.document} readDocument={()=>session.document} frame={90} onSeek={()=>{}} selected={selected} disabled={disabled} externalBusy={disabled} bypassLut={false} onBypass={()=>{}} onCommand={dispatch} onUploadLut={()=>{}} onPrepareTextStyles={async()=>true} onPreviewVisual={(clipId,visual)=>previews.push({clipId,visual})}/>;
 const child=element;const rendered=()=>strict?<StrictMode>{child()}</StrictMode>:child();
 const view=render(rendered());
 return {view,ref,session,commands,previews,holdNext(){let release!:()=>void;delay=new Promise<void>(resolve=>release=resolve);return release;},change(next:{selected?:string[];projectId?:string;disabled?:boolean}){selected=next.selected??selected;projectId=next.projectId??projectId;disabled=next.disabled??disabled;view.rerender(rendered());},rerender(){view.rerender(rendered());}};
}
function disc(h:ReturnType<typeof harness>){const e=h.view.getByRole('button',{name:'暗部の色バランス'});vi.spyOn(e,'getBoundingClientRect').mockReturnValue({left:0,top:0,width:100,height:100,right:100,bottom:100,x:0,y:0,toJSON(){}});return e;}
it('previews multiple pointer positions then commits exactly one Undoable wheel edit, preserving source/layout/audio',async()=>{
 const h=harness(),before=structuredClone(h.session.document),e=disc(h);
 fireEvent.pointerDown(e,{button:0,clientX:60,clientY:50});fireEvent.pointerMove(e,{clientX:70,clientY:55});
 expect(h.commands).toHaveLength(0);expect(h.previews.at(-1)!.visual!.colorGrade!.wheels!.lift).toEqual({x:40,y:10,level:0});expect(h.session.document).toEqual(before);
 await act(async()=>{fireEvent.pointerUp(e);expect(await h.ref.current!.flush()).toBe(true);});
 expect(h.commands).toHaveLength(1);expect(h.session.document.clips[0]!.visual!.colorGrade!.wheels!.lift).toEqual({x:40,y:10,level:0});expect(h.previews.at(-1)!.visual).toBeNull();
 expect(h.session.document.clips[0]!.content).toEqual(before.clips[0]!.content);expect(h.session.document.clips[0]!.visual!.layout).toEqual(before.clips[0]!.visual!.layout);expect(h.session.document.clips[1]).toEqual(before.clips[1]);
 h.session.execute({sessionId:h.session.id,expectedRevision:h.session.document.revision,executionId:'undo',command:{type:'undo'}});expect({...h.session.document,revision:before.revision}).toEqual(before);
});
it.each(['Escape','pointerCancel','lostPointerCapture','windowBlur'])('cancels %s without command or lingering preview',async kind=>{
 const h=harness(),e=disc(h);fireEvent.pointerDown(e,{button:0,clientX:75,clientY:50});
 if(kind==='windowBlur')fireEvent(window,new Event('blur'));else if(kind==='Escape')fireEvent.keyDown(e,{key:'Escape'});else if(kind==='pointerCancel')fireEvent.pointerCancel(e);else fireEvent.lostPointerCapture(e);
 await act(async()=>{fireEvent.pointerUp(e);await h.ref.current!.flush();});expect(h.commands).toHaveLength(0);expect(h.previews.at(-1)!.visual).toBeNull();
});
it.each([{selected:['a0']},{projectId:'other'},{disabled:true}])('retires old pointer owner on %j',async change=>{
 const h=harness(),e=disc(h);fireEvent.pointerDown(e,{button:0,clientX:75,clientY:50});h.change(change);
 await act(async()=>{fireEvent.pointerUp(e);await h.ref.current!.flush();});expect(h.commands).toHaveLength(0);expect(h.previews.at(-1)!.visual).toBeNull();
});
it('retires a gesture after an external revision and on unmount',async()=>{
 const h=harness(),e=disc(h);fireEvent.pointerDown(e,{button:0,clientX:75,clientY:50});h.session.execute({sessionId:h.session.id,expectedRevision:0,executionId:'other',command:{type:'move',clipIds:['a0'],deltaFrames:1,linked:false}});h.rerender();
 await act(async()=>{fireEvent.pointerUp(e);await h.ref.current!.flush();});expect(h.commands).toHaveLength(0);expect(h.previews.at(-1)!.visual).toBeNull();
 fireEvent.pointerDown(e,{button:0,clientX:75,clientY:50});h.view.unmount();expect(h.previews.at(-1)!.visual).toBeNull();
});
it('uses native draft flush for numeric edits and retains keyboard/reset operations',async()=>{
 const h=harness(),field=h.view.getByRole('spinbutton',{name:'明部 明るさ'});field.focus();fireEvent.change(field,{target:{value:'23'}});
 await act(async()=>{expect(await h.ref.current!.flush()).toBe(true);});expect(h.session.document.clips[0]!.visual!.colorGrade!.wheels!.gain.level).toBe(23);
 await act(async()=>{fireEvent.keyDown(disc(h),{key:'ArrowRight',shiftKey:true});await h.ref.current!.flush();});expect(h.session.document.clips[0]!.visual!.colorGrade!.wheels!.lift.x).toBe(10);
 await act(async()=>{fireEvent.click(h.view.getByRole('button',{name:'明部をリセット'}));await h.ref.current!.flush();});expect(h.session.document.clips[0]!.visual!.colorGrade!.wheels!.gain.level).toBe(0);expect(h.commands).toHaveLength(3);
});

it('legacy adapter restores the exact transient base before one edit, even after live rerenders',async()=>{
 const {ColorWheelControls}=await import('../panels/inspector/ColorWheelControls');
 const {currentColorGrade}=await import('../edit/mainVideoOps');
 const original={telops:[],cutRegions:[],colorGrade:undefined} as unknown as import('../edit/editState').EditState;
 let state=original;const edits:unknown[]=[],live:unknown[]=[];
 const element=()=> <ColorWheelControls state={state} supported onEdit={next=>edits.push(next)} onLive={next=>{live.push(next);state=next;view.rerender(element());}}/>;
 const view=render(element()),e=view.getByRole('button',{name:'暗部の色バランス'});
 vi.spyOn(e,'getBoundingClientRect').mockReturnValue({left:0,top:0,width:100,height:100,right:100,bottom:100,x:0,y:0,toJSON(){}});
 fireEvent.pointerDown(e,{button:0,clientX:60,clientY:50});fireEvent.pointerMove(e,{clientX:70,clientY:50});fireEvent.pointerUp(e);
 expect(edits).toHaveLength(1);expect(live.at(-1)).toBe(original);expect(currentColorGrade(edits[0] as typeof original).wheels!.lift.x).toBe(40);
});
it.each(['selection','unmount'])('rejects a completed but not yet dispatched gesture after %s',async target=>{
 const h=harness(),e=disc(h);fireEvent.pointerDown(e,{button:0,clientX:75,clientY:50});
 await act(async()=>{fireEvent.pointerUp(e);if(target==='selection')flushSync(()=>h.change({selected:['a0']}));else h.view.unmount();await Promise.resolve();await Promise.resolve();});
 expect(h.commands).toHaveLength(0);expect(h.session.document.revision).toBe(0);expect(h.previews.at(-1)!.visual).toBeNull();
});

it('remains operable after StrictMode effect replay',async()=>{
 const h=harness(true),e=disc(h);fireEvent.pointerDown(e,{button:0,clientX:70,clientY:50});
 expect(h.previews.at(-1)?.visual?.colorGrade?.wheels?.lift.x).toBe(40);
 await act(async()=>{fireEvent.pointerUp(e);await h.ref.current!.flush();});expect(h.commands).toHaveLength(1);
});
it.each(['during-drag','after-release'])('keeps a drag when its own earlier number commit arrives %s',async timing=>{
 const h=harness(),release=h.holdNext(),e=disc(h),field=h.view.getByRole('spinbutton',{name:'暗部 明るさ'});
 field.focus();fireEvent.change(field,{target:{value:'23'}});
 await act(async()=>{fireEvent.pointerDown(e,{button:0,clientX:60,clientY:50});fireEvent.pointerMove(e,{clientX:70,clientY:55});await Promise.resolve();});
 try{
  expect(h.commands).toHaveLength(1);
  if(timing==='after-release')await act(async()=>{fireEvent.pointerUp(e);await Promise.resolve();});
  await act(async()=>{release();await Promise.resolve();await Promise.resolve();if(timing==='during-drag')fireEvent.pointerUp(e);await h.ref.current!.flush();});
  expect(h.commands).toHaveLength(2);expect(h.session.document.clips[0]!.visual!.colorGrade!.wheels!.lift).toEqual({x:40,y:10,level:23});expect(h.view.queryByRole('alert')).toBeNull();
 }finally{release();}
});
it('keeps transient color after pointerup until its own commit settles',async()=>{
 const h=harness(),release=h.holdNext(),e=disc(h);fireEvent.pointerDown(e,{button:0,clientX:70,clientY:55});
 try{
  await act(async()=>{fireEvent.pointerUp(e);await Promise.resolve();});
  expect(h.commands).toHaveLength(1);expect(h.session.document.revision).toBe(0);expect(h.previews.at(-1)?.visual?.colorGrade?.wheels?.lift).toEqual({x:40,y:10,level:0});
 }finally{await act(async()=>{release();await h.ref.current!.flush();});}
 expect(h.previews.at(-1)!.visual).toBeNull();expect(h.session.document.revision).toBe(1);
});
it('composes repeated arrow intentions before earlier replies without replacing another field',async()=>{
 const h=harness(),release=h.holdNext(),e=disc(h),field=h.view.getByRole('spinbutton',{name:'暗部 明るさ'});
 try{
  field.focus();fireEvent.change(field,{target:{value:'23'}});
  await act(async()=>{e.focus();fireEvent.keyDown(e,{key:'ArrowRight',shiftKey:true});fireEvent.keyDown(e,{key:'ArrowRight',shiftKey:true});fireEvent.keyDown(e,{key:'ArrowDown'});await Promise.resolve();});
 }finally{await act(async()=>{release();expect(await h.ref.current!.flush()).toBe(true);});}
 expect(h.commands).toHaveLength(4);expect(h.session.document.clips[0]!.visual!.colorGrade!.wheels!.lift).toEqual({x:20,y:1,level:23});
});
it('applies a numeric field to the result of an earlier pending drag',async()=>{
 const h=harness(),release=h.holdNext(),e=disc(h),field=h.view.getByRole('spinbutton',{name:'暗部 明るさ'});
 try{
  await act(async()=>{fireEvent.pointerDown(e,{button:0,clientX:70,clientY:55});fireEvent.pointerUp(e);await Promise.resolve();});
  field.focus();fireEvent.change(field,{target:{value:'23'}});fireEvent.blur(field);
 }finally{await act(async()=>{release();expect(await h.ref.current!.flush()).toBe(true);});}
 expect(h.commands).toHaveLength(2);expect(h.session.document.clips[0]!.visual!.colorGrade!.wheels!.lift).toEqual({x:40,y:10,level:23});
});
it('an earlier reply neither clears a new drag nor replaces its unchanged level',async()=>{
 const h=harness(),release=h.holdNext(),e=disc(h);
 try{
  await act(async()=>{fireEvent.pointerDown(e,{button:0,clientX:60,clientY:50});fireEvent.pointerUp(e);await Promise.resolve();});
  fireEvent.pointerDown(e,{button:0,clientX:80,clientY:60});
  await act(async()=>{release();await Promise.resolve();await Promise.resolve();});
  expect(h.previews.at(-1)?.visual?.colorGrade?.wheels?.lift).toEqual({x:60,y:20,level:0});
  await act(async()=>{fireEvent.pointerUp(e);expect(await h.ref.current!.flush()).toBe(true);});
  expect(h.commands).toHaveLength(2);expect(h.session.document.clips[0]!.visual!.colorGrade!.wheels!.lift).toEqual({x:60,y:20,level:0});
 }finally{release();}
});
it('rebases a stationary wheel when preceding non-wheel brightness settles',async()=>{
 const h=harness(),release=h.holdNext(),e=disc(h),field=h.view.getByRole('spinbutton',{name:/^明るさ$/});
 field.focus();fireEvent.change(field,{target:{value:'23'}});
 await act(async()=>{fireEvent.pointerDown(e,{button:0,clientX:70,clientY:55});await Promise.resolve();});
 const n=h.previews.length;
 try{
  await act(async()=>{release();await Promise.resolve();await Promise.resolve();});
  expect(h.session.document.clips[0]!.visual!.colorGrade!.brightness).toBe(23);
  expect(h.previews.length).toBeGreaterThan(n);expect(h.previews.at(-1)?.visual?.colorGrade?.brightness).toBe(23);
  expect(h.previews.at(-1)?.visual?.colorGrade?.wheels?.lift).toEqual({x:40,y:10,level:0});
 }finally{release();await act(async()=>{fireEvent.keyDown(e,{key:'Escape'});await h.ref.current!.flush();});}
});
it('retires a stationary gesture immediately when an external edit changes only another clip',async()=>{
 const h=harness(),e=disc(h);fireEvent.pointerDown(e,{button:0,clientX:70,clientY:55});
 await act(async()=>{h.session.execute({sessionId:h.session.id,expectedRevision:0,executionId:'external',command:{type:'move',clipIds:['a0'],deltaFrames:1,linked:false}});h.rerender();await Promise.resolve();});
 expect(h.previews.at(-1)?.visual).toBeNull();expect(h.commands).toHaveLength(0);
});
