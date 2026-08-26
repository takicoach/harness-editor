import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sanitizeUploadName, saveMaterialFile, isUploadKind, materialRelPath } from './uploadMaterial';
import { HttpError } from './http';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sme-upload-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('isUploadKind', () => {
  it('4種別のみ受け付ける', () => {
    expect(isUploadKind('se')).toBe(true);
    expect(isUploadKind('image')).toBe(true);
    expect(isUploadKind('bgm')).toBe(true);
    expect(isUploadKind('video')).toBe(true);
    expect(isUploadKind('telop')).toBe(false);
    expect(isUploadKind('')).toBe(false);
  });
});

describe('sanitizeUploadName', () => {
  it('種別に合う拡張子を受け付け、ベース名へ整える', () => {
    expect(sanitizeUploadName('se', 'ピロン.mp3')).toBe('ピロン.mp3');
    expect(sanitizeUploadName('image', '/Users/x/Desktop/photo.JPG')).toBe('photo.JPG');
    expect(sanitizeUploadName('video', 'C:\\movies\\clip.mp4')).toBe('clip.mp4');
  });
  it('NFD（macOS の濁点分解）を NFC へ正規化する', () => {
    const nfd = 'が.mp3'; // か + 結合濁点
    expect(sanitizeUploadName('se', nfd)).toBe('が.mp3');
  });
  it('種別に合わない拡張子・隠しファイル・空名は 400', () => {
    expect(() => sanitizeUploadName('image', 'song.mp3')).toThrow(HttpError);
    expect(() => sanitizeUploadName('se', 'movie.mp4')).toThrow(HttpError);
    expect(() => sanitizeUploadName('se', '.DS_Store')).toThrow(HttpError);
    expect(() => sanitizeUploadName('se', '')).toThrow(HttpError);
    expect(() => sanitizeUploadName('video', 'noext')).toThrow(HttpError);
  });
});

describe('saveMaterialFile', () => {
  /** アップロード受信済みの一時ファイルを模す（saveMaterialFile はここから移動する）。 */
  let tmpSeq = 0;
  function makeTmp(content: string): string {
    const path = join(dir, `upload-${tmpSeq++}.tmp`);
    writeFileSync(path, content);
    return path;
  }

  it('種別ごとの public サブディレクトリへ保存する（無ければ作る）', () => {
    const tmp = makeTmp('a');
    const r1 = saveMaterialFile(dir, 'se', 'pop.mp3', tmp);
    expect(r1.file).toBe('pop.mp3');
    expect(readFileSync(join(dir, 'public', 'se', 'pop.mp3'), 'utf8')).toBe('a');
    // 一時ファイルは移動されて残らない
    expect(existsSync(tmp)).toBe(false);

    const r2 = saveMaterialFile(dir, 'image', 'pic.png', makeTmp('b'));
    expect(readFileSync(join(dir, 'public', 'images', r2.file), 'utf8')).toBe('b');

    const r3 = saveMaterialFile(dir, 'bgm', 'song.wav', makeTmp('c'));
    expect(readFileSync(join(dir, 'public', 'BGM', r3.file), 'utf8')).toBe('c');

    // video は public 直下
    const r4 = saveMaterialFile(dir, 'video', 'clip.mp4', makeTmp('d'));
    expect(readFileSync(join(dir, 'public', r4.file), 'utf8')).toBe('d');
  });

  it('同名ファイルは上書きせず連番を付ける', () => {
    mkdirSync(join(dir, 'public', 'se'), { recursive: true });
    writeFileSync(join(dir, 'public', 'se', 'pop.mp3'), 'old');
    const r = saveMaterialFile(dir, 'se', 'pop.mp3', makeTmp('new'));
    expect(r.file).toBe('pop-2.mp3');
    expect(readFileSync(join(dir, 'public', 'se', 'pop.mp3'), 'utf8')).toBe('old');
    expect(readFileSync(join(dir, 'public', 'se', 'pop-2.mp3'), 'utf8')).toBe('new');
    const r2 = saveMaterialFile(dir, 'se', 'pop.mp3', makeTmp('newer'));
    expect(r2.file).toBe('pop-3.mp3');
  });

  it('不正な名前では一時ファイルを消費しない（400）', () => {
    const tmp = makeTmp('x');
    expect(() => saveMaterialFile(dir, 'se', 'movie.mp4', tmp)).toThrow(HttpError);
    expect(existsSync(tmp)).toBe(true);
  });
});

describe('materialRelPath（削除・使用中判定と共有する素材相対パス）', () => {
  it('種別サブディレクトリを反映する', () => {
    expect(materialRelPath('se', 'beep.mp3')).toBe(join('public', 'se', 'beep.mp3'));
    expect(materialRelPath('image', 'sub/logo.png')).toBe(join('public', 'images', 'sub/logo.png'));
    expect(materialRelPath('bgm', 'song.mp3')).toBe(join('public', 'BGM', 'song.mp3'));
    expect(materialRelPath('video', 'clip.mp4')).toBe(join('public', 'clip.mp4'));
  });
});
