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
  const excluded = new Set(excludeClipIds), occurrences = new SourceOccurrenceIndex(doc);
  const targets: SnapTarget[] = [{ frame: 0, kind: 'zero', label: '先頭' }];
  if (playhead !== null) targets.push({ frame: playhead, kind: 'playhead', label: '再生位置' });
  for (const clip of doc.clips) {
    if (excluded.has(clip.id)) continue;
    targets.push({ frame: clip.startFrame, kind: 'clip', label: `${clip.name}の先頭`, side: 'start', clipId: clip.id });
    targets.push({ frame: clipEnd(clip), kind: 'clip', label: `${clip.name}の終わり`, side: 'end', clipId: clip.id });
  }
  const gapSeconds = WORD_GAP_MS / 1000;
  for (const transcript of doc.transcripts) {
    // 同じ時刻の写像を2度引かない（語の始まりは語間の終わりにも、語の終わりは次の語間の始まりにも使う）。積む順は全走査と同じ。
    let previous: { end: Rational; text: string; ends: number[] } | null = null;
    for (const word of transcript.words) {
      const starts = occurrences.frames(transcript.assetId, transcript.streamIndex, word.start), ends = occurrences.frames(transcript.assetId, transcript.streamIndex, word.end);
      for (const frame of starts) targets.push({ frame, kind: 'word', label: `単語「${word.text}」の始まり`, side: 'start' });
      for (const frame of ends) targets.push({ frame, kind: 'word', label: `単語「${word.text}」の終わり`, side: 'end' });
      if (previous && timeNumber(subtractTime(word.start, previous.end)) >= gapSeconds) {
        for (const frame of previous.ends) targets.push({ frame, kind: 'gap', label: `語間の始まり（「${previous.text}」のあと）` });
        for (const frame of starts) targets.push({ frame, kind: 'gap', label: `語間の終わり（「${word.text}」の前）` });
      }
      previous = { end: word.end, text: word.text, ends };
    }
  }
  return foldDuplicates(targets).sort((a, b) => a.frame - b.frame);
}

interface SourceSpan { clip: SequenceClip; start: Rational; end: Rational; from: number; to: number }
/**
 * 素材ストリームごとに、話し（speech）の音声と映像の使用箇所を素材の開始時刻順に並べた索引。語→コマは、その時刻を含む使用箇所だけを引く。
 * 文字起こしのあるストリームだけを入れる（旧実装が触れなかった使用箇所の時刻計算で新たに例外を出さない）。
 */
export class SourceOccurrenceIndex {
  private readonly groups = new Map<string, { spans: SourceSpan[]; reach: number[] }>();
  constructor(private readonly doc: SequenceDocument) {
    const spoken = new Set(doc.transcripts.filter(t => t.words.length).map(t => `${t.assetId}\u0000${t.streamIndex}`));
    for (const clip of doc.clips) {
      const content = clip.content;
      if (content.kind !== 'audio' && content.kind !== 'video') continue;
      if (content.kind === 'audio' && content.role !== 'speech') continue;
      const key = `${content.assetId}\u0000${content.streamIndex}`;if (!spoken.has(key)) continue;
      const end = sourceTimeAt(clip, clipEnd(clip), doc.fps), group = this.groups.get(key) ?? { spans: [], reach: [] };
      group.spans.push({ clip, start: content.sourceIn, end, from: timeNumber(content.sourceIn), to: timeNumber(end) }); this.groups.set(key, group);
    }
    for (const group of this.groups.values()) { group.spans.sort((a, b) => a.from - b.from); let reach = -Infinity; group.reach = group.spans.map(span => reach = Math.max(reach, span.to)); }
  }
  /** sourceFrameOccurrences と同じ結果（含む使用箇所すべて・同じ丸め・昇順）。候補は浮動小数で絞り、含むかは有理数で決める。 */
  frames(assetId: string, streamIndex: number, at: Rational): number[] {
    const group = this.groups.get(`${assetId}\u0000${streamIndex}`); if (!group) return [];
    const seconds = timeNumber(at), slack = 1e-9 * Math.max(1, Math.abs(seconds)), frames: number[] = [];
    let low = 0, high = group.spans.length;
    while (low < high) { const mid = (low + high) >> 1; if (group.spans[mid]!.from <= seconds + slack) low = mid + 1; else high = mid; }
    for (let i = low - 1; i >= 0 && group.reach[i]! >= seconds - slack; i--) {
      // 先の長い使用箇所が reach を高く保つと手前まで遡るので、終わりが確実に手前のものは浮動小数だけで外す。
      const span = group.spans[i]!; if (span.to < seconds - slack) continue;
      if (compareTime(at, span.start) < 0 || compareTime(at, span.end) > 0) continue;
      frames.push(frameInSpan(span, this.doc, at));
    }
    return frames.sort((a, b) => a - b);
  }
}
const SAFE = BigInt(Number.MAX_SAFE_INTEGER), FLOAT_EXACT = 1n << 30n;
/**
 * (at−sourceIn)×fps÷rate を整数で丸める。旧実装の Math.round(timeNumber(約分した値)) と食い違いうるのは、小数部が 0.5 のごく近く・
 * 2^30 コマ以上（浮動小数の誤差が 0.5 の判定に届く）・約分前の分子か分母が安全な整数を超える（旧実装が例外を出しうる）・速度が正でない時だけなので、そこは旧実装で計算する。
 */
function frameInSpan(span: SourceSpan, doc: SequenceDocument, at: Rational): number {
  const content = span.clip.content as Extract<SequenceClip['content'], { kind: 'audio' | 'video' }>, rate = content.rate, start = span.start, fps = doc.fps;
  const p = (BigInt(at.num) * BigInt(start.den) - BigInt(start.num) * BigInt(at.den)) * BigInt(fps.num) * BigInt(rate.den);
  const q = BigInt(at.den) * BigInt(start.den) * BigInt(fps.den) * BigInt(rate.num);
  if (q <= 0n || p > SAFE || q > SAFE) return frameAtSourceTime(span.clip, doc, at)!;
  const whole = p / q, twice = (p % q) * 2n, distance = twice > q ? twice - q : q - twice;
  if (whole >= FLOAT_EXACT || distance * 1000000n <= q) return frameAtSourceTime(span.clip, doc, at)!;
  return span.clip.startFrame + Number(twice > q ? whole + 1n : whole);
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
