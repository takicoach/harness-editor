/**
 * 円形プログレス（書き出し等の進捗表示）。
 * - percent が数値: 確定リング（stroke-dashoffset）＋リング中央に％数字。
 *   横バーだと残量が読み取りにくい・ラベルの％が幅不足で切れる、という試写FB（2026-08-17）への対応で、
 *   ％数字をリング内に置くことでコンテナがどれだけ狭くても進捗が必ず見える。
 * - percent が null: 未確定スピナー（回転ダッシュリング）。
 *   意匠は Subhan-code/Amicro--Micro-transitions-（MIT）の ring 系コンポーネントを CSS のみで翻案。
 */
export function CircularProgress({ percent, size = 28 }: { percent: number | null; size?: number }) {
  const stroke = 3;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  if (percent === null) {
    return (
      <svg
        className="cp-ring cp-indeterminate"
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        aria-hidden="true"
      >
        <circle className="cp-track" cx={size / 2} cy={size / 2} r={r} strokeWidth={stroke} />
        <circle
          className="cp-arc"
          cx={size / 2}
          cy={size / 2}
          r={r}
          strokeWidth={stroke}
          strokeDasharray={`${c * 0.28} ${c * 0.72}`}
        />
      </svg>
    );
  }
  const clamped = Math.max(0, Math.min(100, percent));
  const offset = c * (1 - clamped / 100);
  return (
    <svg
      className="cp-ring"
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role="progressbar"
      aria-valuenow={Math.round(clamped)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <circle className="cp-track" cx={size / 2} cy={size / 2} r={r} strokeWidth={stroke} />
      {/* 12時起点・時計回り。transition は CSS 側（stroke-dashoffset）。 */}
      <circle
        className="cp-arc"
        cx={size / 2}
        cy={size / 2}
        r={r}
        strokeWidth={stroke}
        strokeDasharray={c}
        strokeDashoffset={offset}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
      <text className="cp-value" x="50%" y="50%" dominantBaseline="central" textAnchor="middle">
        {Math.round(clamped)}
      </text>
    </svg>
  );
}
