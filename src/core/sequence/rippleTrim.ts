import {clipEnd,isMediaContent,sourceTimeAt,type ClipContent,type ClipVisual,type EffectClock,type SequenceClip,type SequenceDocument} from './model';
import {addTime,compareTime,multiplyTime,rational} from './time';

/** `ripple` は文書コマンドの一部。省略＝false＝従来動作（既存呼び出しは 1 文字も変わらない）。 */
export interface TrimCommand { type:'trim'; clipId:string; edge:'start'|'end'; frame:number; linked?:boolean; ripple?:boolean }

export type RippleTrimPlan =
  | {kind:'plain'}
  | {kind:'close';startFrame:number;endFrame:number}
  | {kind:'join';leftId:string;rightId:string;audio?:{leftId:string;rightId:string};push?:{atFrame:number;delta:number}}
  | {kind:'push';atFrame:number;delta:number}
  // `reason:'linked-overhang'` は §5 v2.3 の裁定: 一緒に延長されるクリップが押し出し点をまたぐので止めた。
  // `reason:'fixed-insert-length'` は §5 v2.4 の裁定: 固定挿入のある案件では押し出した長さを保てないので止めた。
  | {kind:'clamp';frame:number;reason?:'linked-overhang'|'fixed-insert-length'}
  | {kind:'reject';reason:'transition'|'speed'|'invalid'};

const overlaps=(a:number,b:number,c:number,d:number)=>a<d&&c<b;
/** 境界をまたぐか（端が一致するだけは「またぐ」ではない）。 */
const straddles=(clip:SequenceClip,frame:number)=>clip.startFrame<frame&&frame<clipEnd(clip);

/** content の比較から source の入口だけを外す。ここを変えるときは §4-5 の意味も変わる。 */
function contentWithoutSource(content:ClipContent):unknown{
  if(!isMediaContent(content))return content;
  const {sourceIn:_ignored,...rest}=content;return rest;
}

/**
 * §4-5 の後半。`visual` の**静的な**表示設定（位置・拡大・不透明度・色補正・LUT・出入りのアニメ等）。
 * 外すのは 2 つだけ:
 * - `keyframes`: 有無そのものを別行で断っている（動きがあれば結合しない）。
 * - `keyframeClock`: `split` が切れ目ごとに `offset` をずらす（commands.ts:126-128）ので、
 *   分割直後の 2 片でも必ず食い違う。単純一致では見られないが、素通しにもしない —
 *   `clockContinues` が「左の時計を右片の開始分だけ進めたもの」かを別途検査する。
 * どちらか片方にだけ `visual` がある場合も「違う」と判定する（安全側）。
 */
function visualWithoutKeyframes(visual:ClipVisual|undefined):unknown{
  if(!visual)return undefined;
  const {keyframes:_keys,keyframeClock:_clock,...rest}=visual;return rest;
}

/**
 * §4-5 の時計。結合は L を伸ばして R を消す＝**L の時計だけが残る**ので、R 区間の効果（モーション
 * プリセット・キーフレーム）の値が変わらないためには、R の時計が「L の時計を右片の開始位置分だけ
 * 進めたもの」でなければならない。`split` が両片へ付ける形（commands.ts:125-129 の
 * `offset + (slice.from - startFrame) * rate`）がちょうどこれなので、分割直後の 2 片は必ず通る。
 * 転換の追加→解除のように総尺（`duration`）だけが片側で作り直された文書は通さない（Codex P2 2 巡目:
 * 左右の `duration` が 100／200 に割れた状態で結合すると 150fr の倍率が 1.375→1.4 へ変わった）。
 * 片側にだけ時計がある（`keyframeClock`）場合も「連続していない」と見る（安全側）。
 */
function clockContinues(left:EffectClock|undefined,right:EffectClock|undefined,leftStart:number,rightStart:number):boolean{
  if(left===undefined||right===undefined)return left===undefined&&right===undefined;
  if(compareTime(left.rate,right.rate)!==0||compareTime(left.duration,right.duration)!==0)return false;
  return compareTime(addTime(left.offset,multiplyTime(rational(rightStart-leftStart),left.rate)),right.offset)===0;
}

/** キー順に依存しない深い比較（JSON 化できる値だけを持つ設定オブジェクト用）。 */
function sameSettings(a:unknown,b:unknown):boolean{
  const normalize=(value:unknown):unknown=>{
    if(Array.isArray(value))return value.map(normalize);
    if(value&&typeof value==='object')return Object.entries(value as Record<string,unknown>)
      .filter(([,item])=>item!==undefined).sort(([x],[y])=>x<y?-1:x>y?1:0)
      .map(([key,item])=>[key,normalize(item)]);
    return value;
  };
  return JSON.stringify(normalize(a))===JSON.stringify(normalize(b));
}

/**
 * 1 本のクリップ（生きているものでも cut archive に保存されたスナップショットでも）が
 * 持ちうる「他クリップへの参照」フィールドを列挙する。クリップ自身の `id` と `anchor.clipOccurrenceId`
 * はここに含めない — 生きた文書側の anchor は `rebindClipReferences` が付け替える対象であり、
 * 「付け替え不能な参照」ではない。archive スナップショット側の anchor は付け替えられないので
 * 参照として数えるが、それは呼び出し側（`clipReferencePaths`）が足す（裁定 7）。
 */
function referencesInClip(clip:SequenceClip,clipId:string,path:string):string[]{
  const found:string[]=[];
  if(clip.legacyAudioContinuity?.ownerClipId===clipId)found.push(`${path}.legacyAudioContinuity.ownerClipId`);
  const caption=clip.legacyCaptionContinuity;
  if(caption){
    if(caption.ownerClipId===clipId)found.push(`${path}.legacyCaptionContinuity.ownerClipId`);
    caption.witnesses.forEach((witness,index)=>{if(witness.clipId===clipId)found.push(`${path}.legacyCaptionContinuity.witnesses[${index}].clipId`);});
  }
  const mainRole=clip.legacyMainRole;
  if(mainRole){
    if(mainRole.providerId===clipId)found.push(`${path}.legacyMainRole.providerId`);
    mainRole.witnesses.forEach((witness,index)=>{
      if(witness.clipId===clipId)found.push(`${path}.legacyMainRole.witnesses[${index}].clipId`);
      if(witness.providerId===clipId)found.push(`${path}.legacyMainRole.witnesses[${index}].providerId`);
    });
  }
  (clip.speed?.captions??[]).forEach((ledger,ledgerIndex)=>{
    (ledger.detachedContinuations??[]).forEach((continuation,continuationIndex)=>{
      if(continuation.clipId===clipId)found.push(`${path}.speed.captions[${ledgerIndex}].detachedContinuations[${continuationIndex}].clipId`);
    });
  });
  return found;
}

/**
 * §4-9 の走査。R の id が文書のどこから付け替え不能な形で参照されているかを JSON パスで返す。
 * 戻り値が空でないなら結合してはいけない（未知の参照を黙って壊さない）。
 * 文書全体を汎用的に深く歩く代わりに、参照を持ちうるフィールドだけを対象 id について直接見る
 * （字幕 anchor は clipOccurrenceId===id の一致だけ、archive は該当エントリの中だけ）ため、
 * transcripts の語数や無関係なクリップ数に比例したコストを払わない。
 * cut archive の `entries[].clips[]` は保存済みクリップの**スナップショット**であり、その `.id` は
 * 過去の記録の写しであって生きたクリップへの参照ではないので対象にしない（その中の
 * anchor/legacyAudioContinuity 等はスナップショット内部の本物の参照なので対象にする）。
 */
export function clipReferencePaths(document:SequenceDocument,clipId:string):string[]{
  const found:string[]=[];
  document.clips.forEach((clip,index)=>found.push(...referencesInClip(clip,clipId,`clips[${index}]`)));
  document.transitions.forEach((transition,index)=>{
    if(transition.outClipId===clipId)found.push(`transitions[${index}].outClipId`);
    if(transition.inClipId===clipId)found.push(`transitions[${index}].inClipId`);
  });
  (document.cutArchive?.entries??[]).forEach((entry,entryIndex)=>{
    (entry.sourceRecovery?.ownerClipIds??[]).forEach((ownerId,ownerIndex)=>{
      if(ownerId===clipId)found.push(`cutArchive.entries[${entryIndex}].sourceRecovery.ownerClipIds[${ownerIndex}]`);
    });
    entry.clips.forEach((archivedClip,clipIndex)=>{
      found.push(...referencesInClip(archivedClip,clipId,`cutArchive.entries[${entryIndex}].clips[${clipIndex}]`));
      // 裁定 7: スナップショット内の字幕 anchor は rebindClipReferences も cutArchive.ts も付け替えない。
      if(archivedClip.anchor?.kind==='source'&&archivedClip.anchor.clipOccurrenceId===clipId)
        found.push(`cutArchive.entries[${entryIndex}].clips[${clipIndex}].anchor.clipOccurrenceId`);
    });
  });
  return found;
}

/** clip id を持たない大きな読み取り専用サブツリー。走査しても新しい参照は出てこない。 */
const NO_REFERENCE_TOP_LEVEL_KEYS=new Set(['transcripts','scriptDocument']);

/**
 * §4-9 の最後の保険。`clipReferencePaths` は既知フィールドしか見ないため、将来 clip id を
 * 持つ項目が増えても検出できない可能性がある — その穴を埋める汎用 walk。§4 の他の条件・
 * `clipReferencePaths` が全部通った後にだけ呼ぶ（文書全体を歩くので高コスト、早期リターンの後段専用）。
 * 既知の付け替え可能／データ扱いのパス（生きた clips[].anchor・archive の boundary references・
 * archive スナップショット自身の id/linkGroupId/continuationGroupId）は
 * `clipReferencePaths` と同じ理由でここでも参照として数えない。
 */
function hasUnknownReference(document:SequenceDocument,clipId:string):boolean{
  const known=new Set<string>();
  document.clips.forEach((clip,index)=>{
    if(clip.anchor?.kind==='source')known.add(`clips[${index}].anchor.clipOccurrenceId`);
  });
  (document.cutArchive?.entries??[]).forEach((entry,entryIndex)=>{
    entry.boundary.references.forEach((_,index)=>
      known.add(`cutArchive.entries[${entryIndex}].boundary.references[${index}].clipId`));
    (entry.trackBoundaries??[]).forEach((binding,bindingIndex)=>binding.boundary.references.forEach((_,index)=>
      known.add(`cutArchive.entries[${entryIndex}].trackBoundaries[${bindingIndex}].boundary.references[${index}].clipId`)));
    entry.clips.forEach((_,clipIndex)=>{
      const base=`cutArchive.entries[${entryIndex}].clips[${clipIndex}]`;
      // `anchor.clipOccurrenceId` はここに足さない（裁定 7）。`clipReferencePaths` が参照として
      // 数える側へ回したので、保険が先に握り潰さないよう 2 か所の判断を一致させる。
      known.add(`${base}.id`);known.add(`${base}.linkGroupId`);known.add(`${base}.continuationGroupId`);
    });
  });
  let matched=false;
  const walk=(value:unknown,path:string):void=>{
    if(matched)return;
    if(typeof value==='string'){if(value===clipId&&!known.has(path)&&path!=='')matched=true;return;}
    if(Array.isArray(value)){for(const [index,item] of value.entries()){walk(item,`${path}[${index}]`);if(matched)return;}return;}
    if(value&&typeof value==='object')for(const [key,item] of Object.entries(value)){
      if(path===''&&NO_REFERENCE_TOP_LEVEL_KEYS.has(key))continue;
      walk(item,path?`${path}.${key}`:key);
      if(matched)return;
    }
  };
  walk({...document,clips:document.clips.map(clip=>clip.id===clipId?{...clip,id:''}:clip)},'');
  return matched;
}

/**
 * 結合で解決フレームがずれる復元記録の境界参照（裁定 6）。結合後の L' は [L.start, clipEnd(R))
 * なので、R を指す 'start'（clipEnd(L)+off → L.start+off）と L を指す 'end'（clipEnd(L)+off →
 * clipEnd(R)+off）は付け替えても意味が保てない。逆向きの 2 形は保てるので断らない。
 */
function movedBoundaryEdge(document:SequenceDocument,leftId:string,rightId:string):boolean{
  for(const entry of document.cutArchive?.entries??[])
    for(const boundary of [entry.boundary,...(entry.trackBoundaries??[]).map(binding=>binding.boundary)])
      for(const reference of boundary.references)
        if((reference.clipId===rightId&&reference.edge==='start')||(reference.clipId===leftId&&reference.edge==='end'))return true;
  return false;
}

/** §4 の 1〜9。1 つでも欠ければ ok:false（呼び出し側は押し出し／停止へ倒す）。 */
export function losslessJoin(document:SequenceDocument,leftId:string,rightId:string):
  {ok:true;audio?:{leftId:string;rightId:string}}|{ok:false;reason:string}{
  const pairOk=(left:SequenceClip,right:SequenceClip):string|null=>{
    if(right.startFrame!==clipEnd(left))return '時間上で隣接していません';                                    // 1
    if(left.continuationGroupId===undefined||left.continuationGroupId!==right.continuationGroupId)return '同じ分割から生まれたクリップではありません';   // 2
    if(!isMediaContent(left.content)||!isMediaContent(right.content))return '映像・音声以外は結合できません';  // 3
    if(left.content.kind!==right.content.kind||left.content.assetId!==right.content.assetId
      ||left.content.streamIndex!==right.content.streamIndex||compareTime(left.content.rate,right.content.rate)!==0)return '素材が違います';  // 3
    if(compareTime(sourceTimeAt(left,clipEnd(left),document.fps),right.content.sourceIn)!==0)return '元素材が連続していません';                // 4
    if(JSON.stringify(contentWithoutSource(left.content))!==JSON.stringify(contentWithoutSource(right.content)))return '編集内容が違います';   // 5
    if(left.visual?.keyframes?.length||right.visual?.keyframes?.length)return '動きのキーフレームがあります';                                  // 5
    // 5: 静的な表示設定（位置・拡大・不透明度など）。結合は L を伸ばして R を消すので、R 側だけを
    // 動かしてあると R 区間の見た目が黙って失われる（Codex P1）。キーフレームの有無とは別の理由。
    if(!sameSettings(visualWithoutKeyframes(left.visual),visualWithoutKeyframes(right.visual)))return '見た目の設定が違います';                // 5
    // 5: 効果の時計。表示設定が同じでも時計が食い違えば R 区間のアニメーションが黙って変わる
    // （Codex P2 2 巡目）。`clock` はモーションプリセット、`keyframeClock` はキーフレームの土台。
    if(!clockContinues(left.clock,right.clock,left.startFrame,right.startFrame)
      ||!clockContinues(left.visual?.keyframeClock,right.visual?.keyframeClock,left.startFrame,right.startFrame))
      return '動きの時計が連続していません';                                                                  // 5
    if(left.speed!==undefined||right.speed!==undefined||document.speed!==undefined)return '速度登録がある案件では結合しません';                 // 6
    // 6: 固定挿入は `c.speed` を持てない（insertOwnSpeed.ts:186 が禁じる）ので上の行を素通りする。
    // split は固定挿入に明示対応しており 2 片が同じ continuationGroupId を得るため、条件 2・4・5 も
    // 満たしうる。通すと join の sequenceEndFrame 上書きと rebindInsertOwnCompletion の endFloor
    // 再計算（insertOwnSpeed.ts:113）が競合するので、設計 §3 注記と同じ「固定挿入は断る」側へ倒す。
    if(left.insertOwnSpeed!==undefined||right.insertOwnSpeed!==undefined)return '固定挿入は結合しません';                                      // 6
    for(const transition of document.transitions)
      if([transition.outClipId,transition.inClipId].includes(left.id)||[transition.outClipId,transition.inClipId].includes(right.id))
        return '転換が掛かっています';                                                                        // 7
    for(const clip of document.clips)
      if(clip.content.kind==='scene-fade'&&(overlaps(clip.startFrame,clipEnd(clip),left.startFrame,clipEnd(left))
        ||overlaps(clip.startFrame,clipEnd(clip),right.startFrame,clipEnd(right))))return '場面フェードが掛かっています';  // 7
    if(movedBoundaryEdge(document,left.id,right.id))return '復元記録の境界が結合で動く端を指しています';   // 9
    if(clipReferencePaths(document,right.id).length)return '付け替えられない参照があります';                    // 9
    if(hasUnknownReference(document,right.id))return 'unknown-reference';                                        // 9（保険）
    return null;
  };
  const left=document.clips.find(c=>c.id===leftId),right=document.clips.find(c=>c.id===rightId);
  if(!left||!right||left.trackId!==right.trackId)return {ok:false,reason:'対象が見つかりません'};
  const failure=pairOk(left,right);if(failure)return {ok:false,reason:failure};
  // 8: 片方だけリンクがある場合は結合しない。両方あるときは 1 対 1 で、音声側も 1〜7・9 を満たすこと。
  if((left.linkGroupId===undefined)!==(right.linkGroupId===undefined))return {ok:false,reason:'リンクの有無が違います'};
  if(left.linkGroupId===undefined)return {ok:true};
  const partners=(clip:SequenceClip)=>document.clips.filter(c=>c.id!==clip.id&&c.linkGroupId===clip.linkGroupId);
  const [audioLeft]=partners(left),[audioRight]=partners(right);
  if(!audioLeft||!audioRight||partners(left).length!==1||partners(right).length!==1)return {ok:false,reason:'リンク音声が 1 対 1 で対応しません'};
  // 8: 音声ペアも同じトラックにあること（Codex P2）。映像側は上の `left.trackId!==right.trackId` が
  // 見ているが、リンク相手は `pairOk` が trackId を比較しないので、片方を別の音声トラックへ移した
  // 文書でも結合してしまう。結合後は左音声のトラックだけが残るため、鳴る音が変わる。
  if(audioLeft.trackId!==audioRight.trackId)return {ok:false,reason:'リンク音声が別のトラックにあります'};
  const audioFailure=pairOk(audioLeft,audioRight);if(audioFailure)return {ok:false,reason:`リンク音声: ${audioFailure}`};
  return {ok:true,audio:{leftId:audioLeft.id,rightId:audioRight.id}};
}

/** 字幕 anchor と復元記録（境界・トラック境界）の id を付け替える。入力は変えない。 */
export function rebindClipReferences(document:SequenceDocument,from:string,to:string):SequenceDocument{
  const next=structuredClone(document);
  for(const clip of next.clips)if(clip.anchor?.kind==='source'&&clip.anchor.clipOccurrenceId===from)clip.anchor.clipOccurrenceId=to;
  for(const entry of next.cutArchive?.entries??[])
    for(const boundary of [entry.boundary,...(entry.trackBoundaries??[]).map(binding=>binding.boundary)])
      for(const reference of boundary.references)if(reference.clipId===from)reference.clipId=to;
  return next;
}

/** 詰める／押し出す範囲が触るクリップに固定挿入（insertOwnSpeed）があれば断る。§5 は固定挿入の移動を定義していない。 */
function fixedInsertionBlocks(document:SequenceDocument,from:number):boolean{
  return document.clips.some(clip=>clip.insertOwnSpeed!==undefined&&(clip.startFrame>=from||straddles(clip,from)));
}
function transitionBlocks(document:SequenceDocument,start:number,end:number):boolean{
  if(document.transitions.some(t=>overlaps(start,end,t.startFrame,t.startFrame+t.durationFrames)))return true;
  return document.clips.some(c=>c.content.kind==='scene-fade'&&overlaps(start,end,c.startFrame,clipEnd(c)));
}
/** 押し出しは境界 1 点。またぐ転換・場面フェードと、「動く片と据え置く片」をまたぐ転換を断る。 */
function pushBlocks(document:SequenceDocument,at:number):boolean{
  if(transitionBlocks(document,at,at+1))return true;
  const moves=(id:string|undefined)=>{const clip=document.clips.find(c=>c.id===id);return clip?clip.startFrame>=at||straddles(clip,at):false;};
  return document.transitions.some(t=>t.inClipId!==undefined&&moves(t.outClipId)!==moves(t.inClipId));
}

/**
 * §5 v2.3 の裁定。押し出しでは「対象と一緒に延長されるクリップ」（reducer が recipe を先に埋め、
 * `pushRecipes` の `skip` に渡す集合）だけは `atFrame` で 2 片に切られない。その集合のクリップが
 * `atFrame` をまたぐと、延長されるだけで後半が `+delta` されず、さらにそれを provider とする
 * source anchor 字幕が `rebuild` の再アンカーで元位置へ戻るため、編集点より後ろが `delta` ずれる。
 * v1 は押し出さずに右隣の手前で止める（Codex P1-4 の再来を作らない）。
 */
function overhangsPushPoint(document:SequenceDocument,skip:Set<string>,targetId:string,at:number):boolean{
  return document.clips.some(clip=>clip.id!==targetId&&skip.has(clip.id)&&straddles(clip,at));
}
/** reducer の `targets(document,[clipId],linked!==false)` と同じ選択規則（commands.ts:94-106）。 */
function selectedForTrim(document:SequenceDocument,clip:SequenceClip,linked:boolean|undefined):Set<string>{
  if(linked===false||clip.linkGroupId===undefined)return new Set([clip.id]);
  return new Set(document.clips.filter(c=>c.id===clip.id||c.linkGroupId===clip.linkGroupId).map(c=>c.id));
}

/**
 * §5 v2.4。押し出しで増やした `sequenceEndFrame` を、後処理 `rebindInsertOwnCompletion` が
 * `endFloor` まで戻してしまう条件を検出する（Codex P2 2 巡目）。`endFloor` は「登録時の完成尺」で、
 * 通常編集で端が動いたクリップの終端までしか引き上がらない（insertOwnSpeed.ts:167-174）。
 * そのため**末尾に空白がある**案件では、押し出した分が完成尺に残らず黙って消える
 * （実測: 完成尺 30・固定挿入 [0,5)・通常 [5,10)/[10,15) の中央を 12 へ → 後続は 2fr 動くのに尺は 30 のまま）。
 * 末尾に空白が無い（最後のクリップ終端＝完成尺）場合は endFloor が押し出し後の終端まで上がるので
 * 従来どおり押し出してよい（実測: 完成尺 15 の同じ構成で 17 になる）。
 * 押し出し点より後ろの固定挿入は `fixedInsertionBlocks` が先に断っているので、ここは
 * 「押し出し点より前の固定挿入」だけを見る。戻り値 true＝押し出しても長さを保てる。
 */
function fixedInsertKeepsLength(document:SequenceDocument,at:number):boolean{
  if(document.insertOwnSpeed===undefined)return true;
  if(!document.clips.some(clip=>clip.insertOwnSpeed!==undefined&&clipEnd(clip)<=at))return true;
  return Math.max(...document.clips.map(clipEnd))>=document.sequenceEndFrame;
}

export function rippleTrimPlan(document:SequenceDocument,command:TrimCommand):RippleTrimPlan{
  const clip=document.clips.find(c=>c.id===command.clipId);
  if(!clip||!Number.isSafeInteger(command.frame)||command.frame<0)return {kind:'reject',reason:'invalid'};
  const edgeFrame=command.edge==='start'?clip.startFrame:clipEnd(clip);
  if(command.frame===edgeFrame)return {kind:'plain'};
  // v1: 速度を登録したクリップ自身の端は ripple の対象外。従来 trim の rebindSpeedTrim／{grow:true}
  // 経路（commands.ts の case 'trim'）を ripple 分岐が飛ばしてしまうため、UI で従来 trim に落とす（設計 §3 の注記）。
  if(command.ripple&&clip.speed!==undefined)return {kind:'reject',reason:'speed'};
  const sameTrack=document.clips.filter(c=>c.trackId===clip.trackId&&c.id!==clip.id);
  const shorten=command.edge==='start'?command.frame>clip.startFrame:command.frame<clipEnd(clip);
  if(shorten){
    if(!command.ripple)return {kind:'plain'};
    // 最小長ガード: 新しい端が反対側の固定端を越える／届く指示は範囲が負になるので弾く。
    if(command.edge==='end'?command.frame<=clip.startFrame:command.frame>=clipEnd(clip))return {kind:'reject',reason:'invalid'};
    const startFrame=command.edge==='start'?clip.startFrame:command.frame;
    // 尺より後ろへ伸びたクリップ（隠した尻尾）は詰める対象が無い。reducer の ripple-delete は
    // end > sequenceEndFrame を断るので、制約を緩めずに範囲側へ上限を掛ける（設計 §3 の注記）。
    const endFrame=Math.min(command.edge==='start'?command.frame:clipEnd(clip),document.sequenceEndFrame);
    if(endFrame<=startFrame)return {kind:'plain'};
    if(transitionBlocks(document,startFrame,endFrame))return {kind:'reject',reason:'transition'};
    if(fixedInsertionBlocks(document,startFrame))return {kind:'reject',reason:'speed'};
    return {kind:'close',startFrame,endFrame};
  }
  // 延長。触れる隣は「直後の 1 本」だけ（§3）。
  const neighbour=command.edge==='end'
    ?sameTrack.filter(c=>c.startFrame>=clipEnd(clip)).sort((a,b)=>a.startFrame-b.startFrame)[0]
    :sameTrack.filter(c=>clipEnd(c)<=clip.startFrame).sort((a,b)=>clipEnd(b)-clipEnd(a))[0];
  if(!neighbour)return {kind:'plain'};
  const contact=command.edge==='end'?neighbour.startFrame:clipEnd(neighbour);
  const crosses=command.edge==='end'?command.frame>contact:command.frame<contact;
  if(!crosses)return {kind:'plain'};
  // この枝の消費者は UI のゴースト／Task 5 だけ。reducer は ripple が偽なら計画関数を呼ばない
  // （commands.ts の `command.ripple ? … : {kind:'plain'}`）ので、OFF の延長は core では止まらない。
  if(!command.ripple)return {kind:'clamp',frame:contact};
  const [leftId,rightId]=command.edge==='end'?[clip.id,neighbour.id]:[neighbour.id,clip.id];
  // 裁定 8: linked:false では結合しない。判定をここに置くと、reducer も UI のゴーストも同じ結論になる。
  const join=command.linked===false
    ?{ok:false as const,reason:'リンクを外した操作では結合しません'}
    :losslessJoin(document,leftId,rightId);
  if(join.ok){
    const joinedEnd=clipEnd(document.clips.find(c=>c.id===rightId)!);
    // 開始端側の結合では延長分は左へ食い込むだけで、押し出しは起きない。
    if(command.edge==='end'&&command.frame>joinedEnd){
      if(pushBlocks(document,joinedEnd))return {kind:'reject',reason:'transition'};
      if(fixedInsertionBlocks(document,joinedEnd))return {kind:'reject',reason:'speed'};
      // 結合分岐の skip は 4 本（L・R とリンク音声 A_L・A_R）。この中に joinedEnd をまたぐものが
      // あれば押し出さない（§5 v2.3）。結合だけを残す形は取らない — clamp 先を joinedEnd にすると
      // 従来 trim 経路で R と重なるため、右隣の手前（contact）で止める。拒否（転換・固定挿入）は
      // clamp より強い理由なので先に見る。
      const pairs=new Set([leftId,rightId,...(join.audio?[join.audio.leftId,join.audio.rightId]:[])]);
      if(overhangsPushPoint(document,pairs,command.clipId,joinedEnd))return {kind:'clamp',frame:contact,reason:'linked-overhang'};
      if(!fixedInsertKeepsLength(document,joinedEnd))return {kind:'clamp',frame:contact,reason:'fixed-insert-length'};
      return {kind:'join',leftId,rightId,...(join.audio?{audio:join.audio}:{}),push:{atFrame:joinedEnd,delta:command.frame-joinedEnd}};
    }
    return {kind:'join',leftId,rightId,...(join.audio?{audio:join.audio}:{})};
  }
  // 左への押し出しは提供しない（§3）。開始端は左隣の終端で止める。
  if(command.edge==='start')return {kind:'clamp',frame:contact};
  if(pushBlocks(document,contact))return {kind:'reject',reason:'transition'};
  if(fixedInsertionBlocks(document,contact))return {kind:'reject',reason:'speed'};
  // 単独 push の skip は reducer の `selected`（対象＋リンク相手）。§5 v2.3。
  // 拒否（転換・固定挿入）は clamp より強い理由なので先に見る。
  if(overhangsPushPoint(document,selectedForTrim(document,clip,command.linked),clip.id,contact))
    return {kind:'clamp',frame:contact,reason:'linked-overhang'};
  if(!fixedInsertKeepsLength(document,contact))return {kind:'clamp',frame:contact,reason:'fixed-insert-length'};
  return {kind:'push',atFrame:contact,delta:command.frame-contact};
}
