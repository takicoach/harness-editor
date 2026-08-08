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
