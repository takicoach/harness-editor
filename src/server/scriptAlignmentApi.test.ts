import { EventEmitter } from 'node:events';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createScriptDocument, serializeScriptDocumentData } from '../core/scriptDocumentData';
import { validateScriptProposalArtifact } from '../core/scriptProposalArtifact';
import { HttpError } from './http';
import { handleApi } from './plugin';
import { collectScriptAlignmentArtifact, hashStableSourceFile } from './scriptAlignmentApi';
import { versionToken } from './fileFingerprint';
import { createScriptEditArtifact, verifyScriptEditInput } from './scriptEditArtifacts';

const SAMPLE = resolve(import.meta.dirname, '__fixtures__', 'sample-project');
const roots: string[] = [];
function setup(): { root: string; projectDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'sme-script-api-'));
  roots.push(root);
  const projectDir = join(root, 'project-a');
  cpSync(SAMPLE, projectDir, { recursive: true });
  const configPath = join(projectDir, 'src', 'videoConfig.ts');
  writeFileSync(configPath, readFileSync(configPath, 'utf8')
    .replace('export const FPS = 60;', 'export const FPS = 30;')
    .replace('export const DURATION_FRAMES = 12000;', 'export const DURATION_FRAMES = 30;'));
  writeFileSync(join(projectDir, 'transcript.json'), JSON.stringify({ duration_ms: 1000,
    words: [{ text: 'ゆる', start: 100, end: 300 }, { text: '素振り', start: 300, end: 600 }], segments: [] }));
  const script = createScriptDocument('ゆる素振り\n未収録', { documentId: 'shooting', revision: 'script-1' });
  writeFileSync(join(projectDir, 'shooting-script.json'), serializeScriptDocumentData(script));
  return { root, projectDir };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('collectScriptAlignmentArtifact', () => {
  it('大きいsourceをevent loopへ一括読込せず、AbortSignalで途中停止する', async () => {
    const { root } = setup();
    const file = join(root, 'large-source.bin');
    writeFileSync(file, Buffer.alloc(16 * 1024 * 1024, 7));
    const controller = new AbortController();
    let timerRan = false;
    setTimeout(() => { timerRan = true; controller.abort(); }, 0);
    await expect(hashStableSourceFile(file, controller.signal))
      .rejects.toMatchObject({ status: 499, message: expect.stringContaining('SCRIPT_ALIGNMENT_ABORTED') });
    expect(timerRan).toBe(true);
  });

  it('保存済み原素材/transcript/編集/台本を内容版へ束縛した未適用artifactを返す', async () => {
    const { projectDir } = setup();
    const artifact = await collectScriptAlignmentArtifact('project-a', projectDir, { mode: 'caption' });
    expect(validateScriptProposalArtifact(artifact)).toEqual(artifact);
    expect(artifact).toMatchObject({ schemaVersion: 1, kind: 'script-alignment-proposals', state: 'unapplied' });
    expect(artifact.packet.projectId).toBe('project-a');
    expect(artifact.packet.source).toMatchObject({ id: 'main.mp4', durationMs: 1_000 });
    expect(artifact.packet.source.revision).toMatch(/^sha256-[a-f0-9]{64}$/);
    expect(artifact.packet.transcript.revision).toMatch(/^sha256-[a-f0-9]{64}$/);
    expect(artifact.packet.editRevision).toMatch(/^sha256-[a-f0-9]{64}$/);
    expect(artifact.proposals.map((proposal) => proposal.status)).toEqual(['unique', 'unmatched']);
    expect(artifact.proposals[0]?.generator).toMatchObject({
      skillId: 'subtitle-orthography', provider: 'deterministic', model: 'literal-v1',
    });
  });

  it('raw transcript・編集source・実原素材の変更をそれぞれ別の内容版へ反映する', async () => {
    const { projectDir } = setup();
    const first = await collectScriptAlignmentArtifact('project-a', projectDir, { mode: 'structure' });
    const transcript = JSON.parse(readFileSync(join(projectDir, 'transcript.json'), 'utf8')) as { engine: string };
    transcript.engine = 'same-words-new-source';
    writeFileSync(join(projectDir, 'transcript.json'), JSON.stringify(transcript));
    const transcriptChanged = await collectScriptAlignmentArtifact('project-a', projectDir, { mode: 'structure' });
    expect(transcriptChanged.packet.transcript.words).toEqual(first.packet.transcript.words);
    expect(transcriptChanged.packet.transcript.revision).not.toBe(first.packet.transcript.revision);

    writeFileSync(join(projectDir, 'src', 'cutData.ts'), `${readFileSync(join(projectDir, 'src', 'cutData.ts'), 'utf8')}\n// saved edit revision\n`);
    const editChanged = await collectScriptAlignmentArtifact('project-a', projectDir, { mode: 'structure' });
    expect(editChanged.packet.editRevision).not.toBe(transcriptChanged.packet.editRevision);

    writeFileSync(join(projectDir, 'public', 'main.mp4'), Buffer.concat([
      readFileSync(join(projectDir, 'public', 'main.mp4')), Buffer.from('source-content-change'),
    ]));
    const sourceChanged = await collectScriptAlignmentArtifact('project-a', projectDir, { mode: 'structure' });
    expect(sourceChanged.packet.source.revision).not.toBe(editChanged.packet.source.revision);
    expect(sourceChanged.proposals[0]?.generator.skillId).toBe('script-structure');
  });

  it('古いpreview版、素材不在、不正transcript、開始前abortを具体的に拒否する', async () => {
    const { projectDir } = setup();
    await expect(collectScriptAlignmentArtifact('project-a', projectDir, {
      mode: 'caption', expectedPreviewVersion: '1-1',
    })).rejects.toMatchObject({ status: 409, message: expect.stringContaining('PREVIEW_VERSION_CONFLICT') });

    const controller = new AbortController();
    controller.abort();
    await expect(collectScriptAlignmentArtifact('project-a', projectDir, {
      mode: 'caption', signal: controller.signal,
    })).rejects.toMatchObject({ status: 499, message: expect.stringContaining('SCRIPT_ALIGNMENT_ABORTED') });

    writeFileSync(join(projectDir, 'transcript.json'), JSON.stringify({ duration_ms: 1000,
      words: [{ text: null, start: '0', end: 1 }], segments: [] }));
    await expect(collectScriptAlignmentArtifact('project-a', projectDir, { mode: 'caption' }))
      .rejects.toMatchObject({ status: 400, message: expect.stringContaining('TRANSCRIPT_INVALID') });

    writeFileSync(join(projectDir, 'transcript.json'), JSON.stringify({ duration_ms: 1000,
      words: [{ text: 'ゆる', start: 100, end: 300 }], segments: [] }));
    unlinkSync(join(projectDir, 'public', 'main.mp4'));
    await expect(collectScriptAlignmentArtifact('project-a', projectDir, { mode: 'caption' }))
      .rejects.toMatchObject({ status: 404, message: expect.stringContaining('SOURCE_NOT_AVAILABLE') });
  });

  it('実素材尺が保存済み編集尺から1frameを超えてずれればpacketを作らない', async () => {
    const { projectDir } = setup();
    await expect(collectScriptAlignmentArtifact('project-a', projectDir, { mode: 'caption' }, {
      probeSource: async () => ({ fps: 30, durationSeconds: 1.1, width: 1080, height: 1920 }),
    })).rejects.toMatchObject({ status: 409, message: expect.stringContaining('SOURCE_DURATION_CONFLICT') });
    await expect(collectScriptAlignmentArtifact('project-a', projectDir, { mode: 'caption' }, {
      probeSource: async () => ({ fps: 30, durationSeconds: 1 + 1 / 30, width: 1080, height: 1920 }),
    })).resolves.toMatchObject({ state: 'unapplied' });
  });
});

async function call(root: string, path: string, method = 'GET', payload?: unknown): Promise<{ status: number; body: unknown }> {
  const req = Object.assign(new EventEmitter(), { method, headers: {}, url: path,
    async *[Symbol.asyncIterator]() { if (payload !== undefined) yield Buffer.from(JSON.stringify(payload)); },
  }) as unknown as IncomingMessage;
  let status = 0;
  let body: unknown;
  const responseEvents = new EventEmitter();
  const res = Object.assign(responseEvents, {
    writableEnded: false,
    writeHead(next: number) { status = next; return this; },
    end(text?: string) { this.writableEnded = true; body = text ? JSON.parse(text) : undefined; },
  }) as unknown as ServerResponse;
  try {
    await handleApi(req, res, new URL(path, 'http://localhost'), root);
  } catch (error) {
    if (error instanceof HttpError) return { status: error.status, body: { error: error.message } };
    throw error;
  }
  return { status, body };
}

describe('GET /api/script-alignment', () => {
  it('reviews both draft kinds against live facts; rejects tamper, wrong purpose and stale drafts without editing files', async () => {
    const { root, projectDir } = setup();
    writeFileSync(join(projectDir, 'src', 'cutData.ts'), 'export const cutData = [{id:1, originalStart:0, originalEnd:30, playbackStart:0, playbackEnd:30}];');
    writeFileSync(join(projectDir, 'src', 'テロップテンプレート', 'telopData.ts'), 'export const telopData = [{id:1, startFrame:0, endFrame:30, text:"ゆるすぶり"}];');
    const inventory = () => Object.fromEntries(readdirSync(projectDir, { recursive: true, encoding: 'utf8' })
      .filter(name => statSync(join(projectDir, name)).isFile()).sort()
      .map(name => [name, readFileSync(join(projectDir, name)).toString('base64')]));
    const before = inventory();
    for (const kind of ['caption', 'structure'] as const) {
      const input = verifyScriptEditInput((await call(root, `/api/script-edit-input?id=project-a&mode=${kind}`)).body);
      const draft = createScriptEditArtifact(input, { schemaVersion: 1, kind, proposalId: `script-edit:${kind}:${input.inputHash}`,
        inputHash: input.inputHash, generator: input.alignment.proposals[0]!.generator,
        passages: input.alignment.proposals.map(p => p.status === 'unique'
          ? { passageId: p.passageId, action: 'use', candidateIndex: 0, reason: '合成例の一致発話を使用' }
          : { passageId: p.passageId, action: 'skip', reason: '対応候補なし・要確認' }),
        ...(kind === 'caption' ? { changes: [{ telopId: 1, before: 'ゆるすぶり', after: 'ゆる素振り',
          passageId: input.alignment.proposals[0]!.passageId, scriptRange: input.alignment.proposals[0]!.scriptRange,
          wordRef: input.alignment.proposals[0]!.candidates[0]!.wordRef }] } : {}) });
      const path = `/api/script-edit-review?id=project-a&mode=${kind}`;
      expect(await call(root, path, 'POST', draft)).toEqual({ status: 200, body: draft });
      expect((await call(root, path)).status).toBe(405);
      expect((await call(root, path, 'POST', { ...draft, state: 'applied' })).status).toBe(400);
      expect((await call(root, path, 'POST', { ...draft, input: { ...draft.input, inputHash: '0'.repeat(64) } })).status).toBe(400);
      expect((await call(root, `/api/script-edit-review?id=project-a&mode=${kind === 'caption' ? 'structure' : 'caption'}`, 'POST', draft)).status).toBe(409);
      const transcriptPath = join(projectDir, 'transcript.json'), original = readFileSync(transcriptPath);
      writeFileSync(transcriptPath, Buffer.concat([original, Buffer.from('\n')]));
      expect((await call(root, path, 'POST', draft)).status).toBe(409);
      writeFileSync(transcriptPath, original);
      expect(inventory()).toEqual(before);
    }
  });

  it('collects the edit snapshot and word evidence from one verified read without writing project files', async () => {
    const { root, projectDir } = setup();
    writeFileSync(join(projectDir, 'src', 'cutData.ts'), 'export const cutData = [{id:1, originalStart:0, originalEnd:30, playbackStart:0, playbackEnd:30}];');
    writeFileSync(join(projectDir, 'src', 'テロップテンプレート', 'telopData.ts'), 'export const telopData = [{id:1, startFrame:0, endFrame:30, text:"ゆるすぶり"}];');
    const inventory = () => Object.fromEntries(readdirSync(projectDir, { recursive: true, encoding: 'utf8' })
      .filter(name => statSync(join(projectDir, name)).isFile()).sort()
      .map(name => [name, readFileSync(join(projectDir, name)).toString('base64')]));
    const before = inventory();
    const response = await call(root, '/api/script-edit-input?id=project-a&mode=caption');
    expect(response.status).toBe(200);
    const input = verifyScriptEditInput(response.body);
    expect(input.editing).toMatchObject({ fps: 30, totalFrames: 30,
      telops: [{ id: 1, text: 'ゆるすぶり', originalStart: 0, originalEnd: 30 }], cutRegions: [] });
    expect(input.alignment.packet.projectId).toBe('project-a');
    expect(input.alignment.packet.source.durationMs).toBe(1000);
    expect(inventory()).toEqual(before);
    expect((await call(root, '/api/script-edit-input?id=project-a&mode=caption', 'POST')).status).toBe(405);
  });

  it('artifact本体を返し、mode/method/preview版を入口で検証する', async () => {
    const { root, projectDir } = setup();
    const st = statSync(join(projectDir, 'public', 'main.mp4'));
    const currentVersion = versionToken(st.size, st.mtimeMs);
    const ok = await call(root, `/api/script-alignment?id=project-a&mode=caption&expectedPreviewVersion=${encodeURIComponent(currentVersion)}`);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ kind: 'script-alignment-proposals', state: 'unapplied' });
    expect((await call(root, '/api/script-alignment?id=project-a&mode=other')).status).toBe(400);
    expect((await call(root, '/api/script-alignment?id=project-a&mode=caption', 'POST')).status).toBe(405);
    expect((await call(root, '/api/script-alignment?id=missing&mode=caption')).status).toBe(404);
  });
});
