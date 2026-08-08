import { TrackIcon, type TrackKind } from './TrackIcon';

interface TrackHeaderProps {
  kind: TrackKind;
  label: string;
  onClick?: () => void;
  selected?: boolean;
  /** トラック見出し内に表示するバッジ（速度バッジ等）。 */
  badge?: React.ReactNode;
}

/**
 * 共有トラック見出し。トラック左端の sticky ラベルエリアに
 * 種別アイコン＋テキストラベルを並べて表示する。
 * Task 5: 各トラックの <span className="tl-track-label"> を差し替える。
 * Task 7: onClick が渡された場合のみクリック可能にする（cursor + role=button + keyboard）。
 */
export function TrackHeader({ kind, label, onClick, selected, badge }: TrackHeaderProps) {
  return (
    <span
      className={`tl-track-label${onClick ? ' tl-track-label-clickable' : ''}${selected ? ' tl-track-label-selected' : ''}`}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } } : undefined}
    >
      <TrackIcon kind={kind} />
      <span className="tl-track-name">{label}</span>
      {badge}
    </span>
  );
}
