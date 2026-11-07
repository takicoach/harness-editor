import {describe,expect,it} from 'vitest';
import {MAX_DOCUMENT_BYTES,MAX_DOCUMENTS} from '../../shared/projectDocuments';
import {MAX_DROPPED_FOLDERS,classifyDrop,planFolder,readDroppedFolder,readDroppedFolders,scanFromInputFiles,type FolderScan} from './homeFolderDrop';
const file=(name:string)=>({isFile:true,isDirectory:false,name,file:(ok:(f:File)=>void)=>ok(new File(['x'],name))});
const dir=(name:string,children:unknown[]):FileSystemDirectoryEntry=>({isFile:false,isDirectory:true,name,createReader:()=>{let step=0;
  return {readEntries:(ok:(e:unknown[])=>void)=>{const chunk=step===0?children.slice(0,1):step===1?children.slice(1):[];step++;ok(chunk);}};}}) as never;
const item=(entry:unknown)=>({kind:'file',webkitGetAsEntry:()=>entry}) as unknown as DataTransferItem;
describe('folder drop',()=>{
  it('reads every chunk and sub-folder, keeps videos only, and counts the rest',async()=>{
    const scan=await readDroppedFolder(dir('撮影',[file('clip10.mp4'),file('clip2.MOV'),file('photo.jpg'),file('.DS_Store'),dir('b-roll',[file('b.mp4')])]));
    expect(scan).toMatchObject({folderName:'撮影',skipped:1});
    expect((scan as {files:File[]}).files.map(f=>f.name)).toEqual(['b.mp4','clip2.MOV','clip10.mp4']);
  });
  it('refuses a folder with no videos, more than 50 videos, or too many entries',async()=>{
    expect(planFolder([{path:'a.txt',file:new File(['x'],'a.txt')}],'空')).toEqual({refuse:'フォルダ「空」に動画がありません'});
    expect(planFolder(Array.from({length:51},(_,i)=>({path:`c${i}.mp4`,file:new File(['x'],`c${i}.mp4`)})),'多い'))
      .toEqual({refuse:'フォルダの動画は1回に50本まで取り込めます（フォルダ「多い」の動画: 51 本）'});
    expect(await readDroppedFolder(dir('深い',[file('a.mp4'),file('b.mp4')]),{depth:5,entries:1})).toEqual({refuse:'フォルダの中のファイルが多すぎます（1 件まで）。動画だけのフォルダにしてください'});
  });
  it('does not read deeper than the depth limit',async()=>{
    const scan=await readDroppedFolder(dir('浅い',[file('top.mp4'),dir('sub',[file('deep.mp4')])]),{depth:1,entries:100});
    expect((scan as {files:File[]}).files.map(f=>f.name)).toEqual(['top.mp4']);
  });
  it('does not read hidden entries, so an unreadable system folder beside the videos does not refuse the drop',async()=>{
    // 外付けや SD カードの一番上には .Trashes や .Spotlight-V100 があり、読めないことがある。
    const unreadable=(name:string)=>({isFile:false,isDirectory:true,name,createReader:()=>({readEntries:(_ok:unknown,fail:(e:Error)=>void)=>fail(new Error('EPERM'))})});
    const brokenFile={isFile:true,isDirectory:false,name:'._clip.mp4',file:(_ok:unknown,fail:(e:Error)=>void)=>fail(new Error('EPERM'))};
    const scan=await readDroppedFolder(dir('SD',[unreadable('.Trashes'),brokenFile,file('clip.mp4')]));
    expect(scan).toMatchObject({folderName:'SD',skipped:0});
    expect((scan as {files:File[]}).files.map(f=>f.name)).toEqual(['clip.mp4']);
  });
  it('does not count hidden entries toward the scan limit',async()=>{
    const scan=await readDroppedFolder(dir('a',[file('.1'),file('.2'),file('.3'),file('clip.mp4')]),{depth:5,entries:1});
    expect(scan).toMatchObject({folderName:'a'});
  });
  it('stops listing as soon as the limit is passed instead of reading the whole folder first',async()=>{
    let batches=0;
    const huge={isFile:false,isDirectory:true,name:'大量',createReader:()=>({readEntries:(ok:(e:unknown[])=>void)=>{batches++;ok(Array.from({length:100},(_,i)=>file(`c${batches}-${i}.mp4`)));}})} as never;
    expect(await readDroppedFolder(huge,{depth:5,entries:150})).toMatchObject({refuse:expect.stringContaining('多すぎます')});
    expect(batches).toBe(2);
  });
  it('reports a folder it cannot read',async()=>{
    const broken={isFile:false,isDirectory:true,name:'壊れ',createReader:()=>({readEntries:(_ok:unknown,fail:(e:Error)=>void)=>fail(new Error('x'))})} as never;
    expect(await readDroppedFolder(broken)).toEqual({refuse:'フォルダ「壊れ」を読めませんでした'});
  });
  it('classifies one folder and plain files',()=>{
    expect(classifyDrop([item(dir('a',[]))]).kind).toBe('folder');
    expect(classifyDrop([item(file('a.mp4'))]).kind).toBe('files');
    expect(classifyDrop([{kind:'file',webkitGetAsEntry:()=>null} as unknown as DataTransferItem]).kind).toBe('files');
  });
});

const named=(relative:string,size=1)=>{const file=new File([new Uint8Array(size)],relative.split('/').pop()!);Object.defineProperty(file,'webkitRelativePath',{value:relative});return file;};
describe('several folders',()=>{
  it('tells several folders from a mix of folders and files',()=>{
    const folder=dir('a',[]),other=dir('b',[]);
    expect(classifyDrop([item(folder),item(other)])).toEqual({kind:'folders',entries:[folder,other]});
    expect(classifyDrop([item(folder),item(file('a.mp4'))])).toEqual({kind:'refuse',message:'フォルダとファイルは分けてドロップしてください'});
  });
  it('refuses more folders than the limit before reading any',()=>{
    const many=Array.from({length:MAX_DROPPED_FOLDERS+1},(_,i)=>item(dir(`f${i}`,[])));
    expect(classifyDrop(many)).toEqual({kind:'refuse',message:`フォルダは1回に${MAX_DROPPED_FOLDERS}個までドロップできます`});
  });
  it('reads every folder and keeps the refused ones with their reasons',async()=>{
    const result=await readDroppedFolders([dir('撮影',[file('a.mp4')]),dir('空',[file('memo.txt')]),dir('外ロケ',[file('b.mp4')])]);
    expect(result.folders.map(folder=>folder.folderName)).toEqual(['撮影','外ロケ']);
    expect(result.refused).toEqual([{name:'空',reason:'フォルダ「空」に動画がありません'}]);
  });
});
describe('documents in a folder',()=>{
  const found=(path:string,size=1)=>({path,file:new File([new Uint8Array(size)],path.split('/').pop()!)});
  it('keeps documents apart from videos with their relative paths, and does not count them as skipped',()=>{
    const scan=planFolder([found('a.mp4'),found('台本/第1回.DOCX'),found('構成.pdf'),found('memo.md'),found('写真.jpg')],'撮影') as FolderScan;
    expect(scan.files.map(item=>item.name)).toEqual(['a.mp4']);
    expect(scan.documents.map(item=>item.path)).toEqual(['memo.md','構成.pdf','台本/第1回.DOCX']);
    expect(scan.skipped).toBe(1);
  });
  it('leaves out the lock files Word keeps beside an open document',()=>{
    const scan=planFolder([found('a.mp4'),found('~$台本.docx'),found('台本.docx')],'撮影') as FolderScan;
    expect(scan.documents.map(item=>item.path)).toEqual(['台本.docx']);
    expect(scan.skipped).toBe(0);
  });
  it('counts documents over the size or the number limit as skipped instead of failing later',()=>{
    const small=Array.from({length:MAX_DOCUMENTS+2},(_,i)=>found(`d${String(i).padStart(2,'0')}.txt`));
    const scan=planFolder([found('a.mp4'),...small],'撮影') as FolderScan;
    expect(scan.documents).toHaveLength(MAX_DOCUMENTS);
    expect(scan.skipped).toBe(2);
    const big=new File(['x'],'big.pdf');Object.defineProperty(big,'size',{value:MAX_DOCUMENT_BYTES+1});
    expect(planFolder([found('a.mp4'),{path:'big.pdf',file:big}],'撮影')).toMatchObject({documents:[],skipped:1});
  });
  it('still refuses a folder with documents and no videos',()=>{
    expect(planFolder([found('台本.docx')],'書類')).toEqual({refuse:'フォルダ「書類」に動画がありません'});
  });
});
describe('a folder from the picker',()=>{
  it('takes the folder name and relative paths from the file list',()=>{
    const scan=scanFromInputFiles([named('撮影/clip.mp4'),named('撮影/台本/第1回.txt'),named('撮影/写真.jpg')]) as FolderScan;
    expect(scan.folderName).toBe('撮影');
    expect(scan.files.map(item=>item.name)).toEqual(['clip.mp4']);
    expect(scan.documents.map(item=>item.path)).toEqual(['台本/第1回.txt']);
    expect(scan.skipped).toBe(1);
  });
  it('leaves out hidden entries at any level, and anything deeper than the limit',()=>{
    const scan=scanFromInputFiles([named('撮影/clip.mp4'),named('撮影/.DS_Store'),named('撮影/.cache/a.mp4'),named('撮影/1/2/3/4/ok.mp4'),named('撮影/1/2/3/4/5/deep.mp4')]) as FolderScan;
    expect(scan.files.map(item=>item.name).sort()).toEqual(['clip.mp4','ok.mp4']);
    expect(scan.skipped).toBe(0);
  });
  it('refuses too many entries, nothing at all, and a list without relative paths',()=>{
    expect(scanFromInputFiles(Array.from({length:3},(_,i)=>named(`撮影/${i}.mp4`)),{depth:5,entries:2})).toMatchObject({refuse:expect.stringContaining('多すぎます')});
    expect(scanFromInputFiles([])).toEqual({refuse:'フォルダが空です。素材の入ったフォルダを選んでください'});
    expect(scanFromInputFiles([new File(['x'],'a.mp4')])).toEqual({refuse:'フォルダの中身を読めませんでした'});
  });
});
