"""The extraction pipeline: text -> model -> validated invoice."""

from __future__ import annotations

import time

from . import API_VERSION, SCHEMA_VERSION
from . import documents
from .config import Settings
from .errors import ModelUnavailable, NoReadableText, OcrUnavailable
from .normalize import TextIndex, build_invoice
from .prompts import build_text_messages, build_vision_messages
from .schema import model_schema

NOTICE = (
    "Every value is machine-extracted and unverified. 'printed' is the text copied from the document; "
    "'value' is that text parsed into a typed value; 'evidence' is where it was found. The service "
    "performs no arithmetic - recalculate and review before relying on any figure."
)


def _prepare_text(pages: list[str], limit: int) -> tuple[str, list[str], bool]:
    """Joins pages with markers, stopping at the character limit on a line boundary."""
    used, kept_pages, truncated = 0, [], False
    chunks = []
    for number, text in enumerate(pages, 1):
        marker = f"=== PAGE {number} ==="
        kept_lines = []
        for line in text.splitlines():
            cost = len(line) + 1
            if used + cost > limit:
                truncated = True
                break
            kept_lines.append(line)
            used += cost
        kept_pages.append("\n".join(kept_lines))
        chunks.append(f"{marker}\n" + "\n".join(kept_lines))
        if truncated:
            kept_pages.extend([""] * (len(pages) - number))
            break
    return "\n\n".join(chunks), kept_pages, truncated


class Extractor:
    def __init__(self, settings: Settings, client):
        self.settings = settings
        self.client = client

    def _options(self) -> dict:
        options = {
            "temperature": 0,
            "seed": 0,
            "num_ctx": self.settings.num_ctx,
            "num_predict": self.settings.num_predict,
        }
        if self.settings.num_thread:
            options["num_thread"] = self.settings.num_thread
        return options

    def _vision_allowed(self) -> bool:
        return bool(self.settings.vision_fallback and self.settings.vision_model)

    def run(self, data: bytes, kind: str, *, mode: str = "auto", buyer_hint: str | None = None) -> dict:
        settings = self.settings
        started = time.monotonic()
        deadline = started + settings.request_timeout_s

        warnings: list[dict] = []
        acquired = None
        fallback_reason = None
        try:
            acquired = documents.acquire(data, kind, mode, settings, deadline)
        except (NoReadableText, OcrUnavailable) as exc:
            if not self._vision_allowed():
                raise
            fallback_reason = exc.code
        text_done = time.monotonic()

        remaining = max(1.0, deadline - time.monotonic())
        model_timeout = min(settings.ollama_timeout_s, remaining)

        if acquired is not None:
            text, kept_pages, truncated = _prepare_text(acquired.pages, settings.max_text_chars)
            if truncated:
                warnings.append({
                    "code": "text_truncated", "path": "document",
                    "message": "The document text was longer than the configured limit; later lines were not read.",
                })
            if acquired.page_count > acquired.pages_processed:
                warnings.append({
                    "code": "pages_skipped", "path": "document",
                    "message": f"Only the first {acquired.pages_processed} of {acquired.page_count} pages were read.",
                })
            model_out = self.client.chat_json(
                model=settings.model, messages=build_text_messages(text, buyer_hint),
                schema=model_schema(), options=self._options(),
                keep_alive=settings.keep_alive, timeout_s=model_timeout,
            )
            invoice, found = build_invoice(model_out, TextIndex(kept_pages), buyer_hint)
            document = {
                "page_count": acquired.page_count, "pages_processed": acquired.pages_processed,
                "text_source": acquired.source, "ocr_confidence": acquired.ocr_confidence,
                "text_truncated": truncated,
            }
            model_name, vision = settings.model, False
        else:
            images = documents.page_images_b64(data, kind, settings.vision_max_pages)
            model_out = self.client.chat_json(
                model=settings.vision_model, messages=build_vision_messages(images, buyer_hint),
                schema=model_schema(), options=self._options(),
                keep_alive=settings.keep_alive, timeout_s=model_timeout,
            )
            invoice, found = build_invoice(model_out, None, buyer_hint)
            found.append({
                "code": "image_reading_unverified", "path": "document",
                "message": "No text could be extracted, so the page image was read by a vision model. "
                           "Values could not be checked against document text and carry no evidence.",
            })
            document = {
                "page_count": len(images), "pages_processed": len(images),
                "text_source": "vision", "ocr_confidence": None, "text_truncated": False,
                "fallback_reason": fallback_reason,
            }
            model_name, vision = settings.vision_model, True

        warnings.extend(found)
        done = time.monotonic()
        return {
            "api_version": API_VERSION,
            "schema_version": SCHEMA_VERSION,
            "verification": "unverified",
            "notice": NOTICE,
            "document": document,
            "model": {"provider": "ollama", "name": model_name, "vision": vision},
            "invoice": invoice,
            "warnings": warnings,
            "timing_ms": {
                "text": round((text_done - started) * 1000),
                "model": round((done - text_done) * 1000),
                "total": round((done - started) * 1000),
            },
        }


__all__ = ["Extractor", "NOTICE", "ModelUnavailable"]
