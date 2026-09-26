/**
 * 未保存編集の保全（監査 data-safety-1／2／3／8）の回帰テスト。
 *
 * App.tsx 本体は fetch とサーバ状態に強く依存し、jsdom で丸ごと描画しても
 * 「未保存の編集がある状態」を作れない。そこで判断そのものを純関数へ切り出し、
 * ここでは (1) 判断が正しいこと (2) その判断が画面へ**実際に配線されている**こと
 * （＝素の `selectProject` / `reload` を直に渡していないこと）の 2 段で固定する。
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  proceedAfterSaving,
  pickProjectGuarded,
  requestReloadGuarded,
  showsConflictInBanner,
  overwriteSavedToast,
  toastClassName,
  toastRole,
  SAVE_ERROR_AUTOSAVE_NOTICE,
  PROJECT_SWITCH_ABORTED_TOAST,
} from './App';

const APP_SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'App.tsx'), 'utf8');

describe('proceedAfterSaving（保存してから進むガード）', () => {
  it('未保存が無ければ save を呼ばずに進む', async () => {
    const save = vi.fn(async () => true);
    const proceed = vi.fn();
    await proceedAfterSaving(false, save, proceed);
    expect(save).not.toHaveBeenCalled();
    expect(proceed).toHaveBeenCalledTimes(1);
  });

  it('未保存があれば先に保存し、成功したら進む', async () => {
    const order: string[] = [];
    const save = vi.fn(async () => {
      order.push('save');
      return true;
    });
    const proceed = vi.fn(() => order.push('proceed'));
    await proceedAfterSaving(true, save, proceed);
    expect(order).toEqual(['save', 'proceed']);
  });

  it('保存に失敗したら進まない（編集を捨てない）', async () => {
    const save = vi.fn(async () => false);
    const proceed = vi.fn();
    await proceedAfterSaving(true, save, proceed);
    expect(proceed).not.toHaveBeenCalled();
  });
});

describe('pickProjectGuarded（サイドバーの案件切替）', () => {
  it('同じ案件の再選択は何もしない（開き直して編集を捨てない）', async () => {
    const save = vi.fn(async () => true);
    const select = vi.fn();
    await pickProjectGuarded('a', 'a', true, save, select);
    expect(save).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
  });

  it('未保存があれば保存してから切り替える', async () => {
    const order: string[] = [];
    const save = vi.fn(async () => {
      order.push('save');
      return true;
    });
    const select = vi.fn((id: string) => order.push(`select:${id}`));
    await pickProjectGuarded('b', 'a', true, save, select);
    expect(order).toEqual(['save', 'select:b']);
  });

  it('保存に失敗したら切り替えない（未保存の編集を守る）', async () => {
    const select = vi.fn();
    await pickProjectGuarded('b', 'a', true, async () => false, select);
    expect(select).not.toHaveBeenCalled();
  });

  it('未保存が無ければそのまま切り替える', async () => {
    const save = vi.fn(async () => true);
    const select = vi.fn();
    await pickProjectGuarded('b', 'a', false, save, select);
    expect(save).not.toHaveBeenCalled();
    expect(select).toHaveBeenCalledWith('b');
  });
});

describe('requestReloadGuarded（バナーの「再読込」）', () => {
  /** 衝突ではない保存失敗（従来どおりの経路）。 */
  const notConflict = () => false;

  it('未保存が無ければそのまま再読込する（確認も出さない）', async () => {
    const save = vi.fn(async () => true);
    const reload = vi.fn();
    const confirmDiscard = vi.fn(() => true);
    await requestReloadGuarded(false, save, reload, confirmDiscard, notConflict);
    expect(save).not.toHaveBeenCalled();
    expect(confirmDiscard).not.toHaveBeenCalled();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('未保存があれば保存してから再読込する（確認は出さない）', async () => {
    const order: string[] = [];
    const save = vi.fn(async () => {
      order.push('save');
      return true;
    });
    const reload = vi.fn(() => order.push('reload'));
    const confirmDiscard = vi.fn(() => true);
    await requestReloadGuarded(true, save, reload, confirmDiscard, notConflict);
    expect(order).toEqual(['save', 'reload']);
    expect(confirmDiscard).not.toHaveBeenCalled();
  });

  it('保存に失敗したら確認し、了承されたときだけ再読込する', async () => {
    const save = vi.fn(async () => false);
    const reload = vi.fn();
    await requestReloadGuarded(true, save, reload, () => true, notConflict);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('保存に失敗して確認が拒否されたら再読込しない（編集を守る）', async () => {
    const save = vi.fn(async () => false);
    const reload = vi.fn();
    await requestReloadGuarded(true, save, reload, () => false, notConflict);
    expect(reload).not.toHaveBeenCalled();
  });

  it('衝突（409）で失敗したら破棄の確認を出さず、再読込もしない（衝突 UI に委ねる）', async () => {
    // 外部変更バナーの「保存してから再読込」は、同じファイルが外部で書き換わっている以上
    // 409 になるのが普通。ここで確認を出すと OK 1 回で編集が消える。
    const save = vi.fn(async () => false);
    const reload = vi.fn();
    const confirmDiscard = vi.fn(() => true);
    await requestReloadGuarded(true, save, reload, confirmDiscard, () => true);
    expect(confirmDiscard).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });
});

describe('衝突の復帰 UI は 1 つだけ（バナーとポップオーバーを重ねない）', () => {
  it('外部変更バナーが出ていて衝突したらバナー側が兼ねる', () => {
    expect(showsConflictInBanner(true, true, true)).toBe(true);
  });

  it('バナーが出ていない衝突は従来どおりポップオーバー側', () => {
    expect(showsConflictInBanner(false, true, true)).toBe(false);
  });

  it('衝突していなければバナーは通常表示のまま', () => {
    expect(showsConflictInBanner(true, false, true)).toBe(false);
    expect(showsConflictInBanner(true, true, false)).toBe(false);
  });

  it('ポップオーバーはバナーが兼ねているあいだ出さない（配線）', () => {
    expect(APP_SRC).toContain(
      "{session?.saveStatus === 'error' && session.saveError && !showConflictInBanner && (",
    );
    expect(APP_SRC).toContain('conflict={showConflictInBanner}');
  });
});

describe('画面への配線（未保存を捨てる直呼びが復活していないこと）', () => {
  it('サイドバーの案件切替はガード経由（data-safety-1）', () => {
    expect(APP_SRC).not.toContain('onPickProject={selectProject}');
    expect(APP_SRC).toContain('onPickProject={(id) => void handlePickProject(id)}');
  });

  it('ハンドラ本体が共通ガードを呼んでいる（中身だけ空にされていないこと）', () => {
    // 注意: ソース走査は「呼んでいるか」までしか見えず、渡す値の取り違えは検出できない。
    // 判断そのものは上の pickProjectGuarded / requestReloadGuarded のテストが担う。
    expect(APP_SRC).toContain('await pickProjectGuarded(');
    expect(APP_SRC).toContain('await requestReloadGuarded(');
    // 衝突判定を渡していること（渡し忘れると 409 でも破棄の確認が出る）。
    expect(APP_SRC).toContain('session ? session.isSaveConflict : () => false,');
  });

  it('完了バナー 4 種の「再読込」はガード経由（data-safety-2）', () => {
    // TranscribeBanner / DenoiseBanner / NormalizeBanner / PreviewProxyBanner は
    // すべて TranscriptPanel の onReloadRequested 1 本から配られる。
    expect(APP_SRC).not.toContain('onReloadRequested={reload}');
    expect(APP_SRC).toContain('onReloadRequested={() => void requestReload()}');
  });
});


describe('上書き保存の退避案内（data-safety-4）', () => {
  it('トーストは短く保ち、控えの場所は BackupNotice へ譲る（サイクル 3 残 Minor）', () => {
    const msg = overwriteSavedToast('.sme/backup/2026-09-07T00-00-00-000Z');
    expect(msg).toContain('上書き保存しました');
    expect(msg).toContain('下の案内');
    // 4 秒で消えるトーストに「消えて困る情報」を置かない。
    expect(msg).not.toContain('.sme/backup/');
    expect(msg.length).toBeLessThanOrEqual(40);
  });

  it('退避先が無ければ控えの案内自体を書かない（存在しない控えを案内しない）', () => {
    const msg = overwriteSavedToast(null);
    expect(msg).toContain('上書き保存しました');
    expect(msg).not.toContain('控え');
  });

  it('控えの場所・時刻・開く導線は BackupNotice が持続表示する（一本化の確認）', () => {
    const notice = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), 'panels/BackupNotice.tsx'),
      'utf8',
    );
    expect(notice).toContain('backupTimeLabel');
    expect(notice).toContain('backup-notice-path');
    expect(notice).toContain('案件フォルダを開く');
  });

  it('上書き保存ボタンは押した結果を案内へつないでいる（配線の固定）', () => {
    // saveOverwrite() を呼び捨てにせず、結果の backupDir をトーストへ流していること。
    const wired = APP_SRC.match(
      /saveOverwrite\(\)\.then\(\(r\) => \{\s*if \(!r\.ok\) return;\s*showToast\(overwriteSavedToast\(r\.backupDir\), 'success'\);/g,
    );
    expect(wired?.length ?? 0).toBe(2);
  });
});

describe('書き出し操作の失敗表示（data-safety-11）', () => {
  it('キャンセル・Finder 表示の失敗メッセージをトーストへ流している（配線の固定）', () => {
    expect(APP_SRC).toMatch(/render\.cancel\(\)\.then\(\(msg\) => \{\s*if \(msg !== null\) showToast\(msg, 'error'\);/);
    expect(APP_SRC).toMatch(/render\.reveal\(\)\.then\(\(msg\) => \{\s*if \(msg !== null\) showToast\(msg, 'error'\);/);
  });
});

describe('409 以外の保存失敗の案内（data-safety-12）', () => {
  it('自動保存が止まっていることと再開のしかたを文言で伝える', () => {
    expect(SAVE_ERROR_AUTOSAVE_NOTICE).toContain('自動保存');
    expect(SAVE_ERROR_AUTOSAVE_NOTICE).toContain('一時停止');
  });

  it('非 409 の枝にも「もう一度保存」と一時停止の案内を置いている', () => {
    // 非衝突側（saveConflict が false の枝）の JSX を切り出して確認する。
    const idx = APP_SRC.indexOf('保存に失敗しました: {session.saveError}');
    expect(idx).toBeGreaterThan(0);
    const block = APP_SRC.slice(idx - 600, idx + 600);
    expect(block).toContain('SAVE_ERROR_AUTOSAVE_NOTICE');
    expect(block).toContain('もう一度保存');
    expect(block).toContain('tb-save-error-actions');
  });
});

describe('App のショートカットにもモーダルガード（interaction-1 の残件）', () => {
  it('Undo/Redo/保存の keydown は isModalOpen() を先に見る', () => {
    // 共有モジュールを使っていること（Timeline のコピーではない）。
    expect(APP_SRC).toContain("from './isModalOpen'");
    // ショートカット effect の中で、Undo の分岐より前にガードがあること。
    const start = APP_SRC.indexOf('// キーボードショートカット: Undo / Redo / 保存。');
    expect(start).toBeGreaterThan(0);
    const block = APP_SRC.slice(start, start + 1600);
    const guard = block.indexOf('if (isModalOpen()) {');
    const undo = block.indexOf("key === 'z'");
    expect(guard).toBeGreaterThan(0);
    expect(guard).toBeLessThan(undo);
    const modalGuard = block.slice(guard, block.indexOf('\n      }', guard) + 8);
    expect(modalGuard).toContain("key === 's'");
    expect(modalGuard).toContain('!inEditable');
    expect(modalGuard).toContain('e.preventDefault()');
    expect(modalGuard).toContain('return;');
  });
});

describe('案件切替を中止したときの案内（サイクル 1 レビューの残件）', () => {
  it('保存に失敗したら pickProjectGuarded は false を返す', async () => {
    const select = vi.fn();
    const ok = await pickProjectGuarded('b', 'a', true, async () => false, select);
    expect(ok).toBe(false);
    expect(select).not.toHaveBeenCalled();
  });

  it('保存できたら true を返して切り替える', async () => {
    const select = vi.fn();
    const ok = await pickProjectGuarded('b', 'a', true, async () => true, select);
    expect(ok).toBe(true);
    expect(select).toHaveBeenCalledWith('b');
  });

  it('同じ案件の再選択は「中止」ではない（余計な知らせを出さない）', async () => {
    expect(await pickProjectGuarded('a', 'a', true, async () => false, vi.fn())).toBe(true);
  });

  it('中止したら「切り替えませんでした」と知らせる配線がある', () => {
    expect(PROJECT_SWITCH_ABORTED_TOAST).toContain('切り替えませんでした');
    expect(APP_SRC).toContain("if (!switched) showToast(PROJECT_SWITCH_ABORTED_TOAST, 'error');");
  });

  it('変換後の開き直しも未保存を確認してから行う', () => {
    const start = APP_SRC.indexOf('async function handleConvert');
    const block = APP_SRC.slice(start, start + 1500);
    expect(block).toContain('proceedAfterSaving');
    // 開き直しは着地時に isCurrent を再確認してから（保存の往復中に別案件へ切り替えたら引き戻さない・マージレビュー P2-1）。
    expect(block).toMatch(/if \(isCurrent\(id\) && stillSame\(\)\) reloadProject\(\);/);
  });
});

describe('上書き保存の成功後は外部変更バナーを畳む（サイクル 2 レビュー Important）', () => {
  it('saveOverwrite の成功枝はどちらも clearExternalChange を呼ぶ', () => {
    // 上書きが通った時点でディスクと画面は一致している。バナーが残ると成功トーストと
    // 矛盾し、初心者を再読込（＝自分の編集の破棄）へ誘う。
    const blocks = [...APP_SRC.matchAll(/saveOverwrite\(\)\.then\(\(r\) => \{[\s\S]{0,400}?\}\);/g)].map(
      (m) => m[0],
    );
    // バナー内と保存エラー表示内の 2 か所（どちらの入口からでも上書きできる）。
    expect(blocks).toHaveLength(2);
    for (const block of blocks) {
      expect(block).toContain("showToast(overwriteSavedToast(r.backupDir), 'success')");
      expect(block).toContain('clearExternalChange()');
    }
  });

  it('clearExternalChange は useEditorProject から受け取っている（ローカル state の写しではない）', () => {
    expect(APP_SRC).toMatch(/const \{[\s\S]{0,400}clearExternalChange[\s\S]{0,200}\} =\s*\n?\s*useEditorProject\(\);/);
  });
});

describe('トーストの種別（サイクル 2 レビュー Important）', () => {
  it('成功・案内は危険色の class を持たない', () => {
    expect(toastClassName('success')).toBe('sme-toast sme-toast-success');
    expect(toastClassName('info')).toBe('sme-toast sme-toast-info');
  });

  it('失敗だけが error 種別（危険色）', () => {
    expect(toastClassName('error')).toBe('sme-toast sme-toast-error');
  });

  it('role は失敗のときだけ alert（成功・案内で読み上げに割り込まない）', () => {
    expect(toastRole('error')).toBe('alert');
    expect(toastRole('success')).toBe('status');
    expect(toastRole('info')).toBe('status');
  });

  it('上書き保存の成功は success 種別で出す（赤枠にしない）', () => {
    const wired = APP_SRC.match(/showToast\(overwriteSavedToast\(r\.backupDir\), 'success'\)/g);
    expect(wired?.length ?? 0).toBe(2);
  });

  it('トーストの描画は種別から class と role を引く（"alert" 決め打ちに戻さない）', () => {
    expect(APP_SRC).toContain('className={toastClassName(statusToast.kind)}');
    expect(APP_SRC).toContain('role={toastRole(statusToast.kind)}');
    expect(APP_SRC).not.toContain('<div className="sme-toast" role="alert">');
  });

  it('CSS は危険色の枠を error 種別だけに置く', () => {
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'styles.css'), 'utf8');
    const base = css.slice(css.indexOf('.sme-toast {'), css.indexOf('.sme-toast-success'));
    expect(base).not.toContain('--danger');
    expect(css).toContain('.sme-toast-error { border-color: var(--danger');
  });
});

describe('退避先の案内は消えない（サイクル 2 レビュー Important）', () => {
  it('上書き保存の成功枝は退避先を持続表示へ渡す（トーストだけに置かない）', () => {
    const blocks = [...APP_SRC.matchAll(/saveOverwrite\(\)\.then\(\(r\) => \{[\s\S]{0,500}?\}\);/g)].map(
      (m) => m[0],
    );
    expect(blocks).toHaveLength(2);
    for (const block of blocks) {
      expect(block).toContain('setBackupNotice(r.backupDir)');
    }
  });

  it('BackupNotice を画面に配線している（自動消滅のトーストで代替しない）', () => {
    expect(APP_SRC).toContain("import { BackupNotice } from './panels/BackupNotice'");
    expect(APP_SRC).toContain('<BackupNotice');
    expect(APP_SRC).toContain('backupDir={backupNotice}');
    // 閉じるのは利用者の操作だけ。setTimeout で自動的に畳まない。
    expect(APP_SRC).not.toMatch(/setTimeout\([^)]*setBackupNotice/);
  });
});

describe('保存してから遷移する着地は、保存開始時のセッションが今も現行かを照合する（マージレビュー Codex P1/P2）', () => {
  it('requestReload・ホームへ戻る・案件切替・変換着地の 4 経路が sessionGuard を張る', () => {
    expect((APP_SRC.match(/const stillSame = session \? session\.sessionGuard\(\) : \(\) => true;/g) ?? []).length).toBe(3);
    expect(APP_SRC).toContain('const stillSame = s.sessionGuard();');
    // 古い保存応答の true で、新セッションの編集を再読込・切替・帰還で捨てない。
    expect(APP_SRC).toContain('if (stillSame()) reloadProject();');
    expect(APP_SRC).toContain('if (stillSame()) selectProject(next);');
    expect((APP_SRC.match(/if \(!stillSame\(\)\) return;/g) ?? []).length).toBe(2);
    expect(APP_SRC).toContain('() => stillSame() && window.confirm(DISCARD_RELOAD_CONFIRM)');
    // 変換着地の失敗通知は、今の案件・今のセッションのときだけ出す。
    expect(APP_SRC).toContain('if (isCurrent(id) && stillSame()) {\n            if (!reopened) setPendingReload(true);');
  });

  it('導入・部品更新の着地で開き直せたら、保留中の再読込案内を消す（Codex P2）', () => {
    const m =
      APP_SRC.match(
        /if \(!reloadIfSafe\(id, sessionRef\.current\?\.dirty \?\? false\)\) \{\s*setPendingReload\(true\);\s*\} else \{[^}]*setPendingReload\(false\);\s*\}/g,
      ) ?? [];
    expect(m.length).toBe(2);
  });
});
