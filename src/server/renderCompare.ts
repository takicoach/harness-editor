import { execFileSync, spawnSync } from 'node:child_process';
import { resolveFfmpegBin } from './resolveFfmpeg';
import { probeFrameCount } from './probeFrames';

/**
 * 2 本の書き出し結果の同値レポート（golden レンダテストの土台）。
 * 合否の閾値は持たない — 判定は呼び出し側（テスト）が行う。
 */
export interface CompareReport {
  refFrames: number | null;
  testFrames: number | null;
  /** ffmpeg ssim フィルタの All 平均（0..1）。 */
  ssimAll: number | null;
  /** ssimAll が null になった理由（exit code・stderr 末尾200字）。計測不能を無言で握り潰さない。 */
  ssimError?: string;
  /** s16le/48k/2ch へ揃えた PCM の長さ差（サンプル）と最大サンプル差。 */
  pcm: { lengthDiff: number; maxAbsDiff: number } | null;
  /** pcm が null になった理由（どちらの pcmOf が失敗したか＋exit code・stderr 末尾200字）。 */
  pcmError?: string;
}

/** ffmpeg ssim フィルタの stderr 集計行から All 値を取り出す。 */
export function parseSsimAll(stderr: string): number | null {
  const m = stderr.match(/All:([0-9.]+)/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

/** s16le バッファ 2 本を比較する（短い方の長さで走査）。 */
export function comparePcm(a: Buffer, b: Buffer): { lengthDiff: number; maxAbsDiff: number } {
  const samplesA = Math.floor(a.length / 2);
  const samplesB = Math.floor(b.length / 2);
  const n = Math.min(samplesA, samplesB);
  let maxAbsDiff = 0;
  for (let i = 0; i < n; i++) {
    const d = Math.abs(a.readInt16LE(i * 2) - b.readInt16LE(i * 2));
    if (d > maxAbsDiff) maxAbsDiff = d;
  }
  return { lengthDiff: Math.abs(samplesA - samplesB), maxAbsDiff };
}

/** s16le インターリーブ PCM の区間 RMS（0..1 正規化）。範囲外は黙って切り詰める。 */
export function pcmWindowRms(
  pcm: Buffer,
  sampleRate: number,
  channels: number,
  startSec: number,
  endSec: number,
): number {
  const frameBytes = channels * 2;
  const totalFrames = Math.floor(pcm.length / frameBytes);
  const start = Math.max(0, Math.min(totalFrames, Math.floor(startSec * sampleRate)));
  const end = Math.max(start, Math.min(totalFrames, Math.floor(endSec * sampleRate)));
  if (end === start) return 0;
  let sum = 0;
  for (let f = start; f < end; f++) {
    for (let c = 0; c < channels; c++) {
      const v = pcm.readInt16LE(f * frameBytes + c * 2) / 32768;
      sum += v * v;
    }
  }
  return Math.sqrt(sum / ((end - start) * channels));
}

const PCM_ARGS = ['-map', 'a:0', '-f', 's16le', '-ac', '2', '-ar', '48000', '-'];

/** 実 ffmpeg を起動して 2 本を突き合わせる（ffmpeg 不在なら null）。テストからは E2E マークで呼ぶ。 */
export function compareVideos(refPath: string, testPath: string): CompareReport | null {
  const ffmpeg = resolveFfmpegBin();
  if (!ffmpeg.ok) return null;
  // ffmpeg の ssim フィルタは正常終了しつつ集計行を stderr に出す。1 回の実行で stderr を読む。
  // ssimAll = null（exit code 不一致 or パース失敗）は寛容に許すが、理由は ssimError に残す
  // （I-5: 計測不能を無言で null に畳んで見逃さない）。
  const result = spawnSync(
    ffmpeg.bin,
    ['-hide_banner', '-i', testPath, '-i', refPath, '-lavfi', 'ssim', '-f', 'null', '-'],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  );
  const ssimAll = parseSsimAll(result.stderr ?? '');
  const stderrTail = (s: string): string => s.slice(-200);
  let ssimError: string | undefined;
  if (ssimAll === null) {
    ssimError = result.status !== 0
      ? `ffmpeg ssim が終了コード ${result.status ?? 'null'} で終了しました: ${stderrTail(result.stderr ?? '')}`
      : `ffmpeg ssim の出力から All 値をパースできませんでした: ${stderrTail(result.stderr ?? '')}`;
  }
  const pcmOf = (p: string): { buf: Buffer | null; error?: string } => {
    try {
      return { buf: execFileSync(ffmpeg.bin, ['-hide_banner', '-i', p, ...PCM_ARGS], {
        maxBuffer: 512 * 1024 * 1024,
      }) };
    } catch (err) {
      const code = err && typeof err === 'object' && 'status' in err ? String((err as { status: unknown }).status) : 'null';
      const stderr = err && typeof err === 'object' && 'stderr' in err
        ? String((err as { stderr: unknown }).stderr ?? '')
        : String(err);
      return { buf: null, error: `ffmpeg PCM 抽出が終了コード ${code} で終了しました: ${stderrTail(stderr)}` };
    }
  };
  const ref = pcmOf(refPath);
  const test = pcmOf(testPath);
  let pcmError: string | undefined;
  if (ref.buf === null || test.buf === null) {
    const parts: string[] = [];
    if (ref.buf === null) parts.push(`ref: ${ref.error ?? '不明なエラー'}`);
    if (test.buf === null) parts.push(`test: ${test.error ?? '不明なエラー'}`);
    pcmError = parts.join(' / ');
  }
  return {
    refFrames: probeFrameCount(refPath),
    testFrames: probeFrameCount(testPath),
    ssimAll,
    ...(ssimError !== undefined ? { ssimError } : {}),
    pcm: ref.buf !== null && test.buf !== null ? comparePcm(ref.buf, test.buf) : null,
    ...(pcmError !== undefined ? { pcmError } : {}),
  };
}
