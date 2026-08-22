#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"

EDITOR_DIR="$(pwd)"
TOOLS_DIR="$EDITOR_DIR/tools"

# ---- テスト用の環境変数（ふだんの利用では設定しません）----
#   HE_SETUP_SMOKE=1        … 実際には入れず、配布元 URL の疎通だけ確認して終了
#   HE_SETUP_FORCE_STATIC=1 … ffmpeg の検出と Homebrew をとばし、ダウンロード導入を強制
#   HE_SETUP_SKIP_NPM=1     … npm install を実行しない
TEST_MODE="${HE_SETUP_SMOKE:-}${HE_SETUP_FORCE_STATIC:-}${HE_SETUP_SKIP_NPM:-}"

# ffmpeg の静的ビルド（macOS 専用・ffmpeg と ffprobe が 1 つの書庫に入っている）
# 版を上げるときは下の SHA-256 も両方入れ替えること（ダウンロードした書庫の検証に使う）:
#   shasum -a 256 jellyfin-ffmpeg_<版>_portable_macarm64-gpl.tar.xz
FFMPEG_BUILD_VERSION="7.1.4-3"
FFMPEG_SHA256_ARM64="99d689816a41075574928a0b3059101fd454fc58f465c99105a73b5c415ac86d"
FFMPEG_SHA256_X86_64="943f78e94d2760d3925fc0d9cc15f8329b11dbcdae7b0fd0d225b64e5a1aae29"

NODE_DIST_BASE="https://nodejs.org/dist"
NODE_MANUAL_PAGE="https://nodejs.org/ja"

# 一時ディレクトリは必ず片付ける（正常終了・途中終了・エラー終了のどれでも）
FFMPEG_TMP_DIR=""
cleanup_tmp() {
  if [ -n "$FFMPEG_TMP_DIR" ] && [ -d "$FFMPEG_TMP_DIR" ]; then
    rm -rf "$FFMPEG_TMP_DIR"
  fi
  FFMPEG_TMP_DIR=""
}
trap cleanup_tmp EXIT

# ダウンロードは常に https のみ（リダイレクト先も https に限定）
curl_https() {
  curl --proto '=https' --proto-redir '=https' "$@"
}

wait_enter() {
  if [ -n "$TEST_MODE" ]; then
    return 0
  fi
  read -r -p "Enter キーで閉じます" _
}

# ファイルの SHA-256 が期待値と一致するか
verify_sha256() {
  local file="$1" expected="$2" actual
  if [ -z "$expected" ]; then
    return 1
  fi
  actual="$(shasum -a 256 "$file" | cut -d' ' -f1)"
  [ "$actual" = "$expected" ]
}

# この Mac の CPU に対応する「書庫名 と SHA-256」を返す（対応外の CPU は非 0）
# URL とハッシュの選び方はこの関数だけが知っている
ffmpeg_static_target() {
  case "$(uname -m)" in
    arm64) echo "macarm64 $FFMPEG_SHA256_ARM64" ;;
    x86_64) echo "mac64 $FFMPEG_SHA256_X86_64" ;;
    *) return 1 ;;
  esac
}

ffmpeg_static_url() {
  local target variant
  target="$(ffmpeg_static_target)" || return 1
  variant="${target%% *}"
  echo "https://github.com/jellyfin/jellyfin-ffmpeg/releases/download/v${FFMPEG_BUILD_VERSION}/jellyfin-ffmpeg_${FFMPEG_BUILD_VERSION}_portable_${variant}-gpl.tar.xz"
}

ffmpeg_static_sha256() {
  local target
  target="$(ffmpeg_static_target)" || return 1
  echo "${target##* }"
}

# nodejs.org の配布一覧から最新 LTS のバージョン（例: v24.19.0）を取り出す
# 空白や整形の揺れに強くするため、空白を落としてから塊ごとに判定する
node_lts_version() {
  local version=""
  version="$(curl_https -fsSL --max-time 30 "$NODE_DIST_BASE/index.json" 2>/dev/null \
    | tr -d ' \t\r' \
    | tr '{' '\n' \
    | grep -v '"lts":false' \
    | grep -o '"version":"v[0-9][0-9.]*"' \
    | head -1 \
    | grep -o 'v[0-9][0-9.]*')" || true
  case "$version" in
    v[0-9]*) echo "$version" ;;
    *) return 1 ;;
  esac
}

node_installer_url() {
  local version
  version="$(node_lts_version)" || return 1
  echo "$NODE_DIST_BASE/${version}/node-${version}.pkg"
}

# nodejs.org 公式の SHASUMS256.txt から、指定ファイルの期待ハッシュを取り出す
node_expected_sha256() {
  local version="$1" file="$2" line
  line="$(curl_https -fsSL --max-time 60 "$NODE_DIST_BASE/${version}/SHASUMS256.txt" 2>/dev/null \
    | grep -E "^[0-9a-fA-F]{64}[[:space:]]+${file}$" \
    | head -1)" || true
  if [ -z "$line" ]; then
    return 1
  fi
  echo "$line" | cut -d' ' -f1
}

http_status() {
  curl_https -sIL -o /dev/null -w '%{http_code}' --max-time 30 "$1" || echo "000"
}

# ---- 疎通確認だけして終わるモード（開発者向け）----
if [ -n "${HE_SETUP_SMOKE:-}" ]; then
  smoke_node_url="$(node_installer_url || echo "")"
  if [ -n "$smoke_node_url" ]; then
    echo "SMOKE node-installer $(http_status "$smoke_node_url")"
  else
    echo "SMOKE node-installer 000"
  fi
  smoke_ffmpeg_url="$(ffmpeg_static_url || echo "")"
  if [ -n "$smoke_ffmpeg_url" ]; then
    echo "SMOKE ffmpeg-static $(http_status "$smoke_ffmpeg_url")"
  else
    echo "SMOKE ffmpeg-static 000"
  fi
  exit 0
fi

# ffmpeg を探す（resolveFfmpeg.ts と同じ順番: 環境変数 → PATH → 定番の場所 → tools フォルダ）
detect_ffmpeg() {
  local candidate
  if [ -n "${HARNESS_FFMPEG:-}" ] && [ -x "${HARNESS_FFMPEG}" ]; then
    echo "${HARNESS_FFMPEG}"
    return 0
  fi
  if command -v ffmpeg >/dev/null 2>&1; then
    command -v ffmpeg
    return 0
  fi
  for candidate in /usr/local/bin/ffmpeg /opt/homebrew/bin/ffmpeg /usr/bin/ffmpeg /opt/local/bin/ffmpeg \
    "$HOME/.local/bin/ffmpeg" "$HOME/bin/ffmpeg" "$TOOLS_DIR/ffmpeg"; do
    if [ -x "$candidate" ]; then
      echo "$candidate"
      return 0
    fi
  done
  return 1
}

ffmpeg_manual_hint() {
  echo "❌ ffmpeg（動画処理エンジン）を自動で入れられませんでした。"
  echo "   お手数ですが、ターミナルで次のどちらかをお試しください。"
  echo "     ・Homebrew がある場合: brew install ffmpeg"
  echo "     ・無い場合: https://ffmpeg.org/download.html から Mac 版を入れる"
  echo "   ※ ffmpeg が無くても編集画面は開けますが、音声波形・書き出しなど一部の機能が使えません。"
}

# ダウンロードした静的ビルドを tools/ffmpeg・tools/ffprobe に配置する
# 途中で失敗しても中途半端な tools/ を残さないよう、両方の動作確認が済んでから置き換える
install_ffmpeg_static() {
  local url expected tmp src name
  url="$(ffmpeg_static_url || echo "")"
  expected="$(ffmpeg_static_sha256 || echo "")"
  if [ -z "$url" ] || [ -z "$expected" ]; then
    echo "❌ この Mac の CPU（$(uname -m)）向けの配布物が用意されていません。"
    ffmpeg_manual_hint
    return 1
  fi

  echo "==> ffmpeg をダウンロードして tools フォルダに入れます（30MB ほど・回線次第で数十秒）"
  FFMPEG_TMP_DIR="$(mktemp -d)"
  tmp="$FFMPEG_TMP_DIR"

  if ! curl_https -fL --progress-bar --max-time 900 -o "$tmp/ffmpeg.tar.xz" "$url"; then
    cleanup_tmp
    ffmpeg_manual_hint
    return 1
  fi
  if ! verify_sha256 "$tmp/ffmpeg.tar.xz" "$expected"; then
    cleanup_tmp
    echo "❌ ダウンロードしたファイルの中身が想定と違いました（通信の失敗か、配布元の更新が考えられます）。"
    ffmpeg_manual_hint
    return 1
  fi
  if ! tar -xJf "$tmp/ffmpeg.tar.xz" -C "$tmp"; then
    cleanup_tmp
    ffmpeg_manual_hint
    return 1
  fi

  mkdir -p "$TOOLS_DIR"
  for name in ffmpeg ffprobe; do
    src="$(find "$tmp" -type f -name "$name" | head -1)"
    if [ -z "$src" ]; then
      rm -f "$TOOLS_DIR/.ffmpeg.new" "$TOOLS_DIR/.ffprobe.new"
      cleanup_tmp
      ffmpeg_manual_hint
      return 1
    fi
    cp "$src" "$TOOLS_DIR/.$name.new"
    chmod +x "$TOOLS_DIR/.$name.new"
  done
  cleanup_tmp

  # 2 つとも動くことを確かめてから、まとめて本番の名前へ差し替える
  if ! "$TOOLS_DIR/.ffmpeg.new" -version >/dev/null 2>&1 || ! "$TOOLS_DIR/.ffprobe.new" -version >/dev/null 2>&1; then
    rm -f "$TOOLS_DIR/.ffmpeg.new" "$TOOLS_DIR/.ffprobe.new"
    ffmpeg_manual_hint
    return 1
  fi
  mv -f "$TOOLS_DIR/.ffmpeg.new" "$TOOLS_DIR/ffmpeg"
  mv -f "$TOOLS_DIR/.ffprobe.new" "$TOOLS_DIR/ffprobe"
  echo "✅ ffmpeg を入れました（$TOOLS_DIR/ffmpeg）"
}

# Homebrew があればそちらを優先し、無ければダウンロード導入にする
install_ffmpeg() {
  local installed
  if [ -z "${HE_SETUP_FORCE_STATIC:-}" ] && command -v brew >/dev/null 2>&1; then
    echo "==> Homebrew で ffmpeg をインストールします（数分かかります）"
    if brew install ffmpeg; then
      installed="$(detect_ffmpeg || echo "")"
      if [ -n "$installed" ]; then
        echo "✅ ffmpeg を入れました（$installed）"
        return 0
      fi
    fi
    echo "⚠️ Homebrew での導入がうまくいきませんでした。ダウンロード版を試します。"
  fi
  install_ffmpeg_static
}

node_manual_hint() {
  echo "   $NODE_MANUAL_PAGE から LTS 版（20 以上）をインストールしてください。"
  echo "   インストール後、もう一度 setup.command をダブルクリックしてください。"
}

# Node.js が無い/古いときにインストーラを開き、再実行を案内して終了する
install_node_and_exit() {
  local version url file pkg expected
  version="$(node_lts_version || echo "")"
  if [ -z "$version" ]; then
    echo "❌ Node.js の配布情報を取得できませんでした。"
    node_manual_hint
    echo ""
    wait_enter
    exit 1
  fi
  file="node-${version}.pkg"
  url="$NODE_DIST_BASE/${version}/${file}"
  # インストーラ起動中は消せないので、毎回同じ名前に上書きする（増え続けないように）
  pkg="${TMPDIR:-/tmp}/harness-editor-node-lts.pkg"

  echo "==> Node.js のインストーラをダウンロードします（80MB ほど）"
  if ! curl_https -fL --progress-bar --max-time 900 -o "$pkg" "$url"; then
    echo "❌ ダウンロードに失敗しました。"
    node_manual_hint
    echo ""
    wait_enter
    exit 1
  fi

  echo "==> ダウンロードしたファイルを公式の一覧（SHASUMS256.txt）と照合します"
  expected="$(node_expected_sha256 "$version" "$file" || echo "")"
  if [ -z "$expected" ]; then
    rm -f "$pkg"
    echo "❌ 公式の照合用ファイルを取得できなかったため、安全のため中止しました。"
    node_manual_hint
    echo ""
    wait_enter
    exit 1
  fi
  if ! verify_sha256 "$pkg" "$expected"; then
    rm -f "$pkg"
    echo "❌ ダウンロードしたインストーラが公式のものと一致しませんでした。安全のため開きません。"
    node_manual_hint
    echo ""
    wait_enter
    exit 1
  fi

  echo ""
  echo "==> インストーラを開きます。画面の「続ける」を押していってください。"
  open "$pkg" || true
  echo ""
  echo "👉 Node.js のインストールが終わったら、もう一度 setup.command をダブルクリックしてください。"
  echo "   （このウィンドウは閉じて大丈夫です）"
  echo ""
  wait_enter
  exit 0
}

echo "==> Harness Editor のセットアップを開始します"
echo ""

# ---- 1. ffmpeg（動画処理エンジン）----
echo "==> 動画処理エンジン（ffmpeg）を確認します"
FFMPEG_BIN=""
FFMPEG_FAILED=""
if [ -z "${HE_SETUP_FORCE_STATIC:-}" ]; then
  FFMPEG_BIN="$(detect_ffmpeg || echo "")"
fi
if [ -n "$FFMPEG_BIN" ]; then
  echo "✅ ffmpeg OK ($FFMPEG_BIN)"
else
  install_ffmpeg || FFMPEG_FAILED=1
fi
echo ""

# ---- 2. Node.js ----
echo "==> Node.js を確認します"
if ! command -v node >/dev/null 2>&1; then
  echo "❌ Node.js がインストールされていません。自動で入れる準備をします。"
  install_node_and_exit
fi
NODE_MAJOR=$(node -v | sed 's/^v\([0-9]*\).*/\1/')
case "$NODE_MAJOR" in
  '' | *[!0-9]*)
    # バージョンが読み取れないときも「入れ直し」扱いにする（古いまま素通りさせない）
    echo "❌ Node.js のバージョンを確認できませんでした（$(node -v)）。入れ直します。"
    install_node_and_exit
    ;;
esac
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "❌ Node.js のバージョンが古いです（$(node -v)）。20 以上が必要です。"
  install_node_and_exit
fi
echo "✅ Node.js: $(node -v)"
echo ""

# ---- 3. 部品のインストール ----
if [ -n "${HE_SETUP_SKIP_NPM:-}" ]; then
  echo "==> npm install はスキップしました（テスト用の設定）"
else
  echo "==> npm install を実行します（初回は数分かかります）"
  echo ""
  npm install
fi

echo ""
if [ -n "$FFMPEG_FAILED" ]; then
  echo "⚠️ セットアップは終わりましたが、ffmpeg だけ入れられませんでした（上の案内を参照）。"
else
  echo "✅ セットアップ完了。"
fi
echo ""
echo "次回からは start.command をダブルクリックでエディタを起動できます。"
echo "起動後は、画面右の AI タブから AI に編集を頼めます（接続は自動）。"
echo ""
wait_enter
