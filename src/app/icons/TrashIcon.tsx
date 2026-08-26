/**
 * 共通のゴミ箱アイコン（SVG）。削除導線（素材の行/セル・プロジェクトカード）で共有する。
 *
 * 絵文字を使わない理由: 字面が OS のフォントに依存して大きさ・色が揃わず、
 * テーマ（明暗）にも追従しない。SVG なら `currentColor` で親の文字色に従う。
 * アイコン自体は `aria-hidden`（意味は親ボタンの title / aria-label が持つ）。
 */
export interface TrashIconProps {
  /** 一辺の px。既定 16。 */
  size?: number;
  className?: string;
}

export function TrashIcon({ size = 16, className }: TrashIconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...(className === undefined ? {} : { className })}
    >
      {/* 蓋 */}
      <path d="M2.5 4h11" />
      <path d="M6.5 4V2.8h3V4" />
      {/* 本体 */}
      <path d="M4 4l.7 8.6a1 1 0 0 0 1 .9h4.6a1 1 0 0 0 1-.9L12 4" />
      {/* 溝 */}
      <path d="M6.6 6.6v4.4" />
      <path d="M9.4 6.6v4.4" />
    </svg>
  );
}
