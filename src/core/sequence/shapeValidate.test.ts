import { describe, expect, it } from 'vitest';
import { validateSequenceDocument } from './validate';
import { rational as r } from './time';
import { fixture } from './fixtures';
import type { SequenceDocument } from './model';

function withShape(data: Record<string, unknown>): SequenceDocument {
  const doc = fixture();
  doc.clips.push({ id: 'shape', name: '図形', trackId: 'v2', startFrame: 0, durationFrames: 30,
    clock: { offset: r(0), rate: r(1), duration: r(30) },
    content: { kind: 'shape', data: { kind: 'rect', x1: .1, y1: .1, x2: .5, y2: .5, color: '#FF3B30', thickness: 'medium', ...data } as never } });
  return doc;
}

describe('図形の検証', () => {
  it('三角は 2 点だけで通る', () => {
    expect(() => validateSequenceDocument(withShape({ kind: 'triangle' }))).not.toThrow();
  });
  it('分度器は第 3 点が必須', () => {
    expect(() => validateSequenceDocument(withShape({ kind: 'angle' }))).toThrow('分度器');
  });
  it('分度器の第 3 点は数値', () => {
    expect(() => validateSequenceDocument(withShape({ kind: 'angle', x3: '0.5', y3: .2 }))).toThrow('分度器');
  });
  it('辺の長さ 0 の分度器は拒否する', () => {
    expect(() => validateSequenceDocument(withShape({ kind: 'angle', x1: .1, y1: .1, x2: .1, y2: .1, x3: .5, y3: .5 }))).toThrow('分度器');
  });
  it('分度器以外では第 3 点があっても無視する', () => {
    expect(() => validateSequenceDocument(withShape({ kind: 'rect', x3: 9, y3: 9 }))).not.toThrow();
  });
  it('未対応の形は拒否する', () => {
    expect(() => validateSequenceDocument(withShape({ kind: 'star' }))).toThrow('図形');
  });
  it('2 点と色・太さは全 kind で必須', () => {
    expect(() => validateSequenceDocument(withShape({ x2: undefined }))).toThrow('図形');
    expect(() => validateSequenceDocument(withShape({ thickness: 'huge' }))).toThrow('図形');
  });
});
