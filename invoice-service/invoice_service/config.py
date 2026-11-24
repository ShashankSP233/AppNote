"""Settings, read from the environment (and an optional .env file).

Every variable is prefixed INVOICE_SERVICE_ so that it can never be confused
with Ollama's own OLLAMA_* server variables on the same host.
"""

from __future__ import annotations

import ipaddress
import os
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlparse


class ConfigError(RuntimeError):
    """The service refuses to start with an unsafe or invalid configuration."""


def load_env_file(path: str | os.PathLike[str]) -> None:
    """Loads KEY=VALUE lines into os.environ without overriding real variables."""
    file = Path(path)
    if not file.is_file():
        return
    for raw in file.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key, value = key.strip(), value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        os.environ.setdefault(key, value)


def _text(env, key, default=""):
    value = env.get(f"INVOICE_SERVICE_{key}")
    return default if value is None or value.strip() == "" else value.strip()


def _number(env, key, default, cast, minimum=None, maximum=None):
    raw = _text(env, key, "")
    if raw == "":
        return default
    try:
        value = cast(raw)
    except ValueError as exc:
        raise ConfigError(f"INVOICE_SERVICE_{key} must be a number, got {raw!r}.") from exc
    if minimum is not None and value < minimum:
        raise ConfigError(f"INVOICE_SERVICE_{key} must be at least {minimum}.")
    if maximum is not None and value > maximum:
        raise ConfigError(f"INVOICE_SERVICE_{key} must be at most {maximum}.")
    return value


def _flag(env, key, default):
    raw = _text(env, key, "").lower()
    if raw == "":
        return default
    if raw in {"1", "true", "yes", "on"}:
        return True
    if raw in {"0", "false", "no", "off"}:
        return False
    raise ConfigError(f"INVOICE_SERVICE_{key} must be true or false, got {raw!r}.")


@dataclass(frozen=True)
class Settings:
    host: str = "127.0.0.1"
    port: int = 8700
    api_keys: tuple[str, ...] = ()
    allow_no_auth: bool = False

    ollama_url: str = "http://127.0.0.1:11434"
    model: str = "qwen2.5:3b-instruct"
    vision_model: str = ""
    vision_fallback: bool = False
    num_ctx: int = 8192
    num_predict: int = 2500
    num_thread: int | None = None
    keep_alive: str = "30m"
    ollama_timeout_s: float = 240.0

    request_timeout_s: float = 300.0
    max_upload_bytes: int = 15 * 1024 * 1024
    max_pages: int = 8
    max_text_chars: int = 10000
    min_text_chars: int = 40
    min_chars_per_page: int = 80
    max_concurrency: int = 1
    queue_wait_s: float = 5.0

    ocr_enabled: bool = True
    ocr_lang: str = "eng"
    ocr_dpi: int = 200
    ocr_psm: int = 6
    ocr_timeout_s: float = 60.0
    vision_max_pages: int = 2

    log_level: str = "INFO"

    @classmethod
    def from_env(cls, env=None) -> "Settings":
        env = os.environ if env is None else env

        keys = tuple(k.strip() for k in _text(env, "API_KEYS").split(",") if k.strip())
        allow_no_auth = _flag(env, "ALLOW_NO_AUTH", False)
        if not keys and not allow_no_auth:
            raise ConfigError(
                "INVOICE_SERVICE_API_KEYS is not set. Set one or more API keys (comma separated), "
                "or INVOICE_SERVICE_ALLOW_NO_AUTH=true for local development only."
            )
        for key in keys:
            if len(key) < 24:
                raise ConfigError("Each INVOICE_SERVICE_API_KEYS entry must be at least 24 characters.")

        num_thread = _number(env, "NUM_THREAD", 0, int, 0, 256)

        settings = cls(
            host=_text(env, "HOST", cls.host),
            port=_number(env, "PORT", cls.port, int, 1, 65535),
            api_keys=keys,
            allow_no_auth=allow_no_auth,
            ollama_url=_text(env, "OLLAMA_URL", cls.ollama_url).rstrip("/"),
            model=_text(env, "MODEL", cls.model),
            vision_model=_text(env, "VISION_MODEL", ""),
            vision_fallback=_flag(env, "VISION_FALLBACK", False),
            num_ctx=_number(env, "NUM_CTX", cls.num_ctx, int, 1024, 131072),
            num_predict=_number(env, "NUM_PREDICT", cls.num_predict, int, 256, 16384),
            num_thread=num_thread or None,
            keep_alive=_text(env, "KEEP_ALIVE", cls.keep_alive),
            ollama_timeout_s=_number(env, "OLLAMA_TIMEOUT_S", cls.ollama_timeout_s, float, 5.0),
            request_timeout_s=_number(env, "REQUEST_TIMEOUT_S", cls.request_timeout_s, float, 10.0),
            max_upload_bytes=int(_number(env, "MAX_UPLOAD_MB", 15.0, float, 0.1, 200.0) * 1024 * 1024),
            max_pages=_number(env, "MAX_PAGES", cls.max_pages, int, 1, 50),
            max_text_chars=_number(env, "MAX_TEXT_CHARS", cls.max_text_chars, int, 1000, 200000),
            min_text_chars=_number(env, "MIN_TEXT_CHARS", cls.min_text_chars, int, 1, 5000),
            min_chars_per_page=_number(env, "MIN_CHARS_PER_PAGE", cls.min_chars_per_page, int, 1, 5000),
            max_concurrency=_number(env, "MAX_CONCURRENCY", cls.max_concurrency, int, 1, 16),
            queue_wait_s=_number(env, "QUEUE_WAIT_S", cls.queue_wait_s, float, 0.0, 600.0),
            ocr_enabled=_flag(env, "OCR_ENABLED", True),
            ocr_lang=_text(env, "OCR_LANG", cls.ocr_lang),
            ocr_dpi=_number(env, "OCR_DPI", cls.ocr_dpi, int, 72, 400),
            ocr_psm=_number(env, "OCR_PSM", cls.ocr_psm, int, 0, 13),
            ocr_timeout_s=_number(env, "OCR_TIMEOUT_S", cls.ocr_timeout_s, float, 5.0),
            vision_max_pages=_number(env, "VISION_MAX_PAGES", cls.vision_max_pages, int, 1, 10),
            log_level=_text(env, "LOG_LEVEL", cls.log_level).upper(),
        )

        parsed = urlparse(settings.ollama_url)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname:
            raise ConfigError("INVOICE_SERVICE_OLLAMA_URL must be an http(s) URL.")
        if settings.vision_fallback and not settings.vision_model:
            raise ConfigError("INVOICE_SERVICE_VISION_FALLBACK needs INVOICE_SERVICE_VISION_MODEL.")
        return settings

    def startup_warnings(self) -> list[str]:
        """Things that are legal but worth saying out loud at start-up."""
        notes = []
        if self.allow_no_auth:
            notes.append("API authentication is DISABLED (INVOICE_SERVICE_ALLOW_NO_AUTH). Use this for local development only.")
        if not _is_loopback(self.host):
            notes.append(
                f"The service is listening on {self.host}, not just localhost. Restrict it with a firewall "
                "or a private network and keep API keys secret."
            )
        ollama_host = urlparse(self.ollama_url).hostname or ""
        if not _is_private_or_loopback(ollama_host):
            notes.append(
                f"INVOICE_SERVICE_OLLAMA_URL points at {ollama_host}, which does not look like a private address. "
                "Ollama has no authentication; it must not be reachable from the internet."
            )
        return notes


def _is_loopback(host: str) -> bool:
    if host in {"localhost", ""}:
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def _is_private_or_loopback(host: str) -> bool:
    if _is_loopback(host):
        return True
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        # A hostname: cannot be judged here, so do not nag about it.
        return True
    return address.is_private
