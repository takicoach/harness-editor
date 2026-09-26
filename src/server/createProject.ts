// Shared probing for existing-project relinking and script alignment.
// Native creation lives in sequence/create.ts; no template creation or install.
import { execFileSync } from 'node:child_process';
import { HttpError } from './http';
import { ffprobeFromFfmpeg, resolveFfmpegBin } from './resolveFfmpeg';
export { sanitizeProjectName, precheckCreateProject } from './projectCreationChecks';

/** ffprobe で取得した動画の基本情報。 */
export interface ProbedVideo {
  fps: number;
  durationSeconds: number;
  width: number;
  height: number;
}

/** ffprobe の JSON 出力から必要な値を取り出す。 */
export function parseProbeOutput(jsonText: string): ProbedVideo {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new HttpError(422, '動画情報の解析に失敗しました（ffprobe 出力が不正）');
  }
  const obj = parsed as {
    streams?: Array<{ width?: number; height?: number; r_frame_rate?: string; duration?: string }>;
    format?: { duration?: string };
  };
  const stream = obj.streams?.[0];
  if (!stream || typeof stream.width !== 'number' || typeof stream.height !== 'number') {
    throw new HttpError(422, 'このファイルは動画として読み込めませんでした（映像ストリームなし）');
  }
  const rate = stream.r_frame_rate ?? '';
  const [num = NaN, den] = rate.split('/').map(Number);
  const fps = den ? num / den : Number(rate);
  const durationSeconds = Number(stream.duration ?? obj.format?.duration ?? NaN);
  if (!Number.isFinite(fps) || fps <= 0 || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new HttpError(422, 'この動画の fps または長さを取得できませんでした');
  }
  return { fps, durationSeconds, width: stream.width, height: stream.height };
}

/** ffprobe 実行（ffmpeg と同じ解決手順で ffprobe を探す）。 */
function runFfprobe(videoPath: string): string {
  const ffmpeg = resolveFfmpegBin();
  if (!ffmpeg.ok) throw new HttpError(500, ffmpeg.message);
  const ffprobe = ffprobeFromFfmpeg(ffmpeg.bin);
  try {
    return execFileSync(
      ffprobe,
      [
        '-v', 'error',
        '-select_streams', 'v:0',
        '-show_entries', 'stream=width,height,r_frame_rate,duration',
        '-show_entries', 'format=duration',
        '-of', 'json',
        videoPath,
      ],
      { encoding: 'utf8', maxBuffer: 1024 * 1024 },
    );
  } catch {
    throw new HttpError(422, 'このファイルは動画として読み込めませんでした');
  }
}

/** ffprobe で動画の基本情報を取る（既定の検出手段）。 */
export function probeVideo(videoPath: string): ProbedVideo {
  return parseProbeOutput(runFfprobe(videoPath));
}
