import { useRef } from 'react';
import type { ProjectSummary } from '../shared/types';
import { useEventChannel } from './eventBus';

type ProjectStatusPatch = Pick<
  ProjectSummary,
  'id' | 'status' | 'activityLabel' | 'activityStartedAt' | 'activityStale' | 'lastEditedAt'
>;

/**
 * 全プロジェクトのステータスライブ更新を購読する（ホームのバッジ＋左サイドバーの AI 作業中表示）。
 * SSE 1 本統合バス（/api/events・projects チャネル）を購読し、受信したプロジェクト単位の
 * ステータス差分を onStatus（通常は patchProject）へ渡す。
 * enabled が false の間は購読しない（プロジェクトを開いたら false にして解除する想定）。
 *
 * 再接続は EventBusProvider が一元管理する（onerror では close しない・ブラウザ標準の
 * 自動再接続に委ねる）。onOpen は接続確立の合図（従来の `{type:'open'}` 受信）で呼ばれ、
 * 取りこぼしたイベントを呼び出し元（通常 refreshProjects）で埋め合わせるためのフック。
 *
 * onStatus / onOpen が毎レンダー差し替わっても再購読が走らないように useEventChannel の
 * ref パターンに委ねる。
 *
 * **enabled=false 中の取りこぼしについて（レビュー指摘 M-4）**: handler は先頭で
 * `if (!enabled) return;` するため、enabled=false の間にブラウザ標準の自動再接続で
 * バスが裏で繋ぎ直り 'open' が再送されても onOpen は呼ばれない（＝この区間の status
 * 差分の取りこぼしはここでは回収しない）。ただし実運用では取りこぼしは無害: enabled が
 * 再び true に戻るタイミング（＝プロジェクトを閉じてホームへ戻るタイミング）は
 * `EventBusProvider` の接続先 URL 自体が `/api/events?id=...` → `/api/events`
 * （projectId が空文字に戻る）へ切り替わるタイミングと一致し、その切り替えで EventSource
 * が新規に張り直されて 'open' が改めて配られる（そのとき enabled は既に true）ため、
 * onOpen による refreshProjects 埋め合わせは正しく発火する。enabled が「プロジェクト
 * 開閉と無関係に」false→true する呼び出し方をした場合はこの前提が崩れる（現状の
 * 呼び出し元 App.tsx は enabled=true 固定で呼んでおり該当しない）。
 */
export function useProjectsWatch(
  enabled: boolean,
  onStatus: (id: string, patch: Partial<ProjectSummary>) => void,
  onOpen?: () => void,
): void {
  const onStatusRef = useRef(onStatus);
  onStatusRef.current = onStatus;
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;

  useEventChannel('projects', (raw: unknown) => {
    if (!enabled) return;
    if (typeof raw !== 'object' || raw === null) return;
    const d = raw as { type?: unknown } & Partial<ProjectStatusPatch>;
    if (d.type === 'open') {
      onOpenRef.current?.();
      return;
    }
    if (d.type !== 'status' || typeof d.id !== 'string') return;
    const { id, status, activityLabel, activityStartedAt, activityStale, lastEditedAt } = d;
    onStatusRef.current(id, {
      status,
      activityLabel,
      activityStartedAt,
      activityStale,
      lastEditedAt,
    });
  });
}
