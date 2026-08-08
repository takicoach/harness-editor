/**
 * useHeavyJobConfirm — 重ジョブ開始 API（render/transcribe/denoise/normalize/preview-proxy）
 * の負荷確認ダイアログをまとめるフック。
 *
 * 開始 POST が HTTP 409 `{ confirmationRequired: true, running, recommendedMax }` を返したら
 * pendingConfirm を立てて確認待ちにする。confirm() で `force=1` を付けて同じリクエストを再送し、
 * dismiss() は再送せず 'cancelled' で解決する。それ以外の応答（200 成功や already-running 等の
 * 通常の 409）はそのまま Response を返し、呼び出し側の既存の res.ok 判定に委ねる。
 */
import { useRef, useState } from 'react';

/** 確認待ち中の負荷情報（サーバの 409 応答から）。 */
export interface HeavyJobConfirmInfo {
  running: number;
  recommendedMax: number;
}

export interface UseHeavyJobConfirmReturn {
  /** 確認待ち中の情報。null は非表示（ダイアログを出さない）。 */
  pendingConfirm: HeavyJobConfirmInfo | null;
  /**
   * 重ジョブ開始 POST を送る。409 confirmation-required を受けたら確認待ちにし、
   * confirm()/dismiss() が呼ばれるまで解決しない。
   * 戻り値: dismiss された場合は 'cancelled'、それ以外は最終的な Response
   * （confirm 後の force=1 再送、または最初から confirmation-required でなかった応答）。
   */
  start: (url: string, init?: RequestInit) => Promise<Response | 'cancelled'>;
  /** 「それでも実行」— force=1 を付けて再送する。 */
  confirm: () => void;
  /** 「やめておく」— 再送せず中止する。 */
  dismiss: () => void;
}

interface ConfirmationRequiredBody {
  confirmationRequired?: boolean;
  running?: number;
  recommendedMax?: number;
}

/** URL に force=1 を付与する（既存クエリの有無で ? / & を出し分ける）。 */
function withForceParam(url: string): string {
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}force=1`;
}

export function useHeavyJobConfirm(): UseHeavyJobConfirmReturn {
  const [pendingConfirm, setPendingConfirm] = useState<HeavyJobConfirmInfo | null>(null);

  // 確認待ち中の再送に必要な情報（元 URL/init）と、保留中の start() の Promise を解決する関数。
  const pendingRef = useRef<{
    url: string;
    init: RequestInit | undefined;
    resolve: (v: Response | 'cancelled') => void;
    reject: (e: unknown) => void;
  } | null>(null);

  const start = async (url: string, init?: RequestInit): Promise<Response | 'cancelled'> => {
    const res = await fetch(url, init);
    if (res.status === 409) {
      let body: ConfirmationRequiredBody | null = null;
      try {
        body = (await res.clone().json()) as ConfirmationRequiredBody;
      } catch {
        body = null;
      }
      if (body?.confirmationRequired) {
        return new Promise<Response | 'cancelled'>((resolve, reject) => {
          pendingRef.current = { url, init, resolve, reject };
          setPendingConfirm({ running: body!.running ?? 0, recommendedMax: body!.recommendedMax ?? 1 });
        });
      }
    }
    return res;
  };

  const confirm = (): void => {
    const pending = pendingRef.current;
    if (!pending) return;
    pendingRef.current = null;
    setPendingConfirm(null);
    fetch(withForceParam(pending.url), pending.init).then(pending.resolve, pending.reject);
  };

  const dismiss = (): void => {
    const pending = pendingRef.current;
    if (!pending) return;
    pendingRef.current = null;
    setPendingConfirm(null);
    pending.resolve('cancelled');
  };

  return { pendingConfirm, start, confirm, dismiss };
}
