/** @vitest-environment jsdom */
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {NativeHome} from './NativeApp';

const api=vi.hoisted(()=>({empty:vi.fn()}));
vi.mock('../panels/HomeDashboard',async importOriginal=>{const actual=await importOriginal<typeof import('../panels/HomeDashboard')>();return {...actual,HomeDashboardWithAgentBoard:actual.HomeDashboard};});
vi.mock('./api',async importOriginal=>({...(await importOriginal<typeof import('./api')>()),createNativeEmptyProject:(...args:unknown[])=>api.empty(...args)}));
vi.mock('./useNativeFileReference',()=>({useNativeFileReference:()=>({resolve:vi.fn(),picker:null,cancel:()=>{}})}));
vi.mock('./NativeWorkspace',()=>({NativeWorkspace:()=>null}));
vi.mock('../useProjectsWatch',()=>({useProjectsWatch:()=>{}}));
vi.mock('../layout/useTheme',()=>({useTheme:()=>({theme:'dark',toggle:()=>{}})}));
beforeEach(()=>{localStorage.clear();sessionStorage.clear();api.empty.mockReset().mockResolvedValue({id:'new-empty'});
  vi.stubGlobal('fetch',vi.fn(async(url:string)=>({ok:true,json:async()=>(String(url).startsWith('/api/config')?{tutorialEnabled:false}:{projects:[]})})));});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
it('creates an empty project from the home and opens it',async()=>{
  const navigate=vi.fn();render(<NativeHome navigate={navigate}/>);
  fireEvent.click(await screen.findByRole('button',{name:'空のプロジェクトを作成'}));
  expect(screen.getByText(/1920x1080・30fps/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:'作成'}));
  await waitFor(()=>expect(navigate).toHaveBeenCalledWith('new-empty'));
  expect(api.empty).toHaveBeenCalledWith(expect.stringMatching(/^\d{4}-\d{2}-\d{2}-空のプロジェクト$/));
});
