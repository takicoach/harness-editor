/**
 * Spike (2026-11-08, branch spike/html-in-canvas-157-20261108): frame-by-frame PSNR between two MP4s of the same
 * project (FFmpeg's psnr filter on the decoded YUV, so it runs in constant memory for long videos).
 *
 *   node --import tsx scripts/export-mp4-compare.ts OUT.json LABEL A.mp4 B.mp4 [LABEL A.mp4 B.mp4 ...]
 *
 * For each pair: frame counts, PSNR per frame (A_i against B_i), its minimum and mean, the five worst frames, file sizes,
 * and for the three worst frames a picture A | B | difference×8 next to OUT.json (sheets/<label>-f<frame>.png).
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** PSNR per frame of A_i against B_(i+shift), from FFmpeg's psnr stats (Infinity for identical frames). */
export function psnrSeries(ffmpeg: string, a: string, b: string, shift = 0): number[] {
  const stats = join(tmpdir(), `spike-psnr-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.log`);
  const left = shift < 0 ? `[0:v]trim=start_frame=${-shift},setpts=PTS-STARTPTS[a]` : '[0:v]setpts=PTS-STARTPTS[a]';
  const right = shift > 0 ? `[1:v]trim=start_frame=${shift},setpts=PTS-STARTPTS[b]` : '[1:v]setpts=PTS-STARTPTS[b]';
  try {
    execFileSync(ffmpeg, ['-v', 'error', '-i', a, '-i', b, '-lavfi', `${left};${right};[a][b]psnr=stats_file=${stats.replace(/:/g, '\\:')}`, '-f', 'null', '-'],
      { maxBuffer: 64 * 1024 * 1024 });
    return readFileSync(stats, 'utf8').trim().split('\n').map(line => {
      const value = /psnr_avg:(\S+)/.exec(line)?.[1];
      return value === undefined || value === 'inf' ? Infinity : Number(value);
    });
  } finally { rmSync(stats, { force: true }); }
}

export function frameCount(ffprobe: string, file: string): number {
  return Number(execFileSync(ffprobe, ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', file], { encoding: 'utf8' }).trim());
}

/** A | B | difference×8 of frame n, scaled to 2880 px wide. */
export function sideBySide(ffmpeg: string, a: string, b: string, n: number, out: string): void {
  mkdirSync(dirname(out), { recursive: true });
  execFileSync(ffmpeg, ['-v', 'error', '-i', a, '-i', b, '-filter_complex',
    `[0:v]select=eq(n\\,${n}),format=gbrp,split[a1][a2];[1:v]select=eq(n\\,${n}),format=gbrp,split[b1][b2];` +
    `[a2][b2]blend=all_mode=difference,lutrgb=r=val*8:g=val*8:b=val*8[d];[a1][b1][d]hstack=3,scale=2880:-2`, '-frames:v', '1', '-y', out]);
}

const round = (n: number) => Number.isFinite(n) ? Math.round(n * 100) / 100 : n;

export function compareMp4(ffmpeg: string, ffprobe: string, label: string, a: string, b: string, sheets: string) {
  const series = psnrSeries(ffmpeg, a, b), finite = series.filter(Number.isFinite);
  const worst = series.map((psnr, frame) => ({ frame, psnr })).sort((x, y) => x.psnr - y.psnr).slice(0, 5);
  for (const item of worst.slice(0, 3)) sideBySide(ffmpeg, a, b, item.frame, join(sheets, `${label}-f${item.frame}.png`));
  return { label, a, b, framesA: frameCount(ffprobe, a), framesB: frameCount(ffprobe, b), frames: series.length,
    psnrMin: round(Math.min(...series)), psnrMean: round(finite.length ? finite.reduce((s, v) => s + v, 0) / finite.length : Infinity),
    identicalFrames: series.length - finite.length, worst: worst.map(item => ({ frame: item.frame, psnr: round(item.psnr) })),
    bytesA: statSync(a).size, bytesB: statSync(b).size };
}

async function main() {
  const [out, ...rest] = process.argv.slice(2);
  if (!out || rest.length === 0 || rest.length % 3 !== 0) throw new Error('Usage: export-mp4-compare.ts OUT.json LABEL A.mp4 B.mp4 [...]');
  const { resolveFfmpegBin, resolveFfprobeBin } = await import('../src/server/resolveFfmpeg');
  const ffmpeg = resolveFfmpegBin(), ffprobe = resolveFfprobeBin();
  if (!ffmpeg.ok || !ffprobe.ok) throw new Error('FFmpeg and FFprobe are required');
  const sheets = join(dirname(resolve(out)), 'sheets'), cases = [];
  for (let i = 0; i < rest.length; i += 3) {
    const item = compareMp4(ffmpeg.bin, ffprobe.bin, rest[i]!, resolve(rest[i + 1]!), resolve(rest[i + 2]!), sheets);
    console.error(`[compare] ${item.label}: ${item.frames} frames, PSNR min ${item.psnrMin} mean ${item.psnrMean}, bytes ${item.bytesA} / ${item.bytesB}`);
    cases.push(item);
  }
  writeFileSync(resolve(out), JSON.stringify({ createdAt: new Date().toISOString(), cases }, null, 1));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
