# 出所と利用条件（vendor/cuelume）

- **パッケージ**: cuelume v0.1.0（npm、2026-07-10 公開）
- **作者**: Daniel Belyi
- **リポジトリ**: https://github.com/Danilaa1/cuelume
- **ライセンス**: MIT（同梱の LICENSE 参照）→ **商用利用・改変・再配布OK（著作権表示の保持が条件）**
- **取得方法**: npm レジストリの公式 tarball から dist/ 一式をそのまま保存（2026-07-14）
- **安全確認**: 全330行を精査済み（2026-07-14、Claude）。ネットワーク通信なし・eval なし・依存ゼロ・SSR安全・Web Audio ノードのみ操作。クリーン。

## 使い方の選択肢

1. **npm install cuelume** — 上流の更新に追従したい場合
2. **このフォルダをプロジェクトにコピー**（例: `src/lib/vendor/cuelume/`）— 音レシピを自作拡張したい場合はこちら（RECIPES はモジュール定数のため、カスタム音の追加はフォークが必要）

コピーする場合は LICENSE ファイルも必ず一緒にコピーすること。
