import { describe, expect, it, vi } from 'vitest';
import { RemotePcm, remotePcmChunkIndexes } from './remotePcm';
import { rational } from '../../core/sequence/time';

// 10,500 sample = 区画 1,000 sample × 10 ＋ 端数 500。
const SAMPLES = 10_500, CHUNK = 1000, URL_ = '/api/sequence/audio/data?id=p&asset=a&stream=1&rateNum=1&rateDen=1';
const value = (channel: number, index: number) => channel === 0 ? index : -index;

interface FakeFetchOptions { status?: number; total?: number; gate?: () => Promise<void>; shortBy?: number }
function fakeFetch(records: string[], options: FakeFetchOptions = {}) {
  return vi.fn(async (_url: string, init?: RequestInit) => {
    const range = String((init?.headers as Record<string, string>).Range);
    records.push(range);
    if (init?.signal?.aborted) throw new DOMException('中止', 'AbortError');
    if (options.gate) {
      await Promise.race([options.gate(), new Promise<never>((_, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('中止', 'AbortError')), { once: true }))]);
    }
    if (options.status) return new Response(null, { status: options.status });
    const match = /^bytes=(\d+)-(\d+)$/.exec(range)!, start = Number(match[1]), end = Number(match[2]);
    const count = (end + 1 - start) / 8, first = start / 8, data = new Float32Array(count * 2);
    for (let i = 0; i < count; i++) { data[i * 2] = value(0, first + i); data[i * 2 + 1] = value(1, first + i); }
    const body = data.buffer.slice(0, data.byteLength - (options.shortBy ?? 0));
    return new Response(body, { status: 206, headers: { 'Content-Range': `bytes ${start}-${end}/${options.total ?? SAMPLES * 8}` } });
  });
}
function make(records: string[], options: FakeFetchOptions = {}, extra: Partial<ConstructorParameters<typeof RemotePcm>[0]> = {}) {
  return new RemotePcm({ url: URL_, sampleCount: SAMPLES, sampleRate: 48000, assetId: 'a', streamIndex: 1, rate: rational(1), chunkSamples: CHUNK,
    fetch: fakeFetch(records, options) as unknown as typeof fetch, ...extra });
}

describe('remotePcmChunkIndexes', () => {
  it('maps sample ranges to the chunks they touch', () => {
    expect(remotePcmChunkIndexes([{ from: 2500, to: 2600 }], CHUNK, SAMPLES)).toEqual([2]);
    expect(remotePcmChunkIndexes([{ from: 999, to: 1001 }, { from: 10_400, to: 10_500 }], CHUNK, SAMPLES)).toEqual([0, 1, 10]);
    expect(remotePcmChunkIndexes([{ from: 0, to: 0 }], CHUNK, SAMPLES)).toEqual([]);
    // 末尾の外は要求しない（補間の見張り sample が length を越えることがある）。
    expect(remotePcmChunkIndexes([{ from: 10_499, to: 10_503 }], CHUNK, SAMPLES)).toEqual([10]);
  });
});

describe('RemotePcm', () => {
  it('fetches only the chunk a range needs and reads both channels from it', async () => {
    const records: string[] = [], pcm = make(records);
    expect(pcm.has([{ from: 2500, to: 2600 }])).toBe(false);
    await pcm.ensure([{ from: 2500, to: 2600 }]);
    expect(records).toEqual(['bytes=16000-23999']);
    expect(pcm.has([{ from: 2500, to: 2600 }])).toBe(true);
    expect(pcm.has([{ from: 2000, to: 3000 }])).toBe(true);
    expect(pcm.sample(0, 2500)).toBe(2500);
    expect(pcm.sample(1, 2999)).toBe(-2999);
    expect(() => pcm.sample(0, 3000)).toThrow(/読込範囲/);
    expect(pcm.sampleCount).toBe(SAMPLES);
    expect(pcm.residentBytes).toBe(CHUNK * 8);
  });

  it('coalesces consecutive chunks into one request up to the per-request cap', async () => {
    const records: string[] = [], pcm = make(records, {}, { maxChunksPerRequest: 4 });
    await pcm.ensure([{ from: 0, to: 5500 }]);
    expect(records).toEqual(['bytes=0-31999', 'bytes=32000-47999']);
    for (let i = 0; i < 5500; i += 777) expect(pcm.sample(1, i)).toBe(-i);
  });

  it('reads the partial last chunk up to the real end', async () => {
    const records: string[] = [], pcm = make(records);
    await pcm.ensure([{ from: 10_400, to: 10_503 }]);
    expect(records).toEqual(['bytes=80000-83999']);
    expect(pcm.sample(0, 10_499)).toBe(10_499);
    expect(() => pcm.sample(0, 10_500)).toThrow(/読込範囲/);
  });

  it('shares one in-flight request between concurrent ensures', async () => {
    let open!: () => void; const gate = new Promise<void>(resolve => { open = resolve; });
    const records: string[] = [], pcm = make(records, { gate: () => gate });
    const first = pcm.ensure([{ from: 1000, to: 1500 }]), second = pcm.ensure([{ from: 1200, to: 1900 }]);
    expect(records).toEqual(['bytes=8000-15999']);
    open(); await Promise.all([first, second]);
    expect(records).toHaveLength(1);
    expect(pcm.has([{ from: 1000, to: 2000 }])).toBe(true);
    // 取得済みなら要求しない。
    await pcm.ensure([{ from: 1000, to: 2000 }]);
    expect(records).toHaveLength(1);
  });

  it('evicts the least recently used chunk beyond the residency budget', async () => {
    const records: string[] = [], pcm = make(records, {}, { residentChunks: 3 });
    for (const chunk of [0, 1, 2]) await pcm.ensure([{ from: chunk * CHUNK, to: chunk * CHUNK + 1 }]);
    expect(pcm.has([{ from: 0, to: 1 }])).toBe(true); // 区画 0 に触れて最近使った側へ
    await pcm.ensure([{ from: 3000, to: 3001 }]);
    expect(pcm.has([{ from: 1000, to: 1001 }])).toBe(false);
    expect(pcm.has([{ from: 0, to: 1 }])).toBe(true);
    expect(pcm.has([{ from: 2000, to: 2001 }])).toBe(true);
    expect(pcm.has([{ from: 3000, to: 3001 }])).toBe(true);
    expect(pcm.residentBytes).toBe(3 * CHUNK * 8);
    // 退避した区画は読み直せる。
    await pcm.ensure([{ from: 1000, to: 1001 }]);
    expect(pcm.sample(0, 1000)).toBe(1000);
    expect(records).toHaveLength(5);
  });

  it('never evicts a chunk the current request needs, even past the budget', async () => {
    const records: string[] = [], pcm = make(records, {}, { residentChunks: 2 });
    await pcm.ensure([{ from: 0, to: 4000 }]);
    expect(pcm.has([{ from: 0, to: 4000 }])).toBe(true);
    expect(pcm.residentBytes).toBe(4 * CHUNK * 8);
  });

  it('rejects a response that is not a partial content with the status', async () => {
    const records: string[] = [], pcm = make(records, { status: 200 });
    await expect(pcm.ensure([{ from: 0, to: 10 }])).rejects.toMatchObject({ status: 200, resource: 'pcm', message: expect.stringContaining('音声') });
    expect(pcm.has([{ from: 0, to: 10 }])).toBe(false);
    // 失敗した要求は次の ensure でやり直す。
    await expect(pcm.ensure([{ from: 0, to: 10 }])).rejects.toMatchObject({ status: 200 });
    expect(records).toHaveLength(2);
  });

  it('rejects a body whose length does not match the requested range', async () => {
    const records: string[] = [], pcm = make(records, { shortBy: 8 });
    await expect(pcm.ensure([{ from: 0, to: 10 }])).rejects.toThrow(/長さ/);
    expect(pcm.has([{ from: 0, to: 10 }])).toBe(false);
  });

  it('rejects a response whose total size disagrees with the declared sample count', async () => {
    const records: string[] = [], pcm = make(records, { total: SAMPLES * 8 + 8 });
    await expect(pcm.ensure([{ from: 0, to: 10 }])).rejects.toThrow(/長さ/);
  });

  it('dispose aborts in-flight requests and later ensures are refused', async () => {
    const records: string[] = [], pcm = make(records, { gate: () => new Promise(() => undefined) });
    const pending = pcm.ensure([{ from: 0, to: 10 }]);
    pcm.dispose();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await expect(pcm.ensure([{ from: 0, to: 10 }])).rejects.toThrow();
  });

  it('a caller signal only releases that caller; the shared request still completes', async () => {
    let open!: () => void; const gate = new Promise<void>(resolve => { open = resolve; });
    const records: string[] = [], pcm = make(records, { gate: () => gate });
    const controller = new AbortController();
    const cancelled = pcm.ensure([{ from: 0, to: 10 }], controller.signal), kept = pcm.ensure([{ from: 0, to: 10 }]);
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
    open(); await kept;
    expect(pcm.has([{ from: 0, to: 10 }])).toBe(true);
  });
});
