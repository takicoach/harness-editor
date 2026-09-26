/**
 * renderPreset — 書き出しプリセットの純ロジック（クライアント/サーバ共用）。
 *
 * プリセットは `remotion render` の `--scale` / `--crf` への変換だけで実現する。
 * フォーマット（youtube/short/square）自体は変えない（プロジェクト作成時に決まる）。
 */

import type { DuckingSettings, Orientation } from '../core/types';

/**
 * 解像度の選択肢。
 * - full  = 原本（プロジェクト）の解像度そのまま。4K 素材なら 4K で出る
 * - 1080p = 短辺 1080（横型なら 1920×1080）。原本がこれより小さければ縮小しない
 * - 720p  = 長辺基準で 2/3 縮小（従来の「軽量」）
 */
export type RenderResolution = 'full' | '1080p' | '720p';

/** 画質の選択肢（H.264 CRF へ変換）。 */
export type RenderQuality = 'high' | 'standard' | 'light';

/** ダイアログ→サーバへ渡す書き出しオプション。 */
export interface RenderOptions {
  resolution: RenderResolution;
  quality: RenderQuality;
  /** 保存先 out 内の MP4 ファイル名。省略時は解像度に応じた既定名。 */
  outputName?: string;
  /**
   * ダッキング設定（省略＝undefined＝後方互換）。省略時は fastCutPlan 側が従来の
   * 焼き込み検知ゲート（bgmSourceHasDucking）で Remotion 退避を判断する。
   */
  ducking?: DuckingSettings;
}

/** SNS 名プリセット（詳細設定のショートカット）。 */
export type RenderPresetId = 'post' | 'standard' | 'light';

export const RENDER_PRESETS: Record<RenderPresetId, RenderOptions> = {
  post: { resolution: 'full', quality: 'high' },
  standard: { resolution: 'full', quality: 'standard' },
  light: { resolution: '720p', quality: 'light' },
};

/** 既定値（body 無し POST の後方互換もこれ）。 */
export const DEFAULT_RENDER_OPTIONS: RenderOptions = RENDER_PRESETS.post;

const CRF_MAP: Record<RenderQuality, number> = {
  high: 18,
  standard: 23,
  // 28 だとズーム/パン区間で圧縮ポンピング（微チラつき）が残るため 24（2026-07-09 実測）。
  light: 24,
};
export const renderQualityCrf = (quality: RenderQuality): number => CRF_MAP[quality];

/**
 * 中間レンダー用の低ロス CRF。最終画質は postScaleArgs（ffmpeg）側の CRF_MAP が決めるため、
 * ここは縮小前の情報量を保つことだけが目的。
 */
const INTERMEDIATE_CRF = 14;

/**
 * スーパーサンプリング倍率。ズーム/パン変形中の Chromium リサンプリングは
 * 細かいテクスチャ（ネット・芝目等）でフレーム毎に揺らぐシマー（チラつき）を生む。
 * 1.5 倍で描画→lanczos で 2/3 縮小すると実測でシマーが消える（2026-07-09 dji-0688 検証:
 * 隣接フレームのシャープネス振動 44/160 → 0/160）。
 */
const SUPERSAMPLE = 1.5;

/** 720p 相当 = 1080 基準の 2/3 縮小（縦横どちらのフォーマットでも長辺比は同じ）。 */
const SCALE_720P = 2 / 3;

/** 1080p の基準＝短辺 1080（横 1920×1080 / 縦 1080×1920 / 正方 1080×1080）。 */
const SHORT_EDGE_1080 = 1080;

/** 偶数へ丸める（H.264 は奇数解像度を扱えない）。 */
function even(n: number): number {
  return Math.max(2, Math.round(n / 2) * 2);
}

/**
 * 出力の実解像度を返す。UI のラベルと、ffmpeg の scale フィルタの両方がこれを使う
 * （表示と実出力がずれないよう 1 か所に集約する）。
 */
export function targetResolution(
  width: number,
  height: number,
  resolution: RenderResolution,
): { width: number; height: number } {
  if (resolution === 'full') return { width, height };
  if (resolution === '1080p') {
    const shortEdge = Math.min(width, height);
    // 原本が 1080 以下なら拡大しない（引き伸ばしても情報は増えない）。
    if (shortEdge <= SHORT_EDGE_1080) return { width, height };
    const ratio = SHORT_EDGE_1080 / shortEdge;
    return { width: even(width * ratio), height: even(height * ratio) };
  }
  return { width: even(width * SCALE_720P), height: even(height * SCALE_720P) };
}

/**
 * RenderOptions → remotion render の追加 CLI 引数（中間レンダー）。
 * 解像度によらず 1.5 倍スーパーサンプリングで描画し、postScaleArgs の ffmpeg で
 * full=2/3（等倍へ）、720p=4/9（720p へ）に lanczos 縮小して最終出力になる。
 * 720p も SS 中間を使う方が等倍中間よりシマーが少ない（2026-07-09 実測 13→8/160）。
 */
export function renderExtraArgs(_options: RenderOptions): string[] {
  // Remotion の AAC は libfdk_aac → ADTS → MP4 copy の段で encoder delay 情報を失い、
  // 実測で元音声が 2048 samples 遅れる。中間だけ PCM/MKV にし、下の post 工程で
  // 最終 MP4 の AAC を一度だけ encode する。
  return [
    '--crf', String(INTERMEDIATE_CRF),
    '--scale', String(SUPERSAMPLE),
    '--codec', 'h264-mkv',
    '--audio-codec', 'pcm-16',
    // ブラウザ合成のRGBをPNGで渡し、SDR出力の色変換を明示する。
    // プロジェクト側のJPEG設定では緑・画像の色差が出るためCLIで上書きする。
    // native経路の入力動画の色解釈とは別の設定。
    '--image-format', 'png',
    '--color-space', 'bt709',
  ];
}

export type PostScaleAudioMode = 'copy' | 'aac';

/**
 * 中間レンダー（1.5 倍）→ 最終出力の ffmpeg 引数（lanczos 縮小＋最終 CRF）。
 * trunc(iw/3)*2 = 2/3、trunc(iw/9)*4 = 4/9。どちらも偶数を同時に満たす
 * （H.264 は奇数解像度不可）。native MP4は音声copyを維持し、Remotion PCM中間は
 * ここで最終AACへ一度だけencodeする。
 */
export function postScaleArgs(
  options: RenderOptions,
  input: string,
  output: string,
  /** プロジェクト（合成）の解像度。中間ファイルはこの 1.5 倍で描かれている。 */
  source: { width: number; height: number },
  /** native MP4 は copy、Remotion PCM/MKV 中間だけ AAC を一度 encodeする。 */
  audioMode: PostScaleAudioMode = 'copy',
): string[] {
  // 中間の 1.5 倍から、最終解像度（絶対値）へ一度で縮小する。
  const target = targetResolution(source.width, source.height, options.resolution);
  // FFmpeg 8では出力オプションだけでなく各フレームの色属性も必要。
  // setparamsは変換済みの値をタグ付けし、画素の再変換は行わない。
  const vf = `scale=${target.width}:${target.height}:flags=lanczos`
    + (audioMode === 'aac' ? ',setparams=range=limited:color_primaries=bt709:color_trc=bt709:colorspace=bt709' : '');
  return [
    '-i', input,
    '-vf', vf,
    '-c:v', 'libx264',
    '-preset', 'medium',
    '-crf', String(CRF_MAP[options.quality]),
    '-pix_fmt', 'yuv420p',
    // Remotion CLIのBT.709中間はprimaries/transferタグを失うことがある。
    // 変換済みのRemotion経路だけを明示し、native素材の色を推測で上書きしない。
    ...(audioMode === 'aac' ? [
      '-colorspace', 'bt709', '-color_primaries', 'bt709',
      '-color_trc', 'bt709', '-color_range', 'tv',
    ] : []),
    '-movflags', '+faststart',
    '-c:a', audioMode === 'aac' ? 'aac' : 'copy',
    ...(audioMode === 'aac' ? ['-b:a', '320k'] : []),
    '-y', output,
  ];
}

/** 最終出力ファイル名。縮小版は投稿用と取り違えないよう suffix を付ける。 */
export function renderOutputName(options: RenderOptions): string {
  if (options.outputName !== undefined) return options.outputName;
  if (options.resolution === '720p') return 'video-720p.mp4';
  if (options.resolution === '1080p') return 'video-1080p.mp4';
  return 'video.mp4';
}

/** UI と API で共有する、パスを含まない移植可能な MP4 名の検証。 */
export function isValidRenderOutputName(value: unknown): value is string {
  return typeof value === 'string'
    && value === value.trim()
    && value.length <= 120
    && new TextEncoder().encode(value).length <= 240
    && !value.startsWith('.')
    && /\.mp4$/i.test(value)
    && !/[\x00-\x1f\x7f<>:"/\\|?*]/.test(value)
    && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value);
}

/** unknown な body 値を検証して RenderOptions にする（不正は null）。 */
export function parseRenderOptions(body: unknown): RenderOptions | null {
  if (body === undefined || body === null || (typeof body === 'object' && Object.keys(body as object).length === 0)) {
    return DEFAULT_RENDER_OPTIONS;
  }
  if (typeof body !== 'object') return null;
  const rec = body as Record<string, unknown>;
  const resolution = rec['resolution'];
  const quality = rec['quality'];
  if (resolution !== 'full' && resolution !== '1080p' && resolution !== '720p') return null;
  if (quality !== 'high' && quality !== 'standard' && quality !== 'light') return null;
  const outputName = rec['outputName'];
  if (outputName !== undefined && !isValidRenderOutputName(outputName)) return null;
  const named = outputName === undefined ? {} : { outputName };
  const duckingRaw = rec['ducking'];
  if (duckingRaw === undefined) return { resolution, quality, ...named };
  if (typeof duckingRaw !== 'object' || duckingRaw === null) return null;
  const duckingRec = duckingRaw as Record<string, unknown>;
  const enabled = duckingRec['enabled'];
  const strength = duckingRec['strength'];
  if (typeof enabled !== 'boolean') return null;
  if (strength !== 'weak' && strength !== 'mid' && strength !== 'strong') return null;
  return { resolution, quality, ...named, ducking: { enabled, strength } };
}

/** RenderOptions がどのプリセットに一致するか（一致しなければ null = カスタム）。 */
export function matchPreset(options: RenderOptions): RenderPresetId | null {
  for (const id of Object.keys(RENDER_PRESETS) as RenderPresetId[]) {
    const p = RENDER_PRESETS[id];
    if (p.resolution === options.resolution && p.quality === options.quality) return id;
  }
  return null;
}

/** プリセットの表示ラベル（orientation で投稿先名を出し分け）。 */
export function presetLabel(id: RenderPresetId, orientation: Orientation): string {
  if (id === 'post') {
    if (orientation === 'portrait') return 'ショート / Reels 投稿用（高画質）';
    if (orientation === 'square') return 'フィード投稿用（高画質・正方形）';
    return 'YouTube 投稿用（高画質）';
  }
  if (id === 'standard') return '標準（画質とサイズのバランス）';
  return '軽量・確認用（720p・共有やX投稿に）';
}

/** 出力解像度の表示用文字列（例: 1080×1920 → 720×1280）。 */
export function resolutionLabel(
  width: number,
  height: number,
  resolution: RenderResolution,
): string {
  const t = targetResolution(width, height, resolution);
  return `${t.width}×${t.height}`;
}
