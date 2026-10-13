/** @vitest-environment jsdom */
import {act,cleanup,renderHook,waitFor} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {useNativeSession} from './useNativeSession';
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
const session=(revision:number)=>({sessionId:'s',document:{schemaVersion:2,id:'d',name:'x',revision,fps:{num:30,den:1},resolution:{width:320,height:180},sequenceEndFrame:0,background:'#000',clips:[],tracks:[],assets:[],transitions:[],transcripts:[],ducking:{enabled:false,strength:'mid'}},savedRevision:0,savedContentHash:'h',dirty:revision>0,canUndo:revision>0,canRedo:false});
function setup(reply:Array<'network'|{status:number;json:unknown}>){
  const sent:Array<Record<string,unknown>>=[],queue=[...reply];
  vi.stubGlobal('fetch',vi.fn(async(url:string,options?:RequestInit)=>{
    const route=new URL(url,'http://localhost').pathname.replace('/api/sequence','');
    if(route==='/main/append'){sent.push(JSON.parse(String(options?.body)));const next=queue.shift()!;if(next==='network')throw new TypeError('Failed to fetch');return {ok:next.status<400,status:next.status,json:async()=>next.json};}
    return {ok:true,status:200,json:async()=>session(0)};
  }));
  return {sent,view:renderHook(()=>useNativeSession('p'))};
}
it('appends with the current session and resends the same execution once when the response is lost',async()=>{
  const h=setup(['network',{status:200,json:session(1)}]);await waitFor(()=>expect(h.view.result.current.state).not.toBeNull());
  let result;await act(async()=>{result=await h.view.result.current.appendToMain(['a','b']);});
  expect(result).toEqual({ok:true});expect(h.sent).toHaveLength(2);expect(h.sent[0]).toMatchObject({sessionId:'s',assetIds:['a','b']});
  expect(h.sent[1]!.executionId).toBe(h.sent[0]!.executionId);expect(h.view.result.current.state?.document.revision).toBe(1);
});
it('returns the refusal without resending or writing the shared error',async()=>{
  const h=setup([{status:409,json:{error:'速度を設定した案件では、まだメインに素材を足せません。素材をすべて並べてから速度を設定してください（速度を設定する前に戻すには「元に戻す」を使います）',code:'SPEED_REGISTERED'}}]);
  await waitFor(()=>expect(h.view.result.current.state).not.toBeNull());
  let result;await act(async()=>{result=await h.view.result.current.appendToMain(['a']);});
  expect(result).toEqual({ok:false,message:'速度を設定した案件では、まだメインに素材を足せません。素材をすべて並べてから速度を設定してください（速度を設定する前に戻すには「元に戻す」を使います）'});
  expect(h.sent).toHaveLength(1);expect(h.view.result.current.error).toBeNull();
});
