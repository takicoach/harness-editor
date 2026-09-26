import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectMotionKeysSupport, MOTION_KEYFRAMES_MARKER } from './motionKeysSupport';

function makeProject(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'sme-mks-'));
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, body, 'utf8');
  }
  return dir;
}

const M = `// ${MOTION_KEYFRAMES_MARKER}\n`;

describe('detectMotionKeysSupport', () => {
  it('部品が無い案件は両方 false（古い案件を対応済みと誤認しない）', () => {
    expect(detectMotionKeysSupport(makeProject({}))).toEqual({ telop: false, image: false });
  });
  it('旧版の部品（目印なし）は false', () => {
    const dir = makeProject({
      'src/テロップテンプレート/TelopPlayer.tsx': 'export const TelopPlayer = () => null;',
      'src/InsertImage/InsertImage.tsx': 'export const InsertImage = () => null;',
    });
    expect(detectMotionKeysSupport(dir)).toEqual({ telop: false, image: false });
  });
  it('TelopPlayer が対応していれば telop:true', () => {
    const dir = makeProject({ 'src/テロップテンプレート/TelopPlayer.tsx': M });
    expect(detectMotionKeysSupport(dir).telop).toBe(true);
  });
  it('TelopPlayer が無い案件は telop:false（キーを適用する部品が居ない・fail-closed）', () => {
    const dir = makeProject({ 'src/テロップテンプレート/Telop.tsx': M });
    expect(detectMotionKeysSupport(dir).telop).toBe(false);
  });
  it('旧 TelopPlayer + 目印つきの Telop.tsx でも telop:false（適用者はラッパー1つ）', () => {
    // 実在の組み合わせ: パック導入は Telop.tsx と styles だけを配り TelopPlayer.tsx は差し替えない。
    // ラッパーが旧版のままなら Remotion 書き出しはキーを適用しない（＝反映されない）ので、
    // Telop.tsx 側の目印だけで true を返すと「黙って食い違う」案件に注意書きが出なくなる。
    const dir = makeProject({
      'src/テロップテンプレート/TelopPlayer.tsx': 'export const TelopPlayer = () => null;',
      'src/テロップテンプレート/Telop.tsx': M,
    });
    expect(detectMotionKeysSupport(dir).telop).toBe(false);
  });
  it('imageMotion.ts があれば image:true', () => {
    const dir = makeProject({ 'src/InsertImage/imageMotion.ts': M });
    expect(detectMotionKeysSupport(dir).image).toBe(true);
  });
});

describe('本体が配る部品には目印が入っている（配布物の自己検査）', () => {
  it('project-template の実ファイルに目印がある（telopMotion.ts・imageMotion.ts）', () => {
    // 製品版の TelopPlayer.tsx の目印は motionKeysSupport.product.test.ts（公開版の TelopPlayer.tsx は 0.3.1 の物）。
    const root = join(import.meta.dirname, '..', '..');
    const targets = [
      'project-template/src/テロップテンプレート/telopMotion.ts',
      'project-template/src/InsertImage/imageMotion.ts',
    ];
    for (const rel of targets) {
      expect(readFileSync(join(root, rel), 'utf8')).toContain(MOTION_KEYFRAMES_MARKER);
    }
  });
  it('テロップパックの Telop.tsx には目印を入れない（キーを適用しないので）', () => {
    // 目印を持つのは「キーを実際に適用する部品」だけ。ここに目印を戻すと、旧ラッパーの案件が
    // 対応済みと誤判定されて注意書きが消える（＝黙って食い違う）。
    const src = readFileSync(join(import.meta.dirname, 'telopPack', 'Telop.tsx'), 'utf8');
    expect(src).not.toContain(MOTION_KEYFRAMES_MARKER);
  });
});
