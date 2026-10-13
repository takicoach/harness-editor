/** @vitest-environment jsdom */
import {afterEach,expect,it,vi} from 'vitest';
import {act,cleanup,render,waitFor} from '@testing-library/react';
import {NativePreview,type NativeVisualPreview} from './NativePreview';
import type {NativeManipulationBindings} from './NativePreviewManipulation';
import {ScenePlan,scenePlanFor} from '../../core/sequence/scenePlan';
import type {SequenceDocument} from '../../core/sequence/model';
import {DEFAULT_MAIN_LAYOUT} from '../../core/mainLayout';
import {rational as r} from '../../core/sequence/time';
const plans=vi.hoisted(()=>[] as unknown[]);
const manipulation=vi.hoisted(()=>({render:undefined as undefined|((document:unknown,temporary:boolean)=>Promise<unknown>)}));
vi.mock('../../preview/native/previewBridge',()=>({NativePreviewBridge:class{
  async render(plan:unknown){plans.push(plan);return {documentId:'doc',revision:0,frame:0,resolution:{width:320,height:180},videos:[]};}
  dispose(){} clear(){} async reload(){}}}));
vi.mock('./NativePreviewManipulation',async()=>{const {forwardRef}=await import('react');
  return {NativePreviewManipulation:forwardRef((props:{render(document:unknown,temporary:boolean):Promise<unknown>})=>{manipulation.render=props.render;return null;})};});
afterEach(()=>{cleanup();plans.length=0;manipulation.render=undefined;vi.unstubAllGlobals();});
const stubs=()=>{vi.stubGlobal('ResizeObserver',class{observe(){}disconnect(){}});vi.stubGlobal('requestAnimationFrame',()=>1);vi.stubGlobal('cancelAnimationFrame',()=>{});};
const doc=(revision:number):SequenceDocument=>({schemaVersion:2,id:'doc',name:'共有',revision,fps:r(30),resolution:{width:320,height:180},sequenceEndFrame:30,background:'#000000',assets:[],tracks:[],clips:[],transitions:[],transcripts:[],ducking:{enabled:false,strength:'mid'}});
it('renders with the one plan made for this document object, and a new plan for the next document',async()=>{
  stubs();
  const first=doc(0),view=render(<NativePreview projectId="p" sessionId="s" document={first} onFrame={()=>{}} bypassLut={false}/>);
  await waitFor(()=>expect(plans.length).toBeGreaterThan(0));expect(plans.at(-1)).toBe(scenePlanFor(first));
  const second=doc(1);view.rerender(<NativePreview projectId="p" sessionId="s" document={second} onFrame={()=>{}} bypassLut={false}/>);
  await waitFor(()=>expect(plans.at(-1)).toBe(scenePlanFor(second)));expect(scenePlanFor(second)).not.toBe(scenePlanFor(first));
});
const video=():SequenceDocument=>({...doc(0),assets:[{id:'a',name:'a',kind:'media',file:'media/a.mp4',fingerprint:'test',streams:[{index:0,kind:'video',codec:'h264',duration:r(1),frameRate:r(30),width:320,height:180}]}],
  tracks:[{id:'v',kind:'visual',name:'映像',enabled:true}],
  clips:[{id:'clip',name:'元',trackId:'v',startFrame:0,durationFrames:30,clock:{offset:r(0),rate:r(1),duration:r(30)},content:{kind:'video',assetId:'a',streamIndex:0,sourceIn:r(0),rate:r(1)},visual:{layout:{...DEFAULT_MAIN_LAYOUT},opacity:1,keyframes:[]}}]});
const drawn=()=>plans.at(-1) as ScenePlan;
it('temporary displays with other contents draw their own plans; the program document always comes back to its one shared plan (設計 §2-5)',async()=>{
  stubs();
  const program=video(),shared=scenePlanFor(program);
  let document=program,sessionId='s',visualPreview:NativeVisualPreview|null=null;
  const bindings={readDocument:()=>program} as unknown as NativeManipulationBindings;
  const element=()=> <NativePreview projectId="p" sessionId={sessionId} document={document} onFrame={()=>{}} bypassLut={false} visualPreview={visualPreview} manipulation={bindings}/>;
  const view=render(element());await waitFor(()=>expect(drawn()).toBe(shared));
  // 設定欄の見た目プレビュー: 同じ id・版で中身だけ違う。共有の計画は使わず、閉じたら共有の計画へ戻る（作り直さない）。
  visualPreview={documentId:'doc',revision:0,clipId:'clip',visual:{...program.clips[0]!.visual!,opacity:.4}};await act(async()=>view.rerender(element()));
  expect(drawn()).not.toBe(shared);expect(drawn().document.clips[0]!.visual!.opacity).toBe(.4);
  visualPreview=null;await act(async()=>view.rerender(element()));expect(drawn()).toBe(shared);
  // 試し表示: 中身の違う文書オブジェクトはその文書の計画。元の文書へ戻ると最初と同じ計画。
  const trial:SequenceDocument={...program,id:'doc:trial:1',clips:program.clips.map(c=>({...c,name:'試し'}))};
  document=trial;await act(async()=>view.rerender(element()));expect(drawn()).toBe(scenePlanFor(trial));expect(drawn()).not.toBe(shared);expect(drawn().document.clips[0]!.name).toBe('試し');
  document=program;await act(async()=>view.rerender(element()));expect(drawn()).toBe(shared);
  // 操作中の一時文書: 共有しない。確定した文書はその文書の共有の計画。
  const moving:SequenceDocument={...program,clips:program.clips.map(c=>({...c,name:'操作中'}))};
  await act(async()=>{await manipulation.render!(moving,true);});expect(drawn()).not.toBe(shared);expect(drawn().document.clips[0]!.name).toBe('操作中');
  const committed:SequenceDocument={...program,revision:1,clips:program.clips.map(c=>({...c,name:'確定'}))};
  await act(async()=>{await manipulation.render!(committed,false);});expect(drawn()).toBe(scenePlanFor(committed));
  // 再読込（別セッション）で同じ id・版・中身違いの文書が来ても、その文書の計画で描く。
  sessionId='reloaded';document={...committed,clips:committed.clips.map(c=>({...c,name:'再読込'}))};await act(async()=>view.rerender(element()));
  expect(drawn()).toBe(scenePlanFor(document));expect(drawn().document.clips[0]!.name).toBe('再読込');
});
