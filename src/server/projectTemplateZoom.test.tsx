import { describe, it, expect, vi, beforeEach } from 'vitest';

// 雛形の ZoomFrame は useCurrentFrame() と zoomData（モジュールスコープの const 配列）に依存する。
// interpolate / Easing / AbsoluteFill は純粋なので本物のまま使い、フレームとデータだけ差し替える。
// vi.hoisted で作った同一オブジェクトを両モックが掴むので、テスト側は中身を書き換えるだけでよい。
const zoomMock = vi.hoisted(() => ({ frame: 0, segments: [] as ZoomSegment[] }));

vi.mock('remotion', async (importOriginal) => {
  const actual = await importOriginal<typeof import('remotion')>();
  return { ...actual, useCurrentFrame: () => zoomMock.frame };
});

vi.mock('../../project-template/src/zoomData', () => ({ zoomData: zoomMock.segments }));

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { ZoomFrame } from '../../project-template/src/ZoomFrame';
// tsconfig の include は project-template を含まないため、雛形は「include 内から import された分」
// しか型検査されない。MainVideo をここで値として import し、雛形の合成本体とその依存を
// tsc の対象へ載せる（`tsc --noEmit --listFiles | grep project-template` で確認できる）。
import { MainVideo } from '../../project-template/src/MainVideo';
import type { ZoomSegment } from '../../project-template/src/zoomData';
import { createProjectWith } from './createProject';
import { installBgm } from './installBgm';
import { installVideoInsert } from './installVideoInsert';
import { installShape } from './installShape';
import { installTransition } from './installTransition';

const CHILD = <span data-marker="child">子要素</span>;
const BASELINE = renderToStaticMarkup(CHILD);

function setSegments(...segments: ZoomSegment[]): void {
  zoomMock.segments.length = 0;
  zoomMock.segments.push(...segments);
}

function renderAt(frame: number): string {
  zoomMock.frame = frame;
  return renderToStaticMarkup(<ZoomFrame>{CHILD}</ZoomFrame>);
}

/** 描画結果の transform から translate(%)/scale を数値で取り出す。 */
function parseTransform(html: string): { translateX: number; translateY: number; scale: number } {
  const m = html.match(/transform:translate\((-?[0-9.eE+-]+)%, ?(-?[0-9.eE+-]+)%\) scale\((-?[0-9.eE+-]+)\)/);
  if (!m) throw new Error(`transform が見つからない: ${html}`);
  return { translateX: Number(m[1]), translateY: Number(m[2]), scale: Number(m[3]) };
}

function segment(overrides: Partial<ZoomSegment> = {}): ZoomSegment {
  return { id: 1, originalStart: 0, originalEnd: 100, scale: 2, origin: { x: 50, y: 50 }, ...overrides };
}

beforeEach(() => {
  setSegments();
  zoomMock.frame = 0;
});

// ── ① 対象外では DOM を1要素も足さない（既存プロジェクトへの影響ゼロの土台） ──
describe('ZoomFrame: 対象外は素通し', () => {
  it('zoomData が空配列なら子要素だけを描画する（ラッパー DOM なし）', () => {
    expect(renderAt(0)).toBe(BASELINE);
    expect(renderAt(1234)).toBe(BASELINE);
  });

  it('区間の手前・区間の終端（半開区間で originalEnd は含まない）でも素通しする', () => {
    setSegments(segment({ originalStart: 100, originalEnd: 200 }));
    expect(renderAt(99)).toBe(BASELINE);
    expect(renderAt(200)).toBe(BASELINE);
    // 区間内はラッパーが付く（上の 2 件が「常に素通し」で通っていないことの担保）
    expect(renderAt(100)).not.toBe(BASELINE);
  });
});

// ── ② 区間内の transform（translate(%) → scale() の合成順） ──
describe('ZoomFrame: 区間内の transform', () => {
  it('注視点オフセットぶんの translate と scale をこの順で当てる', () => {
    setSegments(segment({ originalStart: 100, originalEnd: 200, scale: 2, origin: { x: 25, y: 75 } }));
    // t=1（トランジション無し）→ scale=2、offset=(-25,+25) → translate = offset*(1-2)
    expect(renderAt(150)).toContain('transform:translate(25%, -25%) scale(2)');
  });

  it('origin 欠落・非数値でも落ちず、画面中央を注視点にする', () => {
    // zoomData.ts は購入者が手書きする前提のため、キーごと無いデータが来うる。
    // プロパティ参照で TypeError にせず、中央 { x: 50, y: 50 } として描画する。
    setSegments({ id: 1, originalStart: 0, originalEnd: 100, scale: 2 });
    expect(renderAt(50)).toContain('transform:translate(0%, 0%) scale(2)');

    // 片側だけ NaN / 数値以外でも、その軸だけ中央へ倒す。
    setSegments(segment({ scale: 2, origin: { x: Number.NaN, y: 80 } }));
    const { translateX, translateY, scale } = parseTransform(renderAt(50));
    expect(scale).toBe(2);
    expect(translateX).toBe(0); // x は中央 50 扱い → offset 0
    expect(translateY).toBeCloseTo((80 - 50) * (1 - 2), 6);
  });

  it('scale と origin は防御的にクランプされる（scale 0.1〜8 / origin 0〜100）', () => {
    setSegments(segment({ scale: 100, origin: { x: -50, y: 500 } }));
    const { translateX, translateY, scale } = parseTransform(renderAt(50));
    expect(scale).toBe(8);
    // origin は x=0 / y=100 へクランプ → offset=(-50,+50)
    expect(translateX).toBeCloseTo(-50 * (1 - 8), 6);
    expect(translateY).toBeCloseTo(50 * (1 - 8), 6);
  });
});

// ── ③ 注視点不動の不変量（この機構の存在理由そのもの） ──
describe('ZoomFrame: 注視点は画面上で動かない', () => {
  it('区間中のどのフレームでも translate = offset * (1 - scale) が成り立つ', () => {
    const origin = { x: 20, y: 80 };
    setSegments(segment({ originalStart: 0, originalEnd: 60, scale: 1.8, origin, transitionInFrames: 15, transitionOutFrames: 15 }));
    for (let frame = 0; frame < 60; frame++) {
      const { translateX, translateY, scale } = parseTransform(renderAt(frame));
      expect(translateX).toBeCloseTo((origin.x - 50) * (1 - scale), 6);
      expect(translateY).toBeCloseTo((origin.y - 50) * (1 - scale), 6);
    }
  });
});
// ── アタック/リリース封筒の端点 ──
describe('ZoomFrame: アタック/リリース封筒', () => {
  it('区間の最終フレーム（duration-1）で等倍へ戻り切る', () => {
    setSegments(segment({ originalStart: 0, originalEnd: 100, scale: 2, transitionOutFrames: 10 }));
    // 途中はまだ戻り切っていない
    expect(parseTransform(renderAt(95)).scale).toBeGreaterThan(1);
    // 最後に描画されるフレームは originalEnd-1 = 99。ここで 1 に達していないと
    // 区間を抜けた瞬間に等倍へ跳ねる（段差）。
    expect(parseTransform(renderAt(99)).scale).toBe(1);
  });

  it('transitionOutFrames が短すぎて退化する区間でも落ちない（duration-1 <= holdEnd）', () => {
    setSegments(segment({ originalStart: 0, originalEnd: 2, scale: 2, transitionOutFrames: 1 }));
    // duration=2 / tOut=1 では duration-1 が holdEnd と同じで封筒が退化する。
    // 従来どおり duration を終点にして「戻り切らない」で通す（NaN・逆転を出さない）。
    const { scale } = parseTransform(renderAt(1));
    expect(Number.isFinite(scale)).toBe(true);
    expect(scale).toBe(2);
  });
});

// ── ZoomFrame を挟んだ後も、実 MainVideo.tsx に各インストーラのアンカーが立つこと ──
// 個々の install*.test.ts は自前の MainVideo 文字列を使うため、雛形そのものは誰も見ていない。
// ここだけが「配布される実物 × 実インストーラ」を突き合わせる。
describe('雛形 MainVideo.tsx × インストーラのアンカー', () => {
  it('雛形の MainVideo が読み込める（include 外ディレクトリを型検査へ載せる導線）', () => {
    expect(typeof MainVideo).toBe('function');
  });

  it('ZoomFrame 導入後も BGM / サブ動画 / 図形 / シーン転換を組込めて、いずれも ZoomFrame の外に入る', () => {
    const root = mkdtempSync(join(tmpdir(), 'sme-tpl-zoom-'));
    try {
      const { dir } = createProjectWith(
        root,
        { name: 'zoom-anchor-check', videoName: 'main.mp4' },
        {
          placeVideo: (videoPath) => writeFileSync(videoPath, 'x'),
          probe: () => ({ fps: 30, durationSeconds: 10, width: 1920, height: 1080 }),
        },
      );

      const mainVideoPath = join(dir, 'src', 'MainVideo.tsx');
      /** 各要素が `</ZoomFrame>` の内側にあるか外側にあるかを見る。 */
      function assertSides(inside: string[], outside: string[]): void {
        const mv = readFileSync(mainVideoPath, 'utf8');
        const zoomClose = mv.indexOf('</ZoomFrame>');
        expect(zoomClose).toBeGreaterThan(-1);
        for (const tag of inside) {
          expect(mv.indexOf(tag), `${tag} は ZoomFrame の内側`).toBeGreaterThan(-1);
          expect(mv.indexOf(tag), `${tag} は ZoomFrame の内側`).toBeLessThan(zoomClose);
        }
        for (const tag of outside) {
          expect(mv.indexOf(tag), `${tag} は ZoomFrame の外側`).toBeGreaterThan(zoomClose);
        }
      }

      // 配布直後（素の雛形）
      assertSides(['<OffthreadVideo', '<ImageSequence'], ['<TelopPlayer', '<TitleSequence', '<SESequence']);

      expect(installBgm(dir).installed).toBe(true);
      expect(installVideoInsert(dir).installed).toBe(true);
      expect(installShape(dir).installed).toBe(true);
      expect(installTransition(dir).installed).toBe(true);

      // 4 機能の導入後。ベース動画は installTransition が
      // <CutPlayerWithTransitions> へ置換するが、置換先も ZoomFrame の内側に残る。
      // 注入される要素はテロップ行/SESequence 行/`</AbsoluteFill>` 直前がアンカーなので、
      // いずれも ZoomFrame の外側＝ズーム対象外になる（zoomData.ts の制約に明記）。
      assertSides(
        ['<CutPlayerWithTransitions', '<ImageSequence'],
        ['<TelopPlayer', '<TitleSequence', '<SESequence', '<BgmSequence', '<VideoInsertSequence', '<ShapeSequence', '<SceneOverlaySequence'],
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
