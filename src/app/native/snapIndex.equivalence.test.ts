// src/app/native/snapIndex.equivalence.test.ts
import {describe,expect,it,vi} from 'vitest';
import {sourceTimeAt,type SequenceAsset,type SequenceClip,type SequenceDocument} from '../../core/sequence/model';
import * as time from '../../core/sequence/time';
import {applySequenceCommand} from '../../core/sequence/commands';
import {fixture} from '../../core/sequence/fixtures';
import {buildAppendToMain} from '../../core/sequence/mainAppend';
import {buildSnapIndex} from './snapIndex';
import {buildSnapIndexReference} from './snapIndex.reference';

const r=time.rational;
/** 例外も結果のうち（投げる・投げないは一致。文言の一致は保存時の検査を通る文書に限る）。 */
const outcome=(fn:()=>unknown)=>{try{return {value:fn()};}catch(error){const e=error as Error&{code?:string};return {error:`${e.name}:${e.code}:${e.message}`};}};
const same=(doc:SequenceDocument,playhead:number|null=null,exclude:string[]=[])=>expect(outcome(()=>buildSnapIndex(doc,playhead,exclude))).toStrictEqual(outcome(()=>buildSnapIndexReference(doc,playhead,exclude)));
const words=(doc:SequenceDocument)=>buildSnapIndexReference(doc,null,[]).filter(t=>t.kind==='word').length;
/** mulberry32。32 ビット整数の演算だけで回すので、種ごとに別の列になる（浮動小数の掛け算は 2^53 を超えて下位の桁が落ち、種が同じ周期に合流する）。 */
function random(seed:number){let s=seed>>>0;return()=>{s=(s+0x6d2b79f5)>>>0;let t=s;t=Math.imul(t^(t>>>15),t|1);t^=t+Math.imul(t^(t>>>7),t|61);return((t^(t>>>14))>>>0)/4294967296;};}
/** 同じ素材を速度違い・サンプル単位の入り口で何度も使う。語の時刻はミリ秒と 1/48000 秒。映像の使用箇所にも語を当てる。 */
function synthetic(seed:number,fps:time.Rational):SequenceDocument{
  const next=random(seed),doc=fixture(),audio=doc.clips.find(c=>c.id==='audio')!,video=doc.clips.find(c=>c.id==='video')!;
  doc.fps=fps;doc.sequenceEndFrame=40000;doc.clips=doc.clips.filter(c=>c.id==='music');
  let at=0;
  for(let i=0;i<80;i++){
    const rate=[r(1),r(2),r(1,2),r(3,2),r(1001,1000)][Math.floor(next()*5)]!,duration=20+Math.floor(next()*400),sourceIn=r(Math.floor(next()*48000*100),48000);
    doc.clips.push({...structuredClone(audio),id:`speech-${i}`,name:`話し${i}`,linkGroupId:undefined,startFrame:at,durationFrames:duration,clock:{offset:r(0),rate:r(1),duration:r(duration)},
      content:{...structuredClone(audio.content),sourceIn,rate} as SequenceClip['content']});
    if(next()<.3)doc.clips.push({...structuredClone(video),id:`video-${i}`,name:`映像${i}`,linkGroupId:undefined,startFrame:at,durationFrames:duration,clock:{offset:r(0),rate:r(1),duration:r(duration)},
      content:{kind:'video',assetId:'source',streamIndex:0,sourceIn,rate}});
    at+=duration+Math.floor(next()*20);
  }
  const words=(den:number)=>{const list=[];let t=0;for(let i=0;i<1500;i++){const start=t+Math.floor(next()*den/2),end=start+Math.floor(den/20)+Math.floor(next()*den*.7);
    list.push({id:`w${den}-${i}`,text:`語${i}`,start:r(start,den),end:r(end,den)});t=end;}return list;};
  doc.transcripts=[{assetId:'source',streamIndex:1,words:words(1000)},{assetId:'source',streamIndex:0,words:words(48000)}];
  return doc;
}
const media=(id:string,fps:[number,number],seconds:number):SequenceAsset=>({id,kind:'media',file:`.harness/assets/${id}.mp4`,name:`${id}.mp4`,fingerprint:id.padEnd(64,'0'),streams:[
  {index:0,kind:'video',codec:'h264',duration:r(seconds),frameRate:r(...fps),width:320,height:180},
  {index:1,kind:'audio',codec:'aac',duration:r(seconds),sampleRate:48000,channels:2}]});
/** Whisper の語（1/25・1/50・1/1000 秒刻み）を素材の長さいっぱいに並べる。 */
function whisper(next:()=>number,assetId:string,seconds:number){
  const list=[];let t=0;for(let i=0;t<seconds+2;i++){const den=[25,50,1000][i%3]!,start=Math.ceil(t*den)+Math.floor(next()*den/3),end=start+1+Math.floor(next()*den*.6);
    list.push({id:`${assetId}-w${i}`,text:`${assetId}語${i}`,start:r(start,den),end:r(end,den)});t=end/den+(next()<.15?.5:0);}
  return {assetId,streamIndex:1,words:list};
}
/** 複数素材のメイン（メインに追加）→カット（保管庫）・分割を重ね、同じ素材を別トラックで速度を変えて使い直す。 */
function multiSource(seed:number):SequenceDocument{
  const next=random(seed),assets=[media('clipA',[30000,1001],40),media('clipB',[60,1],25),media('clipC',[25,1],30)];
  const empty:SequenceDocument={...fixture(),assets:[],clips:[],transcripts:[],transitions:[],sequenceEndFrame:0,
    tracks:[{id:'v-main',kind:'visual',name:'映像1',enabled:true},{id:'a-main',kind:'audio',name:'原音1',enabled:true}],main:{videoTrackId:'v-main',audioTrackId:'a-main'}};
  let n=0;const plan=buildAppendToMain(empty,assets,()=>`m${seed}-${++n}`);if('error' in plan)throw new Error(plan.error);
  let doc=applySequenceCommand(empty,plan.command);
  for(let i=0;i<6;i++){const start=Math.floor(next()*(doc.sequenceEndFrame-60)),end=start+5+Math.floor(next()*50);doc=applySequenceCommand(doc,{type:'ripple-delete',startFrame:start,endFrame:end});}
  for(let i=0;i<4;i++){const frame=1+Math.floor(next()*(doc.sequenceEndFrame-2)),ids=doc.clips.filter(c=>c.startFrame<frame&&frame<c.startFrame+c.durationFrames).map(c=>c.id);
    if(ids.length)doc=applySequenceCommand(doc,{type:'split',clipIds:ids,frame});}
  const reused=doc.clips.filter(c=>c.content.kind==='audio').slice(0,3);
  doc.tracks.push({id:'a-extra',kind:'audio',name:'原音2',enabled:true});
  let at=doc.sequenceEndFrame;for(const [i,clip] of reused.entries()){const rate=[r(1001,1000),r(3,2),r(1,2)][i]!;
    doc.clips.push({...structuredClone(clip),id:`reuse-${i}`,trackId:'a-extra',linkGroupId:undefined,startFrame:at,content:{...structuredClone(clip.content),rate} as SequenceClip['content']});at+=clip.durationFrames+7;}
  doc.transcripts=assets.map(a=>whisper(next,a.id,40));
  return doc;
}
/** fps 1・速度 1 の話し1本（素材 0 秒から）。語の時刻がそのままコマ数になる。 */
function longSpeech(durationFrames:number,content:Partial<Extract<SequenceClip['content'],{kind:'audio'}>>={}):SequenceDocument{
  const doc=fixture(),audio=doc.clips.find(c=>c.id==='audio')!;doc.fps=r(1);
  doc.clips=[{...audio,durationFrames,clock:{offset:r(0),rate:r(1),duration:r(durationFrames)},content:{...audio.content,...content} as SequenceClip['content']}];
  return doc;
}
/** 小数部が 0.5 より 1/(2d) だけ下の n/d（m は整数部）。旧実装の浮動小数は 0.5 に丸めて切り上げる。 */
const belowHalf=(m:bigint,d:bigint)=>r(Number(((2n*m+1n)*d-1n)/2n),Number(d));

describe('snap index: the same targets as before (設計 §2-5・§3)',()=>{
  it('gives every seed used here its own sequence (no two share a run of consecutive values)',()=>{
    const owner=new Map<string,number>();
    for(const seed of [1,2,3,4,5,6,11,12,13]){const next=random(seed);let previous=next();
      for(let i=0;i<20000;i++){const value=next(),pair=`${previous},${value}`;expect(owner.get(pair)??seed).toBe(seed);owner.set(pair,seed);previous=value;}}
  });
  it('matches the full scan on the existing test documents',()=>{
    const spoken=fixture();spoken.transcripts.push({assetId:'source',streamIndex:1,words:[{id:'w1',text:'ナイス',start:r(1),end:r(2)},{id:'w2',text:'ショット',start:r(2),end:r(3)},{id:'w3',text:'ですね',start:r(4),end:r(5)}]});
    same(spoken);same(spoken,120,['audio']);same(applySequenceCommand(spoken,{type:'split',clipIds:['video'],frame:150}));
    same(fixture());same({...fixture(),clips:[]});same(spoken,0,spoken.clips.map(c=>c.id));
  });
  it.each([[1,r(30)],[2,r(30000,1001)],[3,r(24000,1001)],[4,r(60)]])('matches the full scan on generated document %i',(seed,fps)=>{
    const doc=synthetic(seed,fps);same(doc);same(doc,1234,['speech-3','video-7']);expect(words(doc)).toBeGreaterThan(300);
  });
  it.each([[11],[12],[13]])('matches on a multi-source main with cuts in the archive, splits and reused uses at other speeds (seed %i)',(seed)=>{
    const doc=multiSource(seed);
    expect(new Set(doc.clips.flatMap(c=>c.content.kind==='audio'?[c.content.assetId]:[])).size).toBe(3);
    expect(doc.cutArchive!.entries.length).toBeGreaterThan(0);expect(doc.clips.some(c=>c.id.startsWith('reuse-'))).toBe(true);
    same(doc);same(doc,77,[doc.clips[0]!.id,'reuse-1']);expect(words(doc)).toBeGreaterThan(300);
  });
  it('matches after cuts and splits on a generated document',()=>{
    // 映像ストリームの文字起こしは検証を通らないので、編集の間だけ外す（索引は検証しない文書も受ける）。
    let doc=synthetic(6,r(30000,1001));const transcripts=doc.transcripts;doc.transcripts=[];for(const stream of doc.assets[0]!.streams)stream.duration=r(1000);
    for(const [start,end] of [[100,140],[2000,2600],[9000,9050]] as const)doc=applySequenceCommand(doc,{type:'ripple-delete',startFrame:start,endFrame:end});
    doc=applySequenceCommand(doc,{type:'split',clipIds:doc.clips.filter(c=>c.startFrame<5000&&5000<c.startFrame+c.durationFrames).map(c=>c.id),frame:5000});
    doc.transcripts=transcripts;expect(doc.cutArchive!.entries.length).toBe(3);expect(words(doc)).toBeGreaterThan(300);same(doc);same(doc,5000,['music']);
  });
  it('keeps the old rounding exactly at half frames',()=>{
    const doc=fixture();doc.clips=doc.clips.filter(c=>c.id!=='telop');
    doc.transcripts.push({assetId:'source',streamIndex:1,words:[{id:'h1',text:'半',start:r(1,60),end:r(3,60)},{id:'h2',text:'端',start:r(5,60),end:r(6007,60000)}]});
    same(doc);expect(buildSnapIndex(doc,null,[]).filter(t=>t.kind==='word').map(t=>t.frame)).toEqual([1,2,3]);
  });
  it('keeps the old float rounding near half frames: inside the 0.5 band and beyond 2^30 frames',()=>{
    // 2^29 コマ台で 0.5 との差 6e-8（帯の内側）、2^33 コマ台で差 8.3e-7（帯の外）。どちらも正確な丸めは切り捨て、旧実装は切り上げる。
    const inBand=belowHalf(2n**29n+12345n,2n**23n+1n),far=belowHalf(2n**33n+7n,600001n),doc=longSpeech(2**34);
    // 語間の計算（2語の差）が旧実装でも桁あふれするので、語は別々の文字起こしに置く。
    doc.transcripts=[{assetId:'source',streamIndex:1,words:[{id:'a',text:'帯',start:inBand,end:time.addTime(inBand,r(1))}]},{assetId:'source',streamIndex:1,words:[{id:'b',text:'遠',start:far,end:time.addTime(far,r(1))}]}];
    expect(buildSnapIndexReference(doc,null,[]).filter(t=>t.kind==='word').map(t=>t.frame)).toEqual([2**29+12346,2**29+12347,2**33+8,2**33+9]);
    same(doc);
  });
  it('matches at the exact ends of a use and just outside them (floats equal, fractions differ)',()=>{
    const doc=fixture();doc.clips=doc.clips.filter(c=>c.id!=='telop');
    const audio=doc.clips.find(c=>c.id==='audio')!;audio.content={...audio.content,sourceIn:r(41,10)} as SequenceClip['content'];audio.durationFrames=247;
    // 素材 4.1〜37/3 秒。すぐ外の時刻は浮動小数では端と同じ値になる（候補には残り、含むかは分数で外す）。
    const justBefore=r(2308094809027416,562949953421321),justAfter=r(6943049425529515,562949953421312),word=(id:string,start:time.Rational,end:time.Rational)=>({id,text:id,start,end});
    expect([time.timeNumber(justBefore),time.timeNumber(justAfter)]).toEqual([4.1,37/3]);expect([time.compareTime(justBefore,r(41,10)),time.compareTime(justAfter,r(37,3))]).toEqual([-1,1]);
    doc.transcripts.push({assetId:'source',streamIndex:1,words:[word('before',r(0),r(1)),word('justBefore',r(1),justBefore),word('atStart',r(41,10),r(5)),
      word('atEnd',r(12),r(37,3)),word('justAfter',justAfter,r(13)),word('after',r(50),r(70))]});
    same(doc);same(doc,247,['video','audio']);
    expect(buildSnapIndex(doc,null,[]).filter(t=>t.kind==='word').map(t=>[t.frame,t.label])).toEqual([[0,'単語「atStart」の始まり'],[27,'単語「atStart」の終わり'],[237,'単語「atEnd」の始まり'],[247,'単語「atEnd」の終わり']]);
  });
  it('throws exactly when the full scan throws (fractions beyond safe integers, speeds that are not positive)',()=>{
    const overflow=fixture(),audio=overflow.clips.find(c=>c.id==='audio')!;audio.content={...audio.content,sourceIn:r(1,999999937)} as SequenceClip['content'];
    overflow.transcripts.push({assetId:'source',streamIndex:1,words:[{id:'o',text:'桁',start:r(2,999999929),end:r(1)}]});
    expect(()=>buildSnapIndexReference(overflow,null,[])).toThrow('時刻の精度を保てる範囲を超えています');same(overflow);
    const stopped=longSpeech(10,{rate:{num:0,den:1}}),backwards=longSpeech(0,{rate:{num:-1,den:1}});
    for(const doc of [stopped,backwards])doc.transcripts=[{assetId:'source',streamIndex:1,words:[{id:'z',text:'零',start:r(0),end:r(0)}]}];
    expect(()=>buildSnapIndexReference(stopped,null,[])).toThrow('時刻の分母は0にできません');same(stopped);
    expect(buildSnapIndexReference(backwards,null,[]).filter(t=>t.kind==='word').map(t=>t.frame)).toEqual([0]);same(backwards);
    // 語の無いストリーム（ここでは映像）の使用箇所は旧実装が時刻を計算しないので、計算すると桁あふれする使用箇所があっても投げない。
    const untouched=fixture(),video=untouched.clips.find(c=>c.id==='video')!;video.content={...video.content,sourceIn:r(1,999999937),rate:r(1,999999929)} as SequenceClip['content'];
    untouched.transcripts.push({assetId:'source',streamIndex:1,words:[{id:'u',text:'声',start:r(1),end:r(2)}]});
    expect(()=>sourceTimeAt(video,300,untouched.fps)).toThrow('時刻の精度を保てる範囲を超えています');expect(outcome(()=>buildSnapIndex(untouched,null,[]))).toHaveProperty('value');same(untouched);
  });
  it('looks up only the uses that contain each word time (no scan over every clip)',()=>{
    const doc=synthetic(5,r(30)),compare=vi.spyOn(time,'compareTime');
    buildSnapIndex(doc,null,[]);const lookups=doc.transcripts.reduce((n,t)=>n+t.words.length*2,0);
    expect(compare.mock.calls.length).toBeLessThan(lookups*8);compare.mockRestore();
  });
});
