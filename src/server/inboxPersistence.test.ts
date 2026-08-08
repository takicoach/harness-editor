import { describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  acquireInboxLock,
  parseInboxFile,
  releaseInboxLock,
  serializeInbox,
} from './inboxPersistence';
import { createInstructionInbox } from './instructionInbox';
import type { InstructionContext, InstructionRecord } from '../shared/types';

const CTX: InstructionContext = { frame: 0, timeSec: 0, selection: null };

function input(text: string, projectId: string) {
  return { projectId, projectDir: `/abs/${projectId}`, text, context: CTX };
}

function withTmpDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'inbox-persistence-test-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('serializeInbox / parseInboxFile 往復', () => {
  it('takenVia を含めてシリアライズし、そのままパースで復元できる', () => {
    const now = 1_700_000_000_000;
    const rec: InstructionRecord = {
      id: 'inst-1',
      projectId: 'p',
      projectDir: '/abs/p',
      text: 'ok',
      context: CTX,
      status: 'processing',
      reply: null,
      createdAt: now,
      updatedAt: now,
    };
    const claims = new Map([[rec.id, { takenVia: 'global' as const }]]);
    const json = serializeInbox([rec], claims, 1);
    const parsed = JSON.parse(json) as { schemaVersion: number; seq: number; records: Array<Record<string, unknown>> };
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.seq).toBe(1);
    expect(parsed.records[0]?.takenVia).toBe('global');

    const roundTrip = parseInboxFile(json, now);
    expect(roundTrip?.seq).toBe(1);
    expect(roundTrip?.records[0]?.takenVia).toBe('global');
    expect(roundTrip?.records[0]?.record.id).toBe('inst-1');
    expect(roundTrip?.records[0]?.record.status).toBe('processing');
  });
});

describe('parseInboxFile（観点2・3: 壊れた入力でも throw しない）', () => {
  it('壊れたレコードが混ざっていても正常分のみ復元する', () => {
    const now = 1_700_000_000_000;
    const validRecord = {
      id: 'inst-1',
      projectId: 'p',
      projectDir: '/abs/p',
      text: 'ok',
      context: { frame: 0, timeSec: 0, selection: null },
      status: 'pending',
      reply: null,
      createdAt: now,
      updatedAt: now,
    };
    const brokenRecord = { id: 'inst-2', status: 'pending' }; // 必須フィールド欠落
    const json = JSON.stringify({ schemaVersion: 1, seq: 2, records: [validRecord, brokenRecord] });

    expect(() => parseInboxFile(json, now)).not.toThrow();
    const parsed = parseInboxFile(json, now);
    expect(parsed?.records).toHaveLength(1);
    expect(parsed?.records[0]?.record.id).toBe('inst-1');
  });

  it('schemaVersion 不一致は復元 0 件（null）で throw しない', () => {
    const json = JSON.stringify({ schemaVersion: 2, seq: 5, records: [] });
    expect(() => parseInboxFile(json, Date.now())).not.toThrow();
    expect(parseInboxFile(json, Date.now())).toBeNull();
  });

  it('不正な JSON テキストでも throw せず null を返す', () => {
    expect(() => parseInboxFile('{not json', Date.now())).not.toThrow();
    expect(parseInboxFile('{not json', Date.now())).toBeNull();
  });

  it('done/failed で updatedAt が7日超のレコードは復元されない', () => {
    const now = 1_700_000_000_000;
    const EIGHT_DAYS = 8 * 24 * 60 * 60 * 1000;
    const stale = {
      id: 'inst-1',
      projectId: 'p',
      projectDir: '/abs/p',
      text: 'old',
      context: { frame: 0, timeSec: 0, selection: null },
      status: 'done',
      reply: 'ok',
      createdAt: now - EIGHT_DAYS,
      updatedAt: now - EIGHT_DAYS,
    };
    const json = JSON.stringify({ schemaVersion: 1, seq: 1, records: [stale] });
    const parsed = parseInboxFile(json, now);
    expect(parsed?.records).toHaveLength(0);
  });
});

describe('acquireInboxLock / releaseInboxLock', () => {
  it('未使用の lock は取得でき、release 後は再取得できる', () => {
    withTmpDir((dir) => {
      const lockPath = join(dir, '.sme-inbox.json.lock');
      expect(acquireInboxLock(lockPath)).toBe(true);
      expect(acquireInboxLock(lockPath)).toBe(false); // 自プロセス生存中は二重取得不可
      releaseInboxLock(lockPath);
      expect(acquireInboxLock(lockPath)).toBe(true);
      releaseInboxLock(lockPath);
    });
  });

  it('生存していない pid の stale lock は奪える', () => {
    withTmpDir((dir) => {
      const lockPath = join(dir, '.sme-inbox.json.lock');
      writeFileSync(lockPath, '999999999'); // 生存していないはずの pid
      expect(acquireInboxLock(lockPath)).toBe(true);
      releaseInboxLock(lockPath);
    });
  });
});

describe('InstructionInbox.attachPersistence / releasePersistence（統合観点）', () => {
  it('観点1: enqueue→takeNext→done がファイルに反映され、releasePersistence→新 inbox attach で pending は pending のまま・processing だったものは failed(結果を確認できませんでした)になる', () => {
    withTmpDir((dir) => {
      const filePath = join(dir, '.sme-inbox.json');
      const resolveProjectDir = (projectId: string) => join(dir, projectId);

      const inbox1 = createInstructionInbox();
      const attach1 = inbox1.attachPersistence(filePath, { resolveProjectDir });
      expect(attach1.persisted).toBe(true);

      inbox1.enqueue(input('保留のまま', 'projPending'));
      inbox1.enqueue(input('処理中のまま', 'projProcessing'));
      inbox1.takeNext({ projectId: 'projProcessing' });
      const doneRec = inbox1.enqueue(input('完了済み', 'projDone'));
      inbox1.takeNext({ projectId: 'projDone' });
      inbox1.updateStatus(doneRec.id, 'done', '完了しました');

      // ファイルへ直接反映されていること。
      const onDisk = JSON.parse(readFileSync(filePath, 'utf8')) as { records: Array<Record<string, unknown>> };
      expect(onDisk.records.find((r) => r.projectId === 'projDone')?.status).toBe('done');

      inbox1.releasePersistence();

      const inbox2 = createInstructionInbox();
      const attach2 = inbox2.attachPersistence(filePath, { resolveProjectDir });
      expect(attach2.persisted).toBe(true);

      expect(inbox2.list('projPending')[0]?.status).toBe('pending');

      const restoredProcessing = inbox2.list('projProcessing')[0];
      expect(restoredProcessing?.status).toBe('failed');
      expect(restoredProcessing?.reply).toContain('結果を確認できませんでした');

      const restoredDone = inbox2.list('projDone')[0];
      expect(restoredDone?.status).toBe('done');
      expect(restoredDone?.reply).toBe('完了しました');

      inbox2.releasePersistence();
    });
  });

  it('観点4: resolveProjectDir が null を返すプロジェクトの pending は復元時に failed「対象プロジェクトが見つかりません」になる', () => {
    withTmpDir((dir) => {
      const filePath = join(dir, '.sme-inbox.json');

      const inbox1 = createInstructionInbox();
      inbox1.attachPersistence(filePath, { resolveProjectDir: (projectId) => join(dir, projectId) });
      inbox1.enqueue(input('迷子', 'ghost'));
      inbox1.releasePersistence();

      const inbox2 = createInstructionInbox();
      const attach2 = inbox2.attachPersistence(filePath, { resolveProjectDir: () => null });
      expect(attach2.persisted).toBe(true);

      const [rec] = inbox2.list('ghost');
      expect(rec?.status).toBe('failed');
      expect(rec?.reply).toBe('対象プロジェクトが見つかりません');

      inbox2.releasePersistence();
    });
  });

  it('観点5: lock 保持中の二重 attach は persisted:false でメモリ動作(ファイルへ書かない)', () => {
    withTmpDir((dir) => {
      const filePath = join(dir, '.sme-inbox.json');
      const resolveProjectDir = (projectId: string) => join(dir, projectId);

      const inbox1 = createInstructionInbox();
      const attach1 = inbox1.attachPersistence(filePath, { resolveProjectDir });
      expect(attach1.persisted).toBe(true);

      const inbox2 = createInstructionInbox();
      const attach2 = inbox2.attachPersistence(filePath, { resolveProjectDir });
      expect(attach2.persisted).toBe(false);

      const before = existsSync(filePath) ? readFileSync(filePath, 'utf8') : null;
      const rec = inbox2.enqueue(input('メモリのみ', 'projX'));
      expect(rec.status).toBe('pending'); // メモリ上では通常どおり動作する
      const after = existsSync(filePath) ? readFileSync(filePath, 'utf8') : null;
      expect(after).toBe(before); // ファイルは変化しない

      inbox1.releasePersistence();
    });
  });

  it('観点6: 復元後の enqueue id は既存最大 seq+1 から採番し重複しない', () => {
    withTmpDir((dir) => {
      const filePath = join(dir, '.sme-inbox.json');
      const resolveProjectDir = (projectId: string) => join(dir, projectId);

      const inbox1 = createInstructionInbox();
      inbox1.attachPersistence(filePath, { resolveProjectDir });
      const a = inbox1.enqueue(input('1番目', 'p'));
      const b = inbox1.enqueue(input('2番目', 'p'));
      expect(a.id).toBe('inst-1');
      expect(b.id).toBe('inst-2');
      inbox1.releasePersistence();

      const inbox2 = createInstructionInbox();
      inbox2.attachPersistence(filePath, { resolveProjectDir });
      const c = inbox2.enqueue(input('3番目', 'p'));
      expect(c.id).toBe('inst-3');
      expect(inbox2.list('p').map((r) => r.id)).toEqual(['inst-1', 'inst-2', 'inst-3']);
      inbox2.releasePersistence();
    });
  });

  it('観点7: takeNext 直後にファイルを読むと該当レコードが processing になっている(persist が応答より先)', () => {
    withTmpDir((dir) => {
      const filePath = join(dir, '.sme-inbox.json');
      const resolveProjectDir = (projectId: string) => join(dir, projectId);

      const inbox = createInstructionInbox();
      inbox.attachPersistence(filePath, { resolveProjectDir });
      const rec = inbox.enqueue(input('x', 'p'));
      const taken = inbox.takeNext();
      expect(taken?.id).toBe(rec.id);

      const onDisk = JSON.parse(readFileSync(filePath, 'utf8')) as { records: Array<Record<string, unknown>> };
      const persisted = onDisk.records.find((r) => r.id === rec.id);
      expect(persisted?.status).toBe('processing');

      inbox.releasePersistence();
    });
  });
});

describe('I-1 回帰: enqueue の保存失敗はメモリからも巻き戻す', () => {
  it('保存失敗で throw した指示は受け箱に残らない（phantom 実行の防止）', () => {
    withTmpDir((dir) => {
      const filePath = join(dir, '.sme-inbox.json');
      const inbox = createInstructionInbox();
      const attach = inbox.attachPersistence(filePath, {
        resolveProjectDir: (projectId) => join(dir, projectId),
      });
      expect(attach.persisted).toBe(true);
      inbox.enqueue(input('先に成功する指示', 'A'));

      // ディレクトリを書込不可にして writeFileSync を失敗させる。
      chmodSync(dir, 0o500);
      try {
        expect(() => inbox.enqueue(input('保存に失敗する指示', 'A'))).toThrow();
      } finally {
        chmodSync(dir, 0o700);
      }

      // 失敗した指示はメモリに残らず、takeNext でも配送されない。
      const listed = inbox.list('A');
      expect(listed).toHaveLength(1);
      expect(listed[0]?.text).toBe('先に成功する指示');
      const taken = inbox.takeNext();
      expect(taken?.text).toBe('先に成功する指示');
      expect(inbox.takeNext()).toBeNull();
      inbox.releasePersistence();
    });
  });
});
