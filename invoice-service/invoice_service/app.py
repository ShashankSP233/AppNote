"""HTTP layer: authentication, request validation, concurrency, errors, health.

Logging policy: only request ids, outcome codes, sizes and timings are logged.
Invoice text, extracted values, filenames, prompts and API keys never are.
"""

from __future__ import annotations

import hmac
import logging
import threading
import time
import uuid

from flask import Flask, g, jsonify, request
from werkzeug.exceptions import HTTPException

from . import API_VERSION, __version__
from . import documents
from .config import ConfigError, Settings
from .errors import (
    ApiError, Busy, FileTooLarge, InvalidRequest, Unauthorized, UnsupportedMediaType,
)
from .ollama_client import OllamaClient
from .pipeline import Extractor

log = logging.getLogger("invoice_service")

MODES = {"auto", "text", "ocr"}


def create_app(settings: Settings | None = None, *, client=None, extractor=None) -> Flask:
    settings = settings or Settings.from_env()
    if not settings.api_keys and not settings.allow_no_auth:
        raise ConfigError("API keys are required unless INVOICE_SERVICE_ALLOW_NO_AUTH is set.")

    client = client or OllamaClient(settings.ollama_url)
    extractor = extractor or Extractor(settings, client)
    slots = threading.BoundedSemaphore(settings.max_concurrency)
    health_cache: dict = {"at": 0.0, "body": None, "status": 200}

    app = Flask(__name__)
    app.json.sort_keys = False
    app.json.ensure_ascii = False
    app.config["MAX_CONTENT_LENGTH"] = settings.max_upload_bytes + 256 * 1024
    app.extensions["invoice_settings"] = settings

    # -- plumbing ---------------------------------------------------------

    @app.before_request
    def start_request():
        g.request_id = uuid.uuid4().hex
        g.started = time.monotonic()
        g.outcome = "ok"

    @app.after_request
    def finish_request(response):
        response.headers["X-Request-ID"] = g.get("request_id", "")
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        elapsed = round((time.monotonic() - g.get("started", time.monotonic())) * 1000)
        log.info("request_id=%s method=%s path=%s status=%s ms=%s outcome=%s",
                 g.get("request_id"), request.method, request.path, response.status_code,
                 elapsed, g.get("outcome", "ok"))
        return response

    def error_response(code: str, status: int, message: str, retry_after: int | None = None):
        g.outcome = code
        body = jsonify({"error": {"code": code, "message": message, "request_id": g.get("request_id")}})
        body.status_code = status
        if retry_after is not None:
            body.headers["Retry-After"] = str(retry_after)
        if status == 401:
            body.headers["WWW-Authenticate"] = 'Bearer realm="invoice-service"'
        return body

    @app.errorhandler(ApiError)
    def handle_api_error(exc: ApiError):
        return error_response(exc.code, exc.status, exc.message, exc.retry_after)

    @app.errorhandler(HTTPException)
    def handle_http_error(exc: HTTPException):
        if exc.code == 413:
            return error_response(FileTooLarge.code, 413, "The upload is larger than the service allows.")
        codes = {404: "not_found", 405: "method_not_allowed"}
        return error_response(codes.get(exc.code, "invalid_request"), exc.code or 400, exc.description or "Request failed.")

    @app.errorhandler(Exception)
    def handle_unexpected(exc: Exception):
        # The exception text may contain document content; log only its type.
        log.error("request_id=%s unexpected_error type=%s", g.get("request_id"), type(exc).__name__)
        return error_response("internal_error", 500, "The service failed while processing the request.")

    def authenticate() -> None:
        if settings.allow_no_auth:
            return
        scheme, _, token = request.headers.get("Authorization", "").partition(" ")
        token = token.strip()
        if scheme.lower() != "bearer" or not token:
            raise Unauthorized("A bearer API key is required.")
        candidate = token.encode("utf-8")
        matched = False
        for key in settings.api_keys:            # no early exit: constant work per key
            matched |= hmac.compare_digest(candidate, key.encode("utf-8"))
        if not matched:
            raise Unauthorized("The API key is not valid.")

    # -- routes -----------------------------------------------------------

    @app.get(f"/{API_VERSION}/health")
    def health():
        now = time.monotonic()
        if health_cache["body"] is None or now - health_cache["at"] > 5:
            ollama = client.health(settings.model)
            ocr = documents.ocr_available(settings)
            if not (ollama["reachable"] and ollama["model_available"]):
                status, state = 503, "unavailable"
            elif not ocr and settings.ocr_enabled:
                status, state = 200, "degraded"
            else:
                status, state = 200, "ok"
            health_cache.update(at=now, status=status, body={
                "status": state,
                "api_version": API_VERSION,
                "service_version": __version__,
                "ollama": {"reachable": ollama["reachable"], "model": settings.model,
                           "model_available": ollama["model_available"]},
                "ocr": {"enabled": settings.ocr_enabled, "available": ocr},
                "vision_fallback": bool(settings.vision_fallback and settings.vision_model),
            })
        response = jsonify(health_cache["body"])
        response.status_code = health_cache["status"]
        return response

    @app.post(f"/{API_VERSION}/invoices/extract")
    def extract_invoice():
        authenticate()

        upload = request.files.get("file")
        if upload is None:
            raise InvalidRequest("Send the invoice as multipart form data in a field named 'file'.")
        data = upload.read()
        if not data:
            raise InvalidRequest("The uploaded file is empty.")
        if len(data) > settings.max_upload_bytes:
            raise FileTooLarge("The upload is larger than the service allows.")

        kind = documents.sniff_kind(data)
        if kind is None:
            raise UnsupportedMediaType("Only PDF and image files (PNG, JPEG, TIFF, BMP, WebP) are supported.")

        mode = (request.form.get("mode") or "auto").strip().lower()
        if mode not in MODES:
            raise InvalidRequest("mode must be one of: auto, text, ocr.")
        buyer_hint = (request.form.get("buyer_hint") or "").strip() or None
        if buyer_hint and len(buyer_hint) > 200:
            raise InvalidRequest("buyer_hint must be at most 200 characters.")

        if not slots.acquire(timeout=settings.queue_wait_s):
            raise Busy("The service is processing other invoices. Try again shortly.", retry_after=15)
        try:
            result = extractor.run(data, kind, mode=mode, buyer_hint=buyer_hint)
        finally:
            slots.release()

        doc = result["document"]
        g.outcome = f"ok:{doc['text_source']}"
        log.info("request_id=%s extracted bytes=%d pages=%s source=%s model_ms=%s warnings=%d",
                 g.request_id, len(data), doc["pages_processed"], doc["text_source"],
                 result["timing_ms"]["model"], len(result["warnings"]))
        return jsonify({"request_id": g.request_id, **result})

    return app
