/** @vitest-environment jsdom */
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {fixture} from '../../core/sequence/fixtures';
import {exportRendererOptions} from './exportSourceRelease';
const constructed=vi.hoisted(()=>[] as unknown[][]);
vi.mock('./sceneRenderer',()=>({NativeSceneRenderer:class{
  constructor(...args:unknown[]){constructed.push(args);}
  async render(){} geometry(){return null;} measureLegacy(){return null;} clear(){} dispose(){}}}));
async function load(search:string){
  history.replaceState(null,'',`/native-render.html?${search}`);document.body.innerHTML='<div id="stage"></div>';
  for(const key of ['harnessNativeReady','harnessNativeError','harnessNativeFailure'] as const)delete window[key];
  vi.resetModules();await import('./renderPage');
  await vi.waitFor(()=>expect(window.harnessNativeReady||window.harnessNativeError).toBeTruthy());
}
beforeEach(()=>{
  constructed.length=0;
  vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({document:fixture()}),{status:200})));
});
afterEach(()=>{vi.unstubAllGlobals();});

it('passes the export retention only when the runner names retain=N on the export page',async()=>{
  await load('id=p&job=j&retain=8');
  expect(window.harnessNativeError).toBeUndefined();
  expect(constructed).toHaveLength(1);expect(constructed[0]![3]).toEqual(exportRendererOptions(8));
});
it('keeps the earlier export behaviour when retain is absent',async()=>{
  await load('id=p&job=j');
  expect(constructed).toHaveLength(1);expect(constructed[0]![3]).toEqual({});
});
it('refuses a malformed retain instead of guessing a value',async()=>{
  await load('id=p&job=j&retain=0');
  expect(window.harnessNativeError).toMatch(/保持枚数/);expect(constructed).toHaveLength(0);
});
it('never gives the preview page the export retention, even if the query carries it',async()=>{
  await load('id=p&preview=1&retain=8');
  expect(constructed).toHaveLength(1);expect(constructed[0]).toHaveLength(3);
});
