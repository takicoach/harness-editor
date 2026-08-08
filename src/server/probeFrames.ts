import { execFileSync } from 'node:child_process';
import { ffprobeFromFfmpeg, resolveFfmpegBin } from './resolveFfmpeg';

/**
 * 動画の総フレーム数を ffprobe で数える（パケット数え上げ）。
 * 取得できない場合は null（検算をスキップするだけで、書き出し自体は成功扱い）。
 */
export function probeFrameCount(path: string): number | null {
  const ffmpeg = resolveFfmpegBin();
  if (!ffmpeg.ok) return null;
  try {
    const out = execFileSync(
      ffprobeFromFfmpeg(ffmpeg.bin),
      [
        '-v', 'error',
        '-select_streams', 'v:0',
        '-count_packets',
        '-show_entries', 'stream=nb_read_packets',
        '-of', 'csv=p=0',
        path,
      ],
      { encoding: 'utf8', maxBuffer: 1024 * 1024 },
    );
    const n = Number(out.trim());
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}
