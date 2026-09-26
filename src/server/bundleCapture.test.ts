/**
 * 撮影ページ用バンドル route の中身（M2b T2）。
 *
 * 検査の眼目は「'remotion' が出力に混入していないこと」。撮影ページは importmap で
 * 'remotion' を captureRuntime バレルへ差し替える設計なので、バレル自身や entry の
 * バンドルに real remotion が取り込まれていたら、面の差し替えが無言で無効化される。
 */
import { describe, expect, it } from 'vitest';
import { bundleCaptureEntry, bundleCaptureRuntime, CAPTURE_EXTERNALS } from './bundleCapture';

describe('bundleCaptureRuntime', () => {
  it('captureRuntime バレルを ESM 1ファイルへバンドルし、公開 API を export する', async () => {
    const js = await bundleCaptureRuntime();
    for (const symbol of [
      'useCurrentFrame',
      'useVideoConfig',
      'interpolate',
      'spring',
      'Easing',
      'Sequence',
      'AbsoluteFill',
      'staticFile',
      'Img',
      'CaptureFrameProvider',
      'setStaticFileResolver',
    ]) {
      expect(js).toContain(symbol);
    }
    expect(js).toMatch(/export\s*\{/);
  });

  it("real 'remotion' への依存を出力に含まない（import も再エクスポートも）", async () => {
    const js = await bundleCaptureRuntime();
    expect(js).not.toMatch(/from\s*["']remotion["']/);
    expect(js).not.toMatch(/import\s*\(\s*["']remotion["']\s*\)/);
  });

  it('react は外部化して importmap 側に委ねる（エディタと同一インスタンス共有）', async () => {
    const js = await bundleCaptureRuntime();
    expect(js).toMatch(/from\s*["']react(\/jsx-runtime)?["']/);
    expect(CAPTURE_EXTERNALS).toContain('react');
    expect(CAPTURE_EXTERNALS).toContain('remotion');
  });
});

describe('bundleCaptureEntry', () => {
  it('撮影ページのエントリを ESM 1ファイルへバンドルする', async () => {
    const js = await bundleCaptureEntry();
    expect(js).toContain('__capture');
  });

  it("'remotion' は外部参照のまま残す（importmap で captureRuntime へ解決させる）", async () => {
    const js = await bundleCaptureEntry();
    // 外部参照は残るが、real remotion の実装（static-file.js 等）は取り込まれない。
    expect(js).toMatch(/from\s*["']remotion["']/);
    expect(js).not.toContain('remotion_staticBase');
  });

  it(
    'captureRuntime バレルの実装（CaptureFrameProvider の定義）が entry バンドルへ' +
      'インライン化されていない（M2c T2 レビュー指摘: 上の「remotion 非混入」pin は ' +
      'TitleLayer.tsx 経由の real remotion 外部参照だけで満たせてしまい、' +
      'runtimeFace.ts 経由で captureRuntime がインライン化される regression を検出できない。' +
      'externalizeCaptureRuntimePlugin を外すと本テストは RED になることを確認済み）',
    async () => {
      const js = await bundleCaptureEntry();
      // captureRuntime/components.tsx の CaptureFrameProvider 定義そのものの痕跡。
      // インライン化されていれば "function CaptureFrameProvider" が出力に現れる
      // （single instance が壊れている状態＝importmap 経由の /capture/runtime.js とは
      // 別インスタンスの captureRuntime を entry.js が自前で持ってしまっている）。
      expect(js).not.toContain('function CaptureFrameProvider');
    },
  );
});
