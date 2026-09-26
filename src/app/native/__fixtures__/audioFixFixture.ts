import type { MediaStream, SequenceAsset, SequenceDocument } from '../../../core/sequence/model';
import { rational as r } from '../../../core/sequence/time';

export type AudioFix = 'denoise' | 'normalize';
const LABEL: Record<AudioFix, string> = { denoise: 'ノイズ除去', normalize: '音量正規化' };

const streams = (): MediaStream[] => [
  { index: 0, kind: 'video', codec: 'h264', duration: r(10), frameRate: r(30, 1), width: 1920, height: 1080 },
  { index: 1, kind: 'audio', codec: 'aac', duration: r(10), sampleRate: 48000, channels: 2 },
];

function asset(order: number, id: string, name: string, origin?: SequenceAsset['origin']): SequenceAsset {
  const fingerprint = String(order).padStart(64, '0');
  return { id, kind: 'media', file: `.harness/assets/${fingerprint}.mp4`, name, fingerprint, streams: streams(), ...(origin ? { origin } : {}) };
}

/** 原音 1 本の最小文書。applied に並べた順で補正済み asset の系譜を作る。 */
export function speechDocument({ applied = [], speech = true }: { applied?: AudioFix[]; speech?: boolean } = {}): SequenceDocument {
  const assets = [asset(1, 'source', 'main.mp4')];
  let current = 'source';
  applied.forEach((fix, index) => {
    const id = `source-${fix}`;
    assets.push(asset(index + 2, id, `main（${LABEL[fix]}）.mp4`, { kind: 'audio-fix', from: current, fix }));
    current = id;
  });
  return {
    schemaVersion: 2, id: 'doc', name: '案件', revision: 7, fps: r(30, 1),
    resolution: { width: 1920, height: 1080 }, sequenceEndFrame: 300, background: '#000000', assets,
    tracks: [{ id: 'a1', kind: 'audio', name: '原音', enabled: true }],
    clips: speech ? [{
      id: 'speech', trackId: 'a1', name: '原音', startFrame: 0, durationFrames: 300,
      clock: { offset: r(0), rate: r(1), duration: r(10) },
      content: { kind: 'audio', assetId: current, streamIndex: 1, sourceIn: r(0), rate: r(1), role: 'speech',
        settings: { gainDb: 0, muted: false, fadeInFrames: 0, fadeOutFrames: 0 }, loop: false },
    }] : [],
    transitions: [], transcripts: [], ducking: { enabled: false, strength: 'mid' },
  };
}
