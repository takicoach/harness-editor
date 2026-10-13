/** @vitest-environment jsdom */
import {afterEach,expect,it,vi} from 'vitest';
import {act,cleanup,renderHook} from '@testing-library/react';
import type {CopyJobView} from '../../shared/mediaCopy';
const handlers=vi.hoisted(()=>new Map<string,(raw:unknown)=>void>());
vi.mock('../eventBus',()=>({useEventChannelWithSync:(ch:string,_projectId:string,apply:(raw:unknown)=>void)=>{handlers.set(ch,apply);}}));
import {copyJobsMessage,useMediaCopyJobs} from './useMediaCopyJobs';
afterEach(()=>{cleanup();handlers.clear();});
const job=(phases:Array<CopyJobView['items'][number]['phase']>,state:CopyJobView['state']='running',jobId='cp-1'):CopyJobView=>({jobId,projectId:'case',mode:'reconnect',state,createdAt:'x',destination:{kind:'volume',label:'ssd'},
  items:phases.map((phase,index)=>({itemId:`c${index}`,name:`${index}.mp4`,sizeBytes:1,phase,bytesDone:0,assetId:`${jobId}-a${index}`}))});
const send=(jobs:CopyJobView[])=>act(()=>{handlers.get('copy-jobs')!({type:'list',jobs});});

// 素材の読み直し（プレビューとタイムラインを作り直す）は1本ごとではなく、新しくつなぎ替えた素材がある作業の終わりにまとめて1回。
it('tells the screen once when a job with newly reconnected files ends, also when the same list arrives again after reconnecting',()=>{
  const onConnected=vi.fn(),view=renderHook(()=>useMediaCopyJobs('case',onConnected));
  send([job(['copying','waiting'])]);expect(onConnected).not.toHaveBeenCalled();expect([...view.result.current.activeAssetIds]).toEqual(['cp-1-a0','cp-1-a1']);
  send([job(['done','copying'])]);expect(onConnected).not.toHaveBeenCalled();   // 走っている間はまとめて待つ
  send([job(['done','copying'])]);expect(onConnected).not.toHaveBeenCalled();
  send([job(['done','done'],'finished')]);expect(onConnected).toHaveBeenCalledTimes(1);expect(view.result.current.activeAssetIds.size).toBe(0);
  send([job(['done','done'],'finished')]);expect(onConnected).toHaveBeenCalledTimes(1);   // 再接続の一覧（同じ内容）では知らせない
});
it('tells once for several jobs ending together, for a stopped job and a job left waiting for its drive, and not for a job without new reconnections',()=>{
  const onConnected=vi.fn();renderHook(()=>useMediaCopyJobs('case',onConnected));
  send([job(['copying'],'running','cp-a'),job(['copying'],'running','cp-b'),job(['copying','waiting'],'running','cp-c'),job(['copying'],'running','cp-d')]);
  send([job(['done'],'finished','cp-a'),job(['done'],'finished','cp-b'),job(['done','copying'],'running','cp-c'),job(['cancelled'],'stopped','cp-d')]);expect(onConnected).toHaveBeenCalledTimes(1);
  send([job(['done'],'finished','cp-a'),job(['done'],'finished','cp-b'),job(['done','copying'],'waiting-volume','cp-c'),job(['cancelled'],'stopped','cp-d')]);expect(onConnected).toHaveBeenCalledTimes(2);
});
it('keeps only this project\'s jobs',()=>{
  const view=renderHook(()=>useMediaCopyJobs('case',vi.fn()));send([{...job(['waiting']),projectId:'other'}]);expect(view.result.current.jobs).toEqual([]);
});
// 申し送り（Task 11 のレビュー）: このエディターが動かしていない作業の素材は「コピー中」として押せなくしない（サーバの activeAssetIds もこのプロセスの作業だけ）。
it('does not count the files of a job run elsewhere as being copied',()=>{
  const view=renderHook(()=>useMediaCopyJobs('case',vi.fn()));
  send([{...job(['copying','waiting'],'running','cp-2'),notThisProcess:true},job(['waiting'])]);
  expect([...view.result.current.activeAssetIds]).toEqual(['cp-1-a0']);expect(view.result.current.jobs).toHaveLength(2);
});
// 開いた時の最初の一覧に既にある完了分は、読み込んだばかりの素材なので数えない（素材の読み直しでプレビューとタイムラインを作り直さない）。以後の完了は作業の終わりに知らせる。
it('does not count files already reconnected in the first list after opening, but does later ones',()=>{
  const onConnected=vi.fn(),view=renderHook(({id})=>useMediaCopyJobs(id,onConnected),{initialProps:{id:'case'}});
  send([job(['done','done'],'finished','cp-old'),job(['done','copying'])]);expect(onConnected).not.toHaveBeenCalled();
  send([job(['done','done'],'finished','cp-old'),job(['done','done'],'finished')]);expect(onConnected).toHaveBeenCalledTimes(1);
  view.rerender({id:'other'});expect(view.result.current.jobs).toEqual([]);
  view.rerender({id:'case'});send([job(['done','done'],'finished')]);expect(onConnected).toHaveBeenCalledTimes(1);   // 開き直した時の最初の一覧
});
// 完了の通知: この画面で走っているのを見ていた作業が終わった・止まった時に1回だけ。開いた時に既に終わっていた作業・別のエディターの作業は知らせない。
it('reports a job seen running here once when it finishes or stops',()=>{
  const onSettled=vi.fn();renderHook(()=>useMediaCopyJobs('case',vi.fn(),onSettled));
  send([job(['done'],'finished','cp-old'),job(['copying']),{...job(['copying'],'running','cp-3'),notThisProcess:true}]);
  send([job(['done'],'finished','cp-old'),job(['done'],'finished'),{...job(['cancelled'],'stopped','cp-3')}]);
  expect(onSettled).toHaveBeenCalledTimes(1);expect(onSettled.mock.calls[0]![0]).toMatchObject({jobId:'cp-1',state:'finished'});
  send([job(['done'],'finished','cp-old'),job(['done'],'finished')]);expect(onSettled).toHaveBeenCalledTimes(1);
});
it('reads only list messages',()=>{
  expect(copyJobsMessage({type:'list',jobs:[]})).toEqual([]);expect(copyJobsMessage({type:'update'})).toBeNull();expect(copyJobsMessage(null)).toBeNull();expect(copyJobsMessage({type:'list',jobs:{}})).toBeNull();
});
