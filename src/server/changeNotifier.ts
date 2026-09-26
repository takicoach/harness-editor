/**
 * 監視イベントの debounce と自己書込 suppress（監査 data-safety-6）。
 *
 * 従来は debounce 満了時に `isSelfWrite()` が true なら **その通知を捨てていた**。
 * そのため自己保存ウィンドウ（1500ms）中に届いた本物の外部変更は 1 度捨てられるだけで
 * 二度と検査されず、外部変更バナーが永久に出なかった。
 *
 * ここでは捨てずに「自己書込ウィンドウの残り＋100ms」後へ先送りし、ウィンドウが
 * 明けてから改めて評価する。
 *
 * ただし窓が明けた時点では「自己書込か外部書込か」を時刻だけでは見分けられない
 * （selfWrite の窓は誰に対しても false に戻る）ため、以前はここを必ず通過し、
 * **1 タブで保存しただけで自分の画面に外部変更バナーが出て**いた。
 * 判定は内容で行う: 保存し終えた時点のディスク指紋を記録しておき（selfWrite の
 * contentSignature）、再評価でそれと一致すれば自分の書込として捨て、違えば通知する。
 *
 * chokidar から切り離した純ロジックなので、偽タイマーで決定的にテストできる。
 */
export interface ChangeNotifierOptions {
  /** debounce 時間 (ms)。 */
  debounceMs: number;
  /** 通知本体。 */
  onChange: () => void;
  /** 現在が自己書込ウィンドウ内か。 */
  isSelfWrite?: () => boolean;
  /** 自己書込ウィンドウの残り時間 (ms)。省略時は debounceMs を代用する。 */
  selfWriteRemainingMs?: () => number;
  /**
   * いまディスクに在る内容が「この画面が最後に保存した内容そのもの」か。
   * true なら通知しない（自分の保存の残響）。判定材料が無ければ false を返す実装にする。
   */
  isSelfContent?: () => boolean;
  /** ログ出力（既定は console.log）。 */
  log?: (message: string) => void;
}

export interface ChangeNotifier {
  /** 変更を検知した（debounce タイマーを張り直す）。 */
  trigger: (path: string) => void;
  /** タイマーを止める（監視終了時に呼ぶ）。 */
  stop: () => void;
}

/** 自己書込ウィンドウ明けの再評価までの余裕 (ms)。 */
export const SELF_WRITE_RECHECK_MARGIN_MS = 100;

export function createChangeNotifier(options: ChangeNotifierOptions): ChangeNotifier {
  const log = options.log ?? ((msg: string) => console.log(msg));
  let timer: ReturnType<typeof setTimeout> | null = null;
  // debounce 期間中に最後に検知したパス（ログ用）。再評価をまたいで保持する。
  let lastTriggerPath: string | null = null;

  const evaluate = (): void => {
    timer = null;
    const path = lastTriggerPath ?? '(unknown)';
    if (options.isSelfWrite?.() === true) {
      // 捨てずに先送りする。ウィンドウが明けたら同じ変更をもう一度評価する。
      const wait =
        (options.selfWriteRemainingMs?.() ?? options.debounceMs) + SELF_WRITE_RECHECK_MARGIN_MS;
      log(`[sme] watchProject deferred (self-write, recheck in ${wait}ms): ${path}`);
      timer = setTimeout(evaluate, wait);
      return;
    }
    // ウィンドウが明けた（もしくは元から外だった）。ここで初めて内容を見る。
    // 記録した保存直後の指紋とディスクが一致するなら、このイベントは自分の保存の
    // 残響であって外部変更ではない（サイクル 2 レビュー Important）。
    if (options.isSelfContent?.() === true) {
      lastTriggerPath = null;
      log(`[sme] watchProject skipped (self-write content unchanged): ${path}`);
      return;
    }
    lastTriggerPath = null;
    log(`[sme] watchProject notified: ${path}`);
    options.onChange();
  };

  return {
    trigger: (path: string): void => {
      lastTriggerPath = path;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(evaluate, options.debounceMs);
    },
    stop: (): void => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}
