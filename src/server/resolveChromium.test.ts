/**
 * resolveChromiumBin のユニットテスト（M2d T1・resolveFfmpeg と同型の純関数）。
 *
 * #194: 恒等/単元素 fixture 禁止 — env / tools / playwright-cache の各経路は
 * 互いに異なる文字列パスを返す fake exists で pin する（同じパスだと「どの経路が
 * 実際にヒットしたか」を区別できない偽陽性になる）。
 */
import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CHROME_HEADLESS_SHELL_REVISION,
  CHROME_HEADLESS_SHELL_VERSION,
  chromeHeadlessShellToolsPath,
  headlessShellFromCachePath,
  resolveChromiumBin,
} from './resolveChromium';

const ENV_PATH = '/env/chrome-headless-shell';
/** I-3: tools パスは版セグメントを含む（期待値は定数から組む・手書きしない）。 */
const TOOLS_PATH = `/editor-root/tools/chrome-headless-shell/${CHROME_HEADLESS_SHELL_VERSION}/chrome-headless-shell-mac-arm64/chrome-headless-shell`;
/** C-1: playwright-core の executablePath() が返すのは**フル Chrome for Testing**。 */
const CACHE_FULL_CHROME_PATH =
  '/playwright-cache/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
/** そこから導出されるべき chrome-headless-shell 実体。 */
const CACHE_PATH = `/playwright-cache/chromium_headless_shell-${CHROME_HEADLESS_SHELL_REVISION}/chrome-headless-shell-mac-arm64/chrome-headless-shell`;

describe('resolveChromiumBin: 経路の優先順位（#194 非退化 fixture）', () => {
  it('(a) HARNESS_CHROMIUM が存在すれば env 経由で返す（tools/cache は見ない）', () => {
    const result = resolveChromiumBin({
      env: { HARNESS_CHROMIUM: ENV_PATH },
      platform: 'darwin',
      arch: 'arm64',
      editorRoot: '/editor-root',
      exists: (p) => p === ENV_PATH,
      defaultCachePath: () => CACHE_FULL_CHROME_PATH,
    });
    expect(result).toEqual({ ok: true, bin: ENV_PATH, source: 'env' });
  });

  it('(a) HARNESS_CHROMIUM が指定されているが不在なら env-path-missing で fail（黙って次に落ちない）', () => {
    const result = resolveChromiumBin({
      env: { HARNESS_CHROMIUM: ENV_PATH },
      platform: 'darwin',
      arch: 'arm64',
      editorRoot: '/editor-root',
      // tools/cache は存在するが env が優先されfailするべき
      exists: (p) => p === TOOLS_PATH,
      defaultCachePath: () => CACHE_FULL_CHROME_PATH,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('env-path-missing');
    expect(result.message).toMatch(/HARNESS_CHROMIUM/);
  });

  it('(b) tools/ 配下の実体があれば tools 経由で返す', () => {
    const result = resolveChromiumBin({
      env: {},
      platform: 'darwin',
      arch: 'arm64',
      editorRoot: '/editor-root',
      exists: (p) => p === TOOLS_PATH,
      defaultCachePath: () => CACHE_FULL_CHROME_PATH,
    });
    expect(result).toEqual({ ok: true, bin: TOOLS_PATH, source: 'tools' });
  });

  it('(c) tools/ に無く既定キャッシュがあれば playwright-cache 経由で返す', () => {
    const result = resolveChromiumBin({
      env: {},
      platform: 'darwin',
      arch: 'arm64',
      editorRoot: '/editor-root',
      exists: (p) => p === CACHE_PATH,
      defaultCachePath: () => CACHE_FULL_CHROME_PATH,
    });
    expect(result).toEqual({ ok: true, bin: CACHE_PATH, source: 'playwright-cache' });
  });

  it('全滅（env 未指定・tools 不在・cache null）は chromium-missing', () => {
    const result = resolveChromiumBin({
      env: {},
      platform: 'darwin',
      arch: 'arm64',
      editorRoot: '/editor-root',
      exists: () => false,
      defaultCachePath: () => null,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('chromium-missing');
  });

  it('全滅（cache 非 null だが exists が false）も chromium-missing', () => {
    const result = resolveChromiumBin({
      env: {},
      platform: 'darwin',
      arch: 'arm64',
      editorRoot: '/editor-root',
      exists: () => false,
      defaultCachePath: () => CACHE_FULL_CHROME_PATH,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('chromium-missing');
  });

  it('対応外の OS/CPU でも HARNESS_CHROMIUM が有効なら env が先に効く', () => {
    const result = resolveChromiumBin({
      env: { HARNESS_CHROMIUM: ENV_PATH },
      platform: 'linux',
      arch: 'x64',
      editorRoot: '/editor-root',
      exists: (p) => p === ENV_PATH,
      defaultCachePath: () => null,
    });
    expect(result).toEqual({ ok: true, bin: ENV_PATH, source: 'env' });
  });

  it('win32 では tools パスに .exe が付く（バックスラッシュ区切り・resolveFfmpeg と同じ手組み）', () => {
    const WIN_TOOLS_PATH = `C:\\editor-root\\tools\\chrome-headless-shell\\${CHROME_HEADLESS_SHELL_VERSION}\\chrome-headless-shell-win64\\chrome-headless-shell.exe`;
    const result = resolveChromiumBin({
      env: {},
      platform: 'win32',
      arch: 'x64',
      editorRoot: 'C:\\editor-root',
      exists: (p) => p === WIN_TOOLS_PATH,
      defaultCachePath: () => null,
    });
    expect(result).toEqual({ ok: true, bin: WIN_TOOLS_PATH, source: 'tools' });
  });

  it('editorRoot 省略時は process.cwd() 基準になる（resolveFfmpeg と同じ既定）', () => {
    const result = resolveChromiumBin({
      env: {},
      platform: 'darwin',
      arch: 'arm64',
      exists: (p) => p === chromeHeadlessShellToolsPath(process.cwd(), 'darwin', 'arm64'),
      defaultCachePath: () => null,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.source).toBe('tools');
    expect(result.bin).toBe(chromeHeadlessShellToolsPath(process.cwd(), 'darwin', 'arm64'));
  });
});

describe('chromeHeadlessShellToolsPath', () => {
  it('darwin arm64 は mac-arm64 フォルダを返す', () => {
    expect(chromeHeadlessShellToolsPath('/root', 'darwin', 'arm64')).toBe(
      `/root/tools/chrome-headless-shell/${CHROME_HEADLESS_SHELL_VERSION}/chrome-headless-shell-mac-arm64/chrome-headless-shell`,
    );
  });

  it('darwin x64 は mac-x64 フォルダを返す', () => {
    expect(chromeHeadlessShellToolsPath('/root', 'darwin', 'x64')).toBe(
      `/root/tools/chrome-headless-shell/${CHROME_HEADLESS_SHELL_VERSION}/chrome-headless-shell-mac-x64/chrome-headless-shell`,
    );
  });

  it('win32 x64 は win64 フォルダ + .exe をバックスラッシュ区切りで返す', () => {
    expect(chromeHeadlessShellToolsPath('C:\\root', 'win32', 'x64')).toBe(
      `C:\\root\\tools\\chrome-headless-shell\\${CHROME_HEADLESS_SHELL_VERSION}\\chrome-headless-shell-win64\\chrome-headless-shell.exe`,
    );
  });

  it('対応外構成は null を返す', () => {
    expect(chromeHeadlessShellToolsPath('/root', 'linux', 'x64')).toBeNull();
    expect(chromeHeadlessShellToolsPath('/root', 'win32', 'ia32')).toBeNull();
  });

  it('I-3: パスに版セグメントが含まれる（版を上げたら別パスになる）', () => {
    const path = chromeHeadlessShellToolsPath('/root', 'darwin', 'arm64');
    expect(path).toContain(`/${CHROME_HEADLESS_SHELL_VERSION}/`);
  });
});

describe('headlessShellFromCachePath（C-1: キャッシュ根の導出）', () => {
  it('フル Chrome のパスからキャッシュ根を割り出し headless shell を組む', () => {
    expect(
      headlessShellFromCachePath(
        '/Users/x/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
        'darwin',
        'arm64',
      ),
    ).toBe(
      `/Users/x/Library/Caches/ms-playwright/chromium_headless_shell-${CHROME_HEADLESS_SHELL_REVISION}/chrome-headless-shell-mac-arm64/chrome-headless-shell`,
    );
  });

  it('win32 はバックスラッシュ区切りを保ち .exe を付ける', () => {
    expect(
      headlessShellFromCachePath(
        'C:\\Users\\x\\AppData\\Local\\ms-playwright\\chromium-1223\\chrome-win\\chrome.exe',
        'win32',
        'x64',
      ),
    ).toBe(
      `C:\\Users\\x\\AppData\\Local\\ms-playwright\\chromium_headless_shell-${CHROME_HEADLESS_SHELL_REVISION}\\chrome-headless-shell-win64\\chrome-headless-shell.exe`,
    );
  });

  it('キャッシュ根を特定できない形状（chromium-<rev> セグメントが無い）は null', () => {
    expect(headlessShellFromCachePath('/somewhere/else/chrome', 'darwin', 'arm64')).toBeNull();
  });

  it('未登録の OS/CPU 構成は null', () => {
    expect(
      headlessShellFromCachePath('/cache/chromium-1223/chrome-linux/chrome', 'freebsd', 'x64'),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 修正ラウンド（opus レビュー C-1 / I-2 / M-2）の RED 先行テスト
// ---------------------------------------------------------------------------

/** 本機の playwright-core キャッシュが返す「フル Chrome for Testing」の実体パス形状。 */
const CACHE_FULL_CHROME =
  '/pw-cache/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
/** 上から導出されるべき chrome-headless-shell の実体パス（版セグメントは定数から組む）。 */
const CACHE_SHELL = `/pw-cache/chromium_headless_shell-${CHROME_HEADLESS_SHELL_REVISION}/chrome-headless-shell-mac-arm64/chrome-headless-shell`;

describe('C-1: 全経路の bin は chrome-headless-shell 実体で終わる', () => {
  const ENV_SHELL = '/env/chrome-headless-shell';
  const TOOLS_SHELL = chromeHeadlessShellToolsPath('/editor-root', 'darwin', 'arm64')!;

  it('(a) env 経路', () => {
    const r = resolveChromiumBin({
      env: { HARNESS_CHROMIUM: ENV_SHELL },
      platform: 'darwin',
      arch: 'arm64',
      editorRoot: '/editor-root',
      exists: (p) => p === ENV_SHELL,
      defaultCachePath: () => CACHE_FULL_CHROME,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.bin).toMatch(/chrome-headless-shell(\.exe)?$/);
  });

  it('(b) tools 経路', () => {
    const r = resolveChromiumBin({
      env: {},
      platform: 'darwin',
      arch: 'arm64',
      editorRoot: '/editor-root',
      exists: (p) => p === TOOLS_SHELL,
      defaultCachePath: () => CACHE_FULL_CHROME,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.source).toBe('tools');
    expect(r.bin).toMatch(/chrome-headless-shell(\.exe)?$/);
  });

  it('(c) playwright-cache 経路は executablePath() のフル Chrome ではなく headless shell を返す', () => {
    const r = resolveChromiumBin({
      env: {},
      platform: 'darwin',
      arch: 'arm64',
      editorRoot: '/editor-root',
      // フル Chrome も headless shell も両方存在する状況で headless shell を選ぶことを pin
      exists: (p) => p === CACHE_FULL_CHROME || p === CACHE_SHELL,
      defaultCachePath: () => CACHE_FULL_CHROME,
    });
    expect(r).toEqual({ ok: true, bin: CACHE_SHELL, source: 'playwright-cache' });
    expect(r.ok && r.bin).toMatch(/chrome-headless-shell(\.exe)?$/);
  });

  it('(c) headless shell が不在なら（フル Chrome があっても）chromium-missing', () => {
    const r = resolveChromiumBin({
      env: {},
      platform: 'darwin',
      arch: 'arm64',
      editorRoot: '/editor-root',
      exists: (p) => p === CACHE_FULL_CHROME,
      defaultCachePath: () => CACHE_FULL_CHROME,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.kind).toBe('chromium-missing');
  });
});

describe('I-2: unsupported-platform は (c) を先取りしない', () => {
  const LINUX_FULL_CHROME = '/pw-cache/chromium-1223/chrome-linux/chrome';
  const LINUX_SHELL = `/pw-cache/chromium_headless_shell-${CHROME_HEADLESS_SHELL_REVISION}/chrome-headless-shell-linux64/chrome-headless-shell`;

  it('linux + キャッシュあり → ok/playwright-cache（tools 非対応でも撮影できる）', () => {
    const r = resolveChromiumBin({
      env: {},
      platform: 'linux',
      arch: 'x64',
      editorRoot: '/editor-root',
      exists: (p) => p === LINUX_SHELL,
      defaultCachePath: () => LINUX_FULL_CHROME,
    });
    expect(r).toEqual({ ok: true, bin: LINUX_SHELL, source: 'playwright-cache' });
  });

  it('linux + キャッシュなし → unsupported-platform', () => {
    const r = resolveChromiumBin({
      env: {},
      platform: 'linux',
      arch: 'x64',
      editorRoot: '/editor-root',
      exists: () => false,
      defaultCachePath: () => null,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.kind).toBe('unsupported-platform');
  });
});

describe('M-2: ディレクトリは実体として採用しない（exists だけでは足りない）', () => {
  it('HARNESS_CHROMIUM が実在ディレクトリを指す場合は env-path-missing（既定の exists 実装で検査）', () => {
    const dir = tmpdir();
    const r = resolveChromiumBin({
      env: { HARNESS_CHROMIUM: dir },
      platform: 'darwin',
      arch: 'arm64',
      editorRoot: '/editor-root',
      // exists は注入しない = 既定実装（実ファイルシステム）で判定させる
      defaultCachePath: () => null,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.kind).toBe('env-path-missing');
  });

  it('存在する通常ファイルなら env 経路で採用される（陰性対照）', () => {
    const file = join(tmpdir(), `resolve-chromium-fixture-${process.pid}`);
    writeFileSync(file, '');
    try {
      const r = resolveChromiumBin({
        env: { HARNESS_CHROMIUM: file },
        platform: 'darwin',
        arch: 'arm64',
        editorRoot: '/editor-root',
        defaultCachePath: () => null,
      });
      expect(r).toEqual({ ok: true, bin: file, source: 'env' });
    } finally {
      rmSync(file, { force: true });
    }
  });
});
