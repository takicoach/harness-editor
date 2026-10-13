// src/server/mcp/editorTools.imports.test.ts
import {expect,it,vi} from 'vitest';
import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import type {EditorAgentService} from '../editorAgentService';
import {editorToolInputError,registerEditorTools} from './editorTools';
import {EDITOR_AGENT_CAPABILITIES} from '../editorAgentApi';
import {MAX_IMPORT_BATCH_ITEMS} from '../../shared/importBatches';
it('registers the import tools with the same response and error contract',()=>{
  const handlers=new Map<string,(input:Record<string,unknown>)=>{isError?:boolean;content:Array<{text:string}>}>();
  const server={registerTool:vi.fn((name:string,_d:unknown,handler:(input:Record<string,unknown>)=>{content:Array<{text:string}>})=>{handlers.set(name,handler);})} as unknown as McpServer;
  const service={importMedia:vi.fn(()=>({batchId:'imp-aaaaaaaaaaaaaaaaaaaa'})),importRuns:vi.fn(()=>[]),cancelImport:vi.fn(()=>{throw new Error('IMPORT_FINISHED: 配置済みの取り込みです');})} as unknown as EditorAgentService;
  registerEditorTools(server,service);
  expect(JSON.parse(handlers.get('editor_import_media')!({sessionId:'w',projectId:'case',operationId:'op',paths:['/Volumes/m/a.mp4'],placement:'append-main'}).content[0]!.text)).toEqual({batchId:'imp-aaaaaaaaaaaaaaaaaaaa'});
  const failed=handlers.get('editor_import_cancel')!({projectId:'case',batchId:'imp-aaaaaaaaaaaaaaaaaaaa'});
  expect(failed.isError).toBe(true);expect(JSON.parse(failed.content[0]!.text)).toMatchObject({code:'IMPORT_FINISHED'});
  expect(editorToolInputError('editor_import_media',{sessionId:'w',projectId:'case',operationId:'op',paths:[],placement:'append-main'})).toMatchObject({code:'INVALID_EDITOR_INPUT'});
  expect(editorToolInputError('editor_import_media',{sessionId:'w',projectId:'case',operationId:'op',paths:['/a.mp4'],placement:'at-playhead'})).toMatchObject({code:'INVALID_EDITOR_INPUT'});
  expect(editorToolInputError('editor_import_media',{sessionId:'w',projectId:'case',operationId:'op',paths:Array.from({length:MAX_IMPORT_BATCH_ITEMS+1},(_,i)=>`/v/${i}.mp4`),placement:'append-main'})).toMatchObject({code:'INVALID_EDITOR_INPUT'});
  // editor_read の能力一覧に出す道具は、実際に登録した道具と一致する。
  for(const name of EDITOR_AGENT_CAPABILITIES.imports.tools)expect(handlers.has(name)).toBe(true);
  vi.mocked(service.importMedia).mockImplementation(()=>{throw new Error('IMPORT_SPEED_REGISTERED: 速度を設定した案件では、まだメインに素材を足せません。');});
  const speed=handlers.get('editor_import_media')!({sessionId:'w',projectId:'case',operationId:'op',paths:['/Volumes/m/a.mp4'],placement:'append-main'});
  expect(speed.isError).toBe(true);expect(JSON.parse(speed.content[0]!.text)).toMatchObject({code:'IMPORT_SPEED_REGISTERED',retryable:false,recovery:{action:'fix_request'}});
  expect(EDITOR_AGENT_CAPABILITIES.imports).toMatchObject({placement:['append-main'],maxItemsPerBatch:MAX_IMPORT_BATCH_ITEMS});
});
it('pages the AI batch list newest first with a cursor that keeps its place when old batches are tidied away',()=>{
  const handlers=new Map<string,(input:Record<string,unknown>)=>{isError?:boolean;content:Array<{text:string}>}>();
  const server={registerTool:vi.fn((name:string,_d:unknown,handler:(input:Record<string,unknown>)=>{content:Array<{text:string}>})=>{handlers.set(name,handler);})} as unknown as McpServer;
  const views=Array.from({length:25},(_,index)=>({batchId:`imp-${index.toString(16).padStart(20,'0')}`,createdAt:`2026-10-03T00:00:${String(index).padStart(2,'0')}.000Z`}));
  let current=views;const ids=(page:{batches:Array<{batchId:string}>})=>page.batches.map(view=>view.batchId),of=(list:typeof views)=>list.map(view=>view.batchId);
  const service={importRuns:vi.fn((_projectId:string,batchId?:string)=>batchId?[views[3]]:current)} as unknown as EditorAgentService;
  registerEditorTools(server,service);const runs=(input:Record<string,unknown>)=>JSON.parse(handlers.get('editor_import_runs')!({projectId:'case',...input}).content[0]!.text);
  expect(runs({}).batches).toHaveLength(20);
  const first=runs({limit:10});expect(ids(first)).toEqual(of(views.slice(15).reverse()));expect(first).toMatchObject({total:25,nextCursor:expect.any(String)});
  current=views.slice(2);   // 古い2件が整理された
  const second=runs({cursor:first.nextCursor,limit:10});expect(ids(second)).toEqual(of(views.slice(5,15).reverse()));expect(second.total).toBe(23);
  const third=runs({cursor:second.nextCursor,limit:10});expect(ids(third)).toEqual(of(views.slice(2,5).reverse()));expect(third.nextCursor).toBeNull();
  expect(runs({batchId:views[3]!.batchId})).toEqual([views[3]]);
  expect(runs({cursor:'not-a-cursor'})).toMatchObject({code:'INVALID_PAGE'});
  expect(editorToolInputError('editor_import_runs',{projectId:'case',limit:101})).toMatchObject({code:'INVALID_EDITOR_INPUT'});
});
