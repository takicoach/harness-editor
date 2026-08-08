import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 雛形の Telop.tsx は Remotion のフック（useCurrentFrame / useVideoConfig）を使う。
// interpolate / spring は純関数なので本物のまま使い、コンテキスト依存のフックだけ差し替える。
vi.mock('remotion', async (importOriginal) => {
  const actual = await importOriginal<typeof import('remotion')>();
  return {
    ...actual,
    useCurrentFrame: () => 30,
    useVideoConfig: () => ({
      fps: 30,
      width: 1920,
      height: 1080,
      durationInFrames: 300,
      id: 'test',
      defaultProps: {},
      props: {},
    }),
  };
});

import { renderToStaticMarkup } from 'react-dom/server';
import { Telop } from '../../project-template/src/テロップテンプレート/Telop';
import type { TelopSegment, TelopTemplateId } from '../../project-template/src/テロップテンプレート/telopTypes';
import { widenTelopTypes } from './installTelopPack';
import { bundleTelopComponent } from './bundleTelop';
import { createProjectWith, defaultTemplateDir } from './createProject';

const TELOP_DIR = 'テロップテンプレート';
const TEMPLATE_TELOP = join(defaultTemplateDir(), 'src', TELOP_DIR);

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'sme-tpl-telop-'));
  roots.push(root);
  return root;
}

function segment(template?: TelopTemplateId): TelopSegment {
  return { id: 1, startFrame: 0, endFrame: 90, text: 'テスト字幕', animation: 'none', template };
}

function markup(template?: TelopTemplateId): string {
  return renderToStaticMarkup(<Telop segment={segment(template)} />);
}

// ── 同梱スタイル（TAKICOACH オリジナル3種）が実際に描画されること ──
// 番号は拡張テロップパックの 01〜03 と一致させてある（src/server/telopPack/manifest.ts）。
describe('project-template のテロップ描画（同梱3種）', () => {
  it('template 1 = クラシック白抜き（白文字＋黒縁・背景なし）', () => {
    const html = markup(1);
    expect(html).toContain('-webkit-text-stroke:13px #000000');
    expect(html).toContain('color:#ffffff');
    expect(html).toContain('background:transparent');
  });

  it('template 2 = ブラックバー（黒帯＋白文字）', () => {
    const html = markup(2);
    expect(html).toContain('background:#111318');
    expect(html).toContain('color:#ffffff');
    expect(html).toContain('border-radius:21px');
  });

  it('template 3 = ホワイトバー（白帯＋黒文字）', () => {
    const html = markup(3);
    expect(html).toContain('background:#f7f7f5');
    expect(html).toContain('color:#161616');
  });

  it('3種はそれぞれ別の見た目になる', () => {
    const [a, b, c] = [markup(1), markup(2), markup(3)];
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it('template 未指定は 1（クラシック白抜き）へフォールバックする', () => {
    expect(markup(undefined)).toBe(markup(1));
  });

  it('範囲外の template 番号でも落ちず 1 へフォールバックする', () => {
    // 拡張パック用の番号（35）が data に残ったまま無料版で開かれるケース。
    const html = renderToStaticMarkup(<Telop segment={{ ...segment(), template: 35 as TelopTemplateId }} />);
    expect(html).toBe(markup(1));
  });

  it('本文テキストを描画する', () => {
    expect(markup(1)).toContain('テスト字幕');
  });
});

// ── 第三者由来の意匠が同梱物に残っていないこと ──
describe('project-template のテロップスタイル定義', () => {
  const styles = readFileSync(join(TEMPLATE_TELOP, 'telopStyles.ts'), 'utf8');

  it('TAKICOACH オリジナル3種だけを export する', () => {
    const exported = [...styles.matchAll(/^export const (template\w+):/gm)].map((m) => m[1]);
    expect(exported).toEqual(['template1_classicOutline', 'template2_blackBar', 'template3_whiteBar']);
  });

  it('第三者由来のスタイル名を含まない', () => {
    for (const name of ['template1_gradient', 'template2_purpleStroke', 'template3_gradientText', 'template4_negative', 'template6_whiteGradientText']) {
      expect(styles).not.toContain(name);
    }
  });

  it('CSS 拡張描画パス（TelopCssSpec）を持つ', () => {
    const types = readFileSync(join(TEMPLATE_TELOP, 'telopTypes.ts'), 'utf8');
    expect(types).toContain('export interface TelopCssSpec');
    expect(readFileSync(join(TEMPLATE_TELOP, 'Telop.tsx'), 'utf8')).toContain('const cssSpec = config.css;');
  });

  it('エディタ拡張（position / scale / motion）の型を残している', () => {
    const types = readFileSync(join(TEMPLATE_TELOP, 'telopTypes.ts'), 'utf8');
    for (const field of ['position?: TelopPoint;', 'scale?: number;', 'motion?: TelopMotion;', 'manual?: boolean;']) {
      expect(types).toContain(field);
    }
  });
});

// ── テロップパック（拡張30種）の導入経路が雛形の型でも成立すること ──
describe('雛形の telopTypes.ts × installTelopPack の widen', () => {
  it('TelopTemplateId の数値 union を number へ広げられる', () => {
    const src = readFileSync(join(TEMPLATE_TELOP, 'telopTypes.ts'), 'utf8');
    const widened = widenTelopTypes(src);
    expect(widened).not.toBeNull();
    expect(widened).toContain('export type TelopTemplateId = number;');
    // フィールド側の参照は残す（型名が未使用にならないこと）。
    expect(widened).toContain('template?: TelopTemplateId;');
  });
});

// ── 「動画を作成する」相当のフローで配布される中身の検証 ──
describe('新規プロジェクト作成でテロップ部品が配布される', () => {
  it('雛形と同じ3種が配られ、esbuild でバンドルできる', async () => {
    const root = makeRoot();
    const { dir } = createProjectWith(
      root,
      { name: 'telop-check', videoName: 'main.mp4' },
      {
        placeVideo: (videoPath) => writeFileSync(videoPath, 'x'),
        probe: () => ({ fps: 30, durationSeconds: 10, width: 1920, height: 1080 }),
      },
    );

    const destTelop = join(dir, 'src', TELOP_DIR);
    for (const file of ['Telop.tsx', 'telopStyles.ts', 'telopTypes.ts']) {
      expect(readFileSync(join(destTelop, file), 'utf8')).toBe(
        readFileSync(join(TEMPLATE_TELOP, file), 'utf8'),
      );
    }

    const js = await bundleTelopComponent(dir);
    // 3種の意匠がバンドルへ取り込まれている（esbuild は非ASCIIを \u エスケープするため色で照合）。
    expect(js).toContain('width: 13'); // クラシック白抜きの黒縁
    expect(js).toContain('#111318'); // ブラックバーの帯色
    expect(js).toContain('#f7f7f5'); // ホワイトバーの帯色
    expect(js).toMatch(/\bTelop\b/);
  });
});
