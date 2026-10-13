/** @vitest-environment jsdom */
import {afterEach,expect,it,vi} from 'vitest';
import {ScenePlan} from '../../core/sequence/scenePlan';
import {fixture} from '../../core/sequence/fixtures';
import * as validate from '../../core/sequence/validate';
const drawn=vi.hoisted(()=>[] as Array<[unknown,number,boolean]>);
const geometry=vi.hoisted(()=>({videos:[]}));
vi.mock('./sceneRenderer',()=>({NativeSceneRenderer:class{
  async render(plan:unknown,frame:number,_bypass:boolean,isCurrent:()=>boolean){drawn.push([plan,frame,isCurrent()]);}
  geometry(){return geometry;} measureLegacy(){return null;} clear(){} dispose(){}}}));
afterEach(()=>{vi.restoreAllMocks();});
it('draws the parent plan as it is, keeps isCurrent, and still validates a document handed in from outside (設計 §2-5)',async()=>{
  history.replaceState(null,'','/native-render.html?id=p&preview=1');document.body.innerHTML='<div id="stage"></div>';
  await import('./renderPage');await vi.waitFor(()=>expect(window.harnessNativeReady).toBe(true));
  const bad=JSON.stringify({...fixture(),fps:'30'}),expected=(()=>{try{validate.parseSequence(bad);return '';}catch(error){return (error as Error).message;}})();expect(expected).not.toBe('');
  const plan=new ScenePlan(fixture()),parse=vi.spyOn(validate,'parseSequence');
  // 親の計画: そのまま描く（読み直さない）。古くなった描画は null（isCurrent を保つ）。
  expect(await window.harnessNativePreviewPlan!(plan,3,false,()=>true)).toBe(geometry);expect(drawn.at(-1)![0]).toBe(plan);expect(drawn.at(-1)!.slice(1)).toEqual([3,true]);
  expect(await window.harnessNativePreviewPlan!(plan,4,false,()=>false)).toBeNull();expect(drawn.at(-1)![0]).toBe(plan);expect(drawn.at(-1)!.slice(1)).toEqual([4,false]);expect(parse).not.toHaveBeenCalled();
  // 外からの文書: 今のまま検証してから描く。壊れた文書は描かない。
  const count=drawn.length;
  await expect(window.harnessNativePreviewFrame!(bad,0,false,()=>true)).rejects.toEqual({kind:'render',message:expected});expect(drawn).toHaveLength(count);
  const serialized=validate.serializeSequence(fixture());
  expect(await window.harnessNativePreviewFrame!(serialized,0,false,()=>true)).toBe(geometry);expect(parse).toHaveBeenCalledWith(serialized);
  const external=drawn.at(-1)![0] as ScenePlan;expect(external).toBeInstanceOf(ScenePlan);expect(external).not.toBe(plan);expect(external.document).toEqual(plan.document);
});
