import {describe,expect,it} from 'vitest';
import {fixture} from './fixtures';
import {rational as r} from './time';
import {applySequenceCommand} from './commands';
import {SequenceError} from './errors';
import {SequenceSession} from './session';
import {parseSequence,sequenceContentBytes,serializeSequence,validateSequenceDocument} from './validate';
import {buildTrialSwap,trialArchivedUsage,trialUsage,trialCandidates,trialPreviewId,trialSelectable} from './trialSwap';
import {clipEnd,type SequenceClip,type SequenceDocument} from './model';

// 速度つきクリップの実データ形は、既存の登録コマンドを実際に通して得る（手書きの空オブジェクトは使わない）。
function nativeSpeedDocument(withMusic=false){
  const d:SequenceDocument={schemaVersion:2,id:'sp',name:'sp',revision:0,fps:r(1),resolution:{width:640,height:360},sequenceEndFrame:4,background:'#000',ducking:{enabled:false,strength:'mid'},transcripts:[],transitions:[],
    assets:[{id:'asset',kind:'media',file:'media/test.mp4',name:'test',fingerprint:'private',streams:[{index:0,kind:'video',codec:'h264',duration:r(100),width:640,height:360,frameRate:r(1)},{index:1,kind:'audio',codec:'aac',duration:r(100),sampleRate:48000,channels:2}]}],
    tracks:[{id:'v',kind:'visual',name:'v',enabled:true},{id:'a',kind:'audio',name:'a',enabled:true}],
    clips:[{id:'video',trackId:'v',name:'video',startFrame:0,durationFrames:4,linkGroupId:'linked',clock:{offset:r(-1),rate:r(1),duration:r(20)},content:{kind:'video',assetId:'asset',streamIndex:0,sourceIn:r(0),rate:r(2)}},
      {id:'audio',trackId:'a',name:'audio',startFrame:0,durationFrames:4,linkGroupId:'linked',clock:{offset:r(-3),rate:r(3),duration:r(40)},content:{kind:'audio',assetId:'asset',streamIndex:1,sourceIn:r(0),rate:r(2),role:'speech',loop:false,settings:{gainDb:0,muted:false,fadeInFrames:0,fadeOutFrames:0}}}]};
  if(withMusic){ // 速度登録のある文書に、速度の無い BGM を1本置く
    d.assets.push({id:'song',kind:'media',file:'public/a.m4a',name:'曲',fingerprint:'s1',streams:[{index:0,kind:'audio',codec:'aac',duration:r(60),sampleRate:48000,channels:2}]},
      {id:'song2',kind:'media',file:'public/b.m4a',name:'曲2',fingerprint:'s2',streams:[{index:0,kind:'audio',codec:'aac',duration:r(60),sampleRate:48000,channels:2}]});
    d.tracks.push({id:'m',kind:'audio',name:'m',enabled:true});
    d.clips.push({id:'music',trackId:'m',name:'曲',startFrame:0,durationFrames:4,clock:{offset:r(0),rate:r(1),duration:r(4)},content:{kind:'audio',assetId:'song',streamIndex:0,sourceIn:r(0),rate:r(1),role:'music',loop:false,settings:{gainDb:-12,muted:false,fadeInFrames:0,fadeOutFrames:0}}});
  }
  return applySequenceCommand(applySequenceCommand(d,{type:'register-native-speed',groupId:'group',mainClipIds:['video'],mainAudioBindings:[{audioClipId:'audio',providerId:'video'}]}),{type:'upgrade-native-speed'});
}
/** 速度登録（主映像と原音）のある長い文書に、速度の無い BGM を1本置く（レビューの計測と同じ形）。 */
function speedMusicDocument(frames:number){
  const clock=(n:number)=>({offset:r(0),rate:r(1),duration:r(n)});
  const d:SequenceDocument={schemaVersion:2,id:'sp',name:'sp',revision:0,fps:r(30),resolution:{width:640,height:360},sequenceEndFrame:frames,background:'#000',ducking:{enabled:false,strength:'mid'},transcripts:[],transitions:[],
    assets:[{id:'asset',kind:'media',file:'media/test.mp4',name:'test',fingerprint:'private',streams:[{index:0,kind:'video',codec:'h264',duration:r(1000),width:640,height:360,frameRate:r(30)},{index:1,kind:'audio',codec:'aac',duration:r(1000),sampleRate:48000,channels:2}]},
      {id:'song',kind:'media',file:'public/a.m4a',name:'曲',fingerprint:'s1',streams:[{index:0,kind:'audio',codec:'aac',duration:r(600),sampleRate:48000,channels:2}]},
      {id:'song2',kind:'media',file:'public/b.m4a',name:'曲2',fingerprint:'s2',streams:[{index:0,kind:'audio',codec:'aac',duration:r(600),sampleRate:48000,channels:2}]}],
    tracks:[{id:'v',kind:'visual',name:'v',enabled:true},{id:'a',kind:'audio',name:'a',enabled:true},{id:'m',kind:'audio',name:'m',enabled:true}],
    clips:[{id:'video',trackId:'v',name:'video',startFrame:0,durationFrames:frames,linkGroupId:'linked',clock:clock(frames),content:{kind:'video',assetId:'asset',streamIndex:0,sourceIn:r(0),rate:r(1)}},
      {id:'audio',trackId:'a',name:'audio',startFrame:0,durationFrames:frames,linkGroupId:'linked',clock:clock(frames),content:{kind:'audio',assetId:'asset',streamIndex:1,sourceIn:r(0),rate:r(1),role:'speech',loop:false,settings:{gainDb:0,muted:false,fadeInFrames:0,fadeOutFrames:0}}},
      {id:'music',trackId:'m',name:'曲',startFrame:0,durationFrames:frames,clock:clock(frames),content:{kind:'audio',assetId:'song',streamIndex:0,sourceIn:r(0),rate:r(1),role:'music',loop:false,settings:{gainDb:-12,muted:false,fadeInFrames:0,fadeOutFrames:0}}}]};
  return applySequenceCommand(applySequenceCommand(d,{type:'register-native-speed',groupId:'group',mainClipIds:['video'],mainAudioBindings:[{audioClipId:'audio',providerId:'video'}]}),{type:'upgrade-native-speed'});
}
/** buildTrialSwap が作る採用の command（swap-usage-content）。 */
function swapOf(doc:SequenceDocument,clipId:string,assetId:string){
  const result=buildTrialSwap(doc,{clipId,assetId,endMode:'loop',generation:1});if(!result.ok)throw new Error(result.reason);
  if(result.command.type!=='swap-usage-content')throw new Error('shape');return result.command;
}
function nativeSpeed(){
  const speed=nativeSpeedDocument().clips.find(c=>c.id==='video')!.speed;expect(speed).toBeTruthy();return {speed};
}
function ownSpeed(){
  const d:SequenceDocument={schemaVersion:2,id:'own',name:'own',revision:0,fps:r(1),resolution:{width:320,height:180},sequenceEndFrame:10,background:'#000',ducking:{enabled:false,strength:'mid'},transcripts:[],transitions:[],
    assets:[{id:'asset',kind:'media',name:'素材',file:'media/test.mp4',fingerprint:'private',streams:[{index:0,kind:'video',codec:'h264',duration:r(100),frameRate:r(30),width:320,height:180},{index:1,kind:'audio',codec:'aac',duration:r(100),sampleRate:48000,channels:2}]}],
    tracks:[{id:'v',kind:'visual',name:'映像',enabled:true},{id:'a',kind:'audio',name:'原音',enabled:true}],
    clips:[{id:'iv',trackId:'v',name:'挿入映像',startFrame:5,durationFrames:5,linkGroupId:'pair',clock:{offset:r(-2),rate:r(2),duration:r(40)},content:{kind:'video',assetId:'asset',streamIndex:0,sourceIn:r(10),rate:r(5)}},
      {id:'ia',trackId:'a',name:'挿入原音',startFrame:5,durationFrames:5,linkGroupId:'pair',clock:{offset:r(-3),rate:r(3),duration:r(50)},content:{kind:'audio',assetId:'asset',streamIndex:1,sourceIn:r(10),rate:r(5),role:'speech',loop:false,settings:{gainDb:-2,muted:false,fadeInFrames:3,fadeOutFrames:4}}}]};
  const reg=applySequenceCommand(d,{type:'register-native-insert-own-speed',clipId:'iv',linked:true});
  const insertOwnSpeed=reg.clips.find(c=>c.id==='ia')!.insertOwnSpeed;expect(insertOwnSpeed).toBeTruthy();return {insertOwnSpeed};
}

function withAssets(doc=fixture()):SequenceDocument{
  doc.assets.push(
    {id:'song-long',kind:'media',file:'public/a.m4a',name:'軽快',fingerprint:'f1',streams:[{index:0,kind:'audio',codec:'aac',duration:r(60),sampleRate:48000,channels:2}]},
    {id:'song-short',kind:'media',file:'public/b.m4a',name:'短い',fingerprint:'f2',streams:[{index:2,kind:'audio',codec:'aac',duration:r(5),sampleRate:48000,channels:2},{index:1,kind:'audio',codec:'aac',duration:r(5),sampleRate:48000,channels:2}]},
    {id:'img-a',kind:'image',file:'public/a.png',name:'図A',fingerprint:'f3',streams:[]},
    {id:'img-b',kind:'image',file:'public/b.png',name:'図B',fingerprint:'f4',streams:[]},
  );
  doc.tracks.push({id:'v3',kind:'visual',name:'挿入',enabled:true});
  doc.clips.push({id:'pic',name:'図',trackId:'v3',startFrame:30,durationFrames:60,clock:{offset:r(0),rate:r(1),duration:r(60)},
    content:{kind:'image',assetId:'img-a',style:'plain'},
    visual:{layout:{position:{x:.2,y:-.1},scale:.5,rotation:3,flipH:false,flipV:false,background:'transparent'},opacity:.9,keyframes:[]}});
  // fixture の music は 360 フレームで終端を越える。検証に通る長さへ揃える。
  const music=doc.clips.find(c=>c.id==='music')!;music.durationFrames=300;music.clock.duration=r(300);
  validateSequenceDocument(doc);
  return doc;
}

describe('trialUsage',()=>{
  it('同じトラック・同じ素材・同じ続き番号のクリップをまとめる',()=>{
    const doc=applySequenceCommand(withAssets(),{type:'split',clipIds:['music'],frame:150});
    const usage=trialUsage(doc,'music');
    expect(usage.map(c=>c.startFrame)).toEqual([0,150]);
  });
});

describe('trialSelectable',()=>{
  // 節の表示・開始の受付・試しの継続を、この1つで決める（設計 §3-1・§3-9）。
  it('1件以上で、すべてが先頭のクリップと同じ使用箇所にあるときだけ true',()=>{
    const doc=applySequenceCommand(withAssets(),{type:'split',clipIds:['music'],frame:150}),second=trialUsage(doc,'music')[1]!.id;
    expect(trialSelectable(doc,['pic'])).toBe(true);expect(trialSelectable(doc,['music',second])).toBe(true);expect(trialSelectable(doc,[second,'music'])).toBe(true);
    expect(trialSelectable(doc,['pic','music'])).toBe(false);expect(trialSelectable(doc,['music','video'])).toBe(false);
    expect(trialSelectable(doc,['video'])).toBe(false);expect(trialSelectable(doc,['gone'])).toBe(false);
  });
  it('空の選択は、試し中の継続（使用箇所を渡したとき）だけ許す',()=>{
    const doc=withAssets();
    expect(trialSelectable(doc,[])).toBe(false);expect(trialSelectable(doc,[],['pic'])).toBe(true);
  });
  it('試し中の継続は、その試しの使用箇所の中だけ',()=>{
    const doc=withAssets();
    expect(trialSelectable(doc,['pic'],['pic'])).toBe(true);expect(trialSelectable(doc,['music'],['pic'])).toBe(false);expect(trialSelectable(doc,['pic','music'],['pic'])).toBe(false);
  });
});

describe('trialCandidates',()=>{
  it('画像クリップには画像素材だけ、BGM には映像なしの音声素材だけを返す',()=>{
    const doc=withAssets();
    expect(trialCandidates(doc,'pic').map(a=>a.id)).toEqual(['img-a','img-b']);
    expect(trialCandidates(doc,'music').map(a=>a.id)).toEqual(['song-long','song-short']);
  });
});

describe('buildTrialSwap 画像',()=>{
  it('assetId だけを替え、配置とスタイルを保つ',()=>{
    const doc=withAssets(),before=structuredClone(doc);
    const result=buildTrialSwap(doc,{clipId:'pic',assetId:'img-b',endMode:'loop',generation:1});
    expect(result.ok).toBe(true);if(!result.ok)return;
    const pic=result.preview.clips.find(c=>c.id==='pic')!,old=doc.clips.find(c=>c.id==='pic')!;
    expect(pic.content).toEqual({...old.content,assetId:'img-b'});
    expect(pic.visual).toEqual(old.visual);
    expect(result.preview.id).toBe(trialPreviewId(doc.id,1));
    expect(doc).toEqual(before);
  });
  it('command を applySequenceCommand に通した結果が preview と一致する（id を除く）',()=>{
    const doc=withAssets(),result=buildTrialSwap(doc,{clipId:'pic',assetId:'img-b',endMode:'loop',generation:2});
    if(!result.ok)throw new Error(result.reason);
    expect({...applySequenceCommand(doc,result.command),id:result.preview.id}).toEqual(result.preview);
  });
});

describe('buildTrialSwap クリップ名',()=>{
  it('画像: 名前が元の素材名のままなら候補の素材名に替え、利用者が変えた名前は保つ',()=>{
    const doc=withAssets();doc.clips.find(c=>c.id==='pic')!.name='図A';
    const renamed=buildTrialSwap(doc,{clipId:'pic',assetId:'img-b',endMode:'loop',generation:1});if(!renamed.ok)throw new Error(renamed.reason);
    expect(renamed.preview.clips.find(c=>c.id==='pic')!.name).toBe('図B');
    expect(renamed.command).toMatchObject({type:'swap-usage-content',live:[{clipId:'pic',patch:{name:'図B'}}],archived:[]});
    expect({...applySequenceCommand(doc,renamed.command),id:renamed.preview.id}).toEqual(renamed.preview);
    const kept=buildTrialSwap(withAssets(),{clipId:'pic',assetId:'img-b',endMode:'loop',generation:1});if(!kept.ok)throw new Error(kept.reason);
    expect(kept.preview.clips.find(c=>c.id==='pic')!.name).toBe('図');
    expect(kept.command.type==='swap-usage-content'&&kept.command.live.every(c=>!('name' in c.patch))).toBe(true);
  });
  it('BGM: 使用箇所が複数クリップなら、クリップごとに元の素材名のままかを判定する',()=>{
    const split=applySequenceCommand(withAssets(),{type:'split',clipIds:['music'],frame:150});
    const [first,second]=trialUsage(split,'music');expect(second).toBeTruthy();
    split.clips.find(c=>c.id===first!.id)!.name='映像'; // 元の素材（source）の名前のまま
    split.clips.find(c=>c.id===second!.id)!.name='テーマ曲'; // 利用者が付けた名前
    const result=buildTrialSwap(split,{clipId:'music',assetId:'song-long',endMode:'loop',generation:1});if(!result.ok)throw new Error(result.reason);
    expect(result.preview.clips.find(c=>c.id===first!.id)!.name).toBe('軽快');
    expect(result.preview.clips.find(c=>c.id===second!.id)!.name).toBe('テーマ曲');
    expect({...applySequenceCommand(split,result.command),id:result.preview.id}).toEqual(result.preview);
  });
});
describe('buildTrialSwap BGM',()=>{
  it('曲の頭から・最小番号の音声ストリーム・音量とフェードは保つ',()=>{
    const doc=withAssets(),result=buildTrialSwap(doc,{clipId:'music',assetId:'song-long',endMode:'loop',generation:1});
    if(!result.ok)throw new Error(result.reason);
    const c=result.preview.clips.find(x=>x.id==='music')!.content;
    expect(c).toMatchObject({kind:'audio',assetId:'song-long',streamIndex:0,sourceIn:r(0),loop:false,settings:{gainDb:-12,fadeOutFrames:60}});
    expect(result.notes).toContain('from-start');
    expect(result.notes).not.toContain('short');
  });
  it('分割された使用箇所は、元の開始差を保って付け直す',()=>{
    const split=applySequenceCommand(withAssets(),{type:'split',clipIds:['music'],frame:150});
    const result=buildTrialSwap(split,{clipId:'music',assetId:'song-long',endMode:'loop',generation:1});
    if(!result.ok)throw new Error(result.reason);
    const parts=trialUsage(result.preview,'music').map(c=>c.content.kind==='audio'?c.content.sourceIn:null);
    expect(parts).toEqual([r(0),r(5)]);
  });
  it('短い曲は既定でループ。無音を選ぶと loop:false と endBehavior:silence',()=>{
    const doc=withAssets();
    const loop=buildTrialSwap(doc,{clipId:'music',assetId:'song-short',endMode:'loop',generation:1});
    if(!loop.ok)throw new Error(loop.reason);
    expect(loop.notes).toContain('short');
    expect(loop.preview.clips.find(c=>c.id==='music')!.content).toMatchObject({loop:true,streamIndex:1});
    expect(loop.silenceAllowed).toBe(true);
    const silence=buildTrialSwap(doc,{clipId:'music',assetId:'song-short',endMode:'silence',generation:2});
    if(!silence.ok)throw new Error(silence.reason);
    expect(silence.preview.clips.find(c=>c.id==='music')!.content).toMatchObject({loop:false,endBehavior:'silence'});
  });
  it('後半の片が曲の長さを越えて始まるなら、無音は選べず拒否する',()=>{
    const split=applySequenceCommand(withAssets(),{type:'split',clipIds:['music'],frame:180});
    const result=buildTrialSwap(split,{clipId:'music',assetId:'song-short',endMode:'silence',generation:1});
    expect(result).toEqual({ok:false,reason:'この曲の長さでは「無音で終わる」を選べません'});
    const loop=buildTrialSwap(split,{clipId:'music',assetId:'song-short',endMode:'loop',generation:1});
    if(!loop.ok)throw new Error(loop.reason);expect(loop.silenceAllowed).toBe(false);
  });
  it('速度2倍なら実効の長さは半分として判定する',()=>{
    const doc=withAssets(),music=doc.clips.find(c=>c.id==='music')!;
    if(music.content.kind!=='audio')throw new Error('fixture');
    music.content.rate=r(2);music.content.sourceIn=r(0);
    // 300 フレーム＝10 秒 × 2倍＝20 秒必要。song-long(60秒)は足り、20 秒ちょうどの曲は1フレーム足りない扱いにならないこと
    doc.assets.push({id:'song-20',kind:'media',file:'public/c.m4a',name:'20秒',fingerprint:'f5',streams:[{index:0,kind:'audio',codec:'aac',duration:r(20),sampleRate:48000,channels:2}]});
    const exact=buildTrialSwap(doc,{clipId:'music',assetId:'song-20',endMode:'loop',generation:1});
    if(!exact.ok)throw new Error(exact.reason);
    expect(exact.notes.includes('short')).toBe(false);
    expect(exact.notes.includes('rate')).toBe(true);
  });
  it.each([['speed',()=>nativeSpeed()],['insertOwnSpeed',()=>ownSpeed()]])('実データ形の %s つきクリップは速度の理由で拒否する',(_n,make)=>{
    const doc=withAssets(),music=doc.clips.find(c=>c.id==='music')!;
    Object.assign(music,make());
    const result=buildTrialSwap(doc,{clipId:'music',assetId:'song-long',endMode:'loop',generation:1});
    expect(result).toEqual({ok:false,reason:'このクリップは速度の設定があるため、まだ差し替えを試せません'});
  });
  it('速度以外の理由で適用が例外になれば、そのメッセージを reason にする',()=>{
    const doc=withAssets();
    const pic=doc.clips.find(c=>c.id==='pic')!;pic.trackId='no-such-track';
    const req={clipId:'music',assetId:'song-long',endMode:'loop' as const,generation:1};
    const result=buildTrialSwap(doc,req);
    let thrown:unknown;try{applySequenceCommand(doc,{type:'batch',commands:[{type:'update-clip',clipId:'music',patch:{}}]});}catch(e){thrown=e;}
    expect(thrown).toBeInstanceOf(SequenceError);expect((thrown as SequenceError).code).toBe('INVALID_DOCUMENT');
    const expected=(thrown as SequenceError).message;
    expect(result).toEqual({ok:false,reason:expected});
  });
  it('BGM の使用箇所に音声以外が混ざれば throw せず拒否を返す',()=>{
    const doc=withAssets(),music=doc.clips.find(c=>c.id==='music')!;
    if(music.content.kind!=='audio')throw new Error('fixture');
    // 同じトラック・同じ素材・同じ続き番号に、音声でないクリップが混ざった状態
    const odd={id:'odd',name:'混入',trackId:music.trackId,startFrame:400,durationFrames:30,clock:structuredClone(music.clock),continuationGroupId:'g',content:{kind:'video' as const,assetId:music.content.assetId,streamIndex:0,sourceIn:r(0),rate:r(1)}};
    doc.clips.push(odd as never);(music as {continuationGroupId?:string}).continuationGroupId='g';
    const result=buildTrialSwap(doc,{clipId:'music',assetId:'song-long',endMode:'loop',generation:1});
    expect(result).toEqual({ok:false,reason:'BGM の使用箇所に音声以外が混ざっています'});
  });
  it('muted の BGM には muted の案内を付ける',()=>{
    const doc=withAssets(),music=doc.clips.find(c=>c.id==='music')!;
    if(music.content.kind!=='audio')throw new Error('fixture');music.content.settings.muted=true;
    const result=buildTrialSwap(doc,{clipId:'music',assetId:'song-long',endMode:'loop',generation:1});
    if(!result.ok)throw new Error(result.reason);expect(result.notes).toContain('muted');
  });
  it('曲が足りているなら endMode:silence でも元の loop のまま・endBehavior なし',()=>{
    const doc=withAssets(),music=doc.clips.find(c=>c.id==='music')!;
    if(music.content.kind!=='audio')throw new Error('fixture');music.content.loop=true;
    const result=buildTrialSwap(doc,{clipId:'music',assetId:'song-long',endMode:'silence',generation:1});
    expect(result.ok).toBe(true);if(!result.ok)return;
    const c=result.preview.clips.find(x=>x.id==='music')!.content;
    expect(c).toMatchObject({loop:true});expect(c).not.toHaveProperty('endBehavior');
  });
  it('種類違いの素材は拒否する',()=>{
    expect(buildTrialSwap(withAssets(),{clipId:'music',assetId:'img-a',endMode:'loop',generation:1}))
      .toEqual({ok:false,reason:'この素材はこのクリップの候補にできません'});
  });
});

describe('buildTrialSwap カットで退避した部分',()=>{
  const clipsOn=(doc:SequenceDocument,trackId:string)=>doc.clips.filter(c=>c.trackId===trackId).sort((a,b)=>a.startFrame-b.startFrame);
  const restoreAll=(doc:SequenceDocument)=>{let next=doc;for(const entry of [...doc.cutArchive?.entries??[]].reverse())next=applySequenceCommand(next,{type:'restore-cut',entryId:entry.id});expect(next.cutArchive).toBeUndefined();return next;};
  it('BGM: カット → 差し替えて採用 → カットを戻すと、戻した区間も新しい曲（素材・ストリーム・付け直した開始・名前）になる',()=>{
    const doc=withAssets();doc.clips.find(c=>c.id==='music')!.name='映像'; // 元の素材（source）の名前のまま
    const cut=applySequenceCommand(doc,{type:'ripple-delete',startFrame:100,endFrame:130});
    const result=buildTrialSwap(cut,{clipId:'music',assetId:'song-long',endMode:'loop',generation:1});if(!result.ok)throw new Error(result.reason);
    expect(result.clipIds).toEqual(trialUsage(cut,'music').map(c=>c.id)); // 画面が見る使用箇所は live だけ
    expect({...applySequenceCommand(cut,result.command),id:result.preview.id}).toEqual(result.preview);
    const restored=restoreAll(applySequenceCommand(cut,result.command));validateSequenceDocument(restored);
    const music=clipsOn(restored,'a2');expect(music.map(c=>[c.startFrame,clipEnd(c)])).toEqual([[0,100],[100,130],[130,300]]);
    for(const c of music){
      expect(c.name).toBe('軽快');
      // 付け直しの基準は live と退避を合わせた最小の sourceIn。戻した区間も曲の中で途切れずに続く。
      expect(c.content).toMatchObject({kind:'audio',assetId:'song-long',streamIndex:0,sourceIn:r(c.startFrame,30),loop:false,settings:{gainDb:-12,fadeOutFrames:60}});
    }
  });
  it('画像: カット → 差し替えて採用 → カットを戻すと、戻した区間も新しい画像・名前になり、配置は保つ',()=>{
    const doc=withAssets();doc.clips.find(c=>c.id==='pic')!.name='図A';
    const cut=applySequenceCommand(doc,{type:'ripple-delete',startFrame:50,endFrame:70});
    const result=buildTrialSwap(cut,{clipId:'pic',assetId:'img-b',endMode:'loop',generation:1});if(!result.ok)throw new Error(result.reason);
    expect({...applySequenceCommand(cut,result.command),id:result.preview.id}).toEqual(result.preview);
    const restored=restoreAll(applySequenceCommand(cut,result.command));validateSequenceDocument(restored);
    const pics=clipsOn(restored,'v3'),old=doc.clips.find(c=>c.id==='pic')!;
    expect(pics.map(c=>[c.startFrame,clipEnd(c)])).toEqual([[30,50],[50,70],[70,90]]);
    for(const c of pics){expect(c.name).toBe('図B');expect(c.content).toEqual({...old.content,assetId:'img-b'});expect(c.visual).toEqual(old.visual);}
  });
  it('採用は履歴1件。Undo 1回で live と退避（entries を含む文書全体）が、版を除いて開始時に戻る',()=>{
    const cut=applySequenceCommand(applySequenceCommand(withAssets(),{type:'ripple-delete',startFrame:200,endFrame:220}),{type:'ripple-delete',startFrame:100,endFrame:130});
    expect(cut.cutArchive!.entries).toHaveLength(2);
    const result=buildTrialSwap(cut,{clipId:'music',assetId:'song-long',endMode:'loop',generation:1});if(!result.ok)throw new Error(result.reason);
    expect(trialArchivedUsage(cut,'music').map(x=>x.entryId)).toEqual(cut.cutArchive!.entries.map(e=>e.id));
    const session=new SequenceSession('archive-swap',cut),run=(command:Parameters<SequenceSession['execute']>[0]['command'],executionId:string)=>session.execute({sessionId:'archive-swap',expectedRevision:session.document.revision,executionId,command});
    expect(run(result.command,'adopt').changed).toBe(true);
    const adopted=session.document;expect(adopted.cutArchive!.entries.flatMap(e=>e.clips).filter(c=>c.trackId==='a2').map(c=>c.content.kind==='audio'&&c.content.assetId)).toEqual(['song-long','song-long']);
    run({type:'undo'},'undo');
    expect(session.canUndo).toBe(false);expect(sequenceContentBytes(session.document)).toBe(sequenceContentBytes(cut));
    expect(session.document.cutArchive).toEqual(cut.cutArchive);
  });
  it.each([['speed',()=>nativeSpeed()],['insertOwnSpeed',()=>ownSpeed()]])('退避側に実データ形の %s つきクリップがあれば速度の理由で拒否する',(_n,make)=>{
    const cut=applySequenceCommand(withAssets(),{type:'ripple-delete',startFrame:100,endFrame:130});
    Object.assign(trialArchivedUsage(cut,'music')[0]!.clip,make());
    expect(buildTrialSwap(cut,{clipId:'music',assetId:'song-long',endMode:'loop',generation:1})).toEqual({ok:false,reason:'このクリップは速度の設定があるため、まだ差し替えを試せません'});
  });
  it.each([
    ['legacyAudioContinuity',{legacyAudioContinuity:{version:1,sourceFingerprint:'a'.repeat(64),ownerClipId:'music'}}],
    ['legacyCaptionContinuity',{legacyCaptionContinuity:{version:1,sourceFingerprint:'a'.repeat(64),ownerClipId:'music',witnesses:[]}}],
    ['legacyMainRole',{legacyMainRole:{version:1,sourceFingerprint:'a'.repeat(64),kind:'main',witnesses:[]}}],
  ])('退避側に旧形式の記録（%s）があれば理由つきで拒否する',(_n,record)=>{
    const cut=applySequenceCommand(withAssets(),{type:'ripple-delete',startFrame:100,endFrame:130});
    Object.assign(trialArchivedUsage(cut,'music')[0]!.clip,record);
    expect(buildTrialSwap(cut,{clipId:'music',assetId:'song-long',endMode:'loop',generation:1})).toEqual({ok:false,reason:'このクリップは古い形式の記録があるため、まだ差し替えを試せません'});
  });
  it('退避が無い文書・使用箇所の退避が無い文書では、従来とまったく同じ command（退避用の操作が入らない）',()=>{
    const doc=withAssets(),old=doc.clips.find(c=>c.id==='pic')!;
    const expected={type:'swap-usage-content',live:[{clipId:'pic',patch:{content:{...old.content,assetId:'img-b'}}}],archived:[]};
    const plain=buildTrialSwap(doc,{clipId:'pic',assetId:'img-b',endMode:'loop',generation:1});if(!plain.ok)throw new Error(plain.reason);
    expect(doc.cutArchive).toBeUndefined();expect(plain.command).toEqual(expected);
    // 画像（30〜90）に掛からないカット。退避はあるが、この使用箇所の片は無い。
    const cut=applySequenceCommand(doc,{type:'ripple-delete',startFrame:100,endFrame:130});expect(cut.cutArchive!.entries).toHaveLength(1);
    const other=buildTrialSwap(cut,{clipId:'pic',assetId:'img-b',endMode:'loop',generation:1});if(!other.ok)throw new Error(other.reason);
    expect(trialArchivedUsage(cut,'pic')).toEqual([]);expect(other.command).toEqual(expected);
  });
  it('長さの判定は退避側を含める: 退避した区間が曲の長さを越えて始まるなら「無音で終わる」は選べない',()=>{
    // 末尾 200〜300 をカット。live（0〜200＝6.7秒）だけなら 5 秒の曲で「無音」を選べるが、退避側は 6.7 秒から始まる。
    const cut=applySequenceCommand(withAssets(),{type:'ripple-delete',startFrame:200,endFrame:300});
    expect(trialUsage(cut,'music')).toHaveLength(1);expect(trialArchivedUsage(cut,'music')).toHaveLength(1);
    expect(buildTrialSwap(cut,{clipId:'music',assetId:'song-short',endMode:'silence',generation:1})).toEqual({ok:false,reason:'この曲の長さでは「無音で終わる」を選べません'});
    const loop=buildTrialSwap(cut,{clipId:'music',assetId:'song-short',endMode:'loop',generation:1});if(!loop.ok)throw new Error(loop.reason);
    expect(loop.silenceAllowed).toBe(false);
    const restored=applySequenceCommand(applySequenceCommand(cut,loop.command),{type:'restore-cut',entryId:cut.cutArchive!.entries[0]!.id});validateSequenceDocument(restored);
    expect(restored.clips.filter(c=>c.trackId==='a2').map(c=>c.content)).toEqual([expect.objectContaining({assetId:'song-short',loop:true,sourceIn:r(0)}),expect.objectContaining({assetId:'song-short',loop:true,sourceIn:r(20,3)})]);
  });
  it('長さの判定は退避側を含める: live が曲に収まっても、退避側が足りなければ「カットを戻すと曲が途中で終わります」で、退避側もループになる',()=>{
    const doc=withAssets();doc.assets.push({id:'song-8',kind:'media',file:'public/d.m4a',name:'8秒',fingerprint:'f6',streams:[{index:0,kind:'audio',codec:'aac',duration:r(8),sampleRate:48000,channels:2}]});
    const cut=applySequenceCommand(doc,{type:'ripple-delete',startFrame:200,endFrame:300});
    const loop=buildTrialSwap(cut,{clipId:'music',assetId:'song-8',endMode:'loop',generation:1});if(!loop.ok)throw new Error(loop.reason);
    // 表示中の部分は足りているので 'short' ではなく 'short-if-restored'。ラジオの出し方（silenceAllowed）は変えない。
    expect(loop.notes).toContain('short-if-restored');expect(loop.notes).not.toContain('short');expect(loop.silenceAllowed).toBe(true);
    expect(loop.command).toMatchObject({live:[{patch:{content:{loop:true}}}],archived:[{patch:{content:{loop:true,sourceIn:r(20,3)}}}]});
    const silence=buildTrialSwap(cut,{clipId:'music',assetId:'song-8',endMode:'silence',generation:2});if(!silence.ok)throw new Error(silence.reason);
    expect(silence.command).toMatchObject({live:[{patch:{content:{loop:false,endBehavior:'silence'}}}],archived:[{patch:{content:{loop:false,endBehavior:'silence'}}}]});
    // 表示中の部分そのものが足りないときは従来どおり 'short'。
    const short=buildTrialSwap(cut,{clipId:'music',assetId:'song-short',endMode:'loop',generation:3});if(!short.ok)throw new Error(short.reason);
    expect(short.notes).toContain('short');expect(short.notes).not.toContain('short-if-restored');
  });
  it('付け直しの基準は live と退避を合わせた最小の sourceIn（先頭をカットしても、戻せば曲の頭から）',()=>{
    const cut=applySequenceCommand(withAssets(),{type:'ripple-delete',startFrame:0,endFrame:30});
    const result=buildTrialSwap(cut,{clipId:'music',assetId:'song-long',endMode:'loop',generation:1});if(!result.ok)throw new Error(result.reason);
    expect(result.preview.clips.find(c=>c.id==='music')!.content).toMatchObject({sourceIn:r(1)});
    expect(trialArchivedUsage(result.preview,'music')[0]!.clip.content).toMatchObject({assetId:'song-long',sourceIn:r(0)});
    // 表示中の先頭のクリップが曲の途中から始まるので、'from-start' ではなく 'from-cut-head'。
    expect(result.notes).toContain('from-cut-head');expect(result.notes).not.toContain('from-start');
    const middle=buildTrialSwap(applySequenceCommand(withAssets(),{type:'ripple-delete',startFrame:100,endFrame:130}),{clipId:'music',assetId:'song-long',endMode:'loop',generation:1});
    if(!middle.ok)throw new Error(middle.reason);expect(middle.notes).toContain('from-start');expect(middle.notes).not.toContain('from-cut-head');
  });
  it('30 回カットして 60 片以上に分かれた BGM でも、採用は使用箇所全体の1操作で、Undo 1回で全部戻る',()=>{
    let cut=withAssets();
    for(let k=29;k>=0;k--)cut=applySequenceCommand(cut,{type:'ripple-delete',startFrame:10*k+3,endFrame:10*k+5});
    const live=trialUsage(cut,'music'),archived=trialArchivedUsage(cut,'music');
    expect(live).toHaveLength(31);expect(archived).toHaveLength(30);
    const result=buildTrialSwap(cut,{clipId:'music',assetId:'song-long',endMode:'loop',generation:1});if(!result.ok)throw new Error(result.reason);
    expect(result.command.type).toBe('swap-usage-content');
    if(result.command.type!=='swap-usage-content')throw new Error('shape');
    expect(result.command.live.map(x=>x.clipId)).toEqual(live.map(c=>c.id));expect(result.command.archived.map(x=>[x.entryId,x.clipId])).toEqual(archived.map(x=>[x.entryId,x.clip.id]));
    expect({...applySequenceCommand(cut,result.command),id:result.preview.id}).toEqual(result.preview);
    const session=new SequenceSession('many',cut),run=(command:Parameters<SequenceSession['execute']>[0]['command'],executionId:string)=>session.execute({sessionId:'many',expectedRevision:session.document.revision,executionId,command});
    expect(run(result.command,'adopt').changed).toBe(true);
    const adopted=session.document,assets=[...trialUsage(adopted,'music').map(c=>c.content),...trialArchivedUsage(adopted,'music').map(x=>x.clip.content)].map(c=>c.kind==='audio'&&c.assetId);
    expect(assets).toHaveLength(61);expect(new Set(assets)).toEqual(new Set(['song-long']));
    run({type:'undo'},'undo');expect(session.canUndo).toBe(false);expect(sequenceContentBytes(session.document)).toBe(sequenceContentBytes(cut));
  });
  it('使用箇所が live と退避の合計 5,000 片を超えると、試しを始める前に断る（5,000 片ちょうどは試せる）',()=>{
    const pieces=(live:number,archived:number)=>{
      const doc=withAssets(),music=doc.clips.find(c=>c.id==='music')!,track=doc.tracks.find(t=>t.id==='a2')!;
      if(music.content.kind!=='audio')throw new Error('fixture');
      const piece=(id:string,start:number)=>({...structuredClone(music),id,startFrame:start,durationFrames:1,continuationGroupId:'music',clock:{offset:r(0),rate:r(1),duration:r(1)}});
      doc.clips=[...doc.clips.filter(c=>c.id!=='music'),piece('music',0),...Array.from({length:live-1},(_,i)=>piece(`m${i+1}`,i+1))];
      doc.sequenceEndFrame=Math.max(doc.sequenceEndFrame,live);
      doc.cutArchive={version:1,entries:Array.from({length:archived},(_,i)=>({id:`cut-${i}`,durationFrames:1,completionFloorFrames:1,origin:{cutId:`cut-${i}`,startFrame:0,endFrame:1},
        boundary:{hintFrame:0,ambiguous:false,references:[]},clips:[piece(`a${i}`,0)],tracks:[structuredClone(track)]}))};
      return doc;
    };
    const TOO_MANY={ok:false,reason:'この使用箇所は分かれ方が多すぎるため、差し替えを試せません'};
    expect(buildTrialSwap(pieces(5001,0),{clipId:'music',assetId:'song-long',endMode:'loop',generation:1})).toEqual(TOO_MANY);
    expect(buildTrialSwap(pieces(4000,1001),{clipId:'music',assetId:'song-long',endMode:'loop',generation:1})).toEqual(TOO_MANY);
    const doc=pieces(4000,1000);validateSequenceDocument(doc);
    const exact=buildTrialSwap(doc,{clipId:'music',assetId:'song-long',endMode:'loop',generation:1});if(!exact.ok)throw new Error(exact.reason);
    expect(exact.command.type==='swap-usage-content'&&exact.command.live.length+exact.command.archived.length).toBe(5000);
  },60000);
});

// 設計 §4「カットを戻したときの続き番号」。逆の順番（カット → カットを戻す → 差し替え採用）でも、戻した片が使用箇所から外れない。
describe('カットを戻したときの続き番号（カット → カットを戻す → 差し替え採用）',()=>{
  const clipsOn=(doc:SequenceDocument,trackId:string)=>doc.clips.filter(c=>c.trackId===trackId).sort((a,b)=>a.startFrame-b.startFrame);
  const asset=(c:SequenceClip)=>c.content.kind==='image'||c.content.kind==='audio'?c.content.assetId:null;
  const adopt=(doc:SequenceDocument,clipId:string,assetId:string)=>applySequenceCommand(doc,swapOf(doc,clipId,assetId));
  const restore=(doc:SequenceDocument,range?:{startFrame:number;endFrame:number})=>applySequenceCommand(doc,{type:'restore-cut',entryId:doc.cutArchive!.entries[0]!.id,...(range?{range}:{})});
  const restoreAll=(doc:SequenceDocument)=>{let next=doc;for(const entry of [...doc.cutArchive?.entries??[]].reverse())next=applySequenceCommand(next,{type:'restore-cut',entryId:entry.id});expect(next.cutArchive).toBeUndefined();return next;};
  it('BGM: 全体を戻してから採用すると、戻した区間も新しい曲になり、曲の中で途切れずに続く',()=>{
    const restored=restore(applySequenceCommand(withAssets(),{type:'ripple-delete',startFrame:100,endFrame:160}));validateSequenceDocument(restored);
    expect(trialUsage(restored,'music').map(c=>[c.startFrame,clipEnd(c)])).toEqual([[0,100],[100,160],[160,300]]);
    const adopted=adopt(restored,'music','song-long');validateSequenceDocument(adopted);
    const music=clipsOn(adopted,'a2');expect(music.map(c=>[c.startFrame,clipEnd(c),asset(c)])).toEqual([[0,100,'song-long'],[100,160,'song-long'],[160,300,'song-long']]);
    for(const c of music)expect(c.content).toMatchObject({sourceIn:r(c.startFrame,30)});
  });
  it('画像: 全体を戻してから採用すると、戻した区間も新しい画像になり、配置は保つ',()=>{
    const doc=withAssets(),old=doc.clips.find(c=>c.id==='pic')!;
    const restored=restore(applySequenceCommand(doc,{type:'ripple-delete',startFrame:50,endFrame:70}));validateSequenceDocument(restored);
    const adopted=adopt(restored,'pic','img-b');validateSequenceDocument(adopted);
    const pics=clipsOn(adopted,'v3');expect(pics.map(c=>[c.startFrame,clipEnd(c),asset(c)])).toEqual([[30,50,'img-b'],[50,70,'img-b'],[70,90,'img-b']]);
    for(const c of pics)expect(c.visual).toEqual(old.visual);
  });
  it.each([['BGM','music','a2','song-long',100,160],['画像','pic','v3','img-b',40,80]] as const)('%s: 一部だけ戻してから採用しても、戻した片・残りの退避片・後で戻す片がすべて新しい素材になる',(_n,clipId,trackId,assetId,start,end)=>{
    const part=restore(applySequenceCommand(withAssets(),{type:'ripple-delete',startFrame:start,endFrame:end}),{startFrame:10,endFrame:30});validateSequenceDocument(part);
    expect(part.cutArchive!.entries).toHaveLength(2);
    expect(trialUsage(part,clipId)).toHaveLength(3);expect(trialArchivedUsage(part,clipId)).toHaveLength(2);
    const adopted=adopt(part,clipId,assetId);validateSequenceDocument(adopted);
    expect(clipsOn(adopted,trackId).map(asset)).toEqual([assetId,assetId,assetId]);
    expect(trialArchivedUsage(adopted,clipId).map(x=>asset(x.clip))).toEqual([assetId,assetId]);
    const all=restoreAll(adopted);validateSequenceDocument(all);
    const pieces=clipsOn(all,trackId);expect(pieces.map(asset)).toEqual(Array(5).fill(assetId));
    expect(pieces.every((c,i)=>i===0||c.startFrame===clipEnd(pieces[i-1]!))).toBe(true);
    if(trackId==='a2')for(const c of pieces)expect(c.content).toMatchObject({sourceIn:r(c.startFrame,30)}); // 元の順に戻り、曲の時刻も元どおり
  });
  it('保存して開き直しても続き番号が保たれ、開き直した後の採用でも戻した片が新しい素材になる',()=>{
    const cut=applySequenceCommand(withAssets(),{type:'ripple-delete',startFrame:50,endFrame:70}),restored=restore(cut);
    const reloaded=parseSequence(serializeSequence(restored)),known=new Set(cut.clips.map(c=>c.id));
    expect(Object.fromEntries(reloaded.clips.filter(c=>!known.has(c.id)&&(c.trackId==='a2'||c.trackId==='v3')).map(c=>[c.trackId,c.continuationGroupId]))).toEqual({a2:'music',v3:'pic'});
    const adopted=adopt(adopt(reloaded,'music','song-long'),'pic','img-b');validateSequenceDocument(adopted);
    expect(clipsOn(adopted,'a2').map(asset)).toEqual(['song-long','song-long','song-long']);expect(clipsOn(adopted,'v3').map(asset)).toEqual(['img-b','img-b','img-b']);
  });
  it('映像・話し声・字幕・効果音の戻した片は従来どおり新しい続き番号（元の使用箇所に入らない）',()=>{
    const doc=withAssets(),music=doc.clips.find(c=>c.id==='music')!;if(music.content.kind!=='audio')throw new Error('fixture');
    doc.tracks.push({id:'a3',kind:'audio',name:'効果音',enabled:true});
    doc.clips.push({...structuredClone(music),id:'se',trackId:'a3',name:'効果音',content:{...structuredClone(music.content),role:'effect'}});validateSequenceDocument(doc);
    const cut=applySequenceCommand(doc,{type:'ripple-delete',startFrame:50,endFrame:70}),restored=restore(cut),known=new Set(cut.clips.map(c=>c.id));
    expect(Object.fromEntries(restored.clips.filter(c=>!known.has(c.id)).map(c=>[c.trackId,c.continuationGroupId??null]))).toEqual({v1:null,a1:null,v2:null,a3:null,a2:'music',v3:'pic'});
    expect(trialUsage(restored,'se')).toHaveLength(2);
  });
  it('元の片に続き番号が無ければ元の ID を続き番号にする。新しく振る ID はその続き番号と重ならない（元の ID が採番と同じ形でも）',()=>{
    const doc=withAssets();doc.clips.find(c=>c.id==='pic')!.id='restored-1';validateSequenceDocument(doc);
    const cut=applySequenceCommand(doc,{type:'ripple-delete',startFrame:20,endFrame:100}); // 画像（30〜90）を丸ごと退避
    expect(clipsOn(cut,'v3')).toEqual([]);const saved=cut.cutArchive!.entries[0]!.clips.find(c=>c.trackId==='v3')!;expect([saved.id,saved.continuationGroupId]).toEqual(['restored-1',undefined]);
    const restored=restore(cut);validateSequenceDocument(restored);
    const back=clipsOn(restored,'v3');expect(back).toHaveLength(1);expect(back[0]!.id).not.toBe('restored-1');expect(back[0]!.continuationGroupId).toBe('restored-1');
    const again=restore(applySequenceCommand(restored,{type:'ripple-delete',startFrame:40,endFrame:60}));validateSequenceDocument(again);
    const ids=again.clips.map(c=>c.id);expect(new Set(ids).size).toBe(ids.length);expect(ids).not.toContain('restored-1');
    expect(clipsOn(again,'v3').map(c=>c.continuationGroupId)).toEqual(['restored-1','restored-1','restored-1']);
    expect(trialUsage(again,back[0]!.id)).toHaveLength(3);
  });
  it('速度登録のある文書でも、戻した BGM の片は同じ使用箇所に入り、採用で新しい曲になる',()=>{
    const restored=restore(applySequenceCommand(nativeSpeedDocument(true),{type:'ripple-delete',startFrame:1,endFrame:2}));validateSequenceDocument(restored);
    expect(trialUsage(restored,'music')).toHaveLength(3);
    expect(clipsOn(adopt(restored,'music','song2'),'m').map(asset)).toEqual(['song2','song2','song2']);
  });
});

describe('update-archived-clip（退避クリップの書き換え）',()=>{
  it('退避クリップの名前と中身だけを書き換え、ID・時間・その他は変えない。同じ ID の live クリップにも触れない',()=>{
    const cut=applySequenceCommand(withAssets(),{type:'ripple-delete',startFrame:100,endFrame:130}),entry=cut.cutArchive!.entries[0]!;
    const saved=entry.clips.find(c=>c.id==='music')!;if(saved.content.kind!=='audio')throw new Error('fixture');
    const content={...saved.content,assetId:'song-long',streamIndex:0};
    const next=applySequenceCommand(cut,{type:'update-archived-clip',entryId:entry.id,clipId:'music',patch:{name:'軽快',content,startFrame:5,id:'other'} as never});
    expect(next.revision).toBe(cut.revision+1);validateSequenceDocument(next);
    expect(next.cutArchive!.entries[0]!.clips.find(c=>c.id==='music')).toEqual({...saved,name:'軽快',content});
    expect({...next,revision:0,cutArchive:undefined}).toEqual({...cut,revision:0,cutArchive:undefined});
    expect(next.cutArchive!.entries[0]!.clips.filter(c=>c.id!=='music')).toEqual(entry.clips.filter(c=>c.id!=='music'));
  });
  it('対象が無ければ MISSING_TARGET、検証に通らない中身は文書を変えずに拒否する',()=>{
    const cut=applySequenceCommand(withAssets(),{type:'ripple-delete',startFrame:100,endFrame:130}),entry=cut.cutArchive!.entries[0]!,saved=entry.clips.find(c=>c.id==='music')!;
    for(const [entryId,clipId] of [['gone','music'],[entry.id,'gone']] as const){
      let thrown:unknown;try{applySequenceCommand(cut,{type:'update-archived-clip',entryId,clipId,patch:{content:saved.content}});}catch(e){thrown=e;}
      expect(thrown).toBeInstanceOf(SequenceError);expect((thrown as SequenceError).code).toBe('MISSING_TARGET');
    }
    const before=structuredClone(cut);
    expect(()=>applySequenceCommand(cut,{type:'update-archived-clip',entryId:entry.id,clipId:'music',patch:{content:{...saved.content,assetId:'no-such-asset'} as never}})).toThrow(SequenceError);
    expect(cut).toEqual(before);
  });
  it('速度の記録を持つ退避クリップ（実データ）は書き換えない',()=>{
    const cut=applySequenceCommand(nativeSpeedDocument(),{type:'ripple-delete',startFrame:1,endFrame:2}),entry=cut.cutArchive!.entries[0]!,saved=entry.clips.find(c=>c.id==='video')!;
    expect(saved.speed).toBeTruthy();
    let thrown:unknown;try{applySequenceCommand(cut,{type:'update-archived-clip',entryId:entry.id,clipId:'video',patch:{name:'別名',content:saved.content}});}catch(e){thrown=e;}
    expect(thrown).toBeInstanceOf(SequenceError);expect((thrown as SequenceError).message).toBe('速度や旧形式の記録がある退避クリップは書き換えられません');
  });
});

describe('swap-usage-content（使用箇所をまとめて書き換える）',()=>{
  it('update-clip と update-archived-clip を順に当てたのと同じ文書になる（版も1つだけ進む）',()=>{
    const cut=applySequenceCommand(applySequenceCommand(withAssets(),{type:'ripple-delete',startFrame:200,endFrame:220}),{type:'ripple-delete',startFrame:100,endFrame:130});
    const live=trialUsage(cut,'music'),archived=trialArchivedUsage(cut,'music'),content=(c:{content:unknown})=>({...(c.content as object),assetId:'song-long',streamIndex:0}) as never;
    const swap={type:'swap-usage-content' as const,live:live.map((c,i)=>({clipId:c.id,patch:{content:content(c),...(i===0?{name:'軽快'}:{})}})),archived:archived.map(x=>({entryId:x.entryId,clipId:x.clip.id,patch:{content:content(x.clip),name:'退避'}}))};
    const one=applySequenceCommand(cut,swap);
    const sequential=applySequenceCommand(cut,{type:'batch',commands:[...swap.live.map(x=>({type:'update-clip' as const,...x})),...swap.archived.map(x=>({type:'update-archived-clip' as const,...x}))]});
    expect(one).toEqual(sequential);expect(one.revision).toBe(cut.revision+1);
  });
  it('速度登録のある文書でも、順に当てたのと同じ文書になり、戻した区間も新しい曲になる',()=>{
    const cut=applySequenceCommand(nativeSpeedDocument(true),{type:'ripple-delete',startFrame:1,endFrame:2});
    const result=buildTrialSwap(cut,{clipId:'music',assetId:'song2',endMode:'loop',generation:1});if(!result.ok)throw new Error(result.reason);
    if(result.command.type!=='swap-usage-content')throw new Error('shape');
    expect(result.command.live).toHaveLength(2);expect(result.command.archived).toHaveLength(1);
    const one=applySequenceCommand(cut,result.command);
    expect(one).toEqual(applySequenceCommand(cut,{type:'batch',commands:[...result.command.live.map(x=>({type:'update-clip' as const,...x})),...result.command.archived.map(x=>({type:'update-archived-clip' as const,...x}))]}));
    expect({...one,clips:one.clips.filter(c=>c.trackId!=='m'),cutArchive:undefined,revision:0}).toEqual({...cut,clips:cut.clips.filter(c=>c.trackId!=='m'),cutArchive:undefined,revision:0});
    const restored=applySequenceCommand(one,{type:'restore-cut',entryId:one.cutArchive!.entries[0]!.id});
    expect(restored.clips.filter(c=>c.trackId==='m').map(c=>c.content.kind==='audio'&&c.content.assetId)).toEqual(['song2','song2','song2']);
  });
  it('同じ規則で断る: 無い対象・検証に通らない中身・5,000 件超え。断っても文書は変えない',()=>{
    const cut=applySequenceCommand(withAssets(),{type:'ripple-delete',startFrame:100,endFrame:130}),before=structuredClone(cut);
    const full=swapOf(cut,'music','song-long');
    const code=(command:Parameters<typeof applySequenceCommand>[1])=>{try{applySequenceCommand(cut,command);}catch(e){return e instanceof SequenceError?e.code:String(e);}return 'ok';};
    expect(code({...full,live:[{...full.live[0]!,clipId:'gone'},...full.live.slice(1)]})).toBe('MISSING_TARGET');
    expect(code({...full,live:full.live.map(x=>({...x,patch:{...x.patch,content:{...x.patch.content,assetId:'no-such-asset'} as never}}))})).toBe('INVALID_DOCUMENT');
    expect(code({...full,live:Array.from({length:5001},()=>full.live[0]!)})).toBe('INVALID_RANGE');
    expect(code(full)).toBe('ok');expect(cut).toEqual(before);
  });
  describe('使用箇所の全体だけを受け付ける（HTTP から直接送られても、使用箇所の一部や別の片は書き換えない）',()=>{
    const WHOLE='使用箇所の全体を差し替えてください';
    const setup=()=>{
      const cut=applySequenceCommand(withAssets(),{type:'ripple-delete',startFrame:60,endFrame:100});
      const entry=cut.cutArchive!.entries[0]!,video=entry.clips.find(c=>c.content.kind==='video')!,pic=cut.clips.find(c=>c.id==='pic')!;
      return {cut,before:structuredClone(cut),full:swapOf(cut,'music','song-long'),entry,video,pic};
    };
    const refuse=(doc:SequenceDocument,command:Parameters<typeof applySequenceCommand>[1])=>{
      let thrown:unknown;try{applySequenceCommand(doc,command);}catch(e){thrown=e;}
      expect(thrown).toBeInstanceOf(SequenceError);expect((thrown as SequenceError).code).toBe('INVALID_RANGE');expect((thrown as SequenceError).message).toBe(WHOLE);
    };
    it('部分集合（live の1片だけ・退避を省く）',()=>{
      const {cut,before,full}=setup();
      refuse(cut,{...full,live:full.live.slice(0,1)});refuse(cut,{...full,archived:[]});expect(cut).toEqual(before);
    });
    it('別の使用箇所の片が混ざる',()=>{
      const {cut,before,full,pic}=setup();
      refuse(cut,{...full,live:[...full.live,{clipId:pic.id,patch:{content:pic.content}}]});expect(cut).toEqual(before);
    });
    it('種類を変える・変えてよいキー以外を変える（音量・役割）',()=>{
      const {cut,before,full}=setup(),first=full.live[0]!;
      const video={kind:'video',assetId:'source',streamIndex:0,sourceIn:r(0),rate:r(1)} as never;
      refuse(cut,{...full,live:[{...first,patch:{content:video}},...full.live.slice(1)]});
      for(const change of [{settings:{gainDb:0,muted:false,fadeInFrames:0,fadeOutFrames:60}},{role:'effect'},{rate:r(2)}])
        refuse(cut,{...full,live:[{...first,patch:{content:{...first.patch.content,...change} as never}},...full.live.slice(1)]});
      expect(cut).toEqual(before);
    });
    it('退避中の主映像を書き換える（BGM の使用箇所に足す・主映像だけを送る）',()=>{
      const {cut,before,full,entry,video}=setup(),moved={entryId:entry.id,clipId:video.id,patch:{name:'改',content:{...video.content,sourceIn:r(20)} as never}};
      refuse(cut,{...full,archived:[...full.archived,moved]});
      const live=cut.clips.filter(c=>c.content.kind==='video').sort((a,b)=>a.startFrame-b.startFrame);
      refuse(cut,{type:'swap-usage-content',live:live.map(c=>({clipId:c.id,patch:{content:c.content}})),archived:[moved]});
      expect(cut).toEqual(before);
    });
    it('同じ片を重ねて送る',()=>{
      const {cut,before,full}=setup();
      refuse(cut,{...full,live:[...full.live,full.live[1]!]});refuse(cut,{...full,archived:[...full.archived,full.archived[0]!]});expect(cut).toEqual(before);
    });
  });
  const equalToSequential=(doc:SequenceDocument,clipId:string,assetId:string,count:number,timed:boolean)=>{
    const started=performance.now(),result=buildTrialSwap(doc,{clipId,assetId,endMode:'loop',generation:1}),ms=performance.now()-started;
    if(!result.ok)throw new Error(result.reason);if(result.command.type!=='swap-usage-content')throw new Error('shape');
    expect(result.command.live.length+result.command.archived.length).toBe(count);
    if(timed)expect(ms).toBeLessThan(1000);
    const sequential=applySequenceCommand(doc,{type:'batch',commands:[...result.command.live.map(x=>({type:'update-clip' as const,...x})),...result.command.archived.map(x=>({type:'update-archived-clip' as const,...x}))]});
    expect({...result.preview,id:doc.id}).toEqual(sequential);
  };
  const cutMany=(doc:SequenceDocument)=>{for(let k=99;k>=0;k--)doc=applySequenceCommand(doc,{type:'ripple-delete',startFrame:29*k+5,endFrame:29*k+7});return doc;};
  it('速度登録のある文書でも 200 片を1秒以内で書き換え、順に当てた結果と同じ文書になる',()=>{
    const doc=cutMany(speedMusicDocument(3000));
    expect(trialUsage(doc,'music').length+trialArchivedUsage(doc,'music').length).toBe(201);
    equalToSequential(doc,'music','song2',201,true);
  },180000);
  it('場面フェードの片と画像の使用箇所がある速度文書でも、BGM・画像とも順に当てた結果と同じ文書になる',()=>{
    let doc=speedMusicDocument(3000);
    doc.assets.push({id:'img-a',kind:'image',file:'public/a.png',name:'図A',fingerprint:'i1',streams:[]},{id:'img-b',kind:'image',file:'public/b.png',name:'図B',fingerprint:'i2',streams:[]});
    doc.tracks.push({id:'v2',kind:'visual',name:'挿入',enabled:true});
    doc.clips.push({id:'pic',name:'図',trackId:'v2',startFrame:0,durationFrames:3000,clock:{offset:r(0),rate:r(1),duration:r(3000)},content:{kind:'image',assetId:'img-a',style:'plain'}});
    doc=applySequenceCommand(doc,{type:'set-scene-fades',targets:[{kind:'head'}],change:{enabled:true,durationFrames:2,color:'#224466'}} as never);
    expect(doc.clips.some(c=>c.content.kind==='scene-fade')).toBe(true);
    doc=cutMany(doc);
    const music=trialUsage(doc,'music').length+trialArchivedUsage(doc,'music').length,image=trialUsage(doc,'pic').length+trialArchivedUsage(doc,'pic').length;
    expect(music).toBeGreaterThan(1);expect(image).toBeGreaterThan(1);
    equalToSequential(doc,'music','song2',music,false);
    equalToSequential(doc,'pic','img-b',image,false);
  },180000);
});
