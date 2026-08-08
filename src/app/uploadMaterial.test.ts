import { describe, it, expect } from 'vitest';
import { classifyUploadKind } from './uploadMaterial';

describe('classifyUploadKind', () => {
  it('画像・動画は拡張子で一意に決まる', () => {
    expect(classifyUploadKind('photo.PNG', 'se')).toBe('image');
    expect(classifyUploadKind('pic.jpeg', 'bgm')).toBe('image');
    expect(classifyUploadKind('clip.mp4', 'se')).toBe('video');
    expect(classifyUploadKind('movie.MOV', 'image')).toBe('video');
  });
  it('音声は BGM タブなら bgm、それ以外のタブなら se', () => {
    expect(classifyUploadKind('song.mp3', 'bgm')).toBe('bgm');
    expect(classifyUploadKind('pop.wav', 'se')).toBe('se');
    expect(classifyUploadKind('pop.m4a', 'image')).toBe('se');
    expect(classifyUploadKind('pop.mp3', 'video')).toBe('se');
  });
  it('未対応拡張子は null', () => {
    expect(classifyUploadKind('doc.pdf', 'se')).toBeNull();
    expect(classifyUploadKind('archive.zip', 'image')).toBeNull();
    expect(classifyUploadKind('noext', 'se')).toBeNull();
  });
});
