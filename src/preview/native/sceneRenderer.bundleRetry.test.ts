/** @vitest-environment jsdom */
import {afterEach,expect,it,vi} from 'vitest';
import {NativeSceneRenderer} from './sceneRenderer';
import {ScenePlan} from '../../core/sequence/scenePlan';
import type {SequenceDocument} from '../../core/sequence/model';
import {rational as r} from '../../core/sequence/time';
import {DEFAULT_MAIN_LAYOUT} from '../../core/mainLayout';

vi.mock('./compositor',()=>({NativeCompositor:class {dispose(){}}}));
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});

/** A telop clip bound to a style-pack component (textMode:'component'), matching
 * how the caption panel's 35 built-in テロップスタイル templates render text. */
function documentFixture():SequenceDocument {
  return {schemaVersion:2,id:'bundle-retry',name:'bundle-retry',revision:1,fps:r(30),resolution:{width:320,height:180},sequenceEndFrame:100,background:'#000000',
    transitions:[],transcripts:[],ducking:{enabled:false,strength:'mid'},
    assets:[{id:'component-1',kind:'component',name:'テロップスタイル',file:'component.mjs',fingerprint:'a'.repeat(64),streams:[]}],
    tracks:[{id:'v',name:'text',kind:'visual',enabled:true}],
    clips:[{id:'text',name:'text',trackId:'v',startFrame:0,durationFrames:100,clock:{offset:r(0),rate:r(1),duration:r(100)},
      content:{kind:'telop',textMode:'component',componentAssetId:'component-1',data:{text:'テキスト',template:1,animation:'none'}},
      visual:{layout:structuredClone(DEFAULT_MAIN_LAYOUT),opacity:1,keyframes:[],enter:{kind:'none',frames:0},exit:{kind:'none',frames:0}}}]};
}

// Root cause (before fix): NativeSceneRenderer.bundle() caches the in-flight
// fetch+import PROMISE before it settles. A one-time failure (network blip, dev
// HMR racing the blob import, ...) permanently poisons the cache for that
// componentId: every later render of ANY clip using that テロップスタイル never
// retries the fetch and keeps throwing, so the preview freezes on the last
// successfully-drawn frame forever while the document (and the caption-panel
// text) keeps changing underneath it — edits look like they "don't reflect".
it('retries loading a telop style component after a transient fetch failure instead of caching the rejection forever',async()=>{
  Object.defineProperty(document,'fonts',{configurable:true,value:{ready:Promise.resolve()}});
  const fetcher=vi.fn(async()=>({ok:false,status:500}) as Response);
  vi.stubGlobal('fetch',fetcher);
  const container=document.createElement('div');document.body.append(container);
  const renderer=new NativeSceneRenderer(container,'bundle-retry-project');
  const doc=documentFixture();
  try{
    await expect(renderer.render(new ScenePlan(doc),0)).rejects.toBeTruthy();
    expect(fetcher).toHaveBeenCalledTimes(1);
    await expect(renderer.render(new ScenePlan({...doc,revision:doc.revision+1}),0)).rejects.toBeTruthy();
    // A second attempt must re-fetch the component instead of replaying a stale
    // rejected promise from the first, transient failure.
    expect(fetcher).toHaveBeenCalledTimes(2);
  } finally { renderer.dispose();container.remove(); }
});
