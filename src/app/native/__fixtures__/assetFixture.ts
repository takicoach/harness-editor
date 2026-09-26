import type { CutArchiveEntry, CutArchiveGroup, SequenceAsset, SequenceClip, SequenceDocument } from '../../../core/sequence/model';
import { rational } from '../../../core/sequence/time';

type ClipInput = Partial<SequenceClip> & Pick<SequenceClip, 'content'>;

/** Fills the structural fields assetUsage never reads with tiny valid defaults. */
function buildClip(partial: ClipInput): SequenceClip {
  return {
    id: 'c', trackId: 't1', name: '', startFrame: 0, durationFrames: 1,
    clock: { offset: rational(0), rate: rational(1), duration: rational(1) },
    ...partial,
  };
}

interface CutArchiveEntryInput extends Partial<Omit<CutArchiveEntry, 'clips'>> {
  clips: ClipInput[];
}
interface DocumentOverrides {
  assets?: SequenceAsset[];
  clips?: ClipInput[];
  cutArchive?: { entries: CutArchiveEntryInput[]; groups?: CutArchiveGroup[] };
  rendering?: SequenceDocument['rendering'];
}

/** Minimal valid SequenceDocument with only the pieces assetUsage's tests exercise filled in. */
export function documentWith(overrides: DocumentOverrides): SequenceDocument {
  return {
    schemaVersion: 2, id: 'doc', name: 'doc', revision: 0, fps: rational(30, 1),
    resolution: { width: 1920, height: 1080 }, sequenceEndFrame: 100, background: '#000',
    assets: overrides.assets ?? [], tracks: [{ id: 't1', kind: 'audio', name: 'track', enabled: true }],
    clips: (overrides.clips ?? []).map(buildClip),
    transitions: [], transcripts: [], ducking: { enabled: false, strength: 'mid' },
    ...(overrides.cutArchive ? {
      cutArchive: {
        version: 1 as const,
        entries: overrides.cutArchive.entries.map((entry): CutArchiveEntry => ({
          id: entry.id ?? 'e1', durationFrames: entry.durationFrames ?? 1, completionFloorFrames: entry.completionFloorFrames ?? 1,
          origin: entry.origin ?? { cutId: 'cut', startFrame: 0, endFrame: 1 },
          boundary: entry.boundary ?? { references: [], hintFrame: 0, ambiguous: false },
          clips: entry.clips.map(buildClip), tracks: entry.tracks ?? [],
          ...(entry.speed ? { speed: entry.speed } : {}), ...(entry.insertOwnSpeed ? { insertOwnSpeed: entry.insertOwnSpeed } : {}),
          ...(entry.sourceRecovery ? { sourceRecovery: entry.sourceRecovery } : {}), ...(entry.legacyRecovery ? { legacyRecovery: entry.legacyRecovery } : {}),
          ...(entry.trackBoundaries ? { trackBoundaries: entry.trackBoundaries } : {}),
        })),
        groups: overrides.cutArchive.groups ?? [],
      },
    } : {}),
    ...(overrides.rendering ? { rendering: overrides.rendering } : {}),
  };
}
