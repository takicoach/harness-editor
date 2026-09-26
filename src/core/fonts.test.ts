import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { FONTS, fontById, fontStack, resolveFontByValue } from './fonts';

describe('FONTS', () => {
  it('id は一意', () => {
    expect(new Set(FONTS.map(f => f.id)).size).toBe(FONTS.length);
  });
  it('family は一意', () => {
    expect(new Set(FONTS.map(f => f.family)).size).toBe(FONTS.length);
  });
  it('同梱書体のファイルは public/fonts に実在する', () => {
    for (const font of FONTS.filter(f => f.group === 'bundled')) {
      expect(font.file).not.toBeNull();
      expect(existsSync(resolve('public/fonts', font.file!))).toBe(true);
    }
  });
  it('システム書体はファイルを持たない', () => {
    for (const font of FONTS.filter(f => f.group === 'system')) expect(font.file).toBeNull();
  });
  it('件数はコードに固定せず、同梱ぶんは manifest と一致する', () => {
    const manifest = JSON.parse(readFileSync(resolve('public/fonts/fonts.manifest.json'), 'utf8'));
    expect(manifest.fonts.map((f: { id: string }) => f.id).sort())
      .toEqual(FONTS.filter(f => f.group === 'bundled').map(f => f.id).sort());
  });
  // M-3: 台帳（fonts.manifest.json）の sha256／bytes を実ファイルと突き合わせる。
  // 突合が無いと「記録はあるが中身は別物」を検出できず、台帳が飾りになる。
  it('manifest の sha256 と bytes が public/fonts の実ファイルと一致する', () => {
    const manifest = JSON.parse(readFileSync(resolve('public/fonts/fonts.manifest.json'), 'utf8')) as
      { fonts: { id: string; bytes: number; weights: { file: string; sha256: string; bytes: number }[] }[] };
    let checked = 0;
    for (const font of manifest.fonts) {
      let total = 0;
      for (const weight of font.weights) {
        const bytes = readFileSync(resolve('public/fonts', weight.file));
        expect(createHash('sha256').update(bytes).digest('hex'), `${weight.file} の内容が台帳と違う`).toBe(weight.sha256);
        expect(bytes.length, `${weight.file} のサイズが台帳と違う`).toBe(weight.bytes);
        total += bytes.length; checked++;
      }
      expect(total, `${font.id} の合計サイズが台帳と違う`).toBe(font.bytes);
    }
    // 走査が空振り（glob 崩れ・manifest 空）なら恒真になるので件数も見る。
    expect(checked).toBeGreaterThan(15);
  });
  it('@font-face は同梱書体すべてに 1 件ずつある', () => {
    const css = readFileSync(resolve('src/styles/fonts.css'), 'utf8');
    for (const font of FONTS.filter(f => f.group === 'bundled')) {
      expect(css).toContain(`/fonts/${font.file}`);
      expect(css).toContain(`font-family: '${font.family}'`);
    }
  });
  it('fontById と fontStack', () => {
    expect(fontById(FONTS[0]!.id)).toBe(FONTS[0]);
    expect(fontById('nope')).toBeUndefined();
    expect(fontStack(FONTS[0]!)).toContain(FONTS[0]!.family);
    expect(fontStack(FONTS[0]!)).toMatch(/sans-serif|serif$/);
  });
  it('resolveFontByValue は生 family・fontStack・旧フォールバックスタックのいずれも照合する', () => {
    const font = FONTS.find(f => f.id === 'noto-serif-jp')!;
    expect(resolveFontByValue(font.family)).toBe(font);
    expect(resolveFontByValue(fontStack(font))).toBe(font);
    expect(resolveFontByValue('"Noto Serif JP", "Hiragino Mincho ProN", serif')).toBe(font);
    expect(resolveFontByValue('"Legacy Face", serif')).toBeUndefined();
  });
  it('両方の HTML から読み込まれている', () => {
    for (const page of ['index.html', 'native-render.html'])
      expect(readFileSync(resolve(page), 'utf8')).toContain('/src/styles/fonts.css');
  });
});
