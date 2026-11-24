"""Turning the model's raw output into validated, normalized, evidenced values.

The model only ever copies text. This module:
  * parses each copied string into a typed value (amount, date, GSTIN, ...);
  * checks that the value really appears in the document text ("grounding"),
    and records where (page + the line it was found on) as evidence;
  * drops - never repairs, never guesses - anything that fails.

It performs no arithmetic on invoice figures. Recalculation is the caller's job
and is reported separately, so a printed value can never be confused with a
calculated one.
"""

from __future__ import annotations

import re
import unicodedata
from datetime import date
from decimal import Decimal, InvalidOperation

from .schema import ITEM_KEYS, MAX_LINE_ITEMS

MAX_AMOUNT = Decimal("1e13")

NULLISH = {
    "null", "none", "n/a", "na", "nil", "-", "--", "—", "not available",
    "not provided", "not found", "unknown", "not applicable", "not mentioned",
}

# ---------------------------------------------------------------------------
# Primitive cleaning and parsing
# ---------------------------------------------------------------------------


def clean(value) -> str | None:
    """Whitespace-normalised text, or None for empty / null-like values."""
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        value = str(value)
    if not isinstance(value, str):
        return None
    text = unicodedata.normalize("NFKC", value)
    text = re.sub(r"\s+", " ", text).strip()
    if not text or text.casefold() in NULLISH:
        return None
    return text


def fold(text: str) -> str:
    """Case, spacing and punctuation insensitive form used to find a value in text."""
    return re.sub(r"[\W_]+", "", unicodedata.normalize("NFKC", text).casefold())


_TOKEN = re.compile(r"\d[\d,]*(?:\.\d+)?")
_AMOUNT_SHAPE = re.compile(r"\d{1,3}(?:,\d{2,3})*(?:\.\d+)?|\d+(?:\.\d+)?")


def numbers_in(line: str) -> list[Decimal]:
    found = []
    for match in _TOKEN.finditer(line):
        try:
            found.append(Decimal(match.group().rstrip(",").replace(",", "")))
        except InvalidOperation:
            continue
    return found


def parse_amount(raw) -> Decimal | None:
    """Indian or western grouping, Rs./INR/rupee-sign/'/-' decoration, (negative)."""
    text = clean(raw)
    if not text:
        return None
    text = re.sub(r"(?i)\b(?:rs|inr|rupees)\b\.?|₹|/-|/=", " ", text).strip()
    negative = text.startswith("-") or text.endswith("-") or (text.startswith("(") and text.endswith(")"))
    text = text.strip("()-+ ").strip()
    if not _AMOUNT_SHAPE.fullmatch(text):
        return None
    try:
        value = Decimal(text.replace(",", ""))
    except InvalidOperation:
        return None
    if value >= MAX_AMOUNT:
        return None
    return -value if negative else value


def parse_quantity(raw) -> Decimal | None:
    text = clean(raw)
    if not text:
        return None
    match = _TOKEN.search(text)
    if not match:
        return None
    value = parse_amount(match.group())
    return value if value is not None and value >= 0 else None


def parse_percent(raw) -> Decimal | None:
    text = clean(raw)
    if not text:
        return None
    tokens = _TOKEN.findall(text)
    if len(tokens) != 1:          # "9% + 9%" is two figures; do not pick one
        return None
    value = parse_amount(tokens[0])
    if value is None or value < 0 or value > 100:
        return None
    return value


_MONTHS = {m: i for i, m in enumerate(
    ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"], 1)}

_DATE_PATTERNS = (
    ("ymd", re.compile(r"\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b")),
    ("dMy", re.compile(r"\b(\d{1,2})(?:st|nd|rd|th)?[-/. ,]*([A-Za-z]{3,9})[-/. ,]*(\d{2,4})\b")),
    ("Mdy", re.compile(r"\b([A-Za-z]{3,9})[-/. ,]+(\d{1,2})(?:st|nd|rd|th)?[-/. ,]+(\d{4})\b")),
    ("dmy", re.compile(r"\b(\d{1,2})[-/. ](\d{1,2})[-/. ](\d{2,4})\b")),
)


def _make_date(year: int, month: int, day: int) -> date | None:
    if year < 100:
        year += 2000 if year < 70 else 1900
    if not 1990 <= year <= 2100:
        return None
    try:
        return date(year, month, day)
    except ValueError:
        return None


def date_candidates(text: str) -> list[date]:
    """Every date found in the text, in order of position. Day-first (Indian) convention."""
    found: list[tuple[int, date]] = []
    for shape, pattern in _DATE_PATTERNS:
        for match in pattern.finditer(text):
            a, b, c = match.groups()
            result = None
            if shape == "ymd":
                result = _make_date(int(a), int(b), int(c))
            elif shape == "dMy":
                month = _MONTHS.get(b[:3].lower())
                result = _make_date(int(c), month, int(a)) if month else None
            elif shape == "Mdy":
                month = _MONTHS.get(a[:3].lower())
                result = _make_date(int(c), month, int(b)) if month else None
            else:  # dmy: day first; month-first only if day-first is impossible
                result = _make_date(int(c), int(b), int(a)) or _make_date(int(c), int(a), int(b))
            if result:
                found.append((match.start(), result))
    found.sort(key=lambda pair: pair[0])
    seen, ordered = set(), []
    for _, value in found:
        if value not in seen:
            seen.add(value)
            ordered.append(value)
    return ordered


def parse_date(raw) -> str | None:
    text = clean(raw)
    if not text:
        return None
    candidates = date_candidates(text)
    return candidates[0].isoformat() if candidates else None


_GSTIN = re.compile(r"[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]")
_PAN = re.compile(r"[A-Z]{5}[0-9]{4}[A-Z]")
_IFSC = re.compile(r"[A-Z]{4}0[A-Z0-9]{6}")
_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"


def gstin_check_char(first14: str) -> str | None:
    total = 0
    for index, char in enumerate(first14[:14]):
        position = _ALPHABET.find(char)
        if position < 0:
            return None
        product = position * (1 if index % 2 == 0 else 2)
        total += product // 36 + product % 36
    return _ALPHABET[(36 - total % 36) % 36]


def parse_gstin(raw) -> tuple[str | None, str | None]:
    """Returns (value, issue). issue: None | 'invalid_format' | 'checksum_failed'."""
    text = clean(raw)
    if not text:
        return None, None
    compact = re.sub(r"[\s\-]", "", text.upper())
    match = _GSTIN.search(compact)
    if not match:
        return None, "invalid_format"
    gstin = match.group()
    if gstin_check_char(gstin[:14]) != gstin[14]:
        return gstin, "checksum_failed"
    return gstin, None


def parse_pan(raw) -> str | None:
    text = clean(raw)
    if not text:
        return None
    match = _PAN.search(re.sub(r"[\s\-]", "", text.upper()))
    return match.group() if match else None


def parse_ifsc(raw) -> str | None:
    text = clean(raw)
    if not text:
        return None
    match = _IFSC.search(re.sub(r"[\s\-]", "", text.upper()))
    return match.group() if match else None


def parse_account(raw) -> str | None:
    text = clean(raw)
    if not text:
        return None
    digits = re.sub(r"[\s\-]", "", text)
    return digits if re.fullmatch(r"\d{6,20}", digits) else None


def parse_hsn(raw) -> str | None:
    text = clean(raw)
    if not text:
        return None
    digits = re.sub(r"[\s\-]", "", text)
    return digits if re.fullmatch(r"\d{2,8}", digits) else None


_CURRENCY_ALIASES = {
    "INR": ("inr", "rs", "₹", "rupee", "rupees"),
    "USD": ("usd", "$", "us$"),
    "EUR": ("eur", "€"),
    "GBP": ("gbp", "£"),
    "AED": ("aed",),
    "SGD": ("sgd",),
}


def parse_currency(raw) -> str | None:
    text = clean(raw)
    if not text:
        return None
    key = text.casefold().strip(". ")
    for code, aliases in _CURRENCY_ALIASES.items():
        if key == code.casefold() or key in aliases:
            return code
    return key.upper() if re.fullmatch(r"[a-z]{3}", key) else None


def _currency_hit(code: str, line_lower: str) -> bool:
    for alias in {*(_CURRENCY_ALIASES.get(code, ())), code.casefold()}:
        if re.fullmatch(r"[a-z0-9]+", alias):
            if re.search(rf"(?<![a-z0-9]){re.escape(alias)}(?![a-z0-9])", line_lower):
                return True
        elif alias in line_lower:
            return True
    return False


# ---------------------------------------------------------------------------
# Where did each value come from? (grounding + evidence)
# ---------------------------------------------------------------------------

class TextIndex:
    """Lines of the document text, searchable by text, number, date and currency."""

    def __init__(self, pages: list[str]):
        self.lines: list[tuple[int, str]] = []
        for number, text in enumerate(pages, 1):
            for line in text.splitlines():
                line = line.strip()
                if line:
                    self.lines.append((number, line))
        self._folded = [fold(line) for _, line in self.lines]
        self._lower = [line.casefold() for _, line in self.lines]
        self._numbers = [numbers_in(line) for _, line in self.lines]
        self._pages: dict[int, str] = {}
        for (number, _), folded in zip(self.lines, self._folded):
            self._pages[number] = self._pages.get(number, "") + folded

    def _evidence(self, index: int) -> dict:
        page, line = self.lines[index]
        return {"page": page, "snippet": line[:160]}

    def find_text(self, printed: str) -> dict | None:
        target = fold(printed)
        if not target:
            return None
        for index, folded in enumerate(self._folded):
            if target in folded:
                return self._evidence(index)
        for page, joined in self._pages.items():     # a value that wraps across lines
            if target in joined:
                return {"page": page, "snippet": None}
        return None

    def count_lines(self, folded_fragment: str) -> int:
        if not folded_fragment:
            return 0
        return sum(1 for folded in self._folded if folded_fragment in folded)

    def find_number(self, value: Decimal, *, near: str | None = None, percent: bool = False) -> dict | None:
        if near:
            for anchor, folded in enumerate(self._folded):
                if near in folded:
                    for index in range(anchor, min(anchor + 3, len(self.lines))):
                        if value in self._numbers[index]:
                            return self._evidence(index)
        hits = [i for i, numbers in enumerate(self._numbers) if value in numbers]
        if percent:
            hits = [i for i in hits if "%" in self.lines[i][1]] or hits
        return self._evidence(hits[0]) if hits else None

    def find_date(self, iso: str) -> dict | None:
        for index, (_, line) in enumerate(self.lines):
            if any(candidate.isoformat() == iso for candidate in date_candidates(line)):
                return self._evidence(index)
        return None

    def find_currency(self, code: str) -> dict | None:
        for index, lower in enumerate(self._lower):
            if _currency_hit(code, lower):
                return self._evidence(index)
        return None


# ---------------------------------------------------------------------------
# Building the validated invoice
# ---------------------------------------------------------------------------

def field(value=None, printed=None, evidence=None) -> dict:
    return {"value": value, "printed": printed, "evidence": evidence}


def _number(value: Decimal) -> float:
    return float(value)


class _Builder:
    def __init__(self, index: TextIndex | None, warnings: list[dict]):
        self.index = index
        self.warnings = warnings

    def warn(self, code: str, path: str, message: str) -> None:
        self.warnings.append({"code": code, "path": path, "message": message})

    def _grounded(self, path: str, evidence: dict | None) -> tuple[bool, dict | None]:
        if self.index is None:          # image-reading fallback: nothing to check against
            return True, None
        if evidence is None:
            self.warn("ungrounded_value", path,
                      "The model returned a value that does not appear in the document text. It was discarded.")
            return False, None
        return True, evidence

    def text(self, path: str, raw, max_len: int = 300) -> dict:
        printed = clean(raw)
        if printed is None:
            return field()
        if len(printed) > max_len:
            self.warn("value_too_long", path, "The value was unusually long and was discarded.")
            return field()
        ok, evidence = self._grounded(path, self.index.find_text(printed) if self.index else None)
        return field(printed, printed, evidence) if ok else field()

    def identifier(self, path: str, raw, kind: str) -> dict:
        printed = clean(raw)
        if printed is None:
            return field()
        issue = None
        if kind == "gstin":
            value, issue = parse_gstin(printed)
        elif kind == "pan":
            value = parse_pan(printed)
        elif kind == "ifsc":
            value = parse_ifsc(printed)
        elif kind == "account":
            value = parse_account(printed)
        else:
            value = parse_hsn(printed)
        if value is None:
            self.warn("invalid_format", path, f"The {kind.upper()} value is not in a valid format and was discarded.")
            return field()
        ok, evidence = self._grounded(path, self.index.find_text(value) if self.index else None)
        if not ok:
            return field()
        if issue == "checksum_failed":
            self.warn("gstin_checksum_failed", path,
                      "This GSTIN fails the check-digit test. It may be misread; verify it on the invoice.")
        return field(value, printed, evidence)

    def currency(self, path: str, raw) -> dict:
        printed = clean(raw)
        if printed is None:
            return field()
        code = parse_currency(printed)
        if code is None:
            self.warn("invalid_format", path, "The currency was not recognised and was discarded.")
            return field()
        ok, evidence = self._grounded(path, self.index.find_currency(code) if self.index else None)
        return field(code, printed, evidence) if ok else field()

    def date(self, path: str, raw) -> dict:
        printed = clean(raw)
        if printed is None:
            return field()
        iso = parse_date(printed)
        if iso is None:
            self.warn("invalid_format", path, "The date could not be read as a valid date and was discarded.")
            return field()
        ok, evidence = self._grounded(path, self.index.find_date(iso) if self.index else None)
        return field(iso, printed, evidence) if ok else field()

    def number(self, path: str, raw, kind: str, near: str | None = None) -> dict:
        """kind: amount | discount | signed | quantity | percent"""
        printed = clean(raw)
        if printed is None:
            return field()
        if kind == "quantity":
            value = parse_quantity(printed)
        elif kind == "percent":
            value = parse_percent(printed)
        else:
            value = parse_amount(printed)
        if value is None:
            self.warn("invalid_format", path, "The number could not be read and was discarded.")
            return field()
        if kind == "discount":
            value = abs(value)
        elif kind == "amount" and value < 0:
            self.warn("negative_amount", path, "A negative amount was discarded. Check the invoice for a credit note.")
            return field()
        evidence = None
        if self.index is not None:
            lookup = abs(value) if kind in {"signed", "discount"} else value
            evidence = self.index.find_number(lookup, near=near, percent=(kind == "percent"))
            if evidence is None and kind == "signed":
                evidence = self.index.find_number(value, near=near)
        ok, evidence = self._grounded(path, evidence)
        return field(_number(value), printed, evidence) if ok else field()


TOTAL_FIELDS = (
    ("subtotal", "amount"), ("total_discount", "discount"), ("freight", "amount"),
    ("other_charges", "amount"), ("taxable_total", "amount"), ("cgst_total", "amount"),
    ("sgst_total", "amount"), ("igst_total", "amount"), ("total_tax", "amount"),
    ("round_off", "signed"), ("total", "amount"), ("amount_payable", "amount"),
)

ITEM_FIELDS = (
    ("hsn", "hsn_sac", "hsn"), ("qty", "quantity", "quantity"), ("unit", "unit", "unit"),
    ("rate", "rate", "amount"), ("disc_pct", "discount_percent", "percent"),
    ("disc_amt", "discount_amount", "discount"), ("taxable", "taxable_value", "amount"),
    ("gst_pct", "gst_rate", "percent"), ("cgst", "cgst_amount", "amount"),
    ("sgst", "sgst_amount", "amount"), ("igst", "igst_amount", "amount"),
    ("total", "line_total", "amount"),
)


def _build_item(b: _Builder, raw: dict, position: int) -> dict | None:
    path = f"invoice.line_items[{position}]"
    description = b.text(f"{path}.description", raw.get("desc"), max_len=400)
    if description["value"] is None:
        b.warn("line_dropped", path, "A line without a verifiable description was dropped.")
        return None
    near = fold(description["printed"])[:24]
    item = {"line_no": position + 1, "description": description}
    for short, name, kind in ITEM_FIELDS:
        value = raw.get(short)
        field_path = f"{path}.{name}"
        if kind == "hsn":
            item[name] = b.identifier(field_path, value, "hsn")
        elif kind == "unit":
            item[name] = b.text(field_path, value, max_len=20)
        else:
            item[name] = b.number(field_path, value, kind, near=near)
    return item


def build_invoice(model_output: dict, index: TextIndex | None, buyer_hint: str | None = None):
    """Returns (invoice, warnings). `index` is None when there is no text to check against."""
    warnings: list[dict] = []
    b = _Builder(index, warnings)
    raw = model_output if isinstance(model_output, dict) else {}

    supplier = {
        "name": b.text("invoice.supplier.name", raw.get("supplier_name"), 200),
        "gstin": b.identifier("invoice.supplier.gstin", raw.get("supplier_gstin"), "gstin"),
        "pan": b.identifier("invoice.supplier.pan", raw.get("supplier_pan"), "pan"),
        "address": b.text("invoice.supplier.address", raw.get("supplier_address"), 400),
    }
    buyer = {
        "name": b.text("invoice.buyer.name", raw.get("buyer_name"), 200),
        "gstin": b.identifier("invoice.buyer.gstin", raw.get("buyer_gstin"), "gstin"),
    }

    if buyer_hint and supplier["name"]["value"] and fold(buyer_hint) and fold(buyer_hint) in fold(supplier["name"]["value"]):
        b.warn("supplier_is_buyer", "invoice.supplier.name",
               "The supplier name matches the buyer. It was discarded; enter the supplier from the invoice.")
        supplier["name"] = field()
    if supplier["gstin"]["value"] and supplier["gstin"]["value"] == buyer["gstin"]["value"]:
        b.warn("supplier_buyer_gstin_equal", "invoice.supplier.gstin",
               "The supplier and buyer GSTINs are identical. Check which party each belongs to.")

    invoice = {
        "supplier": supplier,
        "buyer": buyer,
        "invoice_number": b.text("invoice.invoice_number", raw.get("invoice_number"), 60),
        "invoice_date": b.date("invoice.invoice_date", raw.get("invoice_date")),
        "due_date": b.date("invoice.due_date", raw.get("due_date")),
        "po_reference": b.text("invoice.po_reference", raw.get("po_reference"), 100),
        "requisition_reference": b.text("invoice.requisition_reference", raw.get("requisition_reference"), 100),
        "currency": b.currency("invoice.currency", raw.get("currency")),
    }

    invoice_date, due_date = invoice["invoice_date"]["value"], invoice["due_date"]["value"]
    if invoice_date and due_date and due_date < invoice_date:
        b.warn("due_before_invoice", "invoice.due_date", "The due date is earlier than the invoice date. Check both.")

    raw_items = raw.get("line_items")
    raw_items = raw_items if isinstance(raw_items, list) else []
    if len(raw_items) > MAX_LINE_ITEMS:
        b.warn("too_many_lines", "invoice.line_items", f"Only the first {MAX_LINE_ITEMS} lines were kept.")
        raw_items = raw_items[:MAX_LINE_ITEMS]

    items, seen = [], {}
    for position, raw_item in enumerate(raw_items):
        if not isinstance(raw_item, dict):
            continue
        item = _build_item(b, raw_item, len(items))
        if item is None:
            continue
        signature = tuple(
            item[name]["value"] if isinstance(item[name], dict) else None
            for name in ["description", *[n for _, n, _ in ITEM_FIELDS]]
        )
        allowed = max(1, index.count_lines(fold(item["description"]["printed"]))) if index else 1
        seen[signature] = seen.get(signature, 0) + 1
        if seen[signature] > allowed:
            b.warn("duplicate_line_dropped", f"invoice.line_items[{len(items)}]",
                   "An identical repeated line was dropped; the document shows it fewer times.")
            continue
        item["line_no"] = len(items) + 1
        items.append(item)
    invoice["line_items"] = items

    invoice["totals"] = {
        name: b.number(f"invoice.totals.{name}", raw.get(name), kind)
        for name, kind in TOTAL_FIELDS
    }
    invoice["payment"] = {
        "bank_name": b.text("invoice.payment.bank_name", raw.get("bank_name"), 120),
        "account_number": b.identifier("invoice.payment.account_number", raw.get("account_number"), "account"),
        "ifsc": b.identifier("invoice.payment.ifsc", raw.get("ifsc"), "ifsc"),
        "terms": b.text("invoice.payment.terms", raw.get("payment_terms"), 300),
    }
    return invoice, warnings


__all__ = [
    "TextIndex", "build_invoice", "clean", "fold", "parse_amount", "parse_quantity",
    "parse_percent", "parse_date", "parse_gstin", "parse_pan", "parse_ifsc", "parse_account",
    "parse_currency", "gstin_check_char", "date_candidates", "numbers_in", "field",
    "ITEM_KEYS",
]
