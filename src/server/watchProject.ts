import { watch as chokidarWatch, type FSWatcher } from 'chokidar';
import { createChangeNotifier } from './changeNotifier';
import { projectContentSignature, projectWatchPaths } from './projectWatchPaths';
import { relative, resolve, sep } from 'node:path';

interface WatchProjectOptions {
  /** debounce 時間 (ms)。既定 500。 */
  debounceMs?: number;
  /**
   * 自分自身（サーバの保存処理など）が書き込み中で、change を通知から
   * 除外したいときに true を返す predicate。debounce 満了時に評価される。
   */
  isSelfWrite?: () => boolean;
  /**
   * 自己書込ウィンドウの残り時間 (ms)。suppress した変更を「残り＋100ms」後に
   * 再評価するために使う（data-safety-6）。省略時は debounce 時間で代用する。
   */
  selfWriteRemainingMs?: () => number;
  /**
   * いまディスクに在る内容が「その画面が最後に保存した内容そのもの」か。
   * true の間は通知しない（自分の保存の残響を外部変更として出さない）。
   */
  isSelfContent?: () => boolean;
}

/**
 * 対象プロジェクト配下の編集対象ファイルを監視する。Claude Code やテキストエディタが
 * 外部からファイルを書き換えたとき、debounce 済み（既定 500ms）で onChange を呼ぶ。
 *
 * 監視対象は Harness Editor が読み書きする 11 種類のデータファイル＋videoConfig：
 *   - src/テロップテンプレート/telopData.ts
 *   - cutData.ts（複数候補・どれかに存在）
 *   - src/SoundEffects/seData.ts
 *   - src/InsertImage/insertImageData.ts
 *   - src/InsertVideo/insertVideoData.ts
 *   - src/Bgm/bgmData.ts
 *   - src/Title/titleData.ts
 *   - src/InsertShape/shapeData.ts
 *   - src/Transition/transitionData.ts
 *   - src/speedData.ts（速度導入済みプロジェクトで常時保持）
 *   - src/mainLayoutData.ts（レイアウト設定済みプロジェクトで保持）
 *   - src/videoConfig.ts（FPS / 解像度の変更は loadProject の挙動が変わるため監視対象に含める）
 *
 * 戻り値の関数を呼ぶと監視を停止する（SSE 接続切断時に必ず呼ぶこと）。
 *
 * `options.isSelfWrite` を指定すると、debounce 満了時にそれが true を返す場合は
 * onChange を呼ばずに先送りする（自己保存ループ防止）。先送りした変更は自己書込
 * ウィンドウの残り＋100ms 後に再評価されるため、ウィンドウ中に届いた本物の外部変更を
 * 取りこぼさない（data-safety-6）。再評価では `options.isSelfContent` で内容を見比べ、
 * ディスクが「自分が保存した姿」のままなら通知しない（自己保存の誤警告防止）。
 */
export function watchProject(
  projectDir: string,
  onChange: () => void,
  options: WatchProjectOptions = {},
): () => void {
  const debounceMs = options.debounceMs ?? 500;
  // 監視対象ファイル群（projectWatchPaths が正本。自己書込の内容判定と同じ一覧を使う）。
  // chokidar は存在しないパスでも親ディレクトリを watch し、作成時に add イベントを
  // 発火するので、cutData.ts のように後で生成されるファイルも拾える。
  const patterns = projectWatchPaths(projectDir);
  let observedSignature = projectContentSignature(projectDir);
  let watchedFiles = new Set(patterns.map(path => resolve(path)));
  const publicDir = resolve(projectDir, 'public');
  const outsidePublic = (path: string): boolean => {
    const rel = relative(publicDir, resolve(path));
    return rel === '..' || rel.startsWith(`..${sep}`);
  };
  // Chokidar's dynamic add of a not-yet-existing file may miss its creation.
  // Observe public directory events too, but notify only for exact selected files.
  // Do not register the same media as both a file and directory descendant;
  // duplicate registration can emit an initial add despite ignoreInitial.
  const watcher: FSWatcher = chokidarWatch([...patterns.filter(outsidePublic), publicDir], {
    ignoreInitial: true,
    persistent: true,
  });
  const notifier = createChangeNotifier({
    debounceMs,
    onChange,
    isSelfWrite: options.isSelfWrite,
    selfWriteRemainingMs: options.selfWriteRemainingMs,
    isSelfContent: options.isSelfContent,
  });
  const configPath = resolve(projectDir, 'src', 'videoConfig.ts');
  const trigger = (path: string): void => {
    const absolute = resolve(path);
    if (absolute === configPath) {
      // Directory watching already covers a replacement source and future proxy.
      const currentPaths = projectWatchPaths(projectDir);
      watchedFiles = new Set(currentPaths.map(file => resolve(file)));
    }
    if (watchedFiles.has(absolute)) {
      // macOS can deliver a historical change immediately after ready even with
      // ignoreInitial. Only an actual disk revision change invalidates the UI.
      const signature = projectContentSignature(projectDir);
      if (signature === observedSignature) return;
      observedSignature = signature;
      notifier.trigger(path);
    }
  };
  watcher.on('change', (path) => trigger(path));
  watcher.on('add', (path) => trigger(path));
  watcher.on('unlink', (path) => trigger(path));
  watcher.on('error', (err) => {
    console.warn('[sme] watchProject の chokidar エラー:', err);
  });
  return () => {
    notifier.stop();
    watcher.close().catch((err) => {
      console.warn('[sme] watchProject の close に失敗:', err);
    });
  };
}
