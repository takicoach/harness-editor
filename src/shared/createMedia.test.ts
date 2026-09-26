import { describe, expect, it } from 'vitest';
import {
  AUDIO_EXTENSIONS, CREATE_MEDIA_ACCEPT, CREATE_MEDIA_EXTENSIONS, IMAGE_EXTENSIONS, MAX_CREATE_IMAGE_BYTES, MIXED_MEDIA_MESSAGE,
  classifyCreateSelection, createMediaKind, imageLimitMessage,
} from './createMedia';
import { VIDEO_EXTENSIONS } from './videoExtensions';
import { BROWSE_MEDIA_EXTENSIONS } from '../server/browsePaths';

describe('作成で受け付ける素材（設計 M5）', () => {
  it('動画の定数は旧機能と共有のまま変えず、作成用は動画＋音声＋画像', () => {
    expect(VIDEO_EXTENSIONS).toEqual(['.mp4', '.mov', '.webm', '.m4v']);
    expect(CREATE_MEDIA_EXTENSIONS).toEqual([...VIDEO_EXTENSIONS, ...AUDIO_EXTENSIONS, ...IMAGE_EXTENSIONS]);
    for (const extension of CREATE_MEDIA_EXTENSIONS) expect(CREATE_MEDIA_ACCEPT.split(',')).toContain(extension);
  });
  it('フォルダから選ぶ（media=all）と同じ集合', () => {
    expect(BROWSE_MEDIA_EXTENSIONS).toEqual(['.mp4', '.mov', '.webm', '.m4v', '.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg',
      '.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif', '.bmp']);
    expect(BROWSE_MEDIA_EXTENSIONS).toEqual(CREATE_MEDIA_EXTENSIONS);
  });
  it.each([['take.MP4', 'video'], ['talk.mp3', 'audio'], ['cover.JPG', 'image'], ['notes.txt', null], ['noext', null], ['look.cube', null]] as const)(
    '%s は %s', (name, kind) => { expect(createMediaKind(name)).toBe(kind); });
});

describe('1回の作成で1種類（設計 M1）', () => {
  it('同じ種類はその種類と件数を返す', () => {
    expect(classifyCreateSelection(['b.png', 'a.jpg'])).toEqual({ ok: true, kind: 'image', count: 2 });
    expect(classifyCreateSelection(['a.mp4', 'b.mov'])).toEqual({ ok: true, kind: 'video', count: 2 });
    expect(classifyCreateSelection(['talk.wav'])).toEqual({ ok: true, kind: 'audio', count: 1 });
  });
  it('混在は案内だけ（作成しない）', () => {
    expect(classifyCreateSelection(['talk.mp3', 'cover.png'])).toEqual({ ok: false, reason: 'mixed', message: MIXED_MEDIA_MESSAGE });
    expect(MIXED_MEDIA_MESSAGE).toBe('動画・音声・画像のどれか1種類を選んでください');
  });
  it('受け付けない拡張子が1つでもあれば、対応の拡張子を示して断る', () => {
    const result = classifyCreateSelection(['a.png', 'notes.txt']);
    expect(result).toMatchObject({ ok: false, reason: 'unsupported' });
    expect(result.ok ? '' : result.message).toContain('.mp3');
    expect(classifyCreateSelection([])).toMatchObject({ ok: false, reason: 'empty' });
  });
});

describe('複数画像の上限（設計 M3b: 200 枚・合計 2GB）', () => {
  it('ちょうど上限は通し、1つでも超えたら理由を返す', () => {
    expect(imageLimitMessage(200, MAX_CREATE_IMAGE_BYTES)).toBeNull();
    expect(imageLimitMessage(201, 10)).toContain('200枚');
    expect(imageLimitMessage(2, MAX_CREATE_IMAGE_BYTES + 1)).toContain('合計2GB');
  });
});
