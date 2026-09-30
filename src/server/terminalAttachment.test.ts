import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { removeTerminalAttachments, terminalAttachmentRoot } from './terminalAttachment';

// os.tmpdir() は呼ぶたびに TMPDIR を読むため、テスト専用の一時領域へ向け替える。
let previous: string | undefined;
let area: string;
beforeEach(() => {
  previous = process.env.TMPDIR;
  area = realpathSync(mkdtempSync(join(tmpdir(), 'sme-drop-area-')));
  process.env.TMPDIR = area;
  removeTerminalAttachments();
});
afterEach(() => {
  removeTerminalAttachments();
  if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous;
  rmSync(area, { recursive: true, force: true });
});

describe('ターミナルへのドロップの一時フォルダ', () => {
  it('終了時の回収で今回のフォルダを中身ごと消し、次の利用では新しいフォルダを作る', () => {
    const root = terminalAttachmentRoot();
    mkdirSync(join(root, 'one'));
    writeFileSync(join(root, 'one', 'clip.mov'), 'x');
    removeTerminalAttachments();
    expect(existsSync(root)).toBe(false);
    const next = terminalAttachmentRoot();
    expect(next).not.toBe(root);
    expect(dirname(next)).toBe(area);
  });

  it('作成時に、1日より古い残骸だけを消す（新しいもの・無関係な名前は残す）', () => {
    const stale = join(area, 'harness-editor-terminal-drops-stale');
    const fresh = join(area, 'harness-editor-terminal-drops-fresh');
    const other = join(area, 'unrelated-folder');
    for (const folder of [stale, fresh, other]) { mkdirSync(folder); writeFileSync(join(folder, 'a.png'), 'x'); }
    const twoDaysAgo = (Date.now() - 2 * 24 * 60 * 60 * 1000) / 1000;
    utimesSync(stale, twoDaysAgo, twoDaysAgo);
    utimesSync(other, twoDaysAgo, twoDaysAgo);

    const root = terminalAttachmentRoot();
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(other)).toBe(true);
    expect(basename(root).startsWith('harness-editor-terminal-drops-')).toBe(true);
  });
});
