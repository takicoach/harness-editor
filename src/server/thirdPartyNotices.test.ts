/**
 * I-2: THIRD_PARTY_NOTICES.md の台帳突合テスト。
 * package.json の dependencies キー集合を正本とし、各キー名が
 * THIRD_PARTY_NOTICES.md 本文（リテラル文字列として）に出現することを検査する
 * （期待集合を手書きしない）。
 *
 * リテラル一致しないキーは ALLOWLIST で吸収する。ALLOWLIST に載せてよいのは
 * 「Notices の対象になりうるが本ファイルには別名/別セクションで既に説明が
 * 足りている、または本ファイルの対象範囲（改変・同梱・特殊ライセンス条件の記録）
 * に該当しない」場合のみで、必ず reason を書く。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');

/**
 * リテラル一致しない依存キーの許容表（reason 必須）。
 * - @modelcontextprotocol/sdk・react・react-dom・esbuild: MIT の標準的な
 *   ランタイム/ビルド依存で、改変なし・as-is npm 経由。本ファイルは「改変を伴う
 *   採用」「同梱」「特殊ライセンス」など注意を要する依存の記録が主眼であり、
 *   無改変 MIT の一般的なフレームワーク/ツールチェーン依存の網羅台帳ではない。
 */
const ALLOWLIST: Record<string, string> = {
  '@modelcontextprotocol/sdk': 'MIT・無改変・as-is npm 経由の標準ランタイム依存（Notices の対象は改変/同梱/特殊ライセンスが主眼）',
  'react': 'MIT・無改変・as-is npm 経由の標準ランタイム依存（Notices の対象は改変/同梱/特殊ライセンスが主眼）',
  'react-dom': 'MIT・無改変・as-is npm 経由の標準ランタイム依存（Notices の対象は改変/同梱/特殊ライセンスが主眼）',
  'esbuild': 'MIT・無改変・as-is npm 経由の標準ビルドツール依存（Notices の対象は改変/同梱/特殊ライセンスが主眼）',
};

describe('THIRD_PARTY_NOTICES.md 台帳突合', () => {
  it('package.json の全 dependencies キーが本文に出現するか、理由つき ALLOWLIST に載っている', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    const notices = readFileSync(join(ROOT, 'THIRD_PARTY_NOTICES.md'), 'utf8');
    const depKeys = Object.keys(pkg.dependencies ?? {});
    expect(depKeys.length).toBeGreaterThan(0);

    const missing = depKeys.filter((key) => !notices.includes(key) && !(key in ALLOWLIST));
    expect(missing, `THIRD_PARTY_NOTICES.md に記載も ALLOWLIST 登録も無い依存: ${missing.join(', ')}`).toEqual([]);

    // ALLOWLIST の全項目に reason が非空であること（無言 allowlist を禁止）。
    for (const [key, reason] of Object.entries(ALLOWLIST)) {
      expect(reason.trim().length, `ALLOWLIST["${key}"] の reason が空`).toBeGreaterThan(0);
    }

    // ALLOWLIST は実在する依存だけを載せる（削除された依存の allowlist 残骸を検出）。
    const staleAllowlistEntries = Object.keys(ALLOWLIST).filter((key) => !depKeys.includes(key));
    expect(staleAllowlistEntries, `package.json に無い ALLOWLIST 残骸: ${staleAllowlistEntries.join(', ')}`).toEqual([]);
  });

  /**
   * I-6: setup が利用者環境へ取りに行く配布元は Notices の対象。
   * 期待集合を手書きせず、setup スクリプトの現物から https ホストを抽出して突き合わせる
   * （nodejs.org は Node.js 本体の取得元で、本プロジェクトが利用する第三者成果物の
   * 配布元ではないため除外する）。
   */
  it('setup スクリプトの https ホスト（nodejs.org を除く）が本文に出現し、平文 http が無い（I-6・M-11）', () => {
    const notices = readFileSync(join(ROOT, 'THIRD_PARTY_NOTICES.md'), 'utf8');
    const hosts = new Set<string>();
    // M-11: `https:` だけを拾うと、平文 http の取得元が台帳からも検査からも漏れる。
    // scheme ごと拾い、https 以外はそれ自体を失敗として扱う。
    const insecure: string[] = [];
    for (const relPath of ['setup.command', 'setup.bat']) {
      const source = readFileSync(join(ROOT, relPath), 'utf8');
      for (const match of source.matchAll(/(https?):\/\/([a-zA-Z0-9][a-zA-Z0-9.-]*[a-zA-Z0-9])/g)) {
        const [, scheme, host] = match;
        if (!host) continue;
        if (scheme === 'https') hosts.add(host);
        else insecure.push(`${relPath}: ${scheme}://${host}`);
      }
    }
    expect(insecure, `setup スクリプトに https 以外の取得元がある: ${insecure.join(', ')}`).toEqual([]);
    hosts.delete('nodejs.org');
    expect(hosts.size, 'setup スクリプトから https ホストを抽出できなかった').toBeGreaterThan(0);

    const missing = [...hosts].filter((host) => !notices.includes(host));
    expect(missing, `THIRD_PARTY_NOTICES.md に記載の無い配布元ホスト: ${missing.join(', ')}`).toEqual([]);
  });

  it('@resvg/resvg-js（MPL-2.0）が本文に記載されている（I-2）', () => {
    const notices = readFileSync(join(ROOT, 'THIRD_PARTY_NOTICES.md'), 'utf8');
    expect(notices).toContain('@resvg/resvg-js');
    expect(notices).toContain('MPL-2.0');
  });
});
