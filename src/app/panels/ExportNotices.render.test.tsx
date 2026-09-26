/**
 * @vitest-environment jsdom
 */
/**
 * 書き出し中の通知（ExportNotices）の表示テスト。
 *
 * H-3 以前は Toolbar が書き出し帯の中に絶対配置で持っていた（Toolbar.render.test.ts の
 * 「Toolbar — fastCutFallbackNotice」）。置き場をツールバー直下のバナー枠へ移したので、
 * 同じ検証をここへ移設し、**同時表示・当たり判定・ツールチップ**の 3 点を足した
 * （幾何（重なり）の検査は jsdom にレイアウトが無いため e2e: tests/render-button.spec.ts）。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createElement } from 'react';
import { render, cleanup } from '@testing-library/react';
import { ExportNotices, exportNotices, FAST_CUT_FALLBACK_DEFAULT_MESSAGE } from './ExportNotices';
import type { RenderState } from '../useRenderJob';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

afterEach(cleanup);

const running: RenderState = { status: 'running', phase: 'rendering', percent: 50, startedAt: 0 };

describe('exportNotices（純関数）', () => {
  it('running でなければ何も出さない', () => {
    expect(exportNotices({ status: 'idle' }, true, null)).toEqual([]);
    expect(exportNotices({ status: 'done', warning: 'w' }, true, null)).toEqual([]);
  });

  it('退避通知だけ・警告だけ・両方、をこの順で並べる', () => {
    expect(exportNotices(running, true, null).map((n) => n.key)).toEqual(['fastcut']);
    expect(exportNotices({ ...running, warning: 'w' }, false, null).map((n) => n.key)).toEqual(['warning']);
    expect(exportNotices({ ...running, warning: 'w' }, true, null).map((n) => n.key)).toEqual([
      'fastcut',
      'warning',
    ]);
  });

  it('理由が分かっていればその文言・無ければ既定文言', () => {
    expect(exportNotices(running, true, '理由あり')[0]!.text).toBe('理由あり');
    expect(exportNotices(running, true, null)[0]!.text).toBe(FAST_CUT_FALLBACK_DEFAULT_MESSAGE);
  });
});

describe('ExportNotices（表示）', () => {
  it('running 中に fastCutFallbackNotice=true なら通知文言が表示される', () => {
    const { getByRole } = render(
      createElement(ExportNotices, { renderState: running, fastCutFallbackNotice: true }),
    );
    expect(getByRole('note').textContent).toContain('今回は通常の書き出しになりました');
  });

  it('fastCutFallbackNotice=false（既定）なら通知は表示されない', () => {
    const { queryByRole, container } = render(createElement(ExportNotices, { renderState: running }));
    expect(queryByRole('note')).toBeNull();
    expect(container.querySelector('.export-notices')).toBeNull();
  });

  it('fastCutFallbackMessage を渡すと textContent がその値になる（既定文言ではない・M2d T2 修正2 I-2）', () => {
    const message = '環境変数 HARNESS_CHROMIUM のパスが見つからないため通常の書き出しになりました';
    const { getByRole } = render(
      createElement(ExportNotices, {
        renderState: running,
        fastCutFallbackNotice: true,
        fastCutFallbackMessage: message,
      }),
    );
    expect(getByRole('note').textContent).toBe(message);
    expect(getByRole('note').textContent).not.toContain('今回は通常の書き出しになりました（素材の形式などにより');
  });

  it('退避通知と警告が同時でも 2 件が別要素として並ぶ（片方が消えない・H-3(c)）', () => {
    const { getAllByRole } = render(
      createElement(ExportNotices, {
        renderState: { ...running, warning: '高速書き出しに失敗したため互換(Remotion)経路でやり直しています' },
        fastCutFallbackNotice: true,
      }),
    );
    const notes = getAllByRole('note');
    expect(notes).toHaveLength(2);
    expect(notes[0]!.getAttribute('data-notice')).toBe('fastcut');
    expect(notes[1]!.getAttribute('data-notice')).toBe('warning');
    // 同じ親の兄弟として縦に積む（絶対配置で同一座標に重ねない）。
    expect(notes[0]!.parentElement).toBe(notes[1]!.parentElement);
    expect(notes[0]!.textContent).not.toBe(notes[1]!.textContent);
  });

  it('各通知は title を持つ（H-3(b): pointer-events を切ってツールチップを殺さない）', () => {
    const warning = '高速書き出しに失敗したため互換(Remotion)経路でやり直しています';
    const { getAllByRole } = render(
      createElement(ExportNotices, {
        renderState: { ...running, warning },
        fastCutFallbackNotice: true,
      }),
    );
    const notes = getAllByRole('note');
    expect(notes[0]!.getAttribute('title')).toBe(FAST_CUT_FALLBACK_DEFAULT_MESSAGE);
    expect(notes[1]!.getAttribute('title')).toBe(warning);
  });
});

/**
 * 通知の**色の重要度**が逆転していないことを固定する（E-2）。
 *
 * 実測していた破綻: info（案内）が --accent（サーモン）で着色されていたため、
 * ただの案内が実際の注意（warn＝ゴールド）より警戒色に見え、2 件同時表示時に
 * 視覚的な重要度が逆転していた（証拠: docs/reports/aaa-screenshots/E-2/notes-before-*.png →
 * notes-*.png）。色そのものは目で見るしかないが、「案内に注意喚起トークンを使わない」
 * という規約は機械で守れる。
 */
describe('通知の色の重要度（styles.css）', () => {
  const css = readFileSync(resolve(import.meta.dirname, '../styles.css'), 'utf8');
  const block = (selector: string): string => {
    const at = css.indexOf(`${selector} {`);
    expect(at, `${selector} が styles.css に無い`).toBeGreaterThan(-1);
    return css.slice(at, css.indexOf('}', at));
  };

  it('info は注意喚起トークン（--accent / --warn-fg / --danger）で着色しない', () => {
    const info = block('.export-note-info');
    for (const token of ['--accent', '--warn-fg', '--danger']) {
      expect(info.includes(token), `info が ${token} を使っている（warn より目立つ）`).toBe(false);
    }
  });

  it('warn は警告トークンで着色する（案内と同じ見た目に退化させない）', () => {
    expect(block('.export-note-warn')).toContain('--warn-fg');
  });
});
