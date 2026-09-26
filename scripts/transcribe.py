#!/usr/bin/env python3
"""Harness Editor: 再 transcribe スクリプト。

mlx-whisper / openai-whisper のうちインストール済みを自動判別して
transcribe を実行し、進捗を stdout に JSON Lines で出力する。

使い方:
    python3 transcribe.py --video <path/main.mp4> --out <path/transcript.json>
                          [--params <path/transcribe_params.json>]
                          [--mock-backend]
"""
import argparse
import json
import os
import sys
import time


def emit(event: dict) -> None:
    """1 イベント = 1 JSON Lines 行。即時 flush でサーバへ届ける。"""
    sys.stdout.write(json.dumps(event, ensure_ascii=False) + "\n")
    sys.stdout.flush()


DEFAULT_PARAMS = {
    "language": "ja",
    "condition_on_previous_text": False,
    "temperature": 0.0,
    "compression_ratio_threshold": 2.4,
    "logprob_threshold": -1.0,
    "no_speech_threshold": 0.45,
    "word_timestamps": True,
    "initial_prompt": (
        "ゴルフレッスンの解説動画です。"
        "ドリル名: ゆる素振り、零式、壱の型、弐の型、フォロービタ止め、"
        "スプリットハンド、クロスハンド、クッション投げ。"
        "専門用語: スイング、テークバック、ハンドファースト、クラブ、重心、"
        "加速ポイント、当て感、脱力。"
    ),
}


def load_params(path: str | None) -> dict:
    """params ファイルを読み、デフォルトとマージして返す。"""
    if path:
        try:
            with open(path, "r", encoding="utf-8") as f:
                user = json.load(f)
            if not isinstance(user, dict):
                raise ValueError("params は object である必要があります")
        except Exception as e:
            emit({"phase": "failed",
                  "error": {"code": "params-invalid", "message": f"params ファイルが読めません: {e}"}})
            sys.exit(1)
    else:
        user = {}
    return {**DEFAULT_PARAMS, **user}


def run_mock(out_path: str) -> int:
    """テスト用の固定出力。SME_TRANSCRIBE_MOCK_DELAY_MS でスリープを入れて
    キャンセルテストを可能にする（env 未設定なら 0 = 即時完了）。"""
    delay_ms = int(os.environ.get("SME_TRANSCRIBE_MOCK_DELAY_MS", "0"))
    emit({"phase": "loading-model"})
    if delay_ms:
        time.sleep(delay_ms / 1000 / 2)
    emit({"phase": "analyzing", "percent": 50})
    if delay_ms:
        time.sleep(delay_ms / 1000 / 2)
    emit({"phase": "writing"})
    payload = {
        "engine": "mock",
        "language": "ja",
        "duration_ms": 116000,
        "words": [
            {"text": "ゆる", "start": 500, "end": 800, "confidence": 0.9},
            {"text": "素振り", "start": 800, "end": 1200, "confidence": 0.9},
        ],
        "segments": [
            {"text": "ゆる素振り", "start": 500, "end": 1200},
        ],
    }
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    emit({"phase": "completed"})
    return 0


def detect_backend() -> str | None:
    """利用可能な whisper backend 名を返す（mlx-whisper > openai-whisper の順）。

    import は ImportError 以外（壊れた依存・ネイティブ拡張のロード失敗等）でも
    失敗しうるので Exception を広く捕捉して次の backend へフォールバックする。
    resolvePython.ts の probe（実 import で判定）と挙動を揃える。
    """
    try:
        import mlx_whisper  # noqa: F401
        return "mlx-whisper"
    except Exception:
        pass
    try:
        import whisper  # noqa: F401
        return "openai-whisper"
    except Exception:
        pass
    return None


def run_mlx(video: str, out_path: str, params: dict) -> int:
    import mlx_whisper

    emit({"phase": "loading-model"})
    # mlx-whisper は path_or_hf_repo で URL/ローカルパスを直指定
    model = params.pop("model", None) or "mlx-community/whisper-large-v3-mlx"

    emit({"phase": "analyzing"})
    result = mlx_whisper.transcribe(video, path_or_hf_repo=model, **params)

    emit({"phase": "writing"})
    write_transcript(out_path, result, engine="mlx-whisper")
    emit({"phase": "completed"})
    return 0


def run_openai(video: str, out_path: str, params: dict) -> int:
    import whisper

    emit({"phase": "loading-model"})
    model_name = params.pop("model", None) or "large-v3"
    model = whisper.load_model(model_name)

    emit({"phase": "analyzing"})
    # openai-whisper は initial_prompt が日本語の場合 fp16 警告が出るが結果に影響なし
    result = model.transcribe(video, **params)

    emit({"phase": "writing"})
    write_transcript(out_path, result, engine="openai-whisper")
    emit({"phase": "completed"})
    return 0


def write_transcript(out_path: str, result: dict, engine: str) -> None:
    """mlx / openai 両方の result を Harness Editor が読める形へ整形して保存。

    両 backend の result は { text, language, segments: [{ start, end, text, words: [...] }] } 形式。
    Harness Editor は transcript.json をトップレベル `words` / `segments` 配列で読む。
    """
    segments_in = result.get("segments", [])
    words_out = []
    segments_out = []
    for seg in segments_in:
        # 時刻は秒 → ms 変換
        s_start = int(round(float(seg.get("start", 0)) * 1000))
        s_end = int(round(float(seg.get("end", 0)) * 1000))
        segments_out.append({
            "text": seg.get("text", "").strip(),
            "start": s_start,
            "end": s_end,
        })
        for w in seg.get("words", []) or []:
            # mlx: { word, start, end, probability }
            # openai: { word, start, end, probability }（同形式）
            text = (w.get("word") or w.get("text") or "").strip()
            if text == "":
                continue
            words_out.append({
                "text": text,
                "start": int(round(float(w.get("start", 0)) * 1000)),
                "end": int(round(float(w.get("end", 0)) * 1000)),
                "confidence": float(w.get("probability", 0.0)),
            })

    duration_ms = segments_out[-1]["end"] if segments_out else 0
    payload = {
        "engine": engine,
        "language": result.get("language", "ja"),
        "duration_ms": duration_ms,
        "text": result.get("text", "").strip(),
        "words": words_out,
        "segments": segments_out,
    }
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--video", required=False)
    ap.add_argument("--out", required=False)
    ap.add_argument("--params", required=False)
    ap.add_argument("--mock-backend", action="store_true")
    ap.add_argument("--detect-backend", action="store_true",
                    help="利用可能 backend を 1 行出力して exit する（テスト・診断用）")
    args = ap.parse_args()

    if args.detect_backend:
        backend = detect_backend()
        if backend is None:
            emit({"phase": "failed",
                  "error": {"code": "no-whisper-backend",
                            "message": "mlx-whisper も openai-whisper も import できません"}})
            return 1
        sys.stdout.write(backend + "\n")
        sys.stdout.flush()
        return 0

    if not args.video or not args.out:
        emit({"phase": "failed", "error": {"code": "video-not-found", "message": "--video と --out が必要です"}})
        return 1

    if args.mock_backend:
        return run_mock(args.out)

    backend = detect_backend()
    if backend is None:
        emit({"phase": "failed",
              "error": {"code": "no-whisper-backend",
                        "message": "mlx-whisper も openai-whisper も import できません"}})
        return 1

    params = load_params(args.params)

    # サブプロセスの未捕捉例外は failed イベントに変換して exit 1
    try:
        if backend == "mlx-whisper":
            return run_mlx(args.video, args.out, params)
        else:
            return run_openai(args.video, args.out, params)
    except FileNotFoundError as e:
        emit({"phase": "failed", "error": {"code": "video-not-found", "message": str(e)}})
        return 1
    except Exception as e:
        emit({"phase": "failed", "error": {"code": "unknown", "message": f"{type(e).__name__}: {e}"}})
        return 1


if __name__ == "__main__":
    sys.exit(main())
