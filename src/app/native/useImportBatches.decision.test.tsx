/** @vitest-environment jsdom */
import {afterEach,expect,it,vi} from 'vitest';
import {act,cleanup,renderHook} from '@testing-library/react';
import type {ImportBatchView} from '../../shared/importBatches';
const handlers=vi.hoisted(()=>new Map<string,(raw:unknown)=>void>());
vi.mock('../eventBus',()=>({useEventChannelWithSync:(ch:string,_projectId:string,apply:(raw:unknown)=>void)=>{handlers.set(ch,apply);}}));
import {useImportBatches} from './useImportBatches';
afterEach(()=>{cleanup();handlers.clear();});
it('prompts a batch waiting for a decision even when it would be placed automatically, and never places it',()=>{
  const confirm=vi.fn(async()=>true),view=renderHook(()=>useImportBatches('p',{ready:true,confirm}));
  const batch:ImportBatchView={batchId:'imp-aaaaaaaaaaaaaaaaaaaa',projectId:'p',createdAt:'x',origin:{kind:'home'},placement:'append-main',mode:'link',phase:'preparing',
    items:[{itemId:'i0',key:'0',name:'a.mp4',phase:'awaiting-decision'},{itemId:'i1',key:'1',name:'b.mp4',phase:'probing'}],decision:{itemIds:['i0'],totalBytes:1,totalSeconds:100}};
  act(()=>{handlers.get('imports')!({type:'list',batches:[batch]});});
  expect(view.result.current.pending.map(item=>item.batchId)).toEqual([batch.batchId]);expect(view.result.current.all).toHaveLength(1);expect(confirm).not.toHaveBeenCalled();
});
it('returns every batch of the project in all, including the placed and cancelled ones (their items carry the choice made)',()=>{
  const view=renderHook(()=>useImportBatches('p',{ready:false,confirm:vi.fn(async()=>true)}));
  const batch=(batchId:string,phase:ImportBatchView['phase'],projectId='p'):ImportBatchView=>({batchId,projectId,createdAt:'x',origin:{kind:'ui'},placement:'append-main',mode:'link',phase,
    items:[{itemId:'i0',key:'0',name:'a.mp4',phase:'ready',assetId:'x',choice:'keep-once'}]});
  act(()=>{handlers.get('imports')!({type:'list',batches:[batch('imp-aaaaaaaaaaaaaaaaaaaa','confirmed'),batch('imp-bbbbbbbbbbbbbbbbbbbb','cancelled'),batch('imp-cccccccccccccccccccc','ready','other')]});});
  expect(view.result.current.all.map(item=>item.batchId)).toEqual(['imp-aaaaaaaaaaaaaaaaaaaa','imp-bbbbbbbbbbbbbbbbbbbb']);expect(view.result.current.batches).toEqual([]);
});
