import { useRef } from 'react';
import { useEventChannel } from './eventBus';

/**
 * 開いているプロジェクトの編集対象ファイルが外部で変更されたら onChange を呼ぶ。
 * SSE 1 本統合バス（/api/events?id=<projectId>・watch チャネル）を購読する。
 * projectId が null の間はメッセージを無視する（バス自体は projectId 全体で
 * EventBusProvider が一元管理するため、ここでは接続の開閉をしない）。
 *
 * onChange が毎レンダー差し替わっても再購読が走らないように ref パターンで参照する。
 */
export function useProjectWatch(projectId: string | null, onChange: () => void): void {
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEventChannel('watch', (raw: unknown) => {
    if (projectId === null) return;
    if (
      typeof raw === 'object' &&
      raw !== null &&
      (raw as { type?: unknown }).type === 'change'
    ) {
      onChangeRef.current();
    }
    // open イベントは何もしない（接続確立の合図のみ）。
  });
}
