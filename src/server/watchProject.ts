import { watch as chokidarWatch, type FSWatcher } from 'chokidar';
import { join } from 'node:path';

interface WatchProjectOptions {
  /** debounce 時間 (ms)。既定 500。 */
  debounceMs?: number;
  /**
   * 自分自身（サーバの保存処理など）が書き込み中で、change を通知から
   * 除外したいときに true を返す predicate。debounce 満了時に評価される。
   */
  isSelfWrite?: () => boolean;
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
 * onChange を呼ばずに suppress する（自己保存ループ防止）。
 */
export function watchProject(
  projectDir: string,
  onChange: () => void,
  options: WatchProjectOptions = {},
): () => void {
  const debounceMs = options.debounceMs ?? 500;
  // 監視対象ファイル群。chokidar は存在しないパスでも親ディレクトリを watch し、
  // 作成時に add イベントを発火するので、cutData.ts のように後で生成されるファイルも拾える。
  const patterns = [
    join(projectDir, 'src', 'テロップテンプレート', 'telopData.ts'),
    join(projectDir, 'cutData.ts'),
    join(projectDir, 'src', 'cutData.ts'),
    join(projectDir, 'src', 'テロップテンプレート', 'cutData.ts'),
    join(projectDir, 'src', 'SoundEffects', 'seData.ts'),
    join(projectDir, 'src', 'InsertImage', 'insertImageData.ts'),
    join(projectDir, 'src', 'InsertVideo', 'insertVideoData.ts'),
    join(projectDir, 'src', 'Bgm', 'bgmData.ts'),
    join(projectDir, 'src', 'Title', 'titleData.ts'),
    join(projectDir, 'src', 'InsertShape', 'shapeData.ts'),
    join(projectDir, 'src', 'Transition', 'transitionData.ts'),
    join(projectDir, 'src', 'speedData.ts'),
    join(projectDir, 'src', 'mainLayoutData.ts'),
    join(projectDir, 'src', 'videoConfig.ts'),
  ];
  const watcher: FSWatcher = chokidarWatch(patterns, {
    ignoreInitial: true,
    persistent: true,
  });
  let timer: NodeJS.Timeout | null = null;
  // debounce 期間中に最後に検知したパスを記録（ログ出力用）。
  let lastTriggerPath: string | null = null;
  const trigger = (path: string): void => {
    lastTriggerPath = path;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      const path = lastTriggerPath ?? '(unknown)';
      lastTriggerPath = null;
      // サーバ自身の保存処理に由来する change は通知から除外する（自己誘発ループ防止）。
      if (options.isSelfWrite?.() === true) {
        console.log(`[sme] watchProject suppressed (self-write): ${path}`);
        return;
      }
      console.log(`[sme] watchProject notified: ${path}`);
      onChange();
    }, debounceMs);
  };
  watcher.on('change', (path) => trigger(path));
  watcher.on('add', (path) => trigger(path));
  watcher.on('unlink', (path) => trigger(path));
  watcher.on('error', (err) => {
    console.warn('[sme] watchProject の chokidar エラー:', err);
  });
  return () => {
    if (timer !== null) clearTimeout(timer);
    watcher.close().catch((err) => {
      console.warn('[sme] watchProject の close に失敗:', err);
    });
  };
}
