/**
 * eventBus — SSE 1 本統合（/api/events）のクライアント側配線。
 *
 * 背景: 従来はフックごとに EventSource を直張りしており、1 タブあたり最大 8 本の
 * SSE 接続を張っていた。2 タブ開くと Chrome の HTTP/1.1 同一オリジン同時接続上限
 * （6 本）を使い切り、他の fetch（動画読込・保存・pack-upgrade 等）が止まる実害が
 * あった（2026-07-23 実機）。ゴール: 1 タブ = SSE 1 本。
 *
 * `EventBusProvider` がタブ全体で 1 本の EventSource を張り、`{"ch":"...","msg":...}`
 * 形式のメッセージをチャネルごとの購読者へ配る。各フックは `useEventChannel(ch, handler)`
 * で自分のチャネルだけを受け取る（サーバ側の従来ペイロードは無変換のまま msg に入って
 * いるので、各フックの既存パーサ・状態機械はそのまま使い回せる）。
 *
 * 接続先: projectId が空文字なら `/api/events`（ホーム画面・projects チャネルのみ）、
 * 非空なら `/api/events?id=...`（エディタ画面・全チャネル）。projectId が変わったら
 * 張り替える。
 *
 * **onerror では絶対に close しない**（自動再接続を殺すと恒久停止する — 既知の学び
 * feedback-sse-eventsource-no-reconnect）。close するのは unmount / projectId 変更時のみ。
 *
 * 契約: SSE は**この 1 本へ統合**する。新しい通知が要るときは新エンドポイントを
 * 足すのではなく、この接続のチャネルを増やす（接続数はブラウザの同一オリジン上限を食う）。
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

type ChannelHandler = (msg: unknown) => void;

interface EventBusContextValue {
  subscribe(ch: string, handler: ChannelHandler): () => void;
  setProjectId(projectId: string): void;
}

const EventBusContext = createContext<EventBusContextValue | null>(null);

interface EventBusProviderProps {
  /**
   * 初期プロジェクト id（省略時は空文字＝ホーム画面）。EventBusProvider は
   * アプリのルート（main.tsx）で 1 度だけマウントする想定のため、以降の切替えは
   * この prop の変更ではなく `useEventBusProjectId` フックから行う
   * （App 内部の selectedId が確定するのは Provider より下の階層のため、
   * 「配線される側」の App から能動的に伝える設計）。
   */
  projectId?: string;
  children: ReactNode;
}

export function EventBusProvider({ projectId: initialProjectId = '', children }: EventBusProviderProps) {
  const [projectId, setProjectId] = useState(initialProjectId);
  const listenersRef = useRef<Map<string, Set<ChannelHandler>>>(new Map());

  const subscribe = useCallback((ch: string, handler: ChannelHandler): (() => void) => {
    let set = listenersRef.current.get(ch);
    if (!set) {
      set = new Set();
      listenersRef.current.set(ch, set);
    }
    set.add(handler);
    const ref = set;
    return () => ref.delete(handler);
  }, []);

  useEffect(() => {
    const url = projectId === '' ? '/api/events' : `/api/events?id=${encodeURIComponent(projectId)}`;
    const es = new EventSource(url);
    es.onmessage = (e: MessageEvent<string>) => {
      try {
        const data: unknown = JSON.parse(e.data);
        if (typeof data !== 'object' || data === null) return;
        const { ch, msg } = data as { ch?: unknown; msg?: unknown };
        if (typeof ch !== 'string') return;
        const set = listenersRef.current.get(ch);
        if (!set) return;
        for (const fn of set) fn(msg);
      } catch {
        // 不正な JSON は無視する。
      }
    };
    es.onerror = () => {
      // ブラウザ標準の自動再接続に委ねる。ここで close すると恒久停止する
      // （既知の学び: feedback-sse-eventsource-no-reconnect）。
    };
    return () => {
      es.close();
    };
  }, [projectId]);

  const value = useMemo<EventBusContextValue>(() => ({ subscribe, setProjectId }), [subscribe]);

  return <EventBusContext.Provider value={value}>{children}</EventBusContext.Provider>;
}

/**
 * バスの接続先プロジェクトを切り替える。App のルートで現在の projectId
 * （未選択なら ''）を渡して 1 回呼ぶ想定。projectId が変わるとバスは張り替わる。
 */
export function useEventBusProjectId(projectId: string): void {
  const ctx = useContext(EventBusContext);
  useEffect(() => {
    ctx?.setProjectId(projectId);
  }, [ctx, projectId]);
}

/**
 * 指定チャネルのメッセージを購読する。EventBusProvider の外（Provider 無し）で
 * 呼ばれた場合は何もしない（テストで Provider を省略しても安全に no-op）。
 * handler は ref 経由で最新を呼ぶ（stale capture 防止）。
 */
export function useEventChannel(ch: string, handler: ChannelHandler): void {
  const ctx = useContext(EventBusContext);
  const handlerRef = useRef(handler);
  useEffect(() => {
    handlerRef.current = handler;
  }, [handler]);
  useEffect(() => {
    if (!ctx) return;
    return ctx.subscribe(ch, (msg) => handlerRef.current(msg));
  }, [ctx, ch]);
}

/**
 * バス接続確立「後」にマウント/リマウントしたコンシューマ向けのキャッチアップ取得。
 * `GET /api/events/sync?id=<projectId>&ch=<channel>`（サーバ eventsApi.ts）を叩き、
 * 「今つないだら最初に届くはずのメッセージ列」を返す。
 *
 * 背景: EventBusProvider は main.tsx でタブ全体につき 1 度だけマウントされ張りっぱなしの
 * ため、接続時に一度きり配られる初期スナップショット（idle/snapshot・claude の初期一覧）は
 * 「接続が確立した後にマウントしたコンシューマ」には届かない（バスは過去メッセージを
 * 再送しない）。プロジェクト再読込で unmount→remount する `TranscriptPanel` 配下のフック
 * （useNormalize 等）や、初回マウントの ClaudePanel/useRenderJob がこれに該当する。
 *
 * projectId が空文字の間は fetch しない（未選択・空文字は「何もしない」の既存規約）。
 * 取得失敗（ネットワーク断・非対応チャネル等）は静かに諦める（空配列）— 以降のライブ
 * 更新はバス購読に委ねられるため致命的ではない。
 *
 * **terminal 取り逃し防止の前提（レビュー指摘 M-3）**: sync 取得中〜完了までの間に、
 * 同じジョブが terminal（done/failed/cancelled/completed）へ遷移してライブメッセージが
 * バスから届いても、`useEventChannelWithSync` は `useEventChannel`（下記）を sync effect と
 * 同時に配線するため取りこぼさない設計を意図している。ただしこれは React の effect
 * 実行順（子コンポーネントの effect は親〔EventBusProvider〕の effect より先に走る）に
 * 依存した前提であり、保証は「同一コミット内であれば子が先」という React の一般則までで、
 * projectId 変更が `useEventBusProjectId` の effect 経由（＝別コミット）で Provider へ伝播する
 * 都合上、Provider の EventSource 張り替えとコンシューマの新規マウントが必ず同一コミットに
 * 揃う保証は無い。sync とライブイベントの順序レース自体は「最後に処理された方が正」で
 * 許容しているため実害は限定的だが、この前提が崩れた場合の症状は「ごく短い窓で稀に
 * 古い状態が一瞬だけ表示される」程度に留まる設計であることに留意する。
 */
export async function fetchEventsSync(projectId: string, ch: string): Promise<unknown[]> {
  if (!projectId) return [];
  try {
    const res = await fetch(`/api/events/sync?id=${encodeURIComponent(projectId)}&ch=${encodeURIComponent(ch)}`);
    if (!res.ok) return [];
    const body: unknown = await res.json();
    if (typeof body !== 'object' || body === null) return [];
    const messages = (body as { messages?: unknown }).messages;
    return Array.isArray(messages) ? messages : [];
  } catch {
    return [];
  }
}

/**
 * `useEventChannel` にマウント時（projectId 変更時）の `fetchEventsSync` キャッチアップを
 * セットにしたフック。apply はライブメッセージ・sync で取得したメッセージ列の両方に対して
 * 順に呼ばれる（sync のメッセージは「今つないだら最初に届くはずの」ものなので、通常の
 * 1 メッセージ処理関数をそのまま渡せる）。sync とライブイベントの順序レースは
 * 「最後に処理された方が正」で許容する（旧・接続ごと EventSource 方式でも同様のレースが
 * あった）。
 *
 * @param projectId - 対象プロジェクト ID。空文字なら sync は行わない
 *   （useEventChannel 自体は Provider 経由で常時購読するので、ライブ更新は継続する）。
 */
export function useEventChannelWithSync(ch: string, projectId: string, apply: ChannelHandler): void {
  const applyRef = useRef(apply);
  useEffect(() => {
    applyRef.current = apply;
  }, [apply]);

  useEventChannel(ch, (msg) => applyRef.current(msg));

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    fetchEventsSync(projectId, ch).then((messages) => {
      if (cancelled) return;
      for (const msg of messages) applyRef.current(msg);
    });
    return () => {
      cancelled = true;
    };
  }, [projectId, ch]);
}
