import { watch as chokidarWatch, type FSWatcher } from 'chokidar';
import { readdirSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { resolveProjectStatus } from './projectStatus';
import { resolveProjectSteps } from './projectSteps';
import { isSuperMovieProject } from './scanProjects';
import type { ProjectSummary } from '../shared/types';

/** ホーム画面のライブ更新で配信する 1 プロジェクト分のステータス差分。 */
export type ProjectStatusEvent = Pick<
  ProjectSummary,
  | 'id'
  | 'status'
  | 'stageManual'
  | 'activityLabel'
  | 'activityStartedAt'
  | 'activityStale'
  | 'lastEditedAt'
  // out/video.mp4 の増減は工程ステッパーの rendered を変える。差分に載せないと
  // ホームのステッパーだけが古いまま残る（stageManual と同型の取りこぼし）。
  // v2 は project.v2.json の保存で全工程を更新。旧TSX案件は rendered のみライブ更新。
  | 'steps'
  // この差分がどの観測から来たか（単調増加）。クライアントが一覧の全置換と
  // どちらが新しいかを到着順ではなく番号で決めるために必ず載せる。
  | 'statusSeq'
>;

interface WatchAllProjectsStatusOptions {
  /** debounce 時間 (ms)。既定 300。プロジェクトごとに独立して debounce する。 */
  debounceMs?: number;
  /** stale 判定用の現在時刻。テスト注入用。既定 Date.now。 */
  now?: () => number;
}

/**
 * status.json、旧MP4、v2保存データ/書き出し記録の変化から
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
  if (!['.sme', '.sme/status.json', 'out', 'out/video.mp4', '.harness', '.harness/project.v2.json', '.harness/last-export.json'].includes(sub)) return null;
  return id;
}

/** root 直下のハーネス形式の案件ディレクトリ名一覧。 */
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
      if (statSync(dir).isDirectory() && isSuperMovieProject(dir)) ids.push(name);
    } catch {
      continue;
    }
  }
  return ids;
}

/**
 * 「変わったか」の比較用に 1 イベントを文字列化する。
 * `statusSeq` は観測のたびに必ず変わる番号（＝プロジェクトの状態ではない）ので比較から外す。
 * 外さないと baseline と常に食い違い、接続のたびに全プロジェクト分の無駄なイベントが流れる。
 */
export function serializeStatusForCompare(event: ProjectStatusEvent | null): string {
  if (event === null) return 'null';
  const { statusSeq: _ignored, ...rest } = event;
  return JSON.stringify(rest);
}

/**
 * 監視開始時のスナップショット（baseline）と現在値を比べ、**実際に変わったものだけ**を返す。
 * chokidar の初回スキャン中（ignoreInitial の窓）に起きた変更はイベントとして出ないため、
 * ready 時にこれを流して取りこぼしを埋める。変わっていないプロジェクトを返さないことで、
 * 「無関係な変更ではイベントを出さない」という watcher の性質を保つ。
 * baseline は返した分だけ現在値へ更新する（同じ取りこぼしを二度流さない）。
 */
export function startupMissedEvents(
  ids: string[],
  baseline: Map<string, string>,
  resolveNow: (id: string) => ProjectStatusEvent | null,
): ProjectStatusEvent[] {
  const out: ProjectStatusEvent[] = [];
  for (const id of ids) {
    const event = resolveNow(id);
    if (event === null) continue;
    const serialized = serializeStatusForCompare(event);
    if (serialized === baseline.get(id)) continue;
    baseline.set(id, serialized);
    out.push(event);
  }
  return out;
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
    // .sme と .harness の直下メタデータ（depth 1 のファイル）を拾う。
    // public/ の動画や src/ の編集ファイルは projectIdFromWatchedPath が弾く。
    depth: 1,
    // 大きい動画や node_modules を監視ツリーから除外して負荷を抑える。
    ignored: (path) => {
      const rel = path.startsWith(root + sep) ? path.slice(root.length + 1) : path;
      const parts = rel.split(sep);
      const sub = parts[1];
      if (sub === '.harness') return parts.length > 2 && !['project.v2.json', 'last-export.json'].includes(parts[2]!);
      return sub !== undefined && sub !== '.sme' && sub !== 'out';
    },
  });
  const timers = new Map<string, NodeJS.Timeout>();
  /** 現在のディスク状態から解決済みステータスを組み立てる（読めなければ null）。 */
  const resolveNow = (id: string): ProjectStatusEvent | null => {
    const dir = join(root, id);
    try {
      const steps = resolveProjectSteps(dir);
      const status = resolveProjectStatus(dir, steps, now());
      return { id, ...status, steps };
    } catch (err) {
      console.warn(`[sme] watchAllProjectsStatus: プロジェクト "${id}" の解決に失敗:`, err);
      return null;
    }
  };
  /** 現在のディスク状態から解決済みステータスを1件流す。 */
  const emitNow = (id: string): void => {
    const event = resolveNow(id);
    if (event !== null) onEvent(event);
  };
  // 監視開始時点のスナップショット（下の 'ready' 参照）。watcher 生成より前に取る。
  const baseline = new Map<string, string>();
  for (const id of ids) baseline.set(id, serializeStatusForCompare(resolveNow(id)));
  const trigger = (path: string): void => {
    const id = projectIdFromWatchedPath(root, path);
    if (id === null) return;
    const existing = timers.get(id);
    if (existing !== undefined) clearTimeout(existing);
    timers.set(
      id,
      setTimeout(() => {
        timers.delete(id);
        emitNow(id);
      }, debounceMs),
    );
  };
  // 初回スキャン完了時に「スキャン中に変わっていたもの」だけを流す。
  // chokidar は ignoreInitial のため、スキャン中に起きた変更をイベントとして出さない。
  // 監視対象が多い・ディスクが混んでいるほどスキャンは長引き、その間に書かれた
  // `.sme/status.json` は**永久に届かない**（実測: フルスイート実行中、AI 作業中表示が
  // 15 秒待っても出ないケースが再現した）。監視開始時のスナップショットと ready 時点の
  // 実状態を比べ、**実際に変わったものだけ**を送る（無関係な変更で無駄なイベントを
  // 出さない、という本 watcher の性質は保つ）。
  watcher.on('ready', () => {
    for (const event of startupMissedEvents(ids, baseline, resolveNow)) onEvent(event);
  });
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
