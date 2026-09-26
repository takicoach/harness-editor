import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from './cli';
import { loadStore } from './store';

let storeHome: string;
let root: string;
const originalHome = process.env.SUPERMOVIE_LEARNING_HOME;

beforeEach(() => {
  storeHome = mkdtempSync(join(tmpdir(), 'sm-store-'));
  root = mkdtempSync(join(tmpdir(), 'sm-proj-'));
  process.env.SUPERMOVIE_LEARNING_HOME = storeHome;
});
afterEach(() => {
  rmSync(storeHome, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
  if (originalHome === undefined) delete process.env.SUPERMOVIE_LEARNING_HOME;
  else process.env.SUPERMOVIE_LEARNING_HOME = originalHome;
});

describe('runCli', () => {
  it('start と finish で語句辞書へ昇格する', () => {
    writeFileSync(
      join(root, 'transcript_fixed.json'),
      JSON.stringify({ segments: [{ text: 'ゼロ式', start: 0, end: 1 }] }),
    );
    expect(runCli(['start', '--project', root]).code).toBe(0);
    writeFileSync(
      join(root, 'transcript_fixed.json'),
      JSON.stringify({ segments: [{ text: '零式', start: 0, end: 1 }] }),
    );
    expect(runCli(['finish', '--project', root, '--video', 'drill-01']).code).toBe(0);
    expect(loadStore().typoDict.replace).toEqual({ ゼロ: '零' });
  });

  it('unlearn は語句を取り消す', () => {
    writeFileSync(
      join(root, 'transcript_fixed.json'),
      JSON.stringify({ segments: [{ text: 'ゼロ式', start: 0, end: 1 }] }),
    );
    runCli(['start', '--project', root]);
    writeFileSync(
      join(root, 'transcript_fixed.json'),
      JSON.stringify({ segments: [{ text: '零式', start: 0, end: 1 }] }),
    );
    runCli(['finish', '--project', root, '--video', 'drill-01']);
    expect(runCli(['unlearn', 'ゼロ']).code).toBe(0);
    expect(loadStore().typoDict.replace).toEqual({});
  });

  it('不明なコマンドは code 1 を返す', () => {
    expect(runCli(['bogus']).code).toBe(1);
  });

  it('undo はバックアップが無ければ code 1 を返す', () => {
    expect(runCli(['undo']).code).toBe(1);
  });

  it('unlearn は語句指定が無ければ code 1 を返す', () => {
    expect(runCli(['unlearn']).code).toBe(1);
  });
});
