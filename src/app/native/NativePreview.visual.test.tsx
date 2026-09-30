/** @vitest-environment jsdom */
import {act,cleanup,render,waitFor} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {NativePreview,type NativeVisualPreview} from './NativePreview';
import type {SequenceDocument} from '../../core/sequence/model';
import {DEFAULT_MAIN_LAYOUT} from '../../core/mainLayout';
import {rational as r} from '../../core/sequence/time';
const draws=vi.hoisted(()=>vi.fn());
vi.mock('../../preview/native/previewBridge',()=>({NativePreviewBridge:class {async render(plan:{document:SequenceDocument},frame:number){draws(plan.document);return {documentId:plan.document.id,revision:plan.document.revision,frame,resolution:plan.document.resolution,videos:[]};}dispose(){}clear(){}}}));
afterEach(()=>{cleanup();vi.unstubAllGlobals();draws.mockClear();});
it('renders transient color without advancing editing revision, then restores canonical pixels on cancel or revision change',async()=>{
  vi.stubGlobal('ResizeObserver',class {observe(){}disconnect(){}});vi.stubGlobal('requestAnimationFrame',()=>1);vi.stubGlobal('cancelAnimationFrame',()=>{});
  const original:SequenceDocument={schemaVersion:2,id:'doc',name:'test',revision:0,fps:r(30),resolution:{width:320,height:180},sequenceEndFrame:30,background:'#000',ducking:{enabled:false,strength:'mid'},assets:[{id:'a',name:'a',kind:'media',file:'media/a.mp4',fingerprint:'test',streams:[{index:0,kind:'video',codec:'h264',duration:r(1),frameRate:r(30),width:320,height:180}]}],tracks:[{id:'v',name:'v',kind:'visual',enabled:true}],transitions:[],transcripts:[],
    clips:[{id:'clip',name:'clip',trackId:'v',startFrame:0,durationFrames:30,clock:{offset:r(0),rate:r(1),duration:r(30)},content:{kind:'video',assetId:'a',streamIndex:0,sourceIn:r(0),rate:r(1)},visual:{layout:{...DEFAULT_MAIN_LAYOUT},opacity:1,keyframes:[]}}]};
  let doc=original,preview:NativeVisualPreview|null=null,sessionId='original';
  const element=()=> <NativePreview projectId="p" sessionId={sessionId} document={doc} onFrame={()=>{}} bypassLut={false} visualPreview={preview}/>;
  const view=render(element());await waitFor(()=>expect(draws).toHaveBeenCalled());
  preview={documentId:'doc',revision:0,clipId:'clip',visual:{...original.clips[0]!.visual!,opacity:.4}};
  await act(async()=>view.rerender(element()));expect(draws.mock.lastCall![0].clips[0].visual.opacity).toBe(.4);expect(original.clips[0]!.visual!.opacity).toBe(1);expect(doc.revision).toBe(0);
  preview=null;await act(async()=>view.rerender(element()));expect(draws.mock.lastCall![0]).toEqual(doc);
  preview={documentId:'doc',revision:0,clipId:'clip',visual:{...original.clips[0]!.visual!,opacity:.7}};await act(async()=>view.rerender(element()));
  doc={...original,revision:1};await act(async()=>view.rerender(element()));expect(draws.mock.lastCall![0]).toEqual(doc);
  preview=null;
  sessionId='external-same';doc={...doc,background:'#ff0000'};await act(async()=>view.rerender(element()));expect(draws.mock.lastCall![0].background).toBe('#ff0000');
  sessionId='external-older';doc={...original,background:'#00ff00'};await act(async()=>view.rerender(element()));expect(draws.mock.lastCall![0].background).toBe('#00ff00');
});
