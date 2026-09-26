import { open, type FileHandle } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { ScenePlan } from '../../core/sequence/scenePlan';
import { mixAudioBlock, pcmKey, pcmReadRanges, sequenceSampleCount, type WindowedPcm } from '../../preview/native/audioMixer';
import { prepareSequenceAudio } from './media';
import { verifiedSequenceAssetPath } from './assets';

/** Offline and preview share the mixer. Only the requested source windows are resident. */
export async function writeSequenceAudio(plan: ScenePlan, projectDirectory: string, destination: string, signal: AbortSignal,
  progress: (sample: number, total: number) => void = () => undefined): Promise<{ sampleCount: number; sha256: string; peakWindowBytes: number }> {
  const sources = new Map<string, WindowedPcm>(), handles = new Map<string, FileHandle>();
  const windows = new Map<string, Array<{ start: number; data: Buffer }>>();
  const count = sequenceSampleCount(plan, 48000), digest = createHash('sha256');
  let output: FileHandle | undefined, peakWindowBytes = 0;
  try {
    for (const clip of plan.audibleClips) {
      signal.throwIfAborted(); const content = clip.content; if (content.kind !== 'audio') continue;
      const key = pcmKey(content.assetId, content.streamIndex, content.rate); if (sources.has(key)) continue;
      const asset = plan.document.assets.find(a => a.id === content.assetId)!;
      await verifiedSequenceAssetPath(projectDirectory, asset, signal);
      const prepared = await prepareSequenceAudio(projectDirectory, asset, content.streamIndex, content.rate, signal);
      handles.set(key, await open(prepared.file, 'r'));
      sources.set(key, { sampleRate: prepared.sampleRate, sampleCount: prepared.sampleCount, assetId: asset.id, streamIndex: content.streamIndex, rate: content.rate,
        sample(channel, index) {
          const window = windows.get(key)?.find(w => index >= w.start && index < w.start + w.data.length / 8);
          if (!window) throw new Error(`音声の読込範囲が不足しています: ${key} / ${index}`);
          return window.data.readFloatLE((index - window.start) * 8 + channel * 4);
        } });
    }
    output = await open(destination, 'wx', 0o600);
    for (let start = 0; start < count; start += 4096) {
      signal.throwIfAborted(); const length = Math.min(4096, count - start);
      windows.clear(); let bytes = 0;
      for (const [key, ranges] of pcmReadRanges(plan, sources, start, length)) {
        const parts = [];
        for (const range of ranges) {
          const data = Buffer.alloc((range.to - range.from) * 8); let offset = 0;
          while (offset < data.length) {
            const read = await handles.get(key)!.read(data, offset, data.length - offset, range.from * 8 + offset);
            if (!read.bytesRead) throw new Error('準備した音声が途中で終了しました'); offset += read.bytesRead;
          }
          bytes += data.length; parts.push({ start: range.from, data });
        }
        windows.set(key, parts);
      }
      peakWindowBytes = Math.max(peakWindowBytes, bytes);
      const channels = mixAudioBlock(plan, sources, start, length), interleaved = Buffer.allocUnsafe(length * 8);
      for (let i = 0; i < length; i++) { interleaved.writeFloatLE(channels[0][i]!, i * 8); interleaved.writeFloatLE(channels[1][i]!, i * 8 + 4); }
      digest.update(interleaved); await output.writeFile(interleaved); progress(start + length, count);
    }
    await output.sync();
    return { sampleCount: count, sha256: digest.digest('hex'), peakWindowBytes };
  } finally { await output?.close(); await Promise.all([...handles.values()].map(handle => handle.close())); }
}
