import {
  ProjectFileError,
  type Transcript,
  type TranscriptSegment,
  type TranscriptWord,
  type VideoConfig,
} from './types';

/** transcript.json を読み取る。words はトップレベル配列（時刻は ms）。 */
export function parseTranscript(json: string): Transcript {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new ProjectFileError('transcript.json', 'JSON として解析できません');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ProjectFileError('transcript.json', 'オブジェクトではありません');
  }
  const parsedObj = parsed as Record<string, unknown>;
  if (!Array.isArray(parsedObj.words)) {
    throw new ProjectFileError('transcript.json', 'words 配列がありません');
  }
  const words = (parsedObj.words as TranscriptWord[]).map((w) => ({
    text: String(w.text ?? ''),
    start: Number(w.start),
    end: Number(w.end),
    ...(w.confidence !== undefined ? { confidence: Number(w.confidence) } : {}),
  }));
  const rawSegments = Array.isArray(parsedObj.segments) ? (parsedObj.segments as TranscriptSegment[]) : [];
  const segments = rawSegments.map((s) => ({
    text: String(s.text ?? ''),
    start: Number(s.start),
    end: Number(s.end),
  }));
  return {
    durationMs: typeof parsedObj.duration_ms === 'number' ? parsedObj.duration_ms : 0,
    words,
    segments,
  };
}

const ALIGNMENT_TOLERANCE = 0.1;

/**
 * transcript と動画ファイルがおおむね同じ時間軸を共有しているか判定する。
 * 焼き込み済みプロジェクト（transcript=元動画全体・video=抽出後）では false になる。
 * 単語チップは telop と transcript の時間軸が一致している前提なので、
 * false の場合は呼び出し側でチップ生成をスキップする。
 */
export function isTranscriptAlignedWithVideo(
  transcript: Transcript,
  video: VideoConfig,
): boolean {
  if (video.fps <= 0 || video.durationFrames <= 0) return true;
  const videoMs = (video.durationFrames / video.fps) * 1000;
  let txMs = transcript.durationMs;
  if (txMs <= 0) {
    const lastWord = transcript.words[transcript.words.length - 1];
    if (!lastWord) return true; // 判定不能は安全側
    txMs = lastWord.end;
  }
  if (txMs <= 0) return true;
  const denom = Math.max(txMs, videoMs);
  return Math.abs(txMs - videoMs) / denom <= ALIGNMENT_TOLERANCE;
}
