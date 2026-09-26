// src/server/setupNodeGate.test.ts
/**
 * setup.command の Node 版ゲートと「Node が古い」判定を、**実際に bash で走らせて**検査する
 * （M2d 最終修正ラウンド2・M-1 / I-2）。
 *
 * これまで版ゲートの検査は静的 regex（toolchainPins.test.ts）だけだった。regex は
 * 「比較を書いているか」しか見ないので、比較演算子を `-lt` → `-gt` に取り違えても緑のままになる。
 * ここでは `node` / `ffmpeg` / `curl` を PATH の shim に差し替えて setup.command を実行し、
 * **20.19の下限前後と旧版/LTSで出る文言**を assert する（mp4boxの要件も満たす）。
 *
 * shim の設計:
 * - `node -v` … 指定した版を返す。ゲートの判定材料はこれだけ（npm / 撮影エンジンは env でスキップ）。
 * - `node <その他>` … **実物の Node が知らないオプションを渡されたときの出力を写す**
 *   （`node --bogus-option` の実測: stderr に `node: bad option: --bogus-option`・終了コード 9）。
 *   20.6 未満の Node に `--import` を渡したときの signature がこれ。
 * - `curl` … 常に失敗。版が古い枝は Node インストーラのダウンロードへ進むので、
 *   ネットワークに出ないよう塞ぐ（「配布情報を取得できませんでした」で止まる）。
 * - `ffmpeg` … 存在するだけでよい（検出で通り、ffmpeg の導入経路に入らない）。
 *
 * setup.command は cwd ではなく**自分の置き場所**を基準に動く（`cd "$(dirname "$0")"`）。
 * 一時ディレクトリへコピーして走らせることで、開発機の tools/ のログや実体に触らない。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** 実物の Node が未知のオプションを受けたときの stderr（`node --bogus-option` の実測を写す）。 */
const REAL_BAD_OPTION_STDERR = 'node: bad option: --import';
/** 同じく実測の終了コード。 */
const REAL_BAD_OPTION_EXIT = 9;

interface ShimOptions {
  /** `node -v` が返す文字列（例 'v20.5.1'）。 */
  version: string;
  /**
   * `node <その他の引数>` の挙動。
   * - 'bad-option' … 20.6 未満の Node の signature（stderr に bad option・exit 9）
   * - 'silent'     … 何も言わずに終わる（stdout も stderr も空・exit 1）
   */
  other: 'bad-option' | 'silent';
}

let work: string;

function writeExec(file: string, body: string): void {
  writeFileSync(file, body, { mode: 0o755 });
}

function makeShimDir(name: string, opts: ShimOptions): string {
  const bin = path.join(work, 'bin', name);
  mkdirSync(bin, { recursive: true });
  const other =
    opts.other === 'bad-option'
      ? `echo "${REAL_BAD_OPTION_STDERR}" >&2\nexit ${REAL_BAD_OPTION_EXIT}\n`
      : `exit 1\n`;
  writeExec(
    path.join(bin, 'node'),
    `#!/bin/sh\nif [ "$1" = "-v" ]; then echo "${opts.version}"; exit 0; fi\n${other}`,
  );
  writeExec(path.join(bin, 'ffmpeg'), '#!/bin/sh\nexit 0\n');
  writeExec(path.join(bin, 'curl'), '#!/bin/sh\nexit 1\n');
  return bin;
}

interface RunResult {
  status: number | null;
  out: string;
}

function runSetup(bin: string, env: Record<string, string>): RunResult {
  const res = spawnSync('bash', [path.join(work, 'setup.command')], {
    cwd: work,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PATH: `${bin}:/usr/bin:/bin`, ...env },
    timeout: 60_000,
  });
  return { status: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` };
}

beforeAll(() => {
  work = mkdtempSync(path.join(tmpdir(), 'he-setup-gate-'));
  copyFileSync(path.join(repoRoot, 'setup.command'), path.join(work, 'setup.command'));
});

afterAll(() => {
  if (work) rmSync(work, { recursive: true, force: true });
});

describe('setup.command の Node 版ゲート（M-1・実行して確かめる）', () => {
  const cases: Array<{ version: string; accepted: boolean }> = [
    { version: 'v18.20.0', accepted: false },
    { version: 'v20.5.1', accepted: false },
    { version: 'v20.6.0', accepted: false },
    { version: 'v20.8.1', accepted: false },
    { version: 'v20.9.0', accepted: false },
    { version: 'v20.18.9', accepted: false },
    { version: 'v20.19.0', accepted: true },
    { version: 'v24.18.1', accepted: true },
  ];

  for (const { version, accepted } of cases) {
    it(`${version} は ${accepted ? '通る' : '弾かれる'}`, () => {
      const bin = makeShimDir(`gate-${version}`, { version, other: 'silent' });
      const { out } = runSetup(bin, { HE_SETUP_SKIP_NPM: '1', HE_SETUP_SKIP_CHROMIUM: '1' });
      if (accepted) {
        expect(out, `${version} が版ゲートで弾かれた`).toContain(`✅ Node.js: ${version}`);
        expect(out, `${version} なのに「古い」と案内された`).not.toContain('以上が必要です');
      } else {
        expect(out, `${version} が版ゲートを素通りした`).toContain('20.19 以上が必要です');
        expect(out, `${version} なのに ✅ が出た`).not.toContain('✅ Node.js:');
      }
    });
  }
});

describe('install_chromium の「Node が古い」判定（I-2・実物の signature で発火する）', () => {
  it('stderr が実物の bad option signature なら Node 版の案内を出す', () => {
    const bin = makeShimDir('sig-bad-option', { version: 'v24.18.1', other: 'bad-option' });
    const { out } = runSetup(bin, { HE_SETUP_SKIP_NPM: '1' });
    expect(out, '実物の signature で Node 版の枝が発火しない').toContain(
      'Node.js の版が古い可能性があります',
    );
    expect(out).toContain('node -v');
  });

  it('stderr が空（原因不明）のときは Node 版だと断定しない', () => {
    const bin = makeShimDir('sig-silent', { version: 'v24.18.1', other: 'silent' });
    const { out } = runSetup(bin, { HE_SETUP_SKIP_NPM: '1' });
    expect(out, '原因不明なのに Node 版が古いと断定している').not.toContain(
      'Node.js の版が古い可能性があります',
    );
    expect(out, '導入準備の失敗自体は伝えるべき').toContain('撮影エンジンの導入準備ができていません');
    expect(out, 'ログの案内が無いと利用者が原因を追えない').toContain('chromium-setup.log');
  });
});
