import { useDialogEscape } from '../useDialogEscape';
/**
 * 移る先の部品が今の動きを描けないときに出す 2 択。
 * 「保持して中止」は何もしない。「解除して変更」は動きの解除とスタイル変更を 1 コマンドにまとめ、
 * 元に戻すが 1 回で効く。どちらも選ばずに閉じたときは「中止」と同じ扱いにする。
 */
export interface AnimationGuardRequest {
  title: string;
  detail: string;
  keepLabel: string;
  clearLabel: string;
  onKeep(): void;
  onClear(): void;
}

export function NativeAnimationGuard({ request, onDismiss }: { request: AnimationGuardRequest | null; onDismiss(): void }) {
  // R2 Rec 2: Esc は共通の useDialogEscape へ寄せる（IME の変換中の Esc を握らない・背後のタイムラインの
  // 選択解除へ流さない）。フックなので早期 return より前に置き、要求が無い間は enabled=false で止める。
  useDialogEscape(() => { if (request) { onDismiss(); request.onKeep(); } }, !!request);
  if (!request) return null;
  const keep = () => { onDismiss(); request.onKeep(); };
  const clear = () => { onDismiss(); request.onClear(); };
  return <div role="alertdialog" aria-label={request.title} className="native-animation-guard">
    <button type="button" aria-label="動きの確認を閉じる" onClick={keep}>×</button>
    <p>{request.detail}</p>
    <div className="native-animation-guard-actions">
      <button type="button" onClick={keep}>{request.keepLabel}</button>
      <button type="button" onClick={clear}>{request.clearLabel}</button>
    </div>
  </div>;
}
