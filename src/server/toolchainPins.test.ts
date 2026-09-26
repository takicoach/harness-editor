/**
 * playwright-core / @playwright/test の版一致 pin（M2d 設計判断3・受入D）。
 *
 * 期待値を手書きせず、現物同士（package.json・node_modules 実体）を突き合わせる。
 * - package.json の dependencies['playwright-core'] が exact（^/~ 無し）
 * - dependencies['playwright-core'] と devDependencies['@playwright/test'] の
 *   解決版（node_modules 実体の version）が一致
 * - node_modules/playwright-core/browsers.json の chromium-headless-shell の
 *   browserVersion/revision が resolveChromium.ts の定数と一致
 *   （T4 の setup スクリプトも同じ定数を参照する前提）
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHROME_HEADLESS_SHELL_REVISION, CHROME_HEADLESS_SHELL_VERSION } from './resolveChromium';

const ROOT = join(import.meta.dirname, '..', '..');

function readJson(relPath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(ROOT, relPath), 'utf8')) as Record<string, unknown>;
}

describe('toolchainPins: playwright-core / @playwright/test 版一致（設計判断3）', () => {
  it('package.json の dependencies.playwright-core が exact 版である（^/~ 無し）', () => {
    const pkg = readJson('package.json') as { dependencies?: Record<string, string> };
    const spec = pkg.dependencies?.['playwright-core'];
    expect(spec).toBeDefined();
    expect(spec).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('playwright-core と @playwright/test の解決版（node_modules 実体）が一致する', () => {
    const playwrightCorePkg = readJson('node_modules/playwright-core/package.json') as { version: string };
    const playwrightTestPkg = readJson('node_modules/@playwright/test/package.json') as { version: string };
    expect(playwrightCorePkg.version).toBe(playwrightTestPkg.version);
  });

  it('node_modules/playwright-core/browsers.json の chromium-headless-shell が resolveChromium.ts の定数と一致する', () => {
    const browsers = readJson('node_modules/playwright-core/browsers.json') as {
      browsers: Array<{ name: string; browserVersion: string; revision: string }>;
    };
    const entry = browsers.browsers.find((b) => b.name === 'chromium-headless-shell');
    expect(entry).toBeDefined();
    expect(entry?.browserVersion).toBe(CHROME_HEADLESS_SHELL_VERSION);
    expect(entry?.revision).toBe(CHROME_HEADLESS_SHELL_REVISION);
  });
});

/**
 * setup スクリプト（macOS / Windows）の撮影エンジン取得ピン（M2d T4・設計判断2）。
 *
 * setup スクリプトは resolveChromium.ts を import できない（bash / batch）ため、
 * 版と SHA-256 をスクリプト内の定数として持つ。ここでその**現物**を読み、
 * resolveChromium.ts の正本定数と機械的に突き合わせる（版上げ時の片肺更新を検出する）。
 *
 * 逆方向 pin: 配置先パスの規約（`tools/chrome-headless-shell/<版>/chrome-headless-shell-<platform>`）
 * は `scripts/chromium-health.ts --print-tools-path` の出力だけが持つ。
 * 配布物の platform 名（mac-arm64 / mac-x64 / win64）の決め方は
 * `scripts/chromium-health.ts --print-download-platform` の出力だけが持つ（I-5）。
 * setup スクリプト側に同じ規約のリテラル・同じ CPU 分岐が現れていないことを検査して、
 * 二重化を防ぐ。
 */
function readText(relPath: string): string {
  return readFileSync(join(ROOT, relPath), 'utf8');
}

function extractShellConst(source: string, name: string): string | null {
  const match = source.match(new RegExp(`^${name}="([^"]*)"`, 'm'));
  return match?.[1] ?? null;
}

function extractBatchConst(source: string, name: string): string | null {
  const match = source.match(new RegExp(`^set "${name}=([^"]*)"`, 'm'));
  return match?.[1] ?? null;
}

/**
 * I-2: SHA-256 定数に併記された版（`for <版>`）を取り出す。
 * 定数と同じ行の行末コメント、またはその直前のコメント行のどちらでもよい。
 * 「版だけ上げて SHA を据え置く」片肺更新を検出するための併記なので、
 * 併記が無い（null）のも失敗として扱う。
 */
function extractPinnedVersion(source: string, constLinePattern: RegExp): string | null {
  const lines = source.split('\n');
  const index = lines.findIndex((line) => constLinePattern.test(line));
  if (index < 0) return null;
  for (const line of [lines[index] ?? '', index > 0 ? (lines[index - 1] ?? '') : '']) {
    const match = line.match(/\bfor\s+(\d+\.\d+\.\d+\.\d+)\b/);
    if (match?.[1]) return match[1];
  }
  return null;
}

/**
 * 行まるごとのコメント（shell の `#` / batch の `::`・`rem`）を落とす。
 * 「CPU 判定をここに書かない」という規約の検査対象は実行される行だけで、
 * その規約自体を説明するコメントに反応してはいけない。
 */
function stripFullLineComments(body: string): string {
  return body
    .split('\n')
    .filter((line) => !/^\s*(?:#|::|rem\s)/i.test(line))
    .join('\n');
}

/** `name() {` から、桁 0 の `}` までのシェル関数本体を切り出す。 */
function extractShellFunction(source: string, name: string): string {
  const lines = source.split('\n');
  const start = lines.findIndex((line) => line.startsWith(`${name}() {`));
  if (start < 0) throw new Error(`setup.command に ${name}() が見つからない`);
  const end = lines.findIndex((line, i) => i > start && line === '}');
  if (end < 0) throw new Error(`${name}() の終端 } が見つからない`);
  return lines.slice(start, end + 1).join('\n');
}

/** `:label` から次の `:label`（`::` コメントは除く）までの batch サブルーチン本体を切り出す。 */
function extractBatchLabel(source: string, label: string): string {
  const lines = source.split('\n');
  const start = lines.findIndex((line) => line.trim() === `:${label}`);
  if (start < 0) throw new Error(`setup.bat に :${label} が見つからない`);
  const end = lines.findIndex((line, i) => i > start && /^:[a-zA-Z_]/.test(line.trim()));
  return lines.slice(start, end < 0 ? undefined : end).join('\n');
}

describe('toolchainPins: setup スクリプトの撮影エンジン定数（M2d T4）', () => {
  it('setup.command の CHROMIUM_VERSION が resolveChromium.ts の正本定数と一致する', () => {
    expect(extractShellConst(readText('setup.command'), 'CHROMIUM_VERSION')).toBe(CHROME_HEADLESS_SHELL_VERSION);
  });

  it('setup.bat の CHROMIUM_VERSION が resolveChromium.ts の正本定数と一致する', () => {
    expect(extractBatchConst(readText('setup.bat'), 'CHROMIUM_VERSION')).toBe(CHROME_HEADLESS_SHELL_VERSION);
  });

  it('3 プラットフォーム分の SHA-256 が 64 桁の 16 進で、互いに異なる（形式検査のみ）', () => {
    const command = readText('setup.command');
    const bat = readText('setup.bat');
    const hashes = {
      'mac-arm64': extractShellConst(command, 'CHROMIUM_SHA256_MAC_ARM64'),
      'mac-x64': extractShellConst(command, 'CHROMIUM_SHA256_MAC_X64'),
      win64: extractBatchConst(bat, 'CHROMIUM_SHA256_WIN64'),
    };
    for (const [platform, hash] of Object.entries(hashes)) {
      expect(hash, `${platform} の SHA-256 定数が見つからない`).toBeTruthy();
      expect(hash, `${platform} の SHA-256 が 64 桁 16 進でない`).toMatch(/^[0-9a-f]{64}$/);
    }
    const values = Object.values(hashes);
    expect(new Set(values).size, 'プラットフォーム間で SHA-256 が重複している').toBe(values.length);
  });

  it('setup スクリプトが tools/ の配置規約リテラルを持たない（health の --print-tools-path に一本化）', () => {
    for (const relPath of ['setup.command', 'setup.bat']) {
      const source = readText(relPath);
      expect(source, `${relPath} に配置先ディレクトリ名のリテラルがある`).not.toMatch(
        /chrome-headless-shell-(?:mac|win|linux)/,
      );
      expect(source, `${relPath} に tools 配下のパス規約リテラルがある`).not.toMatch(
        /tools[\\/]chrome-headless-shell/,
      );
    }
  });

  // ---- I-2: 版と SHA-256 を縛る（版だけ上げると赤くなる）----
  it('SHA-256 定数に併記された版が CHROMIUM_VERSION（= 正本定数）と一致する（I-2）', () => {
    const command = readText('setup.command');
    const bat = readText('setup.bat');
    const pinned = {
      'setup.command CHROMIUM_SHA256_MAC_ARM64': extractPinnedVersion(command, /^CHROMIUM_SHA256_MAC_ARM64=/),
      'setup.command CHROMIUM_SHA256_MAC_X64': extractPinnedVersion(command, /^CHROMIUM_SHA256_MAC_X64=/),
      'setup.bat CHROMIUM_SHA256_WIN64': extractPinnedVersion(bat, /^set "CHROMIUM_SHA256_WIN64=/),
    };
    for (const [label, version] of Object.entries(pinned)) {
      expect(version, `${label} に版の併記（for <版>）が無い`).not.toBeNull();
      expect(version, `${label} の併記版が正本定数とずれている`).toBe(CHROME_HEADLESS_SHELL_VERSION);
    }
  });

  // ---- I-5: platform の正本を 1 つに（health の --print-download-platform）----
  // 「uname が無い」だけでは、正本を**呼んでいる**ことの検査にならない
  // （分岐を消して platform を決め打ちしても緑になってしまう）。呼び出しの実在も見る。
  it('setup スクリプトが --print-download-platform を実際に呼んでいる（I-5）', () => {
    for (const relPath of ['setup.command', 'setup.bat']) {
      expect(
        stripFullLineComments(readText(relPath)),
        `${relPath} が --print-download-platform を呼んでいない`,
      ).toMatch(/chromium-health\.ts --print-download-platform/);
    }
  });

  it('setup.command の chromium 系関数が uname で CPU 分岐していない（I-5）', () => {
    const source = readText('setup.command');
    const fnNames = [...source.matchAll(/^([a-z_]*chromium[a-z_]*)\(\) \{/gm)].map((m) => m[1] ?? '');
    expect(fnNames.length, 'chromium 系のシェル関数が見つからない').toBeGreaterThan(3);
    for (const name of fnNames) {
      expect(
        stripFullLineComments(extractShellFunction(source, name)),
        `${name}() が uname で CPU 分岐している`,
      ).not.toMatch(/uname/);
    }
  });

  it('setup.bat の :install_chromium が PROCESSOR_ARCHITECTURE で CPU 分岐していない（I-5）', () => {
    const body = stripFullLineComments(extractBatchLabel(readText('setup.bat'), 'install_chromium'));
    expect(body, ':install_chromium が PROCESSOR_ARCHITECTURE で CPU 分岐している').not.toMatch(
      /PROCESSOR_ARCHITECTURE/,
    );
  });

  // ---- I-4: URL / SHA の選択が platform から**実際に導かれている**ことを見る ----
  // 「uname が無い」「--print-download-platform を呼んでいる」だけでは、URL や SHA を
  // platform と無関係に決め打ちする変異（例: chromium_sha256() { echo "$CHROMIUM_SHA256_MAC_ARM64"; }）
  // が緑のまま通ってしまう。関数本体のデータフロー（platform を受け取り、それを使って
  // 組み立てている）を検査する。
  it('setup.command の chromium_url / chromium_mirror_url が platform から URL を組み立てる（I-4）', () => {
    const source = readText('setup.command');
    for (const [name, baseConst] of [
      ['chromium_url', 'CHROMIUM_BASE'],
      ['chromium_mirror_url', 'CHROMIUM_MIRROR_BASE'],
    ] as const) {
      const body = stripFullLineComments(extractShellFunction(source, name));
      expect(body, `${name}() が platform を受け取っていない（引数 or chromium_platform）`).toMatch(
        /platform="\$\{?1\}?"|platform="\$\(chromium_platform\)"/,
      );
      // 組み立てた URL に platform が 2 回（ディレクトリ名とファイル名）現れる
      const echoLine = body.split('\n').find((line) => line.includes(baseConst)) ?? '';
      expect(echoLine, `${name}() が ${baseConst} を使っていない`).toContain(baseConst);
      expect(echoLine, `${name}() の URL が CHROMIUM_VERSION を使っていない`).toContain('CHROMIUM_VERSION');
      expect(
        (echoLine.match(/\$\{?platform\}?/g) ?? []).length,
        `${name}() の URL が platform から組み立てられていない`,
      ).toBeGreaterThanOrEqual(2);
    }
  });

  it('setup.command の chromium_sha256 が platform で case 分岐して定数を選ぶ（I-4）', () => {
    const body = stripFullLineComments(extractShellFunction(readText('setup.command'), 'chromium_sha256'));
    expect(body, 'chromium_sha256() が platform を受け取っていない').toMatch(
      /platform="\$\{?1\}?"|platform="\$\(chromium_platform\)"/,
    );
    expect(body, 'chromium_sha256() が platform で case 分岐していない').toMatch(/case\s+"\$\{?platform\}?"\s+in/);
    const branches = body.match(/\$\{?CHROMIUM_SHA256_[A-Z0-9_]+\}?/g) ?? [];
    expect(new Set(branches).size, 'chromium_sha256() が SHA 定数を 1 つに決め打ちしている').toBeGreaterThanOrEqual(2);
  });

  it('setup.bat が CHROMIUM_PLATFORM から URL を組み立て、SHA 選択を win64 で門番している（I-4）', () => {
    const body = stripFullLineComments(extractBatchLabel(readText('setup.bat'), 'install_chromium'));
    const urlLine = body.split('\n').find((line) => line.includes('storage.googleapis.com')) ?? '';
    expect(urlLine, 'ダウンロード URL の組み立て行が見つからない').toContain('storage.googleapis.com');
    expect(urlLine, 'URL 組み立てが CHROMIUM_PLATFORM を参照していない').toMatch(/\$p\s*=\s*\$env:CHROMIUM_PLATFORM/);
    expect(
      (urlLine.match(/\+\s*\$p\s*\+/g) ?? []).length,
      'URL が platform から組み立てられていない',
    ).toBeGreaterThanOrEqual(2);
    expect(urlLine, 'URL が CHROMIUM_VERSION を参照していない').toContain('$env:CHROMIUM_VERSION');

    // win64 用の SHA 定数を使ってよいのは、platform が win64 だと確かめた後だけ
    const gateIndex = body.search(/CHROMIUM_PLATFORM%"=="win64"/);
    const shaIndex = body.search(/\$env:CHROMIUM_SHA256_WIN64/);
    expect(gateIndex, 'CHROMIUM_PLATFORM を win64 と突き合わせる門番が無い').toBeGreaterThanOrEqual(0);
    expect(shaIndex, 'win64 の SHA 定数を使っていない').toBeGreaterThanOrEqual(0);
    expect(gateIndex, 'SHA 定数の使用が win64 の門番より前にある').toBeLessThan(shaIndex);
  });
});

/**
 * I-6: 現物突合の結果を台帳に残し、既定ゲートに載せる。
 *
 * opt-in の現物突合（HARNESS_VERIFY_CHROMIUM_SHA=1）は 100MB×3 の取得を伴うため
 * 既定では回せない。そこで「実物と一致したことを確かめた版とハッシュ」を
 * `src/server/chromium-sha-verified.json` に記録し（書くのは opt-in が全件一致した後だけ）、
 * 既定テストで setup の現物定数と突き合わせる。
 * 版や SHA を書き換えると台帳とずれて赤 → opt-in を通すと台帳が更新されて緑、になる。
 */
const LEDGER_PATH = 'src/server/chromium-sha-verified.json';

type ShaLedger = {
  version: string;
  /** primary（Google 公式バケット）の実測ハッシュ。 */
  sha256: Record<string, string>;
  /** mirror（Playwright CDN）の実測ハッシュ（I-2・退避経路も現物突合する）。 */
  mirrorSha256?: Record<string, string>;
  verifiedAt?: string;
  source?: string;
  mirror?: string;
};

function readLedger(): ShaLedger {
  return JSON.parse(readText(LEDGER_PATH)) as ShaLedger;
}

function setupShaConstants(): Record<string, string | null> {
  const command = readText('setup.command');
  const bat = readText('setup.bat');
  return {
    'mac-arm64': extractShellConst(command, 'CHROMIUM_SHA256_MAC_ARM64'),
    'mac-x64': extractShellConst(command, 'CHROMIUM_SHA256_MAC_X64'),
    win64: extractBatchConst(bat, 'CHROMIUM_SHA256_WIN64'),
  };
}

/**
 * I-1: setup スクリプトの Node 版ゲート下限（20.6 以上）。
 *
 * setup も health も `node --import tsx …` を使う。`--import` は **Node 20.6 で入った**ので、
 * ゲートを major だけで見る（`major >= 20`）と 20.0〜20.5 が素通りし、撮影エンジンの導入だけが
 * 永久に失敗して案内は別原因（部品の導入が未完了）を指す。下限の定数をスクリプトの**現物**から
 * 読み、`--import` を使う限り床が 20.6 未満へ下がらないことを機械で止める。
 */
const NODE_FLOOR = { major: 20, minor: 6 } as const;

function setupNodeFloor(): Array<{ label: string; major: number; minor: number }> {
  const command = readText('setup.command');
  const bat = readText('setup.bat');
  const read = (label: string, majorRaw: string | null, minorRaw: string | null) => {
    expect(majorRaw, `${label} に NODE_MIN_MAJOR 定数が無い`).toBeTruthy();
    expect(minorRaw, `${label} に NODE_MIN_MINOR 定数が無い`).toBeTruthy();
    return { label, major: Number(majorRaw), minor: Number(minorRaw) };
  };
  return [
    read(
      'setup.command',
      extractShellConst(command, 'NODE_MIN_MAJOR'),
      extractShellConst(command, 'NODE_MIN_MINOR'),
    ),
    read('setup.bat', extractBatchConst(bat, 'NODE_MIN_MAJOR'), extractBatchConst(bat, 'NODE_MIN_MINOR')),
  ];
}

describe('toolchainPins: setup の Node 版ゲート下限（I-1）', () => {
  it('setup 両 OS の下限が 20.6 以上である（node --import が要る限り下げられない）', () => {
    for (const { label, major, minor } of setupNodeFloor()) {
      const atLeast = major > NODE_FLOOR.major || (major === NODE_FLOOR.major && minor >= NODE_FLOOR.minor);
      expect(
        atLeast,
        `${label} の Node 版ゲート下限が ${major}.${minor} で 20.6 未満（node --import は 20.6 以上が要る）`,
      ).toBe(true);
    }
  });

  it('setup 両 OS が minor まで見て分岐している（major だけの比較に戻すと赤）', () => {
    const command = readText('setup.command');
    const bat = readText('setup.bat');
    expect(
      stripFullLineComments(command),
      'setup.command が NODE_MINOR を使った境界比較をしていない',
    ).toMatch(/NODE_MAJOR.*NODE_MIN_MAJOR[\s\S]{0,200}NODE_MINOR.*NODE_MIN_MINOR/);
    expect(stripFullLineComments(bat), 'setup.bat が NODE_MINOR を使った境界比較をしていない').toMatch(
      /NODE_MAJOR!? *(?:LSS|EQU) *%NODE_MIN_MAJOR%[\s\S]{0,200}NODE_MINOR!? *LSS *%NODE_MIN_MINOR%/,
    );
  });

  /**
   * I-1（ラウンド2）: setup.bat の版ゲートが `node -v` の失敗で **fail-open** しないこと。
   *
   * `for /f … in ('node -v')` は node が何も出さなければ本体を 1 度も回さない。
   * `NODE_MAJOR` を先に空へ置いていないと、前回実行の環境変数や想定外の書式がそのまま
   * 比較に使われ、古い Node でも「[OK] Node.js」で素通りしうる。
   * mac 側は `case "$NODE_MAJOR$NODE_MINOR" in '' | *[!0-9]*)` で同じ穴を塞いでいる。
   * bat は実機（pwsh/cmd）で回せないので、ここは静的な現物検査で pin する。
   */
  it('setup.bat の版ゲートが未取得・非数字で fail-open しない（I-1）', () => {
    const bat = stripFullLineComments(readText('setup.bat'));
    expect(bat, 'setup.bat が NODE_MAJOR を空に初期化していない（前の値が残ると素通りする）').toMatch(
      /set "NODE_MAJOR="[\s\S]{0,400}for \/f[^\n]*node -v/,
    );
    expect(bat, 'setup.bat が NODE_MAJOR 未取得のときにインストーラ経路へ落としていない').toMatch(
      /if not defined NODE_MAJOR goto node_install/,
    );
    expect(bat, 'setup.bat が数字以外の版表記を弾いていない（findstr の数字検査が無い）').toMatch(
      /findstr \/r [^\n]*\^\[0-9\]\[0-9\]\*\$/,
    );
  });

  it('package.json の engines.node が同じ下限を宣言している', () => {
    const pkg = readJson('package.json') as { engines?: Record<string, string> };
    const spec = pkg.engines?.['node'];
    expect(spec, 'package.json に engines.node が無い').toBeTruthy();
    const match = /^>=\s*(\d+)\.(\d+)/.exec(spec ?? '');
    expect(match, `engines.node（${spec}）が ">=<major>.<minor>" 形式でない`).not.toBeNull();
    const major = Number(match?.[1]);
    const minor = Number(match?.[2]);
    expect(
      major > NODE_FLOOR.major || (major === NODE_FLOOR.major && minor >= NODE_FLOOR.minor),
      `engines.node（${spec}）が 20.6 未満`,
    ).toBe(true);
    for (const floor of setupNodeFloor()) {
      expect(`${major}.${minor}`, `engines.node と ${floor.label} の下限がずれている`).toBe(
        `${floor.major}.${floor.minor}`,
      );
    }
  });
});

describe('toolchainPins: 現物突合の台帳（I-6・既定ゲート）', () => {
  it('台帳の版と SHA-256 が正本定数・setup の現物定数と一致する', () => {
    const ledger = readLedger();
    expect(
      ledger.version,
      `${LEDGER_PATH} の版が正本定数とずれている（版を上げたら HARNESS_VERIFY_CHROMIUM_SHA=1 で台帳を更新する）`,
    ).toBe(CHROME_HEADLESS_SHELL_VERSION);
    const constants = setupShaConstants();
    expect(Object.keys(ledger.sha256).sort(), '台帳の platform 集合が setup の定数と一致しない').toEqual(
      Object.keys(constants).sort(),
    );
    for (const [platform, want] of Object.entries(constants)) {
      expect(
        ledger.sha256[platform],
        `${platform}: setup の SHA-256 が台帳（配布元の現物と突き合わせ済み）とずれている`,
      ).toBe(want);
    }
  });

  // ---- M-1: 台帳の手編集耐性（最低線）----
  // 台帳は opt-in が書くファイルだが、手で書き換えれば既定ゲートは通ってしまう。
  // 「どこの現物と突き合わせたか（source / mirror）」「いつ突き合わせたか（verifiedAt）」を
  // setup の現物定数・ISO 形式と機械照合して、出所不明の台帳を素通りさせない。
  it('台帳の source / mirror が setup の配布元定数と一致する（M-1）', () => {
    const ledger = readLedger();
    const command = readText('setup.command');
    expect(ledger.source, '台帳の source が setup.command の CHROMIUM_BASE とずれている').toBe(
      extractShellConst(command, 'CHROMIUM_BASE'),
    );
    expect(ledger.mirror, '台帳の mirror が setup.command の CHROMIUM_MIRROR_BASE とずれている').toBe(
      extractShellConst(command, 'CHROMIUM_MIRROR_BASE'),
    );
  });

  it('台帳の verifiedAt が存在し ISO の日付形式である（M-1）', () => {
    const ledger = readLedger();
    expect(ledger.verifiedAt, '台帳に verifiedAt が無い').toBeTruthy();
    expect(ledger.verifiedAt, '台帳の verifiedAt が ISO 形式（YYYY-MM-DD）でない').toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(
      Number.isNaN(Date.parse(`${ledger.verifiedAt}T00:00:00Z`)),
      `台帳の verifiedAt（${ledger.verifiedAt}）が実在しない日付`,
    ).toBe(false);
    // M-2: 未来日は「まだ突き合わせていない」ことの証拠。手で書いた台帳が
    // 「検証済み」を名乗るのを、機械で読める形で1つ止める（時計ずれの余地として翌日まで許す）。
    const stamped = Date.parse(`${ledger.verifiedAt}T00:00:00Z`);
    const tomorrow = Date.now() + 24 * 60 * 60 * 1000;
    expect(
      stamped <= tomorrow,
      `台帳の verifiedAt（${ledger.verifiedAt}）が未来日＝現物と突き合わせた記録になっていない`,
    ).toBe(true);
  });

  // ---- I-2: 退避経路（mirror）の SHA も台帳に残っていること ----
  it('台帳に mirror 側の実測ハッシュがあり primary と一致している（I-2）', () => {
    const ledger = readLedger();
    expect(ledger.mirrorSha256, '台帳に mirrorSha256 が無い（退避経路が未検証）').toBeTruthy();
    expect(Object.keys(ledger.mirrorSha256 ?? {}).sort(), 'mirror の platform 集合が primary と一致しない').toEqual(
      Object.keys(ledger.sha256).sort(),
    );
    for (const [platform, want] of Object.entries(ledger.sha256)) {
      expect(
        ledger.mirrorSha256?.[platform],
        `${platform}: mirror の実測ハッシュが primary とずれている（退避経路が別物）`,
      ).toBe(want);
    }
  });
});

/**
 * I-1: 配布元の現物と SHA-256 定数の突合（opt-in）。
 *
 * 定数どうしの形式検査では「別プラットフォームのハッシュを貼った」取り違えを検出できない。
 * 版を上げるときは `HARNESS_VERIFY_CHROMIUM_SHA=1` を付けてこのテストを回し、
 * 実際に配布元から zip を取得して突き合わせる（100MB×3・数分かかるため既定ではスキップ）。
 */
const VERIFY_CHROMIUM_SHA = process.env.HARNESS_VERIFY_CHROMIUM_SHA === '1';

describe('toolchainPins: 撮影エンジン zip の現物突合（opt-in・HARNESS_VERIFY_CHROMIUM_SHA=1）', () => {
  it.runIf(VERIFY_CHROMIUM_SHA)(
    '3 プラットフォームの zip を primary / mirror の両ホストから取得して SHA-256 が定数と一致する（I-1・I-2）',
    async () => {
      const command = readText('setup.command');
      const bat = readText('setup.bat');
      const base = extractShellConst(command, 'CHROMIUM_BASE');
      const mirrorBase = extractShellConst(command, 'CHROMIUM_MIRROR_BASE');
      const version = extractShellConst(command, 'CHROMIUM_VERSION');
      expect(base).toBeTruthy();
      expect(mirrorBase).toBeTruthy();
      expect(version).toBe(CHROME_HEADLESS_SHELL_VERSION);

      const expected: Record<string, string | null> = {
        'mac-arm64': extractShellConst(command, 'CHROMIUM_SHA256_MAC_ARM64'),
        'mac-x64': extractShellConst(command, 'CHROMIUM_SHA256_MAC_X64'),
        win64: extractBatchConst(bat, 'CHROMIUM_SHA256_WIN64'),
      };

      const digestOf = async (url: string, label: string): Promise<string> => {
        const res = await fetch(url);
        expect(res.ok, `${label}: ${url} の取得に失敗（${res.status}）`).toBe(true);
        return createHash('sha256').update(Buffer.from(await res.arrayBuffer())).digest('hex');
      };

      const verified: Record<string, string> = {};
      const verifiedMirror: Record<string, string> = {};
      for (const [platform, want] of Object.entries(expected)) {
        const name = `chrome-headless-shell-${platform}.zip`;
        // I-2: setup は本家が落ちたときに退避 URL を使う。退避経路で落ちてくる中身が
        // 定数と同じであることを実際に取得して確かめる（退避先だけ別物になる経路を塞ぐ）。
        const actual = await digestOf(`${base}/${version}/${platform}/${name}`, `${platform} primary`);
        expect(actual, `${platform} の SHA-256（primary）が定数と一致しない`).toBe(want);
        const mirrorActual = await digestOf(
          `${mirrorBase}/${version}/${platform}/${name}`,
          `${platform} mirror`,
        );
        expect(mirrorActual, `${platform} の SHA-256（mirror）が primary/定数と一致しない`).toBe(want);
        process.stdout.write(`VERIFY ${platform} primary ${actual}\n`);
        process.stdout.write(`VERIFY ${platform} mirror ${mirrorActual}\n`);
        verified[platform] = actual;
        verifiedMirror[platform] = mirrorActual;
      }

      // I-6: 全件一致した**後だけ**台帳を書く（既定ゲートはこの台帳と setup の定数を突き合わせる）。
      // 途中で 1 件でも食い違えば上の expect で落ちてここへ来ない＝未検証のハッシュが台帳に載らない。
      const ledger = {
        version: CHROME_HEADLESS_SHELL_VERSION,
        source: base,
        mirror: mirrorBase,
        verifiedAt: new Date().toISOString().slice(0, 10),
        sha256: verified,
        mirrorSha256: verifiedMirror,
      };
      writeFileSync(join(ROOT, LEDGER_PATH), `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');
      process.stdout.write(`VERIFY ledger-written ${LEDGER_PATH}\n`);
    },
    1_800_000,
  );
});
