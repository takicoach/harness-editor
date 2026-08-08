#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"
echo "==> Harness Editor のセットアップを開始します"
echo ""
if ! command -v node >/dev/null 2>&1; then
  echo "❌ Node.js がインストールされていません。"
  echo "   https://nodejs.org/ から LTS 版（20 以上）をインストールしてください。"
  echo ""
  read -r -p "Enter キーで閉じます" _
  exit 1
fi
NODE_MAJOR=$(node -v | sed 's/^v\([0-9]*\).*/\1/')
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "❌ Node.js のバージョンが古いです（$(node -v)）。"
  echo "   20 以上が必要です。https://nodejs.org/ から最新の LTS をインストールしてください。"
  echo ""
  read -r -p "Enter キーで閉じます" _
  exit 1
fi
echo "==> Node.js: $(node -v)"
echo "==> npm install を実行します（初回は数分かかります）"
echo ""
npm install
echo ""
echo "✅ セットアップ完了。"
echo ""
echo "次回からは start.command をダブルクリックでエディタを起動できます。"
echo "Claude Code でプロジェクトを作っている横で、エディタも開いておくと便利です。"
echo ""
read -r -p "Enter キーで閉じます" _
