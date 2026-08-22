import { evalDataModule } from './dataModule';
import { readModuleExportsStatic } from './staticModule';
import { ProjectFileError, type Orientation, type TitleStyle, type VideoConfig, type VideoFormat } from './types';

function orientationOf(width: number, height: number): Orientation {
  if (width === height) return 'square';
  return width > height ? 'landscape' : 'portrait';
}

/** unknown が有限数ならそのまま、そうでなければ fallback を返す。 */
function numOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * TELOP_CONFIG からタイトル帯のスタイルを取り出す。
 * 非標準プロジェクト（TELOP_CONFIG 不在・タイトル系フィールド欠落）では解像度から既定値を導く。
 */
function readTitleStyle(
  telopConfig: unknown,
  resolution: { width: number; height: number },
): TitleStyle {
  const c = (typeof telopConfig === 'object' && telopConfig !== null
    ? (telopConfig as Record<string, unknown>)
    : {});
  return {
    top: numOr(c.titleTop, Math.round(resolution.height * 0.03)),
    left: numOr(c.titleLeft, Math.round(resolution.width * 0.03)),
    fontSize: numOr(c.titleFontSize, Math.round(resolution.height * 0.022)),
  };
}

/**
 * TELOP_CONFIG からテロップ下端オフセット（px）を取り出す。
 * プリセットによって値が異なる（標準テンプレート short=200 / golf-short-gold=540）。
 * TELOP_CONFIG 不在・bottomOffset が有限数でない場合は null を返し、呼び出し側で
 * 標準値（`preview/telopLayout.ts` の telopBottomFrac）へフォールバックさせる。
 * **負値も null 扱い**（画面下端より下のアンカーは実描画にあり得ず、枠が画面外へ出るだけ）。
 * 0 は有効値（下端ぴったり）。
 */
function readTelopBottomOffset(telopConfig: unknown): number | null {
  if (typeof telopConfig !== 'object' || telopConfig === null) return null;
  const v = (telopConfig as Record<string, unknown>).bottomOffset;
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
}

/** 評価済み export マップ（m）から VideoConfig を組み立てる（検証込み）。 */
function buildVideoConfig(m: Record<string, unknown>): VideoConfig {
  const format = m.FORMAT as VideoFormat | undefined;
  const fps = m.FPS;
  const durationFrames = m.DURATION_FRAMES;
  const resolution = m.RESOLUTION as { width: number; height: number } | undefined;

  if (!format || typeof fps !== 'number' || typeof durationFrames !== 'number') {
    throw new ProjectFileError(
      'videoConfig.ts',
      'FORMAT / FPS / DURATION_FRAMES を読み取れません',
    );
  }
  if (!resolution || typeof resolution.width !== 'number' || typeof resolution.height !== 'number') {
    throw new ProjectFileError('videoConfig.ts', 'RESOLUTION を読み取れません');
  }

  return {
    format,
    fps,
    durationFrames,
    videoFile: typeof m.VIDEO_FILE === 'string' ? m.VIDEO_FILE : 'main.mp4',
    resolution,
    orientation: orientationOf(resolution.width, resolution.height),
    titleStyle: readTitleStyle(m.TELOP_CONFIG, resolution),
    telopBottomOffset: readTelopBottomOffset(m.TELOP_CONFIG),
  };
}

/**
 * ハーネス形式の videoConfig.ts を読み取り VideoConfig を返す（vm 実行版）。
 * プロジェクトを明示的に開くとき（loadProject 経由）に使う。
 */
export function parseVideoConfig(source: string): VideoConfig {
  return buildVideoConfig(evalDataModule(source));
}

/**
 * videoConfig.ts を「コードを実行せず」に読み取り VideoConfig を返す（静的解析版）。
 * ホーム一覧表示など、ユーザーが開いていないプロジェクトも走査する経路で使う。
 * 悪意ある設定ファイルによる任意コード実行を防ぐため、vm 実行を避ける。
 * 静的に読めない非標準 config は ProjectFileError を投げる（呼び出し側で一覧から除外）。
 */
export function parseVideoConfigStatic(source: string): VideoConfig {
  let m: Record<string, unknown>;
  try {
    m = readModuleExportsStatic(source);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new ProjectFileError('videoConfig.ts', `静的に読み取れません: ${detail}`);
  }
  return buildVideoConfig(m);
}
