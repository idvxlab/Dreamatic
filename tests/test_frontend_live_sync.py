from pathlib import Path


INDEX_HTML = Path(__file__).resolve().parents[1] / "static" / "index.html"


def test_running_session_polling_reconciles_even_with_open_websocket():
    html = INDEX_HTML.read_text(encoding="utf-8")

    assert "pollTimer = setInterval(triggerPoll, 800)" in html
    assert "startPolling(3000);" in html
    assert 'frame.type === "message"' in html
    assert "Every completed message must reconcile" in html


def test_stale_session_responses_and_websockets_are_ignored():
    html = INDEX_HTML.read_text(encoding="utf-8")

    assert "const polledSessionId = currentSessionId" in html
    assert "if (polledSessionId !== currentSessionId) return" in html
    assert "if (ws !== socket || currentSessionId !== sessionId) return" in html
