import { existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isBrokenLink } from './browsePaths';
import { parseVideoConfigStatic } from '../core';
import { HttpError } from './http';

/**
 * メイン動画を「外部の実体へのシンボリックリンク」で持つプロジェクトの記録と検査。
 *
 * `public/main.mp4` がリンクかどうかは lstat で分かるが、それだけでは
 * 「同じパスに別の動画が置かれた」場合を検出できない（fps・尺・解像度が
 * videoConfig.ts と食い違ったままプレビューも書き出しも進んでしまう）。
 * そこで作成時に接続先と素材の指紋を `.sme/videoLink.json` に残し、
 * 読み込み時に照合する。
 */

/** `.sme/videoLink.json` の中身。 */
export interface VideoLinkRecord {
  /** リンク先の絶対パス（作成時点）。 */
  target: string;
  sizeBytes: number;
  mtimeMs: number;
  width: number;
  height: number;
  /** 小数 fps を丸めた値（videoConfig.ts と同じ丸め）。 */
  fps: number;
}

/** 現在のリンク状態。 */
export type VideoLinkState = 'ok' | 'broken' | 'mismatch';

export interface VideoLinkStatus {
  target: string;
  state: VideoLinkState;
}

const REL = join('.sme', 'videoLink.json');

/** 記録の保存先（プロジェクト直下 `.sme/videoLink.json`）。 */
export function videoLinkPath(projectDir: string): string {
  return join(projectDir, REL);
}

/** リンク記録を書き込む（`.sme/` が無ければ作る）。 */
export function writeVideoLink(projectDir: string, record: VideoLinkRecord): void {
  mkdirSync(join(projectDir, '.sme'), { recursive: true });
  writeFileSync(videoLinkPath(projectDir), JSON.stringify(record, null, 2) + '\n', 'utf8');
}

/** リンク記録を読む。無い・壊れている場合は null（＝通常のコピー取り込み扱い）。 */
export function readVideoLink(projectDir: string): VideoLinkRecord | null {
  const path = videoLinkPath(projectDir);
  if (!existsSync(path)) return null;
  try {
    const obj = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (typeof obj !== 'object' || obj === null) return null;
    const r = obj as Partial<VideoLinkRecord>;
    if (typeof r.target !== 'string' || r.target === '') return null;
    return {
      target: r.target,
      sizeBytes: typeof r.sizeBytes === 'number' ? r.sizeBytes : 0,
      mtimeMs: typeof r.mtimeMs === 'number' ? r.mtimeMs : 0,
      width: typeof r.width === 'number' ? r.width : 0,
      height: typeof r.height === 'number' ? r.height : 0,
      fps: typeof r.fps === 'number' ? r.fps : 0,
    };
  } catch {
    return null;
  }
}

/** 実体の指紋が記録と一致するか。サイズが同じでも中身が違えば mtime で気づける。 */
export function fingerprintMatches(
  record: VideoLinkRecord,
  actual: { sizeBytes: number; mtimeMs: number },
): boolean {
  if (record.sizeBytes === 0) return true; // 指紋未記録（旧形式）は判定しない
  return record.sizeBytes === actual.sizeBytes && Math.round(record.mtimeMs) === Math.round(actual.mtimeMs);
}

/**
 * リンク型プロジェクトの現在状態を返す。リンク記録が無ければ null
 * （＝コピー取り込みの通常プロジェクト。呼び出し側は何も表示しない）。
 */
export function inspectVideoLink(
  projectDir: string,
  videoFile: string,
  deps: {
    read?: (dir: string) => VideoLinkRecord | null;
    stat?: (p: string) => { size: number; mtimeMs: number };
    broken?: (p: string) => boolean;
  } = {},
): VideoLinkStatus | null {
  const read = deps.read ?? readVideoLink;
  const stat = deps.stat ?? ((p: string) => statSync(p));
  const broken = deps.broken ?? ((p: string) => isBrokenLink(p));

  const record = read(projectDir);
  if (record === null) return null;
  const videoPath = join(projectDir, 'public', videoFile);
  if (broken(videoPath)) return { target: record.target, state: 'broken' };
  let st: { size: number; mtimeMs: number };
  try {
    st = stat(videoPath);
  } catch {
    return { target: record.target, state: 'broken' };
  }
  return {
    target: record.target,
    state: fingerprintMatches(record, { sizeBytes: st.size, mtimeMs: st.mtimeMs }) ? 'ok' : 'mismatch',
  };
}

/** videoConfig.ts からメイン動画のファイル名を静的に読む（実行しない）。読めなければ null。 */
export function projectVideoFile(projectDir: string): string | null {
  try {
    const source = readFileSync(join(projectDir, 'src', 'videoConfig.ts'), 'utf8');
    return parseVideoConfigStatic(source).videoFile;
  } catch {
    return null;
  }
}

/** プロジェクトディレクトリだけからリンク状態を調べる（videoConfig を自分で読む）。 */
export function inspectProjectVideoLink(projectDir: string): VideoLinkStatus | null {
  const videoFile = projectVideoFile(projectDir);
  if (videoFile === null) return null;
  return inspectVideoLink(projectDir, videoFile);
}

/**
 * 「原本をプロジェクト内へコピーして差し替える」種類の加工（音量調整・ノイズ除去とその復元）を
 * リンク型プロジェクトで禁止する。
 *
 * `ensureBackup` は原本を `copyFileSync` でプロジェクト内へ複製し、処理後に `rename` で
 * `main.*` を差し替える。リンク型で実行すると外付けの巨大原本が内蔵へ再コピーされたうえ、
 * symlink が通常ファイルに置換されて「内蔵を消費しない」という目的そのものが壊れる。
 * UI でもボタンを無効化するが、API 単体でも必ず弾く（二重防御）。
 */
export function assertVideoProcessingAllowed(projectDir: string, action: string): void {
  if (readVideoLink(projectDir) === null) return;
  throw new HttpError(
    409,
    `${action}は、外付けからリンクで取り込んだ動画では実行できません（元動画をプロジェクト内に複製してしまうため）。` +
      '加工が必要な場合は「パソコンから選ぶ」でコピー取り込みし直してください',
  );
}

/** 書き出し前に原本（リンク先の実体）が読めることを確認する。 */
export function assertSourceAvailable(projectDir: string): void {
  const status = inspectProjectVideoLink(projectDir);
  if (status === null || status.state === 'ok') return;
  const reason =
    status.state === 'broken'
      ? '元動画が見つかりません（外付けドライブが接続されていない可能性があります）'
      : '接続先が別の動画に変わっています';
  throw new HttpError(409, `${reason}。接続先: ${status.target}`);
}

/**
 * リンクを張る（実体はコピーしない）。既に何かある場合は呼び出し側で除去済みであること。
 * symlinkSync を差し替え可能にしてテストで失敗系を作れるようにする。
 */
export function linkVideoIntoPlace(
  targetPath: string,
  linkPath: string,
  symlink: (t: string, p: string) => void = symlinkSync,
): void {
  symlink(targetPath, linkPath);
}
