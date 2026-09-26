/**
 * 0.3.1 からの更新でも、作品の保存先がエディター内の projects/ のままになることを確かめる。
 * npm を小さな偽物に替えて start.command を実行するため、実エディターは起動しない。
 */
import {describe, expect, it} from 'vitest';
import {chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {execFileSync} from 'node:child_process';

const ROOT = resolve(import.meta.dirname, '../..');

function editorCopy(): string {
  const editor = mkdtempSync(join(tmpdir(), 'start-script-'));
  copyFileSync(join(ROOT, 'start.command'), join(editor, 'start.command'));
  const bin = join(editor, 'fake-bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'npm'), '#!/bin/sh\necho "ROOT=$HARNESS_PROJECT_ROOT"\n');
  chmodSync(join(bin, 'npm'), 0o755);
  return editor;
}

function runStart(editor: string, env: Record<string, string> = {}): string {
  return execFileSync('/bin/bash', [join(editor, 'start.command')],
    {env: {PATH: `${join(editor, 'fake-bin')}:/usr/bin:/bin`, HOME: editor, ...env}, encoding: 'utf8'});
}

describe.skipIf(process.platform === 'win32')('start.command の作品の保存先', () => {
  it('新しい利用者: projects/ を作って使う', () => {
    const editor = editorCopy();
    try {
      expect(existsSync(join(editor, 'projects'))).toBe(false);
      expect(runStart(editor)).toContain(`ROOT=${join(editor, 'projects')}\n`);
      expect(existsSync(join(editor, 'projects'))).toBe(true);
    } finally { rmSync(editor, {recursive: true, force: true}); }
  });

  it('更新利用者: 既存の作品を保ったまま使う', () => {
    const editor = editorCopy();
    try {
      mkdirSync(join(editor, 'projects', 'my-work', 'src'), {recursive: true});
      writeFileSync(join(editor, 'projects', 'my-work', 'src', 'cutData.ts'), 'export const cutData = [];\n');
      expect(runStart(editor)).toContain(`ROOT=${join(editor, 'projects')}\n`);
      expect(readFileSync(join(editor, 'projects', 'my-work', 'src', 'cutData.ts'), 'utf8')).toBe('export const cutData = [];\n');
    } finally { rmSync(editor, {recursive: true, force: true}); }
  });

  it('新しい環境変数が旧名より優先される', () => {
    const editor = editorCopy();
    try {
      const other = join(editor, 'elsewhere'), legacy = join(editor, 'legacy');
      expect(runStart(editor, {SME_PROJECT_ROOT: legacy})).toContain(`ROOT=${legacy}\n`);
      expect(runStart(editor, {HARNESS_PROJECT_ROOT: other, SME_PROJECT_ROOT: legacy})).toContain(`ROOT=${other}\n`);
    } finally { rmSync(editor, {recursive: true, force: true}); }
  });
});

describe('start.bat の作品の保存先', () => {
  it('既定はエディター内の projects\\ で、無ければ作る', () => {
    const bat = readFileSync(join(ROOT, 'start.bat'), 'utf8');
    expect(bat).toContain('if "%HARNESS_PROJECT_ROOT%"=="" set "HARNESS_PROJECT_ROOT=%~dp0projects"');
    expect(bat).toContain('if not exist "%HARNESS_PROJECT_ROOT%" mkdir "%HARNESS_PROJECT_ROOT%"');
    expect(bat).not.toMatch(/USERPROFILE%\\Marketing/);
  });
});
