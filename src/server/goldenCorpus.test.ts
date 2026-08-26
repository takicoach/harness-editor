import { describe, it, expect } from 'vitest';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadProjectFromDir } from './loadProjectFiles';
import { saveProjectToDir } from './saveProject';

/**
 * golden corpus バイト同値リリースゲート（Phase 0）。
 * 「open → 無変更 save」の前後で全永続ファイルの hash が一致すること、および
 * 既知の副作用以外の新規ファイル（新 sidecar）が旧プロジェクトへ勝手に生成されない
 * ことを検証する。全 Phase のリリース前に必ず通す。
 */
const FIXTURES = join(import.meta.dirname, '__fixtures__');
const CORPUS = [
  join(FIXTURES, 'golden', 'sample-standard'),
  join(FIXTURES, 'golden', 'legacy-root-cutdata'),
];

/**
 * open→save が新規生成してよい既知の副作用（既存挙動: 学習ベースライン退避）。
 * ここへの追加は「既存挙動の観測」を根拠にする場合のみ許す。
 * 新機能（trash/status/steps 等）の sidecar を足すためにこのリストを広げてはならない。
 */
const ALLOWED_NEW = ['cut-baseline.json', 'cutLearning.json', '.learning/'];

function hashTree(dir: string, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix === '' ? e.name : `${prefix}/${e.name}`;
    if (e.isDirectory()) {
      for (const [k, v] of hashTree(join(dir, e.name), rel)) out.set(k, v);
    } else if (e.isFile()) {
      out.set(rel, createHash('sha256').update(readFileSync(join(dir, e.name))).digest('hex'));
    }
  }
  return out;
}

describe.each(CORPUS.map((dir) => [dir.split('/').slice(-1)[0], dir] as const))(
  'golden corpus: %s',
  (_name, src) => {
    it('open→無変更save で全永続ファイルの hash が一致し、未知の新規ファイルが生えない', () => {
      const work = mkdtempSync(join(tmpdir(), 'sme-golden-'));
      try {
        cpSync(src, work, { recursive: true });
        const before = hashTree(work);
        const loaded = loadProjectFromDir(work);
        saveProjectToDir(work, { project: loaded.project, fingerprint: loaded.save.fingerprint });
        const after = hashTree(work);
        for (const [rel, h] of before) {
          expect(after.get(rel), `${rel} の内容が変わった/消えた`).toBe(h);
        }
        for (const rel of after.keys()) {
          if (before.has(rel)) continue;
          const allowed = ALLOWED_NEW.some((p) => rel === p || rel.startsWith(p));
          expect(allowed, `許可されていない新規ファイル: ${rel}`).toBe(true);
        }
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
    });
  },
);
