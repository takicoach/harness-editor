import { clipEnd, type SequenceClip, type SequenceDocument } from '../../core/sequence/model';
import { compareTime } from '../../core/sequence/time';
import { sourceFrameInClip } from './snapIndex';

export interface WordChip { text: string; startFrame: number; endFrame: number; cut: boolean }

/**
 * 字幕クリップの使用箇所（anchor）に重なる語を、タイムラインフレームで返す。
 * `cut: true` は「元の発話にはあるが、いまの並びには残っていない語」。
 */
export function captionWordChips(doc: SequenceDocument, clip: SequenceClip): WordChip[] {
  const anchor = clip.anchor;
  if (anchor?.kind !== 'source') return [];
  const provider = doc.clips.find(c => c.id === anchor.clipOccurrenceId);
  if (!provider || provider.content.kind !== 'audio') return [];
  const content = provider.content;
  const transcript = doc.transcripts.find(t => t.assetId === anchor.sourceAssetId && t.streamIndex === content.streamIndex);
  if (!transcript) return [];
  const chips: WordChip[] = [];
  for (const word of transcript.words) {
    if (compareTime(word.end, anchor.sourceStart) <= 0 || compareTime(word.start, anchor.sourceEnd) >= 0) continue;
    // 対応元（anchor が指す provider）クリップだけを写像する。同一素材の別使用や別トラックの
    // speech クリップが字幕のフレーム範囲に重なっても、無関係な出現とは混ざらない。
    const within = (f: number | null): f is number => f !== null && f >= clip.startFrame && f <= clipEnd(clip);
    const startAt = sourceFrameInClip(doc, provider, word.start), endAt = sourceFrameInClip(doc, provider, word.end);
    const startFrame = within(startAt) ? startAt : undefined, endFrame = within(endAt) ? endAt : undefined;
    if (startFrame !== undefined && endFrame !== undefined) { chips.push({ text: word.text, startFrame, endFrame, cut: false }); continue; }
    // 片端でも provider クリップのいまの配置に残っていなければ、その語はいまの並びから消えている
    // （cutArchive は見ない。「いまの配置に出現が無い＝cut」というだけの判定。取消線で見せる）。
    const fallbackStart = startFrame ?? clip.startFrame, fallbackEnd = endFrame ?? fallbackStart;
    chips.push({ text: word.text, startFrame: fallbackStart, endFrame: fallbackEnd, cut: true });
  }
  return chips.sort((a, b) => a.startFrame - b.startFrame || a.endFrame - b.endFrame);
}
