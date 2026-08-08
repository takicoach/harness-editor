import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installShape, isShapeInstalled } from './installShape';

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
  dir = mkdtempSync(join(tmpdir(), 'sme-shape-'));
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'videoConfig.ts'), `export const VIDEO_FILE = 'main.mp4';`, 'utf8');
  writeFileSync(join(dir, 'src', 'MainVideo.tsx'), MAIN_VIDEO, 'utf8');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('installShape', () => {
  it('① 部品コピー＋marker: ShapeSequence.tsx と insert-shape.json が作られる', () => {
    const r = installShape(dir);
    expect(r.installed).toBe(true);
    // 部品がコピーされている
    expect(existsSync(join(dir, 'src', 'InsertShape', 'ShapeSequence.tsx'))).toBe(true);
    expect(existsSync(join(dir, 'src', 'InsertShape', 'InsertShape.tsx'))).toBe(true);
    // marker が作られている
    expect(existsSync(join(dir, 'src', 'InsertShape', 'insert-shape.json'))).toBe(true);
    expect(existsSync(join(dir, 'src', 'MainVideo.original.bak.tsx'))).toBe(true);
    // 非出荷ファイル（テスト）はユーザープロジェクトへ同梱しない（H-1 回帰防止）。
    // 配布先は vitest 非依存のため shipped test が typecheck/build を壊す。
    const shipped = readdirSync(join(dir, 'src', 'InsertShape'));
    expect(shipped.some((f) => f.endsWith('.test.ts') || f.endsWith('.test.tsx'))).toBe(false);
  });

  it('② import と <ShapeSequence /> が1つだけ注入される（テロップ直前）', () => {
    installShape(dir);
    const mv = readFileSync(join(dir, 'src', 'MainVideo.tsx'), 'utf8');
    // import が1つ注入されている
    expect(mv).toContain("import { ShapeSequence } from './InsertShape';");
    // <ShapeSequence /> タグが存在する
    expect(mv).toContain('<ShapeSequence />');
    // テロップの前に挿入されている
    expect(mv.indexOf('<ShapeSequence')).toBeLessThan(mv.indexOf('<TelopPlayer'));
    // CutPlayer の後にある
    expect(mv.indexOf('<ShapeSequence')).toBeGreaterThan(mv.indexOf('<CutPlayer'));
  });

  it('③ 冪等: 2回呼んでも壊れない（import/JSX が重複しない）', () => {
    installShape(dir);
    const once = readFileSync(join(dir, 'src', 'MainVideo.tsx'), 'utf8');
    installShape(dir);
    const twice = readFileSync(join(dir, 'src', 'MainVideo.tsx'), 'utf8');
    expect(twice).toBe(once);
    expect(isShapeInstalled(dir)).toBe(true);
    // import が1つだけ
    const importCount = (twice.match(/import \{ ShapeSequence \}/g) ?? []).length;
    expect(importCount).toBe(1);
    // タグが1つだけ
    const tagCount = (twice.match(/<ShapeSequence/g) ?? []).length;
    expect(tagCount).toBe(1);
  });

  it('④ shapeData.ts 保持: 既存 shapeData.ts はスキップ（上書きしない）', () => {
    // shapeData.ts が先に存在する場合
    const destDir = join(dir, 'src', 'InsertShape');
    mkdirSync(destDir, { recursive: true });
    const userData = '// USER SAVED DATA\nexport const shapeData = [{ id: "shape-1" }];\n';
    writeFileSync(join(destDir, 'shapeData.ts'), userData, 'utf8');

    const r = installShape(dir);
    expect(r.installed).toBe(true);
    // 部品一式がコピーされている
    expect(existsSync(join(destDir, 'ShapeSequence.tsx'))).toBe(true);
    expect(existsSync(join(destDir, 'InsertShape.tsx'))).toBe(true);
    expect(existsSync(join(destDir, 'index.ts'))).toBe(true);
    expect(existsSync(join(destDir, 'types.ts'))).toBe(true);
    // ユーザーの保存済み shapeData.ts は上書きされず保持される
    expect(readFileSync(join(destDir, 'shapeData.ts'), 'utf8')).toBe(userData);
    // 導入済みになり、MainVideo にも組み込まれている
    expect(isShapeInstalled(dir)).toBe(true);
    const mv = readFileSync(join(dir, 'src', 'MainVideo.tsx'), 'utf8');
    expect(mv).toContain("import { ShapeSequence } from './InsertShape';");
  });

  it('非プロジェクト（videoConfig 無し）は 400 で中断', () => {
    rmSync(join(dir, 'src', 'videoConfig.ts'));
    expect(() => installShape(dir)).toThrow();
  });

  it('アンカーが無ければ中断（marker を書かない）', () => {
    writeFileSync(join(dir, 'src', 'MainVideo.tsx'), `export const MainVideo = () => null;`, 'utf8');
    expect(() => installShape(dir)).toThrow();
    expect(isShapeInstalled(dir)).toBe(false);
  });

  it('テロップ要素が無ければ CutPlayer 直後へ挿入する', () => {
    const noTelop = `import { AbsoluteFill } from 'remotion';
import { CutPlayer } from './CutPlayer';

export const MainVideo: React.FC = () => {
  return (
        <CutPlayer />
  );
};
`;
    writeFileSync(join(dir, 'src', 'MainVideo.tsx'), noTelop, 'utf8');
    installShape(dir);
    const mv = readFileSync(join(dir, 'src', 'MainVideo.tsx'), 'utf8');
    expect(mv.indexOf('<ShapeSequence')).toBeGreaterThan(mv.indexOf('<CutPlayer'));
    // CutPlayer の実インデント(8スペース)に合わせる
    expect(mv).toContain('        <ShapeSequence />');
  });
});
