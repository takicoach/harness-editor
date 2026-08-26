import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseVideoConfigStatic } from '../core';
import { orientationCode } from '../shared/orientation';
import { formatClock, formatSize } from '../shared/format';
import type { ProjectSummary } from '../shared/types';
import { resolveProjectSteps } from './projectSteps';
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
  // FIFO・キャラクタデバイスは size=0 で上限を素通りし、readFileSync が書き手を待って
  // 恒久ブロックする（一覧 API 全体が固まる）ため、通常ファイルであることも要求する。
  const vcStat = statSync(vcPath);
  if (!vcStat.isFile()) {
    throw new Error('videoConfig.ts が通常ファイルではありません');
  }
  if (vcStat.size > MAX_VIDEO_CONFIG_BYTES) {
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
  // 工程判定は 1 回だけ行い、ステータス自動判定（最初の未完了工程）とステッパー表示で共有する。
  const steps = resolveProjectSteps(dir);
  return {
    id: name,
    name,
    // 保存先の絶対パス（ホームカードの「保存先」表示用）。
    dir,
    orientation: orientationCode(vc.orientation),
    durationLabel: formatClock(seconds),
    sizeLabel: sizeKnown ? formatSize(sizeBytes) : '—',
    videoFile,
    ...(videoLink === null ? {} : { videoLink }),
    ...resolveProjectStatus(dir, steps),
    steps,
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
