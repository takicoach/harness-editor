/**
 * 右ドック AI タブの埋め込みターミナル（claude / codex）。
 * checking → (need-install → installing →) starting → connected を辿る。
 * xterm は jsdom で描画できないため、このコンポーネントの検証は e2e と
 * 状態機械 unit（claudeTerminalState.test.ts）・判定純関数 unit
 * （aiToolSwitcher.test.ts）に分担する。
 */
import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { fetchJson, putJsonPost } from '../fetchJson';
import { nextTerminalPhase, type Phase } from './claudeTerminalState';
import { useThemeValue } from '../layout/useThemeValue';
import { terminalOptions, terminalTheme } from './claudeTerminalOptions';
import { terminalColorsFor } from '../../shared/terminalColors';
import { DEFAULT_AI_TOOL, type AiToolId } from '../../shared/aiToolId';
import { shouldShowToolSwitcher, usableTools, pickInitialTool, type ToolInfo } from './aiToolSwitcher';

const TOOL_STORAGE_KEY = 'sme.aiTool';

export function AiTerminal() {
  // documentElement の data-theme を購読（Waveform.tsx と同じ既存フック）。
  // xterm インスタンスは作り直さず options.theme の再代入で追従させる（下の effect）。
  const theme = useThemeValue();
  const [phase, setPhaseRaw] = useState<Phase>('checking');
  const phaseRef = useRef<Phase>('checking');
  const [error, setError] = useState<string | null>(null);
  const [installLog, setInstallLog] = useState<string[]>([]);
  const [removedEnv, setRemovedEnv] = useState<string[]>([]);
  const [waiting, setWaiting] = useState(false); // 「待機を開始」送信中
  const [tools, setTools] = useState<ToolInfo[]>([]);
  /** サーバーが実際に起動しているツール。表示は必ずこれを正本にする。 */
  const [actualTool, setActualTool] = useState<AiToolId | null>(null);
  /** ユーザーが選んだツール（起動要求）。 */
  const [wantTool, setWantTool] = useState<AiToolId>(DEFAULT_AI_TOOL);
  const [notes, setNotes] = useState<string[]>([]);
  const [switching, setSwitching] = useState(false);
  /**
   * takeover phase に落ちた理由。'takeover'（別タブがこの端末を奪った）と
   * 'stale'（別タブのツール切替でこの接続が無効になった）は原因が違い、
   * 利用者が取るべき次の行動の理解も変わるため、文言を出し分ける
   * （Minor 1: 以前は stale でも setError と takeover 文言が両方出て二重表示だった）。
   */
  const [takeoverReason, setTakeoverReason] = useState<'takeover' | 'stale'>('takeover');
  const wantToolRef = useRef<AiToolId>(DEFAULT_AI_TOOL);
  useEffect(() => { wantToolRef.current = wantTool; }, [wantTool]);
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  // I-1: term がまだ無い間に届いた出力（scrollback・生チャンク）を溜めておくバッファ。
  // auth-ok → connected の phase 遷移は React の passive effect（term.open()）を
  // 挟むため、その間に届いたフレームを termRef.current?.write の `?.` で無言破棄しない。
  const pendingWriteRef = useRef<string[]>([]);
  // starting effect（deps: [phase]）が ensure() 呼び出し時点の最新テーマを読むための ref。
  // theme を effect の deps に入れると「テーマを変えるたびに再接続」になってしまうため、
  // ref 経由で「今の値」だけ渡す（claude 本体のテーマは起動時に一度渡せば十分 — 下記コメント）。
  const themeRef = useRef(theme);
  useEffect(() => { themeRef.current = theme; }, [theme]);

  /** term が張られていればそのまま書く。無ければ後で connected effect が flush する。 */
  function writeTerm(data: string): void {
    if (termRef.current) termRef.current.write(data);
    else pendingWriteRef.current.push(data);
  }

  function dispatch(ev: Parameters<typeof nextTerminalPhase>[1]): void {
    const next = nextTerminalPhase(phaseRef.current, ev);
    phaseRef.current = next;
    setPhaseRaw(next);
    if (ev.type === 'restart') setRemovedEnv([]);
    // defer #7: 再接続の成功（restart 着手／auth-ok）で古い失敗文言を残さない。
    if (ev.type === 'restart' || ev.type === 'ws-auth-ok') setError(null);
  }

  // 初回: ツール一覧と導入状態を確認。
  useEffect(() => {
    let alive = true;
    fetchJson<{ tools: ToolInfo[]; current: AiToolId | null; notes: string[] }>('/api/ai/tools')
      .then((s) => {
        if (!alive) return;
        setTools(s.tools);
        setNotes(s.notes);
        // サーバーが既に起動しているならそれを正本にする（表示と実体をずらさない）。
        const initial = s.current ?? pickInitialTool(s.tools, localStorage.getItem(TOOL_STORAGE_KEY));
        if (initial !== null) { setWantTool(initial); wantToolRef.current = initial; }
        setActualTool(s.current);
        const usable = initial !== null && s.tools.some((t) => t.id === initial && t.installed && t.versionOk);
        dispatch({ type: 'status', installed: usable });
      })
      .catch((e) => { if (alive) setError(e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; };
  }, []);

  // installing: 1 秒ポーリング。
  useEffect(() => {
    if (phase !== 'installing') return;
    const t = setInterval(() => {
      fetchJson<{ phase: 'idle' | 'running' | 'done' | 'failed'; log: string[]; error?: string }>(
        '/api/ai/install/status',
      ).then((s) => {
        setInstallLog(s.log.slice(-8));
        if (s.error !== undefined) setError(s.error);
        dispatch({ type: 'install-status', phase: s.phase });
      }).catch(() => { /* 次のポーリングで再試行 */ });
    }, 1000);
    return () => clearInterval(t);
  }, [phase]);

  // starting: pty ensure → トークン → WS → auth → xterm attach。
  useEffect(() => {
    if (phase !== 'starting') return;
    let cancelled = false;
    // C-1: 直前の ws（exited/takeover からの再起動で残っている旧接続）を必ず閉じてから
    // 新しい接続を張る。閉じずに新 ws を作ると、旧 ws がサーバから受ける takeover/
    // terminate の遅延イベント（onmessage/onerror/onclose）が新セッションの phase を
    // 後から汚染する（新品の端末が「別のタブで開かれました」等と誤表示し、キー入力も
    // wsRef が null に潰されて黙って消える）。close() 自体は非同期（'close' イベントは
    // 後で発火する）だが、この後 2 回の await（ensure/token）を挟むため、サーバ側が
    // close を処理し writer をクリアするのに十分な時間が空く。
    wsRef.current?.close();
    wsRef.current = null;
    pendingWriteRef.current = [];
    (async () => {
      try {
        // 修正2（テーマ追従）: claude 本体の配色は起動時の --settings で固定され、
        // プロセス起動後にエディタのテーマを切り替えても claude の出力色は変わらない
        // 制約がある（claudeArgs/EnsureOpts 参照）。ここで送るのは「今の」テーマでよい。
        const ensured = await putJsonPost<{ actualTool: AiToolId | null; notes: string[] }>(
          '/api/pty/ensure',
          { theme: themeRef.current, tool: wantToolRef.current },
        ).catch(async (err: unknown) => {
          // tool-mismatch（409）は「別タブが別のツールを動かしている」。エラーで止めず
          // サーバーの実ツールへ表示を寄せ、そのまま接続する。
          const fresh = await fetchJson<{ tools: ToolInfo[]; current: AiToolId | null; notes: string[] }>(
            '/api/ai/tools',
          ).catch(() => null);
          if (fresh?.current != null) {
            setTools(fresh.tools);
            setWantTool(fresh.current);
            wantToolRef.current = fresh.current;
            return { actualTool: fresh.current, notes: fresh.notes };
          }
          throw err;
        });
        if (cancelled) return;
        setActualTool(ensured.actualTool);
        // Minor 2: ok:true なら actualTool === 要求ツールというサーバー契約に暗黙で
        // 依存せず、実際に返ってきた actualTool へ wantTool（切替行のハイライト）も
        // 明示的に合わせる。表示は常にサーバー正本、という原則の徹底。
        if (ensured.actualTool !== null) {
          setWantTool(ensured.actualTool);
          wantToolRef.current = ensured.actualTool;
        }
        setNotes(ensured.notes);
        const { token } = await fetchJson<{ token: string }>('/api/pty/token');
        if (cancelled) return;
        const ws = new WebSocket(`ws://${location.host}/api/pty`);
        wsRef.current = ws;
        ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', token }));
        ws.onmessage = (e) => {
          // 自分が現在の接続でなければ無視する（旧 ws の遅延イベントで phase を汚染しない。C-1）。
          if (wsRef.current !== ws) return;
          if (typeof e.data !== 'string') return;
          if (e.data.startsWith('{')) {
            let m: { type?: string; data?: string; code?: number; keys?: string[] };
            try { m = JSON.parse(e.data); } catch { writeTerm(e.data); return; }
            if (m.type === 'auth-ok') { dispatch({ type: 'ws-auth-ok' }); return; }
            if (m.type === 'data' && typeof m.data === 'string') { writeTerm(m.data); return; }
            if (m.type === 'scrollback' && typeof m.data === 'string') { writeTerm(m.data); return; }
            if (m.type === 'removed-env' && Array.isArray(m.keys)) { setRemovedEnv(m.keys); return; }
            if (m.type === 'exit') {
              const code = typeof m.code === 'number' ? m.code : -1;
              dispatch({ type: 'ws-exit', code });
              return;
            }
            if (m.type === 'takeover') { setTakeoverReason('takeover'); dispatch({ type: 'ws-takeover' }); return; }
            if (m.type === 'stale') {
              // 別タブでのツール切替（switchTool）が pty の sessionId を入れ替えた後、
              // この接続の sessionId が一致しなくなったとサーバーが判定した合図。
              // 生テキストで端末に書くと `{"type":"stale"}` がそのまま表示されてしまう
              // ため必ずここで捕まえる（申し送り1）。onclose 側では再接続しない
              // （申し送り2: 切替の窓で認証を終えた世代を自動再接続で復活させるとループする）。
              // Minor 1: ここで setError も呼ぶと takeover phase の描画文言と二重表示に
              // なるため、理由だけ takeoverReason に記録し文言は描画側に一本化する。
              setTakeoverReason('stale');
              ws.close();
              dispatch({ type: 'ws-takeover' });
              return;
            }
            if (m.type === 'auth-failed') {
              setError('接続の認証に失敗しました。再読み込みしてください。');
              ws.close();
              dispatch({ type: 'fail', message: '接続の認証に失敗しました' });
              return;
            }
            // 生出力は常に {type:'data'} で届くため、ここに来る JSON は未知の制御
            // メッセージ。端末に流さず無視する（表示すると裸の JSON が見えてしまう）。
            return;
          }
          writeTerm(e.data);
        };
        ws.onerror = () => {
          if (wsRef.current !== ws) return; // 旧接続の遅延 error で新 phase を汚染しない（C-1）
          setError('AI への接続に失敗しました。ネットワークを確認してください。');
          dispatch({ type: 'fail', message: 'AI への接続に失敗しました' });
        };
        ws.onclose = () => { if (wsRef.current === ws) wsRef.current = null; };
      } catch (err) {
        if (!cancelled) {
          const message = err instanceof Error ? err.message : String(err);
          setError(message);
          dispatch({ type: 'fail', message });
        }
      }
    })();
    return () => { cancelled = true; };
  }, [phase]);

  // connected: xterm を張る（StrictMode 二重マウント対策に dispose を必ず返す）。
  useEffect(() => {
    if (phase !== 'connected' || hostRef.current === null) return;
    const term = new Terminal(terminalOptions(themeRef.current));
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(hostRef.current);
    fit.fit();
    // I-1: term ができる前（auth-ok → connected の passive effect 反映待ちの間）に
    // 届いた scrollback/出力をここで再生する。termRef.current 未設定の間の書き込みは
    // pendingWriteRef に溜まっている（writeTerm 参照）。
    if (pendingWriteRef.current.length > 0) {
      for (const chunk of pendingWriteRef.current) term.write(chunk);
      pendingWriteRef.current = [];
    }
    termRef.current = term;
    const send = (data: string) => wsRef.current?.send(JSON.stringify({ type: 'input', data }));
    const d1 = term.onData(send);
    const ro = new ResizeObserver(() => {
      fit.fit();
      wsRef.current?.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    });
    ro.observe(hostRef.current);
    return () => { d1.dispose(); ro.disconnect(); term.dispose(); termRef.current = null; };
  }, [phase]);

  // 修正2（テーマ追従）: data-theme が動的に切り替わった時、既に張られている xterm
  // インスタンスを作り直さず options.theme の再代入だけで配色を追従させる
  // （xterm はこの再代入をサポートしている）。claude 本体（pty の中身）の出力色は
  // 起動時の --settings で固定済みのため、ここでは変わらない（xterm 側の見た目だけ）。
  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = terminalTheme(theme);
  }, [theme]);

  // コンポーネント全体の unmount 時に WS を確実に閉じる。phase 遷移（starting→connected 等）
  // のたびには実行しない（deps: [] で mount/unmount 1 回のみ）ため、接続確立直後に
  // 誤って閉じてしまうことがない。
  useEffect(() => {
    return () => {
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, []);

  /** 表示名。tools 一覧に無い ID でもラベル欠落で落ちないよう ID 自体へフォールバックする。 */
  const currentLabel = (id: AiToolId | null): string =>
    tools.find((t) => t.id === id)?.label ?? (id === null ? 'AI' : id);

  async function handleInstall(): Promise<void> {
    setError(null);
    try {
      await putJsonPost('/api/ai/install', { tool: 'claude' });
      dispatch({ type: 'install-start' });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleStartWaiting(): Promise<void> {
    setWaiting(true);
    try {
      await putJsonPost('/api/pty/waiting', {});
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setWaiting(false);
    }
  }

  /**
   * ツール切替。確認ダイアログ → /api/pty/switch → 成功したら wsRef を閉じて
   * dispatch({type:'restart'}) で starting effect を再実行させる
   * （connected からの restart は claudeTerminalState.ts の拡張で許可済み）。
   * 再接続の発火はこの応答後（switchTool 成功）に限定する — onclose では再接続しない
   * （申し送り2）。
   */
  async function handleSwitchTool(next: AiToolId): Promise<void> {
    if (next === wantTool || switching) return;
    const from = currentLabel(actualTool ?? wantTool);
    const to = currentLabel(next);
    const ok = window.confirm(
      `今の ${from} を終了して ${to} に切り替えますか？ 実行中の編集は中断され、会話の内容も残りません。`,
    );
    if (!ok) return;
    setSwitching(true);
    setError(null);
    try {
      const r = await putJsonPost<{ actualTool: AiToolId; notes: string[] }>('/api/pty/switch', {
        tool: next,
        theme: themeRef.current,
      });
      localStorage.setItem(TOOL_STORAGE_KEY, r.actualTool);
      setWantTool(r.actualTool);
      wantToolRef.current = r.actualTool;
      setActualTool(r.actualTool);
      setNotes(r.notes);
      wsRef.current?.close();
      wsRef.current = null;
      dispatch({ type: 'restart' });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSwitching(false);
    }
  }

  return (
    <div className="clt">
      {shouldShowToolSwitcher(tools) && (
        <div className="clt-tools" role="radiogroup" aria-label="使う AI">
          {usableTools(tools).map((t) => (
            <button
              key={t.id}
              type="button"
              role="radio"
              aria-checked={t.id === wantTool}
              className={t.id === wantTool ? 'clt-tool clt-tool-on' : 'clt-tool'}
              disabled={switching}
              onClick={() => void handleSwitchTool(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
      )}
      {wantTool === 'codex' && (
        <p className="clt-note">
          初回だけ Codex が英語で確認を出します（このフォルダを信頼しますか）。Enter を押せば進めます。
        </p>
      )}
      {notes.map((n) => (
        <p className="clt-note clt-note-warn" key={n}>{n}</p>
      ))}
      {removedEnv.length > 0 && (
        <p className="clt-env-note">
          課金保護のため {removedEnv.join(', ')} を外して起動しました（戻すには SME_ALLOW_API_KEY=1）
        </p>
      )}
      {error !== null && <p className="sme-error">{error}</p>}
      {phase === 'checking' && <p className="hint">AI の状態を確認しています…</p>}
      {(phase === 'need-install' || phase === 'install-failed') && (
        <div className="clt-setup">
          <p>Claude Code がまだ入っていません。ボタン1つで導入できます。</p>
          <button type="button" className="clt-install-btn" onClick={() => void handleInstall()}>
            AI と接続する（Claude Code を導入）
          </button>
          {phase === 'install-failed' && (
            <p className="clt-install-manual">
              うまくいかない場合はターミナルで <code>npm install -g @anthropic-ai/claude-code</code> を実行してください
            </p>
          )}
        </div>
      )}
      {phase === 'installing' && (
        <div className="clt-installing">
          <span className="status-spinner" aria-hidden="true" /> 導入中…
          <pre className="clt-install-log">{installLog.join('\n')}</pre>
        </div>
      )}
      {(phase === 'connected' || phase === 'exited' || phase === 'takeover') && (
        <>
          <div
            className="clt-term"
            ref={hostRef}
            data-testid="claude-terminal"
            /* 枠の地色は端末の配色と同じ出所から取る。CSS 側に色を書くと light/dark の
               2 値が styles.css と shared/terminalColors.ts に二重定義になり、
               ライトテーマで白い端末のまわりに黒い額縁が出る（G-4 実測）。 */
            style={{ background: terminalColorsFor(theme).background }}
          />
          {phase === 'connected' && (
            <div className="clt-actions">
              <button type="button" className="clt-waiting-btn" disabled={waiting}
                onClick={() => void handleStartWaiting()}>
                待機を開始（編集指示を受け付ける）
              </button>
            </div>
          )}
          {phase === 'exited' && (
            <div className="clt-exit">
              <p>{currentLabel(actualTool ?? wantTool)} が終了しました。</p>
              <button type="button" onClick={() => dispatch({ type: 'restart' })}>再起動する</button>
            </div>
          )}
          {phase === 'takeover' && (
            <div className="clt-exit">
              {/* Minor 1: 原因ごとに文言を分ける（takeover=別タブに端末を奪われた／
                  stale=別タブでのツール切替でこの接続が無効になった）。
                  再接続ボタンはどちらの場合も同じものを出し続ける。 */}
              <p>
                {takeoverReason === 'stale'
                  ? '別のタブで AI ツールが切り替えられたため、この接続は無効になりました。'
                  : '別のタブでターミナルが開かれたため、このタブは切断されました。'}
              </p>
              <button type="button" onClick={() => dispatch({ type: 'restart' })}>このタブで開き直す</button>
            </div>
          )}
        </>
      )}
      {phase === 'starting' && <p className="hint">{currentLabel(wantTool)} に接続しています…</p>}
      {phase === 'failed' && (
        <div className="clt-exit">
          <p>{error ?? 'AI への接続に失敗しました。'}</p>
          <button type="button" onClick={() => dispatch({ type: 'restart' })}>もう一度接続する</button>
        </div>
      )}
    </div>
  );
}
