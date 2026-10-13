/** @vitest-environment jsdom */
import {act,cleanup,renderHook,waitFor} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {useNativeSession} from './useNativeSession';
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
const session=(revision:number)=>({sessionId:'s',document:{schemaVersion:2,id:'d',name:'x',revision,fps:{num:30,den:1},resolution:{width:320,height:180},sequenceEndFrame:0,background:'#000',clips:[],tracks:[],assets:[],transitions:[],transcripts:[],ducking:{enabled:false,strength:'mid'}},savedRevision:0,savedContentHash:'h',dirty:revision>0,canUndo:false,canRedo:false});
it('confirms with the current session and keeps a 409 「配置済み」 quiet',async()=>{
  const sent:unknown[]=[];let reply={status:200,json:session(1) as unknown};
  vi.stubGlobal('fetch',vi.fn(async(url:string,options?:RequestInit)=>{
    if(new URL(url,'http://localhost').pathname==='/api/sequence/imports/confirm'){sent.push(JSON.parse(String(options?.body)));return {ok:reply.status<400,status:reply.status,json:async()=>reply.json};}
    return {ok:true,status:200,json:async()=>session(0)};
  }));
  const view=renderHook(()=>useNativeSession('p'));await waitFor(()=>expect(view.result.current.state).not.toBeNull());
  await act(async()=>{expect(await view.result.current.confirmImport('imp-aaaaaaaaaaaaaaaaaaaa',true)).toBe(true);});
  expect(sent[0]).toMatchObject({sessionId:'s',batchId:'imp-aaaaaaaaaaaaaaaaaaaa',skipFailed:true});expect(view.result.current.state?.document.revision).toBe(1);
  reply={status:409,json:{error:'この取り込みは配置済みです。元に戻した取り込みは再配置しません',code:'IMPORT_CONFIRMED'}};
  await act(async()=>{expect(await view.result.current.confirmImport('imp-aaaaaaaaaaaaaaaaaaaa',false)).toBe(false);});
  expect(view.result.current.error).toBeNull();
});
it('keeps a 409 「配置中」 from another window quiet too',async()=>{
  vi.stubGlobal('fetch',vi.fn(async(url:string)=>new URL(url,'http://localhost').pathname==='/api/sequence/imports/confirm'
    ?{ok:false,status:409,json:async()=>({error:'この取り込みを配置しています',code:'IMPORT_CONFIRMING'})}:{ok:true,status:200,json:async()=>session(0)}));
  const view=renderHook(()=>useNativeSession('p'));await waitFor(()=>expect(view.result.current.state).not.toBeNull());
  await act(async()=>{expect(await view.result.current.confirmImport('imp-aaaaaaaaaaaaaaaaaaaa',false)).toBe(false);});
  expect(view.result.current.error).toBeNull();
});
