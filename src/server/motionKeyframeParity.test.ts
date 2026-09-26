/**
 * キーフレームアニメ（F-1）の「プレビュー＝書き出し」ロック。
 *
 * 補間の正典は src/core/motion.ts（プレビュー EditorComposition と高速書き出しの撮影
 * capturePage が直接呼ぶ）。一方、Remotion 書き出しはプロジェクトへコピーされた部品
 * （telopPack/Telop.tsx・project-template の Telop.tsx / InsertImage.tsx）が**同じ式の
 * 自己完結コピー**で描く。式が複製されている以上、片方だけ直す事故が起きうるので、
 * 全複製が core と同値を返すことをフレーム単位で機械的に固定する。
 *
 * 「実測で確認」の中身: プリセット・キーフレーム両方の代表 motion を、区間の全フレームで
 * 走査して数値一致（precision 12）を要求する。1 フレームでもずれたら fail。
 */
import { describe, it, expect } from 'vitest';
import { sampleMotion, motionProgress, type Motion, type MotionBase } from '../core/motion';
import { sampleTelopMotion } from './telopPack/Telop';
import { sampleTelopMotion as templateSampleTelopMotion } from '../../project-template/src/テロップテンプレート/telopMotion';
import { sampleImageMotion } from '../../project-template/src/InsertImage/imageMotion';

const START = 30;
const END = 105;

/** テロップ側の base（回転はテロップでは使わない＝プレビューも 0 固定）。 */
const TELOP_BASE: MotionBase = { x: 0.1, y: -0.2, scale: 1.2, opacity: 1, rotation: 0 };
/** 画像側の base（回転あり）。 */
const IMAGE_BASE: MotionBase = { x: -0.3, y: 0.25, scale: 0.9, opacity: 0.8, rotation: 12 };

const CASES: Array<{ label: string; motion: Motion }> = [
  { label: 'プリセット zoomIn（既存挙動の非退行）', motion: { preset: 'zoomIn', intensity: 0.7 } },
  { label: 'プリセット panLeft + 詳細上書き', motion: { preset: 'panLeft', intensity: 1, to: { scale: 1.5 } } },
  { label: 'プリセット fadeIn', motion: { preset: 'fadeIn' } },
  {
    label: 'キーフレーム 2 点（ズームイン相当）',
    motion: { preset: 'keyframes', keys: [{ t: 0, scale: 1 }, { t: 1, scale: 1.6 }] },
  },
  {
    label: 'キーフレーム 3 点（行って戻る）',
    motion: {
      preset: 'keyframes',
      keys: [
        { t: 0, x: -0.4, opacity: 0 },
        { t: 0.35, x: 0.2, opacity: 1, scale: 1.4 },
        { t: 1, x: 0, opacity: 0.5, scale: 1 },
      ],
    },
  },
  {
    label: 'キーフレーム 4 点（軸ごとの部分指定・端が内側）',
    motion: {
      preset: 'keyframes',
      keys: [
        { t: 0.2, scale: 1 },
        { t: 0.4, y: 0.3 },
        { t: 0.6, opacity: 0.2 },
        { t: 0.8, scale: 2, rotation: 45 },
      ],
    },
  },
  {
    label: 'キーフレーム 1 点（全区間固定）',
    motion: { preset: 'keyframes', keys: [{ t: 0.5, scale: 1.35 }] },
  },
  {
    label: 'キーフレーム t 重複（同値タイ）',
    motion: {
      preset: 'keyframes',
      keys: [{ t: 0, x: 0 }, { t: 0.5, x: 0.5 }, { t: 0.5, x: -0.5 }, { t: 1, x: 0 }],
    },
  },
];

/**
 * パック Telop.tsx は**プリセットだけ**を core と同値で描く（キーは適用しない）。
 * キーの適用者はラッパー1つ（プレビュー / 撮影 / 新版 TelopPlayer）に固定してあり、
 * 旧ラッパー案件でパックがキーを適用すると書き出しだけ二重適用になるため
 * （固定は src/server/telopPack/Telop.motionKeys.test.tsx）。
 */
const PRESET_CASES = CASES.filter((c) => c.motion.keys === undefined);

describe.each(PRESET_CASES)('$label — telopPack/Telop.tsx が core と同値', ({ motion }) => {
  it('区間の全フレームで x/y/scale/opacity が一致', () => {
    for (let frame = START - 3; frame <= END + 3; frame++) {
      const core = sampleMotion(motion, TELOP_BASE, motionProgress(frame, START, END));
      const pack = sampleTelopMotion(motion, TELOP_BASE, frame, START, END);
      expect(pack.x).toBeCloseTo(core.x, 12);
      expect(pack.y).toBeCloseTo(core.y, 12);
      expect(pack.scale).toBeCloseTo(core.scale, 12);
      expect(pack.opacity).toBeCloseTo(core.opacity, 12);
    }
  });
});

describe.each(CASES)('$label — project-template/テロップテンプレート/telopMotion.ts が core と同値', ({ motion }) => {
  it('区間の全フレームで x/y/scale/opacity が一致', () => {
    for (let frame = START - 3; frame <= END + 3; frame++) {
      const core = sampleMotion(motion, TELOP_BASE, motionProgress(frame, START, END));
      const tpl = templateSampleTelopMotion(motion, TELOP_BASE, frame, START, END);
      expect(tpl.x).toBeCloseTo(core.x, 12);
      expect(tpl.y).toBeCloseTo(core.y, 12);
      expect(tpl.scale).toBeCloseTo(core.scale, 12);
      expect(tpl.opacity).toBeCloseTo(core.opacity, 12);
    }
  });
});

describe.each(CASES)('$label — project-template/InsertImage/imageMotion.ts が core と同値（回転含む）', ({ motion }) => {
  it('区間の全ローカルフレームで x/y/scale/opacity/rotation が一致', () => {
    const duration = END - START;
    for (let local = -3; local <= duration + 3; local++) {
      // InsertImage は <Sequence> 内の相対フレーム。core は同じ進行度で評価する。
      const core = sampleMotion(motion, IMAGE_BASE, motionProgress(local, 0, duration));
      const img = sampleImageMotion(motion, IMAGE_BASE, local, duration);
      expect(img.x).toBeCloseTo(core.x, 12);
      expect(img.y).toBeCloseTo(core.y, 12);
      expect(img.scale).toBeCloseTo(core.scale, 12);
      expect(img.opacity).toBeCloseTo(core.opacity, 12);
      expect(img.rotation).toBeCloseTo(core.rotation, 12);
    }
  });
});

describe('縮退区間（長さ 0）でも複製が core と同じ値を返す', () => {
  const motion: Motion = { preset: 'keyframes', keys: [{ t: 0, scale: 1 }, { t: 1, scale: 3 }] };
  it('template / image のいずれも最後のキー値（パック Telop はキー非適用なので対象外）', () => {
    const core = sampleMotion(motion, TELOP_BASE, motionProgress(10, 10, 10));
    expect(templateSampleTelopMotion(motion, TELOP_BASE, 10, 10, 10).scale).toBeCloseTo(core.scale, 12);
    expect(sampleImageMotion(motion, TELOP_BASE, 0, 0).scale).toBeCloseTo(core.scale, 12);
  });
  it('パック Telop はキーを適用せず base のまま（縮退区間でも二重適用の種を作らない）', () => {
    expect(sampleTelopMotion(motion, TELOP_BASE, 10, 10, 10).scale).toBeCloseTo(TELOP_BASE.scale, 12);
  });
});

/**
 * 高速書き出し（撮影→ffmpeg）の画像レイヤが motion を落としていないことの pin。
 * ここが落ちると「高速書き出しのときだけ画像が静止する」という無言の食い違いになる
 * （F-1 以前は実際に落ちていた）。撮影データの組み立てはインライン map なのでソース側で固定する。
 */
describe('高速書き出しの撮影データ（fastCutPlan）が画像の motion を渡す', () => {
  it('images の map に motion が含まれる', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const src = readFileSync(join(import.meta.dirname, 'fastCutPlan.ts'), 'utf8');
    const start = src.indexOf('images: timeline.images.map((i) => ({');
    expect(start).toBeGreaterThan(-1);
    const block = src.slice(start, src.indexOf('})),', start));
    expect(block).toContain('motion: i.motion,');
  });
});
