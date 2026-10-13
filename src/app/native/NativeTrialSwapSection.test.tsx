/** @vitest-environment jsdom */
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {act,cleanup,fireEvent,render,within} from '@testing-library/react';
import {NativeTrialSwapSection} from './NativeTrialSwapSection';
import {NativeInspector} from './NativeInspector';
import {fixture} from '../../core/sequence/fixtures';
import {rational as r} from '../../core/sequence/time';
import {applySequenceCommand} from '../../core/sequence/commands';
import {buildTrialSwap,type TrialEndMode} from '../../core/sequence/trialSwap';
import type {SequenceDocument} from '../../core/sequence/model';
import type {TrialSwapState} from './useTrialSwap';

afterEach(cleanup);

function docWithAssets():SequenceDocument{
  const doc=fixture();
  doc.assets.push(
    {id:'song-long',kind:'media',file:'public/a.m4a',name:'軽快',fingerprint:'f1',streams:[{index:0,kind:'audio',codec:'aac',duration:r(659,10),sampleRate:48000,channels:2}]},
    {id:'song-short',kind:'media',file:'public/b.m4a',name:'短い',fingerprint:'f2',streams:[{index:2,kind:'audio',codec:'aac',duration:r(90),sampleRate:48000,channels:2},{index:1,kind:'audio',codec:'aac',duration:r(5),sampleRate:48000,channels:2}]},
    {id:'se-1',kind:'media',file:'public/se/x.wav',name:'ポン',fingerprint:'f5',streams:[{index:0,kind:'audio',codec:'pcm',duration:r(1),sampleRate:48000,channels:2}]},
    {id:'img-a',kind:'image',file:'public/a.png',name:'図A',fingerprint:'f3',streams:[]},
    {id:'img-b',kind:'image',file:'public/b.png',name:'図B',fingerprint:'f4',streams:[]});
  doc.tracks.push({id:'v3',kind:'visual',name:'挿入',enabled:true});
  doc.clips.push({id:'pic',name:'図',trackId:'v3',startFrame:30,durationFrames:60,clock:{offset:r(0),rate:r(1),duration:r(60)},content:{kind:'image',assetId:'img-a',style:'plain'},
    visual:{layout:{position:{x:0,y:0},scale:1,rotation:0,flipH:false,flipV:false,background:'transparent'},opacity:1,keyframes:[]}});
  const music=doc.clips.find(c=>c.id==='music')!;music.durationFrames=300;music.clock.duration=r(300);
  if(music.content.kind==='audio'){music.content.assetId='song-long';music.content.streamIndex=0;} // fixture の music は映像素材を指すので、BGM 素材へ向ける
  return doc;
}
function trialOf(doc:SequenceDocument,clipId:string,assetId:string,endMode:TrialEndMode='loop'):TrialSwapState{
  const result=buildTrialSwap(doc,{clipId,assetId,endMode,generation:1});
  if(!result.ok)throw new Error(result.reason);
  return {base:{projectId:'p',sessionId:'s',document:doc},clipId,assetId,endMode,generation:1,result,adopting:false};
}
function setup(doc:SequenceDocument,clipId:string,over:Partial<Parameters<typeof NativeTrialSwapSection>[0]>={}){
  const fns={onStart:vi.fn(),onChoose:vi.fn(),onEndMode:vi.fn()};
  const view=render(<NativeTrialSwapSection document={doc} clipId={clipId} projectId="p" trial={null} error={null} disabled={false} {...fns} {...over}/>);
  return {view,...fns};
}

let sizes:Record<string,[number,number]|'error'>;
beforeEach(()=>{
  sizes={};
  class FakeImage{onload:null|(()=>void)=null;onerror:null|(()=>void)=null;naturalWidth=0;naturalHeight=0;
    set src(url:string){const id=new URL(url,'http://x').searchParams.get('asset')!,size=sizes[id];
      queueMicrotask(()=>{if(!size||size==='error'){this.onerror?.();return;}[this.naturalWidth,this.naturalHeight]=size;this.onload?.();});}}
  vi.stubGlobal('Image',FakeImage);
});
afterEach(()=>vi.unstubAllGlobals());

it('BGM: 候補は BGM だけで、使用中は押せず、長さを m:ss で添える',()=>{
  const doc=docWithAssets(),{view}=setup(doc,'music');
  expect(view.getByRole('heading',{name:'素材を試す'})).toBeTruthy();
  expect((view.getByRole('button',{name:/軽快（使用中） 1:05/}) as HTMLButtonElement).disabled).toBe(true);
  expect(view.getByRole('button',{name:/短い 0:05/})).toBeTruthy();
  expect(view.queryByRole('button',{name:/ポン/})).toBeNull();
  expect(view.queryByRole('button',{name:/図A/})).toBeNull();
});
it('試し中でなければ onStart、試し中なら onChoose。試している候補は aria-pressed',()=>{
  const doc=docWithAssets(),a=setup(doc,'music');
  fireEvent.click(a.view.getByRole('button',{name:/短い/}));
  expect(a.onStart).toHaveBeenCalledWith('song-short');expect(a.onChoose).not.toHaveBeenCalled();
  expect(a.view.queryByText('曲の頭から再生します')).toBeNull();
  cleanup();
  const trial=trialOf(doc,'music','song-short'),b=setup(doc,'music',{trial});
  expect(b.view.getByRole('button',{name:/短い/}).getAttribute('aria-pressed')).toBe('true');
  expect(b.view.getByRole('button',{name:/軽快/}).getAttribute('aria-pressed')).toBe('false');
  fireEvent.click(b.view.getByRole('button',{name:/短い/}));
  expect(b.onChoose).toHaveBeenCalledWith('song-short');expect(b.onStart).not.toHaveBeenCalled();
});
it('試している候補には「（試し中）」を付け、太字で見分けられる（aria-pressed はそのまま）',()=>{
  const css=readFileSync(join(__dirname,'native-studio.css'),'utf8').split('\n').filter(line=>line.startsWith('.native-trial-candidates'));
  const style=document.createElement('style');style.textContent=css.join('\n');document.head.append(style);
  try{
    const doc=docWithAssets(),trial=trialOf(doc,'pic','img-b'),{view}=setup(doc,'pic',{trial});
    const on=view.getByRole('button',{name:/^図B（試し中）/}),current=view.getByRole('button',{name:/^図A（使用中）/});
    expect(on.getAttribute('aria-pressed')).toBe('true');expect(current.textContent).not.toContain('（試し中）');
    expect(getComputedStyle(on).fontWeight).toBe('700');expect(getComputedStyle(current).fontWeight).not.toBe('700');
    cleanup();
    const music=setup(doc,'music',{trial:trialOf(doc,'music','song-short')});
    expect(music.view.getByRole('button',{name:/^短い（試し中） 0:05/})).toBeTruthy();
    cleanup();
    expect(setup(doc,'pic').view.queryByText(/（試し中）/)).toBeNull(); // 試していなければ印は無い
  }finally{style.remove();}
});
it('NativeInspector: 試し中でも選択が空なら節は出ない（帯は NativeWorkspace 側に残る）',()=>{
  const doc=docWithAssets();
  const view=render(<NativeInspector projectId="p" document={doc} readDocument={()=>doc} frame={0} onSeek={()=>{}} selected={[]} disabled={false}
    bypassLut={false} onBypass={()=>{}} onCommand={async()=>true} onUploadLut={()=>{}} onPrepareTextStyles={async()=>true}
    trialSwap={{trial:trialOf(doc,'pic','img-b'),error:null,disabled:false,onStart:vi.fn(),onChoose:vi.fn(),onEndMode:vi.fn()}}/>);
  expect(view.queryByRole('heading',{name:'素材を試す'})).toBeNull();
});
it('別クリップの試しは、このクリップでは試し中として扱わない',()=>{
  const doc=docWithAssets(),trial=trialOf(doc,'pic','img-b'),{view,onStart}=setup(doc,'music',{trial});
  fireEvent.click(view.getByRole('button',{name:/短い/}));
  expect(onStart).toHaveBeenCalledWith('song-short');expect(view.queryByText('曲の頭から再生します')).toBeNull();
});
it('案内の行: 頭から・速度・ミュート・途中で終わる',()=>{
  const doc=docWithAssets(),music=doc.clips.find(c=>c.id==='music')!;
  if(music.content.kind!=='audio')throw new Error('audio');
  music.content.rate=r(2);music.content.settings.muted=true;
  const {view}=setup(doc,'music',{trial:trialOf(doc,'music','song-short')});
  expect(view.getByText('曲の頭から再生します')).toBeTruthy();
  expect(view.getByText('速度 ×2 を引き継ぎます')).toBeTruthy();
  expect(view.getByText('ミュート中です')).toBeTruthy();
  expect(view.getByText('曲が途中で終わります')).toBeTruthy();
});
it('カットを含む案内: 先頭をカットしていれば途中から再生、表示中は足りてカットを戻すと足りないならその文言（ラジオは同じく出す）',()=>{
  const head=applySequenceCommand(docWithAssets(),{type:'ripple-delete',startFrame:0,endFrame:30});
  const a=setup(head,'music',{trial:trialOf(head,'music','song-long')});
  expect(a.view.getByText('カットした部分を含めて曲の頭から数えるため、途中から再生します')).toBeTruthy();expect(a.view.queryByText('曲の頭から再生します')).toBeNull();
  cleanup();
  const doc=docWithAssets();doc.assets.push({id:'song-8',kind:'media',file:'public/c.m4a',name:'8秒',fingerprint:'f6',streams:[{index:0,kind:'audio',codec:'aac',duration:r(8),sampleRate:48000,channels:2}]});
  const tail=applySequenceCommand(doc,{type:'ripple-delete',startFrame:200,endFrame:300});
  const b=setup(tail,'music',{trial:trialOf(tail,'music','song-8')});
  expect(b.view.getByText('カットを戻すと曲が途中で終わります')).toBeTruthy();expect(b.view.queryByText('曲が途中で終わります')).toBeNull();
  expect(b.view.getByRole('radio',{name:'ループ（既定）'})).toBeTruthy();expect(b.view.getByRole('radio',{name:'無音で終わる（フェードアウトはかかりません）'})).toBeTruthy();
});
it('足りない曲ではラジオを出し、無音の選択肢は silenceAllowed のときだけ',()=>{
  const doc=docWithAssets(),trial=trialOf(doc,'music','song-short');
  const {view,onEndMode}=setup(doc,'music',{trial});
  const loop=view.getByRole('radio',{name:'ループ（既定）'}) as HTMLInputElement;
  expect(loop.checked).toBe(true);
  expect(trial.result.kind==='music'&&trial.result.silenceAllowed).toBe(true);
  fireEvent.click(view.getByRole('radio',{name:'無音で終わる（フェードアウトはかかりません）'}));
  expect(onEndMode).toHaveBeenCalledWith('silence');
  cleanup();
  const noSilence={...trial,result:{...trial.result,silenceAllowed:false}};
  const b=setup(doc,'music',{trial:noSilence});
  expect(b.view.getByRole('radio',{name:'ループ（既定）'})).toBeTruthy();
  expect(b.view.queryByRole('radio',{name:/無音で終わる/})).toBeNull();
});
it('長さが足りる曲ではラジオを出さない',()=>{
  const doc=docWithAssets(),{view}=setup(doc,'music',{trial:trialOf(doc,'music','song-long')});
  expect(view.queryByRole('radio')).toBeNull();expect(view.queryByText('曲が途中で終わります')).toBeNull();
});
it('画像: 縦横比が1%を超えて違うと案内を出す',async()=>{
  const doc=docWithAssets();sizes={'img-a':[1600,900],'img-b':[1000,1000]};
  const {view}=setup(doc,'pic',{trial:trialOf(doc,'pic','img-b')});
  expect(view.getByRole('button',{name:/図A（使用中）/})).toBeTruthy();
  expect(await view.findByText('縦横比が違うため、見える大きさや切り抜きが変わります')).toBeTruthy();
});
it('画像: 差が1%以内、試し中でない、読み込み失敗では案内を出さない',async()=>{
  const doc=docWithAssets();sizes={'img-a':[1600,900],'img-b':[1610,900]};
  const a=setup(doc,'pic',{trial:trialOf(doc,'pic','img-b')});
  await act(async()=>{await Promise.resolve();await Promise.resolve();});
  expect(a.view.queryByText(/縦横比が違う/)).toBeNull();cleanup();
  sizes={'img-a':[1600,900],'img-b':[1000,1000]};
  const b=setup(doc,'pic');await act(async()=>{await Promise.resolve();await Promise.resolve();});
  expect(b.view.queryByText(/縦横比が違う/)).toBeNull();cleanup();
  sizes={'img-a':'error','img-b':[1000,1000]};
  const c=setup(doc,'pic',{trial:trialOf(doc,'pic','img-b')});await act(async()=>{await Promise.resolve();await Promise.resolve();});
  expect(c.view.queryByText(/縦横比が違う/)).toBeNull();
});
it('error は role=alert、候補0件は空の文言',()=>{
  const doc=docWithAssets();doc.assets=doc.assets.filter(a=>a.id!=='img-b'&&a.id!=='img-a');
  doc.clips=doc.clips.filter(c=>c.id!=='pic');doc.clips.push({id:'pic',name:'図',trackId:'v3',startFrame:30,durationFrames:60,clock:{offset:r(0),rate:r(1),duration:r(60)},content:{kind:'image',assetId:'gone',style:'plain'}});
  const {view}=setup(doc,'pic',{error:{clipId:'pic',message:'失敗しました'}});
  expect(view.getByRole('alert').textContent).toBe('失敗しました');
  expect(view.getByText('画像がありません。「素材を追加」で読み込みます。')).toBeTruthy();
});
it('理由は、そのクリップの使用箇所で出たものだけ出す（BGM の理由を画像の節に出さない）',()=>{
  const doc=docWithAssets(),music=doc.clips.find(c=>c.id==='music')!;
  music.durationFrames=150;music.clock.duration=r(150);music.continuationGroupId='g';
  doc.clips.push({...structuredClone(music),id:'music-2',startFrame:200,durationFrames:100,clock:{offset:r(0),rate:r(1),duration:r(100)},content:{...structuredClone(music.content),sourceIn:r(5)} as never});
  const error={clipId:'music',message:'このクリップは速度の設定があるため、まだ差し替えを試せません'};
  const pic=setup(doc,'pic',{error});
  expect(pic.view.queryByRole('alert')).toBeNull();expect(pic.view.queryByText(error.message)).toBeNull();cleanup();
  for(const id of ['music','music-2']){const v=setup(doc,id,{error});expect(v.view.getByRole('alert').textContent).toBe(error.message);cleanup();}
});
it('disabled と採用中は全ボタン・ラジオを無効にする',()=>{
  const doc=docWithAssets(),trial=trialOf(doc,'music','song-short');
  for(const over of [{trial,disabled:true},{trial:{...trial,adopting:true},disabled:false}]){
    const {view}=setup(doc,'music',over);
    for(const el of [...view.getAllByRole('button'),...view.getAllByRole('radio')])expect((el as HTMLInputElement).disabled).toBe(true);
    cleanup();
  }
});
it('音声でも画像でもないクリップでは何も描かない',()=>{
  const doc=docWithAssets(),{view}=setup(doc,'nope');
  expect(view.container.innerHTML).toBe('');
});

const inspect=(doc:SequenceDocument,selected:string,trialSwap?:Parameters<typeof NativeInspector>[0]['trialSwap'])=>render(<NativeInspector projectId="p" document={doc} readDocument={()=>doc} frame={0} onSeek={()=>{}} selected={[selected]} disabled={false}
  bypassLut={false} onBypass={()=>{}} onCommand={async()=>true} onUploadLut={()=>{}} onPrepareTextStyles={async()=>true} trialSwap={trialSwap}/>);
it('NativeInspector: 複数選択に使用箇所の外のクリップがあれば節を出さず、同じ使用箇所の複数片なら出す',()=>{
  const doc=docWithAssets(),music=doc.clips.find(c=>c.id==='music')!;
  music.durationFrames=150;music.clock.duration=r(150);music.continuationGroupId='g';
  doc.clips.push({...structuredClone(music),id:'music-2',startFrame:200,durationFrames:100,clock:{offset:r(0),rate:r(1),duration:r(100)},content:{...structuredClone(music.content),sourceIn:r(5)} as never});
  const controls={trial:null,error:null,disabled:false,onStart:vi.fn(),onChoose:vi.fn(),onEndMode:vi.fn()};
  const show=(selected:string[])=>{const view=render(<NativeInspector projectId="p" document={doc} readDocument={()=>doc} frame={0} onSeek={()=>{}} selected={selected} disabled={false}
    bypassLut={false} onBypass={()=>{}} onCommand={async()=>true} onUploadLut={()=>{}} onPrepareTextStyles={async()=>true} trialSwap={controls}/>);
    const shown=!!view.queryByRole('heading',{name:'素材を試す'});view.unmount();return shown;};
  expect(show(['pic','music'])).toBe(false);expect(show(['music','pic'])).toBe(false);expect(show(['pic','video'])).toBe(false);
  expect(show(['music','music-2'])).toBe(true);expect(show(['music-2','music'])).toBe(true);
});
it('NativeInspector: 画像と BGM のクリップで、trialSwap があるときだけ節を描く',()=>{
  const doc=docWithAssets(),controls={trial:null,error:null,disabled:false,onStart:vi.fn(),onChoose:vi.fn(),onEndMode:vi.fn()};
  for(const id of ['pic','music']){
    const on=inspect(doc,id,controls);expect(on.queryByRole('heading',{name:'素材を試す'})).toBeTruthy();on.unmount();
    const off=inspect(doc,id);expect(off.queryByRole('heading',{name:'素材を試す'})).toBeNull();off.unmount();
  }
  const other=doc.clips.find(c=>c.content.kind==='video')!;
  const v=inspect(doc,other.id,controls);expect(v.queryByRole('heading',{name:'素材を試す'})).toBeNull();
});
it('NativeInspector: 試し中で設定欄が無効でも、節は fieldset の外にあって候補とラジオを押せる',()=>{
  const doc=docWithAssets();
  for(const [id,assetId,field] of [['pic','img-b','横位置（%）'],['music','song-short','音量（dB）']] as const){
    const onChoose=vi.fn(),onEndMode=vi.fn(),trial=trialOf(doc,id,assetId);
    const view=render(<NativeInspector projectId="p" document={doc} readDocument={()=>doc} frame={0} onSeek={()=>{}} selected={[id]} disabled={true}
      bypassLut={false} onBypass={()=>{}} onCommand={async()=>true} onUploadLut={()=>{}} onPrepareTextStyles={async()=>true}
      trialSwap={{trial,error:null,disabled:false,onStart:vi.fn(),onChoose,onEndMode}}/>);
    const section=view.getByRole('heading',{name:'素材を試す'}).closest('section')!;
    expect(section.closest('fieldset')).toBeNull();
    const candidates=within(section).getAllByRole('button').filter(button=>!button.textContent!.includes('（使用中）'));
    expect(candidates.length).toBeGreaterThan(0);
    for(const button of candidates)expect((button as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(candidates[0]!);expect(onChoose).toHaveBeenCalledTimes(1);
    if(id==='music'){
      const radios=within(section).getAllByRole('radio') as HTMLInputElement[];
      expect(radios).toHaveLength(2);for(const radio of radios)expect(radio.disabled).toBe(false);
      fireEvent.click(radios[1]!);expect(onEndMode).toHaveBeenCalledWith('silence');
    }
    // 節の外（クリップ設定の fieldset）は止まっている。
    expect(view.getAllByLabelText(field)[0]!.closest('fieldset')!.disabled).toBe(true);
    cleanup();
  }
});
it('同じ使用箇所の別のクリップ（カットで分かれた2片目）でも試し中として扱い、候補は切替（onChoose）になる',()=>{
  const doc=docWithAssets(),music=doc.clips.find(c=>c.id==='music')!;
  music.durationFrames=150;music.clock.duration=r(150);music.continuationGroupId='g';
  doc.clips.push({...structuredClone(music),id:'music-2',startFrame:200,durationFrames:100,clock:{offset:r(0),rate:r(1),duration:r(100)},content:{...structuredClone(music.content),sourceIn:r(5)} as never});
  const trial=trialOf(doc,'music','song-short');
  expect(trial.result.clipIds).toContain('music-2');
  const {view,onStart,onChoose}=setup(doc,'music-2',{trial});
  expect(view.getByRole('button',{name:/^短い/}).getAttribute('aria-pressed')).toBe('true');
  expect(view.getAllByRole('radio').length).toBeGreaterThan(0); // 試し中の案内・選択肢も出る
  fireEvent.click(view.getByRole('button',{name:/^短い/}));
  expect(onChoose).toHaveBeenCalledWith('song-short');expect(onStart).not.toHaveBeenCalled();
});

/** 仕上げの絞り込み（native-polish.css）。fieldset の外に出した節が、対象外の絞り込みで見えないこと。 */
it('仕上げの絞り込み: 画像の節は「すべて」と「動き・配置」、BGM の節は「すべて」と「音声」でだけ見える',()=>{
  const css=readFileSync(join(__dirname,'native-polish.css'),'utf8').split('\n')
    .filter(line=>line.startsWith('.native-right-dock')&&line.includes('.native-inspector')&&!line.includes(':has('));
  const style=document.createElement('style');style.textContent=css.join('\n');document.head.append(style);
  try{
    const doc=docWithAssets();
    const visible:Record<string,string[]>={};
    for(const tool of ['all','captions','color','audio','layout','fades']){
      visible[tool]=[];
      for(const [id,kind] of [['pic','image'],['music','music']] as const){
        const view=render(<section className="native-right-dock" data-finish-tool={tool}><aside className="native-inspector">
          <NativeTrialSwapSection document={doc} clipId={id} projectId="p" trial={null} error={null} disabled={false} onStart={vi.fn()} onChoose={vi.fn()} onEndMode={vi.fn()}/></aside></section>);
        const section=view.container.querySelector('section[data-setting=trial-swap]')!;
        expect(section).toBeTruthy(); // 存在検査
        if(getComputedStyle(section).display!=='none')visible[tool]!.push(kind);
        view.unmount();
      }
    }
    expect(visible).toEqual({all:['image','music'],captions:[],color:[],audio:['music'],layout:['image'],fades:[]});
  }finally{style.remove();}
});
