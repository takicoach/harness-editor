import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const control = vi.hoisted(() => ({ afterCopy: undefined as undefined | ((source: string) => Promise<void>) }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, copyFile: async (...args: Parameters<typeof actual.copyFile>) => {
    await actual.copyFile(...args);
    await control.afterCopy?.(String(args[0]));
  } };
});
import { createRenderInputSnapshot, RenderInputChangedError } from './renderInputSnapshot';

describe('render input snapshots', () => {
  let root: string;
  let project: string;
  let temporary: string;
  let controller: AbortController;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sme-snapshot-test-'));
    project = join(root, 'project');
    temporary = join(root, 'temporary');
    mkdirSync(join(project, 'src'), { recursive: true });
    mkdirSync(join(project, 'public'));
    mkdirSync(temporary);
    writeFileSync(join(project, 'src', 'Root.tsx'), 'saved old composition');
    writeFileSync(join(project, 'public', 'voice.wav'), Buffer.from([1, 2, 3, 4]));
    controller = new AbortController();
    control.afterCopy = undefined;
  });
  afterEach(() => { control.afterCopy = undefined; rmSync(root, { recursive: true, force: true }); });
  const paths = ['src/Root.tsx', 'public/voice.wav'];
  const capture = () => createRenderInputSnapshot({ projectDir: project, files: paths, signal: controller.signal, tempRoot: temporary });

  it('keeps old source and media after ordinary in-place saves and releases only its own files', async () => {
    const snapshot = await capture();
    writeFileSync(join(project, paths[0]!), 'new composition');
    writeFileSync(join(project, paths[1]!), Buffer.from([9, 8, 7, 6]));
    expect(readFileSync(join(snapshot.projectDir, paths[0]!), 'utf8')).toBe('saved old composition');
    expect(readFileSync(join(snapshot.projectDir, paths[1]!))).toEqual(Buffer.from([1, 2, 3, 4]));
    expect(statSync(join(snapshot.projectDir, paths[1]!)).ino).not.toBe(statSync(join(project, paths[1]!)).ino);
    controller.abort(); // Ownership has transferred; this must not invalidate a successful render input.
    expect(existsSync(snapshot.projectDir)).toBe(true);
    snapshot.cleanup(); snapshot.cleanup();
    expect(readdirSync(temporary)).toEqual([]);
    expect(readFileSync(join(project, paths[0]!), 'utf8')).toBe('new composition');
  });

  it('materializes an external media link without retaining a mutable link', async () => {
    const media = join(root, 'external.wav');
    writeFileSync(media, 'original media');
    symlinkSync(media, join(project, 'public', 'linked.wav'));
    const snapshot = await createRenderInputSnapshot({ projectDir: project, files: ['public/linked.wav'], signal: controller.signal, tempRoot: temporary });
    expect(lstatSync(join(snapshot.projectDir, 'public/linked.wav')).isSymbolicLink()).toBe(false);
    writeFileSync(media, 'changed media');
    expect(readFileSync(join(snapshot.projectDir, 'public/linked.wav'), 'utf8')).toBe('original media');
    snapshot.cleanup();
    expect(readFileSync(media, 'utf8')).toBe('changed media');
  });

  it('rejects edits to an already copied file while a later input is copied', async () => {
    control.afterCopy = async (source) => {
      if (source.endsWith('voice.wav')) writeFileSync(join(project, paths[0]!), 'changed during media copy');
    };
    await expect(capture()).rejects.toBeInstanceOf(RenderInputChangedError);
    expect(readdirSync(temporary)).toEqual([]);
    expect(readFileSync(join(project, paths[0]!), 'utf8')).toBe('changed during media copy');
  });

  it('rejects same-size mutation even if the source mtime is restored', async () => {
    const media = realpathSync(join(project, paths[1]!));
    const previous = statSync(media);
    let mutated = false;
    control.afterCopy = async (source) => {
      if (source === media) {
        writeFileSync(media, Buffer.from([9, 8, 7, 6]));
        utimesSync(media, previous.atime, previous.mtime);
        mutated = true;
      }
    };
    await expect(capture()).rejects.toBeInstanceOf(RenderInputChangedError);
    expect(mutated).toBe(true);
    expect(readdirSync(temporary)).toEqual([]);
  });

  it('waits for an in-flight copy before abort cleanup and never returns partial inputs', async () => {
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    const continued = new Promise<void>((resolve) => { release = resolve; });
    control.afterCopy = async () => { entered(); await continued; };
    let settled = false;
    const pending = capture();
    const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    void pending.then(() => { settled = true; }, () => { settled = true; });
    await waiting;
    controller.abort();
    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    await rejection;
    expect(readdirSync(temporary)).toEqual([]);
    expect(readFileSync(join(project, paths[1]!))).toEqual(Buffer.from([1, 2, 3, 4]));
  });

  it('allocates nothing for an already aborted request or an invalid path', async () => {
    controller.abort();
    await expect(capture()).rejects.toMatchObject({ name: 'AbortError' });
    controller = new AbortController();
    for (const file of ['../outside', '/outside', 'C:\\outside', 'src/../file', 'src//file', 'node_modules/pkg/index.js']) {
      await expect(createRenderInputSnapshot({ projectDir: project, files: [file], signal: controller.signal, tempRoot: temporary })).rejects.toThrow('Invalid render input path');
    }
    expect(readdirSync(temporary)).toEqual([]);
  });

  it('removes partial files on copy errors without deleting either source or other snapshots', async () => {
    const successful = await capture();
    control.afterCopy = async () => { throw new Error('simulated disk failure'); };
    await expect(capture()).rejects.toThrow('simulated disk failure');
    expect(readdirSync(temporary)).toHaveLength(1);
    expect(existsSync(join(successful.projectDir, paths[0]!))).toBe(true);
    expect(existsSync(join(project, paths[0]!))).toBe(true);
    successful.cleanup();
    expect(readdirSync(temporary)).toEqual([]);
  });
});
