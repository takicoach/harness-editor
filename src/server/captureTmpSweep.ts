/**
 * 起動時 GC（M2c 最終広域レビュー I-2a・焦点再レビュー必須1で対象パターン拡張）。
 *
 * fastCutPlan.ts の一時ファイル/ディレクトリは以下の3系統。正常終了時は呼び出し側が
 * rmSync する（撮影経路: prepareCapture の tempDirs 後始末／非撮影経路: plan.cleanup）が、
 * サーバプロセスが強制終了・クラッシュした場合はいずれも `out/` に残り続ける
 * （連番 PNG は数百MB〜数GBになりうる）:
 *   - `.capture-{slug}-{token}` / `.capture-{slug}-{token}-seq{n}`（撮影一時ディレクトリ）
 *   - `cut-filter-{token}.txt`（filter_complex スクリプト・M-4 でジョブ token 付き化）
 *   - `.shape-{i}-{token}.png`（図形オーバーレイ PNG・M-4 でジョブ token 付き化）
 *
 * うち後二者は **非撮影経路（カットのみ・図形のみ = 最も普通の高速書き出し）では
 * prepareCapture 自体が無く、tempDirs による後始末に乗らない**（fastCutPlan.ts の
 * plan.cleanup は正常終了時のみ renderJob 経由で呼ばれる想定で、クラッシュ時は対象外）ため、
 * 起動時 GC がこの2系統を回収する最後の網になる。
 *
 * uploadTmpDir の rmSync 先例（plugin.ts configureServer）に相乗りし、サーバ起動のたびに
 * **全プロジェクト**の `out/` 配下から対象パターンを掃除する（実行中ジョブは起動直後には
 * 存在しないため、稼働中のファイルを誤って消す心配はない——ただし多重起動時は別、
 * `guard` 参照）。
 */
import { readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { isSuperMovieProject } from './scanProjects';

export interface CaptureTmpSweepDeps {
  readdirSync: (dir: string) => string[];
  statSync: (path: string) => { isDirectory(): boolean };
  rmSync: (path: string, opts: { recursive: boolean; force: boolean }) => void;
  isSuperMovieProject: (dir: string) => boolean;
  /**
   * 多重起動ガード（焦点再レビュー推奨4）。省略時（既定 true）は掃除する。
   * `false` を渡すと sweep 全体を no-op にする——plugin.ts は
   * `instructionInbox.attachPersistence` が pidfile ロックを取れなかった（＝同じ
   * プロジェクトルートで既に別のエディタインスタンスが稼働中）ときに `false` を渡す。
   * 稼働中インスタンスが今まさに撮影している `.capture-*`/`cut-filter-*`/`.shape-*` を、
   * 後から起動した二重目のインスタンスが「クラッシュ残骸」と誤認して消さないための保護。
   */
  guard?: boolean;
}

const defaultDeps: CaptureTmpSweepDeps = {
  readdirSync: (dir) => readdirSync(dir),
  statSync: (path) => statSync(path),
  rmSync: (path, opts) => rmSync(path, opts),
  isSuperMovieProject,
};

/** 掃除対象のエントリ名か（`.capture-*` / `cut-filter-*.txt` / `.shape-*.png`）。 */
function isSweepTarget(entry: string): boolean {
  if (entry.startsWith('.capture-')) return true;
  if (entry.startsWith('cut-filter-') && entry.endsWith('.txt')) return true;
  if (entry.startsWith('.shape-') && entry.endsWith('.png')) return true;
  return false;
}

/**
 * root 直下の全プロジェクトを走査し、各 `out/` 配下の掃除対象エントリを削除する。
 * 個々のプロジェクト/エントリでの失敗（読めない・権限が無い等）はベストエフォートで無視し、
 * 他プロジェクトの掃除を止めない（起動を失敗させたくないため）。
 * `deps.guard === false` のときは何もしない（多重起動ガード・推奨4）。
 */
export function sweepCaptureTmpDirs(root: string, overrides: Partial<CaptureTmpSweepDeps> = {}): void {
  const deps: CaptureTmpSweepDeps = { ...defaultDeps, ...overrides };
  if (deps.guard === false) return;
  let projectNames: string[];
  try {
    projectNames = deps.readdirSync(root);
  } catch {
    return;
  }
  for (const name of projectNames) {
    if (name.startsWith('.')) continue;
    const projectDir = join(root, name);
    try {
      if (!deps.statSync(projectDir).isDirectory()) continue;
      if (!deps.isSuperMovieProject(projectDir)) continue;
    } catch {
      continue;
    }
    const outDir = join(projectDir, 'out');
    let outEntries: string[];
    try {
      outEntries = deps.readdirSync(outDir);
    } catch {
      continue; // out/ が無いプロジェクトは対象外
    }
    for (const entry of outEntries) {
      if (!isSweepTarget(entry)) continue;
      try {
        deps.rmSync(join(outDir, entry), { recursive: true, force: true });
      } catch {
        // ベストエフォート: 1件の削除失敗で他の掃除・サーバ起動を止めない。
      }
    }
  }
}
