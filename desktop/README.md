# Harness Editor — Mac アプリ

既存のブラウザー版を維持した、独立したElectron起動・配布層です。OSS 0.7 には Mac アプリのソースを含めます。ビルドと動作確認の対象は **Apple Silicon Mac** です。**Windows 版のデスクトップアプリは未検証**で、同梱・動作を保証しません。Windows のブラウザー版も実機確認は未実施です。公開OSSと製品版はそれぞれのチェックアウトからビルドしてください。製品版の同梱素材をOSSへコピーしないでください。

## 開発・ビルド

ルートで `npm ci` を実行済みであること。Macビルド機にはXcode Command Line Toolsとpkg-config（例: `brew install pkgconf`）が必要です。利用者のMacに開発ツールは不要です。

```sh
npm --prefix desktop ci
npm run desktop:dev

# 最初の一度: FFmpeg/x264をソースからビルド（数分）
npm --prefix desktop run build:media
npm run desktop:mac
npm run test:desktop
npm --prefix desktop run smoke
```

出力: `dist/desktop/Harness-Editor-<package.json の版>-mac-arm64-preview.zip`。アプリの実パスは `dist/desktop/latest.json` に記録します。ZIPを解凍して `.app` を起動します。公開候補のビルドはローカル評価用の ad-hoc 署名です。一般配布の前に Developer ID 署名・公証と、開発ツールを持たない別の Mac での確認が必要です。

依存は `desktop/package-lock.json` と `desktop/runtime/package-lock.json` に固定。Node/Chrome/source archivesもSHA-256固定。最初のビルドは取得のためネット接続が必要です。rootのnpm設定や起動コマンドをデスクトップ専用に置き換えません。

## データ・終了

- 初期プロジェクトフォルダー: `~/Documents/Harness Editor/Projects`
- 保存先メニュー: フォルダーを開く、次回起動時のフォルダーを選ぶ、ログを開く
- 設定・ログ・キャッシュ・追加AIツール: ElectronのuserData（通常 `~/Library/Application Support/Harness Editor`）
- 再起動でも同じローカルポートを使い、ブラウザー保存の設定を維持します。競合時は明示エラーにします。
- 終了時は確認ダイアログの後、アプリ専用のサーバーを停止します。先に保存し、書き出し完了を確認してください。
- 外部AI CLI、Python文字起こしのモデル/実行環境は未同梱です。既存機能の個別セットアップが必要です。文字起こしの入口 `scripts/transcribe.py` はアプリへ同梱します。

試験時だけ `HARNESS_DESKTOP_USER_DATA` / `HARNESS_DESKTOP_PROJECT_ROOT` を指定すると実案件・設定から隔離できます。`smoke.mjs` はこの方法で生成動画を取り込み、プレビュー・編集保存・MP4書き出し・再起動・終了後のサーバー停止を確認します。編集中の2109には接続しません。

## 今後の配布・拡張

- Developer ID署名・公証と、開発ツールを持たない別Macでの確認
- Intel Mac対応、自動更新、アプリ内の依存セットアップ案内
- Hyperframes: MP4素材の生成・取り込みから始め、元HTML/パラメーターの保存と再出力へ拡張。初版には同梱していません。
- Remotionは同梱対象から除外しています。

同梱する第三者ライセンスは `THIRD-PARTY.md` を参照してください。
