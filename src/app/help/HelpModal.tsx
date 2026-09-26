/**
 * HelpModal — チュートリアル図鑑。横2ペイン（検索・カテゴリ・一覧 / 選択項目の詳細）で
 * 14項目を辞書的に閲覧できるモーダル。狭幅では1カラム・アコーディオン展開に畳む
 * （CSS の media query で切替・DOM は両方持って出し分ける）。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useFocusTrap } from '../useFocusTrap';
import {
  HELP_CATEGORIES,
  HELP_TOPICS,
  filterHelpTopics,
  indexOfTopic,
  nextTopicId,
  prevTopicId,
  resolveSelection,
  type HelpCategory,
  type HelpTopic,
} from './helpTopics';
import { loadSeenFeatures, markFeatureSeen, showNewBadge, type FeatureScope } from '../featureSeen';

// 既読キーの名前空間。チュートリアル（tutorialSteps）と id が重なるため必ず分ける。
const FEATURE_SCOPE: FeatureScope = 'help';

// 画像は glob で自動列挙し「img/<topicId>.png」規約で引く。手動 import マップだと
// topic 追加時に追記を忘れても全テストが緑のまま画像だけ割れる（helpTopics.test の
// 存在チェックと単一ソースにするため glob に統一・レビュー M-1）。
const HELP_IMAGE_MODULES = import.meta.glob('./img/*.png', { eager: true, import: 'default' }) as Record<string, string>;

/** topicId → 画像 URL（helpTopics.test が全 topic 分の解決可能性を検証する）。 */
export function helpImageFor(topicId: string): string | undefined {
  return HELP_IMAGE_MODULES[`./img/${topicId}.png`];
}

export interface HelpModalProps {
  /** ✕ / オーバーレイクリック / Esc で閉じる。 */
  onClose: () => void;
  /** ヘッダー「▶ もう一度最初から見る」。モーダルを閉じてスポットライト型チュートリアルを最初から開始する
   * （既存の再実行機構を App 側で呼ぶため、close と start の両方を App 側の1関数に委ねる）。
   * `hideTutorialRestart` の間はボタン自体を出さないため呼ばれない。 */
  onRestartTutorial: () => void;
  /**
   * スポットライト型チュートリアルのない画面では再開ボタンを隠す。
   * 現在、製品コードの利用箇所は無い（2026-09-25 以降、新画面でも再開ボタンを出す）。prop とテストは残している。
   */
  hideTutorialRestart?: boolean;
}

type CategoryFilter = HelpCategory | 'all';

export function HelpModal({ onClose, onRestartTutorial, hideTutorialRestart = false }: HelpModalProps) {
  const detailPaneRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<CategoryFilter>('all');
  const [rawSelectedId, setSelectedId] = useState<string | null>(HELP_TOPICS[0]?.id ?? null);
  // 新機能バッジの既読集合。開いた時点の localStorage を初期値にし、以後は
  // 「ユーザーが項目を選んだら既読」でこの state を更新する（バッジがその場で消える）。
  const [seenFeatures, setSeenFeatures] = useState<ReadonlySet<string>>(() =>
    loadSeenFeatures(FEATURE_SCOPE, HELP_TOPICS.map((t) => t.id)),
  );

  /**
   * 項目を選ぶ＝既読にする。**呼ぶのはユーザーの明示操作の経路だけ**
   * （一覧クリック・前へ／次へ・矢印キー）。初期表示や検索による先頭寄せは自動選択なので、
   * 「見せてもいない機能の NEW が黙って消える」を避けるため既読化しない。
   */
  function selectTopic(id: string): void {
    setSelectedId(id);
    markFeatureSeen(FEATURE_SCOPE, id);
    setSeenFeatures((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
  }

  const filtered = useMemo(() => filterHelpTopics(HELP_TOPICS, query, category), [query, category]);

  // 検索・カテゴリ変更で選択中項目が絞り込み結果外になったら先頭へ寄せる。
  // state を effect で書き戻すと1フレーム分「選択なし」が見えるため、描画時にその場で解決する
  // （selectedId 自体は素通しし、次のクリックで自然に更新される）。
  const selectedId = resolveSelection(filtered, rawSelectedId);

  const index = indexOfTopic(filtered, selectedId);
  const selected: HelpTopic | null = index >= 0 ? (filtered[index] ?? null) : null;
  const prevId = prevTopicId(filtered, selectedId);
  const nextId = nextTopicId(filtered, selectedId);

  // 縦長画像を読んだあとも、次の項目は画像の先頭から表示する。
  useEffect(() => {
    if (detailPaneRef.current) detailPaneRef.current.scrollTop = 0;
  }, [selectedId]);

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.isComposing) return;
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      const target = e.target as HTMLElement | null;
      const inEditable =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        (target?.isContentEditable ?? false);
      if (inEditable) return;
      if (e.key === 'ArrowLeft' && prevId !== null) {
        selectTopic(prevId);
      } else if (e.key === 'ArrowRight' && nextId !== null) {
        selectTopic(nextId);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, prevId, nextId]);

  // カテゴリ見出し付きの一覧（登場順にカテゴリ見出しを挿む）。
  const groups: { category: HelpCategory; topics: HelpTopic[] }[] = [];
  for (const t of filtered) {
    const last = groups[groups.length - 1];
    if (last !== undefined && last.category === t.category) {
      last.topics.push(t);
    } else {
      groups.push({ category: t.category, topics: [t] });
    }
  }

  function renderDetail(topic: HelpTopic) {
    return (
      <>
        <a key={topic.id} className="help-image-link" href={helpImageFor(topic.id)} target="_blank" rel="noreferrer"
          aria-label={`${topic.title}の画像を大きく表示`} title="クリックして画像を大きく表示">
          <img className="help-img" src={helpImageFor(topic.id)} alt={topic.title} />
        </a>
        <div className="help-cap-row">
          <span className="help-cap">{topic.title}</span>
          <span className="help-detail-chip">{topic.category}</span>
        </div>
        <p className="help-desc">{topic.description}</p>
        <div className="help-nav">
          <button
            type="button"
            className="help-nav-btn help-prev"
            disabled={prevId === null}
            onClick={() => prevId !== null && selectTopic(prevId)}
          >
            ← 前へ
          </button>
          <span className="help-nav-count">
            {index + 1} / {filtered.length}
          </span>
          <button
            type="button"
            className="help-nav-btn help-next"
            disabled={nextId === null}
            onClick={() => nextId !== null && selectTopic(nextId)}
          >
            次へ →
          </button>
        </div>
      </>
    );
  }

  // aria-modal を名乗る以上、Tab はこの中だけを巡回させる（サイクル 3 残 Minor）。
  const helpDialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(helpDialogRef);
  return (
    <div className="help-overlay" onClick={onClose}>
      <div
        ref={helpDialogRef}
        className="help-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="チュートリアル図鑑"
        data-testid="help-dialog"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="help-head">
          <span className="help-title">📖 チュートリアル図鑑</span>
          <span className="help-count">全{HELP_TOPICS.length}項目</span>
          {!hideTutorialRestart && (
            <button type="button" className="help-replay-btn" onClick={onRestartTutorial}>
              ▶ もう一度最初から見る
            </button>
          )}
          <button type="button" className="help-close" aria-label="閉じる" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="help-body">
          <div className="help-list-pane">
            <div className="help-search">
              <span aria-hidden="true">🔍</span>
              <input
                type="text"
                className="help-search-input"
                aria-label="項目を検索"
                placeholder="検索…"
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <div className="help-chips">
              <button
                type="button"
                className={'help-chip' + (category === 'all' ? ' on' : '')}
                onClick={() => setCategory('all')}
              >
                すべて
              </button>
              {HELP_CATEGORIES.map((c) => (
                <button
                  key={c}
                  type="button"
                  className={'help-chip' + (category === c ? ' on' : '')}
                  onClick={() => setCategory(c)}
                >
                  {c}
                </button>
              ))}
            </div>
            <div className="help-list">
              {filtered.length === 0 && <div className="help-empty">該当する項目がありません</div>}
              {groups.map((g) => (
                <div key={g.category} className="help-group">
                  <div className="help-cat-heading">{g.category}</div>
                  {g.topics.map((t) => (
                    <div key={t.id} className="help-item-wrap">
                      <button
                        type="button"
                        className={'help-item' + (t.id === selected?.id ? ' active' : '')}
                        data-topic-id={t.id}
                        onClick={() => selectTopic(t.id)}
                      >
                        <span className="help-item-no">{t.no}</span>
                        <span className="help-item-title">{t.title}</span>
                        {showNewBadge(t.addedIn, t.id, seenFeatures) && (
                          <span className="help-new-badge" aria-label="新機能">NEW</span>
                        )}
                      </button>
                      {t.id === selected?.id && <div className="help-accordion">{renderDetail(t)}</div>}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </div>
          <div ref={detailPaneRef} className="help-detail-pane">{selected !== null && renderDetail(selected)}</div>
        </div>
      </div>
    </div>
  );
}
