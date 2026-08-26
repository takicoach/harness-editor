import { closeSync, openSync, readSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { extname, join, resolve } from 'node:path';
import { VIDEO_EXTENSIONS } from '../shared/videoExtensions';
import { isContained } from './projectRoot';
import type { BrowseRoot } from './browsePaths';

/**
 * 「手元の動画ファイルと同一の実体が、登録済みブラウズルート（外付け等）にあるか」を探す。
 *
 * ブラウザは D&D / ファイル選択で選ばれたファイルの**元のパスを渡さない**ため、
 * アップロードで受け取った実体と同じものが外付けに在るかどうかは、こちらで
 * 探しに行くしかない。見つかればコピーをやめて symlink 取り込みへ切り替える
 * （内蔵ストレージを消費しない）。
 *
 * 判定は保守的に倒す。**取り違えると「別の動画で編集を続ける」という静かな事故**に
 * なるため、少しでも曖昧なら従来どおりコピーする:
 *  - サイズ完全一致（＋名前が分かる経路では名前も完全一致）を必要条件にする
 *  - そのうえで先頭・末尾チャンクのハッシュ一致まで取る
 *  - 候補が 2 件以上（同名同サイズが複数）は ambiguous としてリンク化しない
 *
 * 走査は「起点配下のみ・深さ/件数/時間の上限つき・symlink を辿らない」。
 * これは `browsePaths.listDirectory`（1 階層）と同じ封じ込め方針の再帰版で、
 * 対象パスはすべてサーバ側の走査結果であり、クライアントから受け取らない。
 */

/** 走査の上限。UI を待たせすぎず、巨大ドライブでもサーバを詰まらせない。 */
export interface MatchLimits {
  /** 起点からの深さ（起点直下＝1）。 */
  maxDepth: number;
  /** 見た entry の総数。 */
  maxEntries: number;
  /** 経過時間の上限（ミリ秒）。 */
  maxMillis: number;
}

/**
 * 探索時間の既定（ミリ秒）。**この探索は同期で走り、その間エディタは応答しない**ので、
 * 「待たされた」と感じる前に必ず戻る長さにしてある。見つからなければ従来どおりコピー
 * （＝取り込み自体は失敗しない）なので、短く倒す方の副作用は軽い。
 *
 * 将来課題: 子プロセス（worker）へ出して非同期化すれば上限を伸ばせる。今回は見送り
 * （同期 API 前提の封じ込め・巻き戻しの規律を跨ぐ変更になるため）。
 * それまでの逃げ道として `HARNESS_LINK_SCAN_MS` で伸ばせるようにしてある。
 */
export const DEFAULT_SCAN_MILLIS = 3000;

/** `HARNESS_LINK_SCAN_MS`（正の整数のみ有効）。不正値は既定へ落とす。 */
export function scanMillisFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env['HARNESS_LINK_SCAN_MS'];
  if (raw === undefined || raw === '') return DEFAULT_SCAN_MILLIS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_SCAN_MILLIS;
  return Math.floor(n);
}

export const DEFAULT_MATCH_LIMITS: MatchLimits = {
  maxDepth: 6,
  maxEntries: 50000,
  maxMillis: DEFAULT_SCAN_MILLIS,
};

/** 実際に使う上限。時間だけは env で上書きできる（呼び出しのたびに読み直す）。 */
export function defaultMatchLimits(): MatchLimits {
  return { ...DEFAULT_MATCH_LIMITS, maxMillis: scanMillisFromEnv() };
}

/** 内容照合に使う先頭・末尾チャンクの大きさ。 */
export const DEFAULT_CHUNK_BYTES = 4 * 1024 * 1024;

/** 走査で見つかった候補。 */
export interface FoundFile {
  path: string;
  sizeBytes: number;
  mtimeMs: number;
}

export interface FindOptions {
  /** この配下は走査しない（プロジェクト置き場＝コピー実体そのものを候補にしないため）。 */
  exclude?: string[];
  limits?: MatchLimits;
  now?: () => number;
}

/**
 * 起点配下から「サイズ一致（name 指定時は名前も一致）」の動画を集める。
 * 候補が 2 件に達した時点で打ち切る（2 件＝曖昧確定なので、それ以上数える意味がない）。
 */
export function findSizeMatches(
  roots: BrowseRoot[],
  criteria: { name: string | null; sizeBytes: number },
  options: FindOptions = {},
): { candidates: FoundFile[]; exhausted: boolean } {
  const limits = options.limits ?? defaultMatchLimits();
  const now = options.now ?? (() => Date.now());
  const excluded = (options.exclude ?? []).map((p) => resolve(p));
  const startedAt = now();
  const candidates: FoundFile[] = [];
  // 同じ実体を 2 度数えない（M-1）。起点は入れ子で登録され得る（「外付け全体」と
  // 「その中の撮影フォルダ」の両方など）。素の path で数えると 1 本の動画が 2 候補になり、
  // ambiguous 扱いで**リンク化できる場面が黙って消える**。
  const seenReal = new Set<string>();
  let seen = 0;
  let exhausted = false;

  const isExcluded = (dir: string): boolean =>
    excluded.some((ex) => isContained(resolve(dir), ex));

  const stack: Array<{ dir: string; depth: number }> = [];
  for (const root of roots) {
    if (!isExcluded(root.path)) stack.push({ dir: root.path, depth: 1 });
  }

  while (stack.length > 0) {
    if (candidates.length >= 2) break;
    if (now() - startedAt > limits.maxMillis) {
      exhausted = true;
      break;
    }
    const item = stack.pop();
    if (item === undefined) break;
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(item.dir, { withFileTypes: true });
    } catch {
      continue; // 未接続・権限なしの起点は飛ばす（一覧全体を落とさない）
    }
    for (const e of entries) {
      if (candidates.length >= 2) break;
      if (seen >= limits.maxEntries) {
        exhausted = true;
        break;
      }
      seen++;
      if (e.name.startsWith('.')) continue;
      // Dirent は lstat 相当なので、symlink はここで確実に分かる。
      // 辿らない: 外付け内から内蔵を指すリンクを候補にすると、リンク化しても容量が減らない。
      if (e.isSymbolicLink()) continue;
      const full = join(item.dir, e.name);
      if (e.isDirectory()) {
        if (isExcluded(full)) continue;
        if (item.depth >= limits.maxDepth) {
          exhausted = true;
          continue;
        }
        stack.push({ dir: full, depth: item.depth + 1 });
        continue;
      }
      if (!e.isFile()) continue;
      if (!VIDEO_EXTENSIONS.includes(extname(e.name).toLowerCase())) continue;
      if (criteria.name !== null && e.name !== criteria.name) continue;
      let st: import('node:fs').Stats;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      // Dirent が通常ファイルだと言っても、stat 側でも確かめる（#142: FIFO・
      // キャラクタデバイスは size=0 で上限判定を素通りし、読み込みが恒久ブロックする）。
      if (!st.isFile()) continue;
      if (st.size !== criteria.sizeBytes) continue;
      let real: string;
      try {
        real = realpathSync(full);
      } catch {
        real = resolve(full); // realpath が引けなくても候補自体は落とさない
      }
      if (seenReal.has(real)) continue;
      seenReal.add(real);
      candidates.push({ path: full, sizeBytes: st.size, mtimeMs: st.mtimeMs });
    }
    if (seen >= limits.maxEntries) break;
  }
  return { candidates, exhausted };
}

/**
 * 先頭チャンクと末尾チャンクの SHA-256。サイズもハッシュに混ぜる。
 *
 * 全体ハッシュは 19GB 級の素材で現実的でない（読み切るだけで数分）。
 * 動画は先頭にヘッダ、末尾に moov/インデックスが来ることが多く、
 * 「サイズ完全一致 ＋ 両端一致」で取り違えは実用上潰せる。
 */
export function chunkDigest(
  path: string,
  sizeBytes: number,
  chunkBytes: number = DEFAULT_CHUNK_BYTES,
): string {
  const hash = createHash('sha256').update(`size:${sizeBytes}\n`);
  const fd = openSync(path, 'r');
  try {
    const head = Math.min(chunkBytes, sizeBytes);
    const buf = Buffer.alloc(Math.max(1, head));
    if (head > 0) {
      const read = readSync(fd, buf, 0, head, 0);
      hash.update(buf.subarray(0, read));
    }
    if (sizeBytes > chunkBytes) {
      const tail = Math.min(chunkBytes, sizeBytes);
      const tailBuf = Buffer.alloc(tail);
      const read = readSync(fd, tailBuf, 0, tail, sizeBytes - tail);
      hash.update(tailBuf.subarray(0, read));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest('hex');
}

/** マッチング結果。matched=false の reason は UI の説明文と運用調査のために残す。 */
export type MatchOutcome =
  | { matched: true; target: string; sizeBytes: number; mtimeMs: number }
  | {
      matched: false;
      reason:
        | 'no-candidate'
        /** 上限（時間・件数・深さ）で走査を打ち切ったまま候補 0。「無い」とは言い切れない。 */
        | 'search-truncated'
        | 'ambiguous'
        | 'content-mismatch'
        | 'unreadable';
    };

export interface MatchDeps extends FindOptions {
  chunkBytes?: number;
  digest?: (path: string, sizeBytes: number, chunkBytes: number) => string;
  find?: typeof findSizeMatches;
}

/**
 * 手元の実体（source.path）と同一のファイルを起点配下から探す。
 * 少しでも曖昧なら matched:false を返す（呼び出し側は従来どおりコピーする）。
 */
export function findLinkTarget(
  source: { path: string; name: string | null; sizeBytes: number },
  roots: BrowseRoot[],
  deps: MatchDeps = {},
): MatchOutcome {
  // サイズ 0 は「中身が無い」＝両端ハッシュも常に一致してしまう。決してマッチさせない。
  if (source.sizeBytes <= 0) return { matched: false, reason: 'no-candidate' };
  const find = deps.find ?? findSizeMatches;
  const chunkBytes = deps.chunkBytes ?? DEFAULT_CHUNK_BYTES;
  const digest = deps.digest ?? chunkDigest;

  const { candidates, exhausted } = find(
    roots,
    { name: source.name, sizeBytes: source.sizeBytes },
    { exclude: deps.exclude, limits: deps.limits, now: deps.now },
  );
  // 打ち切ったなら候補の件数に関わらずリンク化しない。
  //   ・候補 0 は「無い」ではなく「見終わっていない」。同じ文言で返すと、実際には
  //     外付けに在る動画について利用者が「無いのか」と諦めてしまう。
  //   ・候補 1 も「これしか無い」の証明にはならない。**未走査の領域に同名同サイズが
  //     残っている可能性がある**ので、一意性は確立していない（ambiguous と同じ規律）。
  // 取り違えは「別の動画で編集を続ける」という静かな事故になるため、リンク化の
  // 成功率よりも取り違えの回避を優先する（外れてもコピー取り込みに落ちるだけ）。
  if (exhausted) return { matched: false, reason: 'search-truncated' };
  if (candidates.length === 0) return { matched: false, reason: 'no-candidate' };
  if (candidates.length > 1) return { matched: false, reason: 'ambiguous' };
  const candidate = candidates[0]!;
  let sourceDigest: string;
  let candidateDigest: string;
  try {
    sourceDigest = digest(source.path, source.sizeBytes, chunkBytes);
    candidateDigest = digest(candidate.path, candidate.sizeBytes, chunkBytes);
  } catch {
    // 読めない（権限・切断・非通常ファイル）は「確証が取れない」＝コピー経路へ落とす。
    return { matched: false, reason: 'unreadable' };
  }
  if (sourceDigest !== candidateDigest) return { matched: false, reason: 'content-mismatch' };
  return {
    matched: true,
    target: candidate.path,
    sizeBytes: candidate.sizeBytes,
    mtimeMs: candidate.mtimeMs,
  };
}
