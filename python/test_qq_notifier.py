"""Unit tests for qq_notifier; run with:

    python -m unittest discover -s python -p "test_*.py"
"""

import unittest

from qq_notifier import MAX_TEXT_BYTES, QQNotifier, QQNotifierError


class FakeResponse:
    def __init__(self, status_code, payload=None, text=""):
        self.status_code = status_code
        self._payload = payload
        self.text = text

    def json(self):
        if self._payload is None:
            raise ValueError("no JSON body")
        return self._payload


class FakeSession:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []
        self.closed = False

    def post(self, url, **kwargs):
        self.calls.append(("POST", url, kwargs))
        return self.responses.pop(0)

    def get(self, url, **kwargs):
        self.calls.append(("GET", url, kwargs))
        return self.responses.pop(0)

    def close(self):
        self.closed = True


def client(responses, token=None):
    session = FakeSession(responses)
    notifier = QQNotifier("192.0.2.10", 24046, token=token, session=session)
    return notifier, session


class SendTests(unittest.TestCase):
    def test_posts_json_and_returns_payload(self):
        notifier, session = client([FakeResponse(202, {"id": "abc", "queued_at": 1})])
        result = notifier.send("hello")
        self.assertEqual(result, {"id": "abc", "queued_at": 1})

        method, url, kwargs = session.calls[0]
        self.assertEqual(method, "POST")
        self.assertEqual(url, "http://192.0.2.10:24046/notify")
        self.assertEqual(kwargs["json"], {"text": "hello"})
        self.assertEqual(kwargs["headers"], {})
        self.assertEqual(kwargs["timeout"], 10.0)

    def test_token_becomes_auth_header(self):
        notifier, session = client([FakeResponse(202, {"id": "abc"})], token="sekret")
        notifier.send("hello")
        self.assertEqual(session.calls[0][2]["headers"], {"X-Auth-Token": "sekret"})

    def test_key_is_only_sent_when_given(self):
        notifier, session = client([FakeResponse(202, {}), FakeResponse(202, {})])
        notifier.send("one")
        notifier.send("two", key="build-42")
        self.assertEqual(session.calls[0][2]["json"], {"text": "one"})
        self.assertEqual(session.calls[1][2]["json"], {"text": "two", "key": "build-42"})

    def test_non_202_raises_with_status_and_payload(self):
        notifier, _ = client([FakeResponse(429, {"error": "queue_full"}, text="queue_full")])
        with self.assertRaises(QQNotifierError) as ctx:
            notifier.send("hello")
        self.assertEqual(ctx.exception.status, 429)
        self.assertEqual(ctx.exception.payload, {"error": "queue_full"})

    def test_rejects_empty_and_oversized_text(self):
        notifier, session = client([])
        with self.assertRaises(ValueError):
            notifier.send("   ")
        with self.assertRaises(ValueError):
            notifier.send("x" * (MAX_TEXT_BYTES + 1))
        self.assertEqual(session.calls, [])

    def test_per_call_timeout_override(self):
        notifier, session = client([FakeResponse(202, {})])
        notifier.send("hello", timeout=2.5)
        self.assertEqual(session.calls[0][2]["timeout"], 2.5)


class HealthAndLifecycleTests(unittest.TestCase):
    def test_health_returns_payload(self):
        notifier, session = client([FakeResponse(200, {"ok": True, "bot": "ready"})])
        self.assertEqual(notifier.health()["bot"], "ready")
        self.assertEqual(session.calls[0][1], "http://192.0.2.10:24046/health")

    def test_health_error_raises(self):
        notifier, _ = client([FakeResponse(401, {"error": "unauthorized"})])
        with self.assertRaises(QQNotifierError) as ctx:
            notifier.health()
        self.assertEqual(ctx.exception.status, 401)

    def test_context_manager_closes_session(self):
        notifier, session = client([])
        with notifier:
            pass
        self.assertTrue(session.closed)

    def test_base_url_and_repr(self):
        notifier, _ = client([])
        self.assertEqual(notifier.base_url, "http://192.0.2.10:24046")
        self.assertIn("192.0.2.10", repr(notifier))


class ValidationTests(unittest.TestCase):
    def test_rejects_bad_arguments(self):
        with self.assertRaises(ValueError):
            QQNotifier("", 24046)
        with self.assertRaises(ValueError):
            QQNotifier("192.0.2.10", 0)
        with self.assertRaises(ValueError):
            QQNotifier("192.0.2.10", 70000)
        with self.assertRaises(ValueError):
            QQNotifier("192.0.2.10", 24046, scheme="ftp")
        with self.assertRaises(ValueError):
            QQNotifier("192.0.2.10", 24046, timeout=0)


if __name__ == "__main__":
    unittest.main()
