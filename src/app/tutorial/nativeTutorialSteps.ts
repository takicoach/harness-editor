/**
 * 新画面（native）の初回チュートリアルの手順表（純データ）。旧画面の tutorialSteps.ts とは別物。
 * 進行は nativeTutorialFlow.ts と useNativeTutorial.ts、描画は TutorialOverlay.tsx。
 * 文面は helpTopics.ts（新画面向け）と画面上の実際の表示名に揃える。
 */
import type { TutorialStep } from './tutorialSteps';

/** その手順を出す画面。any はホームでも編集画面でも出す。 */
export type NativeStepScene = 'home' | 'edit' | 'any';

/** 手順に入るときに整える画面状態。NativeWorkspace が既存の入力確定処理を通して整える。 */
export interface NativeStepPrep {
  mode?: 'edit';
  left?: 'materials';
  right?: true;
}

export interface NativeTutorialStep extends TutorialStep {
  scene: NativeStepScene;
  /** 作品が1件以上あるときだけ出す（進行ボード）。 */
  requiresProjects?: boolean;
  /** 体験で本人が追加したテロップの記録があるときだけ出す（telop-done）。 */
  requiresRecord?: boolean;
  prep?: NativeStepPrep;
  /** 本人の追加成功で自動前進する体験手順。 */
  experience?: 'telop';
}

/** data-tutorial の目印から照準セレクタを作る。 */
export const tutorialTarget = (name: string): string => `[data-tutorial="${name}"]`;

export const NATIVE_UNAVAILABLE_TEXT = 'この部品は今の画面では表示されていません';
export const NATIVE_WAITING_TEXT = '読み込み中…';
export const NATIVE_CREATE_BAND_TEXT = '名前を確かめて「作成」を押してください。取り込みが終わると編集画面が開きます。';

const EDIT_MODE: NativeStepPrep = { mode: 'edit' };
const AUTO_SAVE_NOTE = '\n隣の「自動保存」をオンにすると、手が止まったときに自動で保存されます。';

export const NATIVE_TUTORIAL_STEPS: NativeTutorialStep[] = [
  {
    id: 'welcome',
    scene: 'any',
    target: null,
    text: 'Harness Editor へようこそ！\n5分で最初の1本を作れるように、順番にご案内します。\n手元に動画ファイルを1本用意しておいてください。音声（ポッドキャスト）や画像からも作れます。',
    nextLabel: 'はじめる',
    secondary: { label: 'あとで', action: 'close' },
  },
  {
    id: 'home-intro',
    scene: 'home',
    target: (c) => (c.hasProjects && c.domHas(tutorialTarget('home-grid')) ? tutorialTarget('home-grid') : tutorialTarget('home')),
    text: (c) =>
      c.hasProjects
        ? 'これがホーム画面です。作った動画がここに並びます。動画を選ぶと、すぐ編集画面が開きます。'
        : 'これがホーム画面です。作った動画がここに並んでいきます。',
  },
  {
    id: 'board',
    scene: 'home',
    requiresProjects: true,
    target: tutorialTarget('home-view-switch'),
    text: 'ここを「進行ボード」に切り替えると、動画ごとの進み具合をボードで見られます。\nカードをドラッグして別の列へ動かすと、その状態に固定できます。',
  },
  {
    id: 'create',
    scene: 'home',
    target: tutorialTarget('home-create'),
    text: 'はじめの1本を作ってみましょう。「＋ 動画を作成する」を押して動画ファイルを選ぶか、動画ファイルをこの画面にドラッグ＆ドロップしてください。音声（ポッドキャスト）や画像からも作れます。',
    nextButton: false,
  },
  {
    id: 'modes',
    scene: 'edit',
    prep: EDIT_MODE,
    target: tutorialTarget('modes'),
    text: 'こちらが編集画面です。上の「確認」「編集」「仕上げ」で作業の段階を切り替えます。\nこの案内は「編集」のまま進めます。',
  },
  {
    id: 'materials',
    scene: 'edit',
    prep: { mode: 'edit', left: 'materials' },
    target: tutorialTarget('materials'),
    text: '左パネルの「素材」には、動画・画像・BGM・効果音が種類別に並びます。\n取り込んだ素材は「再生位置に置く」かダブルクリックで配置します。Finder からのドラッグ＆ドロップでも OK。',
  },
  {
    id: 'ai-panel',
    scene: 'edit',
    prep: { mode: 'edit', right: true },
    target: tutorialTarget('ai-panel'),
    text: '右パネル上部の「AI で編集する」から、接続した AI に「ここをカットして」「テロップを赤に」など編集を頼めます。\nやりたいことがあったら、まず何でも聞いてみてね。',
  },
  {
    id: 'ai-work',
    scene: 'edit',
    target: tutorialTarget('ai-work'),
    text: '画面上部の「AIの作業」では、この動画に対する AI の処理状況や変更案を確認できます。',
  },
  {
    id: 'timeline',
    scene: 'edit',
    prep: EDIT_MODE,
    target: tutorialTarget('timeline'),
    text: '下の「シーケンス」がタイムラインです。「選択」でクリップを動かし、「分割」で切れ目を入れ、「なぞってカット」で取り除く範囲を選びます。',
  },
  {
    id: 'add-button',
    scene: 'edit',
    prep: EDIT_MODE,
    target: tutorialTarget('add-telop'),
    text: '【ここ重要】プレビュー横の道具列から、テロップ・タイトル・図形・画像・BGM・効果音を足せます。\nいま光っているのが「＋ テロップ」です。ボタンはアイコンだけなので、マウスを乗せると名前が出ます。',
  },
  {
    id: 'telop-try',
    scene: 'edit',
    prep: EDIT_MODE,
    experience: 'telop',
    target: tutorialTarget('add-telop'),
    text: 'ためしにテロップを1つ追加してみましょう。光っている「＋ テロップ」を押してください。\nこの動画に実際に追加されます。あとで取り除けます。',
    nextButton: false,
  },
  {
    id: 'telop-done',
    scene: 'edit',
    requiresRecord: true,
    target: null,
    body: 'party',
    text: 'テロップが追加されました！（パチパチ）\n右の「調整」で文言やスタイルを変えられます。\n練習のテロップは「残す」か「取り除く」を選んでください。取り除くのはこの1件だけで、ほかの編集はそのまま残ります。',
    nextLabel: '残す',
    secondary: { label: '取り除く', action: 'skip' },
  },
  {
    id: 'save',
    scene: 'edit',
    target: tutorialTarget('save'),
    text: (c) =>
      (c.dirty
        ? 'この「保存」を押すと、ここまでの編集が保存されます（⌘S でも OK）。押してみましょう。'
        : 'この「保存」で、編集がプロジェクトに保存されます（⌘S でも OK）。') + AUTO_SAVE_NOTE,
    advanceWhen: (c, snap) => snap.dirty && !c.dirty,
  },
  {
    id: 'render',
    scene: 'edit',
    target: tutorialTarget('export'),
    text: '編集が終わったら、この「書き出し」で動画ファイルにします。\n投稿先に合わせたプリセットを選べて、完成したら「動画を保存」から受け取れます。',
  },
  {
    id: 'help',
    scene: 'edit',
    target: tutorialTarget('help'),
    text: '分からなくなったら、この「？」を押してください。使い方の一覧が開きます。\nこの案内も、そこの「もう一度最初から見る」からいつでも見返せます。',
  },
  {
    id: 'finish',
    scene: 'any',
    target: null,
    text: (c) =>
      c.editorReady
        ? 'これで準備完了です！ あとは作るだけ。\n分からないことがあったら、右上の「？」からいつでも確かめられます 🎬'
        : 'チュートリアルはここまで！\n動画が用意できたら、右上の「？」→「もう一度最初から見る」からいつでも見返せますよ 🎬',
    nextLabel: 'おわる',
    secondary: null,
  },
];
