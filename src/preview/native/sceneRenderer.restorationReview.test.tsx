/** @vitest-environment jsdom */
import {afterEach,expect,it,vi} from 'vitest';
import {createElement} from 'react';
import {NativeSceneRenderer} from './sceneRenderer';
import {ScenePlan} from '../../core/sequence/scenePlan';
import {DEFAULT_TEXT_APPEARANCE,type SequenceDocument} from '../../core/sequence/model';
import {rational as r} from '../../core/sequence/time';
import {DEFAULT_MAIN_LAYOUT} from '../../core/mainLayout';

const fault=vi.hoisted(()=>({active:false,calls:0}));
// There is no video in this reproduction. Keep the real renderer, React root,
// DrawingBoundary, per-revision error cache and FIFO queue; only GPU startup is
// irrelevant in jsdom. The injected component simulates a transient React throw.
vi.mock('./compositor',()=>({NativeCompositor:class {dispose(){}}}));
vi.mock('./NativeText',()=>({NativeText:()=>{fault.calls++;if(fault.active)throw new Error('transient React drawing error');return createElement('span',{'data-review-healed':true},'decoded text');}}));
afterEach(()=>{fault.active=false;fault.calls=0;vi.restoreAllMocks();});

it('retries a healed component at the same canonical revision without remounting healthy boundary children',async()=>{
  vi.spyOn(console,'error').mockImplementation(()=>{});
  Object.defineProperty(document,'fonts',{configurable:true,value:{ready:Promise.resolve()}});
  const doc:SequenceDocument={schemaVersion:2,id:'review-doc',name:'review',revision:1,fps:r(30),resolution:{width:320,height:180},sequenceEndFrame:100,background:'#000000',assets:[],tracks:[{id:'v',name:'text',kind:'visual',enabled:true}],transitions:[],transcripts:[],ducking:{enabled:false,strength:'mid'},clips:[{id:'text',name:'text',trackId:'v',startFrame:0,durationFrames:100,clock:{offset:r(0),rate:r(1),duration:r(100)},content:{kind:'telop',textMode:'free',data:{text:'text'}},visual:{layout:structuredClone(DEFAULT_MAIN_LAYOUT),opacity:1,keyframes:[],enter:{kind:'none',frames:0},exit:{kind:'none',frames:0}}}]};
  const container=document.createElement('div');document.body.append(container);
  const text=doc.clips[0]!.content;if(text.kind==='telop')text.appearance=structuredClone(DEFAULT_TEXT_APPEARANCE);
  const renderer=new NativeSceneRenderer(container,'review-project');
  const draw=async(document:SequenceDocument,frame=0)=>{
    try{await renderer.render(new ScenePlan(document),frame);return {ok:true,message:'',calls:fault.calls};}
    catch(error){return {ok:false,message:String(error),calls:fault.calls};}
  };
  try{
    const initial=await draw(doc);expect(initial.ok,initial.message).toBe(true);
    fault.active=true;const provisional=structuredClone(doc);provisional.clips[0]!.visual!.layout.position.x=.25;
    const temporary=await draw(provisional);expect(temporary.ok).toBe(false);
    fault.active=false;
    const canonical=await draw(doc),healthyStyle=container.firstElementChild?.shadowRoot?.querySelector('style');
    const retry=await draw(doc),seek=await draw(doc,1);
    const retainedBoundaryChildren=healthyStyle===container.firstElementChild?.shadowRoot?.querySelector('style');
    const nextRevision=await draw({...doc,revision:2});
    const healed=Boolean(container.firstElementChild?.shadowRoot?.querySelector('[data-review-healed]'));
    console.info('F-B actual renderer',JSON.stringify({initial,temporary,canonical,retry,seek,nextRevision,healed,retainedBoundaryChildren}));
    expect(nextRevision.ok).toBe(true);expect(healed).toBe(true);
    expect(canonical.ok).toBe(true);expect(retry.ok).toBe(true);expect(seek.ok).toBe(true);expect(healthyStyle).toBeTruthy();expect(retainedBoundaryChildren).toBe(true);
  }finally{renderer.dispose();await Promise.resolve();container.remove();}
});
