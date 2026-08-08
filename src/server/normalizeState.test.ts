import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  backupName,
  ensureBackup,
  resolveInputFromBackup,
  readNormalizeMarker,
  writeNormalizeMarker,
  isNormalizeApplied,
  restoreFromBackup,
} from './normalizeState';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'sme-norm-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('backupName', () => {
  it('main.mp4 → main.normalize-backup.mp4', () => {
    expect(backupName('main.mp4')).toBe('main.normalize-backup.mp4');
  });
});

describe('ensureBackup', () => {
  it('原本が無ければ null', () => {
    expect(ensureBackup(dir, 'main.mp4')).toBeNull();
  });
  it('初回は原本をコピーしてバックアップを作る（冪等・上書きしない）', () => {
    writeFileSync(join(dir, 'main.mp4'), 'ORIGINAL');
    const bak = ensureBackup(dir, 'main.mp4');
    expect(bak).toBe(join(dir, 'main.normalize-backup.mp4'));
    expect(readFileSync(bak!, 'utf8')).toBe('ORIGINAL');
    // 原本を書き換えても再 ensure でバックアップは保護される
    writeFileSync(join(dir, 'main.mp4'), 'CHANGED');
    ensureBackup(dir, 'main.mp4');
    expect(readFileSync(join(dir, 'main.normalize-backup.mp4'), 'utf8')).toBe('ORIGINAL');
  });
});

describe('resolveInputFromBackup', () => {
  it('バックアップがあればそれを、無ければ原本を返す', () => {
    expect(resolveInputFromBackup(dir, 'main.mp4')).toBe(join(dir, 'main.mp4'));
    writeFileSync(join(dir, 'main.normalize-backup.mp4'), 'BAK');
    expect(resolveInputFromBackup(dir, 'main.mp4')).toBe(join(dir, 'main.normalize-backup.mp4'));
  });
});

describe('marker 読み書き・適用判定', () => {
  it('write→read が往復し、isNormalizeApplied が applied を返す', () => {
    expect(readNormalizeMarker(dir)).toBeNull();
    expect(isNormalizeApplied(dir)).toBe(false);
    writeNormalizeMarker(dir, { applied: true, strength: 'standard', backupRel: 'main.normalize-backup.mp4' });
    expect(readNormalizeMarker(dir)).toEqual({ applied: true, strength: 'standard', backupRel: 'main.normalize-backup.mp4' });
    expect(isNormalizeApplied(dir)).toBe(true);
    writeNormalizeMarker(dir, { applied: false, strength: 'standard', backupRel: 'main.normalize-backup.mp4' });
    expect(isNormalizeApplied(dir)).toBe(false);
  });
  it('壊れた JSON は null', () => {
    writeFileSync(join(dir, 'normalize.json'), '{ broken');
    expect(readNormalizeMarker(dir)).toBeNull();
  });
});

describe('restoreFromBackup', () => {
  it('バックアップから原本を復元する', () => {
    writeFileSync(join(dir, 'main.mp4'), 'PROCESSED');
    writeFileSync(join(dir, 'main.normalize-backup.mp4'), 'ORIGINAL');
    expect(restoreFromBackup(dir, 'main.mp4')).toBe(true);
    expect(readFileSync(join(dir, 'main.mp4'), 'utf8')).toBe('ORIGINAL');
  });
  it('バックアップが無ければ false', () => {
    expect(restoreFromBackup(dir, 'main.mp4')).toBe(false);
  });
});
