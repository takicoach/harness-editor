/**
 * loadOverlayComponentsForPlanner のテスト（M2c T5b）。
 *
 * 実プロジェクトの Telop.tsx / InsertImage.tsx を Node（captureRunPlanner）で使えるように
 * する配線の pin。`vi.mock('remotion', ...)` は**使わない**——本番の renderApi 経路と同じく
 * 「バンドル時に 'remotion' を external にし、評価時に呼び出し側と同じ captureRuntime を
 * 注入する」構造だけで成立することを証明する（captureRunPlanner.nodeResolution.test.ts と同じ規律）。
 */
import { describe, expect, it, vi, beforeAll, afterAll } from 'vitest';
import { cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { compileFunction } from 'node:vm';
import React from 'react';
import * as reactNamespace from 'react';
import * as jsxRuntimeNamespace from 'react/jsx-runtime';
import * as jsxDevRuntimeNamespace from 'react/jsx-dev-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import { CaptureFrameProvider, setStaticFileResolver, useCurrentFrame as captureRuntimeUseCurrentFrame } from '../captureRuntime';
import { loadOverlayComponentsForPlanner } from './loadOverlayComponents';
import { planCaptureRuns } from './captureRunPlanner';

const FIXTURE = resolve(import.meta.dirname, '__fixtures__', 'sample-project');
const VIDEO_CONFIG = { width: 1080, height: 1920, fps: 60, durationInFrames: 4000 };

let tmpRoot: string;

/** fixture を複製した使い捨てプロジェクトを作る（fixture 本体は書き換えない）。 */
function makeProjectCopy(name: string): string {
  const dir = join(tmpRoot, name);
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

/**
 * captureRuntime バレルを独立にもう1回評価して**別インスタンス**を作る（陰性対照専用）。
 * production の loadOverlayComponents と同じ手（esbuild cjs + vm）で、react だけ本物を共有する。
 */
async function evaluateSecondCaptureRuntime(): Promise<Record<string, unknown>> {
  const entry = resolve(import.meta.dirname, '..', 'captureRuntime', 'index.ts');
  const built = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'node',
    target: 'es2022',
    jsx: 'automatic',
    external: ['react', 'react/jsx-runtime', 'react/jsx-dev-runtime'],
    logLevel: 'silent',
  });
  const shims: Record<string, unknown> = {
    react: { ...reactNamespace },
    'react/jsx-runtime': { ...jsxRuntimeNamespace },
    'react/jsx-dev-runtime': { ...jsxDevRuntimeNamespace },
  };
  const fn = compileFunction(built.outputFiles[0]!.text, ['require', 'module', 'exports'], {
    filename: entry,
  }) as (req: (s: string) => unknown, m: { exports: Record<string, unknown> }, e: unknown) => void;
  const moduleObject = { exports: {} as Record<string, unknown> };
  fn((s) => shims[s], moduleObject, moduleObject.exports);
  return moduleObject.exports;
}

function writeTelop(dir: string, source: string): void {
  writeFileSync(join(dir, 'src', 'テロップテンプレート', 'Telop.tsx'), source);
}

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'harness-load-overlay-'));
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('loadOverlayComponentsForPlanner — 実プロジェクトの部品を Node で読む', () => {
  it('resolves both frame specifiers to the same Node context and staticFile resolver', async () => {
    const dir = makeProjectCopy('native-frame-specifier');
    writeTelop(dir, `import {useCurrentFrame as oldFrame} from 'remotion';
      import {useCurrentFrame, useVideoConfig, staticFile} from '@harness/frame-runtime';
      export const Telop = () => <span>{oldFrame()}/{useCurrentFrame()}/{useVideoConfig().fps}/{staticFile('image 空 白&.png')}</span>;`);
    const loaded = await loadOverlayComponentsForPlanner(dir, { telop: true, image: false });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok || !loaded.components.Telop) return;
    setStaticFileResolver(path => `asset:${path}`);
    try {
      const html = renderToStaticMarkup(React.createElement(CaptureFrameProvider, { frame: 45, videoConfig: VIDEO_CONFIG },
        React.createElement(loaded.components.Telop, { segment: {} })));
      expect(html).toContain('45/45/60/asset:image 空 白&amp;.png');
    } finally { setStaticFileResolver(null); }
  });

  it.each(['remotion', '@harness/frame-runtime'])('rejects namespace/default/unsupported APIs before bundling for %s', async specifier => {
    for (const clause of ['* as R', 'R', '{ Audio }']) {
      const dir = makeProjectCopy(`unaudited-${specifier.replaceAll('/', '-')}-${clause.length}`);
      writeTelop(dir, `import ${clause} from '${specifier}'; export const Telop = () => null;`);
      const bundle = vi.fn(async () => '');
      const loaded = await loadOverlayComponentsForPlanner(dir, { telop: true, image: false }, { bundle });
      expect(loaded).toMatchObject({ ok: false, kind: 'unaudited-import' });
      expect(bundle).not.toHaveBeenCalled();
    }
  });
  it('sample-project の実 Telop.tsx を読み込み、captureRunPlanner がシグネチャ分類できる', async () => {
    const dir = makeProjectCopy('ok-sample');
    const result = await loadOverlayComponentsForPlanner(dir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(typeof result.components.Telop).toBe('function');
    expect(typeof result.components.InsertImage).toBe('function');

    // fixture の Telop は opacity = min(1, max(0, localFrame/8))。
    // [100,140) で startFrame=100 のセグメントを描くと local 0..7 が相異なり（8 run）、
    // local 8 以降は opacity=1 で定常（1 run）→ 合計 9 run。
    const plan = planCaptureRuns({
      layer: 'telop',
      data: { telops: [{ id: 1, startFrame: 100, endFrame: 140, text: 'あ', style: 'normal', template: 1 }] },
      videoConfig: VIDEO_CONFIG,
      spans: [{ start: 100, end: 140 }],
      loaded: result.components,
    });
    expect(plan.runs.length).toBe(9);
    expect(plan.totalFrames).toBe(40);
    expect(plan.runs[0]).toEqual({ representativeFrame: 100, startFrame: 100, endFrame: 101 });
    expect(plan.runs[8]).toEqual({ representativeFrame: 108, startFrame: 108, endFrame: 140 });
  });

  it('実 InsertImage を layer:image で分類できる（imageUrl 供給時）', async () => {
    const dir = makeProjectCopy('ok-image');
    const result = await loadOverlayComponentsForPlanner(dir, { telop: false, image: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // fixture の InsertImage は enter/exit 未指定で既定 FADE(8fr)。[100,140) で
    // enter 100..107（8 run）・中盤 108..132（1 run）・exit 133..139（7 run）＝16 run。
    const images = [
      { id: 1, startFrame: 100, endFrame: 140, file: 'sample.png', type: 'photo', imageUrl: '/api/asset?id=p&path=images%2Fsample.png' },
    ];
    const plan = planCaptureRuns({
      layer: 'image',
      data: { images },
      videoConfig: VIDEO_CONFIG,
      spans: [{ start: 100, end: 140 }],
      loaded: result.components,
    });
    expect(plan.runs.length).toBe(16);
    expect(plan.totalFrames).toBe(40);
  });

  it('imageUrl が無いと staticFile リゾルバ未設定で分類が throw する（fastCutPlan が imageUrl を載せる理由）', async () => {
    const dir = makeProjectCopy('image-without-url');
    const result = await loadOverlayComponentsForPlanner(dir, { telop: false, image: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(() =>
      planCaptureRuns({
        layer: 'image',
        data: { images: [{ id: 1, startFrame: 100, endFrame: 140, file: 'sample.png', type: 'photo' }] },
        videoConfig: VIDEO_CONFIG,
        spans: [{ start: 100, end: 140 }],
        loaded: result.components,
      }),
    ).toThrow();
  });

  it('単一インスタンス性: 読み込んだ部品が呼び出し側の CaptureFrameProvider の frame を見る', async () => {
    const dir = makeProjectCopy('single-instance');
    const result = await loadOverlayComponentsForPlanner(dir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const Telop = result.components.Telop!;

    const render = (frame: number): string =>
      renderToStaticMarkup(
        React.createElement(
          CaptureFrameProvider,
          { frame, videoConfig: VIDEO_CONFIG },
          React.createElement(Telop, { segment: { id: 1, startFrame: 100, endFrame: 140, text: 'あ' } }),
        ),
      );

    // context が分離していれば useCurrentFrame が throw する（captureRuntime/components.tsx）。
    // frame=102 → localFrame=2 → opacity=0.25、frame=140 → opacity=1。
    expect(render(102)).toContain('opacity:0.25');
    expect(render(140)).toContain('opacity:1');
  });

  it('陰性対照: captureRuntime を二重評価すると同じ pin が壊れる（上の pin が空振りでない証拠）', async () => {
    // captureRuntime を**もう一度**独立に評価したインスタンスを 'remotion' として注入する
    // （= data: URL / 一時ファイル import で captureRuntime が二重評価された場合の再現）。
    // React Context はインスタンスごとに別物なので、呼び出し側の CaptureFrameProvider の
    // 値は届かず useCurrentFrame が throw する。
    const second = await evaluateSecondCaptureRuntime();
    expect(second['useCurrentFrame']).not.toBe(captureRuntimeUseCurrentFrame);

    const dir = makeProjectCopy('single-instance-control');
    const result = await loadOverlayComponentsForPlanner(dir, undefined, { remotionModuleForTest: second });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const Telop = result.components.Telop!;

    expect(() =>
      renderToStaticMarkup(
        React.createElement(
          CaptureFrameProvider,
          { frame: 102, videoConfig: VIDEO_CONFIG },
          React.createElement(Telop, { segment: { id: 1, startFrame: 100, endFrame: 140, text: 'あ' } }),
        ),
      ),
    ).toThrow('CaptureFrameProvider の内側でのみ使用できます');
  });
});

describe('loadOverlayComponentsForPlanner — 失敗は種別付き（plan は Remotion へ退避）', () => {
  it('未登録 API を import する Telop.tsx は監査 fail・バンドルは実行しない', async () => {
    const dir = makeProjectCopy('unaudited');
    writeTelop(
      dir,
      [
        "import { Audio, useCurrentFrame } from 'remotion';",
        'export const Telop = ({ segment }: { segment: { text?: string } }) => {',
        '  useCurrentFrame();',
        '  return <Audio src="x">{segment.text}</Audio>;',
        '};',
      ].join('\n'),
    );
    const bundle = vi.fn(async () => '');
    const result = await loadOverlayComponentsForPlanner(dir, undefined, { bundle });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('unaudited-import');
    expect(result.message).toContain('Audio');
    expect(bundle).not.toHaveBeenCalled();
  });

  it('@remotion/* からの import も未監査扱いで fail する', async () => {
    const dir = makeProjectCopy('unaudited-scoped');
    writeTelop(
      dir,
      [
        "import { makeCircle } from '@remotion/shapes';",
        'export const Telop = () => <div>{String(makeCircle)}</div>;',
      ].join('\n'),
    );
    const result = await loadOverlayComponentsForPlanner(dir);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('unaudited-import');
  });

  it('Telop.tsx が無ければ missing-file', async () => {
    const dir = makeProjectCopy('missing');
    rmSync(join(dir, 'src', 'テロップテンプレート', 'Telop.tsx'));
    const result = await loadOverlayComponentsForPlanner(dir);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('missing-file');
    expect(result.message).toContain('Telop.tsx');
  });

  it('構文エラーは bundle-failed', async () => {
    const dir = makeProjectCopy('syntax');
    writeTelop(dir, 'export const Telop = ({ segment ) => <div/>;');
    const result = await loadOverlayComponentsForPlanner(dir);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('bundle-failed');
  });

  it('評価時 throw は evaluate-failed', async () => {
    const dir = makeProjectCopy('evaluate');
    writeTelop(dir, ["throw new Error('boom');", 'export const Telop = () => null;'].join('\n'));
    const result = await loadOverlayComponentsForPlanner(dir);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('evaluate-failed');
    expect(result.message).toContain('boom');
  });

  it('未登録のサブパス（react-dom/server）は require シムが弾く＝バンドルに巻き込まない', async () => {
    const dir = makeProjectCopy('unknown-specifier');
    writeTelop(
      dir,
      [
        "import { renderToStaticMarkup } from 'react-dom/server';",
        'export const Telop = () => <div>{String(renderToStaticMarkup)}</div>;',
      ].join('\n'),
    );
    const result = await loadOverlayComponentsForPlanner(dir, { telop: true, image: false });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('evaluate-failed');
    expect(result.message).toContain('react-dom/server');
  });

  it('node builtins を使う部品は bundle-failed（撮影ページで動かないものを分類だけ通さない）', async () => {
    const dir = makeProjectCopy('node-builtin');
    writeTelop(
      dir,
      ["import { readFileSync } from 'node:fs';", 'export const Telop = () => <div>{String(readFileSync)}</div>;'].join('\n'),
    );
    const result = await loadOverlayComponentsForPlanner(dir, { telop: true, image: false });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('bundle-failed');
  });

  it('Telop export が無ければ missing-export', async () => {
    const dir = makeProjectCopy('no-export');
    writeTelop(dir, 'export const NotTelop = () => null;');
    const result = await loadOverlayComponentsForPlanner(dir);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('missing-export');
  });

  it('要らない部品は読み込まない（画像だけ要るプロジェクトで Telop.tsx が無くても ok）', async () => {
    const dir = makeProjectCopy('image-only');
    rmSync(join(dir, 'src', 'テロップテンプレート', 'Telop.tsx'));
    const result = await loadOverlayComponentsForPlanner(dir, { telop: false, image: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.components.Telop).toBeNull();
    expect(typeof result.components.InsertImage).toBe('function');
  });

  it('何も要らなければファイルを読まずに null 部品を返す', async () => {
    const dir = join(tmpRoot, 'nothing-at-all');
    mkdirSync(dir, { recursive: true });
    const result = await loadOverlayComponentsForPlanner(dir, { telop: false, image: false });
    expect(result).toEqual({ ok: true, components: { Telop: null, InsertImage: null } });
  });
});
