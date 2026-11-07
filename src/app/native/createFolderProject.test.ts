import {beforeEach,describe,expect,it,vi} from 'vitest';
import {abandonImportItems,cancelImportBatch,createImportBatch,createNativeEmptyProject,fetchImportBatches,referenceImportItem,savedNativeDocument,uploadImportItem,uploadProjectDocument} from './api';
import {createFolderProject,folderProjectNotes,waitForImportPrepared} from './createFolderProject';
import {deleteProjectRequest} from '../trashApi';

vi.mock('./api',async importOriginal=>{const actual=await importOriginal<typeof import('./api')>();return {...actual,abandonImportItems:vi.fn(),cancelImportBatch:vi.fn(),createImportBatch:vi.fn(),createNativeEmptyProject:vi.fn(),fetchImportBatches:vi.fn(),referenceImportItem:vi.fn(),savedNativeDocument:vi.fn(),uploadImportItem:vi.fn(),uploadProjectDocument:vi.fn()};});
vi.mock('../trashApi',()=>({deleteProjectRequest:vi.fn()}));
vi.mock('./importSeconds',()=>({createWithDurations:async(_files:unknown,create:()=>Promise<unknown>)=>({view:await create(),stop:vi.fn()}),handOverImportSeconds:vi.fn()}));

const video=(name:string)=>new File(['x'],name),abort=()=>Object.assign(new Error('取り消しました'),{name:'AbortError'});
const doc=(path:string)=>({path,file:new File(['本文'],path)});
const batch=(names:string[])=>({batchId:'b1',items:names.map((name,index)=>({itemId:`i${index}`,key:String(index),name,phase:'waiting'}))});
const fileReference=()=>({resolve:vi.fn(async()=>({path:'/v/a.mp4'}))});
beforeEach(()=>{
  vi.resetAllMocks();
  vi.mocked(createNativeEmptyProject).mockResolvedValue({id:'p1'});
  vi.mocked(createImportBatch).mockImplementation(async(_id,body)=>batch(body.items.map(item=>item.name)) as never);
  vi.mocked(savedNativeDocument).mockResolvedValue({clips:[],assets:[],revision:0} as never);
  vi.mocked(cancelImportBatch).mockResolvedValue({} as never);vi.mocked(abandonImportItems).mockResolvedValue({} as never);
});

describe('createFolderProject',()=>{
  it('hands over the videos and then keeps the documents, without opening anything',async()=>{
    const order:string[]=[];
    vi.mocked(referenceImportItem).mockImplementation(async()=>{order.push('video');return {} as never;});
    vi.mocked(uploadProjectDocument).mockImplementation(async(_id,path)=>{order.push(path);});
    const result=await createFolderProject('撮影',{files:[video('a.mp4')],documents:[doc('台本/a.txt'),doc('b.md')]},false,fileReference());
    expect(order).toEqual(['video','台本/a.txt','b.md']);
    expect(result).toEqual({id:'p1',batchId:'b1',undelivered:0,aborted:false,documentFailures:[]});
    expect(createImportBatch).toHaveBeenCalledWith('p1',expect.objectContaining({origin:'home',placement:'materials',mode:'link'}));
  });
  it('copies through the screen when copying is chosen',async()=>{
    await createFolderProject('撮影',{files:[video('a.mp4')],documents:[]},true,fileReference());
    expect(uploadImportItem).toHaveBeenCalledTimes(1);expect(referenceImportItem).not.toHaveBeenCalled();
  });
  it('tries a document once more, and reports it with its reason without undoing the project',async()=>{
    vi.mocked(uploadProjectDocument).mockRejectedValue(new Error('空きがありません'));
    const result=await createFolderProject('撮影',{files:[video('a.mp4')],documents:[doc('a.txt')]},false,fileReference());
    expect(uploadProjectDocument).toHaveBeenCalledTimes(2);
    expect(result.documentFailures).toEqual([{name:'a.txt',reason:'空きがありません'}]);
    expect(deleteProjectRequest).not.toHaveBeenCalled();
  });
  it('says the location choice was cancelled partway, and keeps the project with what was handed over',async()=>{
    const reference=fileReference();reference.resolve.mockResolvedValueOnce({path:'/v/a.mp4'}).mockRejectedValueOnce(abort());
    const result=await createFolderProject('撮影',{files:[video('a.mp4'),video('b.mp4'),video('c.mp4')],documents:[]},false,reference);
    expect(result).toMatchObject({aborted:true,undelivered:2});
    expect(abandonImportItems).toHaveBeenCalledWith('p1','b1',['i1','i2']);
    expect(deleteProjectRequest).not.toHaveBeenCalled();
  });
  it('reports a failure partway without calling it a cancellation',async()=>{
    const reference=fileReference();reference.resolve.mockResolvedValueOnce({path:'/v/a.mp4'}).mockRejectedValueOnce(new Error('読めません'));
    expect(await createFolderProject('撮影',{files:[video('a.mp4'),video('b.mp4')],documents:[]},false,reference)).toMatchObject({aborted:false,undelivered:1});
  });
  it('undoes the project and rethrows when not one video could be handed over',async()=>{
    const reference=fileReference();reference.resolve.mockRejectedValue(abort());
    await expect(createFolderProject('撮影',{files:[video('a.mp4')],documents:[doc('a.txt')]},false,reference)).rejects.toMatchObject({name:'AbortError'});
    expect(cancelImportBatch).toHaveBeenCalled();expect(deleteProjectRequest).toHaveBeenCalledWith('p1');expect(uploadProjectDocument).not.toHaveBeenCalled();
  });
});

describe('waitForImportPrepared',()=>{
  const phases=(...values:string[])=>[{batchId:'b1',items:values.map(phase=>({phase}))}] as never;
  it('waits until nothing is being prepared, and counts the outcome',async()=>{
    vi.mocked(fetchImportBatches).mockResolvedValueOnce(phases('copying','ready')).mockResolvedValueOnce(phases('ready','failed','awaiting-decision'));
    expect(await waitForImportPrepared('p','b1',{pollMs:1})).toEqual({ready:1,failed:1,deciding:1,timedOut:false});
    expect(fetchImportBatches).toHaveBeenCalledTimes(2);
  });
  it('stops waiting when nothing has changed for the idle time, and keeps waiting while something changes',async()=>{
    vi.mocked(fetchImportBatches).mockResolvedValue(phases('copying'));
    expect(await waitForImportPrepared('p','b1',{pollMs:1,idleMs:5})).toEqual({ready:0,failed:0,deciding:0,timedOut:true});
  });
  it('rides out a failed read',async()=>{
    vi.mocked(fetchImportBatches).mockRejectedValueOnce(new Error('切断')).mockResolvedValueOnce(phases('ready'));
    expect(await waitForImportPrepared('p','b1',{pollMs:1})).toMatchObject({ready:1,timedOut:false});
  });
});

describe('folderProjectNotes',()=>{
  const made={id:'p',batchId:'b',undelivered:0,aborted:false,documentFailures:[]};
  it('says nothing when all went well',()=>expect(folderProjectNotes('撮影',made,{ready:2,failed:0,deciding:0,timedOut:false})).toEqual([]));
  it('names what needs attention',()=>{
    expect(folderProjectNotes('撮影',{...made,undelivered:1,documentFailures:[{name:'a.txt',reason:'空きなし'}]},{ready:1,failed:2,deciding:1,timedOut:false})).toEqual([
      '「撮影」: 動画 1 本を渡せませんでした','「撮影」: 動画 1 本を準備できませんでした。開くと理由が出ます','「撮影」: 動画 1 本は確認が必要です。開くと選べます','「撮影」: 書類を保管できませんでした（a.txt: 空きなし）']);
  });
  it('tells that the preparation is still going when it stopped waiting',()=>{
    expect(folderProjectNotes('撮影',made,{ready:0,failed:0,deciding:0,timedOut:true})).toEqual(['「撮影」: 動画の準備に時間がかかっています。開くと続きを確認できます']);
  });
});
