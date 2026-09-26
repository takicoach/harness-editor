/**
 * テスト専用: 「旧形式から取り込んだ案件」の試料を一時フォルダに合成する。
 *
 * 実案件・実際の学習フォルダは読まない。sample-project を複製し、旧形式ファイル（比較元）を上書きしたうえで、
 * 旧ファイルを読んだ project（loadProject の解釈）を edit で「人の仕上げ」へ書き換え、
 * migrateLegacyWithCutHistory で新形式の文書を作る。文書の legacy.sourceFingerprint は
 * ディスク上の旧ファイルの指紋なので、比較元＝旧ファイル・仕上げ＝文書の関係が実際の取り込みと同じになる。
 * 書き出しは実描画せず、完了済みの記録（manifest.json）と input.json・last-export.json だけを作る。
 */
import { cpSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { EditorProject } from '../../../core/types';
import type { SequenceAsset, SequenceDocument } from '../../../core/sequence/model';
import { loadProject } from '../../../core/project';
import { migrateLegacyWithCutHistory } from '../../../core/sequence/migrateLegacyWithCutHistory';
import { rational } from '../../../core/sequence/time';
import { readProjectFiles } from '../../loadProjectFiles';
import { legacyInputFingerprint } from '../../sequence/migration';
import { SequenceStore, sequenceContentHash } from '../../sequence/store';
import { createExportRecord, exportJobId, type ExportRecord } from '../../sequence/exportRecords';
import { targetResolution } from '../../../shared/renderPreset';

const SAMPLE_PROJECT = resolve(import.meta.dirname, '../../__fixtures__/sample-project');

/** 比較元（旧形式ファイル）の中身。既定値は harvest_v2 との照合に使う標準試料。 */
export interface LegacyFiles {
  cutData: string;
  telopData: string;
  seData: string;
  transcriptWords: Array<{ text: string; start: number; end: number }>;
}

export const STANDARD_LEGACY: LegacyFiles = {
  cutData: `export const cutData: { id: number; originalStart: number; originalEnd: number; playbackStart: number; playbackEnd: number }[] = [
  { id: 1, originalStart: 0, originalEnd: 120, playbackStart: 0, playbackEnd: 120 },
  { id: 2, originalStart: 150, originalEnd: 300, playbackStart: 120, playbackEnd: 270 },
];
`,
  telopData: `import type { TelopSegment } from './telopTypes';
export const telopData: TelopSegment[] = [
  { id: 1, startFrame: 0, endFrame: 60, text: "ゆる素振り", style: "normal", template: 1, animation: "fadeOnly" },
  { id: 2, startFrame: 60, endFrame: 100, text: "長いアイアン", style: "normal", template: 1, animation: "fadeOnly" },
  { id: 3, startFrame: 130, endFrame: 180, text: "つなぎ目の後ろ", style: "normal", template: 1, animation: "fadeOnly" },
];
`,
  seData: `import type { SoundEffect } from './SEPlayer';
export const seData: SoundEffect[] = [
  { id: 1, startFrame: 30, file: 'beep.mp3', volume: 0.3 },
  { id: 2, startFrame: 200, file: 'pop.mp3', volume: 0.3 },
];
`,
  transcriptWords: [
    { text: 'ゆる', start: 0, end: 500 }, { text: '素振り', start: 500, end: 1000 },
    { text: 'えー', start: 3400, end: 3700 }, { text: 'あの', start: 4200, end: 4600 },
  ],
};

/** 標準試料の「人の仕上げ」: カット1か所追加・旧カット1か所復元・テロップ修正/削除/追加・SE 削除/追加。 */
export function standardEdit(project: EditorProject): void {
  project.cutRegions = [{ start: 100, end: 115 }];
  project.telops = project.telops.filter((t) => t.id !== 3).map((t) => (t.id === 1 ? { ...t, text: 'ゆるい素振り' } : t));
  project.telops.push({ ...project.telops[0]!, id: 99, originalStart: 220, originalEnd: 260, text: '追加した字幕' });
  project.se = project.se.filter((s) => s.id !== 1);
  project.se.push({ ...project.se[0]!, id: 7, originalStart: 250, originalEnd: 260, file: 'whoosh.mp3' });
}

/** 新エディターで足したクリップに見せる: 旧 ID と legacyId・legacyAudioContinuity を外す。 */
export function markAddedInEditor(document: SequenceDocument, fromId: string, toId: string): void {
  const clip = document.clips.find((c) => c.id === fromId);
  if (!clip) throw new Error(`試料に ${fromId} がありません`);
  clip.id = toId;
  delete clip.legacyAudioContinuity;
  if (clip.content.kind === 'telop') delete clip.content.legacyId;
}

export function standardFinish(document: SequenceDocument): void {
  markAddedInEditor(document, 'legacy-telop-99', 'user-telop-1');
  markAddedInEditor(document, 'legacy-effect-7', 'user-effect-1');
}

export interface ImportedProjectOptions {
  legacy?: Partial<LegacyFiles>;
  /** 旧ファイルを読んだ project を人の仕上げへ書き換える（既定は何もしない＝差分なし）。 */
  edit?(project: EditorProject): void;
  /** 取り込み後の文書をさらに書き換える（新エディターで足したクリップの再現など）。 */
  finish?(document: SequenceDocument): void;
  /** 書き出しジョブの状態（既定 'complete'）。 */
  phase?: 'complete' | 'rendering';
  /** 作る書き出しジョブの実行 ID（既定 'fixture-export-1'）。 */
  executionId?: string;
  /** 書き出し記録の形式（既定 1 = 新エディターの書き出し。3 = 旧形式のまま書き出した記録 legacy-snapshot）。 */
  recordVersion?: 1 | 3;
}

export interface ImportedProjectFixture {
  /** 案件置き場（案件フォルダの親。.sme-editor-operations.json の置き場所）。 */
  root: string;
  /** 案件フォルダ（basename = videoId = 'case-a'）。 */
  dir: string;
  document: SequenceDocument;
  jobId: string;
  contentHash: string;
  cleanup(): void;
}

function mediaAsset(id: string, name: string, file: string, kinds: Array<'video' | 'audio'>): SequenceAsset {
  return { id, kind: 'media', name, file, fingerprint: id, streams: kinds.map((kind, index) => kind === 'video'
    ? { index, kind, duration: rational(10), codec: 'h264', width: 1920, height: 1080, frameRate: rational(30) }
    : { index, kind, duration: rational(10), codec: 'aac', sampleRate: 48000, channels: 2 }) };
}

export async function createImportedProject(options: ImportedProjectOptions = {}): Promise<ImportedProjectFixture> {
  const legacy = { ...STANDARD_LEGACY, ...options.legacy };
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'harness-native-learning-')));
  const dir = join(root, 'case-a');
  cpSync(SAMPLE_PROJECT, dir, { recursive: true });
  writeFileSync(join(dir, 'src/videoConfig.ts'), `export type VideoFormat = 'youtube' | 'short' | 'square';
export const FORMAT: VideoFormat = 'youtube';
export const FPS = 30;
export const DURATION_FRAMES = 300;
export const VIDEO_FILE = 'main.mp4';
const RESOLUTION_MAP = { youtube: { width: 1920, height: 1080 }, short: { width: 1080, height: 1920 }, square: { width: 1080, height: 1080 } } as const;
export const RESOLUTION = RESOLUTION_MAP[FORMAT];
`);
  writeFileSync(join(dir, 'src/cutData.ts'), legacy.cutData);
  writeFileSync(join(dir, 'src/テロップテンプレート/telopData.ts'), legacy.telopData);
  writeFileSync(join(dir, 'src/SoundEffects/seData.ts'), legacy.seData);
  writeFileSync(join(dir, 'transcript.json'), JSON.stringify({ engine: 'fixture', language: 'ja', duration_ms: 10000, words: legacy.transcriptWords, segments: [] }));
  const sourceFingerprint = await legacyInputFingerprint(dir);
  const project = loadProject(readProjectFiles(dir));
  // 学習の対象外（画像・図形・BGM）は試料に持ち込まない（取り込みに必要な素材の準備を省くため）。
  project.images = [];
  project.shapes = [];
  project.bgm = [];
  options.edit?.(project);
  const seFiles = [...new Set(project.se.map((s) => s.file))];
  const document = migrateLegacyWithCutHistory({
    id: 'doc-a', name: 'case-a', project, sourceFingerprint,
    assets: [mediaAsset('main', 'main.mp4', 'public/main.mp4', ['video', 'audio']),
      ...seFiles.map((file) => mediaAsset(`se-${file}`, file, `public/se/${file}`, ['audio'])),
      { id: 'caption', kind: 'component', name: 'caption', file: '.harness/assets/caption.js', fingerprint: 'caption', streams: [] }],
    bindings: { main: 'main', telopComponent: 'caption', images: {}, videoInserts: {}, bgm: {},
      se: Object.fromEntries(project.se.map((s) => [s.id, `se-${s.file}`])) },
  }).document;
  options.finish?.(document);
  document.revision = 3;
  new SequenceStore(dir).save({ expectedSavedRevision: null, executionId: 'fixture-finish', document });
  const executionId = options.executionId ?? 'fixture-export-1';
  const jobId = exportJobId(executionId), contentHash = sequenceContentHash(document);
  const complete = (options.phase ?? 'complete') === 'complete';
  const status = { id: jobId, projectId: 'case-a', revision: document.revision, contentHash, executionId, phase: complete ? 'complete' as const : 'rendering' as const,
    completedFrames: complete ? document.sequenceEndFrame : 0, totalFrames: document.sequenceEndFrame, createdAt: '2026-09-25T00:00:00.000Z',
    ...(complete ? { finishedAt: '2026-09-25T00:00:05.000Z' } : {}) };
  const output = complete ? { output: { sha256: '0'.repeat(64), bytes: 0, verificationHash: '0'.repeat(64) } } : {};
  const settings = { resolution: 'full', quality: 'high' } as const;
  const record: ExportRecord = options.recordVersion === 3
    ? { version: 3, ownerPid: 0, ...output,
      request: { kind: 'legacy-snapshot', sourceFingerprint: document.legacy!.sourceFingerprint, snapshotHash: contentHash,
        expectedRevision: document.revision, executionId, settings, outputName: 'case-a.mp4' },
      status: { ...status, settings, outputResolution: targetResolution(document.resolution.width, document.resolution.height, settings.resolution) } }
    : { version: 1, request: { sessionId: 'fixture-session', expectedRevision: document.revision, executionId }, ownerPid: 0, status, ...output };
  createExportRecord(dir, record, document);
  if (complete) writeFileSync(join(dir, '.harness/last-export.json'), JSON.stringify({ jobId, revision: document.revision, contentHash }));
  return { root, dir, document, jobId, contentHash, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
