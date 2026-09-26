import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, lstatSync, readFileSync, renameSync, statSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative, sep } from 'node:path';
import { prepareCodexHome, codexRuntimeDir, FALLBACK_NOTE } from './codexHome';

/** editorDir と、偽のユーザーホーム（~/.codex/auth.json を持つ）を作る。 */
function setup(withAuth: boolean): { editorDir: string; fakeHome: string; cleanup: () => void } {
  const editorDir = mkdtempSync(join(tmpdir(), 'sme-codexhome-editor-'));
  const fakeHome = mkdtempSync(join(tmpdir(), 'sme-codexhome-home-'));
  if (withAuth) {
    mkdirSync(join(fakeHome, '.codex'), { recursive: true });
    writeFileSync(join(fakeHome, '.codex', 'auth.json'), '{"mode":"chatgpt"}');
  }
  return {
    editorDir, fakeHome,
    cleanup: () => {
      rmSync(editorDir, { recursive: true, force: true });
      rmSync(fakeHome, { recursive: true, force: true });
    },
  };
}

/** テスト全体で使う偽ホームを渡す deps。 */
function homeDeps(fakeHome: string): { homeDir: () => string } {
  return { homeDir: () => fakeHome };
}

describe('prepareCodexHome', () => {
  it('隔離ディレクトリを作り CODEX_HOME を返す', () => {
    const { editorDir, fakeHome, cleanup } = setup(true);
    try {
      const r = prepareCodexHome(editorDir, { homeDir: () => fakeHome });
      expect(r.env.CODEX_HOME).toBe(codexRuntimeDir(editorDir, homeDeps(fakeHome)));
      expect(existsSync(codexRuntimeDir(editorDir, homeDeps(fakeHome)))).toBe(true);
      expect(r.notes).toEqual([]);
    } finally { cleanup(); }
  });

  it('config.toml を作らない（MCP は -c で毎回注入し、codex 自身の状態書き込みを邪魔しない）', () => {
    const { editorDir, fakeHome, cleanup } = setup(true);
    try {
      prepareCodexHome(editorDir, { homeDir: () => fakeHome });
      expect(existsSync(join(codexRuntimeDir(editorDir, homeDeps(fakeHome)), 'config.toml'))).toBe(false);
    } finally { cleanup(); }
  });

  it('auth.json を symlink してログインを引き継ぐ', () => {
    const { editorDir, fakeHome, cleanup } = setup(true);
    try {
      prepareCodexHome(editorDir, { homeDir: () => fakeHome });
      const link = join(codexRuntimeDir(editorDir, homeDeps(fakeHome)), 'auth.json');
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(readFileSync(link, 'utf8')).toBe('{"mode":"chatgpt"}');
    } finally { cleanup(); }
  });

  it('symlink が失敗したら hard link に降格する（Windows の開発者モード無効時）', () => {
    const { editorDir, fakeHome, cleanup } = setup(true);
    try {
      const r = prepareCodexHome(editorDir, {
        homeDir: () => fakeHome,
        symlink: () => { throw new Error('EPERM'); },
      });
      const link = join(codexRuntimeDir(editorDir, homeDeps(fakeHome)), 'auth.json');
      expect(r.env.CODEX_HOME).toBe(codexRuntimeDir(editorDir, homeDeps(fakeHome)));
      expect(lstatSync(link).isFile()).toBe(true);
      expect(lstatSync(link).isSymbolicLink()).toBe(false);
      expect(r.notes).toEqual([]);
    } finally { cleanup(); }
  });

  it('両方失敗したら隔離をやめ、警告を notes に入れる', () => {
    const { editorDir, fakeHome, cleanup } = setup(true);
    try {
      const r = prepareCodexHome(editorDir, {
        homeDir: () => fakeHome,
        symlink: () => { throw new Error('EPERM'); },
        hardlink: () => { throw new Error('EXDEV'); },
      });
      expect(r.env.CODEX_HOME).toBeUndefined();
      expect(r.notes).toEqual([FALLBACK_NOTE]);
    } finally { cleanup(); }
  });

  it('未ログイン（~/.codex/auth.json が無い）なら隔離のまま進め、警告は出さない', () => {
    const { editorDir, fakeHome, cleanup } = setup(false);
    try {
      const r = prepareCodexHome(editorDir, { homeDir: () => fakeHome });
      expect(r.env.CODEX_HOME).toBe(codexRuntimeDir(editorDir, homeDeps(fakeHome)));
      expect(existsSync(join(codexRuntimeDir(editorDir, homeDeps(fakeHome)), 'auth.json'))).toBe(false);
      expect(r.notes).toEqual([]);
    } finally { cleanup(); }
  });

  it('2回呼んでも壊れない（リンクを張り直す）', () => {
    const { editorDir, fakeHome, cleanup } = setup(true);
    try {
      prepareCodexHome(editorDir, { homeDir: () => fakeHome });
      const r = prepareCodexHome(editorDir, { homeDir: () => fakeHome });
      expect(r.env.CODEX_HOME).toBe(codexRuntimeDir(editorDir, homeDeps(fakeHome)));
      expect(r.notes).toEqual([]);
    } finally { cleanup(); }
  });

  it('隔離 home 内の auth.json が実ファイル（そこでログインした）なら消さない', () => {
    const { editorDir, fakeHome, cleanup } = setup(true);
    try {
      const runtime = codexRuntimeDir(editorDir, homeDeps(fakeHome));
      mkdirSync(runtime, { recursive: true });
      const own = join(runtime, 'auth.json');
      writeFileSync(own, '{"mode":"own"}');
      prepareCodexHome(editorDir, { homeDir: () => fakeHome });
      expect(readFileSync(own, 'utf8')).toBe('{"mode":"own"}');
      expect(lstatSync(own).isSymbolicLink()).toBe(false);
    } finally { cleanup(); }
  });

  it('ログイン→ログアウト後は前回のリンクを掃除する（Important 1 回帰）', () => {
    const { editorDir, fakeHome, cleanup } = setup(true);
    try {
      // 1回目: 通常どおりリンク成功。
      prepareCodexHome(editorDir, { homeDir: () => fakeHome });
      const link = join(codexRuntimeDir(editorDir, homeDeps(fakeHome)), 'auth.json');
      expect(lstatSync(link).isSymbolicLink()).toBe(true);

      // ユーザーが codex logout した状態を模す（実ファイル削除 → symlink はリンク切れになる）。
      rmSync(join(fakeHome, '.codex', 'auth.json'));

      // 2回目: リンク切れの symlink が残ったままだと、codex のログイン結果がユーザーの
      // ホームへ書き戻ってしまう（隔離の目的に反する）。ここで掃除されるべき。
      const r = prepareCodexHome(editorDir, { homeDir: () => fakeHome });

      expect(() => lstatSync(link)).toThrow(); // existsSync はリンク切れで false を返すため lstatSync で判定する
      expect(r.env.CODEX_HOME).toBe(codexRuntimeDir(editorDir, homeDeps(fakeHome)));
      expect(r.notes).toEqual([]);
    } finally { cleanup(); }
  });

  it('hard link 経路でも auth.json の張り直しが起きる（Important 2 回帰・nlink に依存しない）', () => {
    const { editorDir, fakeHome, cleanup } = setup(true);
    const deps = {
      homeDir: () => fakeHome,
      symlink: () => { throw new Error('EPERM'); }, // 常に symlink は使えない環境を模す
    };
    try {
      // 1回目: hard link でリンク成功。
      prepareCodexHome(editorDir, deps);
      const link = join(codexRuntimeDir(editorDir, homeDeps(fakeHome)), 'auth.json');
      expect(readFileSync(link, 'utf8')).toBe('{"mode":"chatgpt"}');

      // codex のトークン更新を模す: temp に新内容を書いて rename で置き換える
      // （元の inode への参照が隔離側の hard link だけになり、nlink は 1 に戻る）。
      const realAuth = join(fakeHome, '.codex', 'auth.json');
      const tmp = `${realAuth}.tmp`;
      writeFileSync(tmp, '{"mode":"chatgpt","refreshed":true}');
      renameSync(tmp, realAuth);

      // 2回目: nlink 方式なら「隔離 home 固有の実ファイル」と誤判定して張り直されず、
      // 古い内容のまま固定される。マーカー方式なら張り直されて新しい内容になる。
      const r = prepareCodexHome(editorDir, deps);

      expect(readFileSync(link, 'utf8')).toBe('{"mode":"chatgpt","refreshed":true}');
      expect(r.env.CODEX_HOME).toBe(codexRuntimeDir(editorDir, homeDeps(fakeHome)));
      expect(r.notes).toEqual([]);
    } finally { cleanup(); }
  });

  it('リンク作成が全部失敗しても、それまでのリンクを失わない（Minor: 原子的差し替え回帰）', () => {
    const { editorDir, fakeHome, cleanup } = setup(true);
    // hard link 経路に固定する。symlink 経路は「対象パスが変わらない限り常に
    // 最新内容を指す」ため、今回追加した「既に正しいリンクなら張り直さない」
    // 最適化（Important 4）で 2 回目の呼び出し自体が早期成功し、symlink/hardlink
    // の失敗パスへ到達しなくなる（＝この回帰テストの前提が成立しない）。
    // そのため hard link 経路かつ realAuth 側を張り替えて「既に正しいリンクでは
    // ない」状態を作り、実際に張り替えを試みさせた上で失敗させる。
    const deps = {
      homeDir: () => fakeHome,
      symlink: () => { throw new Error('EPERM'); },
    };
    try {
      // 1回目: hard link でリンク成功。
      prepareCodexHome(editorDir, deps);
      const link = join(codexRuntimeDir(editorDir, homeDeps(fakeHome)), 'auth.json');
      expect(readFileSync(link, 'utf8')).toBe('{"mode":"chatgpt"}');

      // realAuth 側を temp + rename で張り替える（Important 2 回帰テストと同じ操作）。
      // これで inode が変わり「既に正しいリンク」ではなくなるため、次回呼び出しは
      // 実際に張り替えを試みる。
      const realAuth = join(fakeHome, '.codex', 'auth.json');
      const tmp = `${realAuth}.tmp`;
      writeFileSync(tmp, '{"mode":"chatgpt","refreshed":true}');
      renameSync(tmp, realAuth);

      // 2回目: symlink・hardlink 両方失敗する環境を模す。
      const r = prepareCodexHome(editorDir, {
        ...deps,
        hardlink: () => { throw new Error('EXDEV'); },
      });

      expect(r.env.CODEX_HOME).toBeUndefined();
      expect(r.notes).toEqual([FALLBACK_NOTE]);
      // 「消してから作る」実装だと、ここで前回のリンクごと失われてフォールバックになる。
      // tmp + rename の原子的差し替えなら、失敗しても前回のリンク（内容は更新前のまま
      // だが依然として有効な認証情報）が生き残るはず。
      expect(readFileSync(link, 'utf8')).toBe('{"mode":"chatgpt"}');
    } finally { cleanup(); }
  });

  it('隔離 home 側の auth.json が作り直されたら保護する（symlink 経路・再レビュー指摘の回帰）', () => {
    const { editorDir, fakeHome, cleanup } = setup(true);
    try {
      // 1回目: symlink でリンク成功。
      prepareCodexHome(editorDir, { homeDir: () => fakeHome });
      const runtime = codexRuntimeDir(editorDir, homeDeps(fakeHome));
      const link = join(runtime, 'auth.json');
      expect(lstatSync(link).isSymbolicLink()).toBe(true);

      // codex が隔離 home の中でトークンを更新した状態を模す: linkPath を
      // temp + rename で別内容の実ファイルに置き換える（symlink 自体が新しい
      // 実ファイルに置き換わる）。マーカー等は一切触らずそのまま残す。
      const tmp = join(runtime, 'rotated-auth.tmp');
      writeFileSync(tmp, '{"mode":"chatgpt","rotated":true}');
      renameSync(tmp, link);

      // 2回目: 隔離側で作り直された最新のトークンが、ユーザーの古い
      // auth.json へのリンクで上書きされてはならない。
      const r = prepareCodexHome(editorDir, { homeDir: () => fakeHome });

      expect(readFileSync(link, 'utf8')).toBe('{"mode":"chatgpt","rotated":true}');
      expect(r.env.CODEX_HOME).toBe(runtime);
      // 保護は「降格」ではない（隔離は継続し、警告も出さない）。
      expect(r.notes).toEqual([]);
    } finally { cleanup(); }
  });

  it('隔離 home 側の auth.json が作り直されたら保護する（hard link 経路・再レビュー指摘の回帰）', () => {
    const { editorDir, fakeHome, cleanup } = setup(true);
    const deps = {
      homeDir: () => fakeHome,
      symlink: () => { throw new Error('EPERM'); }, // 常に symlink は使えない環境を模す
    };
    try {
      // 1回目: hard link でリンク成功。
      prepareCodexHome(editorDir, deps);
      const runtime = codexRuntimeDir(editorDir, homeDeps(fakeHome));
      const link = join(runtime, 'auth.json');
      expect(readFileSync(link, 'utf8')).toBe('{"mode":"chatgpt"}');

      // codex が隔離 home の中でトークンを更新した状態を模す（symlink 経路と同じ操作）。
      const tmp = join(runtime, 'rotated-auth.tmp');
      writeFileSync(tmp, '{"mode":"chatgpt","rotated":true}');
      renameSync(tmp, link);

      // 2回目: マーカーは「かつてここでリンクを張った」という古い事実しか見ていないと、
      // ここで誤って「置換可」と判定し、ユーザーの古い auth.json への hard link で
      // 上書きしてしまう（＝1回限りのリフレッシュトークンを潰す）。
      const r = prepareCodexHome(editorDir, deps);

      expect(readFileSync(link, 'utf8')).toBe('{"mode":"chatgpt","rotated":true}');
      expect(r.env.CODEX_HOME).toBe(runtime);
      expect(r.notes).toEqual([]);
    } finally { cleanup(); }
  });

  it('起動時に中断した tmp ファイルの残骸を掃除する', () => {
    const { editorDir, fakeHome, cleanup } = setup(true);
    try {
      const runtime = codexRuntimeDir(editorDir, homeDeps(fakeHome));
      mkdirSync(runtime, { recursive: true });
      // replaceAuthLink が使う tmp 名パターン（TMP_AUTH_FILE_PREFIX = '.auth.json.tmp-'）
      // に合わせた残骸を手で置く。プロセス強制終了等で rename 前に残ったケースを模す。
      const staleTmp = join(runtime, '.auth.json.tmp-12345-1690000000000-ab12cd');
      writeFileSync(staleTmp, 'stale');
      expect(existsSync(staleTmp)).toBe(true); // 前提: 確かに置けている（空振り防止）

      prepareCodexHome(editorDir, { homeDir: () => fakeHome });

      expect(existsSync(staleTmp)).toBe(false);
    } finally { cleanup(); }
  });

  // POSIX 限定: Windows では chmod が実質無効なため権限の是正を検証できない。
  (process.platform === 'win32' ? it.skip : it)(
    '既存の隔離ディレクトリが緩い権限（0755）でも 0700 へ是正する（mode は mkdirSync 新規作成時のみ有効なための回帰）',
    () => {
      const { editorDir, fakeHome, cleanup } = setup(true);
      try {
        const runtime = codexRuntimeDir(editorDir, homeDeps(fakeHome));
        // 何らかの理由で既に緩い権限で存在しているケースを模す。
        mkdirSync(runtime, { recursive: true, mode: 0o755 });
        chmodSync(runtime, 0o755); // mkdirSync の mode は既存ディレクトリには効かないため明示で確定させる
        expect(statSync(runtime).mode & 0o777).toBe(0o755); // 前提: 確かに緩い権限になっている

        const r = prepareCodexHome(editorDir, { homeDir: () => fakeHome });

        expect(statSync(runtime).mode & 0o777).toBe(0o700);
        expect(r.env.CODEX_HOME).toBe(runtime);
      } finally { cleanup(); }
    },
  );

  it('homeDir() が throw しても例外を投げず FALLBACK_NOTE で返す', () => {
    const editorDir = mkdtempSync(join(tmpdir(), 'sme-codexhome-editor-'));
    try {
      const r = prepareCodexHome(editorDir, {
        homeDir: () => { throw new Error('HOME is not set'); },
      });
      expect(r).toEqual({ env: {}, notes: [FALLBACK_NOTE] });
    } finally { rmSync(editorDir, { recursive: true, force: true }); }
  });

  it('homeDir() が空文字を返しても隔離を諦めて降格する（HOME="" は os.homedir() が throw せず passwd フォールバックもされない実測挙動のため）', () => {
    // 空文字は相対パスであり isAbsolute("") は false。ここで降格しないと、
    // codexRuntimeDir が相対パス（例: `.supermovie/codex-home/...`）を返し、
    // mkdirSync が process.cwd()（＝配布 ZIP に含まれうるエディタフォルダ配下）に
    // 隔離 home を作ってしまう。cwd を汚染しないことを確認するため、実行前後で
    // cwd 直下に `.supermovie` が存在しないことも検査する。
    const editorDir = mkdtempSync(join(tmpdir(), 'sme-codexhome-editor-'));
    const cwdSupermovieDir = join(process.cwd(), '.supermovie');
    expect(existsSync(cwdSupermovieDir)).toBe(false); // 前提: 事前に無いこと
    try {
      const r = prepareCodexHome(editorDir, { homeDir: () => '' });
      expect(r).toEqual({ env: {}, notes: [FALLBACK_NOTE] });
      expect(existsSync(cwdSupermovieDir)).toBe(false);
    } finally {
      rmSync(editorDir, { recursive: true, force: true });
      rmSync(cwdSupermovieDir, { recursive: true, force: true }); // 実装が壊れていた場合の後始末（安全網）
    }
  });
});

describe('codexRuntimeDir（配布 ZIP に資格情報を含めないための置き場固定）', () => {
  it('editorDir の外（偽ホーム配下）を返す', () => {
    const editorDir = mkdtempSync(join(tmpdir(), 'sme-codexhome-editor-'));
    const fakeHome = mkdtempSync(join(tmpdir(), 'sme-codexhome-home-'));
    try {
      const runtime = codexRuntimeDir(editorDir, homeDeps(fakeHome));
      expect(resolve(runtime).startsWith(resolve(editorDir))).toBe(false);
      expect(resolve(runtime).startsWith(resolve(fakeHome))).toBe(true);
    } finally {
      rmSync(editorDir, { recursive: true, force: true });
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it('異なる editorDir からは異なるディレクトリになる（インストールごとの分離）', () => {
    const editorDirA = mkdtempSync(join(tmpdir(), 'sme-codexhome-editor-a-'));
    const editorDirB = mkdtempSync(join(tmpdir(), 'sme-codexhome-editor-b-'));
    const fakeHome = mkdtempSync(join(tmpdir(), 'sme-codexhome-home-'));
    try {
      expect(codexRuntimeDir(editorDirA, homeDeps(fakeHome)))
        .not.toBe(codexRuntimeDir(editorDirB, homeDeps(fakeHome)));
    } finally {
      rmSync(editorDirA, { recursive: true, force: true });
      rmSync(editorDirB, { recursive: true, force: true });
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it('別の場所にある同名フォルダは異なるディレクトリになる（配布 ZIP を各自展開した時に必ず起きる形）', () => {
    // インストール分離の本丸はここ: 受講生が配布 ZIP を自分の環境で展開すると、
    // basename は同じ（例: "harness-editor"）で親ディレクトリだけが違う状態が
    // 必ず発生する（例: ~/Documents/harness-editor と ~/Downloads/harness-editor）。
    // basename が既に異なる mkdtempSync 同士を比較するだけでは、ハッシュを丸ごと
    // 削っても緑のままになってしまい、この分離を検証できない。
    const parentA = mkdtempSync(join(tmpdir(), 'sme-codexhome-parentA-'));
    const parentB = mkdtempSync(join(tmpdir(), 'sme-codexhome-parentB-'));
    const fakeHome = mkdtempSync(join(tmpdir(), 'sme-codexhome-home-'));
    const editorDirA = join(parentA, 'harness-editor');
    const editorDirB = join(parentB, 'harness-editor');
    try {
      expect(codexRuntimeDir(editorDirA, homeDeps(fakeHome)))
        .not.toBe(codexRuntimeDir(editorDirB, homeDeps(fakeHome)));
    } finally {
      rmSync(parentA, { recursive: true, force: true });
      rmSync(parentB, { recursive: true, force: true });
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it('絶対パス・末尾スラッシュ付き・相対パス表記の3者が同じディレクトリに一致する（resolve() を通してからハッシュする契約の固定）', () => {
    // 「resolve() を通してからハッシュする」という設計意図（コメント参照）を直接
    // 固定するテスト。同じ editorDir を2回呼ぶだけの旧テストは純関数の自明な性質を
    // 確認するだけで、resolve() を外しても落ちなかった。
    const editorDir = mkdtempSync(join(tmpdir(), 'sme-codexhome-editor-'));
    const fakeHome = mkdtempSync(join(tmpdir(), 'sme-codexhome-home-'));
    try {
      const withTrailingSlash = `${editorDir}${sep}`;
      const relativeForm = relative(process.cwd(), editorDir);
      const absolute = codexRuntimeDir(editorDir, homeDeps(fakeHome));
      const trailingSlash = codexRuntimeDir(withTrailingSlash, homeDeps(fakeHome));
      const relativePath = codexRuntimeDir(relativeForm, homeDeps(fakeHome));
      expect(trailingSlash).toBe(absolute);
      expect(relativePath).toBe(absolute);
    } finally {
      rmSync(editorDir, { recursive: true, force: true });
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });
});
