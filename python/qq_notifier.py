"""Minimal Python client for the qq-notifier HTTP API.

Python 3.8+. The only third-party dependency is ``requests``::

    python -m pip install requests

Usage::

    from pathlib import Path
    from qq_notifier import QQNotifier

    with QQNotifier("192.0.2.10", 24046, token="change-me") as notifier:
        notifier.send("download finished", key="dl-42")
        notifier.send(Path("report.txt").read_text(encoding="utf-8"))
        print(notifier.health()["queue"])

The client raises :class:`QQNotifierError` when the server answers with an
unexpected status, and ``ValueError`` for input the server would reject anyway
(empty text, more than 12 000 UTF-8 bytes).
"""

from __future__ import annotations

import sys
from typing import Any, Dict, Optional

try:
    import requests
except ImportError:  # pragma: no cover - depends on the caller's environment
    print(
        "qq_notifier needs the 'requests' package:\n"
        "    python -m pip install requests",
        file=sys.stderr,
    )
    raise SystemExit(1)

__all__ = ["QQNotifier", "QQNotifierError", "MAX_TEXT_BYTES"]

MAX_TEXT_BYTES = 12000
DEFAULT_TIMEOUT = 10.0


class QQNotifierError(RuntimeError):
    """Raised when qq-notifier answers with an unexpected HTTP status."""

    def __init__(self, message: str, status: Optional[int] = None, payload: Any = None) -> None:
        super().__init__(message)
        self.status = status
        self.payload = payload


def _response_payload(response: Any) -> Any:
    try:
        return response.json()
    except ValueError:
        return {"raw": getattr(response, "text", "")}


class QQNotifier:
    """Client for one qq-notifier server."""

    def __init__(
        self,
        host: str,
        port: int,
        token: Optional[str] = None,
        *,
        scheme: str = "http",
        timeout: float = DEFAULT_TIMEOUT,
        session: Optional[Any] = None,
    ) -> None:
        if not isinstance(host, str) or not host.strip():
            raise ValueError("host must be a non-empty string")
        if isinstance(port, bool) or not isinstance(port, int) or not 1 <= port <= 65535:
            raise ValueError("port must be an integer between 1 and 65535")
        if scheme not in ("http", "https"):
            raise ValueError("scheme must be 'http' or 'https'")
        if not isinstance(timeout, (int, float)) or timeout <= 0:
            raise ValueError("timeout must be a positive number")

        self.host = host.strip()
        self.port = port
        self.token = token
        self.scheme = scheme
        self.timeout = float(timeout)
        self._session = session if session is not None else requests.Session()

    @property
    def base_url(self) -> str:
        return f"{self.scheme}://{self.host}:{self.port}"

    def _headers(self) -> Dict[str, str]:
        return {"X-Auth-Token": self.token} if self.token else {}

    def _request_timeout(self, timeout: Optional[float]) -> float:
        return self.timeout if timeout is None else float(timeout)

    def send(
        self,
        text: str,
        key: Optional[str] = None,
        *,
        timeout: Optional[float] = None,
    ) -> Dict[str, Any]:
        """Enqueue one notification and return ``{"id", "queued_at"}``."""
        if not isinstance(text, str) or not text.strip():
            raise ValueError("text must be a non-empty string")
        size = len(text.encode("utf-8"))
        if size > MAX_TEXT_BYTES:
            raise ValueError(f"text is {size} bytes; the server limit is {MAX_TEXT_BYTES}")
        if key is not None and not isinstance(key, str):
            raise TypeError("key must be a string or None")

        payload: Dict[str, Any] = {"text": text}
        if key:
            payload["key"] = key

        response = self._session.post(
            f"{self.base_url}/notify",
            json=payload,
            headers=self._headers(),
            timeout=self._request_timeout(timeout),
        )
        if response.status_code != 202:
            raise QQNotifierError(
                f"notify failed with HTTP {response.status_code}",
                status=response.status_code,
                payload=_response_payload(response),
            )
        return response.json()

    def health(self, *, timeout: Optional[float] = None) -> Dict[str, Any]:
        """Return the server's ``/health`` payload."""
        response = self._session.get(
            f"{self.base_url}/health",
            headers=self._headers(),
            timeout=self._request_timeout(timeout),
        )
        if response.status_code != 200:
            raise QQNotifierError(
                f"health failed with HTTP {response.status_code}",
                status=response.status_code,
                payload=_response_payload(response),
            )
        return response.json()

    def close(self) -> None:
        """Close the underlying HTTP session (safe to call twice)."""
        close = getattr(self._session, "close", None)
        if close is not None:
            close()

    def __enter__(self) -> "QQNotifier":
        return self

    def __exit__(self, exc_type: Any, exc: Any, traceback: Any) -> bool:
        self.close()
        return False

    def __repr__(self) -> str:
        return f"QQNotifier(host={self.host!r}, port={self.port!r})"
