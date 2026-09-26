import {describe,expect,it} from 'vitest';
import {applySequenceCommand} from './commands';
import {clipEnd,type SequenceDocument} from './model';
import {rippleTrimPlan} from './rippleTrim';
import {rational as r} from './time';
import {fixture} from './fixtures';
import {SequenceSession} from './session';
import {sequenceContentBytes} from './validate';

/**
 * 押し出しの土台。`split linked:false` は使わない（左片が元の linkGroupId を保ったままなので
 * リンク音声が trim の selected に入り、2 片化ではなく延長になって検証が無効になる）。
 * 代わりに (a) video と audio のリンクを外し (b) v1 の右隣を**別素材・continuationGroupId 無し**の
 * 独立クリップにする。§4-2/§4-3 が欠けるので結合にならず押し出しになる。
 */
function pushable():SequenceDocument{
  const doc=applySequenceCommand(fixture(),{type:'unlink',clipIds:['video']});
  doc.assets.push({id:'other',kind:'media',file:'public/other.mp4',name:'別素材',fingerprint:'other-source',
    streams:[{index:0,kind:'video',codec:'h264',duration:r(60),frameRate:r(30),width:1920,height:1080}]});
  doc.clips.find(c=>c.id==='video')!.durationFrames=150;
  doc.clips.push({id:'video2',name:'別素材',trackId:'v1',startFrame:150,durationFrames:150,
    clock:{offset:r(0),rate:r(1),duration:r(150)},
    content:{kind:'video',assetId:'other',streamIndex:0,sourceIn:r(0),rate:r(1)}});
  return doc;
}
/** 速度登録のある案件。a2 の music の右に無リンクの尻尾を置く（登録クリップ自身は触らない）。 */
function speedPushable():SequenceDocument{
  const doc=applySequenceCommand(fixture(),{type:'register-native-speed',groupId:'g1',
    mainClipIds:['video'],mainAudioBindings:[{audioClipId:'audio',providerId:'video'}]});
  doc.clips.push({id:'tail',name:'後ろの音',trackId:'a2',startFrame:360,durationFrames:20,
    clock:{offset:r(0),rate:r(1),duration:r(20)},
    content:{kind:'audio',assetId:'source',streamIndex:1,sourceIn:r(0),rate:r(1),role:'music',loop:false,
      settings:{gainDb:-12,muted:false,fadeInFrames:0,fadeOutFrames:0}}});
  return doc;
}

/**
 * 固定挿入（insertOwnSpeed）のある案件（§5 v2.4・Codex P2 2 巡目）。`completion` が完成尺、
 * 中身は固定挿入 [0,5)・通常 [5,10)・[10,15)。完成尺 30 なら末尾に 15fr の空白がある。
 * 固定挿入は押し出し点より**前**にあるので `fixedInsertionBlocks` には掛からない。
 */
function fixedInsertPushable(completion:number,firstEnd=10):SequenceDocument{
  const clock=(offset:number,rate:number,duration:number)=>({offset:r(offset),rate:r(rate),duration:r(duration)});
  const doc:SequenceDocument={schemaVersion:2,id:'own-push',name:'挿入',revision:0,fps:r(1),
    resolution:{width:320,height:180},sequenceEndFrame:completion,background:'#000',ducking:{enabled:false,strength:'mid'},
    transcripts:[],transitions:[],
    assets:[{id:'asset',kind:'media',name:'素材',file:'media/test.mp4',fingerprint:'private',streams:[
      {index:0,kind:'video',codec:'h264',duration:r(100),frameRate:r(30),width:320,height:180},
      {index:1,kind:'audio',codec:'aac',duration:r(100),sampleRate:48000,channels:2}]}],
    tracks:[{id:'v',kind:'visual',name:'映像',enabled:true},{id:'a',kind:'audio',name:'原音',enabled:true}],
    clips:[
      {id:'iv',trackId:'v',name:'挿入映像',startFrame:0,durationFrames:5,clock:clock(-2,2,40),
        content:{kind:'video',assetId:'asset',streamIndex:0,sourceIn:r(10),rate:r(5)}},
      {id:'ov1',trackId:'v',name:'通常1',startFrame:5,durationFrames:firstEnd-5,clock:clock(0,1,firstEnd-5),
        content:{kind:'video',assetId:'asset',streamIndex:0,sourceIn:r(0),rate:r(1)}},
      {id:'ov2',trackId:'v',name:'通常2',startFrame:10,durationFrames:5,clock:clock(0,1,5),
        content:{kind:'video',assetId:'asset',streamIndex:0,sourceIn:r(20),rate:r(1)}}]};
  return applySequenceCommand(doc,{type:'register-native-insert-own-speed',clipId:'iv',linked:false});
}
const on=(doc:SequenceDocument,trackId:string)=>doc.clips.filter(c=>c.trackId===trackId).sort((a,b)=>a.startFrame-b.startFrame);

describe('trim の ripple: 押し出し',()=>{
  it('at 以降が +delta、またぐ音声・字幕・BGM が 2 片に切れて後半だけ動く',()=>{
    const before=pushable();
    // 前提の検算（崩れたら以下の期待値も無効）:
    //   video [0,150) は無リンク、video2 [150,300) は別素材、audio [0,300)・telop [30,270)・music [0,360)。
    expect(on(before,'v1').map(c=>[c.startFrame,clipEnd(c)])).toEqual([[0,150],[150,300]]);
    expect(before.clips.every(c=>c.linkGroupId===undefined)).toBe(true);
    expect(before.clips.find(c=>c.id==='telop')!.anchor).toMatchObject({clipOccurrenceId:'audio'});

    // 導出: 右隣の開始は 150、終了端を 200 へ延ばすので at = 150、delta = 200 − 150 = 50。
    const next=applySequenceCommand(before,{type:'trim',clipId:'video',edge:'end',frame:200,ripple:true});
    expect(on(next,'v1').map(c=>[c.startFrame,c.durationFrames])).toEqual([[0,200],[200,150]]);
    // audio は 0..300 で 150 をまたぐ → [0,150) と [200,350)。
    expect(on(next,'a1').map(c=>[c.startFrame,c.durationFrames])).toEqual([[0,150],[200,150]]);
    // telop は 30..270 で 150 をまたぐ → [30,150) と [200,320)。provider（audio）も 150 で切れるので
    // 字幕の再アンカー（rebuild:139-156）と 2 片化が一致する。
    expect(on(next,'v2').map(c=>[c.startFrame,c.durationFrames])).toEqual([[30,120],[200,120]]);
    // music は 0..360 で 150 をまたぐ → [0,150) と [200,410)。
    expect(on(next,'a2').map(c=>[c.startFrame,c.durationFrames])).toEqual([[0,150],[200,210]]);
    // 全体尺は 300 + 50 = 350。
    expect(next.sequenceEndFrame).toBe(350);
    // 切った 2 片は同じ continuationGroupId を共有する（split と同じ）。無リンクの music で見る。
    const [musicLeft,musicRight]=on(next,'a2');
    expect(musicLeft!.continuationGroupId).toBeDefined();
    expect(musicRight!.continuationGroupId).toBe(musicLeft!.continuationGroupId);
    // 押し出しは復元記録を作らない。
    expect(next.cutArchive).toBeUndefined();
  });
  it('at より後ろの転換は +delta で動く',()=>{
    const before=pushable();
    // telop は 30..270。フェードは [240,260) で telop の中に収まる（validate.ts:289）。
    before.transitions=[{id:'t',trackId:'v2',outClipId:'telop',kind:'fadeBlack',startFrame:240,durationFrames:20,edge:'out'}];
    const next=applySequenceCommand(before,{type:'trim',clipId:'video',edge:'end',frame:200,ripple:true});
    expect(next.transitions[0]!.startFrame).toBe(290);   // 240 + 50
    // 導出: 追従先は telop の右片 [200,320)。290..310 はその中に収まる。
    const outClip=next.clips.find(c=>c.id===next.transitions[0]!.outClipId)!;
    expect([outClip.startFrame,clipEnd(outClip)]).toEqual([200,320]);
  });
  it('at をまたぐ転換は TRANSITION_INTERSECTION で文書不変',()=>{
    const before=pushable();
    before.transitions=[{id:'t',trackId:'v2',outClipId:'telop',kind:'fadeBlack',startFrame:140,durationFrames:20,edge:'out'}];
    const snapshot=structuredClone(before);
    expect(()=>applySequenceCommand(before,{type:'trim',clipId:'video',edge:'end',frame:200,ripple:true})).toThrow(/転換/);
    expect(before).toEqual(snapshot);
  });
  it('押し出しは 1 コマンド・1 Undo（バイト一致で戻る）',()=>{
    const before=pushable(),session=new SequenceSession('push',before);
    session.execute({sessionId:session.id,expectedRevision:before.revision,executionId:'push',
      command:{type:'trim',clipId:'video',edge:'end',frame:200,ripple:true}});
    expect(session.document.sequenceEndFrame).toBe(350);
    session.execute({sessionId:session.id,expectedRevision:session.document.revision,executionId:'undo',
      command:{type:'undo'}});
    expect(sequenceContentBytes(session.document)).toBe(sequenceContentBytes(before));
  });
  it('速度登録のある案件でも、登録されていないクリップの押し出しは通り尺が追従する（§7(7)）',()=>{
    const before=speedPushable();
    expect(before.speed).toBeDefined();
    expect(before.clips.find(c=>c.id==='music')!.speed).toBeUndefined();
    // 実測（Step 4）: 登録直後の基準は主映像の終端ちょうど＝ main-offset の offsetFrames 0。
    expect(before.speed!.sequenceEndBasis).toEqual({kind:'main-offset',offsetFrames:0});
    // 導出: music [0,360) の右隣 tail は 360 始まり。370 まで延ばすので at = 360、delta = 10。
    //       360 をまたぐクリップは無いので 2 片化は起きない。尺は 300 + 10 = 310（§5）。
    const next=applySequenceCommand(before,{type:'trim',clipId:'music',edge:'end',frame:370,ripple:true});
    expect(next.speed).toBeDefined();
    expect(next.sequenceEndFrame).toBe(310);
    // 実測（Step 4）: `rebuild(…,{sequenceEndFrame})` が基準も押し出した分だけずらす（0 → +10）。
    // 主映像は動かないので主終端は 300 のまま、310 − 300 = 10 が新しい offsetFrames。
    expect(next.speed!.sequenceEndBasis).toEqual({kind:'main-offset',offsetFrames:10});
    expect(on(next,'a2').map(c=>[c.startFrame,c.durationFrames])).toEqual([[0,370],[370,20]]);
  });
  it('速度を登録したクリップ自身の押し出しは断る（裁定 10）',()=>{
    const before=speedPushable(),snapshot=structuredClone(before);
    expect(()=>applySequenceCommand(before,{type:'trim',clipId:'video',edge:'end',frame:320,ripple:true})).toThrow(/速度/);
    expect(before).toEqual(snapshot);
  });
  it('linked:false の終了端延長は結合せず押し出す（裁定 8 の reducer 側）',()=>{
    const before=applySequenceCommand(
      applySequenceCommand(fixture(),{type:'split',clipIds:['video'],frame:150}),
      {type:'ripple-delete',startFrame:280,endFrame:300});
    const left=before.clips.find(c=>c.trackId==='v1'&&c.startFrame===0)!;
    const right=before.clips.find(c=>c.trackId==='v1'&&c.startFrame===150)!;
    const next=applySequenceCommand(before,{type:'trim',clipId:left.id,edge:'end',frame:200,ripple:true,linked:false});
    // 導出: at = 150、delta = 50。結合していないので R は残り 200 始まりへ動く。尺は 280 + 50 = 330。
    expect(next.clips.find(c=>c.id===right.id)!.startFrame).toBe(200);
    expect(next.sequenceEndFrame).toBe(330);
  });
  it('結合が断られた延長は押し出しになる（復元記録の中の字幕が A_R を指す文書。裁定 7 の reducer 側）',()=>{
    const before=applySequenceCommand(
      applySequenceCommand(fixture(),{type:'split',clipIds:['video'],frame:150}),
      {type:'ripple-delete',startFrame:200,endFrame:240});
    const left=before.clips.find(c=>c.trackId==='v1'&&c.startFrame===0)!;
    const right=before.clips.find(c=>c.trackId==='v1'&&c.startFrame===150)!;
    const next=applySequenceCommand(before,{type:'trim',clipId:left.id,edge:'end',frame:180,ripple:true});
    // 結合していない＝R が残っている。導出: at = 150、delta = 30 なので R は 180 始まりへ動く。
    expect(next.clips.find(c=>c.id===right.id)!.startFrame).toBe(180);
    expect(next.clips.find(c=>c.id===left.id)!.durationFrames).toBe(180);
  });
});

/**
 * §5 v2.3 の裁定（レビュー Important 1）: 対象と一緒に延長されるクリップ（リンク音声など
 * `selected` に入るもの）が押し出し点をまたぐ文書では、押し出さず右隣の手前で止める。
 */
describe('一緒に延長されるクリップが押し出し点をまたぐなら止める（§5 v2.3）',()=>{
  /** `split linked:false`: 映像だけ 2 片・音声 [0,300) は右へはみ出したまま（J/L カットと同じ形）。 */
  const splitVideoOnly=()=>applySequenceCommand(fixture(),{type:'split',clipIds:['video'],frame:150,linked:false});

  it('計画が clamp（reason: linked-overhang）になり、押し出しは起きない',()=>{
    const before=splitVideoOnly();
    const left=before.clips.find(c=>c.trackId==='v1'&&c.startFrame===0)!;
    // 前提の検算: 左片はリンクを保ち、その相手の音声 [0,300) が押し出し点 150 をまたぐ。
    expect(left.linkGroupId).toBeDefined();
    expect(on(before,'a1').map(c=>[c.startFrame,clipEnd(c)])).toEqual([[0,300]]);
    expect(rippleTrimPlan(before,{type:'trim',clipId:left.id,edge:'end',frame:200,ripple:true}))
      .toEqual({kind:'clamp',frame:150,reason:'linked-overhang'});
    // 右隣は 150 始まり＝clamp 先は現在の終端なので、文書は 1 バイトも変わらない。
    expect(applySequenceCommand(before,{type:'trim',clipId:left.id,edge:'end',frame:200,ripple:true})).toBe(before);
  });
  it('結合＋押し出し（join.push）も同じ検査を通る',()=>{
    // splitThenCut と同じ形（L[0,150)・R[150,280)・A_L[0,150)・A_R[150,280)）を作り、
    // A_R だけを右へはみ出させる。結合条件は隣接しか見ないので join 自体は成立する。
    const before=applySequenceCommand(
      applySequenceCommand(fixture(),{type:'split',clipIds:['video'],frame:150}),
      {type:'ripple-delete',startFrame:280,endFrame:300});
    const left=before.clips.find(c=>c.trackId==='v1'&&c.startFrame===0)!;
    const audioRight=before.clips.find(c=>c.trackId==='a1'&&c.startFrame===150)!;
    expect(rippleTrimPlan(before,{type:'trim',clipId:left.id,edge:'end',frame:320,ripple:true}))
      .toMatchObject({kind:'join',push:{atFrame:280,delta:40}});   // はみ出す前は結合＋押し出し
    audioRight.durationFrames=180;                                  // A_R を [150,330) にして 280 をまたがせる
    expect(rippleTrimPlan(before,{type:'trim',clipId:left.id,edge:'end',frame:320,ripple:true}))
      .toEqual({kind:'clamp',frame:150,reason:'linked-overhang'});
  });
  it('隙間がある文書では右隣の手前まで延長するだけで、音声も右隣も押し出されない',()=>{
    // 右片の開始を 160 へ（ripple 無しの従来トリム）＝ v1 に [150,160) の隙間を作る。
    const split=splitVideoOnly();
    const right=split.clips.find(c=>c.trackId==='v1'&&c.startFrame===150)!;
    const before=applySequenceCommand(split,{type:'trim',clipId:right.id,edge:'start',frame:160});
    const left=before.clips.find(c=>c.trackId==='v1'&&c.startFrame===0)!;
    expect(on(before,'a1').map(c=>[c.startFrame,clipEnd(c)])).toEqual([[0,300]]);   // 音声は 160 をまたぐ

    const next=applySequenceCommand(before,{type:'trim',clipId:left.id,edge:'end',frame:200,ripple:true});
    // 導出: clamp 先は右隣の開始 160。押し出していれば右隣は 200 始まり・尺 340 になるが、そうならない。
    expect(on(next,'v1').map(c=>[c.startFrame,clipEnd(c)])).toEqual([[0,160],[160,300]]);
    // 音声は 2 片に切れず（＝取り残しも起きず）、従来トリムと同じく延長されるだけ。
    expect(on(next,'a1').map(c=>[c.startFrame,clipEnd(c)])).toEqual([[0,310]]);
    // 字幕は provider（音声）に追従するので元位置のまま＝編集点より後ろがずれない。
    expect(on(next,'v2').map(c=>[c.startFrame,clipEnd(c)])).toEqual(on(before,'v2').map(c=>[c.startFrame,clipEnd(c)]));
    expect(next.sequenceEndFrame).toBe(310);   // 押し出しなら 300 + 40 = 340
    expect(next.cutArchive).toBeUndefined();
  });
});

/**
 * Task 3 の `join.push` と Task 4 の単独 push が同じ `pushRecipes` を通ることを、押し出しの効果が
 * ちょうど 1 回だけ掛かる（2 重に +delta しない・2 回切らない）ことで固定する。
 */
describe('join.push は単独 push と同じ押し出しを 1 回だけ通す',()=>{
  it('結合＋押し出しでも、またぐ BGM は 1 回だけ切れて後半が +delta する',()=>{
    const before=applySequenceCommand(
      applySequenceCommand(fixture(),{type:'split',clipIds:['video'],frame:150}),
      {type:'ripple-delete',startFrame:280,endFrame:300});
    const left=before.clips.find(c=>c.trackId==='v1'&&c.startFrame===0)!;
    // 検算: 結合後の終端は 280。320 まで延ばすので at = 280、delta = 40。
    expect(on(before,'a2').map(c=>[c.startFrame,clipEnd(c)])).toEqual([[0,280],[280,340]]);
    const next=applySequenceCommand(before,{type:'trim',clipId:left.id,edge:'end',frame:320,ripple:true});
    // 2 片のまま（3 片に増えない）で、後半だけが +40。+80 にはならない。
    expect(on(next,'a2').map(c=>[c.startFrame,clipEnd(c)])).toEqual([[0,280],[320,380]]);
    expect(next.sequenceEndFrame).toBe(320);
  });
});

/** Task 3 レビューの申し送り: 固定挿入がある文書の開始端 clamp（push 側の対称）。 */
describe('固定挿入がある文書の開始端 clamp（Task 3 レビューの申し送り）',()=>{
  function fixedInsertDocument():SequenceDocument{
    const clock=(offset:number,rate:number,duration:number)=>({offset:r(offset),rate:r(rate),duration:r(duration)});
    const doc:SequenceDocument={schemaVersion:2,id:'own-clamp',name:'挿入',revision:0,fps:r(1),
      resolution:{width:320,height:180},sequenceEndFrame:12,background:'#000',ducking:{enabled:false,strength:'mid'},
      transcripts:[],transitions:[],
      assets:[{id:'asset',kind:'media',name:'素材',file:'media/test.mp4',fingerprint:'private',streams:[
        {index:0,kind:'video',codec:'h264',duration:r(100),frameRate:r(30),width:320,height:180},
        {index:1,kind:'audio',codec:'aac',duration:r(100),sampleRate:48000,channels:2}]}],
      tracks:[{id:'v',kind:'visual',name:'映像',enabled:true},{id:'a',kind:'audio',name:'原音',enabled:true}],
      clips:[
        {id:'iv',trackId:'v',name:'挿入映像',startFrame:0,durationFrames:5,linkGroupId:'pair',clock:clock(-2,2,40),
          content:{kind:'video',assetId:'asset',streamIndex:0,sourceIn:r(10),rate:r(5)}},
        {id:'ia',trackId:'a',name:'挿入原音',startFrame:0,durationFrames:5,linkGroupId:'pair',clock:clock(-3,3,50),
          content:{kind:'audio',assetId:'asset',streamIndex:1,sourceIn:r(10),rate:r(5),role:'speech',loop:false,
            settings:{gainDb:-2,muted:false,fadeInFrames:3,fadeOutFrames:4}}},
        // 隙間（[5,7)）を空けて置いた通常クリップ。開始端を左へ伸ばすと固定挿入の終端で止まる。
        {id:'ov',trackId:'v',name:'通常',startFrame:7,durationFrames:5,clock:clock(0,1,5),
          content:{kind:'video',assetId:'asset',streamIndex:0,sourceIn:r(3),rate:r(1)}}]};
    return applySequenceCommand(doc,{type:'register-native-insert-own-speed',clipId:'iv',linked:true});
  }
  it('固定挿入の右にあるクリップの開始端は、その終端で止まり文書が壊れない',()=>{
    const before=fixedInsertDocument();
    expect(before.clips.find(c=>c.id==='iv')!.insertOwnSpeed).toBeDefined();
    // 導出: 左隣（固定挿入）の終端は 5。0 まで伸ばす指示でも 5 で止まる（左への押し出しは提供しない）。
    const next=applySequenceCommand(before,{type:'trim',clipId:'ov',edge:'start',frame:0,ripple:true});
    const moved=next.clips.find(c=>c.id==='ov')!;
    expect([moved.startFrame,clipEnd(moved)]).toEqual([5,12]);
    // 固定挿入自身は動かず、尺も変わらない。
    expect(next.clips.find(c=>c.id==='iv')!.startFrame).toBe(0);
    expect(next.sequenceEndFrame).toBe(before.sequenceEndFrame);
  });
});

describe('固定挿入がある案件の押し出し（§5 v2.4・Codex P2 2 巡目）',()=>{
  /**
   * 押し出しで増やした完成尺を後処理 `rebindInsertOwnCompletion` が
   * `endFloor` へ戻すため、末尾に空白のある固定挿入案件では押し出さず隣の手前で止める。
   */
  it('固定挿入があり末尾に空白がある案件では押し出さず、右隣の手前で止める',()=>{
    const before=fixedInsertPushable(30);
    // 前提の検算: 完成尺 30・中身は 15 まで（末尾に空白）・endFloor は登録時の完成尺。
    expect(before.sequenceEndFrame).toBe(30);
    expect(Math.max(...before.clips.map(clipEnd))).toBe(15);
    expect(before.insertOwnSpeed).toMatchObject({endFloor:30});
    expect(rippleTrimPlan(before,{type:'trim',clipId:'ov1',edge:'end',frame:12,ripple:true}))
      .toEqual({kind:'clamp',frame:10,reason:'fixed-insert-length'});
    const next=applySequenceCommand(before,{type:'trim',clipId:'ov1',edge:'end',frame:12,ripple:true});
    // 押し出しは起きない。完成尺も右隣も動かない。
    expect(next.sequenceEndFrame).toBe(30);
    expect(on(next,'v').map(c=>[c.startFrame,clipEnd(c)])).toEqual([[0,5],[5,10],[10,15]]);

    // 隙間があるときは「右隣の手前まで延長」だけが起きる（完成尺は不変）。
    const gapped=fixedInsertPushable(30,9);
    expect(rippleTrimPlan(gapped,{type:'trim',clipId:'ov1',edge:'end',frame:12,ripple:true}))
      .toEqual({kind:'clamp',frame:10,reason:'fixed-insert-length'});
    const filled=applySequenceCommand(gapped,{type:'trim',clipId:'ov1',edge:'end',frame:12,ripple:true});
    expect(on(filled,'v').map(c=>[c.startFrame,clipEnd(c)])).toEqual([[0,5],[5,10],[10,15]]);
    expect(filled.sequenceEndFrame).toBe(30);
  });

  it('固定挿入があっても末尾に空白が無ければ従来どおり押し出し、完成尺が増える',()=>{
    const before=fixedInsertPushable(15);
    // 前提の検算: 最後のクリップ終端＝完成尺。この形なら endFloor が押し出し後の終端まで上がる。
    expect(Math.max(...before.clips.map(clipEnd))).toBe(before.sequenceEndFrame);
    expect(rippleTrimPlan(before,{type:'trim',clipId:'ov1',edge:'end',frame:12,ripple:true}))
      .toEqual({kind:'push',atFrame:10,delta:2});
    const next=applySequenceCommand(before,{type:'trim',clipId:'ov1',edge:'end',frame:12,ripple:true});
    // 実測: rebindInsertOwnCompletion は endFloor を 17 へ引き上げるので尺を戻さない。
    expect(next.sequenceEndFrame).toBe(17);
    expect(next.insertOwnSpeed).toMatchObject({endFloor:17});
    expect(on(next,'v').map(c=>[c.startFrame,clipEnd(c)])).toEqual([[0,5],[5,12],[12,17]]);
  });
});
