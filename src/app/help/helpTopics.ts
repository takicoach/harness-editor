/**
 * チュートリアル図鑑（HelpModal）のデータと純関数。
 * 初回チュートリアル（tutorialSteps.ts）の15ステップから、進行専用ステップ
 * （welcome/telop-done/finish 等）を除き AI 待機モード解説を加えた13項目を、文脈非依存の静的説明文へ
 * 書き直したもの。spec: docs/specs/2026-07-23-help-encyclopedia.md
 */

export type HelpCategory = '基本' | 'AI' | '編集' | '仕上げ';

export const HELP_CATEGORIES: HelpCategory[] = ['基本', 'AI', '編集', '仕上げ'];

export interface HelpTopic {
  id: string;
  no: number;
  title: string;
  category: HelpCategory;
  description: string;
}

export const HELP_TOPICS: HelpTopic[] = [
  {
    id: 'home',
    no: 1,
    title: 'ホーム画面',
    category: '基本',
    description: 'これがホーム画面です。作った動画がここに並んでいきます。動画を選ぶとすぐ編集画面が開きます。',
  },
  {
    id: 'board',
    no: 2,
    title: '進行ボード',
    category: '基本',
    description:
      'ホーム右上の表示切り替えで「進行ボード」にすると、動画ごとの進み具合（編集中→書き出し済→公開済）をボードで見られます。',
  },
  {
    id: 'create',
    no: 3,
    title: '動画を作成する',
    category: '基本',
    description:
      'ホームの「＋ 動画を作成する」から動画ファイルを選ぶと、新しいプロジェクトが作られます。プロジェクト名を付けたら「作成」。取り込みには少し時間がかかることがあります。',
  },
  {
    id: 'mcp',
    no: 4,
    title: 'AI エージェント接続',
    category: 'AI',
    description:
      'このエディタは AI 動画編集に対応しています。編集画面の「AI」タブを開くと「AI と接続する（Claude Code を導入）」ボタンが出るので、押すだけで接続できます（初回のみ導入とログインが必要）。接続すると「ここをカットして」など何でも頼めるようになります。',
  },
  {
    id: 'ai-tab',
    no: 5,
    title: 'AI タブに頼む',
    category: 'AI',
    description:
      '編集画面の「AI」タブから、接続した AI エージェントに「ここをカットして」「テロップを赤に」など編集を頼めます。やりたいことがあったら、まず何でも聞いてみましょう。',
  },
  {
    id: 'ai-modes',
    no: 6,
    title: 'AI の待機モード（全体待機／動画専属）',
    category: 'AI',
    description:
      'AI エージェントの待機のしかたは2つあります。「A. 全体待機」（推奨）は、1つの待機役がすべての動画を担当し、指示ごとに裏で助手（subagent）へ任せるので、複数の動画を同時に進められます——AI タブの「待機を開始」ボタンを押すだけで始まります。「B. この動画専属」は、その動画の指示だけを処理する集中モードで、別ターミナルの Claude Code に専属の待機プロンプト（AI接続マニュアルの付録にひな形）を貼り付けて使います。同じ動画に両方いる時は専属が優先され、専属の反応が約3分途絶えると全体待機が自動で引き継ぎます。',
  },
  {
    id: 'materials',
    no: 7,
    title: '素材を追加する（左カラム）',
    category: '編集',
    description:
      '編集画面左の「素材」タブから効果音・画像・BGM を追加できます。Finder からのドラッグ＆ドロップでも追加できます。',
  },
  {
    id: 'timeline',
    no: 8,
    title: 'タイムラインとシーン転換',
    category: '編集',
    description:
      '画面下がタイムラインです。カットすると、つなぎ目に ◇ マークが出ます。これがシーン転換で、クリックすると転換効果を選べます。',
  },
  {
    id: 'add-button',
    no: 9,
    title: '＋ 追加ボタン',
    category: '編集',
    description:
      '字幕・テロップ・効果音・BGM・サブ動画——何かを足したいときは、ぜんぶタイムラインの「＋ 追加」からです。迷ったらココ！',
  },
  {
    id: 'telop',
    no: 10,
    title: 'テロップ',
    category: '編集',
    description: '「＋ 追加」からテロップを追加し、右の設定パネルで文言の書き換えやスタイルの変更ができます。',
  },
  {
    id: 'save',
    no: 11,
    title: '保存',
    category: '仕上げ',
    description: 'ツールバーの「保存」を押すと、ここまでの編集が保存されます（⌘S でも OK）。',
  },
  {
    id: 'render',
    no: 12,
    title: '書き出し',
    category: '仕上げ',
    description:
      '編集が終わったら「書き出し」で動画ファイルにします。投稿先に合わせたプリセット（高画質/標準/軽量）を選べて、自動保存してからレンダリングが始まります。完成したらフォルダを開いてすぐ確認できます。',
  },
  {
    id: 'layout',
    no: 13,
    title: 'レイアウトとテーマ',
    category: '仕上げ',
    description: '画面レイアウトは ⚙ 設定から変えられます（標準/全高ドック/字幕/波形）。テーマの切り替えもここです。',
  },
];

/** 検索語（タイトル・本文の部分一致・大小文字無視）とカテゴリで絞り込む純関数。 */
export function filterHelpTopics(
  topics: HelpTopic[],
  query: string,
  category: HelpCategory | 'all',
): HelpTopic[] {
  const q = query.trim().toLowerCase();
  return topics.filter((t) => {
    if (category !== 'all' && t.category !== category) return false;
    if (q === '') return true;
    return t.title.toLowerCase().includes(q) || t.description.toLowerCase().includes(q);
  });
}

/** 現在の絞り込み結果内で id が指す項目の index（無ければ -1）。 */
export function indexOfTopic(topics: HelpTopic[], id: string | null): number {
  if (id === null) return -1;
  return topics.findIndex((t) => t.id === id);
}

/**
 * 選択中 id が現在の絞り込み結果に含まれていればそのまま、含まれなければ
 * 先頭項目（無ければ null）へフォールバックする、選択解決の純関数。
 */
export function resolveSelection(topics: HelpTopic[], selectedId: string | null): string | null {
  if (selectedId !== null && topics.some((t) => t.id === selectedId)) return selectedId;
  return topics[0]?.id ?? null;
}

/** 前へ（先頭では null＝無効）。 */
export function prevTopicId(topics: HelpTopic[], selectedId: string | null): string | null {
  const i = indexOfTopic(topics, selectedId);
  if (i <= 0) return null;
  return topics[i - 1]?.id ?? null;
}

/** 次へ（末尾では null＝無効）。 */
export function nextTopicId(topics: HelpTopic[], selectedId: string | null): string | null {
  const i = indexOfTopic(topics, selectedId);
  if (i < 0 || i >= topics.length - 1) return null;
  return topics[i + 1]?.id ?? null;
}
