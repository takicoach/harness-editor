import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import type {
  InstructionContext,
  InstructionInput,
  InstructionRecord,
  InstructionStatus,
} from '../shared/types';
import { HttpError } from './http';
import { acquireInboxLock, parseInboxFile, releaseInboxLock, serializeInbox } from './inboxPersistence';

/** enqueue の入力（projectDir はサーバ側で解決済み）。 */
export interface EnqueueInput {
  projectId: string;
  projectDir: string;
  text: string;
  context: InstructionContext;
}

/** 専属在席（そのプロジェクト指定の poll/報告）の鮮度（ms）。既存 isAgentConnected の graceMs と同値。 */
export const DEDICATED_GRACE_MS = 180_000;

/** AI エージェント（MCP 消費者）の在席シグナル。 */
export interface AgentStatus {
  /** グローバル待機（フィルタなし takeOrWait）でブロック待機中の消費者数（従来通り）。 */
  waiting: number;
  /** 最後にグローバル poll（フィルタなし takeOrWait）が呼ばれた時刻（ms）。専属 poll は含めない。一度も無ければ null。 */
  lastPollAt: number | null;
  /** グローバル経由で processing のまま報告待ちのレコードがあるか（エージェントが編集作業中）。 */
  processing: boolean;
  /** agentStatus(projectId) 指定時のみ付与。その動画の専属在席（poll または報告）が新鮮か。 */
  dedicated?: { connected: boolean };
}

/** 受け箱の公開 API。 */
export interface InstructionInbox {
  enqueue(input: EnqueueInput): InstructionRecord;
  /**
   * pending を processing にして返す。無ければ null。
   * filter.projectId 指定時はそのプロジェクトの pending のみ対象（専属モード）。
   * 同一プロジェクトは processing が 1 件でもあれば以降の pending を配送しない（直列配送）。
   * フィルタなし取得では、専属在席が新鮮なプロジェクトの pending をスキップし（専属優先）、
   * グローバル経由の processing が maxGlobalParallel 以上なら null を返す（上限）。
   */
  takeNext(filter?: { projectId?: string }): InstructionRecord | null;
  /**
   * pending があれば即返す。無ければ waitMs まで待つ。
   * projectId 指定時は専属モード（在席は専属としてのみ記録・専属 waker として起床）、
   * 未指定はグローバルモード（従来通り・在席カウンタ waiting/lastPollAt を更新）。
   */
  takeOrWait(waitMs: number, projectId?: string): Promise<InstructionRecord | null>;
  /** processing → done/failed のみ受理して更新する。それ以外の遷移は拒否して null。 */
  updateStatus(id: string, status: InstructionStatus, reply?: string | null): InstructionRecord | null;
  /** processing のレコードを手動で打ち切る（failed・reply「手動で打ち切られました」）。processing 以外は null。 */
  abort(id: string): InstructionRecord | null;
  /** projectId のレコードを作成順で返す。 */
  list(projectId: string): InstructionRecord[];
  /** レコード変化（enqueue / updateStatus）を購読する。SSE 用。解除関数を返す。 */
  subscribe(listener: (record: InstructionRecord) => void): () => void;
  /** エージェント在席シグナルを返す（/api/agent-status 用）。projectId 指定時は dedicated も付与。 */
  agentStatus(projectId?: string): AgentStatus;
  /**
   * 同期単一 writer による永続化を有効にする（`.sme-inbox.json` への保存/復元）。
   * pidfile ロックが取れなければ `{ persisted: false }` を返し、以降メモリのみで動作する
   * （他プロセスがこのフォルダで既に永続化を握っている場合の安全側フォールバック）。
   * ロックが取れた場合、既存ファイルがあれば復元する：pending はそのまま・processing は
   * failed（「エディタ再起動により結果を確認できませんでした」）・projectDir 解決不能な
   * pending は failed（「対象プロジェクトが見つかりません」）。
   */
  attachPersistence(
    filePath: string,
    deps: { resolveProjectDir: (projectId: string) => string | null },
  ): { persisted: boolean };
  /** 永続化を無効化し、ロックを解放する。以降はメモリのみで動作する。 */
  releasePersistence(): void;
}

/** processing のまま再起動を迎えたレコードへ付ける返答（結果不明扱い）。 */
const RESTART_UNKNOWN_REPLY =
  'エディタ再起動により結果を確認できませんでした。動画の状態を確認し、必要な場合のみもう一度指示してください';

/** 復元時に projectDir を解決できなかった pending レコードへ付ける返答。 */
const PROJECT_NOT_FOUND_REPLY = '対象プロジェクトが見つかりません';

/**
 * 在席シグナルから「接続中」を判定する純関数。
 * - waiting > 0: ロングポーリングでブロック中＝確実に接続中。
 * - processing: 指示を取り出して編集作業中（この間はポーリングが止まる）。
 * - lastPollAt が graceMs 以内: ポーリングの谷間（done 報告→次の取得の間など）。
 */
export function isAgentConnected(
  status: AgentStatus,
  now: number,
  graceMs = 180_000,
): boolean {
  if (status.waiting > 0 || status.processing) return true;
  return status.lastPollAt !== null && now - status.lastPollAt < graceMs;
}

export function createInstructionInbox(opts?: {
  maxGlobalParallel?: number;
  now?: () => number;
}): InstructionInbox {
  const now = opts?.now ?? Date.now;
  const maxGlobalParallel =
    opts?.maxGlobalParallel ??
    Math.max(1, Number.parseInt(process.env.SME_MAX_PARALLEL_INSTRUCTIONS ?? '', 10) || 3);

  // 挿入順を保つ Map（メモリ保持・再起動で消える）。
  const records = new Map<string, InstructionRecord>();
  // 内部 claim 情報（公開レコードには載せない）。どちらの経路で取得されたか。
  const claims = new Map<string, { takenVia: 'dedicated' | 'global' }>();
  // 専属在席: projectId → 最後の専属 poll / 専属レコード報告の時刻。
  const dedicatedSeenAt = new Map<string, number>();
  const listeners = new Set<(record: InstructionRecord) => void>();
  // takeOrWait の待機者。projectId 指定は専属 waker、未指定はグローバル waker。
  const wakers = new Set<{ projectId?: string; fn: () => void }>();
  let seq = 0;
  // グローバル在席シグナル（フィルタなし takeOrWait のみ更新。AI タブの接続表示用）。
  let globalLastPollAt: number | null = null;
  let globalWaiting = 0;

  function emit(record: InstructionRecord): void {
    for (const l of listeners) l(record);
  }

  // 永続化状態。attachPersistence が呼ばれるまでは全て無効（メモリのみ）。
  let persistFilePath: string | null = null;
  let persistLockPath: string | null = null;
  let writeSeq = 0;

  /** 実際にファイルへ書く（同期・tmp→rename）。失敗時は呼び出し元へ throw する。 */
  function writeInboxFile(): void {
    if (persistFilePath === null) return;
    const json = serializeInbox([...records.values()], claims, seq);
    const tmpPath = `${persistFilePath}.${process.pid}.${++writeSeq}.tmp`;
    writeFileSync(tmpPath, json, { mode: 0o600 });
    renameSync(tmpPath, persistFilePath);
  }

  // enqueue 経路: 保存失敗を呼び出し元へ伝える必要があるため throw させる。
  let persistOrThrow: () => void = () => {};
  // takeNext/updateStatus 経路: 保存失敗があっても処理は止めない（警告ログのみ）。
  let persistBestEffort: () => void = () => {};

  function processingProjects(): Set<string> {
    const s = new Set<string>();
    for (const r of records.values()) if (r.status === 'processing') s.add(r.projectId);
    return s;
  }

  function dedicatedFresh(projectId: string): boolean {
    const seen = dedicatedSeenAt.get(projectId);
    if (seen !== undefined && now() - seen < DEDICATED_GRACE_MS) return true;
    // 専属経由の processing が残っている間も在席扱い。
    for (const r of records.values()) {
      if (r.status === 'processing' && r.projectId === projectId && claims.get(r.id)?.takenVia === 'dedicated') {
        return true;
      }
    }
    return false;
  }

  function globalInFlight(): number {
    let n = 0;
    for (const r of records.values()) {
      if (r.status === 'processing' && claims.get(r.id)?.takenVia === 'global') n++;
    }
    return n;
  }

  function wake(projectId: string): void {
    // 専属 waker（該当プロジェクト）→ グローバル waker の順で起こす。
    for (const w of [...wakers]) if (w.projectId === projectId) w.fn();
    for (const w of [...wakers]) if (w.projectId === undefined) w.fn();
  }

  const inbox: InstructionInbox = {
    enqueue(input) {
      const timestamp = now();
      const id = `inst-${++seq}`;
      const record: InstructionRecord = {
        id,
        projectId: input.projectId,
        projectDir: input.projectDir,
        text: input.text,
        context: input.context,
        status: 'pending',
        reply: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      records.set(id, record);
      try {
        persistOrThrow();
      } catch (err) {
        // 保存に失敗した指示は受付自体を取り消す。メモリに残すと 500 を返したのに
        // ポーリング中のエージェントが取得・実行してしまう（seq のギャップは無害）。
        records.delete(id);
        throw err;
      }
      emit(record);
      wake(record.projectId);
      return record;
    },

    takeNext(filter) {
      const busy = processingProjects();
      if (filter?.projectId === undefined && globalInFlight() >= maxGlobalParallel) return null;
      for (const record of records.values()) {
        if (record.status !== 'pending') continue;
        if (busy.has(record.projectId)) continue; // 直列配送
        if (filter?.projectId !== undefined) {
          if (record.projectId !== filter.projectId) continue;
        } else if (dedicatedFresh(record.projectId)) {
          continue; // 専属優先
        }
        record.status = 'processing';
        record.updatedAt = now();
        claims.set(record.id, { takenVia: filter?.projectId !== undefined ? 'dedicated' : 'global' });
        persistBestEffort();
        emit(record);
        return record;
      }
      return null;
    },

    async takeOrWait(waitMs, projectId) {
      if (projectId !== undefined) {
        dedicatedSeenAt.set(projectId, now());
      } else {
        globalLastPollAt = now();
      }
      const immediate = inbox.takeNext(projectId !== undefined ? { projectId } : undefined);
      if (immediate !== null) return immediate;
      // waitMs 以下0は「待たない」即時ポーリング。在席記録だけ残し、待機者登録はしない
      // （そうしないと後続の enqueue がこの poll を即座に消費してしまう）。
      if (waitMs <= 0) return null;
      if (projectId === undefined) globalWaiting++;
      return new Promise<InstructionRecord | null>((resolve) => {
        let settled = false;
        const finish = (value: InstructionRecord | null) => {
          if (settled) return;
          settled = true;
          if (projectId === undefined) {
            globalWaiting--;
            globalLastPollAt = now();
          } else {
            dedicatedSeenAt.set(projectId, now());
          }
          wakers.delete(waker);
          clearTimeout(timer);
          resolve(value);
        };
        // enqueue / updateStatus(done|failed) 時に呼ばれる。pending を取れたら resolve。
        const waker: { projectId?: string; fn: () => void } = {
          projectId,
          fn: () => {
            const next = inbox.takeNext(projectId !== undefined ? { projectId } : undefined);
            if (next !== null) finish(next);
          },
        };
        const timer = setTimeout(() => finish(null), waitMs);
        wakers.add(waker);
      });
    },

    updateStatus(id, status, reply = null) {
      const record = records.get(id);
      if (record === undefined) return null;
      if (record.status !== 'processing' || (status !== 'done' && status !== 'failed')) return null;
      const claim = claims.get(id);
      record.status = status;
      record.reply = reply;
      record.updatedAt = now();
      claims.delete(id);
      if (claim?.takenVia === 'dedicated') dedicatedSeenAt.set(record.projectId, now()); // 報告=在席
      persistBestEffort();
      emit(record);
      wake(record.projectId); // 直列/上限で待たされていた取得を解放
      return record;
    },

    abort(id) {
      const record = records.get(id);
      if (record === undefined || record.status !== 'processing') return null;
      // updateStatus と同経路（遷移ガードを通る processing→failed）。
      return inbox.updateStatus(id, 'failed', '手動で打ち切られました');
    },

    list(projectId) {
      return [...records.values()].filter((r) => r.projectId === projectId);
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    agentStatus(projectId) {
      let processing = false;
      for (const r of records.values()) {
        if (r.status === 'processing' && claims.get(r.id)?.takenVia === 'global') {
          processing = true;
          break;
        }
      }
      const base: AgentStatus = { waiting: globalWaiting, lastPollAt: globalLastPollAt, processing };
      if (projectId !== undefined) base.dedicated = { connected: dedicatedFresh(projectId) };
      return base;
    },

    attachPersistence(filePath, deps) {
      const lockPath = `${filePath}.lock`;
      if (!acquireInboxLock(lockPath)) {
        return { persisted: false };
      }
      persistFilePath = filePath;
      persistLockPath = lockPath;

      if (existsSync(filePath)) {
        let text = '';
        try {
          text = readFileSync(filePath, 'utf8');
        } catch (err) {
          console.warn('[sme] 受け箱ファイルの読み込みに失敗しました', err);
        }
        const parsed = text === '' ? null : parseInboxFile(text, now());
        if (parsed !== null) {
          let maxSeqFromIds = 0;
          for (const { record } of parsed.records) {
            const match = /^inst-(\d+)$/.exec(record.id);
            const matchedNumber = match?.[1];
            if (matchedNumber !== undefined) {
              maxSeqFromIds = Math.max(maxSeqFromIds, Number.parseInt(matchedNumber, 10));
            }

            const dir = deps.resolveProjectDir(record.projectId);
            if (record.status === 'processing') {
              records.set(record.id, {
                ...record,
                projectDir: dir ?? record.projectDir,
                status: 'failed',
                reply: RESTART_UNKNOWN_REPLY,
                updatedAt: now(),
              });
            } else if (record.status === 'pending') {
              if (dir === null) {
                records.set(record.id, {
                  ...record,
                  status: 'failed',
                  reply: PROJECT_NOT_FOUND_REPLY,
                  updatedAt: now(),
                });
              } else {
                records.set(record.id, { ...record, projectDir: dir });
              }
            } else {
              // done/failed（既に終端）は状態を変えず、projectDir だけ再解決できれば更新する。
              records.set(record.id, { ...record, projectDir: dir ?? record.projectDir });
            }
          }
          seq = Math.max(seq, parsed.seq, maxSeqFromIds);
        }
      }

      persistOrThrow = () => {
        writeInboxFile();
      };
      persistBestEffort = () => {
        try {
          writeInboxFile();
        } catch (err) {
          console.warn('[sme] 受け箱の永続化に失敗しました', err);
        }
      };
      // 復元時の状態変換（processing→failed 等）をファイルへ確定させる。
      persistBestEffort();
      return { persisted: true };
    },

    releasePersistence() {
      persistOrThrow = () => {};
      persistBestEffort = () => {};
      persistFilePath = null;
      if (persistLockPath !== null) {
        releaseInboxLock(persistLockPath);
        persistLockPath = null;
      }
    },
  };

  return inbox;
}

/** アプリ全体で共有する単一の受け箱（plugin.ts / mcp が参照）。 */
export const instructionInbox = createInstructionInbox();

const SELECTION_KINDS = ['telop', 'image', 'videoInsert', 'bgm', 'se'] as const;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** POST /api/instructions の本文を構造検証する。クライアント由来の任意 JSON なので必ず通す。 */
export function validateInstructionInput(body: unknown): InstructionInput {
  if (!isObject(body)) throw new HttpError(400, '指示リクエストの本文が不正です');
  if (typeof body.projectId !== 'string' || body.projectId === '') {
    throw new HttpError(400, '指示リクエストの projectId が必要です');
  }
  if (typeof body.text !== 'string' || body.text.trim() === '') {
    throw new HttpError(400, '指示リクエストの text が必要です');
  }
  if (!isObject(body.context)) throw new HttpError(400, '指示リクエストの context が不正です');
  const ctx = body.context;
  if (typeof ctx.frame !== 'number' || typeof ctx.timeSec !== 'number') {
    throw new HttpError(400, '指示リクエストの context.frame / timeSec が不正です');
  }
  let selection: InstructionInput['context']['selection'] = null;
  if (ctx.selection !== null && ctx.selection !== undefined) {
    if (!isObject(ctx.selection)) throw new HttpError(400, '指示リクエストの context.selection が不正です');
    const kind = ctx.selection.kind;
    const id = ctx.selection.id;
    if (typeof kind !== 'string' || !SELECTION_KINDS.includes(kind as (typeof SELECTION_KINDS)[number]) || typeof id !== 'string') {
      throw new HttpError(400, '指示リクエストの context.selection が不正です');
    }
    selection = { kind: kind as (typeof SELECTION_KINDS)[number], id };
  }
  return {
    projectId: body.projectId,
    text: body.text,
    context: { frame: ctx.frame, timeSec: ctx.timeSec, selection },
  };
}
