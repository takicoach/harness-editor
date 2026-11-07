/** @vitest-environment jsdom */
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {HomeDashboard} from './HomeDashboard';
import {defaultProjectName} from '../createProjectApi';
afterEach(()=>{cleanup();localStorage.clear();});
const select=(files:File[])=>{const input=screen.getByTestId('home-create-file') as HTMLInputElement;Object.defineProperty(input,'files',{value:files,configurable:true});fireEvent.change(input);};
const home=(managedMedia:boolean)=>{const onCreate=vi.fn().mockResolvedValue(undefined);
  render(<HomeDashboard managedMedia={managedMedia} projects={[]} error={null} onPick={vi.fn()} onSetStage={vi.fn()} onCreate={onCreate} onProjectsChanged={vi.fn()}/>);return onCreate;};
it('makes one project per video, with their names listed, and stays on the home after creating',async()=>{
  const onCreate=vi.fn().mockResolvedValue({created:['p1','p2'],failed:[],stopped:[]}),onProjectsChanged=vi.fn();
  render(<HomeDashboard managedMedia projects={[]} error={null} onPick={vi.fn()} onSetStage={vi.fn()} onCreate={onCreate} onProjectsChanged={onProjectsChanged}/>);
  select([new File(['b'],'clip10.mp4'),new File(['a'],'clip2.mp4')]);
  expect(screen.getByText('素材: 動画 2 本（1 本ずつ別のプロジェクト）')).toBeTruthy();
  expect(screen.getByRole('list',{name:'作るプロジェクト'}).textContent).toMatch(/clip2.*clip10/);
  expect(screen.queryByRole('textbox',{name:'プロジェクト名'})).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'作成'}));
  await waitFor(()=>expect(screen.queryByRole('button',{name:'作成'})).toBeNull());
  const source=onCreate.mock.calls[0]![1] as {kind:string;files:File[];names:string[]};expect(source.kind).toBe('video-projects');expect(source.files.map(f=>f.name)).toEqual(['clip2.mp4','clip10.mp4']);expect(source.names).toHaveLength(2);
  expect(onProjectsChanged).toHaveBeenCalled();expect(screen.getByRole('status').textContent).toBe('2 本のプロジェクトを作りました');
});
it('names the projects around the ones that already exist',()=>{
  const today=defaultProjectName('clip.mp4');
  render(<HomeDashboard managedMedia projects={[{id:today,name:today} as never]} error={null} onPick={vi.fn()} onSetStage={vi.fn()} onCreate={vi.fn()} onProjectsChanged={vi.fn()}/>);
  select([new File(['a'],'clip.mp4'),new File(['b'],'other.mp4')]);
  expect(screen.getByRole('list',{name:'作るプロジェクト'}).textContent).toContain(`${today} (2)`);
});
it('keeps the report on screen until closed when some videos could not be made into projects',async()=>{
  const onCreate=vi.fn().mockResolvedValue({created:['x'],failed:[{name:'b',reason:'同じ名前のプロジェクトがすでにあります'}],stopped:['c']});
  render(<HomeDashboard managedMedia projects={[]} error={null} onPick={vi.fn()} onSetStage={vi.fn()} onCreate={onCreate} onProjectsChanged={vi.fn()}/>);
  select([new File(['a'],'a.mp4'),new File(['b'],'b.mp4'),new File(['c'],'c.mp4')]);fireEvent.click(screen.getByRole('button',{name:'作成'}));
  const report=await screen.findByTestId('home-create-report');
  expect(report.textContent).toContain('3 本中 1 本を作りました。作れなかった動画: b（同じ名前のプロジェクトがすでにあります）。取り消したため作らなかった動画: c');
  fireEvent.click(screen.getByRole('button',{name:'閉じる'}));expect(screen.queryByTestId('home-create-report')).toBeNull();
});
it('shows which video it is on while making several projects',async()=>{
  const onCreate=vi.fn((_n:string,_s:unknown,_c:boolean,_p:unknown,onStep:(i:number,c:number)=>void)=>{onStep(2,3);return new Promise<void>(()=>{});});
  render(<HomeDashboard managedMedia projects={[]} error={null} onPick={vi.fn()} onSetStage={vi.fn()} onCreate={onCreate as never} onProjectsChanged={vi.fn()}/>);
  select([new File(['a'],'a.mp4'),new File(['b'],'b.mp4'),new File(['c'],'c.mp4')]);fireEvent.click(screen.getByRole('button',{name:'作成'}));
  expect((await screen.findAllByText(/2 \/ 3 本目/)).length).toBeGreaterThan(0);
});

it('keeps the legacy screen to the first video only',()=>{
  home(false);select([new File(['b'],'clip10.mp4'),new File(['a'],'clip2.mp4')]);
  expect(screen.getByRole('status').textContent).toContain('1件目のみ取り込みます');
});

// ---- Task 8: 上限・コピーの選択 ----
it('refuses more videos than one batch takes, before creating anything',()=>{
  const onCreate=home(true);select(Array.from({length:51},(_,index)=>new File(['x'],`clip${index}.mp4`)));
  expect(screen.getByRole('status').textContent).toBe('動画は1回に50本まで作成できます（選んだ動画: 51 本）');
  expect(screen.queryByRole('button',{name:'作成'})).toBeNull();expect(onCreate).not.toHaveBeenCalled();
});
it('offers to copy several videos and passes the choice on',async()=>{
  const onCreate=home(true);select([new File(['b'],'clip10.mp4'),new File(['a'],'clip2.mp4')]);
  fireEvent.click(screen.getByTestId('home-create-copy'));fireEvent.click(screen.getByRole('button',{name:'作成'}));
  await waitFor(()=>expect(onCreate).toHaveBeenCalled());expect((onCreate.mock.calls[0]![1] as {kind:string}).kind).toBe('video-projects');expect(onCreate.mock.calls[0]![2]).toBe(true);
});
