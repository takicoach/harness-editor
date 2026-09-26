import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { HttpError, sendJson } from './http';
import { JOB_BODY_MAX_BYTES, readJsonBody } from './readBody';
import { resolveFfmpegBin } from './resolveFfmpeg';
import { buildDenoiseArgs } from './buildDenoiseArgs';
import { buildApplyArgs, buildMeasureArgs, parseLoudnormJson, targetToLufs } from './buildNormalizeArgs';
import { denoiseJobs } from './denoiseApi';
import { normalizeJobs } from './normalizeApi';
import { importSequenceAsset, registerAssetOrigin, registeredSequenceAssets, verifiedSequenceAssetPath } from './sequence/assets';
import { sequenceExports } from './sequence/exports';
import { heavyJobCounts, heavyJobGate } from './systemLoad';
import type { SequenceAsset } from '../core/sequence/model';

export type AudioFixKind = 'denoise' | 'normalize';
export interface AudioFixResult { asset: SequenceAsset; kind: AudioFixKind; from: string }

const LABEL: Record<AudioFixKind, string> = { denoise: 'ノイズ除去', normalize: '音量正規化' };
/** aac を収められる器だけを許す。映像は -c:v copy でそのまま運ぶので器は変えない。 */
const VIDEO_CONTAINERS = new Set(['.mp4', '.mov', '.m4v', '.mkv']);
const ASSET_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/**
 * 案件ごとに 1 本だけ。denoise/normalize の Manager はキーごとに直列化しているが、
 * 片方ずつ走らせても素材の系譜が分岐するので、この API の単位でも 1 本に絞る。
 */
const running = new Map<string, { kind: AudioFixKind; token: symbol }>();
export function audioFixRunning(projectId: string): AudioFixKind | undefined { return running.get(projectId)?.kind; }

/** 既存の引数ビルダから -af の中身だけを借りる（フィルタ式の正本を二重に持たない）。 */
function filterOf(args: string[]): string {
  const at = args.indexOf('-af'), filter = at < 0 ? undefined : args[at + 1];
  if (!filter) throw new Error('音声フィルタを組み立てられません');
  return filter;
}

/**
 * 入力の映像・音声を「入力の並び順のまま」出力へ写す。replace-audio-source は
 * 差し替え先に同じ streamIndex の音声があることを要求するため、既定の並べ替えに任せない。
 */
function audioFixArgs(asset: SequenceAsset, input: string, output: string, filter: string): string[] {
  const maps = [...asset.streams].sort((a, b) => a.index - b.index).flatMap(stream => ['-map', `0:${stream.index}`]);
  return ['-y', '-i', input, ...maps, '-af', filter, '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', output];
}

/** 出力の stream index を原本と一致させられる構成だけを受け付ける。 */
function assertFixableLayout(asset: SequenceAsset): void {
  const sorted = [...asset.streams].sort((a, b) => a.index - b.index);
  if (!sorted.some(stream => stream.kind === 'audio')) throw new HttpError(400, 'この素材には音声が入っていません');
  // 字幕など映像・音声以外が混じった素材は番号が飛ぶ。飛んだまま作ると差し替えができない。
  if (sorted.some((stream, at) => stream.index !== at)) throw new HttpError(400, 'この素材は構成が特殊なため、音声を補正できません');
}

function outputExtension(asset: SequenceAsset): string {
  if (!asset.streams.some(stream => stream.kind === 'video')) return '.m4a';
  const extension = extname(asset.file).toLowerCase();
  if (!VIDEO_CONTAINERS.has(extension)) throw new HttpError(400, `この形式（${extension || '不明'}）の素材は音声を補正できません`);
  return extension;
}

type AudioFixJobEvent = { phase: string; error?: { code: string; message: string } };
/** 2 つの Manager は subscribe/discard の形が同じ（phase の文字列集合だけが違う）。 */
interface AudioFixJobManager { subscribe(key: string, fn: (event: AudioFixJobEvent) => void): () => void; discard(key: string): void }

async function runAudioFix(kind: AudioFixKind, projectId: string, ffmpeg: string, asset: SequenceAsset,
  input: string, temporary: string, output: string, cwd: string): Promise<void> {
  const key = `audio-fix:${projectId}`;
  const manager = (kind === 'denoise' ? denoiseJobs : normalizeJobs) as unknown as AudioFixJobManager;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (unsubscribe: () => void, error?: Error) => {
      if (settled) return;
      settled = true; unsubscribe(); manager.discard(key);
      if (error) reject(error); else resolve();
    };
    const unsubscribe = manager.subscribe(key, event => {
      if (event.phase === 'done') finish(unsubscribe);
      else if (event.phase === 'failed' || event.phase === 'cancelled')
        finish(unsubscribe, new HttpError(500, event.error?.message ?? '音声の補正に失敗しました'));
    });
    try {
      if (kind === 'denoise') denoiseJobs.start(key, { ffmpeg, cwd, tmpOutput: temporary, finalOutput: output,
        ffmpegArgs: audioFixArgs(asset, input, temporary, filterOf(buildDenoiseArgs({ input, output: temporary }))) });
      else {
        const targetLufs = targetToLufs('standard');
        normalizeJobs.start(key, { ffmpeg, cwd, tmpOutput: temporary, finalOutput: output,
          measureArgs: buildMeasureArgs({ input, targetLufs }), parseMeasured: parseLoudnormJson,
          buildApplyArgs: measured => audioFixArgs(asset, input, temporary, filterOf(buildApplyArgs({ input, output: temporary, targetLufs, measured }))) });
      }
    } catch (error) {
      // running を synchronize してからしか start() を呼ばないので通常は届かないが、
      // Manager 側の直列化キーが将来増えた場合の保険として 409 に写像しておく（I1）。
      const message = error instanceof Error ? error.message : String(error);
      finish(unsubscribe, message === 'already-running'
        ? new HttpError(409, 'この案件では別の音声補正が実行中です。完了を待ってから、もう一度お試しください')
        : (error instanceof Error ? error : new Error(message)));
    }
  });
}

/**
 * POST /api/audio-fix?id=<projectId> — ボディ { assetId, kind: 'denoise' | 'normalize' }
 *
 * 原本 asset は 1 バイトも変えない。補正結果は別の不変 asset として登録し、その asset を返す。
 * 呼び出し側は /register で document へ載せてから replace-audio-source で参照を切り替える。
 * 途中で失敗した場合は素材台帳にも文書にも何も足さない。
 */
export async function handleAudioFixPost(req: IncomingMessage, res: ServerResponse, projectId: string, projectDir: string): Promise<void> {
  const body = await readJsonBody(req, JOB_BODY_MAX_BYTES) as { assetId?: unknown; kind?: unknown };
  const kind = body.kind;
  if (kind !== 'denoise' && kind !== 'normalize') throw new HttpError(400, '対応していない補正の種類です');
  if (typeof body.assetId !== 'string' || !ASSET_ID.test(body.assetId)) throw new HttpError(400, '素材IDが不正です');
  if (!existsSync(projectDir)) throw new HttpError(404, '対象のプロジェクトがありません');
  if (sequenceExports.get(projectId, projectDir)) throw new HttpError(409, '書き出し中は音声を補正できません。書き出しの完了を待ってから、もう一度お試しください');
  if (running.has(projectId)) throw new HttpError(409, 'この案件では別の音声補正が実行中です。完了を待ってから、もう一度お試しください');
  if (!heavyJobGate(false, { counts: heavyJobCounts() }).allowed) throw new HttpError(429, 'ほかの重い処理が進行中です。完了してから音声を補正してください');
  // I1: has() の判定直後、await を挟む前に同期でスロットを確保する（TOCTOU 対策）。
  // ここから次の await（registeredSequenceAssets）までのあいだに他のリクエストへ制御は渡らないため、
  // 同じ projectId で running.set が二重に起きることはない。
  // C2: スロットは要求ごとの所有トークン付きで持つ。応答の前に解放したあと（下記 I-2）、
  // 一時フォルダ掃除の await の隙間に次の要求が同じ案件のスロットを取ることがある。
  // token を照合しないと、こちらの後片付けが「次の要求のスロット」まで消してしまう。
  const token = Symbol('audio-fix');
  const release = (): void => { if (running.get(projectId)?.token === token) running.delete(projectId); };
  running.set(projectId, { kind, token });
  try {
    // 取り込み済みの素材だけを入力にする（クライアントが渡した文字列からパスは作らない）。
    const asset = (await registeredSequenceAssets(projectDir)).find(item => item.id === body.assetId);
    if (!asset) throw new HttpError(404, '対象の素材が見つかりません');
    if (asset.kind !== 'media') throw new HttpError(400, '音声を含む素材を選んでください');
    assertFixableLayout(asset);
    const extension = outputExtension(asset);
    const ffmpeg = resolveFfmpegBin();
    if (!ffmpeg.ok) throw new HttpError(500, ffmpeg.message);
    // 内容照合してから読む（assets.ts の verifiedSequenceAssetPath と同じ契約）。
    // M4: 保存後に原本が変わっていた場合の平文 Error を 409 の HttpError へ写像する。
    const input = await verifiedSequenceAssetPath(projectDir, asset)
      .catch((error: unknown) => { throw new HttpError(409, error instanceof Error ? error.message : '素材が変更されています'); });
    const work = await mkdtemp(join(tmpdir(), 'harness-audio-fix-'));
    try {
      // 一時出力も同じ拡張子にする（ffmpeg は出力名の拡張子で muxer を選ぶ）。
      const temporary = join(work, `part${extension}`), output = join(work, `fixed${extension}`);
      await runAudioFix(kind, projectId, ffmpeg.bin, asset, input, temporary, output, work);
      const stem = asset.name.replace(/\.[^./\\]+$/, '');
      const imported = await importSequenceAsset(projectDir, output, `${stem}（${LABEL[kind]}）${extension}`);
      if (imported.id === asset.id) throw new HttpError(500, '補正しても内容が変わりませんでした。元の音声のままです');
      const origin = { kind: 'audio-fix', from: asset.id, fix: kind } as const;
      // M3: registerAssetOrigin が失敗した場合、imported はすでに素材台帳へ登録済みだが
      // 由来（origin）だけが付かない。台帳から取り消す API（unregister 相当）が存在しないため、
      // ここでは台帳へは残したまま呼び出し元へ 500 を返す（見送り。素材そのものは無害で、
      // ただ「補正済み」表示が付かないだけ。取り消し口を新設するのは本タスクの範囲外）。
      const registered = await registerAssetOrigin(projectDir, imported.id, origin);
      const result: AudioFixResult = { asset: registered, kind, from: asset.id };
      // I-2: 実行中スロットは応答の「前」に落とす。後ろに置くと一時フォルダ掃除の await が
      // 挟まり、200 を受け取った直後の /status がまだ実行中を返す（UI のボタンが一瞬ロック
      // されたままになり、並列負荷下のテストだけが落ちる flaky にもなる）。
      // 外側 finally の release は自分のトークンと一致した時だけ消すので、二重呼び出しは無害。
      release();
      sendJson(res, 200, result);
    } finally {
      await rm(work, { recursive: true, force: true }).catch(() => undefined);
    }
  } finally {
    release();
  }
}

/** GET /api/audio-fix/status?id=<projectId> — 実行中の補正があるか。 */
export function handleAudioFixStatus(_req: IncomingMessage, res: ServerResponse, projectId: string): void {
  sendJson(res, 200, { running: audioFixRunning(projectId) ?? null });
}
