import {describe,expect,it} from 'vitest';
import {applySequenceCommand} from './commands';
import {losslessJoin,rippleTrimPlan} from './rippleTrim';
import {clipEnd,type SequenceDocument} from './model';
import {compareTime,rational as r} from './time';
import {fixture} from './fixtures';
import {planTransition,transitionJoins} from './transitions';
import {sampleVisualTransform} from './visualTransform';
import {SequenceSession} from './session';
import {sequenceContentBytes} from './validate';
import {DEFAULT_MAIN_LAYOUT} from '../mainLayout';

/** 150 で分割 → 末尾 [280,300) を詰める。復元境界が「右の映像の終端」を指す文書になる。 */
function splitThenCut():SequenceDocument{
  const split=applySequenceCommand(fixture(),{type:'split',clipIds:['video'],frame:150});
  return applySequenceCommand(split,{type:'ripple-delete',startFrame:280,endFrame:300});
}
/** v1: 主映像 [0,150) と、160 から始まる別素材（間に 10fr の隙間）。結合条件 1 が欠ける。
 *  別素材は sourceIn=2s から使うので、開始端を左へ 10fr 伸ばす余裕がある。 */
function gapNeighbour():SequenceDocument{
  const doc=applySequenceCommand(fixture(),{type:'unlink',clipIds:['video']});
  doc.assets.push({id:'other',kind:'media',file:'public/other.mp4',name:'別素材',fingerprint:'other-source',
    streams:[{index:0,kind:'video',codec:'h264',duration:r(60),frameRate:r(30),width:1920,height:1080}]});
  doc.clips.find(c=>c.id==='video')!.durationFrames=150;
  doc.clips.push({id:'video2',name:'別素材',trackId:'v1',startFrame:160,durationFrames:140,
    clock:{offset:r(0),rate:r(1),duration:r(140)},
    content:{kind:'video',assetId:'other',streamIndex:0,sourceIn:r(2),rate:r(1)}});
  return doc;
}
/** 固定挿入（insertOwnSpeed）を 2 フレーム目で分割した文書。2 片は同じ出自・連続した source を持つ
 *  ので §4 の 1〜5 を満たすが、固定挿入なので結合してはいけない（修正ラウンド 1）。 */
function splitFixedInsert():SequenceDocument{
  const clock=(offset:number,rate:number,duration:number)=>({offset:r(offset),rate:r(rate),duration:r(duration)});
  const doc:SequenceDocument={schemaVersion:2,id:'own-join',name:'挿入',revision:0,fps:r(1),
    resolution:{width:320,height:180},sequenceEndFrame:10,background:'#000',ducking:{enabled:false,strength:'mid'},
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
      {id:'ov',trackId:'v',name:'通常',startFrame:5,durationFrames:5,clock:clock(0,1,5),
        content:{kind:'video',assetId:'asset',streamIndex:0,sourceIn:r(0),rate:r(1)}}]};
  const registered=applySequenceCommand(doc,{type:'register-native-insert-own-speed',clipId:'iv',linked:true});
  return applySequenceCommand(registered,{type:'split',clipIds:['iv'],frame:2});
}
const at=(doc:SequenceDocument,trackId:string,startFrame:number)=>doc.clips.find(c=>c.trackId===trackId&&c.startFrame===startFrame)!;

describe('trim の ripple: 結合',()=>{
  it('続きへ延ばすとクリップが 2 減り、source が連結し、R への参照が L を指す',()=>{
    const before=splitThenCut();
    const left=at(before,'v1',0),right=at(before,'v1',150),audioRight=at(before,'a1',150);
    // 前提の確認（この検算が崩れたら以下の期待値も無効）:
    expect(before.sequenceEndFrame).toBe(280);            // 300 − (300 − 280)
    expect(clipEnd(right)).toBe(280);
    expect(before.cutArchive!.entries[0]!.boundary.references.map(v=>v.clipId)).toContain(right.id);
    const telopRight=before.clips.find(c=>c.anchor?.kind==='source'&&c.anchor.clipOccurrenceId===audioRight.id)!;
    const countBefore=before.clips.length;

    const next=applySequenceCommand(before,{type:'trim',clipId:left.id,edge:'end',frame:200,ripple:true});
    // 映像の右片とリンク音声の右片が消える＝2 減。
    expect(next.clips).toHaveLength(countBefore-2);
    // L は [0, clipEnd(R)) へ伸びる。source は 0 から連続なので 280fr。
    expect(at(next,'v1',0).durationFrames).toBe(280);
    expect(compareTime((at(next,'v1',0).content as {sourceIn:ReturnType<typeof r>}).sourceIn,
      (left.content as {sourceIn:ReturnType<typeof r>}).sourceIn)).toBe(0);
    expect(at(next,'a1',0).durationFrames).toBe(280);
    // L は 1 片のまま（rebuild:161 は parts.length>1 のときだけ id を振り直す）＝出自とリンクが保たれる。
    expect(at(next,'v1',0).continuationGroupId).toBe(left.continuationGroupId);
    expect(at(next,'v1',0).linkGroupId).toBe(left.linkGroupId);
    expect(at(next,'a1',0).linkGroupId).toBe(left.linkGroupId);
    // 全体尺は変わらない（結合は尺を増やさない）。
    expect(next.sequenceEndFrame).toBe(280);
    // R を指していた復元境界と、A_R を指していた字幕 anchor が L・A_L を指す。
    expect(next.cutArchive!.entries[0]!.boundary.references.map(v=>v.clipId)).toContain(at(next,'v1',0).id);
    expect(next.cutArchive!.entries[0]!.boundary.references).not.toContainEqual(expect.objectContaining({clipId:right.id}));
    expect(next.clips.find(c=>c.id===telopRight.id)!.anchor)
      .toMatchObject({kind:'source',clipOccurrenceId:at(next,'a1',0).id});
    // 1 コマンド＝ revision は 1 だけ進む。
    expect(next.revision).toBe(before.revision+1);
  });
  it('結合後さらに越えた分は同じ操作の中で押し出される',()=>{
    const before=splitThenCut(),left=at(before,'v1',0);
    // 導出: 結合後の終端は 280。320 まで延ばすので 280 から 40 を押し出す → 全体尺 280 + 40 = 320。
    const next=applySequenceCommand(before,{type:'trim',clipId:left.id,edge:'end',frame:320,ripple:true});
    expect(at(next,'v1',0).durationFrames).toBe(320);
    expect(at(next,'a1',0).durationFrames).toBe(320);
    expect(next.sequenceEndFrame).toBe(320);
    // 押し出しの相手: music は [0,340) で 280 をまたぐ → [0,280) と [320,380)。
    expect(before.clips.filter(c=>c.trackId==='a2').map(c=>[c.startFrame,clipEnd(c)])).toEqual([[0,280],[280,340]]);
    expect(next.clips.filter(c=>c.trackId==='a2').map(c=>[c.startFrame,clipEnd(c)]).sort((a,b)=>a[0]!-b[0]!))
      .toEqual([[0,280],[320,380]]);
  });
  it('結合＋押し出しも 1 コマンド・1 Undo（Minor 2）',()=>{
    const before=splitThenCut(),session=new SequenceSession('join-push',before);
    session.execute({sessionId:session.id,expectedRevision:before.revision,executionId:'join-push',
      command:{type:'trim',clipId:at(before,'v1',0).id,edge:'end',frame:320,ripple:true}});
    expect(session.document.sequenceEndFrame).toBe(320);
    session.execute({sessionId:session.id,expectedRevision:session.document.revision,executionId:'undo',
      command:{type:'undo'}});
    expect(sequenceContentBytes(session.document)).toBe(sequenceContentBytes(before));
  });
  it('開始端を左隣の続きへ延ばしても結合になる',()=>{
    const before=splitThenCut(),right=at(before,'v1',150);
    const next=applySequenceCommand(before,{type:'trim',clipId:right.id,edge:'start',frame:100,ripple:true});
    expect(at(next,'v1',0).durationFrames).toBe(280);
    expect(next.clips.find(c=>c.id===right.id)).toBeUndefined();
    expect(next.sequenceEndFrame).toBe(280);
  });
  it('linked:false では結合せず、開始端は左隣の終端で止まる（裁定 8）',()=>{
    const before=splitThenCut(),right=at(before,'v1',150);
    const next=applySequenceCommand(before,{type:'trim',clipId:right.id,edge:'start',frame:100,ripple:true,linked:false});
    // 導出: clamp で 150（左隣の終端）へ戻るので端は動かない ＝ delta 0 ＝ :471 が同じ文書を返す。
    expect(next).toBe(before);
  });
  it('Undo 1 回で結合前の文書へ戻る（1 コマンド・1 Undo）',()=>{
    const before=splitThenCut(),session=new SequenceSession('join',before);
    session.execute({sessionId:session.id,expectedRevision:before.revision,executionId:'join',
      command:{type:'trim',clipId:at(before,'v1',0).id,edge:'end',frame:200,ripple:true}});
    expect(session.document.clips).toHaveLength(before.clips.length-2);
    session.execute({sessionId:session.id,expectedRevision:session.document.revision,executionId:'undo',
      command:{type:'undo'}});
    // バイト一致なので復元記録・字幕 anchor の巻き戻しまで固定される。
    expect(sequenceContentBytes(session.document)).toBe(sequenceContentBytes(before));
  });
});

describe('trim の ripple: 隣で止める（clamp）',()=>{
  it('開始端を左隣へ食い込ませると左隣の終端で止まる',()=>{
    const before=gapNeighbour();
    // 導出: 左隣 video は [0,150)。video2 は [160,300)。100 まで延ばしても 150 で止まる。
    const next=applySequenceCommand(before,{type:'trim',clipId:'video2',edge:'start',frame:100,ripple:true});
    expect(at(next,'v1',150).id).toBe('video2');
    expect(at(next,'v1',150).durationFrames).toBe(150);   // 300 − 150
    // 10fr ぶん左へ伸びたので素材の入口も 10fr（= 1/3 秒）戻る: 2 − 1/3 = 5/3。
    expect(compareTime((at(next,'v1',150).content as {sourceIn:ReturnType<typeof r>}).sourceIn,r(5,3))).toBe(0);
    expect(next.sequenceEndFrame).toBe(300);
    // 左隣は動かない。
    expect(at(next,'v1',0).durationFrames).toBe(150);
  });
  it('clamp は文書を 1 回だけ変える（Undo 1 回で戻り、TRACK_COLLISION にならない）',()=>{
    const before=gapNeighbour(),session=new SequenceSession('clamp',before);
    session.execute({sessionId:session.id,expectedRevision:before.revision,executionId:'clamp',
      command:{type:'trim',clipId:'video2',edge:'start',frame:100,ripple:true}});
    expect(session.document.clips.find(c=>c.id==='video2')!.startFrame).toBe(150);
    session.execute({sessionId:session.id,expectedRevision:session.document.revision,executionId:'undo',
      command:{type:'undo'}});
    expect(sequenceContentBytes(session.document)).toBe(sequenceContentBytes(before));
  });
});

/** Task 2 レビュー Minor 3: linked:false + ripple が従来（linked 既定）と同じ結果になることを実行で固定する。 */
describe('linked:false ＋ ripple の境界（Task 2 レビュー Minor 3）',()=>{
  it('短縮（close）は範囲操作なので linked:false でも結果が 1 バイト一致する',()=>{
    const before=fixture();
    const withLink=applySequenceCommand(before,{type:'trim',clipId:'video',edge:'end',frame:200,ripple:true});
    const noLink=applySequenceCommand(before,{type:'trim',clipId:'video',edge:'end',frame:200,ripple:true,linked:false});
    expect(sequenceContentBytes(noLink)).toBe(sequenceContentBytes(withLink));
  });
});

describe('固定挿入は結合しない（修正ラウンド 1・Important 1）',()=>{
  it('固定挿入を分割した 2 片は losslessJoin が断り、reducer でも文書が変わらない',()=>{
    const before=splitFixedInsert();
    const left=at(before,'v',0),right=at(before,'v',2);
    // 検算: 2 片は固定挿入を持ち、条件 1〜5 側は満たしている（＝条件 6 が唯一の壁）。
    expect(left.insertOwnSpeed).toBeDefined();expect(right.insertOwnSpeed).toBeDefined();
    expect(left.continuationGroupId).toBeDefined();
    expect(left.continuationGroupId).toBe(right.continuationGroupId);
    expect(losslessJoin(before,left.id,right.id)).toEqual({ok:false,reason:'固定挿入は結合しません'});
    // 計画は結合以外へ倒れる（固定挿入が範囲に掛かるので設計 §3 注記どおり reject:'speed'）。
    expect(rippleTrimPlan(before,{type:'trim',clipId:left.id,edge:'end',frame:4,ripple:true}))
      .toEqual({kind:'reject',reason:'speed'});
    // reducer は断り、文書は 1 バイトも変わらない（尺と insertOwnSpeed が矛盾しない）。
    expect(()=>applySequenceCommand(before,{type:'trim',clipId:left.id,edge:'end',frame:4,ripple:true}))
      .toThrow(/詰められません/);
    expect(sequenceContentBytes(before)).toBe(sequenceContentBytes(splitFixedInsert()));
  });
});

describe('静的な表示設定が違う片は結合しない（Codex P1）',()=>{
  it('右片だけ位置・不透明度を変えると losslessJoin が断り、reducer は結合せず押し出す',()=>{
    const base=():NonNullable<SequenceDocument['clips'][number]['visual']>=>
      ({layout:structuredClone(DEFAULT_MAIN_LAYOUT),opacity:1,keyframes:[]});
    const before=applySequenceCommand(fixture(),{type:'split',clipIds:['video'],frame:150});
    const left=at(before,'v1',0),right=at(before,'v1',150);
    before.clips.find(c=>c.id===left.id)!.visual=base();
    const moved=base();moved.layout.position={x:0.25,y:0};moved.opacity=0.5;
    before.clips.find(c=>c.id===right.id)!.visual=moved;
    expect(losslessJoin(before,left.id,right.id)).toEqual({ok:false,reason:'見た目の設定が違います'});
    // 結合できないので、越える延長は右隣を押し出す計画になる（clamp ではなく push）。
    expect(rippleTrimPlan(before,{type:'trim',clipId:left.id,edge:'end',frame:200,linked:true,ripple:true}))
      .toEqual({kind:'push',atFrame:150,delta:50});
    const next=applySequenceCommand(before,{type:'trim',clipId:left.id,edge:'end',frame:200,linked:true,ripple:true});
    // 右片は消えずに 50 だけ右へ動く（結合なら id ごと消えて表示設定が失われていた）。
    const survivor=next.clips.find(c=>c.id===right.id)!;
    expect(survivor.startFrame).toBe(200);
    expect(survivor.visual).toEqual(moved);
    expect(next.sequenceEndFrame).toBe(before.sequenceEndFrame+50);
  });

  /**
   * §4-5 の時計（Codex P2 2 巡目）。結合は L の時計だけを残すので、R の時計が「L を右片の開始分だけ
   * 進めたもの」でなければ R 区間の動きが黙って変わる。転換の追加→解除は片ごとに `clock.duration` を
   * 作り直すため、素材も表示設定も同じまま時計だけが食い違う文書ができる。
   */
  it('効果の時計が連続していれば結合でき、転換の追加→解除で総尺が割れた 2 片は結合しない',()=>{
    const source=fixture();
    source.clips.find(c=>c.id==='video')!.visual=
      {layout:structuredClone(DEFAULT_MAIN_LAYOUT),opacity:1,keyframes:[],motion:{preset:'zoomIn'}};
    const split=applySequenceCommand(source,{type:'split',clipIds:['video'],frame:100});
    const left=at(split,'v1',0),right=at(split,'v1',100);
    // (a) 回帰: 分割直後の 2 片は時計が連続している（split は offset を進めるだけ・commands.ts:125-129）。
    expect(split.clips.filter(c=>c.trackId==='v1').map(c=>c.clock.duration)).toEqual([r(300),r(300)]);
    expect(losslessJoin(split,left.id,right.id).ok).toBe(true);

    // (b) 転換を足して外すと、片ごとに clock.duration が作り直される（100 と 200 に割れる）。
    const joinKey=transitionJoins(split).find(join=>join.trackId==='v1')!.joinKey;
    const planned=planTransition(split,joinKey,'crossfade',20);
    if(!('transition' in planned))throw new Error('転換を計画できない前提が崩れています');
    const added=applySequenceCommand(split,{type:'set-transition',joinKey,transition:planned.transition});
    const before=applySequenceCommand(added,{type:'set-transition',joinKey,transition:null});
    const splitLeft=at(before,'v1',0),splitRight=at(before,'v1',100);
    // 前提の検算: 時計だけが食い違い、結合すると 150fr の倍率が 1.375 → 1.4 に変わる文書。
    expect([splitLeft.clock.duration,splitRight.clock.duration]).toEqual([r(100),r(200)]);
    expect(splitLeft.visual).toEqual(splitRight.visual);
    expect(sampleVisualTransform(splitRight,150).scale).toBeCloseTo(1.375,10);
    expect(sampleVisualTransform({...splitLeft,durationFrames:200},150).scale).toBeCloseTo(1.4,10);
    expect(losslessJoin(before,splitLeft.id,splitRight.id)).toEqual({ok:false,reason:'動きの時計が連続していません'});

    // (c) reducer 経由。終了端は押し出し、開始端は左隣の接点で止まる（結合には倒れない）。
    expect(rippleTrimPlan(before,{type:'trim',clipId:splitLeft.id,edge:'end',frame:101,linked:true,ripple:true}))
      .toEqual({kind:'push',atFrame:100,delta:1});
    expect(rippleTrimPlan(before,{type:'trim',clipId:splitRight.id,edge:'start',frame:99,linked:true,ripple:true}))
      .toEqual({kind:'clamp',frame:100});
    const next=applySequenceCommand(before,{type:'trim',clipId:splitLeft.id,edge:'end',frame:101,linked:true,ripple:true});
    expect(next.clips.filter(c=>c.trackId==='v1').map(c=>[c.startFrame,clipEnd(c)])).toEqual([[0,101],[101,301]]);
    // 右片は消えないので、その区間の動きは元のまま。
    expect(sampleVisualTransform(at(next,'v1',101),151).scale).toBeCloseTo(1.375,10);
  });
});
