import type { SequenceDocument } from './model';
import { rational as r } from './time';

export function fixture(): SequenceDocument {
  const clock = { offset: r(0), rate: r(1), duration: r(300) };
  return {
    schemaVersion: 2, id: 'sequence', name: '検証', revision: 0, fps: r(30), resolution: { width: 1920, height: 1080 },
    sequenceEndFrame: 300, background: '#000000', ducking: { enabled: false, strength: 'mid' },
    assets: [{ id: 'source', kind: 'media', file: 'public/source.mp4', name: '映像', fingerprint: 'test-source', streams: [
      { index: 0, kind: 'video', codec: 'h264', duration: r(60), frameRate: r(30), width: 1920, height: 1080 },
      { index: 1, kind: 'audio', codec: 'aac', duration: r(60), sampleRate: 48000, channels: 2 },
    ] }],
    tracks: [
      { id: 'v1', kind: 'visual', name: '映像1', enabled: true },
      { id: 'v2', kind: 'visual', name: '字幕', enabled: true },
      { id: 'a1', kind: 'audio', name: '音声1', enabled: true },
      { id: 'a2', kind: 'audio', name: '音楽', enabled: true },
    ],
    clips: [
      { id: 'video', name: '映像', trackId: 'v1', startFrame: 0, durationFrames: 300, clock: structuredClone(clock), linkGroupId: 'linked',
        content: { kind: 'video', assetId: 'source', streamIndex: 0, sourceIn: r(0), rate: r(1) } },
      { id: 'audio', name: '音声', trackId: 'a1', startFrame: 0, durationFrames: 300, clock: structuredClone(clock), linkGroupId: 'linked',
        content: { kind: 'audio', assetId: 'source', streamIndex: 1, sourceIn: r(0), rate: r(1), role: 'speech', loop: false,
          settings: { gainDb: 0, muted: false, fadeInFrames: 0, fadeOutFrames: 0 } } },
      { id: 'telop', name: '字幕', trackId: 'v2', startFrame: 30, durationFrames: 240,
        clock: { offset: r(0), rate: r(1), duration: r(240) }, content: { kind: 'telop', data: { text: '元の発話に対応' } },
        anchor: { kind: 'source', role: 'speech', sourceAssetId: 'source', clipOccurrenceId: 'audio', sourceStart: r(1), sourceEnd: r(9) } },
      { id: 'music', name: '音楽', trackId: 'a2', startFrame: 0, durationFrames: 360, clock: { ...structuredClone(clock), duration: r(360) },
        content: { kind: 'audio', assetId: 'source', streamIndex: 1, sourceIn: r(0), rate: r(1), role: 'music', loop: false,
          settings: { gainDb: -12, muted: false, fadeInFrames: 0, fadeOutFrames: 60 } } },
    ], transitions: [], transcripts: [],
  };
}
