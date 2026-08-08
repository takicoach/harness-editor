import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { bundleTelopComponent, TELOP_EXTERNALS } from './bundleTelop';

const SAMPLE = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'sample-project');

describe('bundleTelopComponent', () => {
  it('Telop.tsx を ESM へバンドルする', async () => {
    const js = await bundleTelopComponent(SAMPLE);
    expect(js.length).toBeGreaterThan(0);
    // Telop が export される
    expect(js).toMatch(/\bTelop\b/);
  });

  it('react / remotion は外部依存として bare import のまま残す', async () => {
    const js = await bundleTelopComponent(SAMPLE);
    expect(js).toMatch(/from\s*["']remotion["']/);
    expect(js).toMatch(/from\s*["']react\/jsx-runtime["']/);
  });

  it('react-dom の直接 import も bare import のまま残す（import map で解決される前提）', async () => {
    const js = await bundleTelopComponent(SAMPLE);
    expect(js).toMatch(/from\s*["']react-dom["']/);
  });

  it('ローカル import (telopStyles) はバンドルへ取り込む', async () => {
    const js = await bundleTelopComponent(SAMPLE);
    // ./telopStyles の import 文は消え、中身（色定義）が取り込まれている
    expect(js).not.toMatch(/from\s*["']\.\/telopStyles["']/);
    expect(js).toContain('#FFE57A');
  });
});

describe('TELOP_EXTERNALS', () => {
  it('共有必須パッケージだけを外部化し @remotion/* は含めない', () => {
    expect(TELOP_EXTERNALS).toEqual([
      'react',
      'react-dom',
      'react/jsx-runtime',
      'react/jsx-dev-runtime',
      'remotion',
    ]);
    expect(TELOP_EXTERNALS).not.toContain('@remotion/*');
  });
});
