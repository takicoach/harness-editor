import { watch as chokidarWatch, type FSWatcher } from 'chokidar';
import { readdirSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { resolveProjectStatus } from './projectStatus';
import { isHarnessProject } from './scanProjects';
import type { ProjectSummary } from '../shared/types';

/** ホーム画面のライブ更新で配信する 1 プロジェクト分のステータス差分。 */
export type ProjectStatusEvent = Pick<
  ProjectSummary,
  'id' | 'status' | 'activityLabel' | 'activityStartedAt' | 'activityStale' | 'lastEditedAt'
>;

interface WatchAllProjectsStatusOptions {
  /** debounce 時間 (ms)。既定 300。プロジェクトごとに独立して debounce する。 */
  debounceMs?: number;
  /** stale 判定用の現在時刻。テスト注入用。既定 Date.now。 */
  now?: () => number;
}

/**
 * `root/<projectId>/.sme/status.json` または `root/<projectId>/out/video.mp4` の変化から
 * 変化したプロジェクト ID を取り出す純関数。root 直下の子ディレクトリ名が projectId（=id)。
 * ステータスに関係しないパス（プロジェクト内の他ファイル等）は null。
 */
export function projectIdFromWatchedPath(root: string, path: string): string | null {
  if (!path.startsWith(root + sep)) return null;
  const rel = path.slice(root.length + 1);
  const parts = rel.split(sep);
  const id = parts[0];
  if (id === undefined || id === '' || id.startsWith('.')) return null;
  // ステータス由来のパスのみ通す（.sme/status.json は dir 作成イベントも含めて拾う）。
  const sub = parts.slice(1).join('/');
  if (sub !== '.sme' && sub !== '.sme/status.json' && sub !== 'out' && sub !== 'out/video.mp4') return null;
  return id;
}

/** root 直下のハーネス形式プロジェクトディレクトリ名一覧。 */
function listProjectIds(root: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  const ids: string[] = [];
  for (const name of entries) {
    if (name.startsWith('.')) continue;
    const dir = join(root, name);
    try {
      if (statSync(dir).isDirectory() && isHarnessProject(dir)) ids.push(name);
    } catch {
      continue;
    }
  }
  return ids;
}

/**
 * root 配下の全プロジェクトの `.sme/status.json` と `out/video.mp4` を監視し、
 * 変化したプロジェクトの解決済みステータスを onEvent へ渡す。
 * 監視対象は接続時点の既存プロジェクト一覧のみ（プロジェクトの増減までは追わない）。
 * `.sme` や `out` がまだ無いプロジェクトでも初回作成を拾えるよう、リテラルファイルパスではなく
 * 各プロジェクトディレクトリを depth 制限付きで監視し、パスフィルタで status 関連のみ通す
 * （chokidar は存在しないパスの親ディレクトリ越し監視ができないため）。
 * 戻り値の関数を呼ぶと監視を停止する。
 */
export function watchAllProjectsStatus(
  root: string,
  onEvent: (event: ProjectStatusEvent) => void,
  options: WatchAllProjectsStatusOptions = {},
): () => void {
  const debounceMs = options.debounceMs ?? 300;
  const now = options.now ?? Date.now;
  const ids = listProjectIds(root);
  const patterns = ids.map((id) => join(root, id));
  if (patterns.length === 0) {
    // 監視対象が無い（プロジェクト0件）。無害な no-op watcher を返す。
    return () => {};
  }
  const watcher: FSWatcher = chokidarWatch(patterns, {
    ignoreInitial: true,
    persistent: true,
    // <project>/.sme/status.json（depth 1 のファイル）まで拾えれば十分。
    // public/ の動画や src/ の編集ファイルは projectIdFromWatchedPath が弾く。
    depth: 1,
    // 大きい動画や node_modules を監視ツリーから除外して負荷を抑える。
    ignored: (path) => {
      const rel = path.startsWith(root + sep) ? path.slice(root.length + 1) : path;
      const parts = rel.split(sep);
      const sub = parts[1];
      return sub !== undefined && sub !== '.sme' && sub !== 'out';
    },
  });
  const timers = new Map<string, NodeJS.Timeout>();
  const trigger = (path: string): void => {
    const id = projectIdFromWatchedPath(root, path);
    if (id === null) return;
    const existing = timers.get(id);
    if (existing !== undefined) clearTimeout(existing);
    timers.set(
      id,
      setTimeout(() => {
        timers.delete(id);
        const dir = join(root, id);
        try {
          const status = resolveProjectStatus(dir, now());
          onEvent({ id, ...status });
        } catch (err) {
          console.warn(`[sme] watchAllProjectsStatus: プロジェクト "${id}" の解決に失敗:`, err);
        }
      }, debounceMs),
    );
  };
  watcher.on('change', (path) => trigger(path));
  watcher.on('add', (path) => trigger(path));
  watcher.on('unlink', (path) => trigger(path));
  watcher.on('error', (err) => {
    console.warn('[sme] watchAllProjectsStatus の chokidar エラー:', err);
  });
  return () => {
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    watcher.close().catch((err) => {
      console.warn('[sme] watchAllProjectsStatus の close に失敗:', err);
    });
  };
}

