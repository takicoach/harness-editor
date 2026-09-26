import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { open, stat } from 'node:fs/promises';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import { loadProject } from '../core/project';
import { buildLiteralAlignments, type AlignmentGenerator, type ScriptInputPacket } from '../core/scriptAlignment';
import type { ScriptProposalArtifact } from '../core/scriptProposalArtifact';
import type { ScriptEditInput } from '../core/scriptEditProposal';
import { sealScriptEditInput } from './scriptEditArtifacts';
import { HttpError } from './http';
import { parseProbeOutput, type ProbedVideo } from './createProject';
import { fingerprintFile, versionToken } from './fileFingerprint';
import { readProjectFiles, type LoadedProject } from './loadProjectFiles';
import { resolvePreviewVideoPath } from './previewProxy';
import { resolveFfprobeBin } from './resolveFfmpeg';
import { isContained } from './projectRoot';
import {
  createScriptProposalArtifact,
  scriptContentHash,
  sealScriptInputPacket,
} from './scriptProposalArtifacts';

export type ScriptAlignmentMode = 'caption' | 'structure';
const execFileAsync = promisify(execFile);

interface StableFileIdentity {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

interface StableFileDigest {
  revision: string;
  identity: StableFileIdentity;
}

function identityOf(value: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }): StableFileIdentity {
  return { dev: value.dev, ino: value.ino, size: value.size, mtimeMs: value.mtimeMs, ctimeMs: value.ctimeMs };
}

function sameIdentity(a: StableFileIdentity, b: StableFileIdentity): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size
    && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

function abortError(): HttpError {
  return new HttpError(499, 'SCRIPT_ALIGNMENT_ABORTED: 台本照合を中止しました');
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

/** 大きい原素材をevent loopへ一括読込せずhashし、読取中の置換・更新を拒否する。 */
export async function hashStableSourceFile(path: string, signal?: AbortSignal): Promise<StableFileDigest> {
  throwIfAborted(signal);
  let handle;
  try {
    handle = await open(path, 'r');
  } catch {
    throw new HttpError(404, 'SOURCE_NOT_AVAILABLE: 原素材が見つかりません');
  }
  try {
    const before = identityOf(await handle.stat());
    if (before.size <= 0) throw new HttpError(400, 'SOURCE_INVALID: 原素材が空です');
    const hash = createHash('sha256');
    // FileHandle.read を小さい単位でawaitし、各境界でabortを検査する。signal付き
    // createReadStreamはopen直後のabortでiteratorのerror listener設置より先に
    // AbortErrorをemitし得るため、呼出側でcatchできない未処理errorを作る。
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    try {
      while (true) {
        throwIfAborted(signal);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
        throwIfAborted(signal);
        if (bytesRead === 0) break;
        hash.update(buffer.subarray(0, bytesRead));
        position += bytesRead;
      }
    } catch (error) {
      if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) throw abortError();
      throw new HttpError(409, 'SOURCE_READ_FAILED: 原素材を安全に読み取れませんでした');
    }
    const afterHandle = identityOf(await handle.stat());
    let afterPath: StableFileIdentity;
    try {
      afterPath = identityOf(await stat(path));
    } catch {
      throw new HttpError(409, 'SOURCE_CHANGED_DURING_READ: 原素材が照合中に変更されました');
    }
    if (!sameIdentity(before, afterHandle) || !sameIdentity(before, afterPath)) {
      throw new HttpError(409, 'SOURCE_CHANGED_DURING_READ: 原素材が照合中に変更されました');
    }
    return { revision: `sha256-${hash.digest('hex')}`, identity: before };
  } finally {
    await handle.close();
  }
}

function editContent(files: ReturnType<typeof readProjectFiles>): Record<string, string | null> {
  return {
    videoConfigSource: files.videoConfigSource,
    projectConfigJson: files.projectConfigJson,
    telopDataSource: files.telopDataSource,
    cutDataSource: files.cutDataSource,
    seDataSource: files.seDataSource,
    insertImageDataSource: files.insertImageDataSource,
    videoInsertDataSource: files.videoInsertDataSource ?? null,
    bgmDataSource: files.bgmDataSource ?? null,
    titleDataSource: files.titleDataSource,
    shapeDataSource: files.shapeDataSource ?? null,
    transitionDataSource: files.transitionDataSource ?? null,
    speedDataSource: files.speedDataSource ?? null,
    mainLayoutDataSource: files.mainLayoutDataSource ?? null,
    mainAudioDataSource: files.mainAudioDataSource ?? null,
  };
}

function previewVersion(projectDir: string, videoFile: string): string | null {
  const path = resolvePreviewVideoPath(join(projectDir, 'public'), videoFile);
  const fp = fingerprintFile(path, 'preview');
  return fp === null ? null : versionToken(fp.size, fp.mtimeMs);
}

function deterministicGenerator(mode: ScriptAlignmentMode): AlignmentGenerator {
  const skillId = mode === 'caption' ? 'subtitle-orthography' : 'script-structure';
  return {
    skillId,
    skillVersion: '1',
    provider: 'deterministic',
    model: 'literal-v1',
    configHash: scriptContentHash({ schemaVersion: 1, skillId, normalization: 'whitespace-only', matcher: 'literal-word-boundaries' }),
  };
}

interface RawTranscriptWord {
  text: string;
  start: number;
  end: number;
}

/** parseTranscriptの互換coercionを照合の信頼境界へ持ち込まない。 */
function strictRawTranscriptWords(json: string): RawTranscriptWord[] {
  let value: unknown;
  try { value = JSON.parse(json); }
  catch { throw new HttpError(400, 'TRANSCRIPT_INVALID: transcript.json がJSONではありません'); }
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || !Array.isArray((value as Record<string, unknown>).words)) {
    throw new HttpError(400, 'TRANSCRIPT_INVALID: transcript.json のwordsが配列ではありません');
  }
  return ((value as Record<string, unknown>).words as unknown[]).map((word, index) => {
    if (typeof word !== 'object' || word === null || Array.isArray(word)) {
      throw new HttpError(400, `TRANSCRIPT_INVALID: words[${index}] がオブジェクトではありません`);
    }
    const record = word as Record<string, unknown>;
    if (typeof record.text !== 'string'
      || typeof record.start !== 'number' || !Number.isFinite(record.start)
      || typeof record.end !== 'number' || !Number.isFinite(record.end)) {
      throw new HttpError(400, `TRANSCRIPT_INVALID: words[${index}] のtext/start/endが不正です`);
    }
    return { text: record.text, start: record.start, end: record.end };
  });
}

export async function probeStableSourceVideo(path: string, signal?: AbortSignal): Promise<ProbedVideo> {
  throwIfAborted(signal);
  const resolved = resolveFfprobeBin();
  if (!resolved.ok) throw new HttpError(503, 'SOURCE_PROBE_UNAVAILABLE: 原素材を検証するffprobeが見つかりません');
  try {
    const { stdout } = await execFileAsync(resolved.bin, [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height,r_frame_rate,duration',
      '-show_entries', 'format=duration', '-of', 'json', path,
    ], { encoding: 'utf8', maxBuffer: 1024 * 1024, signal });
    return parseProbeOutput(stdout);
  } catch (error) {
    if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) throw abortError();
    if (error instanceof HttpError) throw error;
    throw new HttpError(422, 'SOURCE_INVALID: 原素材を動画として検証できません');
  }
}

export interface CollectScriptAlignmentOptions {
  mode: ScriptAlignmentMode;
  expectedPreviewVersion?: string;
  signal?: AbortSignal;
}

export interface ScriptAlignmentCollectorDeps {
  probeSource: (path: string, signal?: AbortSignal) => Promise<ProbedVideo>;
}

const defaultCollectorDeps: ScriptAlignmentCollectorDeps = { probeSource: probeStableSourceVideo };

/** 保存済み案件だけから、未適用の決定的照合artifactを作る。diskへの書込は行わない。 */
async function collectScriptSource(
  projectId: string,
  projectDir: string,
  options: CollectScriptAlignmentOptions,
  deps: ScriptAlignmentCollectorDeps = defaultCollectorDeps,
): Promise<{ alignment: ScriptProposalArtifact; project: LoadedProject['project'] }> {
  throwIfAborted(options.signal);
  let files: ReturnType<typeof readProjectFiles>;
  let project: LoadedProject['project'];
  try {
    files = readProjectFiles(projectDir);
    project = loadProject(files);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new HttpError(400, `PROJECT_INPUT_INVALID: 保存済み案件を照合用に読み取れません: ${message}`);
  }
  if (project.scriptDocument == null) {
    throw new HttpError(409, 'SCRIPT_DOCUMENT_MISSING: 台本を保存してから照合してください');
  }
  const rawWords = strictRawTranscriptWords(files.transcriptJson);
  const publicDir = resolve(projectDir, 'public');
  const sourcePath = resolve(publicDir, project.videoConfig.videoFile);
  if (!isContained(sourcePath, publicDir)) {
    throw new HttpError(400, 'SOURCE_INVALID: videoConfigの原素材パスが不正です');
  }
  const initialPreviewVersion = previewVersion(projectDir, project.videoConfig.videoFile);
  if (options.expectedPreviewVersion !== undefined && options.expectedPreviewVersion !== initialPreviewVersion) {
    throw new HttpError(409, 'PREVIEW_VERSION_CONFLICT: 表示中の動画が古いため、案件を再読込してください');
  }
  const sourceDigest = await hashStableSourceFile(sourcePath, options.signal);
  const probedSource = await deps.probeSource(sourcePath, options.signal);
  throwIfAborted(options.signal);

  const configuredDurationMs = (project.videoConfig.durationFrames / project.videoConfig.fps) * 1000;
  const durationMs = probedSource.durationSeconds * 1000;
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    throw new HttpError(422, 'SOURCE_DURATION_INVALID: 原素材の実尺を取得できません');
  }
  // videoConfigは編集座標の正。実素材との差が1編集frameを超える案件へword時刻を結び付けない。
  const oneFrameMs = 1000 / project.videoConfig.fps;
  if (!Number.isFinite(configuredDurationMs)
    || Math.abs(configuredDurationMs - durationMs) > oneFrameMs + 1e-6) {
    throw new HttpError(409, 'SOURCE_DURATION_CONFLICT: 原素材の実尺と保存済み編集尺が一致しません');
  }
  const rawTranscriptRevision = `sha256-${createHash('sha256').update(files.transcriptJson).digest('hex')}`;
  const editRevision = `sha256-${scriptContentHash(editContent(files))}`;
  let packet: ScriptInputPacket;
  try {
    packet = sealScriptInputPacket({
      schemaVersion: 1,
      packetHash: '0'.repeat(64),
      projectId,
      editRevision,
      source: { id: project.videoConfig.videoFile, revision: sourceDigest.revision, durationMs },
      script: project.scriptDocument,
      transcript: {
        revision: rawTranscriptRevision,
        words: rawWords.map((word, index) => ({
          index,
          text: word.text,
          startMs: word.start,
          endMs: word.end,
        })),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new HttpError(400, `TRANSCRIPT_INVALID: 保存済み文字起こしを安全に照合できません: ${message}`);
  }

  // 長いsource hashの間に台本・transcript・編集内容・previewが変わっていないことを確認する。
  let currentFiles: ReturnType<typeof readProjectFiles>;
  try {
    currentFiles = readProjectFiles(projectDir);
  } catch {
    throw new HttpError(409, 'PROJECT_CHANGED_DURING_READ: 案件が照合中に変更されました');
  }
  const stableInputs = currentFiles.transcriptJson === files.transcriptJson
    && currentFiles.scriptDocumentJson === files.scriptDocumentJson
    && scriptContentHash(editContent(currentFiles)) === scriptContentHash(editContent(files));
  const currentPreviewVersion = previewVersion(projectDir, project.videoConfig.videoFile);
  let sourceAfter: StableFileIdentity;
  try {
    sourceAfter = identityOf(await stat(sourcePath));
  } catch {
    throw new HttpError(409, 'SOURCE_CHANGED_DURING_READ: 原素材が照合中に変更されました');
  }
  if (!stableInputs || !sameIdentity(sourceDigest.identity, sourceAfter)) {
    throw new HttpError(409, 'PROJECT_CHANGED_DURING_READ: 案件が照合中に変更されました');
  }
  if (currentPreviewVersion !== initialPreviewVersion) {
    throw new HttpError(409, 'PREVIEW_VERSION_CONFLICT: 表示する動画が照合中に変更されました。案件を再読込してください');
  }
  throwIfAborted(options.signal);
  return { alignment: createScriptProposalArtifact(packet, buildLiteralAlignments(packet, deterministicGenerator(options.mode))), project };
}

export async function collectScriptAlignmentArtifact(
  projectId: string, projectDir: string, options: CollectScriptAlignmentOptions,
  deps: ScriptAlignmentCollectorDeps = defaultCollectorDeps,
): Promise<ScriptProposalArtifact> {
  return (await collectScriptSource(projectId, projectDir, options, deps)).alignment;
}

/** The editing baseline and correspondence come from the same verified read, never a second load. */
export async function collectScriptEditInput(
  projectId: string, projectDir: string, options: CollectScriptAlignmentOptions,
  deps: ScriptAlignmentCollectorDeps = defaultCollectorDeps,
): Promise<ScriptEditInput> {
  const { alignment, project } = await collectScriptSource(projectId, projectDir, options, deps);
  return sealScriptEditInput({ schemaVersion: 1, inputHash: '0'.repeat(64), alignment, editing: {
    fps: project.videoConfig.fps, totalFrames: project.videoConfig.durationFrames,
    telops: project.telops.map(({ id, text, originalStart, originalEnd }) => ({ id, text, originalStart, originalEnd })),
    cutRegions: project.cutRegions, cutOrder: project.cutOrder ?? [],
  } });
}
