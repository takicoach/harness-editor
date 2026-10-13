/** @vitest-environment jsdom */
import {act,renderHook} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import type {ImportBatchView} from '../../shared/importBatches';
const bus=vi.hoisted(()=>({apply:null as null|((raw:unknown)=>void)}));
vi.mock('../eventBus',()=>({useEventChannelWithSync:(_ch:string,_id:string,apply:(raw:unknown)=>void)=>{bus.apply=apply;}}));
const api=vi.hoisted(()=>({cancel:vi.fn(),create:vi.fn()}));
vi.mock('./api',async importOriginal=>({...(await importOriginal<typeof import('./api')>()),cancelImportBatch:api.cancel,createImportBatch:api.create}));
import {IMPORT_CONFIRM_STALL_MS,useImportBatches} from './useImportBatches';
import {handOverImportSeconds,importSeconds,noteImportSeconds} from './importSeconds';
const batch=(batchId:string,phase:ImportBatchView['phase'],origin:ImportBatchView['origin']={kind:'ui'}):ImportBatchView=>({batchId,projectId:'p',createdAt:'2026-10-02T00:00:00.000Z',origin,placement:'append-main',mode:'link',phase,
  items:[{itemId:'i0',key:'0',name:'a.mp4',phase:phase==='preparing'?'probing':'ready'}]});
const send=(...batches:ImportBatchView[])=>act(()=>{bus.apply!({type:'list',batches});});
let confirm:ReturnType<typeof vi.fn>;
beforeEach(()=>{sessionStorage.clear();bus.apply=null;confirm=vi.fn(async()=>true);api.cancel.mockReset().mockResolvedValue({});api.create.mockReset();});
afterEach(()=>{vi.clearAllMocks();});
it('auto-confirms an agent or home batch once when it becomes ready, even if the list repeats',async()=>{
  renderHook(()=>useImportBatches('p',{ready:true,confirm}));
  await send(batch('imp-aaaaaaaaaaaaaaaaaaaa','preparing',{kind:'agent',operationId:'op'}));expect(confirm).not.toHaveBeenCalled();
  await send(batch('imp-aaaaaaaaaaaaaaaaaaaa','ready',{kind:'agent',operationId:'op'}));await send(batch('imp-aaaaaaaaaaaaaaaaaaaa','ready',{kind:'agent',operationId:'op'}));
  await send(batch('imp-bbbbbbbbbbbbbbbbbbbb','ready',{kind:'home'}));
  expect(confirm.mock.calls).toEqual([['imp-aaaaaaaaaaaaaaaaaaaa',false],['imp-bbbbbbbbbbbbbbbbbbbb',false]]);
});
it('auto-confirms only its own UI batch and shows another UI batch as ready but not placed',async()=>{
  const {result}=renderHook(()=>useImportBatches('p',{ready:true,confirm}));
  act(()=>{result.current.remember(batch('imp-cccccccccccccccccccc','preparing'));});
  await send(batch('imp-cccccccccccccccccccc','ready'),batch('imp-dddddddddddddddddddd','ready'));
  expect(confirm.mock.calls).toEqual([['imp-cccccccccccccccccccc',false]]);
  expect(result.current.pending.map(b=>b.batchId)).toEqual(['imp-dddddddddddddddddddd']);
});
it('never auto-confirms a partial batch and waits while the workspace is not ready',async()=>{
  const {result,rerender}=renderHook((props:{ready:boolean})=>useImportBatches('p',{ready:props.ready,confirm}),{initialProps:{ready:false}});
  await send({...batch('imp-eeeeeeeeeeeeeeeeeeee','partial',{kind:'agent',operationId:'x'})},batch('imp-ffffffffffffffffffff','ready',{kind:'home'}));
  expect(confirm).not.toHaveBeenCalled();expect(result.current.pending.map(b=>b.batchId)).toContain('imp-eeeeeeeeeeeeeeeeeeee');
  rerender({ready:true});expect(confirm.mock.calls).toEqual([['imp-ffffffffffffffffffff',false]]);
});
it('offers a batch again by hand when its automatic confirm failed',async()=>{
  confirm.mockResolvedValue(false);const {result}=renderHook(()=>useImportBatches('p',{ready:true,confirm}));
  await send(batch('imp-iiiiiiiiiiiiiiiiiiii','ready',{kind:'home'}));
  await vi.waitFor(()=>expect(result.current.pending.map(b=>b.batchId)).toEqual(['imp-iiiiiiiiiiiiiiiiiiii']));expect(confirm).toHaveBeenCalledTimes(1);
});
it('ignores other projects and resets when the project changes',async()=>{
  const {result,rerender}=renderHook((props:{id:string})=>useImportBatches(props.id,{ready:false,confirm}),{initialProps:{id:'p'}});
  await send(batch('imp-gggggggggggggggggggg','preparing'),{...batch('imp-hhhhhhhhhhhhhhhhhhhh','preparing'),projectId:'other'});
  expect(result.current.batches.map(b=>b.batchId)).toEqual(['imp-gggggggggggggggggggg']);
  rerender({id:'q'});expect(result.current.batches).toEqual([]);
});
it('keeps confirmed batches out of the open list but reports the ones missing from the document',async()=>{
  const {result}=renderHook(()=>useImportBatches('p',{ready:false,confirm}));
  await send({...batch('imp-jjjjjjjjjjjjjjjjjjjj','confirmed'),items:[{itemId:'i0',key:'0',name:'a.mp4',phase:'ready',assetId:'asset-new'}],confirmed:{executionId:'e',revision:4}});
  expect(result.current.batches).toEqual([]);expect(result.current.pending).toEqual([]);
  const doc={schemaVersion:2,id:'d',name:'x',revision:3,fps:{num:30,den:1},resolution:{width:320,height:180},sequenceEndFrame:0,background:'#000',transcripts:[],transitions:[],ducking:{enabled:false,strength:'mid'},assets:[],tracks:[],clips:[]} as unknown as Parameters<typeof result.current.unplaced>[0];
  expect(result.current.unplaced(doc).map(b=>b.batchId)).toEqual(['imp-jjjjjjjjjjjjjjjjjjjj']);
});
const emptyDoc=(revision:number)=>({schemaVersion:2,id:'d',name:'x',revision,fps:{num:30,den:1},resolution:{width:320,height:180},sequenceEndFrame:0,background:'#000',transcripts:[],transitions:[],ducking:{enabled:false,strength:'mid'},assets:[],tracks:[],clips:[]}) as unknown as Parameters<ReturnType<typeof useImportBatches>['unplaced']>[0];
it('does not auto-confirm the previous project\'s batch right after switching projects',async()=>{
  const {rerender}=renderHook((props:{id:string;ready:boolean})=>useImportBatches(props.id,{ready:props.ready,confirm}),{initialProps:{id:'p',ready:false}});
  await send(batch('imp-oooooooooooooooooooo','ready',{kind:'home'}));expect(confirm).not.toHaveBeenCalled();
  rerender({id:'q',ready:true});
  expect(confirm).not.toHaveBeenCalled();
});
it('auto-confirms its own UI batch even when the list arrived before it was remembered',async()=>{
  const {result}=renderHook(()=>useImportBatches('p',{ready:true,confirm}));
  await send(batch('imp-pppppppppppppppppppp','ready'));expect(confirm).not.toHaveBeenCalled();expect(result.current.pending.map(b=>b.batchId)).toEqual(['imp-pppppppppppppppppppp']);
  act(()=>{result.current.remember(batch('imp-pppppppppppppppppppp','preparing'));});
  expect(confirm.mock.calls).toEqual([['imp-pppppppppppppppppppp',false]]);expect(result.current.pending).toEqual([]);
});
it('does not call its own batch missing while its confirm is in flight or just succeeded',async()=>{
  let finish:(ok:boolean)=>void=()=>{};confirm.mockImplementation(()=>new Promise<boolean>(resolve=>{finish=resolve;}));
  const {result}=renderHook(()=>useImportBatches('p',{ready:true,confirm}));
  const confirmed={...batch('imp-qqqqqqqqqqqqqqqqqqqq','confirmed',{kind:'home'}),items:[{itemId:'i0',key:'0',name:'a.mp4',phase:'ready' as const,assetId:'asset-new'}],confirmed:{executionId:'e',revision:4}};
  await send(batch('imp-qqqqqqqqqqqqqqqqqqqq','ready',{kind:'home'}));expect(confirm).toHaveBeenCalledTimes(1);
  await send(confirmed);expect(result.current.unplaced(emptyDoc(3))).toEqual([]);
  await act(async()=>{finish(true);});expect(result.current.unplaced(emptyDoc(3))).toEqual([]);
});
it('points out a batch that has stayed in placing for too long, without offering to place or cancel it',async()=>{
  vi.useFakeTimers();
  try{
    const {result}=renderHook(()=>useImportBatches('p',{ready:true,confirm}));
    await send(batch('imp-rrrrrrrrrrrrrrrrrrrr','confirming',{kind:'home'}));expect(result.current.pending).toEqual([]);
    act(()=>{vi.advanceTimersByTime(IMPORT_CONFIRM_STALL_MS-1);});expect(result.current.pending).toEqual([]);
    act(()=>{vi.advanceTimersByTime(1);});expect(result.current.pending.map(b=>b.batchId)).toEqual(['imp-rrrrrrrrrrrrrrrrrrrr']);
    await send(batch('imp-rrrrrrrrrrrrrrrrrrrr','ready',{kind:'home'}));expect(result.current.pending.map(b=>b.phase)).not.toContain('confirming');
  }finally{vi.useRealTimers();}
});

// ---- Task 7 ----
it('start creates a batch from this screen and treats it as its own (confirmed automatically when ready)',async()=>{
  api.create.mockResolvedValue(batch('imp-ssssssssssssssssssss','preparing'));
  const {result}=renderHook(()=>useImportBatches('p',{ready:true,confirm}));
  let view!:ImportBatchView;await act(async()=>{view=await result.current.start({mode:'link',items:[{key:'0',name:'a.mp4',path:'/m/a.mp4'}],seconds:new Map([['0',2]])});});
  expect(api.create).toHaveBeenCalledWith('p',expect.objectContaining({mode:'link',origin:'ui',items:[{key:'0',name:'a.mp4',path:'/m/a.mp4'}],requestId:expect.any(String)}));
  expect(view.batchId).toBe('imp-ssssssssssssssssssss');
  const doc=emptyDoc(0);expect(result.current.frames(doc)[0]!.durationFrames).toBe(60);
  await send(batch('imp-ssssssssssssssssssss','ready'));expect(confirm.mock.calls).toEqual([['imp-ssssssssssssssssssss',false]]);
});
it('re-arms the stall timer when it fires before the time is up',async()=>{
  vi.useFakeTimers();
  try{
    const {result}=renderHook(()=>useImportBatches('p',{ready:true,confirm}));
    await send(batch('imp-tttttttttttttttttttt','confirming',{kind:'home'}));
    // 時計が少し戻る（タイマーが予定より早く届いたのと同じ）
    vi.setSystemTime(Date.now()-5);
    act(()=>{vi.advanceTimersByTime(IMPORT_CONFIRM_STALL_MS);});expect(result.current.pending).toEqual([]);
    act(()=>{vi.advanceTimersByTime(5);});expect(result.current.pending.map(b=>b.batchId)).toEqual(['imp-tttttttttttttttttttt']);
  }finally{vi.useRealTimers();}
});
it('aborts the uploads of a batch that was cancelled here or elsewhere, and of every batch when the project changes',async()=>{
  api.create.mockImplementation(async(_id:string,body:{requestId:string})=>batch(`imp-${body.requestId.replace(/[^a-f0-9]/g,'').padEnd(20,'0').slice(0,20)}`,'preparing'));
  const {result,rerender,unmount}=renderHook((props:{id:string})=>useImportBatches(props.id,{ready:true,confirm}),{initialProps:{id:'p'}});
  const start=async()=>{let view!:ImportBatchView;await act(async()=>{view=await result.current.start({mode:'copy',items:[{key:'0',name:'a.mp4'}]});});return view;};
  const a=await start(),b=await start(),c=await start();
  const signal=(view:ImportBatchView)=>result.current.uploadSignal(view.batchId);
  expect([signal(a).aborted,signal(b).aborted,signal(c).aborted]).toEqual([false,false,false]);
  api.cancel.mockRejectedValueOnce(new Error('接続が切れました'));
  await act(async()=>{expect(await result.current.cancel(a.batchId)).toBe('接続が切れました');});expect(signal(a).aborted).toBe(false);
  await act(async()=>{expect(await result.current.cancel(a.batchId)).toBeNull();});expect(signal(a).aborted).toBe(true);
  await send({...b,phase:'cancelled',items:[{...b.items[0]!,phase:'cancelled'}]});expect(signal(b).aborted).toBe(true);expect(signal(c).aborted).toBe(false);
  const kept=signal(c);rerender({id:'q'});expect(kept.aborted).toBe(true);
  expect(result.current.uploadSignal('imp-unknown').aborted).toBe(true);
  const d=await start(),last=result.current.uploadSignal(d.batchId);unmount();expect(last.aborted).toBe(true);
});
it('tells the screen about a batch it placed, but not about one placed after the project changed',async()=>{
  const onPlaced=vi.fn();let finish:(ok:boolean)=>void=()=>{};
  const {result,rerender}=renderHook((props:{id:string})=>useImportBatches(props.id,{ready:true,confirm,onPlaced}),{initialProps:{id:'p'}});
  const voice={...batch('imp-uuuuuuuuuuuuuuuuuuuu','ready',{kind:'home'}),items:[{itemId:'i0',key:'0',name:'voice.mp4',phase:'ready' as const,audioOnly:true as const}]};
  await send(voice);await vi.waitFor(()=>expect(onPlaced).toHaveBeenCalledTimes(1));expect(onPlaced.mock.calls[0]![0]).toMatchObject({batchId:'imp-uuuuuuuuuuuuuuuuuuuu',items:[{audioOnly:true}]});
  confirm.mockImplementation(()=>new Promise<boolean>(resolve=>{finish=resolve;}));
  await send(batch('imp-vvvvvvvvvvvvvvvvvvvv','ready',{kind:'home'}));expect(confirm).toHaveBeenCalledTimes(2);
  rerender({id:'q'});await act(async()=>{finish(true);});expect(onPlaced).toHaveBeenCalledTimes(1);
  // 元の案件へ戻っても、切り替え前の確定を知らせ直さず、確定もし直さない（一覧は次の通知で届き直す）。
  rerender({id:'p'});expect(onPlaced).toHaveBeenCalledTimes(1);expect(confirm).toHaveBeenCalledTimes(2);expect(result.current.batches).toEqual([]);
});

// ---- Task 8 ----
it('makes an upload signal only for a copy batch and lets it go once the sending is over',async()=>{
  api.create.mockResolvedValueOnce(batch('imp-wwwwwwwwwwwwwwwwwwww','preparing')).mockResolvedValueOnce({...batch('imp-xxxxxxxxxxxxxxxxxxxx','preparing'),mode:'copy'});
  const {result}=renderHook(()=>useImportBatches('p',{ready:true,confirm}));
  await act(async()=>{await result.current.start({mode:'link',items:[{key:'0',name:'a.mp4',path:'/m/a.mp4'}]});});
  expect(result.current.uploadSignal('imp-wwwwwwwwwwwwwwwwwwww').aborted).toBe(true);
  await act(async()=>{await result.current.start({mode:'copy',items:[{key:'0',name:'a.mp4'}]});});
  const sending=result.current.uploadSignal('imp-xxxxxxxxxxxxxxxxxxxx');expect(sending.aborted).toBe(false);
  act(()=>{result.current.releaseUploads('imp-xxxxxxxxxxxxxxxxxxxx');});
  expect(result.current.uploadSignal('imp-xxxxxxxxxxxxxxxxxxxx').aborted).toBe(true);expect(sending.aborted).toBe(false);
});
it('shows the lengths read elsewhere (the home) in the frames of that batch, and redraws as more arrive',async()=>{
  noteImportSeconds('imp-yyyyyyyyyyyyyyyyyyyy',[['0',2]]);
  const {result}=renderHook(()=>useImportBatches('p',{ready:false,confirm}));
  await send({...batch('imp-yyyyyyyyyyyyyyyyyyyy','preparing',{kind:'home'}),items:[{itemId:'i0',key:'0',name:'a.mp4',phase:'probing'},{itemId:'i1',key:'1',name:'b.mp4',phase:'probing'}]});
  expect(result.current.frames(emptyDoc(0)).map(frame=>[frame.durationFrames,frame.estimated])).toEqual([[60,false],[150,true]]);
  const before=result.current.frames;act(()=>{noteImportSeconds('imp-yyyyyyyyyyyyyyyyyyyy',[['1',1]]);});
  expect(result.current.frames).not.toBe(before);
  expect(result.current.frames(emptyDoc(0)).map(frame=>[frame.durationFrames,frame.estimated])).toEqual([[60,false],[30,false]]);
});
it('forgets the lengths of a batch once it is placed or cancelled',async()=>{
  noteImportSeconds('imp-zzzzzzzzzzzzzzzzzzzz',[['0',2]]);renderHook(()=>useImportBatches('p',{ready:false,confirm}));
  await send({...batch('imp-zzzzzzzzzzzzzzzzzzzz','confirmed',{kind:'home'}),confirmed:{executionId:'e',revision:1}});
  expect(importSeconds('imp-zzzzzzzzzzzzzzzzzzzz','0')).toBeUndefined();
});
it('shows the lengths left in the session before a page reload in the frames of a fresh screen, once',async()=>{
  noteImportSeconds('imp-reloadreloadreload',[['0',2]]);handOverImportSeconds('p','imp-reloadreloadreload');
  vi.resetModules();const fresh=await import('./useImportBatches'),freshSeconds=await import('./importSeconds');
  expect(freshSeconds.importSeconds('imp-reloadreloadreload','0')).toBeUndefined();
  const {result}=renderHook(()=>fresh.useImportBatches('p',{ready:false,confirm}));
  await send({...batch('imp-reloadreloadreload','preparing',{kind:'home'}),items:[{itemId:'i0',key:'0',name:'a.mp4',phase:'probing'}]});
  expect(result.current.frames(emptyDoc(0)).map(frame=>[frame.durationFrames,frame.estimated])).toEqual([[60,false]]);
  expect(sessionStorage.length).toBe(0);
});
it('keeps a batch waiting for a decision open without placing it, and places it once decided',async()=>{
  const {result}=renderHook(()=>useImportBatches('p',{ready:true,confirm}));
  const deciding:ImportBatchView={...batch('imp-jjjjjjjjjjjjjjjjjjjj','deciding',{kind:'home'}),items:[{itemId:'i0',key:'0',name:'a.mp4',phase:'awaiting-decision'}],decision:{itemIds:['i0'],totalBytes:1,totalSeconds:90}};
  await send(deciding);expect(result.current.batches.map(b=>b.batchId)).toEqual(['imp-jjjjjjjjjjjjjjjjjjjj']);expect(confirm).not.toHaveBeenCalled();
  await send(batch('imp-jjjjjjjjjjjjjjjjjjjj','ready',{kind:'home'}));expect(confirm.mock.calls).toEqual([['imp-jjjjjjjjjjjjjjjjjjjj',false]]);
});
