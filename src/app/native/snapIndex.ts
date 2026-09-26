import { clipEnd, sourceTimeAt, type SequenceClip, type SequenceDocument } from '../../core/sequence/model';
import { compareTime, divideTime, multiplyTime, subtractTime, timeNumber, type Rational } from '../../core/sequence/time';

export type SnapKind = 'zero' | 'playhead' | 'clip' | 'word' | 'gap';
/**
 * `side` は対象が指す端の向き（'start'＝始まり側／'end'＝終わり側）。クリップ端・語境界に付き、
 * 呼び出し側（`NativeTimeline.tsx` の `targetSide`）が displayFrame の bias（'before'/'after'）を
 * ここから決める。`clipId` はクリップ端ターゲットの出どころで、ドラッグ中に自分自身の端を
 * 除外する時に使う（値一致ではなく id で判定するため）。
 */
export interface SnapTarget { frame: number; kind: SnapKind; label: string; side?: 'start' | 'end'; clipId?: string }
/** 語と語の間隔がこれ以上あいたら「語間」の吸着先にする。「無音」とは呼ばない。 */
export const WORD_GAP_MS = 400;

/** 同距離・同フレームの並び順を決める優先順位（高いほど勝つ）。playhead > clip > word > gap > zero。 */
const KIND_PRIORITY: Record<SnapKind, number> = { playhead: 4, clip: 3, word: 2, gap: 1, zero: 0 };

/** 素材時刻 → タイムラインフレーム。1クリップのみを対象にした `sourceFrameOccurrences` の内部写像。 */
function frameAtSourceTime(clip: SequenceClip, doc: SequenceDocument, at: Rational): number | null {
  const content = clip.content;
  if (content.kind !== 'audio' && content.kind !== 'video') return null;
  const start = content.sourceIn, end = sourceTimeAt(clip, clipEnd(clip), doc.fps);
  if (compareTime(at, start) < 0 || compareTime(at, end) > 0) return null;
  const offset = divideTime(multiplyTime(subtractTime(at, start), doc.fps), content.rate);
  return clip.startFrame + Math.round(timeNumber(offset));
}

/**
 * 素材時刻 → タイムラインフレーム。`sourceTimeAt` の逆写像。
 * 同じ素材を複数箇所で使っていればその数だけ返す（カット・速度変更を経由しても
 * それぞれのクリップの rate と sourceIn をたどるので値が合う）。
 */
export function sourceFrameOccurrences(doc: SequenceDocument, assetId: string, streamIndex: number, at: Rational): number[] {
  const frames: number[] = [];
  for (const clip of doc.clips) {
    const content = clip.content;
    if (content.kind !== 'audio' && content.kind !== 'video') continue;
    if (content.kind === 'audio' && content.role !== 'speech') continue;
    if (content.assetId !== assetId || content.streamIndex !== streamIndex) continue;
    const frame = frameAtSourceTime(clip, doc, at);
    if (frame !== null) frames.push(frame);
  }
  return frames.sort((a, b) => a - b);
}

/**
 * 素材時刻 → タイムラインフレーム。単一クリップに限定した写像（対応元クリップが分かっている時に使う）。
 * `sourceFrameOccurrences` と違い、同じ素材の他クリップの出現とは混ざらない。
 */
export function sourceFrameInClip(doc: SequenceDocument, clip: SequenceClip, at: Rational): number | null {
  return frameAtSourceTime(clip, doc, at);
}

/**
 * Rebuilt on document change only. `playhead` を渡すと再生ヘッドの対象を1件焼き込む。
 * `null` を渡すと再生ヘッド対象を含めない（document 由来の index を作る時はこちら。frame 0 付近で
 * 「再生位置」が「先頭」より優先されてしまう幽霊 playhead を防ぐ）。実際の再生ヘッドは
 * 呼び出し側がドラッグ中に別途合成する。
 */
export function buildSnapIndex(doc: SequenceDocument, playhead: number | null, excludeClipIds: readonly string[]): SnapTarget[] {
  const excluded = new Set(excludeClipIds);
  const targets: SnapTarget[] = [{ frame: 0, kind: 'zero', label: '先頭' }];
  if (playhead !== null) targets.push({ frame: playhead, kind: 'playhead', label: '再生位置' });
  for (const clip of doc.clips) {
    if (excluded.has(clip.id)) continue;
    targets.push({ frame: clip.startFrame, kind: 'clip', label: `${clip.name}の先頭`, side: 'start', clipId: clip.id });
    targets.push({ frame: clipEnd(clip), kind: 'clip', label: `${clip.name}の終わり`, side: 'end', clipId: clip.id });
  }
  const gapSeconds = WORD_GAP_MS / 1000;
  for (const transcript of doc.transcripts) {
    let previous: { end: Rational; text: string } | null = null;
    for (const word of transcript.words) {
      for (const frame of sourceFrameOccurrences(doc, transcript.assetId, transcript.streamIndex, word.start))
        targets.push({ frame, kind: 'word', label: `単語「${word.text}」の始まり`, side: 'start' });
      for (const frame of sourceFrameOccurrences(doc, transcript.assetId, transcript.streamIndex, word.end))
        targets.push({ frame, kind: 'word', label: `単語「${word.text}」の終わり`, side: 'end' });
      if (previous && timeNumber(subtractTime(word.start, previous.end)) >= gapSeconds) {
        for (const frame of sourceFrameOccurrences(doc, transcript.assetId, transcript.streamIndex, previous.end))
          targets.push({ frame, kind: 'gap', label: `語間の始まり（「${previous.text}」のあと）` });
        for (const frame of sourceFrameOccurrences(doc, transcript.assetId, transcript.streamIndex, word.start))
          targets.push({ frame, kind: 'gap', label: `語間の終わり（「${word.text}」の前）` });
      }
      previous = { end: word.end, text: word.text };
    }
  }
  return foldDuplicates(targets).sort((a, b) => a.frame - b.frame);
}

/**
 * 同じ `frame` かつ同じ `kind` のエントリが並んだら 1 件に畳む（例: 連続する語で
 * 「前の語の終わり」と「次の語の始まり」が同じフレームに来るケース、または隣接する2クリップの
 * 「A の終わり」＝「B の始まり」）。kind が異なる場合は畳まない — zero と clip、gap と word は
 * この索引の作りにより同じ frame で意図的に重なる（例: 先頭クリップの開始は常に frame 0 で
 * 'zero' と衝突し、語間の境界は隣の語の境界と同じ frame になる）ため、ここで潰すと
 * 'zero'・'gap' がほぼ常に消える。どれを優先するかは呼び出し側の `snapFrame` が KIND_PRIORITY で決める。
 *
 * `kind==='clip'` の衝突（隣接クリップの端）だけは `doc.clips` の並び順に関わらず常に `side:'end'`
 * を残す決定的な tie-break を行う。`side` は呼び出し側（`NativeTimeline.tsx` の `targetSide`）が
 * displayFrame の bias にそのまま使うため、ここを push 順（＝配列順）任せにすると、同じ境界でも
 * クリップの並び順次第で bias が変わってしまう。それ以外の kind は先に push された方を残す。
 */
function foldDuplicates(targets: readonly SnapTarget[]): SnapTarget[] {
  const seen = new Map<string, SnapTarget>();
  for (const target of targets) {
    const key = `${target.frame}:${target.kind}`;
    const existing = seen.get(key);
    if (!existing) { seen.set(key, target); continue; }
    if (target.kind === 'clip' && target.side === 'end' && existing.side !== 'end') seen.set(key, target);
  }
  return [...seen.values()];
}

/**
 * displayFrame の bias（呼び出し側 `NativeTimeline.tsx` の距離計算がそのまま使う）。
 * `'before'` はクリップの終わり端（`kind==='clip' && side==='end'`）だけ — カット境界の手前を指し、
 * round-0 からの意味を保つ。語境界（word）は `side` を始まり/終わりの表示用に持つが、bias は
 * clip とは独立で常に `'after'`（I2 fix-round-2: side だけを見て word の終わりにも 'before' を
 * 付けていた回帰。語の終わりが確定済みカット境界と一致する場合に round-0 と挙動がずれていた）。
 */
export function targetDisplayBias(target: SnapTarget): 'before' | 'after' {
  return target.kind === 'clip' && target.side === 'end' ? 'before' : 'after';
}

/** しきい値内で一番近い対象へ寄せる。同距離は `KIND_PRIORITY`（playhead > clip > word > gap > zero）で決める。 */
export function snapFrame(targets: readonly SnapTarget[], frame: number, thresholdFrames: number): { frame: number; target: SnapTarget | null } {
  let best: SnapTarget | null = null, bestDistance = Infinity;
  for (const target of targets) {
    const distance = Math.abs(target.frame - frame);
    if (distance >= thresholdFrames) continue;
    if (best === null || distance < bestDistance || (distance === bestDistance && KIND_PRIORITY[target.kind] > KIND_PRIORITY[best.kind])) {
      best = target; bestDistance = distance;
    }
  }
  return best ? { frame: best.frame, target: best } : { frame, target: null };
}
