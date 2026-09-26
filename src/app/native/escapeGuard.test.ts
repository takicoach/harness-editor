import {readFileSync, readdirSync} from 'node:fs';
import {join} from 'node:path';
import {expect, it} from 'vitest';

/**
 * R2 Rec 2: Esc の IME ガード（`isEscape` / `useDialogEscape`）を通さない直書きの Esc を機械で止める。
 *
 * 日本語入力の変換中に押す Esc は「変換の取り消し」であって、アプリの Esc（閉じる・下書きを戻す）では
 * ない。ガードを各所に手で書けば、次に増えた 1 箇所で必ず抜ける — 症状は気づきにくい
 * （変換を取り消しただけでダイアログが閉じる・入力中の下書きが巻き戻る）。
 *
 * 許可するのは「ドラッグ中断」の Esc だけ。ドラッグ中は IME の変換が走っていないので意味が衝突せず、
 * かつ `stopPropagation` で中断を使い切る必要がある（keyboard.ts の M-7）。ファイル名で逐語に列挙し、
 * ヒューリスティクスでは判定しない。ここに足すときは「本当に入力欄と無縁か」を 1 件ずつ見ること。
 */
const ALLOWED_DRAG_CANCEL = [
  'NativeCutRange.tsx',            // なぞってカットの範囲ドラッグ
  'NativeCutWords.tsx',            // 字幕のなぞり選択ドラッグ
  'NativeFinishCutTrack.tsx',      // カット行の端ドラッグと role=slider のハンドル操作
  'NativePreview.tsx',             // 図形の下書きドラッグ
  'NativePreviewManipulation.tsx', // 舞台の直接操作ジェスチャー
  'NativeTimeline.tsx',            // クリップのドラッグ／トリム
  'usePanelResize.ts',             // パネルのサイズドラッグ
  'useNativeAssetDrop.ts',         // 素材のドラッグ＆ドロップ
];
/**
 * IME ガードの定義側。keyboard.ts の isEscape 本体に加え、useDialogEscape.ts はダイアログの
 * Escape 処理を isComposing ガード込みで 1 箇所に集約する定義そのもの（native の外＝
 * src/app/ にあるが、同じ理由で許可リストに入る）。
 */
const DEFINITION = 'keyboard.ts';
const DEFINITIONS = [DEFINITION, 'useDialogEscape.ts'];

const directory = __dirname;
const sources = readdirSync(directory).filter(name => /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name));
expect(sources.length, 'src/app/native に走査対象がありません').toBeGreaterThan(20);
const extraSources: ReadonlyArray<readonly [string, string]> = [['useDialogEscape.ts', join(directory, '..', 'useDialogEscape.ts')]];
const raw = new Map([
  ...sources.map(name => [name, [...readFileSync(join(directory, name), 'utf8').matchAll(/['"]Escape['"]/g)].length] as const),
  ...extraSources.map(([name, path]) => [name, [...readFileSync(path, 'utf8').matchAll(/['"]Escape['"]/g)].length] as const),
].filter(([, count]) => count > 0));

it('Esc の直書きは「ドラッグ中断」の許可リストと定義側だけ。ほかは isEscape / useDialogEscape を通す', () => {
  const offenders = [...raw.keys()].filter(name => !DEFINITIONS.includes(name) && !ALLOWED_DRAG_CANCEL.includes(name));
  expect(offenders, `IME ガードを通さない Esc: ${offenders.join(', ')}`).toEqual([]);
});

it('許可リストは実在し、いまも直書きを持っている（列が腐ったら落ちる）', () => {
  expect(raw.size, '直書きの Esc が 1 件も見つからない（走査が空振りしている）').toBeGreaterThan(0);
  expect(ALLOWED_DRAG_CANCEL.filter(name => !raw.has(name)), '許可リストに、もう直書きの無いファイルが残っています').toEqual([]);
  expect(raw.has(DEFINITION), 'keyboard.ts に isEscape の定義がありません').toBe(true);
  expect(raw.has('useDialogEscape.ts'), 'useDialogEscape.ts に Escape の直書きがありません').toBe(true);
});
