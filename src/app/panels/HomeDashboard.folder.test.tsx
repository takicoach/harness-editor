/** @vitest-environment jsdom */
import {cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {HomeDashboard} from './HomeDashboard';
afterEach(()=>{cleanup();localStorage.clear();});
const folder=(name:string,names:string[])=>({kind:'file',getAsFile:()=>null,webkitGetAsEntry:()=>({isFile:false,isDirectory:true,name,createReader:()=>{let done=false;
  return {readEntries:(ok:(e:unknown[])=>void)=>{const chunk=done?[]:names.map(n=>({isFile:true,isDirectory:false,name:n,file:(f:(x:File)=>void)=>f(new File(['x'],n))}));done=true;ok(chunk);}};}})});
const drop=(items:unknown[])=>fireEvent.drop(document.querySelector('.home')!,{dataTransfer:{types:['Files'],files:[],items}});
const home=(managedMedia:boolean,onCreate:unknown=vi.fn())=>render(<HomeDashboard managedMedia={managedMedia} projects={[]} error={null} onPick={vi.fn()} onSetStage={vi.fn()} onCreate={onCreate as never} onProjectsChanged={vi.fn()}/>);
it('turns a dropped folder into one materials project named after the folder',async()=>{
  const onCreate=vi.fn(()=>new Promise<void>(()=>{}));home(true,onCreate);
  drop([folder('撮影0704',['clip2.mp4','memo.txt','photo.jpg','clip10.mp4'])]);
  expect(await screen.findByText('フォルダ「撮影0704」の動画 2 本を素材欄に入れます（メインには並べません）。台本や書類 1 件は「資料」に保管します。そのほかの 1 件は取り込みません。')).toBeTruthy();
  expect((screen.getByRole('textbox',{name:'プロジェクト名'}) as HTMLInputElement).value).toBe('撮影0704');
  fireEvent.click(screen.getByRole('button',{name:'作成'}));
  await waitFor(()=>expect(onCreate).toHaveBeenCalled());
  expect((onCreate.mock.calls as unknown[][])[0]![1]).toMatchObject({kind:'folder',folderName:'撮影0704',skipped:1});
});
it('says why when the folder has no videos, and does not open the dialog',async()=>{
  home(true);drop([folder('空',['memo.txt'])]);
  await waitFor(()=>expect(screen.getByRole('status').textContent).toBe('フォルダ「空」に動画がありません'));
  expect(screen.queryByRole('button',{name:'作成'})).toBeNull();
});
it('shows that it is reading the folder and takes no other drop meanwhile',async()=>{
  let finish:(entries:unknown[])=>void=()=>{};
  const slow={kind:'file',webkitGetAsEntry:()=>({isFile:false,isDirectory:true,name:'遅い',createReader:()=>({readEntries:(ok:(e:unknown[])=>void)=>{finish=ok;}})})};
  home(true);drop([slow]);
  expect(screen.getByRole('status').textContent).toBe('フォルダを読んでいます…');
  drop([folder('次',['a.mp4'])]);
  finish([]);
  await waitFor(()=>expect(screen.getByRole('status').textContent).toBe('フォルダ「遅い」に動画がありません'));
  expect(screen.queryByRole('button',{name:'作成'})).toBeNull();
});
it('offers several folders as one project each, with the names and the folders it will not make',async()=>{
  const onCreate=vi.fn(()=>new Promise<void>(()=>{}));home(true,onCreate);
  drop([folder('撮影',['a.mp4']),folder('空',['memo.txt']),folder('外ロケ',['b.mp4','台本.txt'])]);
  expect(await screen.findByText(/フォルダ 2 個を、それぞれ別のプロジェクトとして作ります/)).toBeTruthy();
  expect(within(screen.getByRole('list',{name:'作るプロジェクト'})).getAllByRole('listitem').map(item=>item.textContent)).toEqual(['撮影','外ロケ']);
  expect(screen.getByText('作らないフォルダ: フォルダ「空」に動画がありません')).toBeTruthy();
  expect(screen.queryByRole('textbox',{name:'プロジェクト名'})).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'作成'}));
  await waitFor(()=>expect(onCreate).toHaveBeenCalled());
  const source=(onCreate.mock.calls as unknown[][])[0]![1] as {kind:string;folders:Array<{documents:Array<{path:string}>}>};
  expect(source.kind).toBe('folders');
  expect(source.folders[1]!.documents.map(item=>item.path)).toEqual(['台本.txt']);
});
it('copies by default for several folders in the browser, where there is no real path',async()=>{
  home(true);drop([folder('a',['a.mp4']),folder('b',['b.mp4'])]);
  expect((await screen.findByTestId<HTMLInputElement>('home-create-copy')).checked).toBe(true);
});
it('keeps the link default for several folders on the desktop',async()=>{
  Object.defineProperty(window,'harnessDesktop',{configurable:true,value:{getPathForFile:(file:File)=>`/v/${file.name}`}});
  try{home(true);drop([folder('a',['a.mp4']),folder('b',['b.mp4'])]);expect((await screen.findByTestId<HTMLInputElement>('home-create-copy')).checked).toBe(false);}
  finally{Reflect.deleteProperty(window,'harnessDesktop');}
});
it('only says why when none of the folders can be made',async()=>{
  home(true);drop([folder('空',['memo.txt']),folder('無',['n.txt'])]);
  await waitFor(()=>expect(screen.getByRole('status').textContent).toBe('フォルダ「空」に動画がありません / フォルダ「無」に動画がありません'));
  expect(screen.queryByRole('button',{name:'作成'})).toBeNull();
});
it('refuses folders mixed with files',()=>{
  home(true);drop([folder('a',['a.mp4']),{kind:'file',webkitGetAsEntry:()=>({isFile:true,isDirectory:false,name:'b.mp4'})}]);
  expect(screen.getByRole('status').textContent).toBe('フォルダとファイルは分けてドロップしてください');
});
it('makes project names not overlap the existing ones, ignoring case',async()=>{
  render(<HomeDashboard managedMedia projects={[{id:'trip',name:'trip',status:'draft'} as never]} error={null} onPick={vi.fn()} onSetStage={vi.fn()} onCreate={vi.fn() as never} onProjectsChanged={vi.fn()} now={Date.now()}/>);
  drop([folder('Trip',['a.mp4']),folder('b',['b.mp4'])]);
  expect((await screen.findByRole('list',{name:'作るプロジェクト'})).textContent).toContain('Trip (2)');
});
describe('素材フォルダから作成',()=>{
  const picked=(path:string)=>{const file=new File(['x'],path.split('/').pop()!);Object.defineProperty(file,'webkitRelativePath',{value:path});return file;};
  it('asks the system for a folder, and treats it like a dropped one',async()=>{
    home(true);
    const input=screen.getByTestId<HTMLInputElement>('home-create-folder-input');
    expect(input.hasAttribute('webkitdirectory')).toBe(true);
    const clicked=vi.spyOn(input,'click');
    fireEvent.click(screen.getByTestId('home-create-media-folder'));
    expect(clicked).toHaveBeenCalled();
    fireEvent.change(input,{target:{files:[picked('撮影/a.mp4'),picked('撮影/台本/b.txt')]}});
    expect(await screen.findByText('フォルダ「撮影」の動画 1 本を素材欄に入れます（メインには並べません）。台本や書類 1 件は「資料」に保管します。')).toBeTruthy();
    expect((screen.getByRole('textbox',{name:'プロジェクト名'}) as HTMLInputElement).value).toBe('撮影');
  });
  it('says why when the picked folder has no videos',async()=>{
    home(true);
    fireEvent.change(screen.getByTestId('home-create-folder-input'),{target:{files:[picked('空/memo.txt')]}});
    await waitFor(()=>expect(screen.getByRole('status').textContent).toBe('フォルダ「空」に動画がありません'));
  });
  it('is not on the legacy screen',()=>{
    home(false);
    expect(screen.queryByTestId('home-create-media-folder')).toBeNull();
  });
});
it('keeps the legacy screen away from folders',()=>{
  home(false);drop([folder('a',['a.mp4'])]);
  expect(screen.getByRole('status').textContent).toBe('この画面ではフォルダから作成できません。新しい編集画面から作成してください');
});
