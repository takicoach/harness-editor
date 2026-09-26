/**
 * @vitest-environment jsdom
 *
 * ExportDialog の fastCut 説明文テスト（I-2）。
 * 「テロップや効果音が入っていないので」は誤り（SE は fastCut 経路でも重ねて合成される）。
 * 能力ベースの文言（描画が要らない＝高速）へ変更したことを実 DOM で検証する。
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import { ExportDialog } from './ExportDialog';

afterEach(cleanup);

describe('ExportDialog', () => {
  it('keeps a custom filename when changing preset and sends it without remembering it across projects', () => {
    localStorage.clear();
    const onStart = vi.fn();
    const ui = render(<ExportDialog orientation="landscape" width={1920} height={1080} onStart={onStart} onClose={() => {}} />);
    fireEvent.change(ui.getByRole('textbox', { name: 'ファイル名' }), { target: { value: 'result.mp4' } });
    fireEvent.click(ui.getByRole('radio', { name: /軽量・確認用/ }));
    expect((ui.getByRole('textbox', { name: 'ファイル名' }) as HTMLInputElement).value).toBe('result.mp4');
    fireEvent.click(ui.getByRole('button', { name: '書き出し開始' }));
    expect(onStart).toHaveBeenCalledWith({ resolution: '720p', quality: 'light', outputName: 'result.mp4' }, false);
    expect(localStorage.getItem('sme:render-preset')).not.toContain('result.mp4');
    localStorage.clear();
  });

  it('changes an untouched default name with the preset and rejects a path before starting', () => {
    localStorage.clear();
    const onStart = vi.fn();
    const ui = render(<ExportDialog orientation="landscape" width={1920} height={1080} onStart={onStart} onClose={() => {}} />);
    fireEvent.click(ui.getByRole('radio', { name: /軽量・確認用/ }));
    expect((ui.getByRole('textbox', { name: 'ファイル名' }) as HTMLInputElement).value).toBe('video-720p.mp4');
    fireEvent.change(ui.getByRole('textbox', { name: 'ファイル名' }), { target: { value: '../result.mp4' } });
    expect((ui.getByRole('button', { name: '書き出し開始' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(ui.getByRole('button', { name: '書き出し開始' }));
    expect(onStart).not.toHaveBeenCalled();
  });
  it('fastCut 時の説明文は「効果音が入っていない」を含まず、「高速で書き出せる見込みです」を含む', () => {
    const { getByRole } = render(
      <ExportDialog
        orientation="landscape"
        width={1920}
        height={1080}
        onStart={() => {}}
        onClose={() => {}}
        fastCut
      />,
    );
    const note = getByRole('note');
    expect(note.textContent).not.toContain('効果音が入っていない');
    expect(note.textContent).toContain('高速で書き出せる見込みです');
  });

  it('M-6: 文言を確定断定から見込みへ弱める（「素材によっては通常の書き出しに切り替わります」を含む）', () => {
    const { getByRole } = render(
      <ExportDialog
        orientation="landscape"
        width={1920}
        height={1080}
        onStart={() => {}}
        onClose={() => {}}
        fastCut
      />,
    );
    const note = getByRole('note');
    // クライアント予測（isCutsOnly）は M2c 撮影経路のサーバ側フォールバック要因
    // （titleStyle 未確定・run 0本・撮影失敗等）を知らないため、確定表現は過大な約束になる。
    expect(note.textContent).toContain('素材によっては通常の書き出しに切り替わります');
    expect(note.textContent).not.toContain('高速で書き出します');
  });

  it('M4: 「戻る」条件から場面転換とサブ動画を外す（native 対応済み・残るのは速度・レイアウト）', () => {
    // 対立仮説: 文言が古いままだと、実際は高速で書き出せる編集に対して
    // 「通常の書き出しに戻ります」と案内する＝ UI が実態より悲観的に嘘をつく。
    const { getByRole } = render(
      <ExportDialog
        orientation="landscape"
        width={1920}
        height={1080}
        onStart={() => {}}
        onClose={() => {}}
        fastCut
      />,
    );
    const note = getByRole('note');
    expect(note.textContent).toContain('速度やレイアウトの変更を足すと通常の書き出しに戻ります');
    expect(note.textContent).not.toContain('場面転換を足すと');
    expect(note.textContent).not.toContain('サブ動画や速度');
    // 高速側の対応範囲には場面転換とサブ動画が入る（M3 / M4）。
    expect(note.textContent).toContain('場面転換・サブ動画を重ねるだけ');
  });
});

describe('ExportDialog — 撮影エンジン不在の理由表示（M2d T2・設計判断5）', () => {
  it('(a) fastCut かつ needsCapture かつ captureEngine.ok===false → engine ノートが出て fast ノートは出ない', () => {
    const { container } = render(
      <ExportDialog
        orientation="landscape"
        width={1920}
        height={1080}
        onStart={() => {}}
        onClose={() => {}}
        fastCut
        needsCapture
        captureEngine={{ ok: false, message: '撮影エンジンが見つかりません' }}
      />,
    );
    const notes = container.querySelectorAll('[role="note"]');
    expect(notes).toHaveLength(1);
    const engineNote = container.querySelector('.export-engine-note');
    expect(engineNote).not.toBeNull();
    expect(engineNote?.textContent).toContain('通常の書き出し');
    expect(engineNote?.textContent).toContain('setup.command');
    expect(container.querySelector('.export-fast-note')).toBeNull();
    expect(engineNote?.textContent).not.toContain('高速で書き出せる見込みです');
  });

  it('(b) fastCut かつ needsCapture かつ captureEngine.ok===true → 従来どおり fast ノート', () => {
    const { getByRole } = render(
      <ExportDialog
        orientation="landscape"
        width={1920}
        height={1080}
        onStart={() => {}}
        onClose={() => {}}
        fastCut
        needsCapture
        captureEngine={{ ok: true }}
      />,
    );
    const note = getByRole('note');
    expect(note.textContent).toContain('高速で書き出せる見込みです');
  });

  it('(c) fastCut かつ needsCapture===false かつ captureEngine.ok===false → 従来どおり fast ノート（撮影不要ならエンジン不在は無関係）', () => {
    const { getByRole } = render(
      <ExportDialog
        orientation="landscape"
        width={1920}
        height={1080}
        onStart={() => {}}
        onClose={() => {}}
        fastCut
        needsCapture={false}
        captureEngine={{ ok: false, message: '撮影エンジンが見つかりません' }}
      />,
    );
    const note = getByRole('note');
    expect(note.textContent).toContain('高速で書き出せる見込みです');
  });

  it('(d) captureEngine 未取得（undefined）の間は従来表示のまま', () => {
    const { getByRole } = render(
      <ExportDialog
        orientation="landscape"
        width={1920}
        height={1080}
        onStart={() => {}}
        onClose={() => {}}
        fastCut
        needsCapture
      />,
    );
    const note = getByRole('note');
    expect(note.textContent).toContain('高速で書き出せる見込みです');
  });
});

describe('ExportDialog — 復旧案内の出し分け（M2d T2 修正 9・M-3）', () => {
  function renderWith(engine: { ok: boolean; kind?: string; message?: string }) {
    return render(
      <ExportDialog
        orientation="landscape"
        width={1920}
        height={1080}
        onStart={() => {}}
        onClose={() => {}}
        fastCut
        needsCapture
        captureEngine={engine as { ok: boolean; kind?: 'chromium-missing' | 'env-path-missing' | 'unsupported-platform'; message?: string }}
      />,
    );
  }

  it('kind=chromium-missing → setup 再実行の案内', () => {
    const { container } = renderWith({ ok: false, kind: 'chromium-missing', message: '見つかりません' });
    const note = container.querySelector('.export-engine-note')!;
    expect(note.textContent).toContain('setup.command');
    expect(note.textContent).toContain('見つかりません');
  });

  it('kind=env-path-missing → 環境変数の確認案内（setup 再実行は案内しない）', () => {
    const { container } = renderWith({ ok: false, kind: 'env-path-missing', message: 'パスが見つかりません' });
    const note = container.querySelector('.export-engine-note')!;
    expect(note.textContent).toContain('HARNESS_CHROMIUM');
    expect(note.textContent).not.toContain('setup.command');
  });

  it('kind=unsupported-platform → 非対応 OS の案内', () => {
    const { container } = renderWith({ ok: false, kind: 'unsupported-platform', message: '未対応の OS/CPU 構成です' });
    const note = container.querySelector('.export-engine-note')!;
    expect(note.textContent).toContain('この OS');
    expect(note.textContent).not.toContain('setup.command');
  });

  it('M-3: エンジン未導入ノートに初回ダウンロードの一文が入る', () => {
    const { container } = renderWith({ ok: false, kind: 'chromium-missing' });
    const note = container.querySelector('.export-engine-note')!;
    expect(note.textContent).toContain('通常の書き出しは初回に描画部品のダウンロードが走ることがあります');
  });
});

/**
 * M-4（ラウンド2・M-6 の撤回）: 予測は編集内容の事実として渡す。
 *
 * 一度は「ダイアログが説明済みなら `predictedFastCut` を false にして帯を出さない」としたが、
 * ダイアログは開始と同時に閉じるので、閉じた後に理由が分かる場所が無くなる。
 * 予測は `fastCut` をそのまま渡し、開始後の説明は帯（`CAPTURE_ENGINE_MESSAGES[reason].band`・
 * ダイアログより短い文言）に任せる。ダイアログと帯は「開始前」「開始後」で読む場面が違う。
 */
describe('ExportDialog — 予測 fastCut の受け渡し（M-4）', () => {
  function startWith(props: Partial<Parameters<typeof ExportDialog>[0]>): boolean[] {
    cleanup();
    const seen: boolean[] = [];
    const { getByTestId } = render(
      <ExportDialog
        orientation="portrait"
        width={1080}
        height={1920}
        onStart={(_options, predicted) => seen.push(predicted)}
        onClose={() => {}}
        fastCut
        {...props}
      />,
    );
    (getByTestId('export-start') as HTMLButtonElement).click();
    return seen;
  }

  it('エンジン不在の説明を出していても predictedFastCut は編集内容どおり true で渡す', () => {
    expect(startWith({ needsCapture: true, captureEngine: { ok: false, kind: 'chromium-missing' } })).toEqual([true]);
  });

  it('従来の高速見込み表示のときも predictedFastCut=true のまま', () => {
    expect(startWith({ needsCapture: true, captureEngine: { ok: true } })).toEqual([true]);
    expect(startWith({ needsCapture: false, captureEngine: { ok: false } })).toEqual([true]);
  });
});
