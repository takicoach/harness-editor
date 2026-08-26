import { AbsoluteFill } from 'remotion';
import { ShapeSequence } from './InsertShape';

// 標準ひな形（Harness Editor 標準 MainVideo）の最小フィクスチャ。
// エディタはデータファイル（telopData/cutData/insertVideoData 等）を読むため
// MainVideo 自体はプレビュー/保存に使われないが、サブ動画の「導入」(installVideoInsert)
// が <TelopPlayer> 直前 / <CutPlayer> 直後へ <VideoInsertSequence/> を挿入するための
// アンカーを提供する。ここでは CutPlayer/TelopPlayer を自己完結のダミーで定義し、
// フィクスチャの型チェック（tsconfig include: src）がダングリング import で壊れないようにする。
// InsertShape 経路: 図形機能導入済み（insert-shape.json marker あり）。
const CutPlayer = () => <AbsoluteFill style={{ backgroundColor: 'black' }} />;
const TelopPlayer = () => <AbsoluteFill />;

export const MainVideo = () => {
  return (
    <AbsoluteFill style={{ backgroundColor: 'black' }}>
      <CutPlayer />
      <ShapeSequence />
      <TelopPlayer />
    </AbsoluteFill>
  );
};
