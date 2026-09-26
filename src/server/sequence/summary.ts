import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SequenceStore, type SavedSequence } from './store';
import type { ProjectSteps, ProjectSummary } from '../../shared/types';
import { formatClock, formatSize } from '../../shared/format';
import { timeNumber } from '../../core/sequence/time';
import { readExportRecord } from './exportRecords';

export const sequenceFile = (directory: string) => join(directory, '.harness', 'project.v2.json');
/** Presence is distinct from validity: a broken v2 file must never fall back to old TSX. */
export function hasSequenceDocument(directory: string): boolean {
  try { lstatSync(sequenceFile(directory)); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
function isCurrentExport(directory: string, saved: SavedSequence): boolean {
  try {
    const receipt = join(directory, '.harness', 'last-export.json'), info = lstatSync(receipt);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 65536) return false;
    const data = JSON.parse(readFileSync(receipt, 'utf8'));
    if (data.contentHash !== saved.contentHash || typeof data.jobId !== 'string' || !/^(?:[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/.test(data.jobId)) return false;
    const parent = join(directory, '.harness', 'exports'), folder = join(parent, data.jobId);
    for (const path of [parent, folder]) { const entry = lstatSync(path); if (!entry.isDirectory() || entry.isSymbolicLink()) return false; }
    const output = lstatSync(join(folder, 'output.mp4'));
    if(data.jobId.length===32){
      const record=readExportRecord(directory,data.jobId);
      if(record.status.phase!=='complete'||record.status.contentHash!==saved.contentHash||record.output?.bytes!==output.size)return false;
    }
    return output.isFile() && !output.isSymbolicLink() && output.size > 0;
  } catch { return false; }
}
export function sequenceSteps(directory: string, saved: SavedSequence): ProjectSteps {
  const doc = saved.document;
  return {
    transcribe: doc.transcripts.some(transcript => transcript.words.length > 0),
    cut: true,
    telop: doc.clips.some(clip => clip.content.kind === 'telop') ? 'nonempty' : 'empty',
    audio: doc.clips.some(clip => clip.content.kind === 'audio' && clip.content.role !== 'speech'),
    rendered: isCurrentExport(directory, saved),
  };
}
export function readSequenceSummary(directory: string): Omit<ProjectSummary, 'status' | 'id'> | null {
  const saved = new SequenceStore(directory).load(); if (!saved) return null;
  const doc = saved.document, video = doc.assets.find(asset => asset.kind === 'media' && asset.streams.some(stream => stream.kind === 'video'));
  const firstImage = video ? undefined : doc.clips.filter(clip => clip.content.kind === 'image').sort((a, b) => a.startFrame - b.startFrame)[0];
  const imageAssetId = firstImage?.content.kind === 'image' ? firstImage.content.assetId : undefined;
  const audioOnly = !video && !imageAssetId && doc.clips.some(clip => clip.content.kind === 'audio' && clip.content.role === 'speech');
  let size = 0;
  // Assets have project-relative, validated paths; do not follow a replaced symlink to another source.
  for (const asset of doc.assets) {
    try { const info = lstatSync(join(directory, asset.file)); if (info.isFile() && !info.isSymbolicLink()) size += info.size; } catch { /* Missing assets are reported when opened. */ }
  }
  return { name: doc.name, dir: directory, orientation: doc.resolution.width === doc.resolution.height ? 'sq' : doc.resolution.width > doc.resolution.height ? 'h' : 'v',
    durationLabel: formatClock(doc.sequenceEndFrame / timeNumber(doc.fps)), sizeLabel: formatSize(size), videoFile: null,
    ...(video ? { videoAssetId: video.id } : {}), ...(imageAssetId ? { imageAssetId } : {}), ...(audioOnly ? { audioOnly: true } : {}), lastEditedAt: lstatSync(sequenceFile(directory)).mtimeMs, steps: sequenceSteps(directory, saved) };
}
