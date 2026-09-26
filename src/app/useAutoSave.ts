import { useEffect, useRef } from 'react';
import {
  AUTO_SAVE_DELAY_MS,
  shouldFireAutoSave,
  shouldForceAutoSave,
  type AutoSaveStatus,
} from './edit/autoSave';

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
 *   （IME 入力・テロップ編集中の割込みを防ぐ）。ただし延期は
 *   MAX_AUTO_SAVE_DEFERRALS 回まで。それを超えたら入力欄にカーソルが残っていても
 *   保存する（IME 変換中だけは例外・監査 data-safety-10）。
 * - あわせて、ウィンドウからフォーカスが外れたとき（blur）とタブが隠れたとき
 *   （visibilitychange → hidden）にも保存を試みる。「カーソルを残して離席」で
 *   未保存のまま取り残される事故を塞ぐ。
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
  /**
   * IME 変換中か。effect の外（ref）で持つ。
   * 以前は effect のローカル変数だったため、編集のたびに effect が張り直されると
   * 変換の途中でも false へ戻り、「変換中は保存しない」ガードが抜けていた。
   */
  const composingRef = useRef(false);

  useEffect(() => {
    if (!enabled || !dirty || saveStatus !== 'idle') return;

    let timer: ReturnType<typeof setTimeout>;
    // テキスト編集中を理由に先送りした回数（この dirty 区間かぎり）。
    let deferrals = 0;
    // IME 変換中は保存を割り込ませない。composition イベントで追う（値は ref に持つ）。
    const onCompositionStart = (): void => {
      composingRef.current = true;
    };
    const onCompositionEnd = (): void => {
      composingRef.current = false;
    };

    const check = (): void => {
      const focusInEditable = isFocusInEditable();
      if (shouldFireAutoSave({ enabled, dirty, saveStatus, focusInEditable })) {
        void saveRef.current();
        return;
      }
      if (focusInEditable) {
        deferrals += 1;
        if (shouldForceAutoSave(deferrals, composingRef.current)) {
          void saveRef.current();
          return;
        }
      }
      // 発火しなかった理由に関わらず、必ず次のチェックを予約する。
      // 以前は「テキスト編集中」以外の理由（保存中など）で return しており、
      // その dirty のまま二度と自動保存が来ない（fail-silent）状態が作れた。
      // 条件が本当に消えたとき（トグル OFF・dirty 解消・保存失敗）は effect ごと
      // 張り直されてこのタイマーは片付けられる。
      timer = setTimeout(check, delayMs);
    };

    // 離席・タブ切替は「もう触らない」の合図なので、静止時間を待たず保存を試みる。
    const saveNow = (): void => {
      if (composingRef.current) return;
      void saveRef.current();
    };
    const onVisibilityChange = (): void => {
      if (document.visibilityState === 'hidden') saveNow();
    };

    timer = setTimeout(check, delayMs);
    window.addEventListener('compositionstart', onCompositionStart);
    window.addEventListener('compositionend', onCompositionEnd);
    window.addEventListener('blur', saveNow);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('compositionstart', onCompositionStart);
      window.removeEventListener('compositionend', onCompositionEnd);
      window.removeEventListener('blur', saveNow);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
    // state は「編集のたびに変わる値」として意図的に依存に含める（内容比較ではなく参照変化でリセットする）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, dirty, saveStatus, state, delayMs]);
}
