/**
 * 比較試験の基準: 第1段より前の buildSnapIndex（全クリップの総当たり・分数の約分）の写し（e30d38a4 の snapIndex.ts）。
 * 製品コードから import しない。snapIndex.equivalence.test.ts と .sdd/perf/snap-bench.ts だけが使う。
 */
import { clipEnd, sourceTimeAt, type SequenceClip, type SequenceDocument } from '../../core/sequence/model';
import { compareTime, divideTime, multiplyTime, subtractTime, timeNumber, type Rational } from '../../core/sequence/time';
import { WORD_GAP_MS, type SnapTarget } from './snapIndex';

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
function sourceFrameOccurrences(doc: SequenceDocument, assetId: string, streamIndex: number, at: Rational): number[] {
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
 * Rebuilt on document change only. `playhead` を渡すと再生ヘッドの対象を1件焼き込む。
 * `null` を渡すと再生ヘッド対象を含めない（document 由来の index を作る時はこちら。frame 0 付近で
 * 「再生位置」が「先頭」より優先されてしまう幽霊 playhead を防ぐ）。実際の再生ヘッドは
 * 呼び出し側がドラッグ中に別途合成する。
 */
export function buildSnapIndexReference(doc: SequenceDocument, playhead: number | null, excludeClipIds: readonly string[]): SnapTarget[] {
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
