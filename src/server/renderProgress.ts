// src/server/renderProgress.ts
/** Remotion CLI stdout の進捗。 */
export interface RenderProgress {
  frames: number;
  total: number;
  percent: number;
}

const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;
const RENDERED_RE = /Rendered\s+(\d+)\/(\d+)/g;

/**
 * Remotion CLI の stdout チャンクから最後の `Rendered N/M` を抽出する。
 * CLI バージョン差で形式が変わった場合は null（UI はスピナーへフォールバック）。
 */
export function parseRenderProgress(chunk: string): RenderProgress | null {
  const clean = chunk.replace(ANSI_RE, '');
  let last: RegExpExecArray | null = null;
  for (const m of clean.matchAll(RENDERED_RE)) last = m;
  if (!last) return null;
  const frames = Number(last[1]);
  const total = Number(last[2]);
  if (!Number.isFinite(frames) || !Number.isFinite(total) || total <= 0) return null;
  return { frames, total, percent: Math.min(100, Math.round((frames / total) * 100)) };
}
