/**
 * fastCut の撮影（prepare）段の結果。呼び出し側は撮影の中身を知らない
 * （撮影失敗の種別は呼び出し側が `reason` の文字列へ畳んで渡す契約）。
 */
export type FastCutPrepareOutcome =
  | {
      ok: true;
      /** 撮影入力（連番 PNG 等）を含めて確定した ffmpeg 引数。呼び出し側はこの引数を使用する。 */
      args: string[];
      /** 一時ディレクトリ等の後始末。呼び出し側は完了・失敗・中止のいずれでも1回だけ呼ぶ。 */
      cleanup?: () => void;
    }
  | {
      ok: false;
      /** 失敗理由（利用者に見せる文言に埋め込む）。 */
      reason: string;
      /** 失敗時も呼び出し側が1回だけ実行する後始末。 */
      cleanup?: () => void;
    };
