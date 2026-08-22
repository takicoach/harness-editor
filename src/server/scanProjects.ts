import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseVideoConfigStatic } from '../core';
import { orientationCode } from '../shared/orientation';
import { formatClock, formatSize } from '../shared/format';
import type { ProjectSummary } from '../shared/types';
import { resolveProjectStatus } from './projectStatus';
import { inspectVideoLink } from './videoLink';

const TELOP_DIR = 'テロップテンプレート';

/** videoConfig.ts の読み取り上限。正規の設定ファイルは数 KB。巨大ファイルによる OOM を防ぐ。 */
const MAX_VIDEO_CONFIG_BYTES = 1024 * 1024;

/** ディレクトリがハーネス形式（旧形式互換）のプロジェクトの体裁を持つか判定する。 */
export function isHarnessProject(dir: string): boolean {
  return (
    existsSync(join(dir, 'src', 'videoConfig.ts')) &&
    existsSync(join(dir, 'src', TELOP_DIR, 'telopData.ts'))
  );
}

function summarize(name: string, dir: string): ProjectSummary {
  const vcPath = join(dir, 'src', 'videoConfig.ts');
  // 走査は信頼していないプロジェクトも読むため、読み込み前にサイズ上限で DoS（巨大ファイル OOM）を弾く。
  if (statSync(vcPath).size > MAX_VIDEO_CONFIG_BYTES) {
    throw new Error('videoConfig.ts が大きすぎます');
  }
  const vcSource = readFileSync(vcPath, 'utf8');
  // 一覧表示は「開いていないプロジェクト」も走査するため、コードを実行しない静的読み取りを使う
  // （悪意ある videoConfig.ts による任意コード実行の防止）。
  const vc = parseVideoConfigStatic(vcSource);
  const seconds = vc.fps > 0 ? vc.durationFrames / vc.fps : 0;
  // 外部実体へのリンク（外付けストレージ取り込み）の状態。通常のコピー取り込みなら null。
  const videoLink = inspectVideoLink(dir, vc.videoFile);
  let videoFile: string | null = vc.videoFile;
  let sizeBytes = 0;
  let sizeKnown = true;
  try {
    sizeBytes = statSync(join(dir, 'public', vc.videoFile)).size;
  } catch {
    sizeKnown = false;
    // リンク切れは「動画未配置」ではない。videoFile を保持したまま切れている旨を出し、
    // 接続し直せば元に戻ることを示す（null にするとカードから動画の存在自体が消える）。
    if (videoLink === null) videoFile = null; // 動画未配置: サムネなし・サイズ不明
  }
  return {
    id: name,
    name,
    orientation: orientationCode(vc.orientation),
    durationLabel: formatClock(seconds),
    sizeLabel: sizeKnown ? formatSize(sizeBytes) : '—',
    videoFile,
    ...(videoLink === null ? {} : { videoLink }),
    ...resolveProjectStatus(dir),
  };
}

/** ルート直下を走査しハーネス形式のプロジェクトの一覧を返す。 */
export function scanProjects(root: string): ProjectSummary[] {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  const out: ProjectSummary[] = [];
  for (const name of entries) {
    if (name.startsWith('.')) continue;
    const dir = join(root, name);
    let isDir = false;
    try {
      isDir = statSync(dir).isDirectory();
    } catch {
      continue;
    }
    if (!isDir || !isHarnessProject(dir)) continue;
    try {
      out.push(summarize(name, dir));
    } catch (err) {
      console.warn(`[sme] プロジェクト "${name}" の要約に失敗（一覧から除外）:`, err);
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name, 'ja'));
  return out;
}
