#!/usr/bin/env bash
#
# プレビュー用の軽量プロキシ動画を生成する。
#
# Harness Editor のプレビューは public/main.preview.mp4 があればそれを優先して再生する
# （src/server/previewProxy.ts）。重い HEVC（縦 1080×1920・60fps など）を直接ブラウザで
# デコードするとメモリを大量に消費しタブが落ちることがあるため、H.264・半解像度の軽い
# プロキシに置き換えてプレビュー負荷を下げる。最終書き出しは元動画（public/main.mp4）を
# 使うため、プロキシは画質に一切影響しない。
#
# 使い方:
#   scripts/make-preview-proxy.sh <プロジェクトのパス> [元動画ファイル名]
# 例:
#   scripts/make-preview-proxy.sh ~/Marketing/VideoEditing/2026-04-30-golf-drills
#   scripts/make-preview-proxy.sh ./my-project clip.mp4
#
set -euo pipefail

PROJECT_DIR="${1:?プロジェクトのパスを指定してください（例: ~/Marketing/VideoEditing/2026-04-30-golf-drills）}"
SRC_NAME="${2:-main.mp4}"

PUBLIC_DIR="$PROJECT_DIR/public"
SRC="$PUBLIC_DIR/$SRC_NAME"
# 拡張子を除いたベース名 + .preview.mp4（previewProxyName と同じ規約）
BASE="${SRC_NAME%.*}"
OUT="$PUBLIC_DIR/$BASE.preview.mp4"

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "エラー: ffmpeg が見つかりません。" >&2
  exit 1
fi
if [ ! -f "$SRC" ]; then
  echo "エラー: 元動画が見つかりません: $SRC" >&2
  exit 1
fi

echo "==> プレビュープロキシを生成します"
echo "    元:     $SRC"
echo "    出力:   $OUT  (H.264 / 横540px / 音声 aac)"

# scale=540:-2 = 横540px・縦はアスペクト比維持（偶数へ丸め）。
# H.264 8bit はどの環境でもハードウェアデコードできるためプレビューが軽い。
ffmpeg -y -i "$SRC" \
  -vf "scale=540:-2" \
  -c:v libx264 -preset veryfast -crf 23 -pix_fmt yuv420p \
  -c:a aac -b:a 128k \
  -movflags +faststart \
  "$OUT"

echo "==> 完了: $OUT"
ls -lh "$OUT" | awk '{print "    サイズ:", $5}'
echo "    エディタを開き直すと、プレビューがこの軽量プロキシで再生されます。"
