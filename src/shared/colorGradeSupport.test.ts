/**
 * サブ動画レイヤの補正配線を **構造で** 見る判定（F-2）。
 *
 * 存在確認（`<ColorGradeLayer scope="insert">` が文字列としてあるか）だけでは、
 * `<MainLayout>` の内側に包まれた形——補正が 2 回掛かり、兄弟配置のプレビューと
 * 絵が食い違う形——を「対応済み」と誤って通す。ここで入れ子位置まで固定する。
 */
import { describe, it, expect } from 'vitest';
import { isInsideMainLayout, isVideoInsertColorGradeWired, mainLayoutRanges } from './colorGradeSupport';

const SIBLING = `export const MainVideo = () => (
  <AbsoluteFill>
    <MainLayout layout={MAIN_LAYOUT} colorGrade={COLOR_GRADE}>
      <CutPlayer />
    </MainLayout>
    <ColorGradeLayer grade={COLOR_GRADE} scope="insert">
      <VideoInsertSequence />
    </ColorGradeLayer>
  </AbsoluteFill>
);
`;

const NESTED = `export const MainVideo = () => (
  <AbsoluteFill>
    <MainLayout layout={MAIN_LAYOUT} colorGrade={COLOR_GRADE}>
      <CutPlayer />
      <ColorGradeLayer grade={COLOR_GRADE} scope="insert">
        <VideoInsertSequence />
      </ColorGradeLayer>
    </MainLayout>
  </AbsoluteFill>
);
`;

describe('mainLayoutRanges / isInsideMainLayout', () => {
  it('開き〜閉じの範囲を返し、内側の位置を内側と判定する', () => {
    const ranges = mainLayoutRanges(NESTED);
    expect(ranges).toHaveLength(1);
    expect(isInsideMainLayout(NESTED, NESTED.indexOf('<VideoInsertSequence'))).toBe(true);
    expect(isInsideMainLayout(SIBLING, SIBLING.indexOf('<VideoInsertSequence'))).toBe(false);
  });

  it('閉じタグが無い断片は末尾までを内側とみなす（fail-closed）', () => {
    const src = '<MainLayout layout={MAIN_LAYOUT}>\n<VideoInsertSequence />\n';
    expect(isInsideMainLayout(src, src.indexOf('<VideoInsertSequence'))).toBe(true);
  });
});

describe('isVideoInsertColorGradeWired', () => {
  it('サブ動画未導入なら true（食い違う面が無い）', () => {
    expect(isVideoInsertColorGradeWired('<MainLayout layout={MAIN_LAYOUT}>\n<CutPlayer />\n</MainLayout>')).toBe(true);
  });

  it('MainLayout の兄弟として包まれていれば true', () => {
    expect(isVideoInsertColorGradeWired(SIBLING)).toBe(true);
  });

  it('MainLayout の内側に包まれている形は false（補正が 2 回掛かる＝プレビューと食い違う）', () => {
    expect(isVideoInsertColorGradeWired(NESTED)).toBe(false);
  });

  it('包まれていなければ false', () => {
    expect(isVideoInsertColorGradeWired('<VideoInsertSequence />')).toBe(false);
  });

  it('別の ColorGradeLayer があるだけでは true にしない（包む対象が違う）', () => {
    const src = '<ColorGradeLayer grade={COLOR_GRADE}>\n  <Something />\n</ColorGradeLayer>\n<VideoInsertSequence />\n';
    expect(isVideoInsertColorGradeWired(src)).toBe(false);
  });
});
