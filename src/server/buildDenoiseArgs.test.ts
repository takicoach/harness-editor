import { describe, it, expect } from 'vitest';
import { strengthToNr, buildDenoiseArgs } from './buildDenoiseArgs';

describe('strengthToNr', () => {
  it('weak → 6', () => {
    expect(strengthToNr('weak')).toBe(6);
  });

  it('mid → 12', () => {
    expect(strengthToNr('mid')).toBe(12);
  });

  it('strong → 21', () => {
    expect(strengthToNr('strong')).toBe(21);
  });

  it('省略時（undefined）は mid=12 を返す（既定値）', () => {
    expect(strengthToNr(undefined)).toBe(12);
  });
});

describe('buildDenoiseArgs', () => {
  const base = {
    input: '/projects/sample/public/main.mp4',
    output: '/tmp/main.denoise-out.mp4',
    strength: 'mid' as const,
  };

  it('-y が先頭に入る', () => {
    const args = buildDenoiseArgs(base);
    expect(args[0]).toBe('-y');
  });

  it('-i <input> を含む', () => {
    const args = buildDenoiseArgs(base);
    const iIdx = args.indexOf('-i');
    expect(iIdx).toBeGreaterThan(-1);
    expect(args[iIdx + 1]).toBe(base.input);
  });

  it('-af afftdn=nr=<dB> を含む（mid=12）', () => {
    const args = buildDenoiseArgs(base);
    const afIdx = args.indexOf('-af');
    expect(afIdx).toBeGreaterThan(-1);
    expect(args[afIdx + 1]).toBe('afftdn=nr=12');
  });

  it('-af afftdn=nr=6（weak）', () => {
    const args = buildDenoiseArgs({ ...base, strength: 'weak' });
    const afIdx = args.indexOf('-af');
    expect(args[afIdx + 1]).toBe('afftdn=nr=6');
  });

  it('-af afftdn=nr=21（strong）', () => {
    const args = buildDenoiseArgs({ ...base, strength: 'strong' });
    const afIdx = args.indexOf('-af');
    expect(args[afIdx + 1]).toBe('afftdn=nr=21');
  });

  it('-c:v copy を含む（映像コピー）', () => {
    const args = buildDenoiseArgs(base);
    const vIdx = args.indexOf('-c:v');
    expect(vIdx).toBeGreaterThan(-1);
    expect(args[vIdx + 1]).toBe('copy');
  });

  it('-c:a aac を含む', () => {
    const args = buildDenoiseArgs(base);
    const aIdx = args.indexOf('-c:a');
    expect(aIdx).toBeGreaterThan(-1);
    expect(args[aIdx + 1]).toBe('aac');
  });

  it('-b:a 192k を含む', () => {
    const args = buildDenoiseArgs(base);
    const baIdx = args.indexOf('-b:a');
    expect(baIdx).toBeGreaterThan(-1);
    expect(args[baIdx + 1]).toBe('192k');
  });

  it('output が最後の引数', () => {
    const args = buildDenoiseArgs(base);
    expect(args[args.length - 1]).toBe(base.output);
  });

  it('strength を省略すると mid=12 が使われる', () => {
    const args = buildDenoiseArgs({ input: base.input, output: base.output });
    const afIdx = args.indexOf('-af');
    expect(args[afIdx + 1]).toBe('afftdn=nr=12');
  });
});
