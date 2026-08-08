import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseVideoConfig, serializeCutData } from '../core';
import type { CutSegment } from '../core/types';
import { HttpError } from './http';

// cutData.ts の探索候補（loadProjectFiles.ts の CUT_DATA_CANDIDATES と同一・
// テロップディレクトリ名を変える場合は両ファイルを揃えて更新すること）。
const CUT_DATA_CANDIDATES = ['cutData.ts', 'src/cutData.ts', 'src/テロップテンプレート/cutData.ts'];

/** プロジェクトに cutData.ts がいずれかの候補位置に存在するか。 */
export function hasCutData(dir: string): boolean {
  return CUT_DATA_CANDIDATES.some((rel) => existsSync(join(dir, rel)));
}

/**
 * 焼き込み済みカットのプロジェクトを非破壊モデルへ変換する。
 * 動画全体を 1 つの「残す区間」とした恒等 cutData.ts をプロジェクト直下へ生成する。
 * これにより「cutData.ts 不在＝モデル未確定」が解消し、以後のカット編集は非破壊で記録される。
 * 焼き込み済みのカット自体は動画へ適用済みのため復元しない（spec §15 リスク#4・ffmpeg 不要方針）。
 * すでに cutData.ts があるプロジェクトは変換不要として HttpError(400)。
 */
export function convertBurnedInProject(dir: string): { cutDataRelPath: string } {
  if (hasCutData(dir)) {
    throw new HttpError(400, 'このプロジェクトには既に cutData.ts があり、変換は不要です');
  }
  const vcPath = join(dir, 'src', 'videoConfig.ts');
  if (!existsSync(vcPath)) {
    throw new HttpError(400, '動画設定 videoConfig.ts が見つかりません');
  }
  const vc = parseVideoConfig(readFileSync(vcPath, 'utf8'));
  const duration = vc.durationFrames;
  // カット 0 件 ＝ 動画全体を残す。恒等 CutSegment を 1 件だけ持たせる。
  const identity: CutSegment[] = [
    { id: 1, originalStart: 0, originalEnd: duration, playbackStart: 0, playbackEnd: duration },
  ];
  const source = serializeCutData(null, identity, duration, duration);
  const rel = 'cutData.ts';
  writeFileSync(join(dir, rel), source, 'utf8');
  return { cutDataRelPath: rel };
}
