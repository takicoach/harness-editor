/**
 * 初回チュートリアル「はじめての1本」のステップ定義（純データ）。
 * 進行ロジックは tutorialMachine.ts、描画は TutorialOverlay.tsx が担う。
 */

/** ステップの表示・前進判定に使う実状態のスナップショット。 */
export interface TutorialCtx {
  /** ホーム（プロジェクト未選択）表示中か。 */
  home: boolean;
  /** プロジェクトが1件以上あるか。 */
  hasProjects: boolean;
  /** エディタが開いて編集セッションがあるか。 */
  editorReady: boolean;
  /** 現在のテロップ数（追加検知用）。 */
  telopCount: number;
  /** 未保存の編集があるか。 */
  dirty: boolean;
  /** DOM に要素があるか（作成ダイアログなど、コンポーネント外状態の検知用）。 */
  domHas: (selector: string) => boolean;
}

/** ステップ入場時に控える基準値（「増えた/減った」の判定用）。 */
export interface TutorialSnapshot {
  telopCount: number;
  dirty: boolean;
}

/** 吹き出しの補助ボタン（welcome の「あとで」など）。 */
export interface TutorialSecondary {
  label: string;
  action: 'skip' | 'close';
}

export interface TutorialStep {
  id: string;
  /** 照準セレクタ。null=画面中央。関数なら ctx で動的解決（作成ボタン⇄ダイアログ等）。 */
  target: string | null | ((ctx: TutorialCtx) => string | null);
  /** 吹き出し本文。\n で改行。 */
  text: string | ((ctx: TutorialCtx) => string);
  /** このステップを表示する条件。省略時は常に表示。 */
  when?: (ctx: TutorialCtx) => boolean;
  /** 自動前進の条件（実操作の完了検知）。 */
  advanceWhen?: (ctx: TutorialCtx, snapshot: TutorialSnapshot) => boolean;
  /** 「次へ」ボタンを出すか。既定 true（自動前進のみのステップは false にする）。 */
  nextButton?: boolean;
  /** 「次へ」のラベル上書き（はじめる/おわる等）。 */
  nextLabel?: string;
  /** 補助ボタン。省略時は「スキップ」。null で非表示。 */
  secondary?: TutorialSecondary | null;
  /** 特殊ボディ。mcp=接続案内、party=紙吹雪のお祝い。 */
  body?: 'mcp' | 'party';
  /**
   * 吹き出しの配置。'above' は照準の上に固定する
   * （＋追加のようにドロップダウンが下へ開くステップで、メニューと吹き出しの重なりを避ける）。
   */
  placement?: 'auto' | 'above';
  /**
   * 機能世代タグ（例 '2026-08'）。現行世代（featureSeen.ts の CURRENT_FEATURE_GENERATION）と
   * 一致するステップには、初めて表示した回だけ吹き出しに NEW バッジが出る。
   */
  addedIn?: string;
}

export const TUTORIAL_DONE_KEY = 'sme-tutorial-done';

export const TUTORIAL_STEPS: TutorialStep[] = [
  {
    id: 'welcome',
    target: null,
    text: 'Harness Editor へようこそ！\n5分で最初の1本を作れるように、順番にご案内します。',
    nextLabel: 'はじめる',
    secondary: { label: 'あとで', action: 'close' },
  },
  {
    id: 'home-intro',
    when: (c) => c.home,
    target: (c) => (c.hasProjects ? '.home-grid' : '.home'),
    text: (c) =>
      c.hasProjects
        ? 'これがホーム画面です。作った動画がここに並びます。ここに動画が追加されましたね。'
        : 'これがホーム画面です。作った動画がここに並んでいきます。',
  },
  {
    id: 'mcp',
    when: (c) => c.home,
    target: null,
    body: 'mcp',
    text:
      'このエディタは AI 動画編集に対応しています。\n' +
      '編集画面の「AI」タブを開くと、その場で Claude が立ち上がり（初回のみ導入とログインが必要）、' +
      '「ここをカットして」など何でも頼めるようになります。設定ファイルを書く必要はありません。',
  },
  {
    id: 'board',
    addedIn: '2026-08',
    when: (c) => c.home && c.hasProjects,
    target: '.home-view-switch',
    text:
      'ここを「進行ボード」に切り替えると、動画ごとの進み具合を「未着手→文字起こし→カット→テロップ→SE/BGM→書き出し済」の\n' +
      '6つの工程列で見られますよ。カードをドラッグして別の列へ動かすとその工程に固定できます（各カードには工程の進み具合も出ます）。',
  },
  {
    id: 'create',
    addedIn: '2026-08',
    when: (c) => c.home,
    target: (c) => (c.domHas('.home-create-dialog') ? '.home-create-dialog' : '.home-create-btn'),
    text: (c) =>
      c.domHas('.home-create-dialog')
        ? '動画を選んで、プロジェクト名を付けたら「作成」。取り込みには少し時間がかかることがあります。'
        : 'はじめの1本を作ってみましょう。「＋ 動画を作成する」を押すか、動画ファイルをこの画面にドラッグ＆ドロップしてください。',
    advanceWhen: (c) => c.editorReady,
    nextButton: false,
  },
  {
    id: 'editor-left',
    addedIn: '2026-08',
    when: (c) => c.editorReady,
    target: '.lc',
    text:
      'こちらが編集画面です。左の「素材」タブから効果音・画像・BGM・サブ動画を追加できます。Finder からのドラッグ＆ドロップでも OK。\n' +
      'いらなくなった素材は、マウスを乗せると出るゴミ箱アイコンからゴミ箱へ（あとで復元できます）。',
  },
  {
    id: 'ai-tab',
    when: (c) => c.editorReady,
    target: '.rightdock-tab[data-tab="ai"]',
    text:
      'この「AI」タブから、接続した AI エージェントに「ここをカットして」「テロップを赤に」など編集を頼めます。\n' +
      'やりたいことがあったら、まず何でも聞いてみてね。',
  },
  {
    id: 'timeline',
    when: (c) => c.editorReady,
    target: '.tl',
    text:
      '下がタイムラインです。いちばん上の目盛りに重なる高さに「◇」が並んでいます——これがシーン転換で、動画の先頭と末尾には最初から出ています。\n' +
      'カットするとその切れ目にも ◇ が増えます。クリックすると右が「シーン転換設定」に変わって、フェードやクロスフェードを選べますよ。',
  },
  {
    id: 'add-button',
    when: (c) => c.editorReady,
    target: '.tl-add-menu-btn',
    text: '【ここ重要】字幕・テロップ・効果音・画像・BGM・サブ動画——何かを足したいときは、ぜんぶこの「＋ 追加」からです。迷ったらココ！',
    placement: 'above',
  },
  {
    id: 'telop-try',
    when: (c) => c.editorReady,
    target: '.tl-add-menu-btn',
    text: 'ためしにテロップを1つ追加してみましょう。「＋ 追加」を押して、メニューから「テロップ」を選んでください。',
    advanceWhen: (c, snap) => c.telopCount > snap.telopCount,
    nextButton: false,
    placement: 'above',
  },
  {
    id: 'telop-done',
    when: (c) => c.editorReady,
    target: null,
    body: 'party',
    text: 'テロップが追加されました！（パチパチ）\n右の設定パネルで、文言の書き換えやスタイルの変更ができます。',
  },
  {
    id: 'save',
    when: (c) => c.editorReady,
    target: '.tb-save',
    text: (c) =>
      c.dirty
        ? 'この「保存」を押すと、ここまでの編集が保存されます（⌘S でも OK）。押してみましょう。'
        : 'この「保存」で、編集がプロジェクトに保存されます（⌘S でも OK）。',
    advanceWhen: (c, snap) => snap.dirty && !c.dirty,
  },
  {
    id: 'render',
    when: (c) => c.editorReady,
    target: '.tb-render',
    text:
      '編集が終わったら、この「書き出し」で動画ファイルにします。\n' +
      '押すと投稿先に合わせたプリセット（投稿用／標準／軽量・確認用）を選べて、自動保存してからレンダリングが始まります。完成したら「Finderで表示」ですぐ確認できますよ。',
  },
  {
    id: 'layout',
    when: (c) => c.editorReady,
    target: '.tb-settings-btn',
    text: '画面レイアウトはこの ⚙ 設定から変えられます（標準/全高/字幕/波形）。ダッキング・自動保存・テーマの切り替えもここです。',
  },
  {
    id: 'finish',
    target: null,
    text: (c) =>
      c.editorReady
        ? 'これで準備完了です！ あとは作るだけ。\nわからないことがあったら、AI タブから何でも聞いてみてね 🎬'
        : 'チュートリアルはここまで！\n動画が用意できたら、⚙ 設定の「チュートリアル図鑑」からいつでも見返せますよ 🎬',
    nextLabel: 'おわる',
    secondary: null,
  },
];
