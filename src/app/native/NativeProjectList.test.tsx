/** @vitest-environment jsdom */
import {act,cleanup,fireEvent,render,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {NativeProjectList} from './NativeProjectList';
import type {ProjectSummary} from '../../shared/types';

const watch=vi.hoisted(()=>({reconnect:()=>{}}));
vi.mock('../useProjectsWatch',()=>({useProjectsWatch:(_enabled:boolean,_patch:unknown,onOpen:()=>void)=>{watch.reconnect=onOpen;}}));
const project=(id:string):ProjectSummary=>({id,name:id,orientation:'h',durationLabel:'0:10',sizeLabel:'1 MB',videoFile:null,status:'idle'});
const response=(body:unknown)=>({ok:true,json:async()=>body});
beforeEach(()=>vi.stubGlobal('fetch',vi.fn()));
afterEach(()=>{cleanup();vi.unstubAllGlobals();});

it('supports keyboard selection and prevents selecting the active project or switching while disabled',async()=>{
  vi.mocked(fetch).mockResolvedValue(response({projects:[project('A'),project('B')]}) as Response);
  const onPick=vi.fn(),view=render(<NativeProjectList projectId="A" disabled={false} onPick={onPick}/>);
  const b=await view.findByRole('button',{name:'B'});
  fireEvent.click(view.getByRole('button',{name:'A'}));expect(onPick).not.toHaveBeenCalled();
  fireEvent.keyDown(b,{key:'Enter'});expect(onPick).toHaveBeenLastCalledWith('B');
  onPick.mockClear();view.rerender(<NativeProjectList projectId="A" disabled onPick={onPick}/>);
  fireEvent.click(b);fireEvent.keyDown(b,{key:'Enter'});fireEvent.keyDown(b,{key:' '});
  expect(onPick).not.toHaveBeenCalled();expect(b.getAttribute('aria-disabled')).toBe('true');expect(b.tabIndex).toBe(-1);
});

it('ignores an older response after reconnect even when the fetch ignores its abort signal',async()=>{
  const pending:Array<(value:Response)=>void>=[];
  vi.mocked(fetch).mockImplementation(()=>new Promise(resolve=>pending.push(resolve)));
  const view=render(<NativeProjectList projectId="A" disabled={false} onPick={()=>{}}/>);
  expect(pending).toHaveLength(1);act(()=>watch.reconnect());expect(pending).toHaveLength(2);
  await act(async()=>pending[1]!(response({projects:[project('new')]}) as Response));
  expect(await view.findByRole('button',{name:'new'})).toBeTruthy();
  await act(async()=>pending[0]!(response({projects:[project('old')]}) as Response));
  expect(view.queryByRole('button',{name:'old'})).toBeNull();expect(view.getByRole('button',{name:'new'})).toBeTruthy();
});

it('keeps a malformed response recoverable with an explicit retry',async()=>{
  vi.mocked(fetch).mockResolvedValueOnce(response({}) as Response).mockResolvedValueOnce(response({projects:[project('B')]}) as Response);
  const view=render(<NativeProjectList projectId="A" disabled={false} onPick={()=>{}}/>);
  fireEvent.click(await view.findByRole('button',{name:'一覧を再読み込み'}));
  expect(await view.findByRole('button',{name:'B'})).toBeTruthy();
  await waitFor(()=>expect(view.queryByRole('button',{name:'一覧を再読み込み'})).toBeNull());
});
