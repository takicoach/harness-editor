// src/server/trashStore.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync,
  symlinkSync, lstatSync, readdirSync, chmodSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { moveToTrash, listTrash, restoreFromTrash, emptyTrash, TRASH_DIR } from './trashStore';
import { HttpError } from './http';

let base: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'sme-trash-'));
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function writeMaterial(rel: string, content = 'data'): void {
  mkdirSync(join(base, rel, '..'), { recursive: true });
  writeFileSync(join(base, rel), content, 'utf8');
}

describe('moveToTrash / listTrash', () => {
  it('UUID tombstone へ移動し manifest に元パス・種別・削除日時を記録する', () => {
    writeMaterial('public/se/beep.mp3');
    const entry = moveToTrash(base, 'public/se/beep.mp3', 'se');
    expect(existsSync(join(base, 'public/se/beep.mp3'))).toBe(false);
    expect(existsSync(join(base, TRASH_DIR, entry.id, 'beep.mp3'))).toBe(true);
    expect(entry.kind).toBe('se');
    expect(entry.originalPath).toBe('public/se/beep.mp3');
    expect(Number.isNaN(Date.parse(entry.deletedAt))).toBe(false);
    expect(listTrash(base).map((e) => e.id)).toContain(entry.id);
  });

  it('symlink は拒否し、リンクも外部実体も unlink しない（必須ケース）', () => {
    const outside = mkdtempSync(join(tmpdir(), 'sme-outside-'));
    try {
      writeFileSync(join(outside, 'real.mp4'), 'REAL', 'utf8');
      mkdirSync(join(base, 'public'), { recursive: true });
      symlinkSync(join(outside, 'real.mp4'), join(base, 'public', 'linked.mp4'));
      expect(() => moveToTrash(base, 'public/linked.mp4', 'video')).toThrowError(HttpError);
      // 外部実体もリンク自身も残っている
      expect(readFileSync(join(outside, 'real.mp4'), 'utf8')).toBe('REAL');
      expect(lstatSync(join(base, 'public', 'linked.mp4')).isSymbolicLink()).toBe(true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('存在しない対象は 404', () => {
    expect(() => moveToTrash(base, 'public/se/nothing.mp3', 'se')).toThrowError(/見つかりません/);
  });

  it('rename が失敗しても作りかけの tombstone を残さない（baseDir 自身の削除）', () => {
    // '.' は baseDir 自身を指す。自分自身を自分の配下へ移動する rename は必ず失敗する。
    expect(() => moveToTrash(base, '.', 'project')).toThrowError(HttpError);
    const leftovers = existsSync(join(base, TRASH_DIR))
      ? readdirSync(join(base, TRASH_DIR)).filter((n) => n !== 'trash-manifest.json')
      : [];
    expect(leftovers).toEqual([]);
    expect(existsSync(base)).toBe(true);
  });

  it('manifest が壊れていても落ちず、以後の削除で追記できる', () => {
    mkdirSync(join(base, TRASH_DIR), { recursive: true });
    writeFileSync(join(base, TRASH_DIR, 'trash-manifest.json'), '{broken', 'utf8');
    writeMaterial('public/se/beep.mp3');
    const entry = moveToTrash(base, 'public/se/beep.mp3', 'se');
    expect(listTrash(base).map((e) => e.id)).toEqual([entry.id]);
  });
});

describe('moveToTrash の .trash 封じ込め', () => {
  /**
   * P1: `.trash` 自体が外部フォルダへの symlink だと、tombstone の作成
   * （mkdirSync）と renameSync が**プロジェクト外へデータを持ち出す**。
   * 削除・掃除と同じ入口ガードを移動経路にも通す（ガードの 3 経路目）。
   */
  it('.trash が外部への symlink なら移動を拒否し、実体はプロジェクト内に残る', () => {
    const outside = mkdtempSync(join(tmpdir(), 'sme-outside-move-'));
    try {
      writeMaterial('public/se/beep.mp3', 'SOUND');
      symlinkSync(outside, join(base, TRASH_DIR));

      expect(() => moveToTrash(base, 'public/se/beep.mp3', 'se')).toThrow(
        /ゴミ箱がプロジェクトの外を指している/,
      );
      // 実体はプロジェクト内に残る（外へ運ばれていない）。
      expect(readFileSync(join(base, 'public/se/beep.mp3'), 'utf8')).toBe('SOUND');
      // 外部側には tombstone も実体も生えていない。
      expect(readdirSync(outside)).toEqual([]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('restoreFromTrash', () => {
  it('元パスへ復元し、tombstone と manifest から消える（必須ケース）', () => {
    writeMaterial('public/se/beep.mp3', 'SOUND');
    const entry = moveToTrash(base, 'public/se/beep.mp3', 'se');
    const r = restoreFromTrash(base, entry.id);
    expect(r.restoredPath).toBe(join('public/se', 'beep.mp3'));
    expect(readFileSync(join(base, 'public/se/beep.mp3'), 'utf8')).toBe('SOUND');
    expect(listTrash(base)).toEqual([]);
    expect(readdirSync(join(base, TRASH_DIR)).filter((n) => n !== 'trash-manifest.json')).toEqual([]);
  });

  it('同名衝突は -2 連番（uploadMaterial と同じ規則）で回避する', () => {
    writeMaterial('public/se/beep.mp3', 'OLD');
    const entry = moveToTrash(base, 'public/se/beep.mp3', 'se');
    writeMaterial('public/se/beep.mp3', 'NEW'); // 削除後に同名を再アップロードした状況
    const r = restoreFromTrash(base, entry.id);
    expect(r.restoredPath).toBe(join('public/se', 'beep-2.mp3'));
    expect(readFileSync(join(base, 'public/se/beep-2.mp3'), 'utf8')).toBe('OLD');
    expect(readFileSync(join(base, 'public/se/beep.mp3'), 'utf8')).toBe('NEW');
  });

  it('復元先ディレクトリが消えていても再作成して復元する', () => {
    writeMaterial('public/images/sub/logo.png');
    const entry = moveToTrash(base, 'public/images/sub/logo.png', 'image');
    rmSync(join(base, 'public/images'), { recursive: true, force: true });
    const r = restoreFromTrash(base, entry.id);
    expect(r.restoredPath).toBe(join('public/images/sub', 'logo.png'));
    expect(existsSync(join(base, 'public/images/sub/logo.png'))).toBe(true);
  });

  it('未知の entryId は 404', () => {
    expect(() => restoreFromTrash(base, 'no-such-id')).toThrowError(/見つかりません/);
  });

  /**
   * リンク化のあと外付けを外したまま「ゴミ箱から動画を復元」した場合（I-2）。
   * 復元先には symlink が居座っている。連番回避で main-2.mp4 を作ると videoConfig.ts と
   * 食い違い、**リンク切れのまま画面も書き出しも直らない**。symlink を外して元の名前で
   * 戻し、リンク記録も消して「コピー実体のプロジェクト」へ整合させる。
   */
  it('動画の復元先が symlink なら置き換えて videoLink.json も消す', () => {
    const outside = mkdtempSync(join(tmpdir(), 'sme-outside-'));
    try {
      writeMaterial('public/main.mp4', 'REAL-COPY');
      const entry = moveToTrash(base, 'public/main.mp4', 'video');
      // リンク化後の状態を作る（切れたリンク＋記録）。
      writeFileSync(join(outside, 'take1.mp4'), 'REAL-COPY', 'utf8');
      symlinkSync(join(outside, 'take1.mp4'), join(base, 'public', 'main.mp4'));
      mkdirSync(join(base, '.sme'), { recursive: true });
      writeFileSync(join(base, '.sme', 'videoLink.json'), JSON.stringify({ target: join(outside, 'take1.mp4') }), 'utf8');

      const r = restoreFromTrash(base, entry.id);
      expect(r.restoredPath).toBe(join('public', 'main.mp4'));
      expect(lstatSync(join(base, 'public', 'main.mp4')).isSymbolicLink()).toBe(false);
      expect(readFileSync(join(base, 'public', 'main.mp4'), 'utf8')).toBe('REAL-COPY');
      expect(existsSync(join(base, '.sme', 'videoLink.json'))).toBe(false);
      // 外部の実体は消さない（symlink を外しただけ）。
      expect(readFileSync(join(outside, 'take1.mp4'), 'utf8')).toBe('REAL-COPY');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('動画以外の復元は symlink を置き換えない（従来どおり連番で逃げる）', () => {
    const outside = mkdtempSync(join(tmpdir(), 'sme-outside-'));
    try {
      writeMaterial('public/BGM/bgm.mp3', 'OLD');
      const entry = moveToTrash(base, 'public/BGM/bgm.mp3', 'bgm');
      writeFileSync(join(outside, 'x.mp3'), 'EXTERNAL', 'utf8');
      symlinkSync(join(outside, 'x.mp3'), join(base, 'public', 'BGM', 'bgm.mp3'));
      const r = restoreFromTrash(base, entry.id);
      expect(r.restoredPath).toBe(join('public/BGM', 'bgm-2.mp3'));
      expect(lstatSync(join(base, 'public', 'BGM', 'bgm.mp3')).isSymbolicLink()).toBe(true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('emptyTrash', () => {
  it('entryId 指定でその1件だけ完全削除する', () => {
    writeMaterial('public/se/a.mp3');
    writeMaterial('public/se/b.mp3');
    const a = moveToTrash(base, 'public/se/a.mp3', 'se');
    const b = moveToTrash(base, 'public/se/b.mp3', 'se');
    expect(emptyTrash(base, a.id)).toEqual({ removed: 1 });
    expect(listTrash(base).map((e) => e.id)).toEqual([b.id]);
    expect(existsSync(join(base, TRASH_DIR, a.id))).toBe(false);
  });

  it('entryId なしで全件空にする', () => {
    writeMaterial('public/se/a.mp3');
    moveToTrash(base, 'public/se/a.mp3', 'se');
    expect(emptyTrash(base)).toEqual({ removed: 1 });
    expect(listTrash(base)).toEqual([]);
  });

  it('全件空にすると manifest 未参照の孤児 tombstone も回収する（再レビュー M-3）', () => {
    // 孤児＝記録だけ失われた実体（manifest 保存失敗・手動編集・検証落ち entry の除外）。
    // 一覧に出ないので利用者はどう操作しても消せず、ディスクを食い続ける。
    const orphan = randomUUID();
    mkdirSync(join(base, TRASH_DIR, orphan), { recursive: true });
    writeFileSync(join(base, TRASH_DIR, orphan, 'lost.mp3'), 'LOST', 'utf8');
    // UUID 形式でないディレクトリは掃除対象外（第三者が置いたものを消さない）。
    mkdirSync(join(base, TRASH_DIR, 'notes'), { recursive: true });
    writeMaterial('public/se/a.mp3');
    const a = moveToTrash(base, 'public/se/a.mp3', 'se');

    // removed は「一覧に出ていた件数」のまま（利用者に見えていた数と食い違わせない）。
    expect(emptyTrash(base)).toEqual({ removed: 1 });
    expect(existsSync(join(base, TRASH_DIR, a.id))).toBe(false);
    expect(existsSync(join(base, TRASH_DIR, orphan))).toBe(false);
    expect(existsSync(join(base, TRASH_DIR, 'notes'))).toBe(true);
    expect(existsSync(join(base, TRASH_DIR, 'trash-manifest.json'))).toBe(true);
  });

  /**
   * `.trash` ごと外部へ向けられていると、UUID 名が一致するだけで外部ディレクトリを
   * recursive 削除してしまう。**全件・単件のどちらの経路でも**入口で弾く
   * （単件でも削除は `.trash/<uuid>` の recursive rm なので被害は同じ）。
   */
  it('.trash 自体が外部への symlink なら全件削除を拒否する（外部を消さない）', () => {
    const outside = mkdtempSync(join(tmpdir(), 'sme-outside-'));
    try {
      const orphan = randomUUID();
      mkdirSync(join(outside, orphan), { recursive: true });
      writeFileSync(join(outside, orphan, 'keep.mp3'), 'KEEP', 'utf8');
      symlinkSync(outside, join(base, TRASH_DIR));

      expect(() => emptyTrash(base)).toThrow(HttpError);
      expect(readFileSync(join(outside, orphan, 'keep.mp3'), 'utf8')).toBe('KEEP');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('.trash 自体が外部への symlink なら単件削除も拒否する（経路の非対称を作らない）', () => {
    const outside = mkdtempSync(join(tmpdir(), 'sme-outside-single-'));
    try {
      // manifest から参照される「検証を通る」entry を外部側に用意する。単件経路は
      // manifest を引いてから消しにいくため、ガードが無いと外部の実体が消える。
      // isValidTrashEntry の必須キー（id / kind / name / originalPath / deletedAt）を
      // 満たさないと一覧から落ちて 404 になり、**ガードの有無に関わらず throw する**
      // ＝検査にならない。実際に一覧へ載ることを先に確かめてから消しにいく。
      const id = randomUUID();
      mkdirSync(join(outside, id), { recursive: true });
      writeFileSync(join(outside, id, 'keep.mp3'), 'KEEP', 'utf8');
      writeFileSync(
        join(outside, 'trash-manifest.json'),
        JSON.stringify({
          version: 1,
          entries: [
            {
              id,
              kind: 'se',
              name: 'keep.mp3',
              originalPath: 'public/se/keep.mp3',
              deletedAt: new Date().toISOString(),
              sizeBytes: 4,
            },
          ],
        }),
        'utf8',
      );
      symlinkSync(outside, join(base, TRASH_DIR));
      expect(listTrash(base).map((e) => e.id)).toEqual([id]); // 前提: 404 経路ではない

      // 文言まで固定する。「見つかりません」(404) では素通りと区別できない。
      expect(() => emptyTrash(base, id)).toThrow(/ゴミ箱がプロジェクトの外を指している/);
      // アブレーション: ガードが無ければこの実体は消える。存在検査まで見る。
      expect(existsSync(join(outside, id, 'keep.mp3'))).toBe(true);
      expect(readFileSync(join(outside, id, 'keep.mp3'), 'utf8')).toBe('KEEP');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  /**
   * 「空にする」も復元と同じ規約にする。tombstone を先に消してから manifest を書くと、
   * writeManifest が失敗したときに **実体は消えたのに記録だけ残る「ゴースト entry」**
   * ができる。一覧には出るが復元は「ゴミ箱の実体が見つかりません」で必ず失敗し、
   * 利用者はその行をどうやっても消せない。
   */
  it('空にする途中で manifest 保存が失敗しても、記録と実体が食い違わない', () => {
    writeMaterial('public/se/beep.mp3', 'SOUND');
    const entry = moveToTrash(base, 'public/se/beep.mp3', 'se');
    const stored = join(base, TRASH_DIR, entry.id, 'beep.mp3');
    // writeManifest の一時ファイル名をディレクトリで塞ぐ。manifest 本体は普通のファイルの
    // ままなので **読みは通り、書き込みだけが EISDIR で失敗する**（tombstone の削除は
    // できる状態＝「先に消してから記録を書く」順序の穴をそのまま突ける）。
    mkdirSync(join(base, TRASH_DIR, 'trash-manifest.json.tmp'), { recursive: true });

    expect(() => emptyTrash(base)).toThrow();

    // 実体も記録も残っている（ゴーストを作らない）。
    expect(existsSync(stored)).toBe(true);
    expect(listTrash(base).map((e) => e.id)).toEqual([entry.id]);

    // 原因が解消すれば正常に空にできる（恒久破損になっていない）。
    rmSync(join(base, TRASH_DIR, 'trash-manifest.json.tmp'), { recursive: true, force: true });
    expect(emptyTrash(base)).toEqual({ removed: 1 });
    expect(existsSync(stored)).toBe(false);
    expect(listTrash(base)).toEqual([]);
  });

  it('entryId 指定のときは孤児を掃除しない（1件だけ消す操作の意味を変えない）', () => {
    const orphan = randomUUID();
    mkdirSync(join(base, TRASH_DIR, orphan), { recursive: true });
    writeMaterial('public/se/a.mp3');
    const a = moveToTrash(base, 'public/se/a.mp3', 'se');
    expect(emptyTrash(base, a.id)).toEqual({ removed: 1 });
    expect(existsSync(join(base, TRASH_DIR, orphan))).toBe(true);
  });
});

describe('manifest の検証（細工された trash-manifest.json）', () => {
  function writeManifestRaw(json: unknown): void {
    mkdirSync(join(base, TRASH_DIR), { recursive: true });
    writeFileSync(join(base, TRASH_DIR, 'trash-manifest.json'), JSON.stringify(json), 'utf8');
  }

  it('id が UUID でない細工 entry は emptyTrash で baseDir 外を消さない', () => {
    const outside = mkdtempSync(join(tmpdir(), 'sme-outside-'));
    try {
      writeFileSync(join(outside, 'keep.txt'), 'KEEP', 'utf8');
      // id を '../../..' 相当にして .trash/<id> の rmSync を外へ逃がそうとする細工。
      writeManifestRaw({
        version: 1,
        entries: [
          {
            id: `../../..${outside}`,
            kind: 'project',
            name: 'keep.txt',
            originalPath: 'keep.txt',
            deletedAt: new Date().toISOString(),
          },
        ],
      });
      expect(listTrash(base)).toEqual([]);
      expect(emptyTrash(base)).toEqual({ removed: 0 });
      expect(readFileSync(join(outside, 'keep.txt'), 'utf8')).toBe('KEEP');
      expect(existsSync(outside)).toBe(true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('検証で落とした件数を console.warn に出す（黙って消えない・再レビュー M-2）', () => {
    const iso = new Date().toISOString();
    writeManifestRaw({
      version: 1,
      entries: [
        { id: randomUUID(), kind: 'se', name: 'a.mp3', originalPath: '/etc/a.mp3', deletedAt: iso },
        { id: 'not-a-uuid', kind: 'se', name: 'b.mp3', originalPath: 'public/se/b.mp3', deletedAt: iso },
        { id: randomUUID(), kind: 'se', name: 'ok.mp3', originalPath: 'public/se/ok.mp3', deletedAt: iso },
      ],
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(listTrash(base)).toHaveLength(1);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![0])).toContain('2');
    } finally {
      warn.mockRestore();
    }
  });

  it('全 entry が正しければ warn は出ない（正常時に鳴る警告にしない）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      writeMaterial('public/se/a.mp3');
      moveToTrash(base, 'public/se/a.mp3', 'se');
      listTrash(base);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('{"entries":[{}]} でも listTrash は落ちず空一覧を返す', () => {
    writeManifestRaw({ entries: [{}] });
    expect(listTrash(base)).toEqual([]);
  });

  it('originalPath が絶対パス・.. を含む entry は一覧から除外する', () => {
    const iso = new Date().toISOString();
    writeManifestRaw({
      version: 1,
      entries: [
        { id: randomUUID(), kind: 'se', name: 'a.mp3', originalPath: '/etc/a.mp3', deletedAt: iso },
        { id: randomUUID(), kind: 'se', name: 'b.mp3', originalPath: '../b.mp3', deletedAt: iso },
        { id: randomUUID(), kind: 'se', name: 'c/d.mp3', originalPath: 'public/se/d.mp3', deletedAt: iso },
        { id: randomUUID(), kind: 'se', name: 'e.mp3', originalPath: 'public/se/e.mp3', deletedAt: 'not-a-date' },
      ],
    });
    expect(listTrash(base)).toEqual([]);
  });

  it('細工 entry を復元しようとしても 404（baseDir 外へ書かない）', () => {
    writeManifestRaw({
      version: 1,
      entries: [
        {
          id: randomUUID(),
          kind: 'se',
          name: 'a.mp3',
          originalPath: '../escape.mp3',
          deletedAt: new Date().toISOString(),
        },
      ],
    });
    const entries = JSON.parse(
      readFileSync(join(base, TRASH_DIR, 'trash-manifest.json'), 'utf8'),
    ) as { entries: Array<{ id: string }> };
    expect(() => restoreFromTrash(base, entries.entries[0]!.id)).toThrowError(HttpError);
    expect(existsSync(join(base, '..', 'escape.mp3'))).toBe(false);
  });
});

describe('復元先の realpath 封じ込め（再レビュー M-1）', () => {
  it('復元先ディレクトリが外部への symlink なら復元せず、外部へ書かない', () => {
    const outside = mkdtempSync(join(tmpdir(), 'sme-outside-'));
    try {
      // 正規の手順でゴミ箱へ入れてから、元の場所（親ディレクトリ）を外部への symlink へ
      // すり替える。originalPath は 'public/se/beep.mp3' のままなので字面の包含検査
      // （resolve ベース）は通ってしまい、rename が外部フォルダへ着地する。
      writeMaterial('public/se/beep.mp3', 'INSIDE');
      const entry = moveToTrash(base, 'public/se/beep.mp3', 'se');
      rmSync(join(base, 'public', 'se'), { recursive: true, force: true });
      symlinkSync(outside, join(base, 'public', 'se'));

      expect(() => restoreFromTrash(base, entry.id)).toThrowError(HttpError);
      // 文言は経路ごとに分ける（復元で「削除できません」と出さない・再レビュー M-1）。
      expect(() => restoreFromTrash(base, entry.id)).toThrowError(/復元できません/);
      expect(readdirSync(outside)).toEqual([]);
      // 実体はゴミ箱に残したまま（片道で消さない）。
      expect(existsSync(join(base, TRASH_DIR, entry.id, 'beep.mp3'))).toBe(true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  /**
   * 再レビュー M-2: 封じ込め検査が mkdirSync より後ろにあると、検査で弾く前に
   * 外部 symlink の先へ空ディレクトリが生えてしまう（弾いたのに副作用が残る）。
   * 復元先の「実在する最上位の祖先」を mkdir の前に realpath 検査する。
   */
  it('復元先の親が外部 symlink なら、外部側に空ディレクトリを作らずに弾く', () => {
    const outside = mkdtempSync(join(tmpdir(), 'sme-outside-'));
    try {
      writeMaterial('public/se/beep.mp3', 'INSIDE');
      const entry = moveToTrash(base, 'public/se/beep.mp3', 'se');
      // public ごと外部 symlink へすり替える（外部側に se/ は無い＝復元は mkdir から始まる）。
      rmSync(join(base, 'public'), { recursive: true, force: true });
      symlinkSync(outside, join(base, 'public'));

      expect(() => restoreFromTrash(base, entry.id)).toThrowError(HttpError);
      expect(readdirSync(outside)).toEqual([]); // se/ が作られていない
      expect(existsSync(join(base, TRASH_DIR, entry.id, 'beep.mp3'))).toBe(true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('通常の（symlink でない）復元先はこれまで通り復元できる', () => {
    writeMaterial('public/se/beep.mp3', 'INSIDE');
    const entry = moveToTrash(base, 'public/se/beep.mp3', 'se');
    expect(restoreFromTrash(base, entry.id).restoredPath).toBe(join('public/se', 'beep.mp3'));
    expect(readFileSync(join(base, 'public/se/beep.mp3'), 'utf8')).toBe('INSIDE');
  });
});

describe('親ディレクトリ symlink の封じ込め（二重防御）', () => {
  it('親ディレクトリが symlink で外を指す素材は移動できない（外部実体が残る）', () => {
    const outside = mkdtempSync(join(tmpdir(), 'sme-outside-'));
    try {
      writeFileSync(join(outside, 'real.mp3'), 'REAL', 'utf8');
      mkdirSync(join(base, 'public'), { recursive: true });
      // 末端ではなく親ディレクトリが symlink（末端 symlink 検査では検出できないケース）。
      symlinkSync(outside, join(base, 'public', 'BGM'));
      expect(() => moveToTrash(base, 'public/BGM/real.mp3', 'bgm')).toThrowError(HttpError);
      expect(readFileSync(join(outside, 'real.mp3'), 'utf8')).toBe('REAL');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('manifest 書き込み失敗時の巻き戻し', () => {
  it('rename 後に manifest 保存が失敗したら元パスへ戻して 500', () => {
    writeMaterial('public/se/beep.mp3', 'SOUND');
    // manifest 本体をディレクトリにしておくと writeManifest の renameSync が必ず失敗する。
    mkdirSync(join(base, TRASH_DIR, 'trash-manifest.json', 'x'), { recursive: true });
    expect(() => moveToTrash(base, 'public/se/beep.mp3', 'se')).toThrowError(HttpError);
    // 素材は元の場所に戻っている（消失させない）
    expect(readFileSync(join(base, 'public/se/beep.mp3'), 'utf8')).toBe('SOUND');
    const leftovers = readdirSync(join(base, TRASH_DIR)).filter(
      (n) => n !== 'trash-manifest.json',
    );
    expect(leftovers).toEqual([]);
  });
});

describe('復元中の manifest 保存失敗', () => {
  /**
   * P2: 復元は「rename（実体を戻す）→ manifest 更新」の 2 段。manifest 更新が最後だと、
   * そこで失敗したときに **実体は復元済みなのに manifest には古い entry が残る**。
   * 以後の復元試行は `stored` を見に行って「ゴミ箱の実体が見つかりません」で
   * **恒久に失敗**し、一覧からも消せない entry が残る。
   *
   * manifest を先にコミットし、失敗したら rename を巻き戻すことで、
   * 「実体と記録が食い違ったまま固定される」状態を作らない。
   */
  it('復元中に manifest 保存が失敗したら巻き戻し、記録と実体が整合したまま残る', () => {
    writeMaterial('public/se/beep.mp3', 'SOUND');
    const entry = moveToTrash(base, 'public/se/beep.mp3', 'se');
    const stored = join(base, TRASH_DIR, entry.id, 'beep.mp3');
    const dest = join(base, 'public/se/beep.mp3');
    expect(existsSync(stored)).toBe(true);
    expect(existsSync(dest)).toBe(false);

    // .trash を r-x にすると readManifest（既存ファイルの読み）は通り、writeManifest の
    // 一時ファイル作成だけが EACCES で失敗する。tombstone 配下は書けるままなので
    // rename とその巻き戻しは動く＝「manifest 保存だけが失敗」を正確に再現できる。
    chmodSync(join(base, TRASH_DIR), 0o500);
    try {
      expect(() => restoreFromTrash(base, entry.id)).toThrow(HttpError);
    } finally {
      chmodSync(join(base, TRASH_DIR), 0o700);
    }

    // 巻き戻し済み: 実体は tombstone に戻り、復元先には出ていない。
    expect(existsSync(stored)).toBe(true);
    expect(existsSync(dest)).toBe(false);
    // 記録も残っている（実体と食い違わない）。
    expect(listTrash(base).map((e) => e.id)).toEqual([entry.id]);
    // 恒久不整合になっていないこと＝原因が解消すれば復元できる。
    expect(restoreFromTrash(base, entry.id).restoredPath).toBe(join('public', 'se', 'beep.mp3'));
    expect(readFileSync(dest, 'utf8')).toBe('SOUND');
    expect(listTrash(base)).toEqual([]);
  });
});

describe('プロジェクト（ディレクトリ）の tombstone', () => {
  it('ディレクトリごと移動・復元できる（拡張子なし名の -2 連番含む）', () => {
    mkdirSync(join(base, 'proj', 'src'), { recursive: true });
    writeFileSync(join(base, 'proj', 'src', 'a.ts'), 'A', 'utf8');
    const entry = moveToTrash(base, 'proj', 'project');
    expect(existsSync(join(base, 'proj'))).toBe(false);
    mkdirSync(join(base, 'proj')); // 復元前に同名ディレクトリができた状況
    const r = restoreFromTrash(base, entry.id);
    expect(r.restoredPath).toBe('proj-2');
    expect(readFileSync(join(base, 'proj-2', 'src', 'a.ts'), 'utf8')).toBe('A');
  });
});
