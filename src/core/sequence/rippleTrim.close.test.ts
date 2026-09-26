import {describe,expect,it} from 'vitest';
import {applySequenceCommand} from './commands';
import {type SequenceDocument} from './model';
import {fixture} from './fixtures';
import {SequenceSession} from './session';
import {rational as r} from './time';
import {sequenceContentBytes} from './validate';

const on=(doc:SequenceDocument,trackId:string)=>doc.clips.filter(c=>c.trackId===trackId).sort((a,b)=>a.startFrame-b.startFrame);

/** 固定挿入（insertOwnSpeed）のある文書。挿入より**後ろ**を詰めるので計画は reject:'speed' にならない。
 *  iv/ia を [0,5) へ寄せ、通常クリップ ov を [5,10) に置く（fps=1・sequenceEndFrame=10）。 */
function ownFixtureWithOrdinaryTail():SequenceDocument{
  const clock=(offset:number,rate:number,duration:number)=>({offset:r(offset),rate:r(rate),duration:r(duration)});
  const doc:SequenceDocument={schemaVersion:2,id:'own-close',name:'挿入',revision:0,fps:r(1),
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
  return applySequenceCommand(doc,{type:'register-native-insert-own-speed',clipId:'iv',linked:true});
}

describe('trim の ripple: 詰める',()=>{
  it('終了端の短縮が全トラックを詰め、またぐ字幕が切れ、復元記録が 1 件増える',()=>{
    const before=fixture();
    const next=applySequenceCommand(before,{type:'trim',clipId:'video',edge:'end',frame:200,ripple:true});
    // 導出（設計 §3 ON・終了端・短く ＝ ripple-delete(200,300)）:
    //   sequenceEndFrame 300 − (300 − 200) = 200
    expect(next.sequenceEndFrame).toBe(200);
    //   video は 0..300 → [0,200)。telop は 30..270 → [30,200) なので 170fr。
    expect(on(next,'v1')[0]!.durationFrames).toBe(200);
    expect(next.clips.find(c=>c.trackId==='v2')!.durationFrames).toBe(170);
    //   music は 0..360 で [200,300) をまたぐので 2 片（[0,200) と 300..360 が 200 へ寄る＝60fr）。
    expect(on(next,'a2').map(c=>[c.startFrame,c.durationFrames])).toEqual([[0,200],[200,60]]);
    //   復元記録は 1 件。中身は「操作前の文書」から切り出した 100fr（= 300 − 200）。
    expect(next.cutArchive!.entries).toHaveLength(1);
    expect(next.cutArchive!.entries[0]!.origin).toMatchObject({startFrame:200,endFrame:300});
    expect(next.cutArchive!.entries[0]!.durationFrames).toBe(100);
  });
  it('固定挿入のある文書でも ripple-delete と 1 バイト一致する（後処理まで同じ経路の証拠）',()=>{
    const before=ownFixtureWithOrdinaryTail();
    // 検算: 挿入は [0,5)、通常クリップ ov は [5,10)、insertOwnSpeed.endFloor は 10。
    expect(before.insertOwnSpeed!.endFloor).toBe(10);
    const byTrim=applySequenceCommand(before,{type:'trim',clipId:'ov',edge:'end',frame:7,ripple:true});
    const byCut=applySequenceCommand(before,{type:'ripple-delete',startFrame:7,endFrame:10});
    expect(sequenceContentBytes(byTrim)).toBe(sequenceContentBytes(byCut));
    // 偽証拠よけ: 従来 trim とは**違う**こと（endFloor 10 のまま・尺 10 のまま）を同時に固定する。
    const byPlain=applySequenceCommand(before,{type:'trim',clipId:'ov',edge:'end',frame:7});
    expect(byPlain.insertOwnSpeed!.endFloor).toBe(10);
    expect(byPlain.sequenceEndFrame).toBe(10);
    expect(byTrim.insertOwnSpeed!.endFloor).toBe(7);
    expect(byTrim.sequenceEndFrame).toBe(7);
  });
  it('開始端の短縮は [oldStart, newStart) を詰め、対象の開始位置が元へ戻る',()=>{
    const next=applySequenceCommand(fixture(),{type:'trim',clipId:'video',edge:'start',frame:40,ripple:true});
    // 導出: 範囲 [0,40) を詰めるので全体は 300 − 40 = 260、video は 0 から始まり 300 − 40 = 260fr。
    expect(next.sequenceEndFrame).toBe(260);
    expect(on(next,'v1')[0]!.startFrame).toBe(0);
    expect(on(next,'v1')[0]!.durationFrames).toBe(260);
  });
  it('反対の端を越える指示は INVALID_RANGE で文書不変（裁定 2）',()=>{
    const before=fixture(),snapshot=structuredClone(before);
    // 導出: video は [0,300)。終了端を 0 にすると長さ 0。従来 trim の INVALID_RANGE と同じ文言。
    expect(()=>applySequenceCommand(before,{type:'trim',clipId:'video',edge:'end',frame:0,ripple:true}))
      .toThrow(/1フレーム以上/);
    expect(before).toEqual(snapshot);
  });
  it('尺の外だけの短縮は詰めずに従来 trim と同じ結果になる（裁定 3）',()=>{
    const before=fixture();
    const rippled=applySequenceCommand(before,{type:'trim',clipId:'music',edge:'end',frame:320,ripple:true});
    const plain=applySequenceCommand(before,{type:'trim',clipId:'music',edge:'end',frame:320});
    expect(sequenceContentBytes(rippled)).toBe(sequenceContentBytes(plain));
    expect(rippled.cutArchive).toBeUndefined();
    // 導出: 従来 trim は選択クリップの終端まで尺を広げるので 300 → 320、music は [0,320)。
    expect(rippled.sequenceEndFrame).toBe(320);
    expect(rippled.clips.find(c=>c.id==='music')!.durationFrames).toBe(320);
  });
  it('尺をまたぐ短縮は尺内だけを詰める（裁定 3）',()=>{
    const before=fixture();
    const rippled=applySequenceCommand(before,{type:'trim',clipId:'music',edge:'end',frame:250,ripple:true});
    // 導出: 生の範囲 [250,360) に尺 300 の上限 → [250,300) ＝ ripple-delete(250,300)。
    expect(sequenceContentBytes(rippled))
      .toBe(sequenceContentBytes(applySequenceCommand(before,{type:'ripple-delete',startFrame:250,endFrame:300})));
    expect(rippled.sequenceEndFrame).toBe(250);
    // music は [0,250) と、300..360 が 250 へ寄った 60fr の 2 片。
    expect(on(rippled,'a2').map(c=>[c.startFrame,c.durationFrames])).toEqual([[0,250],[250,60]]);
  });
  it('速度を登録したクリップ自身の端は INVALID_RANGE で文書不変（裁定 4）',()=>{
    const before=applySequenceCommand(fixture(),{type:'register-native-speed',groupId:'g1',
      mainClipIds:['video'],mainAudioBindings:[{audioClipId:'audio',providerId:'video'}]});
    const snapshot=structuredClone(before);
    expect(()=>applySequenceCommand(before,{type:'trim',clipId:'video',edge:'end',frame:250,ripple:true}))
      .toThrow(/速度/);
    expect(before).toEqual(snapshot);
    // 同じ案件でも登録されていない music は詰められる（§7(7)）。
    const next=applySequenceCommand(before,{type:'trim',clipId:'music',edge:'end',frame:250,ripple:true});
    expect(next.speed).toBeDefined();
    expect(next.sequenceEndFrame).toBe(250);
  });
  it('存在しない clipId は MISSING_TARGET のまま（計画の invalid に吸われない）',()=>{
    expect(()=>applySequenceCommand(fixture(),{type:'trim',clipId:'missing',edge:'end',frame:100,ripple:true}))
      .toThrow(/対象のクリップが見つかりません/);
  });
  it('転換が掛かる範囲は TRANSITION_INTERSECTION で文書不変',()=>{
    const before=fixture();
    before.transitions=[{id:'t',trackId:'v1',outClipId:'video',kind:'fadeBlack',startFrame:210,durationFrames:20,edge:'out'}];
    const snapshot=structuredClone(before);
    expect(()=>applySequenceCommand(before,{type:'trim',clipId:'video',edge:'end',frame:200,ripple:true}))
      .toThrow(/転換|フェード/);
    expect(before).toEqual(snapshot);
  });
  it('ripple を省略すると従来どおり（隙間が残る）',()=>{
    const next=applySequenceCommand(fixture(),{type:'trim',clipId:'video',edge:'end',frame:200});
    expect(next.sequenceEndFrame).toBe(300);
    expect(next.cutArchive).toBeUndefined();
    expect(on(next,'v1')[0]!.durationFrames).toBe(200);
  });
  it('リンク音声が押し出し点をまたぐ文書では押し出さず止める（§5 v2.3・レビュー Important 1）',()=>{
    // 導出: linked:false の分割は音声を割らないので、左片のリンク相手 [0,300) が押し出し点 150 を
    // またぐ。押し出すと音声だけ据え置かれて編集点より後ろがずれるので、v1 は clamp へ倒す。
    const before=applySequenceCommand(fixture(),{type:'split',clipIds:['video'],frame:150,linked:false});
    const left=before.clips.find(c=>c.trackId==='v1'&&c.startFrame===0)!;
    const next=applySequenceCommand(before,{type:'trim',clipId:left.id,edge:'end',frame:200,ripple:true});
    const span=(doc:SequenceDocument,trackId:string)=>on(doc,trackId).map(c=>[c.startFrame,c.startFrame+c.durationFrames]);
    // clamp 先は右隣の開始 150＝現在の終端なので、どのトラックも 1 フレームも動かない。
    // 押し出していれば v1 は [[0,200],[200,350]]、a1 は [0,350)、尺は 350 になる。
    expect(span(next,'v1')).toEqual([[0,150],[150,300]]);
    expect(span(next,'a1')).toEqual([[0,300]]);
    expect(span(next,'v2')).toEqual(span(before,'v2'));
    expect(next.sequenceEndFrame).toBe(300);
    expect(next.cutArchive).toBeUndefined();
    // 隣が無ければ従来どおり伸びる（設計 §3「右隣が無ければ従来どおり伸びる」）。
    expect(applySequenceCommand(fixture(),{type:'trim',clipId:'video',edge:'end',frame:340,ripple:true})
      .clips.find(c=>c.id==='video')!.durationFrames).toBe(340);
  });
  it('Undo 1 回で文書・復元記録・速度データが元に戻る（設計 §7(8)）',()=>{
    const before=fixture(),session=new SequenceSession('close',before);
    session.execute({sessionId:session.id,expectedRevision:before.revision,executionId:'close',
      command:{type:'trim',clipId:'video',edge:'end',frame:200,ripple:true}});
    expect(session.document.cutArchive!.entries).toHaveLength(1);
    expect(session.document.sequenceEndFrame).toBe(200);
    session.execute({sessionId:session.id,expectedRevision:session.document.revision,executionId:'undo',
      command:{type:'undo'}});
    expect(sequenceContentBytes(session.document)).toBe(sequenceContentBytes(before));
  });
});
