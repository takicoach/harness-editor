import type { ProjectSummary } from '../../shared/types';
import { STALE_AFTER_MS } from '../../shared/staleThreshold';
import { STATUS_LABEL, statusColorClass } from '../../shared/projectStage';

/** カード／一覧のステータス表示に使う解決済みビュー。 */
export interface StatusView {
  /** バッジに出す文言（activity 優先）。 */
  label: string;
  /** バッジの CSS クラス（`status-badge` + 色クラス）。 */
  className: string;
  /** 色クラスのみ（ドット等バッジ外の要素で再利用）。例 'status-telop'。 */
  colorClass: string;
  /** スピナーを回すか（AI 作業中かつ stale でない時のみ true）。 */
  spinner: boolean;
}

/** 表示ステータスの日本語ラベルを返す（正本は shared/projectStage）。 */
export function statusLabel(status: ProjectSummary['status']): string {
  return STATUS_LABEL[status];
}

/**
 * activityStartedAt（ISO 8601）と now からクライアント側で stale 判定する純関数。
 * 解析不能な startedAt は stale 扱いにしない。startedAt が無ければ stale 判定しない
 * （サーバー由来の activityStale フィールドにはフォールバックしない — 描画のたびに
 * クライアント時計で再判定することで、放置しても表示が固定されたままにならないようにする）。
 */
function isActivityStale(activityStartedAt: string | undefined, now: number): boolean {
  if (activityStartedAt === undefined) return false;
  const started = Date.parse(activityStartedAt);
  if (Number.isNaN(started)) return false;
  return now - started > STALE_AFTER_MS;
}

/**
 * プロジェクト要約からバッジ／ドットの表示ビューを解決する純関数。
 * 優先順位: AI 作業中 activity（最優先）> 解決済み status。
 * stale な activity はスピナーを止めグレー化し「（中断?）」を付ける。
 * stale 判定は now（呼び出し時点の現在時刻）を基準にクライアント側で行う
 * （サーバーの activityStale はイベント受信時点の値で固定されるため使わない）。
 */
export function resolveStatusView(
  p: {
    status: ProjectSummary['status'];
    activityLabel?: string;
    activityStartedAt?: string;
    /** @deprecated 互換性のため受け付けるが、クライアントは isActivityStale の自前判定を優先する。 */
    activityStale?: boolean;
  },
  now: number = Date.now(),
): StatusView {
  if (p.activityLabel !== undefined && p.activityLabel !== '') {
    if (isActivityStale(p.activityStartedAt, now)) {
      return {
        label: `${p.activityLabel}（中断?）`,
        className: 'status-badge status-stale',
        colorClass: 'status-stale',
        spinner: false,
      };
    }
    return {
      label: p.activityLabel,
      className: 'status-badge status-activity',
      colorClass: 'status-activity',
      spinner: true,
    };
  }
  const colorClass = statusColorClass(p.status);
  return {
    label: STATUS_LABEL[p.status],
    className: `status-badge ${colorClass}`,
    colorClass,
    spinner: false,
  };
}

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * 最終編集時刻（mtimeMs）を相対表記にする純関数。
 * 例: 「たった今」「5分前」「2時間前」「昨日」「3日前」、7 日超は日付。
 * 未来・負値は「たった今」に丸める。
 */
export function formatRelativeTime(ms: number, now: number): string {
  const diff = now - ms;
  if (diff < MINUTE) return 'たった今';
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)}分前`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)}時間前`;
  if (diff < 2 * DAY) return '昨日';
  if (diff < 7 * DAY) return `${Math.floor(diff / DAY)}日前`;
  const d = new Date(ms);
  const nowYear = new Date(now).getFullYear();
  const md = `${d.getMonth() + 1}/${d.getDate()}`;
  return d.getFullYear() === nowYear ? md : `${d.getFullYear()}/${md}`;
}
