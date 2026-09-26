import {describe,expect,it} from 'vitest';
import {clipEnd,type SequenceClip,type SequenceDocument} from './model';
import {rational as r} from './time';
import {fixture} from './fixtures';
import {applySequenceCommand} from './commands';
import {clipReferencePaths,losslessJoin,rebindClipReferences,rippleTrimPlan} from './rippleTrim';
import {DEFAULT_MAIN_LAYOUT} from '../mainLayout';

/** v1 の映像を 150 で分割した文書。左右は同じ出自・素材・連続した source を持つ（＝結合の条件を満たす）。 */
function splitAt150():SequenceDocument{return applySequenceCommand(fixture(),{type:'split',clipIds:['video'],frame:150});}
const onV1=(doc:SequenceDocument,startFrame:number)=>doc.clips.find(c=>c.trackId==='v1'&&c.startFrame===startFrame)!;
const onA1=(doc:SequenceDocument,startFrame:number)=>doc.clips.find(c=>c.trackId==='a1'&&c.startFrame===startFrame)!;
const trim=(clip:SequenceClip,edge:'start'|'end',frame:number,ripple=true)=>
  ({type:'trim',clipId:clip.id,edge,frame,linked:true,ripple}) as const;

describe('動作表（設計 §3）',()=>{
  it('ON・終了端・短く → 詰める（範囲は [newEnd, oldEnd)）',()=>{
    const doc=fixture(),video=doc.clips.find(c=>c.id==='video')!;
    // 導出: video は 0..300。終了端を 200 へ縮めると空く範囲は [200, clipEnd(video)=300)。
    expect(rippleTrimPlan(doc,trim(video,'end',200))).toEqual({kind:'close',startFrame:200,endFrame:300});
  });
  it('ON・開始端・短く（右へ） → 詰める（範囲は [oldStart, newStart)）',()=>{
    const doc=fixture(),video=doc.clips.find(c=>c.id==='video')!;
    // 導出: video.startFrame は 0。開始端を 40 へ動かすと空く範囲は [0, 40)。
    expect(rippleTrimPlan(doc,trim(video,'start',40))).toEqual({kind:'close',startFrame:0,endFrame:40});
  });
  it('ON・終了端・長く・右隣が続き → 結合（リンク音声つき）',()=>{
    const doc=splitAt150(),left=onV1(doc,0),right=onV1(doc,150);
    expect(rippleTrimPlan(doc,trim(left,'end',200)))
      .toEqual({kind:'join',leftId:left.id,rightId:right.id,audio:{leftId:onA1(doc,0).id,rightId:onA1(doc,150).id}});
  });
  it('ON・終了端・長く・右隣が続きだが更に越える → 結合＋残りを押し出す',()=>{
    const doc=splitAt150(),left=onV1(doc,0),right=onV1(doc,150);
    // 導出: 結合後の終端は clipEnd(right)=300。そこを 340 まで越えるので、300 から 40 を押し出す。
    expect(rippleTrimPlan(doc,trim(left,'end',340)))
      .toMatchObject({kind:'join',push:{atFrame:clipEnd(right),delta:340-clipEnd(right)}});
  });
  it('ON・終了端・長く・右隣が続きでない → 押し出す',()=>{
    // linked:false の分割は音声を割らない → §4-8（リンク音声 1 対 1）が欠ける → 結合しない。
    const doc=applySequenceCommand(fixture(),{type:'split',clipIds:['video'],frame:150,linked:false});
    // リンク音声を 150 で終える。押し出し点をまたぐ場合は §5 v2.3 で clamp（別テスト）。
    doc.clips.find(c=>c.id==='audio')!.durationFrames=150;
    const left=onV1(doc,0);
    // 導出: 右隣の開始は 150。終了端を 200 へ延ばすので delta = 200 − 150 = 50。
    expect(rippleTrimPlan(doc,trim(left,'end',200))).toEqual({kind:'push',atFrame:150,delta:50});
  });
  it('ON・終了端・長く・右隣が無い → 従来どおり伸びる',()=>{
    const doc=fixture(),music=doc.clips.find(c=>c.id==='music')!;
    expect(rippleTrimPlan(doc,trim(music,'end',400))).toEqual({kind:'plain'});
  });
  it('ON・開始端・長く・左隣が続き → 結合',()=>{
    const doc=splitAt150(),left=onV1(doc,0),right=onV1(doc,150);
    expect(rippleTrimPlan(doc,trim(right,'start',100)))
      .toMatchObject({kind:'join',leftId:left.id,rightId:right.id});
  });
  it('ON・開始端・長く・左隣が続きでない → 左隣の終端で止める（押し出さない）',()=>{
    const doc=applySequenceCommand(fixture(),{type:'split',clipIds:['video'],frame:150,linked:false});
    const right=onV1(doc,150);
    expect(rippleTrimPlan(doc,trim(right,'start',100))).toEqual({kind:'clamp',frame:150});
  });
  it('OFF・短く → 従来どおり（隙間が残る）',()=>{
    const doc=fixture(),video=doc.clips.find(c=>c.id==='video')!;
    expect(rippleTrimPlan(doc,trim(video,'end',200,false))).toEqual({kind:'plain'});
    expect(rippleTrimPlan(doc,trim(video,'start',40,false))).toEqual({kind:'plain'});
  });
  it('OFF・長く → 隣の手前で止める（結合しない）',()=>{
    const doc=splitAt150(),left=onV1(doc,0),right=onV1(doc,150);
    expect(rippleTrimPlan(doc,trim(left,'end',200,false))).toEqual({kind:'clamp',frame:150});
    expect(rippleTrimPlan(doc,trim(right,'start',100,false))).toEqual({kind:'clamp',frame:150});
  });
  it('端を動かさない指示は plain（reducer の delta===0 と同じ扱い）',()=>{
    const doc=fixture(),video=doc.clips.find(c=>c.id==='video')!;
    expect(rippleTrimPlan(doc,trim(video,'end',clipEnd(video)))).toEqual({kind:'plain'});
  });
});

/** v1 に別素材（asset/streamIndex とも違う・continuationGroupId 無し）の隣を置いた文書。
 * §4-2（出自）と §4-3（素材）が split linked:false とは独立に落ちる「続きでない隣」を作る。 */
function differentAssetNeighbourFixture():SequenceDocument{
  const doc=fixture();
  doc.assets.push({id:'other',kind:'media',file:'public/other.mp4',name:'別素材',fingerprint:'other-source',
    streams:[{index:0,kind:'video',codec:'h264',duration:r(60),frameRate:r(30),width:1920,height:1080}]});
  const video=doc.clips.find(c=>c.id==='video')!;
  video.durationFrames=150;video.continuationGroupId='g';
  // リンク音声も 150 で終える。押し出し点をまたぐと §5 v2.3 で clamp へ倒れ、この文書が見たい
  // 「続きでない隣＝押し出し」の行を検証できなくなるため（はみ出す場合は専用のテストがある）。
  doc.clips.find(c=>c.id==='audio')!.durationFrames=150;
  doc.clips.push({id:'video2',name:'別素材',trackId:'v1',startFrame:150,durationFrames:150,
    clock:{offset:r(0),rate:r(1),duration:r(150)},
    content:{kind:'video',assetId:'other',streamIndex:0,sourceIn:r(0),rate:r(1)}});
  return doc;
}

describe('動作表: split linked:false 以外で作った「続きでない隣」（Important 2）',()=>{
  it('別素材の右隣 → 押し出す',()=>{
    const doc=differentAssetNeighbourFixture(),video=doc.clips.find(c=>c.id==='video')!;
    expect(rippleTrimPlan(doc,trim(video,'end',200))).toEqual({kind:'push',atFrame:150,delta:50});
  });
  it('別素材の左隣 → 隣の終端で止める（押し出さない）',()=>{
    const doc=differentAssetNeighbourFixture(),video2=doc.clips.find(c=>c.id==='video2')!;
    expect(rippleTrimPlan(doc,trim(video2,'start',100))).toEqual({kind:'clamp',frame:150});
  });
});

describe('最小長ガード（Important 4）',()=>{
  it('終了端: 新しい終端が開始端以下 → invalid',()=>{
    const doc=fixture(),video=doc.clips.find(c=>c.id==='video')!;
    expect(rippleTrimPlan(doc,trim(video,'end',0))).toEqual({kind:'reject',reason:'invalid'});
  });
  it('開始端: 新しい開始が終了端以上 → invalid',()=>{
    const doc=fixture(),video=doc.clips.find(c=>c.id==='video')!;
    expect(rippleTrimPlan(doc,trim(video,'start',300))).toEqual({kind:'reject',reason:'invalid'});
  });
  it('終了端: 新しい終端が開始端+1 なら close（境界の対称受理）',()=>{
    const doc=fixture(),video=doc.clips.find(c=>c.id==='video')!;
    expect(rippleTrimPlan(doc,trim(video,'end',1))).toEqual({kind:'close',startFrame:1,endFrame:300});
  });
  it('開始端: 新しい開始が終了端-1 なら close（境界の対称受理）',()=>{
    const doc=fixture(),video=doc.clips.find(c=>c.id==='video')!;
    expect(rippleTrimPlan(doc,trim(video,'start',299))).toEqual({kind:'close',startFrame:0,endFrame:299});
  });
});

describe('性能（Important 3・§6 のドラッグ中評価に耐える）',()=>{
  it('1000 字幕（実 anchor 付き）・archive 100 エントリ×5 クリップの文書でも rippleTrimPlan は速い（200 回で 1 秒未満・flaky な単発計測を避ける）',()=>{
    const doc=splitAt150();
    doc.clips.push(...Array.from({length:1000},(_,i)=>({
      id:`caption-${i}`,name:'字幕',trackId:'v2',startFrame:i,durationFrames:1,
      clock:{offset:r(0),rate:r(1),duration:r(1)},
      content:{kind:'telop',data:{text:'x'}},
      anchor:{kind:'source',role:'speech',sourceAssetId:'source',clipOccurrenceId:'audio',sourceStart:r(i),sourceEnd:r(i+1)},
    } as SequenceClip)));
    doc.cutArchive={version:1,entries:Array.from({length:100},(_,i)=>({
      id:`cut-${i}`,durationFrames:10,completionFloorFrames:10,
      origin:{cutId:`cut-${i}`,startFrame:2000+i*10,endFrame:2000+i*10+10},
      boundary:{references:[],hintFrame:2000+i*10,ambiguous:false},
      clips:Array.from({length:5},(_,j)=>({
        id:`archived-${i}-${j}`,name:'保存済み',trackId:'v1',startFrame:j,durationFrames:1,
        clock:{offset:r(0),rate:r(1),duration:r(1)},
        content:{kind:'video',assetId:'source',streamIndex:0,sourceIn:r(j),rate:r(1)},
      } as SequenceClip)),
      tracks:[],
    }))};
    const left=onV1(doc,0),iterations=200;
    const start=performance.now();
    for(let i=0;i<iterations;i++)rippleTrimPlan(doc,trim(left,'end',200));
    expect(performance.now()-start).toBeLessThan(1000);
  });
});

describe('§4 無損失結合の 9 条件（1 つ欠けると結合しない・reason で証明する）',()=>{
  const joinable=()=>{const doc=splitAt150();return {doc,left:onV1(doc,0),right:onV1(doc,150)};};
  it('すべて満たすとき ok',()=>{
    const {doc,left,right}=joinable();
    expect(losslessJoin(doc,left.id,right.id)).toMatchObject({ok:true});
  });
  it('1 時間上で隣接していない（隙間）',()=>{
    const {doc,left,right}=joinable();
    doc.clips.find(c=>c.id===right.id)!.startFrame=160;
    expect(losslessJoin(doc,left.id,right.id)).toMatchObject({ok:false,reason:'時間上で隣接していません'});
  });
  it('2 出自（continuationGroupId）が違う',()=>{
    const {doc,left,right}=joinable();
    delete doc.clips.find(c=>c.id===right.id)!.continuationGroupId;
    expect(losslessJoin(doc,left.id,right.id)).toMatchObject({ok:false,reason:'同じ分割から生まれたクリップではありません'});
  });
  it('3 素材（assetId）だけが違う（sourceIn は連続・content は同一のまま）',()=>{
    const {doc,left,right}=joinable();
    // assetId だけを変える。rate/sourceIn/content の他フィールドは触らないので条件 4・5・6 は満たしたまま。
    (doc.clips.find(c=>c.id===right.id)!.content as {assetId:string}).assetId='other-asset';
    expect(losslessJoin(doc,left.id,right.id)).toMatchObject({ok:false,reason:'素材が違います'});
  });
  it('4 source が連続していない（assetId/rate/content は同一のまま）',()=>{
    const {doc,left,right}=joinable();
    (doc.clips.find(c=>c.id===right.id)!.content as {sourceIn:unknown}).sourceIn=r(7);
    expect(losslessJoin(doc,left.id,right.id)).toMatchObject({ok:false,reason:'元素材が連続していません'});
  });
  it('5a 編集内容（content の sourceIn 以外）が違う',()=>{
    const {doc,left,right}=joinable();
    (doc.clips.find(c=>c.id===right.id)!.content as {endBehavior?:string}).endBehavior='hold';
    expect(losslessJoin(doc,left.id,right.id)).toMatchObject({ok:false,reason:'編集内容が違います'});
  });
  it('5b キーフレームがある',()=>{
    const {doc,left,right}=joinable();
    doc.clips.find(c=>c.id===right.id)!.visual={layout:{} as never,opacity:1,keyframes:[{frame:r(0),value:{opacity:0}}]};
    expect(losslessJoin(doc,left.id,right.id)).toMatchObject({ok:false,reason:'動きのキーフレームがあります'});
  });
  it('5c 静的な表示設定（位置・拡大・不透明度）が違う（Codex P1）',()=>{
    const {doc,left,right}=joinable();
    const base=():NonNullable<SequenceClip['visual']>=>({layout:structuredClone(DEFAULT_MAIN_LAYOUT),opacity:1,keyframes:[]});
    doc.clips.find(c=>c.id===left.id)!.visual=base();
    const moved=base();moved.layout.position={x:0.25,y:0};
    doc.clips.find(c=>c.id===right.id)!.visual=moved;
    expect(losslessJoin(doc,left.id,right.id)).toMatchObject({ok:false,reason:'見た目の設定が違います'});
    // 同じ設定に戻すと通る＝この条件だけで落ちていた証拠（キーフレーム側の行に巻き込まれていない）。
    doc.clips.find(c=>c.id===right.id)!.visual=base();
    expect(losslessJoin(doc,left.id,right.id)).toMatchObject({ok:true});
    // 不透明度・拡大でも同じ理由で落ちる。
    doc.clips.find(c=>c.id===right.id)!.visual={...base(),opacity:0.5};
    expect(losslessJoin(doc,left.id,right.id)).toMatchObject({ok:false,reason:'見た目の設定が違います'});
  });
  it('6 速度登録がある',()=>{
    const {doc,left,right}=joinable();doc.speed={version:2,family:'native-exact-v1',groupId:'g',originFrame:0,
      fpsBasis:r(30),globalRate:r(1),sequenceEndBasis:{kind:'main-offset',offsetFrames:0}};
    expect(losslessJoin(doc,left.id,right.id)).toMatchObject({ok:false,reason:'速度登録がある案件では結合しません'});
  });
  it('7 転換・場面フェードが L または R を参照している',()=>{
    const {doc,left,right}=joinable();
    doc.transitions=[{id:'t',trackId:'v1',outClipId:right.id,kind:'fadeBlack',startFrame:280,durationFrames:10,edge:'out'}];
    expect(losslessJoin(doc,left.id,right.id)).toMatchObject({ok:false,reason:'転換が掛かっています'});
  });
  it('8 リンク音声が 1 対 1 で対応しない',()=>{
    const {doc,left,right}=joinable();
    doc.clips=doc.clips.filter(c=>c.id!==onA1(doc,150).id);
    expect(losslessJoin(doc,left.id,right.id)).toMatchObject({ok:false,reason:'リンク音声が 1 対 1 で対応しません'});
  });
  it('8b リンク音声が別のトラックにある（Codex P2）',()=>{
    const {doc,left,right}=joinable();
    // 右側の音声だけを別の音声トラック（a2）へ移す。リンクも出自も素材も連続性もそのまま。
    doc.clips.find(c=>c.id===onA1(doc,150).id)!.trackId='a2';
    expect(losslessJoin(doc,left.id,right.id)).toMatchObject({ok:false,reason:'リンク音声が別のトラックにあります'});
  });
  it('9 付け替えできない参照が R に残る',()=>{
    const {doc,left,right}=joinable();
    doc.clips.find(c=>c.id===left.id)!.legacyAudioContinuity={version:1,sourceFingerprint:'f',ownerClipId:right.id};
    expect(clipReferencePaths(doc,right.id).length).toBeGreaterThan(0);
    expect(losslessJoin(doc,left.id,right.id)).toMatchObject({ok:false,reason:'付け替えられない参照があります'});
  });
  it('cut archive がある文書でも、1〜8 を満たすペアは結合できる（archive スナップショット自身の id は参照ではない）',()=>{
    // 修正前は cutArchive.entries[].clips[].id を「付け替え不能な参照」と誤認し、常に ok:false に倒れていた。
    const split=applySequenceCommand(fixture(),{type:'split',clipIds:['video'],frame:150});
    const doc=applySequenceCommand(split,{type:'ripple-delete',startFrame:280,endFrame:300});
    expect(doc.cutArchive?.entries.length??0).toBeGreaterThan(0);
    const left=onV1(doc,0),right=onV1(doc,150);
    expect(clipReferencePaths(doc,right.id)).toEqual([]);
    expect(losslessJoin(doc,left.id,right.id)).toMatchObject({ok:true});
  });
  it('9（保険） 既知フィールドに無い未知の参照でも結合しない',()=>{
    // clipReferencePaths が知らない将来のフィールドを模す。汎用 walk の最後の保険が効いていることの証拠。
    const {doc,left,right}=joinable();
    (doc as unknown as {futureNotes:Array<{clipId:string}>}).futureNotes=[{clipId:right.id}];
    expect(clipReferencePaths(doc,right.id)).toEqual([]);
    expect(losslessJoin(doc,left.id,right.id)).toMatchObject({ok:false,reason:'unknown-reference'});
  });
});

describe('reject',()=>{
  it('詰める範囲に転換が掛かると transition',()=>{
    const doc=fixture(),video=doc.clips.find(c=>c.id==='video')!;
    doc.transitions=[{id:'t',trackId:'v1',outClipId:'video',kind:'fadeBlack',startFrame:210,durationFrames:20,edge:'out'}];
    expect(rippleTrimPlan(doc,trim(video,'end',200))).toEqual({kind:'reject',reason:'transition'});
  });
  it('動かす／切るクリップが固定挿入（insertOwnSpeed）を持つと speed',()=>{
    const doc=applySequenceCommand(fixture(),{type:'split',clipIds:['video'],frame:150,linked:false});
    doc.clips.find(c=>c.trackId==='v1'&&c.startFrame===150)!.insertOwnSpeed={version:1,
      placement:{startFrame:150,exposure:r(5)},rate:r(1),
      source:{assetId:'source',streamIndex:0,sourceStart:r(5),sourceEnd:r(10)},
      clock:{offset:r(0),slope:r(1),duration:r(150)}};
    expect(rippleTrimPlan(doc,trim(onV1(doc,0),'end',200))).toEqual({kind:'reject',reason:'speed'});
  });
  it('対象が見つからない・媒体でないと invalid',()=>{
    const doc=fixture();
    expect(rippleTrimPlan(doc,{type:'trim',clipId:'missing',edge:'end',frame:10,ripple:true})).toEqual({kind:'reject',reason:'invalid'});
  });
});

describe('rebindClipReferences',()=>{
  it('字幕 anchor と復元境界の参照を付け替え、入力を変えない',()=>{
    const doc=applySequenceCommand(fixture(),{type:'ripple-delete',startFrame:280,endFrame:300});
    const before=structuredClone(doc);
    const entry=doc.cutArchive!.entries[0]!,reference=entry.boundary.references[0]!;
    const next=rebindClipReferences(doc,reference.clipId,'telop');
    expect(next.cutArchive!.entries[0]!.boundary.references.map(v=>v.clipId)).toContain('telop');
    expect(doc).toEqual(before);
  });
});

describe('尺より後ろへ伸びたクリップの終端短縮（裁定 3）',()=>{
  it('取り除く範囲は sequenceEndFrame で上限になる',()=>{
    // 導出: music は [0,360)、sequenceEndFrame は 300（意図的に隠した尻尾）。
    //       250 まで縮めると生の範囲は [250,360) だが、尺の外は詰める対象が無いので [250,300)。
    expect(rippleTrimPlan(fixture(),{type:'trim',clipId:'music',edge:'end',frame:250,ripple:true}))
      .toEqual({kind:'close',startFrame:250,endFrame:300});
  });
  it('上限を掛けた結果が空なら従来 trim へ落ちる',()=>{
    // 導出: 320 まで縮めると生の範囲は [320,360) で、尺 300 より後ろだけ。詰める対象が無い＝plain。
    expect(rippleTrimPlan(fixture(),{type:'trim',clipId:'music',edge:'end',frame:320,ripple:true}))
      .toEqual({kind:'plain'});
  });
});

describe('速度を登録したクリップ自身の端（裁定 4）',()=>{
  const registered=()=>applySequenceCommand(fixture(),{type:'register-native-speed',groupId:'g1',
    mainClipIds:['video'],mainAudioBindings:[{audioClipId:'audio',providerId:'video'}]});
  it('登録クリップの端は reject:speed（従来 trim に落とす）',()=>{
    const doc=registered();
    // 検算: register-native-speed は video を speed.kind='main'、audio を 'main-audio' にする。
    expect(doc.clips.find(c=>c.id==='video')!.speed).toBeDefined();
    expect(rippleTrimPlan(doc,{type:'trim',clipId:'video',edge:'end',frame:250,ripple:true}))
      .toEqual({kind:'reject',reason:'speed'});
  });
  it('同じ案件でも登録されていないクリップは詰められる',()=>{
    // 導出: music は speed を持たない。範囲は [250,360) → 尺 300 で上限 → [250,300)。
    expect(rippleTrimPlan(registered(),{type:'trim',clipId:'music',edge:'end',frame:250,ripple:true}))
      .toEqual({kind:'close',startFrame:250,endFrame:300});
  });
  it('ripple を送らなければ登録クリップでも従来どおり（plain／clamp）',()=>{
    expect(rippleTrimPlan(registered(),{type:'trim',clipId:'video',edge:'end',frame:250})).toEqual({kind:'plain'});
  });
});

/** 150 で分割 → 末尾 [280,300) を詰める。結合可能な L/R を持つ基準文書。 */
const splitThenCut=()=>applySequenceCommand(
  applySequenceCommand(fixture(),{type:'split',clipIds:['video'],frame:150}),
  {type:'ripple-delete',startFrame:280,endFrame:300});
const pair=(doc:SequenceDocument)=>({
  left:doc.clips.find(c=>c.trackId==='v1'&&c.startFrame===0)!,
  right:doc.clips.find(c=>c.trackId==='v1'&&c.startFrame===150)!});

describe('§4-9 の追加条件（裁定 6・7）',()=>{
  it('基準の文書は結合できる（この土台が崩れたら以下は無効）',()=>{
    const doc=splitThenCut(),{left,right}=pair(doc);
    // 検算: 末尾カットの境界参照は R を edge:'end' で指すだけ（実測）＝付け替えで意味が保てる形。
    expect(doc.cutArchive!.entries[0]!.boundary.references.filter(v=>v.clipId===right.id))
      .toEqual([{clipId:right.id,edge:'end',offsetFrames:0}]);
    expect(losslessJoin(doc,left.id,right.id)).toMatchObject({ok:true});
  });
  it('R を edge:start で指す境界参照があれば結合しない（裁定 6）',()=>{
    const doc=splitThenCut(),{left,right}=pair(doc);
    doc.cutArchive!.entries[0]!.boundary.references.push({clipId:right.id,edge:'start',offsetFrames:0});
    expect(losslessJoin(doc,left.id,right.id))
      .toEqual({ok:false,reason:'復元記録の境界が結合で動く端を指しています'});
  });
  it('L を edge:end で指す境界参照があれば結合しない（裁定 6）',()=>{
    const doc=splitThenCut(),{left,right}=pair(doc);
    doc.cutArchive!.entries[0]!.boundary.references.push({clipId:left.id,edge:'end',offsetFrames:0});
    expect(losslessJoin(doc,left.id,right.id))
      .toEqual({ok:false,reason:'復元記録の境界が結合で動く端を指しています'});
  });
  it('復元記録の中の字幕が R・A_R を指すなら結合しない（裁定 7）',()=>{
    // 到達可能な作り方: 右片の中を詰めると、保存された字幕断片が「生きている A_R」を指す。
    const doc=applySequenceCommand(
      applySequenceCommand(fixture(),{type:'split',clipIds:['video'],frame:150}),
      {type:'ripple-delete',startFrame:200,endFrame:240});
    const {left,right}=pair(doc);
    const audioRight=doc.clips.find(c=>c.trackId==='a1'&&c.startFrame===150)!;
    // 検算: スナップショットの字幕断片の anchor が A_R を指している（実測）。
    expect(doc.cutArchive!.entries[0]!.clips.some(c=>c.anchor?.kind==='source'&&c.anchor.clipOccurrenceId===audioRight.id)).toBe(true);
    expect(clipReferencePaths(doc,audioRight.id).length).toBeGreaterThan(0);
    expect(losslessJoin(doc,left.id,right.id)).toMatchObject({ok:false});
    // 計画は押し出しへ倒れる（§4「1 つでも欠ければ押し出し」）。
    expect(rippleTrimPlan(doc,{type:'trim',clipId:left.id,edge:'end',frame:180,ripple:true}))
      .toEqual({kind:'push',atFrame:150,delta:30});
  });
});

describe('linked:false では結合しない（裁定 8）',()=>{
  it('終了端は押し出しへ、開始端は左隣の終端で止める',()=>{
    const doc=splitThenCut(),{left,right}=pair(doc);
    expect(rippleTrimPlan(doc,{type:'trim',clipId:left.id,edge:'end',frame:200,ripple:true,linked:false}))
      .toEqual({kind:'push',atFrame:150,delta:50});      // 導出: 右隣の開始 150、200 − 150 = 50
    expect(rippleTrimPlan(doc,{type:'trim',clipId:right.id,edge:'start',frame:100,ripple:true,linked:false}))
      .toEqual({kind:'clamp',frame:150});                // 導出: 左隣の終端 150
  });
});
