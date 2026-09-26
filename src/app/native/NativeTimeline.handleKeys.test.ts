import {describe, expect, it} from 'vitest';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {TIMELINE_HANDLE_KEYS} from './NativeTimeline';

/**
 * I-1 の再発防止。NativeWorkspace の各テストは NativeTimeline を vi.mock で差し替え、
 * useImperativeHandle でハンドルを作り直す。そのキー集合が NativeTimelineHandle
 * と食い違うと、NativeWorkspace のアンマウント時などに `timeline.current.flush is not a function`
 * で Unhandled Rejection になる（NativeWorkspace.narrowLeft.test.tsx /
 * NativeWorkspace.toolbarRemeasure.test.tsx で実測）。
 * 型からは実行時にキーを取れないので、ソースをテキストとして走査してキー集合を突合する。
 *
 * R3 M-1: 突合するのは「実装 ⇔ 定数 ⇔ モック」の三者。以前は実装側だけ手書きの写し
 * （TIMELINE_HANDLE_KEYS）を正としており、実装がキーを増やしても定数を直し忘れれば
 * モックまで揃って古いまま緑になった。実装からも同じ手で読む。
 */
const sorted = (values: readonly string[]): string[] => [...values].sort();
const read = (fileName: string) => readFileSync(resolve(import.meta.dirname, fileName), 'utf8');

/**
 * `useImperativeHandle(ref,()=>({ … }))` の返り値オブジェクトから、深さ 0 のキーだけを読む。
 * 入れ子の関数本体や三項のコロンを拾わないよう、括弧と文字列を数えながら走る。
 *
 * I-2: `key: value` / `key: (…) => {…}` はコロンで拾えるが、shorthand メソッド記法
 * （`key(){…}` / `async key(){…}` / `get key(){…}`）にはコロンが無く、素通しすると
 * キーが 1 件も抽出されない。メソッド名の直後の `(` を深さ 1 で見た時点でもキーとして拾うが、
 * 今のメンバーが既にコロンで拾い済み（`memberHasColon`）なら拾わない。そうしないと
 * `restoreCut:()=>cutTrack.current?.restore()??Promise.resolve(false)` のように、
 * 波括弧の無いアロー本体（式のまま。深さが 1 に戻る）の中の `.restore(` `.resolve(` まで
 * キーとして誤検出する。メンバーの境界（深さ 1 のカンマ）でフラグを戻す。
 */
function handleKeys(source: string, where: string): string[] {
  const call = source.indexOf('useImperativeHandle(ref');
  if (call < 0) throw new Error(`${where}: useImperativeHandle(ref, …) が見つからない`);
  const open = source.indexOf('{', source.indexOf('=>', call));
  if (open < 0) throw new Error(`${where}: ハンドルのオブジェクトが見つからない`);
  const keys: string[] = [];
  let depth = 0, quote = '', word = '', memberHasColon = false;
  for (let i = open; i < source.length; i++) {
    const ch = source[i]!;
    if (quote) {if (ch === quote && source[i - 1] !== '\\') quote = ''; continue;}
    if (ch === '\'' || ch === '"' || ch === '`') {quote = ch; continue;}
    if (ch === '{' || ch === '(' || ch === '[') {
      if (depth === 1 && ch === '(' && word && !memberHasColon) {keys.push(word);}
      depth++; word = ''; continue;
    }
    if (ch === '}' || ch === ')' || ch === ']') {depth--; word = ''; if (depth === 0) break; continue;}
    if (depth === 1 && ch === ',') {memberHasColon = false; word = ''; continue;}
    if (depth === 1 && ch === ':' && word) {keys.push(word); memberHasColon = true; word = ''; continue;}
    word = /[\w$]/.test(ch) ? word + ch : '';
  }
  if (!keys.length) throw new Error(`${where}: ハンドルのキーが 1 件も読めない`);
  return keys;
}

describe('handleKeys の抽出が拾うキーの記法（I-2: shorthand メソッドの読み飛ばし再発防止）', () => {
  const wrap = (body: string) => `useImperativeHandle(ref, () => ({\n  ${body}\n}), [deps]);`;
  const cases: ReadonlyArray<readonly [string, string, string[]]> = [
    ['key:', 'flush: flushValue,', ['flush']],
    ['key:(…)=>', 'flush: (event) => { doThing(event); },', ['flush']],
    ['key(){', 'flush(){ doThing(); },', ['flush']],
    ['async key(){', 'async flush(){ await doThing(); },', ['flush']],
    ['get key(){', 'get flush(){ return value; },', ['flush']],
  ];
  for (const [name, body, expected] of cases) {
    it(`「${name}」形式からキーを抽出する`, () => {
      expect(handleKeys(wrap(body), name)).toEqual(expected);
    });
  }
});

describe('NativeTimeline のハンドルキー集合（実装 ⇔ 定数 ⇔ モック）', () => {
  const implementation = handleKeys(read('NativeTimeline.tsx'), 'NativeTimeline.tsx');
  it('定数 TIMELINE_HANDLE_KEYS は実装の写しではなく、実装と一致する', () => {
    expect(sorted(implementation)).toEqual(sorted(TIMELINE_HANDLE_KEYS));
  });
  for (const fileName of ['NativeWorkspace.narrowLeft.test.tsx', 'NativeWorkspace.toolbarRemeasure.test.tsx']) {
    it(`${fileName} のモックは実装と同形`, () => {
      const mock = read(fileName);
      const start = mock.indexOf(`vi.mock('./NativeTimeline'`);
      if (start < 0) throw new Error(`${fileName}: NativeTimeline の vi.mock が見つからない`);
      const nextMock = mock.indexOf('vi.mock(', start + 1);
      expect(sorted(handleKeys(mock.slice(start, nextMock < 0 ? undefined : nextMock), fileName))).toEqual(sorted(implementation));
    });
  }
});
