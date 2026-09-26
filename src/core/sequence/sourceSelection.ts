import { SequenceError } from './errors';
import { clipEnd, sourceTimeAt, type SequenceDocument } from './model';
import { ceilTime, compareTime, divideTime, floorTime, multiplyTime, subtractTime, type Rational } from './time';
import { validateSequenceDocument, validateSourceSelection } from './validate';

export interface SpeechSelection {
  assetId: string;
  streamIndex: number;
  occurrenceId?: string;
  start: Rational;
  end: Rational;
}

/** Resolves speech to the audible occurrence, never silently to a reused video. */
export function speechSelectionRange(document: SequenceDocument, selection: SpeechSelection): { startFrame: number; endFrame: number } {
  validateSequenceDocument(document);
  if (compareTime(selection.start, selection.end) >= 0) throw new SequenceError('INVALID_RANGE', '発話の選択範囲が不正です');
  const occurrences = document.clips.filter(c => c.content.kind === 'audio'
    && c.content.assetId === selection.assetId && c.content.streamIndex === selection.streamIndex
    && c.content.role === 'speech' && (!selection.occurrenceId || c.id === selection.occurrenceId)
    && compareTime(sourceTimeAt(c, c.startFrame, document.fps), selection.start) <= 0
    && compareTime(sourceTimeAt(c, clipEnd(c), document.fps), selection.end) >= 0);
  if (!occurrences.length) throw new SequenceError('MISSING_TARGET', '選択した発話の使用箇所が見つかりません');
  if (occurrences.length > 1) throw new SequenceError('AMBIGUOUS_SOURCE_OCCURRENCE', '同じ発話が複数箇所で使われています。使用箇所を選択してください', occurrences.map(c => c.id));
  const clip = occurrences[0]!;
  validateSourceSelection(document, clip);
  if (clip.content.kind !== 'audio') throw new SequenceError('INAUDIBLE_SOURCE', '音声がありません');
  const { sourceIn, rate } = clip.content;
  const toFrame = (time: Rational) => multiplyTime(divideTime(subtractTime(time, sourceIn), rate), document.fps);
  // Outward rounding keeps the entire selected utterance; quantization happens once here.
  const startFrame = Math.max(clip.startFrame, clip.startFrame + floorTime(toFrame(selection.start)));
  const endFrame = Math.min(clipEnd(clip), clip.startFrame + ceilTime(toFrame(selection.end)));
  if (startFrame >= endFrame || endFrame > document.sequenceEndFrame) throw new SequenceError('INVALID_RANGE', '発話の範囲がシーケンス外です');
  return { startFrame, endFrame };
}
