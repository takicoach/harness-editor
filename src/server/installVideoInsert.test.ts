import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installVideoInsert, isVideoInsertInstalled } from './installVideoInsert';

let dir: string;
const MAIN_VIDEO = `import { AbsoluteFill } from 'remotion';
import { TelopPlayer } from './テロップテンプレート';
import { CutPlayer } from './CutPlayer';

export const MainVideo: React.FC = () => {
  return (
    <AbsoluteFill style={{ backgroundColor: 'black' }}>
      <CutPlayer />
      <TelopPlayer />
    </AbsoluteFill>
  );
};
`;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sme-iv-'));
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'videoConfig.ts'), `export const VIDEO_FILE = 'main.mp4';`, 'utf8');
  writeFileSync(join(dir, 'src', 'MainVideo.tsx'), MAIN_VIDEO, 'utf8');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('installVideoInsert', () => {
  it('非プロジェクト（videoConfig 無し）は 400 で中断', () => {
    rmSync(join(dir, 'src', 'videoConfig.ts'));
    expect(() => installVideoInsert(dir)).toThrow();
  });

  it('部品をコピーし MainVideo にVideoInsertSequenceをテロップ直前へ挿入する', () => {
    const r = installVideoInsert(dir);
    expect(r.installed).toBe(true);
    expect(existsSync(join(dir, 'src', 'InsertVideo', 'InsertVideo.tsx'))).toBe(true);
    expect(existsSync(join(dir, 'src', 'InsertVideo', 'insert-video.json'))).toBe(true);
    expect(existsSync(join(dir, 'src', 'MainVideo.original.bak.tsx'))).toBe(true);
    const mv = readFileSync(join(dir, 'src', 'MainVideo.tsx'), 'utf8');
    expect(mv).toContain("import { VideoInsertSequence } from './InsertVideo';");
    // テロップの前に挿入されている
    expect(mv.indexOf('<VideoInsertSequence')).toBeLessThan(mv.indexOf('<TelopPlayer'));
    expect(mv.indexOf('<VideoInsertSequence')).toBeGreaterThan(mv.indexOf('<CutPlayer'));
  });

  it('開発専用テスト（*.test.*）はユーザープロジェクトへ配らない', () => {
    installVideoInsert(dir);
    // 実コンポーネントの依存（elementAnim.ts）は配られる。
    expect(existsSync(join(dir, 'src', 'InsertVideo', 'elementAnim.ts'))).toBe(true);
    // payload 同梱の InsertVideo.test.tsx は配られない（vitest 依存を持ち込まない）。
    expect(existsSync(join(dir, 'src', 'InsertVideo', 'InsertVideo.test.tsx'))).toBe(false);
  });

  it('冪等: 2回呼んでも壊れない', () => {
    installVideoInsert(dir);
    const once = readFileSync(join(dir, 'src', 'MainVideo.tsx'), 'utf8');
    installVideoInsert(dir);
    const twice = readFileSync(join(dir, 'src', 'MainVideo.tsx'), 'utf8');
    expect(twice).toBe(once); // 二重挿入しない
    expect(isVideoInsertInstalled(dir)).toBe(true);
  });

  it('アンカー（テロップ要素も CutPlayer も）が無ければ中断（marker を書かない）', () => {
    writeFileSync(join(dir, 'src', 'MainVideo.tsx'), `export const MainVideo = () => null;`, 'utf8');
    expect(() => installVideoInsert(dir)).toThrow();
    expect(isVideoInsertInstalled(dir)).toBe(false);
  });

  it('バックアップ既存時は上書きしない', () => {
    const bakPath = join(dir, 'src', 'MainVideo.original.bak.tsx');
    writeFileSync(bakPath, 'EXISTING_BAK', 'utf8');
    installVideoInsert(dir);
    expect(readFileSync(bakPath, 'utf8')).toBe('EXISTING_BAK');
  });

  it('テロップ要素が無ければ CutPlayer 直後へ実インデントを合わせて挿入する', () => {
    // テロップ無し・CutPlayer は 8 スペースインデント（ハードコード 6 と区別できる値）。
    const noTelop = `import { AbsoluteFill } from 'remotion';
import { CutPlayer } from './CutPlayer';

export const MainVideo: React.FC = () => {
  return (
        <CutPlayer />
  );
};
`;
    writeFileSync(join(dir, 'src', 'MainVideo.tsx'), noTelop, 'utf8');
    installVideoInsert(dir);
    const mv = readFileSync(join(dir, 'src', 'MainVideo.tsx'), 'utf8');
    // CutPlayer の直後に挿入されている。
    expect(mv.indexOf('<VideoInsertSequence')).toBeGreaterThan(mv.indexOf('<CutPlayer'));
    // ハードコード 6 スペースではなく CutPlayer 行の実インデント(8)へ合わせる。
    expect(mv).toContain('        <VideoInsertSequence />');
  });

  it('保存先行（insertVideoData.ts 既存）でも部品一式をコピーし、既存データは保持する', () => {
    // ＋サブ動画→保存を install より先に行うと src/InsertVideo/insertVideoData.ts が
    // 先に作られる。このとき install が「ディレクトリ存在＝導入済み」と見なして部品コピーを
    // 丸ごとスキップすると、InsertVideo.tsx / index.ts / types.ts / VideoInsertSequence.tsx が
    // 無いまま marker と import だけ書かれ、プレビュー bundle と最終 render が壊れる（Codex P1）。
    const destDir = join(dir, 'src', 'InsertVideo');
    mkdirSync(destDir, { recursive: true });
    const userData = '// USER SAVED DATA\nexport const insertVideoData = [{ id: 1 }];\n';
    writeFileSync(join(destDir, 'insertVideoData.ts'), userData, 'utf8');

    const r = installVideoInsert(dir);
    expect(r.installed).toBe(true);
    // 部品一式がコピーされている。
    expect(existsSync(join(destDir, 'InsertVideo.tsx'))).toBe(true);
    expect(existsSync(join(destDir, 'index.ts'))).toBe(true);
    expect(existsSync(join(destDir, 'types.ts'))).toBe(true);
    expect(existsSync(join(destDir, 'VideoInsertSequence.tsx'))).toBe(true);
    // ユーザーの保存済みデータは payload のスタブで上書きされず保持される。
    expect(readFileSync(join(destDir, 'insertVideoData.ts'), 'utf8')).toBe(userData);
    // 導入済みになり、MainVideo にも組み込まれている。
    expect(isVideoInsertInstalled(dir)).toBe(true);
    const mv = readFileSync(join(dir, 'src', 'MainVideo.tsx'), 'utf8');
    expect(mv).toContain("import { VideoInsertSequence } from './InsertVideo';");
  });

  it('画像シーケンスがある MainVideo では 画像の後・テロップの前へ挿入する（レイヤ順 画像→サブ動画→テロップ）', () => {
    // 実プロジェクト（golf-drills / YouTube1）は <CutPlayer/> <ImageSequence/> <TelopPlayer/> の順。
    // プレビュー合成は ベース→画像→サブ動画→テロップ なので、install もこの相対順を保つ必要がある。
    const withImage = `import { AbsoluteFill } from 'remotion';
import { TelopPlayer } from './テロップテンプレート';
import { ImageSequence } from './InsertImage';
import { CutPlayer } from './CutPlayer';

export const MainVideo: React.FC = () => {
  return (
    <AbsoluteFill style={{ backgroundColor: 'black' }}>
      <CutPlayer />
      <ImageSequence />
      <TelopPlayer />
    </AbsoluteFill>
  );
};
`;
    writeFileSync(join(dir, 'src', 'MainVideo.tsx'), withImage, 'utf8');
    installVideoInsert(dir);
    const mv = readFileSync(join(dir, 'src', 'MainVideo.tsx'), 'utf8');
    const vi = mv.indexOf('<VideoInsertSequence');
    // 画像の後・テロップの前。
    expect(vi).toBeGreaterThan(mv.indexOf('<ImageSequence'));
    expect(vi).toBeLessThan(mv.indexOf('<TelopPlayer'));
  });
});
