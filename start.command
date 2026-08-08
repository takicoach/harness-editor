#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"
# 動画プロジェクトが並ぶ親フォルダ。別の場所を使いたければ書き換える。
# 新変数 → 旧変数（SME_PROJECT_ROOT・後方互換）→ 既定値（このフォルダ内の projects/）の順で解決する
export HARNESS_PROJECT_ROOT="${HARNESS_PROJECT_ROOT:-${SME_PROJECT_ROOT:-$PWD/projects}}"
mkdir -p "$HARNESS_PROJECT_ROOT"
# 課金ガード: ANTHROPIC_API_KEY があると Claude Code がサブスクでなく API 課金に切り替わる。
if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
  echo "⚠ ANTHROPIC_API_KEY が設定されています。" >&2
  echo "  Claude Code がサブスクではなく API レート課金に切り替わるため、ブリッジ常駐は危険です。" >&2
  echo "  解除してから常駐してください（このシェルで: unset ANTHROPIC_API_KEY）。" >&2
fi
echo "    画面から Claude に指示するには docs/claude-bridge-loop.md を参照（MCP 接続 + /loop 常駐）。"
echo "==> Harness Editor を起動します"
echo "    プロジェクト置き場: $HARNESS_PROJECT_ROOT"
echo "    ブラウザが自動で開きます。このウィンドウは閉じないでください"
echo "    （閉じるとエディタも止まります）。"
echo "    終了するには Ctrl+C を 2 回押すか、このウィンドウを閉じてください。"
echo ""
npm start
