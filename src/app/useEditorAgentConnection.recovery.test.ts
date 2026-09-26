/** @vitest-environment jsdom */
import {act,cleanup,renderHook} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {useEditorAgentConnection,type AsyncEditorBridge} from './useEditorAgentConnection';
import type {EditorSessionSnapshot} from '../shared/editorSessions';

const delivery=vi.hoisted(()=>vi.fn());
vi.mock('./edit/editorDelivery',()=>({executeEditorDelivery:delivery}));
const snapshot:EditorSessionSnapshot={status:'ready',projectId:'project-a',revision:'r1',dirty:false,saving:false,humanBusy:false,elements:[]};
const bridge=():AsyncEditorBridge=>({sessionId:'browser-a',presence:async()=>snapshot,
  apply:vi.fn(),save:vi.fn(),hasApplied:()=>false});
const response=(body:unknown)=>({ok:true,json:async()=>body});
beforeEach(()=>{vi.useFakeTimers();vi.spyOn(console,'warn').mockImplementation(()=>{});delivery.mockReset();delivery.mockResolvedValue({kind:'retry'});});
afterEach(()=>{cleanup();vi.unstubAllGlobals();vi.restoreAllMocks();vi.useRealTimers();});

it('treats a failed idle heartbeat as reconnecting, without latching an unknown edit error',async()=>{
  let fail=true;
  vi.stubGlobal('fetch',vi.fn(async()=>{if(fail)throw new DOMException('signal timed out','TimeoutError');return response({deliveries:[]});}));
  const {result}=renderHook(()=>useEditorAgentConnection(bridge(),'project-a',vi.fn()));
  await act(async()=>{});
  expect(result.current.connection).toBe('offline');
  expect(result.current.error).toBeNull();
  expect(result.current.transportError).toBeTruthy();
  expect(result.current.readySnapshot).toBeNull();
  fail=false;await act(async()=>{await vi.advanceTimersByTimeAsync(2000);});
  expect(result.current.connection).toBe('connected');
  expect(result.current.transportError).toBeNull();
  expect(result.current.error).toBeNull();
  expect(result.current.readySnapshot).toEqual({projectId:'project-a',revision:'r1'});
});

it('retires the last ready snapshot while the connection is unavailable',async()=>{
  let fail=false;
  vi.stubGlobal('fetch',vi.fn(async()=>{if(fail)throw new TypeError('Failed to fetch');return response({deliveries:[]});}));
  const {result}=renderHook(()=>useEditorAgentConnection(bridge(),'project-a',vi.fn()));
  await act(async()=>{});expect(result.current.readySnapshot).not.toBeNull();
  fail=true;await act(async()=>{await vi.advanceTimersByTimeAsync(2000);});
  expect(result.current.connection).toBe('offline');
  expect(result.current.readySnapshot).toBeNull();
  expect(result.current.error).toBeNull();
  expect(result.current.transportError).toBe('接続できません。自動で再接続します。');
});

it('retains an unknown edit outcome through reconnection and keeps unresolved work gated',async()=>{
  let first=true,fail=false;
  delivery.mockResolvedValue({kind:'unknown',message:'保存の返事を確認できません'});
  vi.stubGlobal('fetch',vi.fn(async(url:string)=>{
    if(fail)throw new DOMException('signal timed out','TimeoutError');
    if(url.endsWith('/disconnect'))return response({ok:true});
    const deliveries=first?[{runId:'run-a',request:{}}]:[];first=false;
    return response({deliveries,unresolved:!deliveries.length});
  }));
  const {result}=renderHook(()=>useEditorAgentConnection(bridge(),'project-a',vi.fn()));
  await act(async()=>{});expect(result.current.error).toBe('保存の返事を確認できません');
  fail=true;await act(async()=>{await vi.advanceTimersByTimeAsync(2000);});
  expect(result.current.connection).toBe('offline');
  expect(result.current.error).toBe('保存の返事を確認できません');
  expect(result.current.transportError).toBeTruthy();
  fail=false;
  await act(async()=>{await vi.advanceTimersByTimeAsync(2000);});
  expect(result.current.connection).toBe('connected');
  expect(result.current.error).toBe('保存の返事を確認できません');
  expect(result.current.needsReview).toBe(true);
  expect(result.current.readySnapshot).toBeNull();
});

it('preserves a server rejection reason instead of misreporting a network failure',async()=>{
  let rejected=true;const reason='SESSION_OWNERSHIP_CONFLICT: 別の編集画面です';
  vi.stubGlobal('fetch',vi.fn(async()=>rejected?{ok:false,status:409,json:async()=>({error:reason})}:response({deliveries:[]})));
  const {result}=renderHook(()=>useEditorAgentConnection(bridge(),'project-a',vi.fn()));
  await act(async()=>{});
  expect(result.current.connection).toBe('offline');
  expect(result.current.transportError).toBe(reason);
  expect(result.current.error).toBeNull();expect(result.current.readySnapshot).toBeNull();
  expect(console.warn).toHaveBeenCalledWith('AI接続の確認に失敗しました',expect.objectContaining({name:'ApiError',status:409,message:reason}));
  rejected=false;await act(async()=>{await vi.advanceTimersByTimeAsync(2000);});
  expect(result.current.transportError).toBeNull();expect(result.current.connection).toBe('connected');
});
