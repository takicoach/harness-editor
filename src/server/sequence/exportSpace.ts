import { statfs } from 'node:fs/promises';
import type { ScenePlan } from '../../core/sequence/scenePlan';
import { divideTime, timeNumber } from '../../core/sequence/time';
import { pcmKey, sequenceSampleCount } from '../../preview/native/audioMixer';

/** 書き出しの音声は 48kHz・2ch・float32（1サンプル 8 バイト）。media.ts の元音声の PCM と exportAudio.ts の混合後の一時ファイルが同じ形。 */
const PCM_BYTES_PER_SAMPLE = 8;
/** 動画本体（H.264）・参照フレーム・記録の分の余白。 */
export const EXPORT_SPACE_MARGIN_BYTES = 512 * 1024 * 1024;

/**
 * 書き出しに要る空き容量の見積もり（設計 M7b）: 混合後の一時音声 ＋ 鳴らす音声素材ごとの元音声の PCM ＋ 余白。
 * 元音声の PCM がキャッシュ済みでも数える（安全側。60分の音声作品でおよそ 3.1GB）。
 */
export function exportFreeSpaceRequirement(plan: ScenePlan): number {
  let bytes = sequenceSampleCount(plan, 48000) * PCM_BYTES_PER_SAMPLE + EXPORT_SPACE_MARGIN_BYTES;
  const seen = new Set<string>();
  for (const clip of plan.audibleClips) {
    const content = clip.content;
    if (content.kind !== 'audio') continue;
    const key = pcmKey(content.assetId, content.streamIndex, content.rate);
    if (seen.has(key)) continue;
    seen.add(key);
    const stream = plan.document.assets.find(asset => asset.id === content.assetId)?.streams.find(item => item.kind === 'audio' && item.index === content.streamIndex);
    if (stream) bytes += Math.ceil(timeNumber(divideTime(stream.duration, content.rate)) * 48000) * PCM_BYTES_PER_SAMPLE;
  }
  return bytes;
}

const gigabytes = (bytes: number) => (bytes / 1024 ** 3).toFixed(1);
/** 空きが見積もりより少なければ、理由を出して書き出しを止める（設計 M7b）。見積もりのバイト数を返す。 */
export async function assertExportFreeSpace(directory: string, plan: ScenePlan,
  measure: (path: string) => Promise<{ bavail: number; bsize: number }> = path => statfs(path)): Promise<number> {
  const required = exportFreeSpaceRequirement(plan), info = await measure(directory), available = Number(info.bavail) * Number(info.bsize);
  if (available < required) {
    throw new Error(`書き出しに必要な空き容量が足りません（必要: 約 ${gigabytes(required)} GB・空き: ${gigabytes(available)} GB）。不要なファイルを削除してから、もう一度書き出してください。`);
  }
  return required;
}
