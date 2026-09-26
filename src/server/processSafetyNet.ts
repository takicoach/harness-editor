/**
 * X-1 最後の砦: プロセス全体の uncaughtException / unhandledRejection ハンドラ。
 *
 * この製品は「dev サーバーがそのまま製品」（ptySession.ts 冒頭コメント参照）であり、
 * リポジトリ全体を見渡してもこの2イベントを拾うハンドラは元々1つも無かった
 * （grep 済み・0件）。個別の握り潰し（ptySession.ts の resize/write 保護など）で
 * 塞ぎきれない未知の経路が残っていた場合、Node の既定動作は
 * プロセスを終了させる（unhandledRejection は Node 15+ で既定 fatal）。
 * 単一プロセスの dev サーバーではこれがそのままエディタ全体の白画面・
 * 未保存編集の消失に直結するため、「ログに残して継続する」を既定にする。
 *
 * ただし「何でも握り潰す」実装にはしない: 短時間に大量の uncaughtException /
 * unhandledRejection が連続する場合は、個別の一過性グリッチではなく
 * プロセス自体が壊れている（例: イベントループが同じ例外を無限に踏み続けている）
 * とみなし、`process.exit(1)` で実際に終了する。継続を選ぶことで
 * 「クラッシュしたことにすら気づけない無限ループ」を作ってしまうことこそが
 * 本当の握り潰しであり、それは避ける。
 * （V8 の致命的エラー — ヒープ枯渇時の FATAL ERROR 等 — はそもそもこの2イベントを
 * 経由せず Node が直接終了させるため、ここで別扱いする必要はない。）
 */

export interface ProcessSafetyNetOptions {
  /** この時間内（ms）に limit 件を超えたら復旧不能とみなし終了する。既定 10 秒。 */
  windowMs?: number;
  /** windowMs 内の許容件数。これを超えたら終了する。既定 20 件。 */
  limit?: number;
  /** ログ出力先（テスト用に差し替え可能）。既定 console.error。 */
  log?: (message: string, err: unknown) => void;
  /** 復旧不能と判断したときに呼ぶ（既定 process.exit(1)。テスト用に差し替え可能）。 */
  exit?: (code: number) => void;
  /** 時刻源（テスト用に差し替え可能）。既定 Date.now。 */
  now?: () => number;
}

export interface ProcessSafetyNet {
  /** uncaughtException / unhandledRejection 相当のイベントを1件処理する。 */
  handle(kind: 'uncaughtException' | 'unhandledRejection', err: unknown): void;
  /** 実プロセスへ process.on で配線する。二重配線しても安全（1回だけ実際に登録する）。 */
  install(): void;
}

/**
 * 判定ロジックだけを切り出したファクトリ（テスト容易性のため process.on を直接
 * 呼ばない形にしてある。実配線は install() が担う）。
 */
export function createProcessSafetyNet(opts: ProcessSafetyNetOptions = {}): ProcessSafetyNet {
  const windowMs = opts.windowMs ?? 10_000;
  const limit = opts.limit ?? 20;
  const log = opts.log ?? ((message: string, err: unknown) => console.error(message, err));
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  const now = opts.now ?? (() => Date.now());

  let windowStart = now();
  let count = 0;
  let installed = false;

  const net: ProcessSafetyNet = {
    handle(kind, err) {
      const t = now();
      if (t - windowStart > windowMs) {
        windowStart = t;
        count = 0;
      }
      count++;
      log(`[sme] ${kind} を捕捉しました（サーバーは継続します）:`, err);
      if (count > limit) {
        log(
          `[sme] ${windowMs}ms 以内に ${count} 件の uncaughtException/unhandledRejection — ` +
            '個別の一過性エラーではなく復旧不能な破損とみなし、プロセスを終了します。',
          err,
        );
        exit(1);
      }
    },
    install() {
      if (installed) return; // 二重配線防止（同一ハンドラが複数回発火するのを防ぐ）
      installed = true;
      process.on('uncaughtException', (err) => net.handle('uncaughtException', err));
      process.on('unhandledRejection', (reason) => net.handle('unhandledRejection', reason));
    },
  };
  return net;
}

let globalNet: ProcessSafetyNet | null = null;

/** 実プロセスへ配線する。何度呼ばれても実際の登録は最初の1回だけ。 */
export function installProcessSafetyNet(): void {
  globalNet ??= createProcessSafetyNet();
  globalNet.install();
}
