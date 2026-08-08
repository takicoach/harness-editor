/**
 * 診断スクリプト: 大域キーフレーム化後、カット区間を跨ぐ panLeft 相当のアニメで
 * 隣接フレーム間の x 差分の最大値を求める（旧実装の 216px 段差が解消されたことの数値確認）。
 * 実行: npx tsx scripts/diag-keyframe-pan-smoothness.ts
 */
import { effectiveLayoutAt } from '../src/core/segmentLayout';
import { DEFAULT_MAIN_LAYOUT } from '../src/core/mainLayout';

const base = { ...DEFAULT_MAIN_LAYOUT };

// 旧バグ再現条件と同じ2区間構成（区間境界で強度1のpanLeftを跨ぐ）。
// カットで飛ぶ原本フレーム幅は小さく（10フレーム）取り、「本当の時間経過による位置変化」と
// 「区間ごとリセットの人工的な段差」を区別できるようにする。
const kept = [
  { id: 1, originalStart: 0, playbackStart: 0, playbackEnd: 5000 },
  { id: 2, originalStart: 5010, playbackStart: 5000, playbackEnd: 10000 },
];

// 大域KF: originalFrame 0 で x=+0.4、originalFrame 10009（原本総尺相当）で x=-0.4（panLeft相当・強度1）。
const kfs = [
  { originalFrame: 0, x: 0.4, y: 0, scale: 1, rotation: 0 },
  { originalFrame: 10009, x: -0.4, y: 0, scale: 1, rotation: 0 },
];

let maxDelta = 0;
let maxAt = -1;
let prevX: number | null = null;
for (let f = 0; f < 10000; f++) {
  const x = effectiveLayoutAt(f, kept, base, {}, false, kfs).position.x;
  if (prevX !== null) {
    const delta = Math.abs(x - prevX) * 1080; // 画面幅相当(px換算・1080p想定)
    if (delta > maxDelta) {
      maxDelta = delta;
      maxAt = f;
    }
  }
  prevX = x;
}

console.log(`最大フレーム間差分: ${maxDelta.toFixed(3)}px (frame ${maxAt} 付近)`);
console.log(maxDelta < 5 ? '判定: 滑らか（旧216px段差は解消）' : '判定: 段差が残っている');
