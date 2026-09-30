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
import { pickInitialTool, toolButtonState, toolButtonHint, CODEX_INSTALL_URL, type ToolInfo } from './aiToolSwitcher';
import { dropPaths, hasDroppedFiles, terminalDropText } from './terminalDrop';

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
  /** I1: 「再確認」の連打で recheck=1 の GET が複数飛ばないようにする in-flight ガード。 */
  const [rechecking, setRechecking] = useState(false);
  /**
   * I2: 導入中のツール id（無ければ null）。`phase` は「今 wantTool の端末がどの段階か」
   * を表す別の状態機械で、もう一方のツールが connected 中でも導入進捗はここで独立に追う。
   */
  const [installingTool, setInstallingTool] = useState<AiToolId | null>(null);
  /**
   * takeover phase に落ちた理由。'takeover'（別タブがこの端末を奪った）と
   * 'stale'（別タブのツール切替でこの接続が無効になった）は原因が違い、
   * 利用者が取るべき次の行動の理解も変わるため、文言を出し分ける
   * （Minor 1: 以前は stale でも setError と takeover 文言が両方出て二重表示だった）。
   */
  const [takeoverReason, setTakeoverReason] = useState<'takeover' | 'stale'>('takeover');
  /** ファイルを端末の上に重ねている間だけ true（受け付けの目印を出す）。 */
  const [dropHover, setDropHover] = useState(false);
  /** ドロップしたファイルをブラウザ版がサーバーへ送っている間だけ true。 */
  const [attaching, setAttaching] = useState(false);
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

  /**
   * ツール一覧を取得し直す。初回取得・導入完了後の反映・「再確認」ボタンの
   * いずれからも呼ぶ共通経路（申し送り: TTL（5秒）任せにすると
   * 「導入したのに未導入と出る」に戻るため、導入完了検知の直後に必ず呼ぶ）。
   *
   * I1（レビュー指摘）: `recheck=true` は「再確認」ボタン押下時専用。サーバーの
   * TOOL_CACHE_TTL_MS（5秒）を素通しして毎回実探索させる。初回取得・導入完了後の
   * 自動反映は通常どおりキャッシュを使う（乱打防止・不要な探索を増やさない）。
   */
  async function refreshTools(recheck = false): Promise<void> {
    const s = await fetchJson<{ tools: ToolInfo[]; current: AiToolId | null; notes: string[] }>(
      recheck ? '/api/ai/tools?recheck=1' : '/api/ai/tools',
    );
    setTools(s.tools);
    setNotes(s.notes);
    // サーバーが既に起動しているならそれを正本にする（表示と実体をずらさない）。
    const initial = s.current ?? pickInitialTool(s.tools, localStorage.getItem(TOOL_STORAGE_KEY));
    if (initial !== null) { setWantTool(initial); wantToolRef.current = initial; }
    setActualTool(s.current);
    const usable = initial !== null && s.tools.some((t) => t.id === initial && t.installed && t.versionOk);
    dispatch({ type: 'status', installed: usable });
  }

  // 初回: ツール一覧と導入状態を確認。
  useEffect(() => {
    let alive = true;
    refreshTools().catch((e) => { if (alive) setError(e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; };
  }, []);

  // 導入中: 1 秒ポーリング。
  // I2（レビュー指摘）: 以前は `phase==='installing'` にだけ掛かっていたため、片方の
  // ツールが connected 中はもう一方の導入を始めても phase が 'installing' へ進まず
  // （claudeTerminalState の install-start は need-install/install-failed からしか
  // 遷移しない）、このポーリングも進捗の自動反映も起きなかった。`installingTool`
  // （ツール単位の独立 state）を正にして、現在の全体 phase から切り離す。
  useEffect(() => {
    if (installingTool === null) return;
    const t = setInterval(() => {
      fetchJson<{ phase: 'idle' | 'running' | 'done' | 'failed'; log: string[]; error?: string }>(
        '/api/ai/install/status',
      ).then((s) => {
        setInstallLog(s.log.slice(-8));
        if (s.error !== undefined) setError(s.error);
        if (s.phase === 'done' || s.phase === 'failed') {
          setInstallingTool(null);
          // 導入完了は TTL を待たず即座に再検出する（申し送り参照）。
          if (s.phase === 'done') void refreshTools().catch(() => { /* 次の操作で再試行 */ });
        }
        // phase が need-install/installing 側にいる時（従来の単一ツール導入フロー）は
        // 引き続きここで駆動する。connected 等では nextTerminalPhase が現状維持を返すため
        // 無害（申し送り: 既存の状態機械はそのまま・拡張しない）。
        dispatch({ type: 'install-status', phase: s.phase });
      }).catch(() => { /* 次のポーリングで再試行 */ });
    }, 1000);
    return () => clearInterval(t);
  }, [installingTool]);

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

  // ドラッグを端末の外で離した・取り消した時に、受け付けの目印を残さない。
  useEffect(() => {
    if (!dropHover) return;
    const clear = () => setDropHover(false);
    window.addEventListener('drop', clear); window.addEventListener('dragend', clear); window.addEventListener('blur', clear);
    return () => { window.removeEventListener('drop', clear); window.removeEventListener('dragend', clear); window.removeEventListener('blur', clear); };
  }, [dropHover]);

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

  async function handleInstall(tool: AiToolId): Promise<void> {
    if (installingTool !== null) return; // Minor 4: 導入中の連打で POST を重複させない
    setError(null);
    try {
      await putJsonPost('/api/ai/install', { tool });
      setInstallingTool(tool);
      // 既存の単一ツール導入フロー（need-install/install-failed からの遷移）は
      // そのまま dispatch で駆動する。connected 等では nextTerminalPhase が現状維持を
      // 返すため無害（I2 申し送り: 既存の状態機械は拡張しない）。
      dispatch({ type: 'install-start' });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  /** 「再確認」ボタン。押下中は disabled にして二重送信を防ぐ（Minor 4 と同種のガード）。 */
  async function handleRecheck(): Promise<void> {
    if (rechecking) return;
    setRechecking(true);
    try {
      await refreshTools(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRechecking(false);
    }
  }

  /**
   * 端末へ落とされたファイルのパスを貼り付けとして入力する。ターミナルアプリへの
   * ドラッグと同じ入力になるため、claude は画像パスを添付画像として取り込む。
   * 送信（Enter）はしない。利用者が指示を書き足してから送れるようにする。
   */
  async function handleDropFiles(files: File[]): Promise<void> {
    if (!files.length || attaching) return;
    setError(null);
    setAttaching(true);
    try {
      const text = terminalDropText(await dropPaths(files));
      const term = termRef.current;
      if (!term || phaseRef.current !== 'connected') throw new Error('AI との接続が切れたため、ファイルを渡せませんでした');
      term.paste(text);
      term.focus();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setAttaching(false);
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
      <div className="clt-tools" role="radiogroup" aria-label="使う AI">
        {tools.map((t) => {
          const state = toolButtonState(t);
          return (
            <div className="clt-tool-cell" key={t.id}>
              <button
                type="button"
                role="radio"
                aria-checked={t.id === wantTool && state === 'ready'}
                aria-describedby={`clt-hint-${t.id}`}
                className={t.id === wantTool && state === 'ready' ? 'clt-tool clt-tool-on' : 'clt-tool'}
                data-state={state}
                disabled={switching || state !== 'ready'}
                onClick={() => void handleSwitchTool(t.id)}
              >
                {t.label}
              </button>
              <span className="clt-tool-hint" id={`clt-hint-${t.id}`}>
                {state === 'manual'
                  ? <>未導入です。<a href={CODEX_INSTALL_URL} target="_blank" rel="noreferrer">導入手順を見る</a></>
                  : toolButtonHint(t)}
              </span>
              {state === 'installable' && installingTool === t.id && (
                // I2: もう一方が connected 中でも、導入中のツールにはここで進捗を出す
                // （全体 phase を占有しないため大画面の「導入中…」に頼れない）。
                <span className="clt-install-progress">
                  <span className="status-spinner" aria-hidden="true" /> 導入中…
                </span>
              )}
              {state === 'installable' && installingTool !== t.id && (
                <button
                  type="button"
                  className="clt-install-btn"
                  disabled={installingTool !== null}
                  onClick={() => void handleInstall(t.id)}
                >
                  インストール
                </button>
              )}
              {state === 'unverified' && (
                <button type="button" className="btn-ghost" disabled={rechecking} onClick={() => void handleRecheck()}>
                  再確認
                </button>
              )}
            </div>
          );
        })}
      </div>
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
      {phase === 'need-install' && (
        <p className="hint">上のボタンから使いたい AI を導入してください。</p>
      )}
      {phase === 'install-failed' && (
        <div className="clt-setup">
          <p className="clt-install-manual">
            導入がうまくいきませんでした。ターミナルで <code>npm install -g @anthropic-ai/claude-code</code> を実行してください
          </p>
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
          {/* ドロップは xterm の外側の枠で受ける（xterm 自身はファイルのドロップを扱わない。
              受けないと画面全体の既定動作抑止に吸われ、何も起きない）。 */}
          <div
            className={dropHover ? 'clt-term-frame is-drop' : 'clt-term-frame'}
            onDragEnter={(event) => {
              if (!hasDroppedFiles(event.dataTransfer)) return;
              event.preventDefault(); event.stopPropagation();
              setDropHover(phase === 'connected' && !attaching);
            }}
            onDragOver={(event) => {
              if (!hasDroppedFiles(event.dataTransfer)) return;
              event.preventDefault(); event.stopPropagation();
              event.dataTransfer.dropEffect = phase === 'connected' && !attaching ? 'copy' : 'none';
            }}
            onDragLeave={(event) => {
              if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
              setDropHover(false);
            }}
            onDrop={(event) => {
              if (!hasDroppedFiles(event.dataTransfer)) return;
              event.preventDefault(); event.stopPropagation();
              setDropHover(false);
              if (phase === 'connected') void handleDropFiles(Array.from(event.dataTransfer.files));
            }}
          >
            <div
              className="clt-term"
              ref={hostRef}
              data-testid="claude-terminal"
              /* 枠の地色は端末の配色と同じ出所から取る。CSS 側に色を書くと light/dark の
                 2 値が styles.css と shared/terminalColors.ts に二重定義になり、
                 ライトテーマで白い端末のまわりに黒い額縁が出る（G-4 実測）。 */
              style={{ background: terminalColorsFor(theme).background }}
            />
            {dropHover && <div className="clt-drop-hint" aria-hidden="true">ここで離すと、ファイルを AI に渡します</div>}
          </div>
          {attaching && <p className="hint">ファイルを AI に渡しています…</p>}
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
