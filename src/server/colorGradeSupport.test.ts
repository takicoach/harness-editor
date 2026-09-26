/**
 * カラー補正が「書き出しに反映されるか」の判定（F-2）。
 * fail-closed（部品と配線が両方揃って初めて true）であることを固定する。
 * 片方だけで true を返すと、プレビューだけ変わる案件に注意書きが出なくなる。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectColorGradeSupport, COLOR_GRADE_MARKER } from './colorGradeSupport';

let dir = '';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sme-color-'));
  mkdirSync(join(dir, 'src', 'MainLayout'), { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const writePayload = (body: string): void =>
  writeFileSync(join(dir, 'src', 'MainLayout', 'colorGrade.ts'), body, 'utf8');
const writeMainVideo = (body: string): void =>
  writeFileSync(join(dir, 'src', 'MainVideo.tsx'), body, 'utf8');

describe('detectColorGradeSupport', () => {
  it('部品も配線も無い（未導入）案件は false', () => {
    expect(detectColorGradeSupport(dir)).toBe(false);
  });

  it('部品はあるが MainVideo に配線が無ければ false', () => {
    writePayload(`// ${COLOR_GRADE_MARKER}\n`);
    writeMainVideo('<MainLayout layout={MAIN_LAYOUT}>');
    expect(detectColorGradeSupport(dir)).toBe(false);
  });

  it('配線はあるが部品が旧版（目印なし）なら false', () => {
    writePayload('// 旧版\n');
    writeMainVideo('<MainLayout layout={MAIN_LAYOUT} colorGrade={COLOR_GRADE}>');
    expect(detectColorGradeSupport(dir)).toBe(false);
  });

  it('部品も配線も揃えば true', () => {
    writePayload(`// ${COLOR_GRADE_MARKER}\n`);
    writeMainVideo('<MainLayout layout={MAIN_LAYOUT} colorGrade={COLOR_GRADE}>');
    expect(detectColorGradeSupport(dir)).toBe(true);
  });

  it('サブ動画が導入済みでも、MainLayout の兄弟として包まれていれば true', () => {
    writePayload(`// ${COLOR_GRADE_MARKER}\n`);
    // install が実際に作る形（サブ動画レイヤはメイン動画レイヤの外側＝兄弟）。
    writeMainVideo(
      '<MainLayout layout={MAIN_LAYOUT} colorGrade={COLOR_GRADE}>\n<CutPlayer />\n</MainLayout>\n' +
        '<ColorGradeLayer grade={COLOR_GRADE} scope="insert">\n<VideoInsertSequence />\n</ColorGradeLayer>',
    );
    expect(detectColorGradeSupport(dir)).toBe(true);
  });

  // 差し戻し[major]: 存在確認だけでは、MainLayout の内側に包まれた形（補正が 2 回掛かり
  // プレビューと絵が食い違う）まで「対応済み」と表示してしまう。入れ子位置まで見る。
  it('サブ動画が MainLayout の内側に包まれている形は false（補正が 2 回掛かる）', () => {
    writePayload(`// ${COLOR_GRADE_MARKER}\n`);
    writeMainVideo(
      '<MainLayout layout={MAIN_LAYOUT} colorGrade={COLOR_GRADE}>\n<CutPlayer />\n' +
        '<ColorGradeLayer grade={COLOR_GRADE} scope="insert">\n<VideoInsertSequence />\n</ColorGradeLayer>\n</MainLayout>',
    );
    expect(detectColorGradeSupport(dir)).toBe(false);
  });

  it('サブ動画が導入済みなのに包まれていなければ false（メインだけ補正が乗る絵を黙認しない）', () => {
    writePayload(`// ${COLOR_GRADE_MARKER}\n`);
    writeMainVideo('<MainLayout layout={MAIN_LAYOUT} colorGrade={COLOR_GRADE}>\n<VideoInsertSequence />');
    expect(detectColorGradeSupport(dir)).toBe(false);
  });

  it('実際に配る payload は目印を持っている（目印の付け忘れを検出する）', async () => {
    const { readFileSync } = await import('node:fs');
    const real = readFileSync(
      new URL('./mainLayoutPayload/colorGrade.ts', import.meta.url),
      'utf8',
    );
    expect(real).toContain(COLOR_GRADE_MARKER);
  });
});
