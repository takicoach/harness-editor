#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"

# I-3: 物理パス（symlink を解決した実体のパス）で持つ。論理 pwd のままだと、
# tools/ 配下かどうかの封じ込め検査（chromium_dest_is_safe）で「health が返す実体パス」と
# 突き合わせたときに、symlink 経由で起動しただけで想定外扱いになって中止してしまう
EDITOR_DIR="$(pwd -P)"
TOOLS_DIR="$EDITOR_DIR/tools"
# 撮影エンジンの導入記録（health / 配置先取得の生出力）。画面には出さず、失敗時にここを案内する（I-4）
CHROMIUM_LOG="$TOOLS_DIR/chromium-setup.log"

# ---- テスト用の環境変数（ふだんの利用では設定しません）----
#   HE_SETUP_SMOKE=1         … 実際には入れず、配布元 URL の疎通だけ確認して終了
#   HE_SETUP_FORCE_STATIC=1  … ffmpeg の検出と Homebrew をとばし、ダウンロード導入を強制
#   HE_SETUP_SKIP_NPM=1      … npm install を実行しない
#   HE_SETUP_SKIP_CHROMIUM=1 … 撮影エンジン（Chromium）の導入をとばす
TEST_MODE="${HE_SETUP_SMOKE:-}${HE_SETUP_FORCE_STATIC:-}${HE_SETUP_SKIP_NPM:-}${HE_SETUP_SKIP_CHROMIUM:-}"

# ffmpeg の静的ビルド（macOS 専用・ffmpeg と ffprobe が 1 つの書庫に入っている）
# 版を上げるときは下の SHA-256 も両方入れ替えること（ダウンロードした書庫の検証に使う）:
#   shasum -a 256 jellyfin-ffmpeg_<版>_portable_macarm64-gpl.tar.xz
FFMPEG_BUILD_VERSION="7.1.4-3"
FFMPEG_SHA256_ARM64="99d689816a41075574928a0b3059101fd454fc58f465c99105a73b5c415ac86d"
FFMPEG_SHA256_X86_64="943f78e94d2760d3925fc0d9cc15f8329b11dbcdae7b0fd0d225b64e5a1aae29"

NODE_DIST_BASE="https://nodejs.org/dist"
NODE_MANUAL_PAGE="https://nodejs.org/ja"

# Node.js の下限。--import の下限20.6に加え、独自プレビューのmp4boxが20.8.1以上を必要とする。
# noble/hashes と package engines に合わせ、major/minor比較の下限を20.19にする。
# 値は toolchainPins.test.ts が現物突合する（下げると赤・package.json の engines とも一致必須）。
NODE_MIN_MAJOR="20"
NODE_MIN_MINOR="19"
NODE_MIN_LABEL="20.19"

# I-2: いま PATH にある node が下限未満かを、その場で `node -v` から判定する（真 = 古い）。
# 版が読めないときは**断定しない**（false を返す）——読めないことは「古い」の証拠ではない。
node_below_min() {
  local raw major minor
  raw="$(node -v 2>/dev/null || echo "")"
  major="$(printf '%s' "$raw" | sed 's/^v\([0-9]*\).*/\1/')"
  minor="$(printf '%s' "$raw" | sed 's/^v[0-9]*\.\([0-9]*\).*/\1/')"
  case "$major$minor" in
    '' | *[!0-9]*) return 1 ;;
  esac
  [ "$major" -lt "$NODE_MIN_MAJOR" ] \
    || { [ "$major" -eq "$NODE_MIN_MAJOR" ] && [ "$minor" -lt "$NODE_MIN_MINOR" ]; }
}

# 撮影エンジン（Chrome for Testing の chrome-headless-shell・テロップ入りの高速書き出しで使う）
# 版は src/server/resolveChromium.ts の CHROME_HEADLESS_SHELL_VERSION と同じ値にすること
# （toolchainPins.test.ts が両者の一致を機械検査する）。
# 版を上げるときは下の SHA-256 も入れ替えること（ダウンロードした書庫の検証に使う）:
#   shasum -a 256 chrome-headless-shell-<platform>.zip
# Windows 用（win64）のハッシュは setup.bat 側が持つ。
#
# I-2: SHA-256 の行末に「どの版のハッシュか」を併記する。版だけ上げてハッシュを据え置く
# 片肺更新を toolchainPins.test.ts が赤で止める（併記が無い場合も赤）。
# I-1: 併記は「貼り忘れ」しか見ない。ハッシュの**取り違え**（別 platform のものを貼った等）は
# 版上げのたびに `HARNESS_VERIFY_CHROMIUM_SHA=1 npx vitest run src/server/toolchainPins.test.ts`
# で配布元の現物と突き合わせて確かめること。
CHROMIUM_VERSION="148.0.7778.96"
CHROMIUM_SHA256_MAC_ARM64="d9014195871a583b0978001a23000aa2cff22e3bb951a92919b7c7775cd14e01" # for 148.0.7778.96
CHROMIUM_SHA256_MAC_X64="1dabfd7b4ecc5759d3fe90dd3e782ae41659f5dc7c756cf403db104e93c918f0" # for 148.0.7778.96
CHROMIUM_BASE="https://storage.googleapis.com/chrome-for-testing-public"
CHROMIUM_MIRROR_BASE="https://cdn.playwright.dev/builds/cft"

# 一時ディレクトリは必ず片付ける（正常終了・途中終了・エラー終了のどれでも）
# M-4: 片付けは工程ごとに分ける（ffmpeg の失敗経路で撮影エンジンの一時物まで消す・
# あるいはその逆、という取り違えが起きないように）。trap は両方まとめて呼ぶ。
FFMPEG_TMP_DIR=""
CHROMIUM_TMP_DIR=""
cleanup_ffmpeg_tmp() {
  if [ -n "$FFMPEG_TMP_DIR" ] && [ -d "$FFMPEG_TMP_DIR" ]; then
    rm -rf "$FFMPEG_TMP_DIR"
  fi
  FFMPEG_TMP_DIR=""
}
cleanup_chromium_tmp() {
  if [ -n "$CHROMIUM_TMP_DIR" ] && [ -d "$CHROMIUM_TMP_DIR" ]; then
    rm -rf "$CHROMIUM_TMP_DIR"
  fi
  CHROMIUM_TMP_DIR=""
}
cleanup_tmp() {
  cleanup_ffmpeg_tmp
  cleanup_chromium_tmp
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

# この Mac が使う「配布物の platform 名」（mac-arm64 / mac-x64）を返す（対応外の CPU は非 0）
# I-5: CPU の判定はこのファイルでは行わない。正本は resolveChromium.ts の
# chromiumDownloadPlatform で、その出力を health スクリプト経由で受け取る
# （tools/ の配置名と同じ表なので、両者がずれて展開先と配置先が食い違うことが起きない）
chromium_platform() {
  local platform
  platform="$(node --import tsx scripts/chromium-health.ts --print-download-platform 2>/dev/null || echo "")"
  if [ -z "$platform" ]; then
    return 1
  fi
  echo "$platform"
}

# M-1: 以下の 3 つは platform を**引数で**受け取る。関数の中で覚えても `$(...)` の
# サブシェルごと捨てられるのでキャッシュにならない（node の起動回数が減らない）。
# 呼ぶ側が 1 回だけ chromium_platform を呼び、その値を配る。

# 第一 URL（Google 公式バケット）
chromium_url() {
  local platform="$1"
  [ -n "$platform" ] || return 1
  echo "$CHROMIUM_BASE/$CHROMIUM_VERSION/$platform/chrome-headless-shell-$platform.zip"
}

# 退避 URL（Playwright の CDN ミラー・中身は同一物でハッシュも一致）
chromium_mirror_url() {
  local platform="$1"
  [ -n "$platform" ] || return 1
  echo "$CHROMIUM_MIRROR_BASE/$CHROMIUM_VERSION/$platform/chrome-headless-shell-$platform.zip"
}

# ハッシュの選択も platform 名で行う（CPU 名での分岐をこのファイルに持たない）
chromium_sha256() {
  local platform="$1"
  case "$platform" in
    mac-arm64) echo "$CHROMIUM_SHA256_MAC_ARM64" ;;
    mac-x64) echo "$CHROMIUM_SHA256_MAC_X64" ;;
    *) return 1 ;;
  esac
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
  # M-1: platform の問い合わせ（node 起動）はここで 1 回だけ
  # M-7: platform は `node --import tsx` 経由で取るので、**npm install 済みの状態が前提**。
  # node_modules が無いと platform が空になり撮影エンジンの 2 行は 000 になる。
  # ここで `uname -m` の簡易判定へフォールバックしない — CPU→platform の対応表は
  # resolveChromium.ts の chromiumDownloadPlatform だけが持つ正本で（I-5）、
  # 疎通確認の都合で shell 側に二つ目の表を作ると版上げのたびにずれる余地を生むため。
  # 代わりに前提を出力へ書く。
  smoke_platform="$(chromium_platform || echo "")"
  if [ -z "$smoke_platform" ]; then
    echo "SMOKE note platform-unavailable（npm install 後に実行すると撮影エンジンの URL も確認できます）"
  fi
  smoke_chromium_url="$(chromium_url "$smoke_platform" || echo "")"
  if [ -n "$smoke_chromium_url" ]; then
    echo "SMOKE chromium $(http_status "$smoke_chromium_url")"
  else
    echo "SMOKE chromium 000"
  fi
  # M-7: 本家が落ちた時に実際に使う退避先も一緒に見る（退避先だけ先に腐るのを見逃さない）
  smoke_chromium_mirror_url="$(chromium_mirror_url "$smoke_platform" || echo "")"
  if [ -n "$smoke_chromium_mirror_url" ]; then
    echo "SMOKE chromium-mirror $(http_status "$smoke_chromium_mirror_url")"
  else
    echo "SMOKE chromium-mirror 000"
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
    cleanup_ffmpeg_tmp
    ffmpeg_manual_hint
    return 1
  fi
  if ! verify_sha256 "$tmp/ffmpeg.tar.xz" "$expected"; then
    cleanup_ffmpeg_tmp
    echo "❌ ダウンロードしたファイルの中身が想定と違いました（通信の失敗か、配布元の更新が考えられます）。"
    ffmpeg_manual_hint
    return 1
  fi
  if ! tar -xJf "$tmp/ffmpeg.tar.xz" -C "$tmp"; then
    cleanup_ffmpeg_tmp
    ffmpeg_manual_hint
    return 1
  fi

  mkdir -p "$TOOLS_DIR"
  for name in ffmpeg ffprobe; do
    src="$(find "$tmp" -type f -name "$name" | head -1)"
    if [ -z "$src" ]; then
      rm -f "$TOOLS_DIR/.ffmpeg.new" "$TOOLS_DIR/.ffprobe.new"
      cleanup_ffmpeg_tmp
      ffmpeg_manual_hint
      return 1
    fi
    cp "$src" "$TOOLS_DIR/.$name.new"
    chmod +x "$TOOLS_DIR/.$name.new"
  done
  cleanup_ffmpeg_tmp

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
        # bash 3.2 は全角の「）」を変数名の一部として食う（`$installed）` が空になる）。
        # 全角括弧に隣接する変数参照は必ず ${...} で閉じること
        echo "✅ ffmpeg を入れました（${installed}）"
        return 0
      fi
    fi
    echo "⚠️ Homebrew での導入がうまくいきませんでした。ダウンロード版を試します。"
  fi
  install_ffmpeg_static
}

# I-4: 撮影エンジン導入の記録（画面には出さず、失敗時にこのファイルを案内する）。
# 「入れられませんでした」だけでは原因を追えないので、health と配置先取得の生出力を残す
# M-9: 記録は実行ごとに世代を分け、1 世代前だけ残す（`.log.1`）。追記だけだと
# 再実行のたびに膨らみ、しかも「今回の実行の記録がどこから始まるか」が読み取りにくい。
CHROMIUM_LOG_ROTATED=""
chromium_log_rotate_once() {
  if [ -n "$CHROMIUM_LOG_ROTATED" ]; then
    return 0
  fi
  CHROMIUM_LOG_ROTATED=1
  if [ -f "$CHROMIUM_LOG" ]; then
    # 失敗しても導入は止めない（記録の都合であって導入の成否ではない）
    mv -f "$CHROMIUM_LOG" "${CHROMIUM_LOG}.1" 2>/dev/null || true
  fi
}

chromium_log_header() {
  mkdir -p "$TOOLS_DIR"
  chromium_log_rotate_once
  printf -- '--- %s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$1" >>"$CHROMIUM_LOG"
}

chromium_log_hint() {
  echo "   詳しい記録: tools/chromium-setup.log"
}

# 撮影エンジンの動作確認（実際に起動して 1×1 の画を 1 枚撮る）
# 検査したい実体は必ず HARNESS_CHROMIUM で明示する。渡さないと開発機に元からある
# 別の実体を見て「OK」になってしまい、いま置いたものの検査にならない
chromium_health() {
  chromium_log_header "health $1"
  HARNESS_CHROMIUM="$1" node --import tsx scripts/chromium-health.ts >>"$CHROMIUM_LOG" 2>&1
}

# M-5: 消す・退避する対象が本当に tools フォルダの中かを確かめる保険。
# $dest は health スクリプトの出力なので通常は必ず tools 配下だが、
# rm -rf / mv の相手なので「想定外なら何もしない」を機械で担保する
# M-6: 前方一致だけだと `<tools>/../..` のように tools 配下から抜け出すパスを通してしまう。
# `..` を含むパスは（正当な用途が無いので）まとめて拒否する
chromium_dest_is_safe() {
  case "$1" in
    *..*)
      echo "❌ 撮影エンジンの配置先に「..」が含まれていました（${1}）。安全のため中止しました。"
      return 1
      ;;
    "$TOOLS_DIR"/*) return 0 ;;
    *)
      echo "❌ 撮影エンジンの配置先が想定外の場所でした（${1}）。安全のため中止しました。"
      return 1
      ;;
  esac
}

# I-3: 起動できない実体をその場に残さない（残すと次回もスキップ判定で引っかかり続ける）。
# 消さずに .broken へ退避して、原因調査とロールバックの余地を残す
# I-2: 退避に失敗したら**そこで止める**。呼び出し側は `|| return 1` で受けるので、
# 「退避したつもりで壊れた実体が残ったまま先へ進み、最後の rm -rf で消してしまう」経路を作らない
retire_broken_chromium() {
  local dest="$1"
  chromium_dest_is_safe "$dest" || return 1
  rm -rf "${dest}.broken" || true
  # 消せたかどうかは戻り値ではなく**残っていないこと**で確かめる
  if [ -e "${dest}.broken" ]; then
    echo "❌ 前に退避した撮影エンジン（${dest}.broken）を片付けられませんでした。"
    echo "   お手数ですが、このフォルダを手で削除してからもう一度実行してください。"
    chromium_log_hint
    return 1
  fi
  if ! mv "$dest" "${dest}.broken"; then
    echo "❌ 起動できない撮影エンジンを退避できませんでした（${dest}）。"
    echo "   壊れた実体はそのまま残してあります。手で削除してからもう一度実行してください。"
    chromium_log_hint
    return 1
  fi
  echo "⚠️ 既にあった撮影エンジンが起動できなかったので退避しました（${dest}.broken）。入れ直します。"
}

# 撮影エンジンをダウンロードして tools フォルダに配置する（install_ffmpeg_static と同型）
# 配置先のパスは health スクリプト（--print-tools-path）だけが知っている
# ＝置き場所の規約をこのファイルに二重に書かない
install_chromium() {
  local dest staged url mirror expected tmp src found err_file unsupported node_stale err_empty platform

  # M-11: 配置先を出せない理由は 2 つあり、利用者の取るべき行動が違う。
  # 「未対応の CPU」はこの撮影エンジンを導入できないが、「部品の導入が未完了」は
  # setup をやり直せば直る。health の stderr（`unsupported-platform:` で始まるか）で分ける
  # I-1: この関数は `install_chromium || CHROMIUM_FAILED=1` で呼ばれる＝関数の中では
  # `set -e` が効かない。副作用を起こす行は 1 つ残らず自分で失敗を見て、❌ を出して return 1 する
  if ! mkdir -p "$TOOLS_DIR"; then
    echo "❌ tools フォルダを作れませんでした（${TOOLS_DIR}）。書き込み権限を確認してください。"
    return 1
  fi
  err_file="$TOOLS_DIR/.chromium-tools-path.err"
  chromium_log_header "--print-tools-path"
  dest="$(node --import tsx scripts/chromium-health.ts --print-tools-path 2>"$err_file" || echo "")"
  cat "$err_file" >>"$CHROMIUM_LOG"
  printf 'dest=%s\n' "$dest" >>"$CHROMIUM_LOG"
  unsupported=""
  node_stale=""
  err_empty=""
  if grep -q '^unsupported-platform:' "$err_file" 2>/dev/null; then
    unsupported=1
  fi
  # I-2: 「Node が古くて `node --import` を解釈できない（20.6 未満）」は、**その signature で**見る。
  # 20.6 未満の Node は未知のオプションとして扱い、stderr に `node: bad option: --import` を出して
  # 終了コード 9 で落ちる（`node --bogus-option` の実出力と同じ形）。ESM 側で弾かれる版は
  # `ERR_UNKNOWN_*` を出す。以前は「stderr が空なら古い」としていたが、それは**別物の推測**で、
  # 空になる原因（node が黙って落ちた等）は他にもある。加えて `node -v` を直接読んで下限と比べる。
  if grep -qi 'bad option: --import\|ERR_UNKNOWN' "$err_file" 2>/dev/null; then
    node_stale=1
  elif node_below_min; then
    node_stale=1
  fi
  if [ ! -s "$err_file" ]; then
    err_empty=1
  fi
  rm -f "$err_file"
  if [ -z "$dest" ]; then
    if [ -n "$unsupported" ]; then
      echo "❌ この Mac の OS/CPU は撮影エンジンに対応していません。"
    elif [ -n "$node_stale" ]; then
      echo "❌ 撮影エンジンの導入準備ができていません（Node.js の版が古い可能性があります）。"
      echo "   ターミナルで node -v を実行し、${NODE_MIN_LABEL} 以上か確認してください。"
      chromium_log_hint
    elif [ -n "$err_empty" ]; then
      # 何も言わずに終わった＝原因が分からない。ここで原因を名指しすると、
      # 利用者は当たらない対処（npm install のやり直し等）を繰り返すことになる
      echo "❌ 撮影エンジンの導入準備ができていません（原因を特定できませんでした）。"
      echo "   下の記録を確認のうえ、setup をもう一度実行してください。"
      chromium_log_hint
    else
      echo "❌ 撮影エンジンの導入準備ができていません（部品の導入が未完了の可能性があります）。"
      echo "   npm install が終わった状態で setup をもう一度実行してください。"
      chromium_log_hint
    fi
    return 1
  fi

  # 同じ版の実体が既にあって、実際に起動できるならそのまま使う
  # （版はパスに含まれるので、古い版のフォルダは残しても混ざらない＝戻せるように消さない）
  if [ -f "$dest/chrome-headless-shell" ]; then
    if chromium_health "$dest/chrome-headless-shell"; then
      echo "✅ 撮影エンジンは導入済みです（${dest}）"
      return 0
    fi
    retire_broken_chromium "$dest" || return 1
  fi

  # M-1: platform の問い合わせ（node 起動）はここで 1 回だけ行い、以降は引数で配る
  platform="$(chromium_platform || echo "")"
  url="$(chromium_url "$platform" || echo "")"
  mirror="$(chromium_mirror_url "$platform" || echo "")"
  expected="$(chromium_sha256 "$platform" || echo "")"
  if [ -z "$url" ] || [ -z "$expected" ]; then
    echo "❌ この Mac 向けの配布物が用意されていません。"
    chromium_log_hint
    return 1
  fi

  echo "==> 撮影エンジンをダウンロードして tools フォルダに入れます（100MB ほど・回線次第で数分）"
  CHROMIUM_TMP_DIR="$(mktemp -d || echo "")"
  if [ -z "$CHROMIUM_TMP_DIR" ] || [ ! -d "$CHROMIUM_TMP_DIR" ]; then
    echo "❌ 作業用の一時フォルダを作れませんでした。"
    chromium_log_hint
    return 1
  fi
  tmp="$CHROMIUM_TMP_DIR"

  # M-12: 100MB の取得は途中で切れやすいので、同じ URL で 2 回まで再試行する。
  # M-7: `-C -` が効くのは**この 1 回の実行の中で**再試行するときだけ（保存先は毎回
  # 新しい一時フォルダなので、前回の setup の落としかけを引き継ぐことはできない）
  if ! curl_https -fL --progress-bar --max-time 1800 --retry 2 --retry-delay 3 -C - -o "$tmp/chromium.zip" "$url"; then
    echo "⚠️ 配布元からダウンロードできませんでした。別の配布元で試します。"
    # 退避先は別サーバなので、途中まで落ちた本家のファイルには継ぎ足さない（先頭から取り直す）
    # 消せなくても次の curl が -o で上書きし、その失敗はすぐ下で捕まえる
    rm -f "$tmp/chromium.zip" || true
    if [ -z "$mirror" ] || ! curl_https -fL --progress-bar --max-time 1800 --retry 2 --retry-delay 3 -o "$tmp/chromium.zip" "$mirror"; then
      cleanup_chromium_tmp
      echo "❌ 撮影エンジンをダウンロードできませんでした。"
      return 1
    fi
  fi
  if ! verify_sha256 "$tmp/chromium.zip" "$expected"; then
    cleanup_chromium_tmp
    echo "❌ ダウンロードしたファイルの中身が想定と違いました（通信の失敗か、配布元の更新が考えられます）。"
    return 1
  fi
  if ! unzip -q "$tmp/chromium.zip" -d "$tmp/unpacked"; then
    cleanup_chromium_tmp
    echo "❌ ダウンロードしたファイルを展開できませんでした。"
    return 1
  fi

  # 書庫の中身のフォルダ名は規約として持たず、実物から拾う。
  # I-4: 先頭 1 件（`-type d | head -1`）ではなく**実体を含むディレクトリ**を選ぶ。
  # 書庫に付随ディレクトリ（`__MACOSX/` 等）が混ざると先頭は列挙順まかせになり、
  # 中身は正しいのに「中身が想定と違いました」で導入に失敗しうる。
  # M-6: 深さを 2 に固定するのは、CfT の zip が「top-level の 1 ディレクトリ／その直下に実体」の
  # 形だから（深さ 2 = そのディレクトリの中の実体）。浅く探すと展開先直下の同名ファイル、
  # 深く探すと付随ディレクトリの中の同名ファイルまで拾い、別物を配置しうる
  found="$(find "$tmp/unpacked" -mindepth 2 -maxdepth 2 -type f -name chrome-headless-shell -print -quit)"
  src="${found%/*}"
  if [ -z "$found" ] || [ ! -f "$src/chrome-headless-shell" ]; then
    cleanup_chromium_tmp
    echo "❌ ダウンロードしたファイルの中身が想定と違いました。"
    return 1
  fi

  # いったん仮の名前で置き、動作確認が済んでから本番の名前へ差し替える（ffmpeg と同じ順序）
  # M-5: rm -rf / mv の相手が tools フォルダの中であることを先に確かめる
  chromium_dest_is_safe "$dest" || { cleanup_chromium_tmp; return 1; }
  staged="${dest}.new"
  rm -rf "$staged" || true
  if [ -e "$staged" ]; then
    cleanup_chromium_tmp
    echo "❌ 前回の作業用フォルダ（${staged}）を片付けられませんでした。手で削除してからやり直してください。"
    chromium_log_hint
    return 1
  fi
  if ! mkdir -p "$(dirname "$dest")"; then
    cleanup_chromium_tmp
    echo "❌ 撮影エンジンの置き場所を作れませんでした（$(dirname "$dest")）。"
    chromium_log_hint
    return 1
  fi
  if ! cp -R "$src" "$staged"; then
    cleanup_chromium_tmp
    rm -rf "$staged" || true
    echo "❌ 撮影エンジンを作業用フォルダへコピーできませんでした（${staged}）。"
    echo "   ディスクの空き容量を確認してから、もう一度実行してください。"
    chromium_log_hint
    return 1
  fi
  cleanup_chromium_tmp
  if ! chmod +x "$staged/chrome-headless-shell"; then
    rm -rf "$staged" || true
    echo "❌ 撮影エンジンに実行の許可を与えられませんでした（${staged}）。"
    chromium_log_hint
    return 1
  fi
  # 実体は ad-hoc 署名（spctl --assess は rejected）。curl での取得に quarantine 属性は
  # 付かず、実測（macOS 26.6.2）では属性を付けても端末からの起動自体は止まらなかったが、
  # Finder / LaunchServices 経由で開かれる経路では Gatekeeper が止めうるため必ず剥がす
  # （属性が無ければ何も起きない・失敗しても続行する）
  xattr -dr com.apple.quarantine "$staged" 2>/dev/null || true

  if ! chromium_health "$staged/chrome-headless-shell"; then
    # ここで消せなくても致命ではない（次回の実行が同じ場所を作り直す前に検査する）
    rm -rf "$staged" || true
    echo "❌ 撮影エンジンを起動できませんでした。"
    chromium_log_hint
    return 1
  fi
  rm -rf "$dest" || true
  if [ -e "$dest" ]; then
    echo "❌ 古い撮影エンジン（${dest}）を片付けられませんでした。入れ替えを中止しました。"
    echo "   新しい実体は ${staged} に置いてあります。手で入れ替えるか、フォルダの権限を直してやり直してください。"
    chromium_log_hint
    return 1
  fi
  if ! mv "$staged" "$dest"; then
    echo "❌ 撮影エンジンを所定の場所へ移せませんでした（${dest}）。"
    echo "   新しい実体は ${staged} に置いてあります。"
    chromium_log_hint
    return 1
  fi
  # 「置いたつもり」で ✅ を出さない。最後に実体の存在を観測してから成功を名乗る
  if [ ! -f "$dest/chrome-headless-shell" ]; then
    echo "❌ 撮影エンジンを配置できたか確認できませんでした（${dest}）。"
    chromium_log_hint
    return 1
  fi
  echo "✅ 撮影エンジンを入れました（${dest}）"
}

node_manual_hint() {
  echo "   $NODE_MANUAL_PAGE から LTS 版（${NODE_MIN_LABEL} 以上）をインストールしてください。"
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
NODE_MINOR=$(node -v | sed 's/^v[0-9]*\.\([0-9]*\).*/\1/')
case "$NODE_MAJOR$NODE_MINOR" in
  '' | *[!0-9]*)
    # バージョンが読み取れないときも「入れ直し」扱いにする（古いまま素通りさせない）
    echo "❌ Node.js のバージョンを確認できませんでした（$(node -v)）。入れ直します。"
    install_node_and_exit
    ;;
esac
# I-1: major だけでなく minor まで見る（20.0〜20.5 では `node --import` が使えない）
if [ "$NODE_MAJOR" -lt "$NODE_MIN_MAJOR" ] \
  || { [ "$NODE_MAJOR" -eq "$NODE_MIN_MAJOR" ] && [ "$NODE_MINOR" -lt "$NODE_MIN_MINOR" ]; }; then
  echo "❌ Node.js のバージョンが古いです（$(node -v)）。${NODE_MIN_LABEL} 以上が必要です。"
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
  # I-1: @resvg/resvg-js（図形オーバーレイの PNG ラスタライズ）はネイティブアドオン。
  # 対応外プラットフォームで prebuild が取れないと導入時点では気づかず、書き出し時に
  # 初めて失敗する可能性があるため、導入時点でも確認する。
  # ここで一度だけ require 可否を確認し、失敗しても致命的にはせず案内だけ出す。
  if ! node -e "require('@resvg/resvg-js')" >/dev/null 2>&1; then
    echo "⚠️ 図形（矢印・線・枠など）の書き出し用ライブラリ（@resvg/resvg-js）の読み込みに失敗しました。"
    echo "   図形を使わない書き出しには影響しません。図形を使う場合は npm install をやり直してください。"
  fi
fi


# ---- 4. 撮影エンジン（テロップ入りの高速書き出しで使う Chromium）----
echo ""
CHROMIUM_FAILED=""
if [ -n "${HE_SETUP_SKIP_CHROMIUM:-}" ]; then
  echo "==> 撮影エンジンの導入はスキップしました（テスト用の設定）"
else
  echo "==> 撮影エンジン（テロップ入りの高速書き出し用）を確認します"
  install_chromium || CHROMIUM_FAILED=1
fi

# Native renderer uses full Chrome, separately from the unchanged legacy shell.
NATIVE_CHROMIUM_FAILED=""
if [ -z "${HE_SETUP_SKIP_CHROMIUM:-}" ]; then
  echo "==> 独自書き出し用ブラウザ（通常版Chrome）を確認します"
  if ! node --import tsx scripts/native-chromium-setup.ts; then
    NATIVE_CHROMIUM_FAILED=1
    echo "⚠️ 独自書き出し用ブラウザを導入できませんでした。書き出しは利用できません。setup を再実行してください。"
  fi
fi

echo ""
if [ -n "$CHROMIUM_FAILED" ]; then
  echo "⚠️ 追加の撮影エンジン（headless shell）を導入できませんでした。この警告ではsetupを中止しません。"
  echo "   独自書き出しには通常版Chromeを使います。利用できるかは、上に表示された通常版Chromeの確認結果をご覧ください。"
  echo "   setup をもう一度実行すると再試行します。"
  echo ""
fi
if [ -n "$NATIVE_CHROMIUM_FAILED" ]; then
  echo "⚠️ セットアップ未完了。独自書き出し用ブラウザを導入できませんでした。setup を再実行してください。"
elif [ -n "$FFMPEG_FAILED" ]; then
  echo "⚠️ セットアップは終わりましたが、ffmpeg だけ入れられませんでした（上の案内を参照）。"
else
  echo "✅ セットアップ完了。"
fi
echo ""
echo "次回からは start.command をダブルクリックでエディタを起動できます。"
echo "起動後は、画面右の AI タブから AI に編集を頼めます（接続は自動）。"
echo ""
wait_enter
if [ -n "$NATIVE_CHROMIUM_FAILED" ]; then exit 1; fi
