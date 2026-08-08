import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cutDataImport } from './cutDataImport';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sme-cutimport-'));
  mkdirSync(join(dir, 'src'), { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('cutDataImport', () => {
  it('プロジェクト直下 cutData.ts → ../cutData', () => {
    writeFileSync(join(dir, 'cutData.ts'), 'export const cutData=[]', 'utf8');
    expect(cutDataImport(dir)).toBe('../cutData');
  });
  it('src/cutData.ts → ./cutData', () => {
    writeFileSync(join(dir, 'src', 'cutData.ts'), 'export const cutData=[]', 'utf8');
    expect(cutDataImport(dir)).toBe('./cutData');
  });
  it('src/テロップテンプレート/cutData.ts → ./テロップテンプレート/cutData', () => {
    mkdirSync(join(dir, 'src', 'テロップテンプレート'), { recursive: true });
    writeFileSync(join(dir, 'src', 'テロップテンプレート', 'cutData.ts'), 'export const cutData=[]', 'utf8');
    expect(cutDataImport(dir)).toBe('./テロップテンプレート/cutData');
  });
  it('直下と src の両方があれば直下（../cutData）を優先', () => {
    writeFileSync(join(dir, 'cutData.ts'), 'export const cutData=[]', 'utf8');
    writeFileSync(join(dir, 'src', 'cutData.ts'), 'export const cutData=[]', 'utf8');
    expect(cutDataImport(dir)).toBe('../cutData');
  });
  it('どれも無ければ null', () => {
    expect(cutDataImport(dir)).toBeNull();
  });
});
