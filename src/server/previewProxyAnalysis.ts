import { statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { HttpError } from './http';
import { LARGE_UPLOAD_NOTICE_BYTES } from '../shared/uploadNotice';
import { ffprobeFromFfmpeg, resolveFfmpegBin } from './resolveFfmpeg';

/**
 * プレビュー軽量化（preview proxy）の推奨判定。
 *
 * Remotion のプレビューは動画をブラウザの <video> でそのまま再生するため、
 * 快適さはファイル容量そのものより「作り」（尺・解像度・コーデック・フレームレートの安定性）
 * に左右される。ここでは ffprobe の情報から「軽量化をおすすめすべきか」と
 * ユーザーに見せる理由文を導出する。
 */

/** ffprobe ＋ ファイルサイズから得た、判定に必要な元動画情報。 */
export interface ProxySourceInfo {
  sizeBytes: number;
  durationSeconds: number;
  width: number;
  height: number;
  /** 公称フレームレート（r_frame_rate）。 */
  fps: number;
  /** 実測平均フレームレート（avg_frame_rate）。取得できなければ null。 */
  avgFps: number | null;
  /** 映像コーデック名（例: h264 / hevc）。取得できなければ null。 */
  codecName: string | null;
}

export interface ProxyRecommendation {
  recommended: boolean;
  /** ユーザーへそのまま表示できる日本語の理由（該当したものだけ）。 */
  reasons: string[];
}

/** 推奨トリガー: 尺 10 分以上。 */
const RECOMMEND_DURATION_SEC = 10 * 60;
/** 推奨トリガー: 500MB 以上（投入時の事前案内と同じしきい値を共有）。 */
const RECOMMEND_SIZE_BYTES = LARGE_UPLOAD_NOTICE_BYTES;
/** 推奨トリガー: 短辺が 1080px 超（4K など。縦動画の 1080×1920 は対象外）。 */
const RECOMMEND_SHORT_SIDE_PX = 1080;
/** 公称 fps と平均 fps の乖離がこの比率を超えたら可変フレームレート（VFR）とみなす。 */
const VFR_RATIO_THRESHOLD = 0.01;

/** "30000/1001" 形式の有理数文字列を数値へ。壊れていれば null。 */
export function parseRational(text: string | undefined): number | null {
  if (!text) return null;
  const [num = NaN, den] = text.split('/').map(Number);
  const v = den === undefined ? num : den === 0 ? NaN : num / den;
  return Number.isFinite(v) && v > 0 ? v : null;
}

/** ffprobe の JSON 出力（拡張 entries）を ProxySourceInfo へ変換する。 */
export function parseProxyProbeOutput(jsonText: string, sizeBytes: number): ProxySourceInfo {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new HttpError(422, '動画情報の解析に失敗しました（ffprobe 出力が不正）');
  }
  const obj = parsed as {
    streams?: Array<{
      width?: number;
      height?: number;
      r_frame_rate?: string;
      avg_frame_rate?: string;
      codec_name?: string;
      duration?: string;
    }>;
    format?: { duration?: string };
  };
  const stream = obj.streams?.[0];
  if (!stream || typeof stream.width !== 'number' || typeof stream.height !== 'number') {
    throw new HttpError(422, 'このファイルは動画として読み込めませんでした（映像ストリームなし）');
  }
  const fps = parseRational(stream.r_frame_rate);
  // stream.duration は ffprobe 版によって "N/A" 文字列を返すことがある（MKV/WebM 等）。
  // null 合体でなく数値妥当性でフォールバックし、有効な format.duration を取りこぼさない。
  const streamDur = Number(stream.duration ?? NaN);
  const formatDur = Number(obj.format?.duration ?? NaN);
  const durationSeconds = Number.isFinite(streamDur) && streamDur > 0 ? streamDur : formatDur;
  if (fps === null || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new HttpError(422, 'この動画の fps または長さを取得できませんでした');
  }
  return {
    sizeBytes,
    durationSeconds,
    width: stream.width,
    height: stream.height,
    fps,
    avgFps: parseRational(stream.avg_frame_rate),
    codecName: typeof stream.codec_name === 'string' && stream.codec_name !== '' ? stream.codec_name : null,
  };
}

/** 元動画情報から軽量化の推奨可否と理由を導出する（純関数）。 */
export function analyzeProxyNeed(info: ProxySourceInfo): ProxyRecommendation {
  const reasons: string[] = [];
  if (info.durationSeconds >= RECOMMEND_DURATION_SEC) {
    reasons.push(`長尺（約${Math.round(info.durationSeconds / 60)}分）`);
  }
  if (info.sizeBytes >= RECOMMEND_SIZE_BYTES) {
    reasons.push(`容量が大きい（${Math.round(info.sizeBytes / (1024 * 1024))}MB）`);
  }
  if (Math.min(info.width, info.height) > RECOMMEND_SHORT_SIDE_PX) {
    reasons.push(`高解像度（${info.width}×${info.height}）`);
  }
  if (info.codecName !== null && info.codecName !== 'h264') {
    reasons.push(`ブラウザが苦手なコーデック（${info.codecName.toUpperCase()}）`);
  }
  if (info.avgFps !== null && Math.abs(info.fps - info.avgFps) / info.fps > VFR_RATIO_THRESHOLD) {
    reasons.push('可変フレームレート（Zoom・画面録画で多い形式）');
  }
  return { recommended: reasons.length > 0, reasons };
}

/** ffprobe で ProxySourceInfo を取得する（createProject の runFfprobe と同じ解決手順）。 */
export function probeProxySource(videoPath: string): ProxySourceInfo {
  const ffmpeg = resolveFfmpegBin();
  if (!ffmpeg.ok) throw new HttpError(500, ffmpeg.message);
  const ffprobe = ffprobeFromFfmpeg(ffmpeg.bin);
  let out: string;
  try {
    out = execFileSync(
      ffprobe,
      [
        '-v', 'error',
        '-select_streams', 'v:0',
        '-show_entries', 'stream=width,height,r_frame_rate,avg_frame_rate,codec_name,duration',
        '-show_entries', 'format=duration',
        '-of', 'json',
        videoPath,
      ],
      { encoding: 'utf8', maxBuffer: 1024 * 1024 },
    );
  } catch {
    throw new HttpError(422, 'このファイルは動画として読み込めませんでした');
  }
  return parseProxyProbeOutput(out, statSync(videoPath).size);
}

/** 動画ファイルの尺（秒）を ffprobe で取得。失敗時は null（検証呼び出し側でエラー化）。 */
export function probeDurationSeconds(videoPath: string): number | null {
  const ffmpeg = resolveFfmpegBin();
  if (!ffmpeg.ok) return null;
  const ffprobe = ffprobeFromFfmpeg(ffmpeg.bin);
  try {
    const out = execFileSync(
      ffprobe,
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', videoPath],
      { encoding: 'utf8', maxBuffer: 1024 * 1024 },
    );
    const parsed = JSON.parse(out) as { format?: { duration?: string } };
    const d = Number(parsed.format?.duration ?? NaN);
    return Number.isFinite(d) && d > 0 ? d : null;
  } catch {
    return null;
  }
}
