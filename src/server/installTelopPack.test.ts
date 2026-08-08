import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installTelopPack, isTelopPackInstalled, widenTelopTypes } from './installTelopPack';
import { TELOP_PACK } from './telopPack/manifest';

const TELOP_DIR = 'テロップテンプレート';
const ORIGINAL_TELOP = 'export const Telop = () => null; // original\n';
const STD_TYPES = 'export interface TelopSegment {\n  template?: 1 | 2 | 3 | 4 | 5 | 6;\n}\n';

const created: string[] = [];

/** テスト用の最小プロジェクトを temp dir に作る。 */
function makeProject(opts: { videoConfig?: boolean; telop?: string; telopTypes?: string }): string {
  const dir = mkdtempSync(join(tmpdir(), 'sme-install-'));
  created.push(dir);
  mkdirSync(join(dir, 'src', TELOP_DIR), { recursive: true });
  if (opts.videoConfig !== false) {
    writeFileSync(join(dir, 'src', 'videoConfig.ts'), 'export const VIDEO_FORMAT = {};\n', 'utf8');
  }
  if (opts.telop !== undefined) {
    writeFileSync(join(dir, 'src', TELOP_DIR, 'Telop.tsx'), opts.telop, 'utf8');
  }
  if (opts.telopTypes !== undefined) {
    writeFileSync(join(dir, 'src', TELOP_DIR, 'telopTypes.ts'), opts.telopTypes, 'utf8');
  }
  return dir;
}

afterEach(() => {
  for (const d of created.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('installTelopPack', () => {
  it('正常導入: adapter/styles/marker を書き、telopTypes を widen し、元 Telop をバックアップ', () => {
    const dir = makeProject({ telop: ORIGINAL_TELOP, telopTypes: STD_TYPES });
    const res = installTelopPack(dir);
    expect(res).toEqual({ installed: true });
    const tdir = join(dir, 'src', TELOP_DIR);
    expect(isTelopPackInstalled(dir)).toBe(true);
    expect(existsSync(join(tdir, 'telop-pack.json'))).toBe(true);
    // アダプタ Telop.tsx は pack 版（元とは別物）
    expect(readFileSync(join(tdir, 'Telop.tsx'), 'utf8')).not.toContain('// original');
    // styles は同梱スタイル数ぶん（マニフェストを正とする）
    expect(readdirSync(join(tdir, 'styles')).filter((f) => f.endsWith('.tsx'))).toHaveLength(TELOP_PACK.length);
    // 元 Telop はバックアップ
    expect(readFileSync(join(tdir, 'Telop.original.bak.tsx'), 'utf8')).toBe(ORIGINAL_TELOP);
    // telopTypes は number へ widen
    expect(readFileSync(join(tdir, 'telopTypes.ts'), 'utf8')).toContain('template?: number;');
  });

  it('冪等: 2回目は no-op（バックアップ・アダプタを上書きしない）', () => {
    const dir = makeProject({ telop: ORIGINAL_TELOP, telopTypes: STD_TYPES });
    installTelopPack(dir);
    const tdir = join(dir, 'src', TELOP_DIR);
    const adapter1 = readFileSync(join(tdir, 'Telop.tsx'), 'utf8');
    installTelopPack(dir);
    expect(readFileSync(join(tdir, 'Telop.original.bak.tsx'), 'utf8')).toBe(ORIGINAL_TELOP);
    expect(readFileSync(join(tdir, 'Telop.tsx'), 'utf8')).toBe(adapter1);
  });

  it('サブセット union (1|2|3) も widen する', () => {
    const dir = makeProject({ telop: ORIGINAL_TELOP, telopTypes: 'export interface T { template?: 1 | 2 | 3; }\n' });
    installTelopPack(dir);
    expect(readFileSync(join(dir, 'src', TELOP_DIR, 'telopTypes.ts'), 'utf8')).toContain('template?: number;');
  });

  it('template が既に number（required 含む）なら中断せず導入する', () => {
    const dir = makeProject({ telop: ORIGINAL_TELOP, telopTypes: 'export interface T { template: number; }\n' });
    expect(() => installTelopPack(dir)).not.toThrow();
    expect(isTelopPackInstalled(dir)).toBe(true);
  });

  it('videoConfig.ts 不在なら throw・marker/styles/バックアップを書かない', () => {
    const dir = makeProject({ videoConfig: false, telop: ORIGINAL_TELOP, telopTypes: STD_TYPES });
    expect(() => installTelopPack(dir)).toThrow();
    const tdir = join(dir, 'src', TELOP_DIR);
    expect(existsSync(join(tdir, 'telop-pack.json'))).toBe(false);
    expect(existsSync(join(tdir, 'styles'))).toBe(false);
    expect(existsSync(join(tdir, 'Telop.original.bak.tsx'))).toBe(false);
  });

  // 新テンプレート（スキルパッケージ同梱の telopTypes.ts）は `template?: TelopTemplateId;` と
  // 型エイリアス経由で書かれている。旧実装は直書き union しか見ておらず、この形を
  // 「自動で広げられない型」と誤判定して HTTP 400 で導入を止めていた。
  it('型エイリアス経由の数値 union（template?: TelopTemplateId）も widen する', () => {
    const types = [
      'export type TelopTemplateId =',
      '  | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10',
      '  | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18 | 19 | 20',
      '  | 21 | 22 | 23 | 24 | 25 | 26 | 27 | 28 | 29 | 30;',
      '',
      'export interface TelopSegment {',
      '  template?: TelopTemplateId;',
      '}',
      '',
    ].join('\n');
    const dir = makeProject({ telop: ORIGINAL_TELOP, telopTypes: types });
    expect(() => installTelopPack(dir)).not.toThrow();
    expect(isTelopPackInstalled(dir)).toBe(true);
    const after = readFileSync(join(dir, 'src', TELOP_DIR, 'telopTypes.ts'), 'utf8');
    // エイリアス定義側を number へ広げる（フィールド側の参照は残すので、
    // 型名が未使用になって noUnusedLocals で落ちることがない）。
    expect(after).toContain('export type TelopTemplateId = number;');
    expect(after).toContain('template?: TelopTemplateId;');
    // 広げるのは対象のエイリアスだけ（他の宣言を巻き込まない）。
    expect(after).toContain('export interface TelopSegment {');
  });

  it('エイリアスが同一ファイルに無い（import 由来）なら widen せず中断する', () => {
    const types = [
      "import type { TelopTemplateId } from './external';",
      'export interface TelopSegment {',
      '  template?: TelopTemplateId;',
      '}',
      '',
    ].join('\n');
    const dir = makeProject({ telop: ORIGINAL_TELOP, telopTypes: types });
    expect(() => installTelopPack(dir)).toThrow();
    const tdir = join(dir, 'src', TELOP_DIR);
    expect(existsSync(join(tdir, 'telop-pack.json'))).toBe(false);
    expect(existsSync(join(tdir, 'styles'))).toBe(false);
    expect(readFileSync(join(tdir, 'Telop.tsx'), 'utf8')).toBe(ORIGINAL_TELOP);
  });

  it('エイリアスの中身が数値リテラル union でなければ中断する（任意の型宣言を書き換えない）', () => {
    const types = [
      "export type TelopTemplateId = 'a' | 'b';",
      'export interface TelopSegment {',
      '  template?: TelopTemplateId;',
      '}',
      '',
    ].join('\n');
    const dir = makeProject({ telop: ORIGINAL_TELOP, telopTypes: types });
    expect(() => installTelopPack(dir)).toThrow();
    const tdir = join(dir, 'src', TELOP_DIR);
    expect(existsSync(join(tdir, 'telop-pack.json'))).toBe(false);
    expect(readFileSync(join(tdir, 'telopTypes.ts'), 'utf8')).toBe(types);
  });

  it('widen 不能な template 型なら throw・書き込み前に中断（元 Telop 無傷・marker/styles なし）', () => {
    const dir = makeProject({ telop: ORIGINAL_TELOP, telopTypes: "export interface T { template?: 'a' | 'b'; }\n" });
    expect(() => installTelopPack(dir)).toThrow();
    const tdir = join(dir, 'src', TELOP_DIR);
    expect(existsSync(join(tdir, 'telop-pack.json'))).toBe(false);
    expect(existsSync(join(tdir, 'styles'))).toBe(false);
    expect(existsSync(join(tdir, 'Telop.original.bak.tsx'))).toBe(false);
    expect(readFileSync(join(tdir, 'Telop.tsx'), 'utf8')).toBe(ORIGINAL_TELOP);
  });
});

// widen 判定そのものの単体確認（書き込みを伴わない純関数として検証する）。
// この関数は「ユーザーのプロジェクトのソースを書き換えてよいか」の門番なので、
// 形が確定できない入力では必ず throw する（＝任意の型宣言を書き換えない）ことを固定する。
describe('widenTelopTypes（widen 可否の判定）', () => {
  it('直書き union は number へ広げる', () => {
    expect(widenTelopTypes('export interface T { template?: 1 | 2 | 30; }\n'))
      .toContain('template?: number;');
  });

  it('template フィールドが無ければ widen しない（null）', () => {
    expect(widenTelopTypes('export interface T { id: number; }\n')).toBeNull();
  });

  it('既に number なら widen しない（null）', () => {
    expect(widenTelopTypes('export interface T { template?: number; }\n')).toBeNull();
  });

  it('エイリアスの数値 union は宣言側だけを number にする', () => {
    const src = 'type Ids = 1 | 2 | 3;\nexport interface T { template?: Ids; }\n';
    expect(widenTelopTypes(src)).toBe('type Ids = number;\nexport interface T { template?: Ids; }\n');
  });

  it('同名前方一致の別エイリアスを巻き込まない', () => {
    const src = 'type IdsExtra = 1 | 2;\ntype Ids = 1 | 2 | 3;\nexport interface T { template?: Ids; }\n';
    const out = widenTelopTypes(src);
    expect(out).toContain('type IdsExtra = 1 | 2;');
    expect(out).toContain('type Ids = number;');
  });

  it('エイリアスの中身が数値リテラルでなければ throw（任意の型宣言を書き換えない）', () => {
    expect(() => widenTelopTypes("type Ids = 'a' | 'b';\nexport interface T { template?: Ids; }\n")).toThrow();
    expect(() => widenTelopTypes('type Ids = Record<string, () => void>;\nexport interface T { template?: Ids; }\n')).toThrow();
  });

  it('型注釈が識別子でない（インライン union・関数型など）なら throw', () => {
    expect(() => widenTelopTypes("export interface T { template?: 'a' | 'b'; }\n")).toThrow();
    expect(() => widenTelopTypes('export interface T { template?: () => void; }\n')).toThrow();
    expect(() => widenTelopTypes('export interface T { template?: number[]; }\n')).toThrow();
  });

  it('エイリアス名に正規表現メタ文字を混ぜても widen せず throw する（正規表現インジェクション不成立）', () => {
    // `template?: .*;` は識別子として解釈されないため参照候補にならない。
    expect(() => widenTelopTypes('type X = 1 | 2;\nexport interface T { template?: .*; }\n')).toThrow();
  });

  it('$ を含む型名は正規表現へ埋め込まず throw する（広げずに止める）', () => {
    // `$` は TS の識別子には使えるが正規表現のメタ文字。埋め込みは許可しない。
    const src = 'type Ids$A = 1 | 2 | 3;\nexport interface T { template?: Ids$A; }\n';
    expect(() => widenTelopTypes(src)).toThrow();
  });

  it('import 由来のエイリアス（同一ファイルに宣言が無い）は throw', () => {
    const src = "import type { Ids } from './x';\nexport interface T { template?: Ids; }\n";
    expect(() => widenTelopTypes(src)).toThrow();
  });
});

// 置換が先頭1件だけだと「導入は成功したのに実際のフィールドは narrow なまま」＝
// ビルドが壊れた状態で完了扱いになる。全件置換と事後条件検査をここで固定する。
describe('widenTelopTypes（取りこぼしの防止・全件置換と事後条件）', () => {
  it('同じ記述がコメントにもある場合、フィールド側を取りこぼさない', () => {
    const src = [
      '/** 例: template?: 1 | 2 | 3; のように書く。 */',
      'export interface T { template?: 1 | 2 | 3; }',
      '',
    ].join('\n');
    const out = widenTelopTypes(src);
    expect(out).toContain('export interface T { template?: number; }');
    expect(out).not.toContain('template?: 1 | 2 | 3;');
  });

  it('template を持つ interface が2つあれば両方広げる', () => {
    const src = 'export interface A { template?: 1 | 2 | 3; }\nexport interface B { template?: 1 | 2 | 3; }\n';
    expect(widenTelopTypes(src))
      .toBe('export interface A { template?: number; }\nexport interface B { template?: number; }\n');
  });

  it('エイリアスが2種類あれば両方の宣言を広げる', () => {
    const src = [
      'type IdsA = 1 | 2 | 3;',
      'type IdsB = 1 | 2;',
      'export interface A { template?: IdsA; }',
      'export interface B { template?: IdsB; }',
      '',
    ].join('\n');
    const out = widenTelopTypes(src);
    expect(out).toContain('type IdsA = number;');
    expect(out).toContain('type IdsB = number;');
  });

  it('1件でも広げられない template が残れば throw（部分適用しない）', () => {
    const src = "export interface A { template?: 1 | 2 | 3; }\nexport interface B { template?: 'a' | 'b'; }\n";
    expect(() => widenTelopTypes(src)).toThrow();
  });

  it('template を語尾に含む別フィールドは書き換えない（事後条件の誤爆も無い）', () => {
    const src = 'export interface T { subtemplate?: 1 | 2; template?: 1 | 2 | 3; }\n';
    const out = widenTelopTypes(src);
    expect(out).toContain('subtemplate?: 1 | 2;');
    expect(out).toContain(' template?: number;');
  });
});
