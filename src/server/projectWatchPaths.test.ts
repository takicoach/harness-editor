/**
 * 監視対象の一覧と指紋（サイクル 2 レビュー Important の土台）。
 * 「保存した内容とディスクが一致するか」を見分ける材料がここで作られる。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { projectContentSignature, projectWatchPaths } from './projectWatchPaths';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makeProject(): string {
  const d = mkdtempSync(join(tmpdir(), 'sme-sig-'));
  dirs.push(d);
  const telop = join(d, 'src', 'テロップテンプレート', 'telopData.ts');
  mkdirSync(dirname(telop), { recursive: true });
  writeFileSync(telop, 'export const TELOP_DATA = [];\n');
  return d;
}

describe('projectContentSignature', () => {
  it('撮影台本の追加・外部更新・削除を同じ監視一覧と指紋へ含める', () => {
    const dir = makeProject();
    const file = join(dir, 'shooting-script.json');
    expect(projectWatchPaths(dir)).toContain(file);
    const absent = projectContentSignature(dir);
    writeFileSync(file, '{"text":"台本"}');
    const added = projectContentSignature(dir);
    expect(added).not.toBe(absent);
    writeFileSync(file, '{"text":"台本の更新"}');
    expect(projectContentSignature(dir)).not.toBe(added);
    rmSync(file);
    expect(projectContentSignature(dir)).toBe(absent);
  });

  it('同じ内容なら同じ指紋', () => {
    const d = makeProject();
    expect(projectContentSignature(d)).toBe(projectContentSignature(d));
  });

  it('監視対象が書き換わると指紋が変わる', () => {
    const d = makeProject();
    const before = projectContentSignature(d);
    const telop = join(d, 'src', 'テロップテンプレート', 'telopData.ts');
    writeFileSync(telop, 'export const TELOP_DATA = [1];\n');
    expect(projectContentSignature(d)).not.toBe(before);
  });

  it('大きさが同じでも更新時刻が変われば指紋が変わる（同内容の外部上書きを見逃さない）', () => {
    const d = makeProject();
    const before = projectContentSignature(d);
    const telop = join(d, 'src', 'テロップテンプレート', 'telopData.ts');
    const later = new Date(Date.now() + 5000);
    utimesSync(telop, later, later);
    expect(projectContentSignature(d)).not.toBe(before);
  });

  it('監視対象が新しく作られると指紋が変わる', () => {
    const d = makeProject();
    const before = projectContentSignature(d);
    writeFileSync(join(d, 'src', 'speedData.ts'), 'export const MAIN_SPEED = 1;\n');
    expect(projectContentSignature(d)).not.toBe(before);
  });

  it('指紋は監視対象のすべてのパスを含む（片側だけ増える取りこぼしを防ぐ）', () => {
    const d = makeProject();
    const sig = projectContentSignature(d);
    for (const abs of projectWatchPaths(d)) expect(sig).toContain(abs);
  });
});
