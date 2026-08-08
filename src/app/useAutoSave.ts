import { useEffect, useRef } from 'react';
import { AUTO_SAVE_DELAY_MS, shouldFireAutoSave, type AutoSaveStatus } from './edit/autoSave';

/** フォーカスがテキスト編集要素にあるか（IME 変換中の textarea もこの中に含まれる）。 */
function isFocusInEditable(): boolean {
  const el = document.activeElement;
  return (
    el instanceof HTMLInputElement ||
    el instanceof HTMLTextAreaElement ||
    (el instanceof HTMLElement && el.isContentEditable)
  );
}

export interface UseAutoSaveParams {
  /** 自動保存トグル（設定 UI・localStorage 永続）。 */
  enabled: boolean;
  /** 未保存の変更があるか。 */
  dirty: boolean;
  /** 現在の保存処理状態。'error' の間は自動リトライしない。 */
  saveStatus: AutoSaveStatus;
  /**
   * 編集のたびに変わる値（session.state 等）。参照が変わるたびに
   * debounce タイマーをリセットする＝「操作が落ち着いたら」の判定に使う。
   */
  state: unknown;
  /** 保存を実行する（既存の EditSession.save をそのまま渡す想定）。 */
  save: () => Promise<boolean>;
  /**
   * dirty から発火までの静止時間（ミリ秒）。省略時は AUTO_SAVE_DELAY_MS。
   * e2e の待ち時間短縮用に上書き可能（`parseAutoSaveDelayOverride`）。
   */
  delayMs?: number;
}

/**
 * dirty になってから AUTO_SAVE_DELAY_MS だけ操作（state 変化）が無ければ自動保存する。
 * - トグル OFF / dirty でない / saveStatus が 'saving'・'error' のときは発火しない
 * - 発火予定時にフォーカスがテキスト編集要素にあれば延期し、次のチェックへ持ち越す
 *   （IME 入力・テロップ編集中の割込みを防ぐ）。**割り切り**: フォーカスが編集要素に
 *   置かれたまま（例: カーソルを残して離席）だと、その間は無期限に延期し続ける。
 * - 既存の保存経路（EditSession.save）をそのまま呼ぶため、外部変更ウォッチの
 *   自己保存抑制・samePersistedContent 等の既存整合性はそのまま効く。EditSession.save は
 *   in-flight ロック済みのため、このフックの呼び出しと他所（render 開始前の自動保存等）
 *   からの呼び出しが重なっても二重 PUT にはならない。
 */
export function useAutoSave({
  enabled,
  dirty,
  saveStatus,
  state,
  save,
  delayMs = AUTO_SAVE_DELAY_MS,
}: UseAutoSaveParams): void {
  const saveRef = useRef(save);
  saveRef.current = save;

  useEffect(() => {
    if (!enabled || !dirty || saveStatus !== 'idle') return;

    let timer: ReturnType<typeof setTimeout>;
    const check = (): void => {
      if (
        !shouldFireAutoSave({
          enabled,
          dirty,
          saveStatus,
          focusInEditable: isFocusInEditable(),
        })
      ) {
        // フォーカスがテキスト編集要素にある間は延期し、同じ静止時間だけ後で再チェックする。
        timer = setTimeout(check, delayMs);
        return;
      }
      void saveRef.current();
    };
    timer = setTimeout(check, delayMs);
    return () => clearTimeout(timer);
    // state は「編集のたびに変わる値」として意図的に依存に含める（内容比較ではなく参照変化でリセットする）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, dirty, saveStatus, state, delayMs]);
}
