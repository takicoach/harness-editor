/** @vitest-environment jsdom */
import {StrictMode} from 'react';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {act,cleanup,renderHook} from '@testing-library/react';
import {fixture} from '../../core/sequence/fixtures';
import {rational as r} from '../../core/sequence/time';
import type {SequenceDocument} from '../../core/sequence/model';
import {useTrialSwap,type TrialSwapBase} from './useTrialSwap';
afterEach(cleanup);
type Outcome='ok'|'conflict'|'failed'|'unknown'|'cancelled';
const AUTO='内容が更新されたため試し表示を終了しました',CONFLICT='内容が更新されたため採用できませんでした。もう一度試してください',UNKNOWN='採用できたか確認できませんでした。タイムラインを確かめてください';
function docWithImages():SequenceDocument{
  const doc=fixture();
  doc.assets.push({id:'img-a',kind:'image',file:'public/a.png',name:'図A',fingerprint:'f3',streams:[]},{id:'img-b',kind:'image',file:'public/b.png',name:'図B',fingerprint:'f4',streams:[]},{id:'img-c',kind:'image',file:'public/c.png',name:'図C',fingerprint:'f5',streams:[]});
  doc.tracks.push({id:'v3',kind:'visual',name:'挿入',enabled:true});
  doc.clips.push({id:'pic',name:'図',trackId:'v3',startFrame:30,durationFrames:60,clock:{offset:r(0),rate:r(1),duration:r(60)},content:{kind:'image',assetId:'img-a',style:'plain'},visual:{layout:{position:{x:.2,y:-.1},scale:.5,rotation:3,flipH:false,flipV:false,background:'transparent'},opacity:.9,keyframes:[]}});
  return doc;
}
function setup(strict=false){
  const doc=docWithImages(),base:TrialSwapBase={projectId:'p',sessionId:'s',document:structuredClone(doc)};
  const onNotice=vi.fn();let resolve:(o:Outcome)=>void=()=>{};
  const executeAt=vi.fn(()=>new Promise<Outcome>(res=>{resolve=res;}));
  const hook=renderHook((props:{current:{projectId:string;sessionId?:string;document?:SequenceDocument}})=>useTrialSwap({current:props.current,executeAt,onNotice}),{initialProps:{current:{projectId:'p',sessionId:'s',document:doc}},...(strict?{wrapper:StrictMode}:{})});
  return {doc,base,onNotice,executeAt,hook,settle:(o:Outcome)=>resolve(o)};
}
describe('useTrialSwap',()=>{
  it('start で世代1・試し用 id',()=>{
    const t=setup();let ok=false;
    act(()=>{ok=t.hook.result.current.start(t.base,'pic','img-b');});
    expect(ok).toBe(true);expect(t.hook.result.current.trial?.generation).toBe(1);
    expect(t.hook.result.current.trial?.result.preview.id).toBe(`${t.doc.id}:trial:1`);
  });
  it('choose 2回で世代3・基準は開始時の内容のまま（current 側だけ変わっても）',()=>{
    const t=setup();act(()=>{t.hook.result.current.start(t.base,'pic','img-b');});
    t.hook.rerender({current:{projectId:'p',sessionId:'s',document:{...t.doc,name:'変えた'}}});
    act(()=>{t.hook.result.current.choose('img-c');});act(()=>{t.hook.result.current.choose('img-b');});
    const tr=t.hook.result.current.trial!;
    expect(tr.generation).toBe(3);expect(tr.result.preview.id).toBe(`${t.doc.id}:trial:3`);
    expect(t.base.document.name).not.toBe('変えた');expect(tr.result.preview.name).toBe(t.base.document.name);expect(tr.result.preview.name).not.toBe('変えた');
    act(()=>{t.hook.result.current.setEndMode('silence');});
    expect(t.hook.result.current.trial?.generation).toBe(4);expect(t.hook.result.current.trial?.result.preview.name).toBe(t.base.document.name);
  });
  it.each([['projectId',{projectId:'q'}],['sessionId',{sessionId:'x'}],['document.id',{document:'id'}]] as const)('%s が変わると自動解除（通知1回）',(_n,change)=>{
    const t=setup();act(()=>{t.hook.result.current.start(t.base,'pic','img-b');});
    const document='document' in change?{...t.doc,id:'other'}:t.doc;
    t.hook.rerender({current:{projectId:'projectId' in change?change.projectId:'p',sessionId:'sessionId' in change?change.sessionId:'s',document}});
    expect(t.hook.result.current.trial).toBeNull();expect(t.onNotice).toHaveBeenCalledTimes(1);expect(t.onNotice).toHaveBeenCalledWith(AUTO);
  });
  it('choose 失敗で直前の試しが残り error に理由、成功で error は空に戻る',()=>{
    const t=setup();act(()=>{t.hook.result.current.start(t.base,'pic','img-b');});
    let ok=true;act(()=>{ok=t.hook.result.current.choose('song-nope');});
    expect(ok).toBe(false);expect(t.hook.result.current.trial?.generation).toBe(1);expect(t.hook.result.current.trial?.assetId).toBe('img-b');expect(t.hook.result.current.error).toEqual({clipId:'pic',message:expect.any(String)});
    act(()=>{ok=t.hook.result.current.choose('img-c');});
    expect(ok).toBe(true);expect(t.hook.result.current.trial?.generation).toBe(2);expect(t.hook.result.current.error).toBeNull();
  });
  it('setEndMode 失敗で直前の試しが残り error に理由',()=>{
    const t=setup();act(()=>{t.hook.result.current.start(t.base,'pic','img-b');});
    Object.assign(t.base.document.clips.find(c=>c.id==='pic')!,{speed:2}); // 開始後に基準の再構築が失敗する状況を作る
    let ok=true;act(()=>{ok=t.hook.result.current.setEndMode('silence');});
    expect(ok).toBe(false);expect(t.hook.result.current.trial?.generation).toBe(1);expect(t.hook.result.current.trial?.endMode).toBe('loop');expect(t.hook.result.current.error).toEqual({clipId:'pic',message:expect.any(String)});
  });
  it('採用中の start は false で何もせず、完了時に新しい試しを消さない',async()=>{
    const t=setup();act(()=>{t.hook.result.current.start(t.base,'pic','img-b');});
    let p:Promise<string>=Promise.resolve('');act(()=>{p=t.hook.result.current.adopt();});
    let ok=true;act(()=>{ok=t.hook.result.current.start(t.base,'pic','img-c');});
    expect(ok).toBe(false);expect(t.hook.result.current.trial?.assetId).toBe('img-b');expect(t.hook.result.current.trial?.adopting).toBe(true);
    let second='';await act(async()=>{second=await t.hook.result.current.adopt();});
    expect(second).toBe('busy');expect(t.executeAt).toHaveBeenCalledTimes(1);
    await act(async()=>{t.settle('failed');await p;});
    expect(t.hook.result.current.trial?.assetId).toBe('img-b');expect(t.hook.result.current.trial?.adopting).toBe(false);
  });
  it('アンマウント後に採用が解決しても通知しない',async()=>{
    const t=setup();act(()=>{t.hook.result.current.start(t.base,'pic','img-b');});
    let p:Promise<string>=Promise.resolve('');act(()=>{p=t.hook.result.current.adopt();});
    t.hook.unmount();
    await act(async()=>{t.settle('conflict');await p;});
    expect(t.onNotice).not.toHaveBeenCalled();
  });
  it('版が進むと自動解除し、通知は1回だけ（StrictMode でも）',()=>{
    const t=setup(true);act(()=>{t.hook.result.current.start(t.base,'pic','img-b');});
    t.hook.rerender({current:{projectId:'p',sessionId:'s',document:{...t.doc,revision:t.doc.revision+1}}});
    expect(t.hook.result.current.trial).toBeNull();expect(t.onNotice).toHaveBeenCalledTimes(1);expect(t.onNotice).toHaveBeenCalledWith(AUTO);
    t.hook.rerender({current:{projectId:'p',sessionId:'s',document:{...t.doc,revision:t.doc.revision+2}}});
    expect(t.onNotice).toHaveBeenCalledTimes(1);
  });
  it('adopt は開始時の版で1回だけ送り、処理中の2回目は busy・choose/revert は無視',async()=>{
    const t=setup();act(()=>{t.hook.result.current.start(t.base,'pic','img-b');});
    let p1:Promise<string>=Promise.resolve(''),second='';
    act(()=>{p1=t.hook.result.current.adopt();});
    await act(async()=>{second=await t.hook.result.current.adopt();});
    expect(second).toBe('busy');expect(t.executeAt).toHaveBeenCalledTimes(1);
    expect(t.executeAt).toHaveBeenCalledWith(t.hook.result.current.trial!.result.command,{sessionId:'s',revision:t.doc.revision});
    expect(t.hook.result.current.trial?.adopting).toBe(true);
    let c=true;act(()=>{c=t.hook.result.current.choose('img-c');t.hook.result.current.revert();});
    expect(c).toBe(false);expect(t.hook.result.current.trial?.generation).toBe(1);
    await act(async()=>{t.settle('failed');await p1;});
  });
  it.each([['conflict',CONFLICT,true],['unknown',UNKNOWN,true],['ok',null,true],['cancelled',null,true],['failed',null,false]] as const)('adopt が %s',async(outcome,notice,cleared)=>{
    const t=setup();act(()=>{t.hook.result.current.start(t.base,'pic','img-b');});
    let p:Promise<string>=Promise.resolve('');act(()=>{p=t.hook.result.current.adopt();});
    let got='';await act(async()=>{t.settle(outcome);got=await p;});
    expect(got).toBe(outcome);
    if(cleared)expect(t.hook.result.current.trial).toBeNull();else{expect(t.hook.result.current.trial).not.toBeNull();expect(t.hook.result.current.trial?.adopting).toBe(false);}
    if(notice)expect(t.onNotice).toHaveBeenCalledWith(notice);else expect(t.onNotice).not.toHaveBeenCalled();
  });
  it('採用が ok で版が進んでも自動解除の通知は出ない（採用中に進んだ場合も）',async()=>{
    const t=setup(true);act(()=>{t.hook.result.current.start(t.base,'pic','img-b');});
    let p:Promise<string>=Promise.resolve('');act(()=>{p=t.hook.result.current.adopt();});
    t.hook.rerender({current:{projectId:'p',sessionId:'s',document:{...t.doc,revision:t.doc.revision+1}}});
    expect(t.onNotice).not.toHaveBeenCalled();
    await act(async()=>{t.settle('ok');await p;});
    expect(t.hook.result.current.trial).toBeNull();expect(t.onNotice).not.toHaveBeenCalled();
  });
  it('buildTrialSwap が失敗なら start は false で error に理由',()=>{
    const t=setup();let ok=true;
    act(()=>{ok=t.hook.result.current.start(t.base,'pic','song-nope');});
    expect(ok).toBe(false);expect(t.hook.result.current.trial).toBeNull();expect(t.hook.result.current.error).toEqual({clipId:'pic',message:'この素材はこのクリップの候補にできません'});
  });
  it('理由はクリップに結び付けて持ち、clearError で消える（別のクリップの節に出さないため）',()=>{
    const t=setup();
    act(()=>{t.hook.result.current.start(t.base,'pic','song-nope');});
    expect(t.hook.result.current.error?.clipId).toBe('pic');
    act(()=>{t.hook.result.current.clearError();});
    expect(t.hook.result.current.error).toBeNull();
  });
  it('世代はフックの間ずっと増え続ける。開始が2本並んでも、後の開始は前と違う id で後の候補を持つ',()=>{
    const t=setup();
    act(()=>{t.hook.result.current.start(t.base,'pic','img-b');});
    const first=t.hook.result.current.trial!;
    act(()=>{t.hook.result.current.start(t.base,'pic','img-c');});
    const second=t.hook.result.current.trial!;
    expect(second.generation).toBeGreaterThan(first.generation);expect(second.result.preview.id).not.toBe(first.result.preview.id);
    expect(second.result.preview.clips.find(c=>c.id==='pic')!.content).toMatchObject({assetId:'img-c'});
    // 戻してから始め直しても、番号は戻らない（プレビューは同じ id・同じ版の文書を無視する）。
    act(()=>{t.hook.result.current.revert();t.hook.result.current.start(t.base,'pic','img-b');});
    expect(t.hook.result.current.trial!.generation).toBeGreaterThan(second.generation);
    expect(new Set([first,second,t.hook.result.current.trial!].map(x=>x.result.preview.id)).size).toBe(3);
  });
});
describe('useTrialSwap: 採用の結果が不明',()=>{
  it('refresh（状態の読み直し）を済ませてから知らせる',async()=>{
    const doc=docWithImages(),order:string[]=[];
    let finish:()=>void=()=>{};
    const refresh=vi.fn(()=>new Promise<void>(resolve=>{order.push('refresh');finish=()=>{order.push('refreshed');resolve();};}));
    const onNotice=vi.fn((message:string)=>{order.push(message);});
    const hook=renderHook(()=>useTrialSwap({current:{projectId:'p',sessionId:'s',document:doc},executeAt:async()=>'unknown',onNotice,refresh}));
    act(()=>{hook.result.current.start({projectId:'p',sessionId:'s',document:doc},'pic','img-b');});
    let pending:Promise<unknown>=Promise.resolve();
    await act(async()=>{pending=hook.result.current.adopt();await Promise.resolve();});
    expect(refresh).toHaveBeenCalledTimes(1);expect(onNotice).not.toHaveBeenCalled();
    await act(async()=>{finish();await pending;});
    expect(order).toEqual(['refresh','refreshed',UNKNOWN]);
  });
});
