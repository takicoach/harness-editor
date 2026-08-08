import { describe, it, expect, vi } from 'vitest';
import {
  previewProxyName,
  resolvePreviewVideoPath,
  resolveVideoPathForVersion,
  buildPreviewSyncArgs,
  syncPreviewProxyAudio,
} from './previewProxy';

describe('previewProxyName', () => {
  it('拡張子を .preview.mp4 へ置き換える', () => {
    expect(previewProxyName('main.mp4')).toBe('main.preview.mp4');
  });
  it('mp4 以外の拡張子でもプロキシは .preview.mp4', () => {
    expect(previewProxyName('clip.MOV')).toBe('clip.preview.mp4');
  });
  it('拡張子なしでも .preview.mp4 を付ける', () => {
    expect(previewProxyName('movie')).toBe('movie.preview.mp4');
  });
});

describe('resolvePreviewVideoPath', () => {
  const pub = '/proj/public';
  it('プロキシが存在すればプロキシを優先する', () => {
    const exists = (p: string) => p === '/proj/public/main.preview.mp4';
    expect(resolvePreviewVideoPath(pub, 'main.mp4', exists)).toBe('/proj/public/main.preview.mp4');
  });
  it('プロキシが無ければ元動画へフォールバックする', () => {
    const exists = () => false;
    expect(resolvePreviewVideoPath(pub, 'main.mp4', exists)).toBe('/proj/public/main.mp4');
  });
  it('要求されたファイル自体がプロキシ名なら二重付与せず元へフォールバック', () => {
    // main.preview.preview.mp4 は存在しないので main.preview.mp4 を返す
    const exists = () => false;
    expect(resolvePreviewVideoPath(pub, 'main.preview.mp4', exists)).toBe('/proj/public/main.preview.mp4');
  });
});

describe('buildPreviewSyncArgs', () => {
  it('preview 映像（コピー）+ main 音声（aac）で差し替える ffmpeg 引数', () => {
    expect(
      buildPreviewSyncArgs({
        previewIn: '/pub/main.preview.mp4',
        mainIn: '/pub/main.mp4',
        output: '/pub/.tmp.mp4',
      }),
    ).toEqual([
      '-y',
      '-i', '/pub/main.preview.mp4',
      '-i', '/pub/main.mp4',
      '-map', '0:v',
      '-map', '1:a',
      '-c:v', 'copy',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-shortest',
      '/pub/.tmp.mp4',
    ]);
  });
});

describe('syncPreviewProxyAudio', () => {
  const VDIR = '/proj/public';

  it('プロキシが無ければ何もしない（spawn も rename もしない）', () => {
    const spawnSync = vi.fn((_cmd: string, _args: string[]) => ({ status: 0 as number | null }));
    const rename = vi.fn();
    syncPreviewProxyAudio(VDIR, 'main.mp4', 'ffmpeg', { exists: () => false, spawnSync, rename });
    expect(spawnSync).not.toHaveBeenCalled();
    expect(rename).not.toHaveBeenCalled();
  });

  it('プロキシがあれば preview 映像+main 音声で ffmpeg を呼び、成功で preview へ rename する', () => {
    const spawnSync = vi.fn((_cmd: string, _args: string[]) => ({ status: 0 as number | null }));
    const rename = vi.fn();
    syncPreviewProxyAudio(VDIR, 'main.mp4', 'ffmpeg', { exists: () => true, spawnSync, rename });
    expect(spawnSync).toHaveBeenCalledTimes(1);
    const [bin, args] = spawnSync.mock.calls[0]!;
    expect(bin).toBe('ffmpeg');
    // 入力1 が preview、映像コピーが含まれる
    expect(args[args.indexOf('-i') + 1]).toBe('/proj/public/main.preview.mp4');
    expect(args).toContain('-c:v');
    // 一時出力を最終的に preview へ置き換える（同一ディレクトリ rename）
    expect(rename).toHaveBeenCalledTimes(1);
    const [, dest] = rename.mock.calls[0]!;
    expect(dest).toBe('/proj/public/main.preview.mp4');
  });

  it('ffmpeg が非0で終わったら rename しない（preview は元のまま・無害）', () => {
    const spawnSync = vi.fn((_cmd: string, _args: string[]) => ({ status: 1 as number | null }));
    const rename = vi.fn();
    syncPreviewProxyAudio(VDIR, 'main.mp4', 'ffmpeg', { exists: () => true, spawnSync, rename });
    expect(rename).not.toHaveBeenCalled();
  });
});

describe('resolveVideoPathForVersion', () => {
  const publicDir = '/pj/public';
  const original = '/pj/public/main.mp4';
  const proxy = '/pj/public/main.preview.mp4';
  const bothExist = (p: string) => p === original || p === proxy;
  const statOriginal = () => ({ size: 1000, mtimeMs: 5000 });

  it('?v= が原本の現トークンと一致する間は原本を返し続ける（開きっぱなしの video を壊さない）', () => {
    const path = resolveVideoPathForVersion(publicDir, 'main.mp4', '1000-5000', {
      exists: bothExist,
      stat: statOriginal,
    });
    expect(path).toBe(original);
  });

  it('?v= がプロキシ版（原本と不一致）なら従来どおりプロキシを返す', () => {
    const path = resolveVideoPathForVersion(publicDir, 'main.mp4', '2222-9999', {
      exists: bothExist,
      stat: statOriginal,
    });
    expect(path).toBe(proxy);
  });

  it('?v= なしはプロキシ優先（従来挙動）', () => {
    const path = resolveVideoPathForVersion(publicDir, 'main.mp4', null, {
      exists: bothExist,
      stat: statOriginal,
    });
    expect(path).toBe(proxy);
  });

  it('プロキシが無ければ ?v= に関わらず原本', () => {
    const path = resolveVideoPathForVersion(publicDir, 'main.mp4', '1000-5000', {
      exists: (p: string) => p === original,
      stat: statOriginal,
    });
    expect(path).toBe(original);
  });

  it('原本の stat 失敗はプロキシ優先へフォールバック', () => {
    const path = resolveVideoPathForVersion(publicDir, 'main.mp4', '1000-5000', {
      exists: bothExist,
      stat: () => {
        throw new Error('EACCES');
      },
    });
    expect(path).toBe(proxy);
  });
});
