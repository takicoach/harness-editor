import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PRO_MARKER_FILE, detectEdition } from './edition';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const serverDir = () => { const dir = mkdtempSync(join(tmpdir(), 'sme-edition-')); dirs.push(dir); return dir; };

describe('detectEdition', () => {
  it('is free when the marker file is absent', () => {
    expect(detectEdition(serverDir())).toBe('free');
  });
  it('is paid when the marker file exists', () => {
    const dir = serverDir();
    mkdirSync(join(dir, 'proFeatures'));
    writeFileSync(join(dir, PRO_MARKER_FILE), '{}');
    expect(detectEdition(dir)).toBe('paid');
  });
  it('is free when the proFeatures folder exists but holds no marker', () => {
    const dir = serverDir();
    mkdirSync(join(dir, 'proFeatures'));
    expect(detectEdition(dir)).toBe('free');
  });
  it('is free for the shipped source tree, which has no marker', () => {
    expect(detectEdition()).toBe('free');
  });
});
