/**
 * KeyframeList — キーフレーム（Motion.keys）を打つ・動かす・消す UI（F-1）。
 *
 * 非エンジニアが触る面なので、時間は「表示のはじめ=0% / おわり=100%」の 1 本のスライダーで扱い、
 * フレーム番号は出さない（秒は区間長が分かるときだけ補助表示する）。
 * 値の変更・並べ替えは core/motionKeyOps.ts の純関数に任せ、この面は表示と入力だけを持つ。
 */
import type { Motion, MotionBase } from '../../../core/motion';
import { addMotionKey, moveMotionKey, removeMotionKey, setMotionKeyAxis, type MotionKeyAxis } from '../../../core/motionKeyOps';

export interface KeyframeListProps {
  idPrefix: string;
  motion: Motion;
  base: MotionBase;
  withRotation: boolean;
  withOpacity: boolean;
  /** 書き出し部品の対応状況（未対応なら注意書きを出す）。 */
  support?: { supported: boolean; message: string };
  durationFrames?: number;
  fps?: number;
  onChange: (motion: Motion | undefined) => void;
}

/**
 * 表示の並び（時間順）を、**データ側の位置（index）** の列として返す。
 *
 * 操作対象は常にデータ側の index で指す（moveMotionKey などが並べ替えないのはこのため）。
 * 並べ替えを表示だけに閉じることで、時間スライダーで他のキーを追い越しても、
 * ドラッグ中のスライダーが別のキーを掴み直すことがない。
 */
export function displayOrder(keys: readonly { t: number }[]): number[] {
  return keys.map((_, i) => i).sort((a, b) => keys[a]!.t - keys[b]!.t || a - b);
}

/** 次に打つ位置＝いちばん広い間隔の真ん中（端しか無ければ中央）。 */
export function nextKeyT(ts: number[]): number {
  if (ts.length === 0) return 0;
  if (ts.length === 1) return ts[0]! < 0.5 ? 1 : 0;
  const sorted = [...ts].sort((a, b) => a - b);
  let bestGap = -1;
  let bestT = 0.5;
  for (let i = 0; i < sorted.length - 1; i++) {
    const gap = sorted[i + 1]! - sorted[i]!;
    if (gap > bestGap) {
      bestGap = gap;
      bestT = sorted[i]! + gap / 2;
    }
  }
  return bestT;
}

/** t（0..1）の見出し。区間長が分かるときは秒も添える。 */
function timeLabel(t: number, durationFrames: number | undefined, fps: number | undefined): string {
  const pct = `${Math.round(t * 100)}%`;
  if (durationFrames === undefined || fps === undefined || fps <= 0) return pct;
  return `${pct}（${((t * durationFrames) / fps).toFixed(2)}秒）`;
}

interface AxisRowProps {
  label: string;
  ariaLabel: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
}

function AxisRow({ label, ariaLabel, value, min, max, step, onChange }: AxisRowProps) {
  return (
    <div className="ins-motion-detail-row">
      <span className="ins-motion-detail-label">{label} {value.toFixed(2)}</span>
      <input
        type="range"
        aria-label={ariaLabel}
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  );
}

export function KeyframeList({
  idPrefix, motion, base, withRotation, withOpacity, support, durationFrames, fps, onChange,
}: KeyframeListProps) {
  const keys = motion.keys ?? [];
  const unsupported = support !== undefined && !support.supported;

  return (
    <div className="ins-motion-keys" data-testid={`${idPrefix}-motion-keys`}>
      <p className="ins-motion-keys-help">
        時間の点（キーフレーム）を打つと、点と点の間がなめらかにつながります。
      </p>
      {unsupported && (
        <div className="export-note export-note-warn" role="note">
          {support.message}
        </div>
      )}
      <button
        type="button"
        className="ins-motion-keys-add"
        onClick={() => onChange(addMotionKey(motion, nextKeyT(keys.map((k) => k.t)), base))}
      >
        キーフレームを打つ
      </button>
      <ol className="ins-motion-keys-list">
        {displayOrder(keys).map((i, pos) => {
          const k = keys[i]!;
          const n = pos + 1;
          const axis = (name: MotionKeyAxis, fallback: number): number => k[name] ?? fallback;
          const set = (name: MotionKeyAxis, v: number): void => onChange(setMotionKeyAxis(motion, i, name, v));
          return (
            <li key={i} className="ins-motion-key">
              <div className="ins-motion-key-head">
                <span className="ins-motion-key-title">{n} 番目 — {timeLabel(k.t, durationFrames, fps)}</span>
                <button
                  type="button"
                  className="ins-motion-detail-clear"
                  aria-label={`${n} 番目のキーフレームを削除`}
                  onClick={() => onChange(removeMotionKey(motion, i))}
                >
                  ×
                </button>
              </div>
              <div className="ins-motion-detail-row">
                <span className="ins-motion-detail-label">時間</span>
                <input
                  type="range"
                  aria-label={`${n} 番目のキーフレームの時間`}
                  min={0}
                  max={1}
                  step={0.01}
                  value={k.t}
                  onChange={(e) => onChange(moveMotionKey(motion, i, Number(e.target.value)))}
                />
              </div>
              <AxisRow label="横位置" ariaLabel={`${n} 番目のキーフレームの横位置`} value={axis('x', base.x)} min={-1} max={1} step={0.02} onChange={(v) => set('x', v)} />
              <AxisRow label="縦位置" ariaLabel={`${n} 番目のキーフレームの縦位置`} value={axis('y', base.y)} min={-1} max={1} step={0.02} onChange={(v) => set('y', v)} />
              <AxisRow label="大きさ" ariaLabel={`${n} 番目のキーフレームの大きさ`} value={axis('scale', base.scale)} min={0.1} max={3} step={0.05} onChange={(v) => set('scale', v)} />
              {withOpacity && (
                <AxisRow label="不透明度" ariaLabel={`${n} 番目のキーフレームの不透明度`} value={axis('opacity', base.opacity)} min={0} max={1} step={0.05} onChange={(v) => set('opacity', v)} />
              )}
              {withRotation && (
                <AxisRow label="回転" ariaLabel={`${n} 番目のキーフレームの回転`} value={axis('rotation', base.rotation)} min={-180} max={180} step={1} onChange={(v) => set('rotation', v)} />
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
