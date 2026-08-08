import { Icon, type IconName } from '../Icon';
import type { ProjectSummary } from '../../shared/types';
import type { OrientationCode } from '../../shared/orientation';
import { VideoThumb } from './VideoThumb';
import { useLiveNow } from '../useLiveNow';
import { resolveStatusView, statusLabel, formatRelativeTime } from './projectStatusView';

interface FolderBrowserProps {
  open: boolean;
  projects: ProjectSummary[];
  activeId: string | null;
  error: string | null;
  onPick: (id: string) => void;
  onToggle: () => void;
  /** ホーム（プロジェクト未選択）へ戻る。未指定またはプロジェクト未選択時はボタン非表示。 */
  onGoHome?: () => void;
}

const ORIENTATION_ICON: Record<OrientationCode, IconName> = {
  v: 'portrait',
  h: 'landscape',
  sq: 'square',
};
const ORIENTATION_LABEL: Record<OrientationCode, string> = {
  v: '縦',
  h: '横',
  sq: '正方形',
};

/**
 * AI 作業中（activity あり）の行に付ける強調クラス。
 * 作業中=' fb-working'、放置（中断?）=' fb-working stale'、それ以外は ''。
 */
function workingClass(p: ProjectSummary, now: number): string {
  if (p.activityLabel === undefined || p.activityLabel === '') return '';
  return resolveStatusView(p, now).spinner ? ' fb-working' : ' fb-working stale';
}

export function FolderBrowser({ open, projects, activeId, error, onPick, onToggle, onGoHome }: FolderBrowserProps) {
  const now = useLiveNow();
  if (!open) {
    return (
      <div className="fb">
        <div className="fb-head">
          <button className="fb-collapse" onClick={onToggle} title="フォルダを開く">
            <Icon name="panel-left-open" size={15} />
          </button>
        </div>
        <div className="fb-mini">
          {projects.slice(0, 8).map((p) => (
            <button
              key={p.id}
              className={'fb-mini-item' + (activeId === p.id ? ' active' : '') + workingClass(p, now)}
              onClick={() => onPick(p.id)}
              title={p.activityLabel !== undefined ? `${p.name} — ${resolveStatusView(p, now).label}` : p.name}
            >
              <div className={'fb-thumb' + (p.orientation === 'h' ? ' h' : p.orientation === 'sq' ? ' sq' : '')}>
                {p.videoFile !== null ? (
                  <VideoThumb src={`/api/video?id=${encodeURIComponent(p.id)}&file=${encodeURIComponent(p.videoFile)}`} />
                ) : (
                  <div className="fb-thumb-inner" />
                )}
              </div>
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="fb">
      <div className="fb-head">
        <h2>
          <Icon name="folder" size={14} />
          <span>プロジェクト</span>
        </h2>
        {onGoHome !== undefined && activeId !== null && (
          <button className="fb-collapse" onClick={onGoHome} title="ホームへ戻る" data-testid="go-home">
            <Icon name="home" size={15} />
          </button>
        )}
        <button className="fb-collapse" onClick={onToggle} title="サイドバーを畳む">
          <Icon name="panel-left-close" size={15} />
        </button>
      </div>
      <div className="fb-list">
        <div className="fb-section-title">
          <span>ハーネス形式のプロジェクト</span>
          <span className="fb-counts">{projects.length} 件</span>
        </div>
        {error && <div className="sme-warnings sme-error">{error}</div>}
        {!error && projects.length === 0 && (
          <div className="sme-center">
            <p>プロジェクトが見つかりません</p>
            <p className="hint">HARNESS_PROJECT_ROOT にハーネス形式のプロジェクトのある場所を指定してください</p>
          </div>
        )}
        {projects.map((p) => {
          const view = resolveStatusView(p, now);
          const working = p.activityLabel !== undefined && p.activityLabel !== '';
          return (
          <div
            key={p.id}
            className={'fb-item' + (activeId === p.id ? ' active' : '') + workingClass(p, now)}
            onClick={() => onPick(p.id)}
            title={working ? `${p.name} — ${view.label}` : p.name}
          >
            <div className={'fb-thumb' + (p.orientation === 'h' ? ' h' : p.orientation === 'sq' ? ' sq' : '')}>
              {p.videoFile !== null ? (
                <VideoThumb src={`/api/video?id=${encodeURIComponent(p.id)}&file=${encodeURIComponent(p.videoFile)}`} />
              ) : (
                <div className="fb-thumb-inner" />
              )}
            </div>
            <div className="fb-item-text">
              <div className="fb-item-name">
                <span
                  className={'fb-status-dot ' + view.colorClass}
                  title={p.activityLabel ?? statusLabel(p.status)}
                />
                <span className="fb-item-name-text">{p.name}</span>
              </div>
              {working && (
                <div className={'fb-activity' + (view.spinner ? '' : ' stale')}>
                  {view.spinner && <span className="status-spinner" aria-hidden="true" />}
                  <span className="fb-activity-label">{view.label}</span>
                </div>
              )}
              <div className="fb-item-meta">
                <span className={'fb-orientation ' + p.orientation}>
                  <Icon name={ORIENTATION_ICON[p.orientation]} size={10} />
                  {ORIENTATION_LABEL[p.orientation]}
                </span>
                <span className="sep">·</span>
                <span>{p.durationLabel}</span>
                {p.lastEditedAt !== undefined && <span className="sep">·</span>}
                {p.lastEditedAt !== undefined && <span>{formatRelativeTime(p.lastEditedAt, now)}</span>}
              </div>
            </div>
            {activeId === p.id && <span className="fb-active-dot" />}
          </div>
          );
        })}
      </div>
    </div>
  );
}
