import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { bundleInsertImageComponent, INSERT_IMAGE_EXTERNALS } from './bundleInsertImage';

const SAMPLE = resolve(__dirname, '__fixtures__', 'sample-project');

describe('bundleInsertImageComponent', () => {
  it('対象プロジェクトの InsertImage.tsx を ESM へバンドルする', async () => {
    const js = await bundleInsertImageComponent(SAMPLE);
    expect(js).toContain('export');
    expect(js).toContain('InsertImage');
  });

  it('react / remotion は外部化したまま', async () => {
    const js = await bundleInsertImageComponent(SAMPLE);
    // jsx: 'automatic' により react/jsx-runtime が外部化される（bare import のまま残る）
    expect(js).toMatch(/from\s*["']react\/jsx-runtime["']/);
    expect(js).toContain('from "remotion"');
  });
});

describe('INSERT_IMAGE_EXTERNALS', () => {
  it('共有必須パッケージのみ外部化する', () => {
    expect(INSERT_IMAGE_EXTERNALS).toEqual([
      'react',
      'react-dom',
      'react/jsx-runtime',
      'react/jsx-dev-runtime',
      'remotion',
    ]);
  });

  it('@remotion/* ヘルパは外部化しない（バンドルへ取り込む）', () => {
    expect(INSERT_IMAGE_EXTERNALS).not.toContain('@remotion/*');
    expect(INSERT_IMAGE_EXTERNALS).not.toContain('@remotion/shapes');
  });
});
