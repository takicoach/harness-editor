import type { TranscriptFixed, TranscriptFixedSegment } from './types';

/** transcript_fixed.json を読み取り、学習に必要な segments を返す。 */
export function parseTranscriptFixed(json: string): TranscriptFixed {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('transcript_fixed.json を JSON として解析できません');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('transcript_fixed.json はオブジェクトではありません');
  }
  const parsedObj = parsed as Record<string, unknown>;
  if (!Array.isArray(parsedObj.segments)) {
    throw new Error('transcript_fixed.json に segments 配列がありません');
  }
  const segments: TranscriptFixedSegment[] = (parsedObj.segments as TranscriptFixedSegment[]).map(
    (s) => ({
      text: String(s.text ?? ''),
      start: Number(s.start),
      end: Number(s.end),
    }),
  );
  return { segments };
}
