"""Getting text out of an uploaded document.

Order of preference:
  1. the PDF's own text layer (exact, fast);
  2. OCR (Tesseract) for scans and images.
Image-based model reading is a separate, optional fallback handled by the pipeline.
"""

from __future__ import annotations

import base64
import io
import re
import time
from dataclasses import dataclass
from statistics import median

from .config import Settings
from .errors import (
    InvalidDocument, InvalidRequest, NoReadableText, OcrTimeout, OcrUnavailable,
    RequestTimeout,
)

_IMAGE_SIGNATURES = (
    b"\x89PNG\r\n\x1a\n",
    b"\xff\xd8\xff",
    b"II*\x00",
    b"MM\x00*",
    b"BM",
)


def sniff_kind(data: bytes) -> str | None:
    """Identifies the file by its content, never by its name or declared type."""
    if b"%PDF-" in data[:1024]:
        return "pdf"
    if any(data.startswith(sig) for sig in _IMAGE_SIGNATURES):
        return "image"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image"
    return None


@dataclass
class Acquired:
    pages: list[str]
    source: str                 # "pdf_text" | "ocr"
    page_count: int             # pages in the document
    pages_processed: int
    ocr_confidence: int | None


def check_deadline(deadline: float) -> None:
    if time.monotonic() > deadline:
        raise RequestTimeout("The request ran past its time limit.")


# ---------------------------------------------------------------------------
# PDF text layer
# ---------------------------------------------------------------------------

def words_to_text(words: list[dict], y_tolerance: float = 3.0, column_gap: float = 14.0) -> str:
    """Rebuilds visual rows from positioned words, marking wide gaps as column breaks.

    Tables are what the model must read. Plain text extraction flattens the
    columns together; keeping a ' | ' where the page had a wide gap preserves them.
    """
    if not words:
        return ""
    ordered = sorted(words, key=lambda w: (w["top"], w["x0"]))
    rows: list[list[dict]] = []
    anchor = None
    for word in ordered:
        if anchor is None or abs(word["top"] - anchor) > y_tolerance:
            rows.append([word])
            anchor = word["top"]
        else:
            rows[-1].append(word)

    lines = []
    for row in rows:
        row.sort(key=lambda w: w["x0"])
        parts = [row[0]["text"]]
        for previous, word in zip(row, row[1:]):
            gap = word["x0"] - previous["x1"]
            parts.append(" | " if gap > column_gap else " ")
            parts.append(word["text"])
        lines.append(re.sub(r"[ \t]+", " ", "".join(parts)).strip())
    return "\n".join(line for line in lines if line)


def pdf_page_texts(data: bytes, max_pages: int, deadline: float) -> tuple[list[str], int]:
    import pdfplumber

    try:
        with pdfplumber.open(io.BytesIO(data)) as pdf:
            total = len(pdf.pages)
            texts = []
            for page in pdf.pages[:max_pages]:
                check_deadline(deadline)
                words = page.extract_words(x_tolerance=1.5, y_tolerance=3, keep_blank_chars=False)
                texts.append(words_to_text(words))
            return texts, total
    except RequestTimeout:
        raise
    except Exception as exc:  # corrupt, encrypted, unsupported structure
        raise InvalidDocument(
            "The PDF could not be opened. It may be corrupt or password-protected."
        ) from exc


def _non_space_chars(pages: list[str]) -> int:
    return sum(len(re.sub(r"\s", "", page)) for page in pages)


def has_enough_text(pages: list[str], settings: Settings, *, per_page: bool) -> bool:
    if not pages:
        return False
    total = _non_space_chars(pages)
    if total < settings.min_text_chars:
        return False
    return (total / len(pages)) >= settings.min_chars_per_page if per_page else True


# ---------------------------------------------------------------------------
# Rendering and OCR
# ---------------------------------------------------------------------------

def render_pdf_pages(data: bytes, dpi: int, max_pages: int, deadline: float):
    import pypdfium2 as pdfium

    try:
        pdf = pdfium.PdfDocument(data)
    except Exception as exc:
        raise InvalidDocument(
            "The PDF could not be opened. It may be corrupt or password-protected."
        ) from exc
    try:
        total = len(pdf)
        images = []
        for index in range(min(total, max_pages)):
            check_deadline(deadline)
            page = pdf[index]
            try:
                images.append(page.render(scale=dpi / 72).to_pil())
            finally:
                page.close()
        return images, total
    except RequestTimeout:
        raise
    except Exception as exc:
        raise InvalidDocument("A page of the PDF could not be rendered.") from exc
    finally:
        pdf.close()


def load_image_frames(data: bytes, max_pages: int):
    from PIL import Image, ImageSequence

    try:
        image = Image.open(io.BytesIO(data))
        frames = []
        total = getattr(image, "n_frames", 1)
        for frame in ImageSequence.Iterator(image):
            frames.append(frame.convert("RGB"))
            if len(frames) >= max_pages:
                break
        return frames, total
    except Exception as exc:  # includes decompression-bomb errors
        raise InvalidDocument("The image could not be decoded.") from exc


def ocr_available(settings: Settings) -> bool:
    if not settings.ocr_enabled:
        return False
    try:
        import pytesseract

        pytesseract.get_tesseract_version()
        return True
    except Exception:
        return False


def _prepare(image):
    from PIL import ImageOps

    image = image.convert("L")
    if image.width < 1000:
        image = image.resize((image.width * 2, image.height * 2))
    image.thumbnail((3200, 3200))
    return ImageOps.autocontrast(image)


def ocr_image(image, settings: Settings) -> tuple[str, float | None]:
    """Reads one page. Returns (text, mean word confidence 0-100 or None)."""
    import pytesseract
    from pytesseract import Output

    config = f"--psm {settings.ocr_psm} -c preserve_interword_spaces=1"
    try:
        data = pytesseract.image_to_data(
            _prepare(image), lang=settings.ocr_lang, config=config,
            output_type=Output.DICT, timeout=settings.ocr_timeout_s,
        )
    except pytesseract.TesseractNotFoundError as exc:
        raise OcrUnavailable("OCR is not installed on the service host.") from exc
    except RuntimeError as exc:
        if "timeout" in str(exc).lower():
            raise OcrTimeout("OCR of a page took too long.") from exc
        raise OcrUnavailable("OCR failed on this page.") from exc
    except Exception as exc:
        raise OcrUnavailable("OCR failed on this page.") from exc

    lines: dict[tuple[int, int, int], list[dict]] = {}
    confidences: list[float] = []
    for index, text in enumerate(data["text"]):
        text = (text or "").strip()
        if not text:
            continue
        key = (data["block_num"][index], data["par_num"][index], data["line_num"][index])
        word = {
            "text": text, "left": data["left"][index], "width": data["width"][index],
            "height": data["height"][index],
        }
        lines.setdefault(key, []).append(word)
        try:
            conf = float(data["conf"][index])
        except (TypeError, ValueError):
            conf = -1
        if conf >= 0:
            confidences.append(conf)

    out_lines = []
    for words in lines.values():
        words.sort(key=lambda w: w["left"])
        height = median(w["height"] for w in words) or 10
        parts = [words[0]["text"]]
        for previous, word in zip(words, words[1:]):
            gap = word["left"] - (previous["left"] + previous["width"])
            parts.append(" | " if gap > 2.5 * height else " ")
            parts.append(word["text"])
        out_lines.append("".join(parts).strip())

    confidence = round(sum(confidences) / len(confidences)) if confidences else None
    return "\n".join(out_lines), confidence


def acquire(data: bytes, kind: str, mode: str, settings: Settings, deadline: float) -> Acquired:
    """Returns page texts for a PDF or image, or raises a precise ApiError."""
    if kind == "pdf":
        total = 0
        if mode in {"auto", "text"}:
            pages, total = pdf_page_texts(data, settings.max_pages, deadline)
            if has_enough_text(pages, settings, per_page=True):
                return Acquired(pages, "pdf_text", total, len(pages), None)
            if mode == "text":
                raise NoReadableText(
                    "The PDF has no usable text layer (it looks like a scan). "
                    "Retry with mode 'auto' or 'ocr'."
                )
        images, total = _render_for_ocr(data, settings, deadline)
        return _run_ocr(images, total, settings, deadline)

    if mode == "text":
        raise InvalidRequest("An image has no text layer. Use mode 'auto' or 'ocr'.")
    images, total = load_image_frames(data, settings.max_pages)
    return _run_ocr(images, total, settings, deadline)


def _render_for_ocr(data, settings, deadline):
    if not ocr_available(settings):
        raise OcrUnavailable("OCR is disabled or not installed, and this document has no text layer.")
    return render_pdf_pages(data, settings.ocr_dpi, settings.max_pages, deadline)


def _run_ocr(images, total, settings, deadline) -> Acquired:
    if not ocr_available(settings):
        raise OcrUnavailable("OCR is disabled or not installed on the service host.")
    pages, confidences = [], []
    for image in images:
        check_deadline(deadline)
        text, confidence = ocr_image(image, settings)
        pages.append(text)
        if confidence is not None:
            confidences.append(confidence)
    if not has_enough_text(pages, settings, per_page=False):
        raise NoReadableText("No readable text was found in the document, even with OCR.")
    mean = round(sum(confidences) / len(confidences)) if confidences else None
    return Acquired(pages, "ocr", total, len(pages), mean)


def page_images_b64(data: bytes, kind: str, max_pages: int, dpi: int = 130) -> list[str]:
    """PNG pages as base64, for the optional image-reading fallback."""
    if kind == "pdf":
        images, _ = render_pdf_pages(data, dpi, max_pages, time.monotonic() + 120)
    else:
        images, _ = load_image_frames(data, max_pages)
    encoded = []
    for image in images:
        image = image.convert("RGB")
        image.thumbnail((1800, 1800))
        buffer = io.BytesIO()
        image.save(buffer, format="PNG")
        encoded.append(base64.b64encode(buffer.getvalue()).decode("ascii"))
    return encoded
