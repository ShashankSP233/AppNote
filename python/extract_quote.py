"""Local, rule-based extraction of quotation fields from PDF/OCR text."""

from __future__ import annotations

import json
import re
import sys
from datetime import date


BUYER_PATTERN = re.compile(r"\bdharti\b|\byogayatan\b", re.I)
BUSINESS_PATTERN = re.compile(
    r"\b(private|pvt\.?|limited|ltd\.?|llp|industr(?:y|ies)|engineering|marine|"
    r"traders?|trading|corporation|company|enterprises?|services?|fabricators?|"
    r"suppliers?|agencies|works|systems|solutions)\b|&\s*co\b", re.I,
)
NOISE_START = re.compile(
    r"^(quotation|quote|proforma|performa|invoice|tax invoice|estimate|offer|"
    r"to|from|date|dated|ref(?:erence)?|subject|sir|dear|gstin|gst|pan|phone|"
    r"mobile|email|address|page|www\.|http)", re.I,
)
GSTIN_RE = re.compile(r"\b(\d{2}[A-Z]{5}\d{4}[A-Z][A-Z0-9]Z[A-Z0-9])\b", re.I)
PAN_RE = re.compile(r"\b([A-Z]{5}\d{4}[A-Z])\b", re.I)
MONTHS = {
    "jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6,
    "jul": 7, "aug": 8, "sep": 9, "sept": 9, "oct": 10,
    "nov": 11, "dec": 12,
}
MONEY_RE = re.compile(
    r"(?<![A-Za-z0-9])(?:₹|rs\.?\s*|inr\s*)?\(?-?\s*"
    r"\d[\d,]*(?:\.\d{1,4})?\s*\)?\s*(?:/-|/=)?", re.I,
)
UNIT_RE = re.compile(
    r"^(nos?\.?|pcs?\.?|pieces?|sets?|units?|ltr|lit(?:re|er)s?|kgs?|kg|mt|"
    r"tons?|tonnes?|mtrs?|meters?|metres?|rm|sqm|cum|cbm|boxes?|packets?|"
    r"rolls?|pairs?|drums?|cans?|bags?|jobs?|lot|ls|each|ea|hrs?|hours?)$", re.I,
)
TOTAL_LINE = re.compile(
    r"^\s*(?:sub\s*-?\s*)?(?:total|grand\s*total|net|amount\s*in\s*words|"
    r"gst|cgst|sgst|igst|tax|round\s*off|discount|freight|packing|forwarding|"
    r"insurance|less|add|terms|bank|account|ifsc)\b", re.I,
)


def clean_text(value: str) -> str:
    value = str(value or "").replace("\r\n", "\n").replace("\r", "\n")
    value = value.replace("\u00a0", " ").replace("\u200b", "")
    value = value.replace("ﬁ", "fi").replace("ﬂ", "fl")
    value = re.sub(r"[\t\f\v ]+", " ", value)
    value = re.sub(r"\n[ ]+", "\n", value)
    return re.sub(r"\n{3,}", "\n\n", value).strip()


def amount(raw: str | None) -> float | None:
    if raw is None:
        return None
    value = str(raw).strip()
    if not value:
        return None
    negative = value.startswith("-") or (value.startswith("(") and value.endswith(")"))
    value = re.sub(r"(?i)rs\.?|inr|₹", "", value)
    value = value.replace("(", "").replace(")", "").replace("/-", "").replace("/=", "")
    value = re.sub(r"[^0-9.,]", "", value).replace(",", "")
    if not value or value.count(".") > 1:
        return None
    try:
        number = float(value)
    except ValueError:
        return None
    if not (number < 1e15):
        return None
    return -number if negative else number


def amount_tokens(line: str) -> list[float]:
    values = []
    for match in MONEY_RE.finditer(line):
        if line[match.end():].lstrip().startswith("%"):
            continue
        parsed = amount(match.group(0))
        if parsed is not None:
            values.append(parsed)
    return values


def valid_date(day: int, month: int, year: int) -> str | None:
    if year < 100:
        year += 2000 if year < 70 else 1900
    try:
        return date(year, month, day).isoformat()
    except ValueError:
        return None


def date_matches(text: str) -> list[str]:
    found = []
    for m in re.finditer(r"\b(\d{1,2})[\s./-]([A-Za-z]{3,9})[\s./-](\d{2,4})\b", text):
        month = MONTHS.get(m.group(2).lower()[:4], MONTHS.get(m.group(2).lower()[:3]))
        if month:
            result = valid_date(int(m.group(1)), month, int(m.group(3)))
            if result:
                found.append((m.start(), result))
    for m in re.finditer(r"\b(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})\b", text):
        result = valid_date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
        if result:
            found.append((m.start(), result))
    for m in re.finditer(r"\b(20\d{2})-(\d{2})-(\d{2})\b", text):
        result = valid_date(int(m.group(3)), int(m.group(2)), int(m.group(1)))
        if result:
            found.append((m.start(), result))
    found.sort()
    return [value for _, value in found]


def find_vendor(lines: list[str]) -> str | None:
    candidates: list[tuple[int, int, str]] = []
    for index, line in enumerate(lines[:35]):
        trimmed = line.strip(" \t|:-")
        if len(trimmed) < 4 or len(trimmed) > 110 or NOISE_START.search(trimmed):
            continue
        if BUYER_PATTERN.search(trimmed) or GSTIN_RE.search(trimmed) or PAN_RE.fullmatch(trimmed):
            continue
        if re.fullmatch(r"[\d\W]+", trimmed):
            continue

        score = 0
        if re.match(r"^m/s\.?\s*", trimmed, re.I):
            score += 100
            trimmed = re.sub(r"^m/s\.?\s*", "", trimmed, flags=re.I)
        if re.match(r"^(supplier|vendor|seller)\s*[:|-]", line, re.I):
            score += 95
            trimmed = re.sub(r"^(supplier|vendor|seller)\s*[:|-]\s*", "", trimmed, flags=re.I)
        if BUSINESS_PATTERN.search(trimmed):
            score += 30
        if any(ch.isalpha() for ch in trimmed):
            score += 6
        if re.search(r"\b(quotation|quote|offer|proforma)\b", " ".join(lines[max(0, index - 2):index + 3]), re.I):
            score += 7
        score -= min(index, 20)
        if len(trimmed) > 85:
            score -= 15
        candidates.append((score, -index, trimmed.rstrip(".,; ")))

    if not candidates:
        return None
    return max(candidates)[2] or None


def find_gstin(text: str, vendor: str | None) -> str | None:
    lines = text.splitlines()
    vendor_words = [word for word in re.findall(r"[a-z0-9]+", (vendor or "").lower()) if len(word) > 3]
    buyer_starts = [
        index for index, line in enumerate(lines)
        if re.search(r"details\s+of\s+buyer|buyer|billed\s*to|bill\s*to|consignee|shipped\s*to|ship\s*to", line, re.I)
    ]
    first_buyer_section = min(buyer_starts) if buyer_starts else None
    candidates = []
    for index, line in enumerate(lines):
        match = GSTIN_RE.search(line)
        if not match:
            continue
        context = " ".join(lines[max(0, index - 1):min(len(lines), index + 2)])
        seller_context = re.search(r"supplier|vendor|seller|from", context, re.I)
        # In two-column buyer/consignee headers, nearby text from both columns
        # can be flattened onto one PDF line. Treat the document's first buyer
        # block as a boundary and prefer the seller GSTIN printed above it.
        if first_buyer_section is not None and index >= first_buyer_section and not seller_context:
            continue
        if re.search(r"our\s+gst|company\s+gst", line, re.I) and not seller_context:
            continue
        score = 0
        if seller_context:
            score += 8
        if re.search(r"gstin|gst\s*(?:no|number|#)", line, re.I):
            score += 2
        if vendor_words and any(word in context.lower() for word in vendor_words):
            score += 5
        score -= index * 0.01
        candidates.append((score, -index, match.group(1).upper()))
    return max(candidates)[2] if candidates else None


def find_pan(text: str, gstin: str | None) -> str | None:
    # A GSTIN embeds the registered entity's PAN. The vendor GSTIN was
    # selected by party block above, so this is safer than taking the first PAN
    # label in a buyer/vendor invoice layout.
    if gstin:
        return gstin[2:12]
    lines = text.splitlines()
    for index, line in enumerate(lines):
        match = re.search(r"\bpan\s*(?:no\.?|number|#)?\s*[:|-]?\s*([A-Z]{5}\d{4}[A-Z])\b", line, re.I)
        context = " ".join(lines[max(0, index - 1):min(len(lines), index + 2)])
        if match and not re.search(r"buyer|purchaser|consignee|customer|bill\s*to|our\s+pan", context, re.I):
            return match.group(1).upper()
    for index, line in enumerate(lines):
        context = " ".join(lines[max(0, index - 1):min(len(lines), index + 2)])
        if re.search(r"buyer|purchaser|consignee|customer|bill\s*to|our\s+pan", context, re.I):
            continue
        for match in PAN_RE.finditer(line.upper()):
            candidate = match.group(1)
            # GSTIN embeds the PAN in characters 3–12. Don't mistake it for a
            # separately printed PAN unless it appears on a labelled PAN line.
            if gstin and candidate == gstin[2:12]:
                continue
            return candidate
    return None


def find_reference(lines: list[str]) -> str | None:
    patterns = [
        re.compile(r"\b(?:quotation|quote|offer|proforma|pro forma)\s*(?:no\.?|number|#|ref(?:erence)?)?\s*[:#-]\s*([A-Z0-9][A-Z0-9/_.-]{1,50})", re.I),
        re.compile(r"\b(?:quotation|quote|offer)\s*(?:no\.?|number|#|ref(?:erence)?)\s+([A-Z0-9][A-Z0-9/_.-]{1,50})", re.I),
    ]
    for pattern in patterns:
        for line in lines[:50]:
            match = pattern.search(line)
            if match:
                return match.group(1).rstrip(".,;)")
    return None


def find_doc_date(lines: list[str]) -> str | None:
    ranked = []
    for index, line in enumerate(lines[:70]):
        if not date_matches(line):
            continue
        if re.search(r"delivery|dispatch|despatch|required by|valid until|validity up to", line, re.I):
            continue
        score = 0
        if re.search(r"quotation|quote|offer|proforma|invoice|dated|\bdate\b", line, re.I):
            score += 10
        if re.search(r"delivery|dispatch|despatch", " ".join(lines[max(0, index - 1):index + 2]), re.I):
            score -= 15
        ranked.append((score, -index, date_matches(line)[0]))
    return max(ranked)[2] if ranked else None


def find_period(lines: list[str], labels: str, is_validity: bool = False):
    candidates = []
    period = re.compile(r"\b(\d{1,3})\s*(?:-|to|–|—)\s*(\d{1,3})\s*(days?|weeks?|months?)\b|\b(\d{1,3})\s*(days?|weeks?|months?)\b", re.I)
    for index, line in enumerate(lines):
        if not re.search(labels, line, re.I):
            continue
        match = period.search(line)
        if not match:
            continue
        if match.group(1):
            value, unit = int(match.group(2)), match.group(3).lower()
        else:
            value, unit = int(match.group(4)), match.group(5).lower()
        days = value * (7 if unit.startswith("week") else 30 if unit.startswith("month") else 1)
        candidates.append((index, days, line.strip()))
    if candidates:
        _, days, evidence = candidates[0]
        return days, evidence
    if not is_validity:
        for line in lines:
            if re.search(labels, line, re.I) and re.search(r"ready stock|ex[ -]?stock|immediate|readily available", line, re.I):
                return 0, line.strip()
        matching = next((line.strip() for line in lines if re.search(labels, line, re.I)), None)
        return None, matching
    return None, None


def parse_payment(lines: list[str]):
    relevant = [line.strip() for line in lines if re.search(r"payment|advance|credit|retention|pdc|against delivery|against invoice", line, re.I)]
    scope = " ".join(relevant)
    advance = None
    m = re.search(r"(\d{1,3}(?:\.\d+)?)\s*%\s*(?:payment\s*)?(?:as\s*)?advance|advance\s*(?:of\s*)?(\d{1,3}(?:\.\d+)?)\s*%", scope, re.I)
    if m:
        value = float(m.group(1) or m.group(2))
        if 0 <= value <= 100:
            advance = value
    elif re.search(r"100\s*%\s*(?:payment\s*)?(?:against|before|along\s*with)\s*(?:po|purchase order|proforma|performa)", scope, re.I):
        advance = 100

    credit = None
    m = re.search(r"(?:net\s*)?(\d{1,3})\s*days?\s*(?:credit|from\s*(?:invoice|delivery|receipt))|credit\s*(?:period\s*)?(?:of\s*)?(\d{1,3})\s*days?", scope, re.I)
    if m:
        credit = int(m.group(1) or m.group(2))
    retention = None
    m = re.search(r"(\d{1,3}(?:\.\d+)?)\s*%\s*retention|retention\s*(?:of\s*)?(\d{1,3}(?:\.\d+)?)\s*%", scope, re.I)
    if m:
        value = float(m.group(1) or m.group(2))
        if 0 <= value <= 100:
            retention = value
    return advance, credit, retention, "; ".join(relevant) or None


def find_gst_rate(text: str):
    cgst = re.search(r"c\.?\s*gst\s*@?\s*(\d{1,2}(?:\.\d+)?)\s*%", text, re.I)
    sgst = re.search(r"s\.?\s*gst\s*@?\s*(\d{1,2}(?:\.\d+)?)\s*%", text, re.I)
    igst = re.search(r"i\.?\s*gst\s*@?\s*(\d{1,2}(?:\.\d+)?)\s*%", text, re.I)
    if igst:
        return float(igst.group(1)), []
    if cgst and sgst:
        return round(float(cgst.group(1)) + float(sgst.group(1)), 2), []
    if cgst:
        return round(float(cgst.group(1)) * 2, 2), []
    rates = {float(x) for x in re.findall(r"\b(?:gst|tax)\s*@?\s*(\d{1,2}(?:\.\d+)?)\s*%", text, re.I)}
    if len(rates) == 1:
        return rates.pop(), []
    if len(rates) > 1:
        return None, ["Multiple tax rates appear in the quotation. Check GST by line before confirming."]
    return None, []


def find_totals(lines: list[str]):
    basic_candidates = []
    grand_candidates = []
    generic_totals = []
    tax_totals = []
    tax_components = []
    total_warnings = []
    for index, line in enumerate(lines):
        low = line.lower()
        values = amount_tokens(line)
        if not values:
            continue
        value = values[-1]
        if re.search(r"grand\s*total|net\s*(?:payable|amount)|total\s*amount|amount\s*payable|invoice total|total\s*(?:including|incl\.?|inclusive of)\s*gst", low):
            grand_candidates.append((10, index, value))
        elif re.search(r"taxable\s*(?:value|amount)|sub\s*-?\s*total|total\s*basic|basic\s*(?:value|amount)|\btotal\b", low) and not re.search(r"gst|tax|grand|net|invoice", low):
            priority = 8 if re.search(r"taxable|sub\s*-?\s*total|basic", low) else 3
            if priority == 3:
                generic_totals.append((priority, index, value))
            else:
                basic_candidates.append((priority, index, value))
        elif re.search(r"\b(?:cgst|sgst|igst|gst|tax)\b", low):
            if re.search(r"(?:total\s*(?:gst|tax)|(?:gst|tax)\s*total)", low):
                tax_totals.append((10, index, value))
            elif re.search(r"\b(?:cgst|sgst|igst)\b", low):
                # Ignore item-table rows carrying both a tax rate and amount;
                # the summary tax rows normally contain a single amount.
                if len(values) == 1:
                    tax_components.append((index, value))
            else:
                if len(values) == 1:
                    tax_totals.append((1, index, value))

    basic = max(basic_candidates)[2] if basic_candidates else None
    grand = max(grand_candidates)[2] if grand_candidates else None
    tax = max(tax_totals)[2] if tax_totals else None
    if tax is None and tax_components:
        tax = round(sum(value for _, value in tax_components), 2)
    if grand is None and basic is not None and tax is not None:
        expected_grand = round(basic + tax, 2)
        matching_generic = [entry for entry in generic_totals if abs(entry[2] - expected_grand) <= max(2, expected_grand * 0.01)]
        if matching_generic:
            grand = max(matching_generic)[2]
    if basic is None and generic_totals:
        if grand is not None:
            basic = max(generic_totals)[2]
        else:
            total_warnings.append("A total is printed without a clear basic or grand-total label. It was left for manual review.")
    return basic, tax, grand, total_warnings


def split_cells(line: str) -> list[str]:
    if "|" in line:
        return [part.strip() for part in re.split(r"\s*\|\s*", line.strip().strip("|"))]
    return [part.strip() for part in re.split(r"\t+|\s{2,}", line.strip())]


def number_cell(value: str) -> float | None:
    value = re.sub(r"\b(?:qty|quantity|nos?|pcs?)\b", "", value, flags=re.I).strip()
    return amount(value)


def parse_quantity_cell(value: str) -> tuple[float | None, str | None]:
    match = re.search(r"^\s*([\d,.]+)\s*([A-Za-z]+)?", value or "")
    if not match:
        return number_cell(value), None
    unit = match.group(2)
    return number_cell(match.group(1)), unit if unit and UNIT_RE.fullmatch(unit) else None


def parse_items(lines: list[str]):
    items = []
    warnings = []
    header = None
    header_index = -1
    for index, line in enumerate(lines):
        cells = split_cells(line)
        text = " ".join(cells).lower()
        description_header = re.compile(r"description|particulars|item details|item name|name\s+of\s+(?:the\s+)?(?:product|item|goods)|product\s*/\s*service", re.I)
        if description_header.search(text) and re.search(r"qty|quantity", text) and re.search(r"rate|price", text):
            header = {"gst_rates": []}
            for col in range(len(cells)):
                if description_header.search(" ".join(cells[col:col + 4])):
                    header["description"] = col
                    break
            current_tax_heading = None
            for col, cell in enumerate(cells):
                value = cell.lower()
                if description_header.search(value):
                    header["description"] = col
                elif re.search(r"qty|quantity", value):
                    header["quantity"] = col
                elif re.search(r"unit", value):
                    header["unit"] = col
                elif re.search(r"rate|unit price|price", value):
                    header["rate"] = col
                adjacent_taxable_header = value.strip() == "taxable" and col + 1 < len(cells) and cells[col + 1].strip().lower() in {"value", "amount"}
                if re.search(r"taxable\s*(?:value|amount)|amount\s*before\s*tax", value) or adjacent_taxable_header:
                    header["amount"] = col
                elif "amount" in value and "amount" not in header:
                    header["amount"] = col
                if re.search(r"\b(cgst|sgst|igst)\b", value):
                    current_tax_heading = value
                if re.search(r"(?:c|s|i)?gst.*%|tax\s*rate", value) or (value.strip() == "%" and current_tax_heading):
                    header["gst_rates"].append(col)
                    current_tax_heading = None
            header_index = index
            break

    def add_item(line_no, description, qty, unit, rate, total, gst_rate=None):
        description = re.sub(r"\s+", " ", description or "").strip(" .:-")
        if not description or len(description) < 2 or re.fullmatch(r"[\d.,/-]+", description):
            return
        if total is None and rate is None:
            return
        if qty is not None and rate is not None and total is not None:
            expected = round(qty * rate, 2)
            reconciled = abs(expected - total) <= max(1.0, abs(total) * 0.01)
        else:
            reconciled = False
        if not reconciled:
            warnings.append(f'Line "{description[:40]}": check the read quantity, rate and amount against the quotation.')
        items.append({
            "line_no": line_no or len(items) + 1,
            "description": description,
            "quantity": qty,
            "unit": unit or "Nos",
            "rate": rate,
            "amount": total,
            "gst_rate": gst_rate,
            "reconciled": reconciled,
            "needs_review": not reconciled,
        })

    if header and header_index >= 0:
        for line in lines[header_index + 1:]:
            if TOTAL_LINE.search(line):
                if re.search(r"grand\s*total|sub\s*-?\s*total|\btotal\b", line, re.I):
                    break
                continue
            cells = split_cells(line)
            if len(cells) < 3:
                continue
            def get(key):
                pos = header.get(key)
                return cells[pos] if pos is not None and pos < len(cells) else ""
            desc = get("description")
            if not desc:
                continue
            serial = cells[0] if cells and re.fullmatch(r"\d{1,3}[.)]?", cells[0]) else ""
            line_no = int(re.sub(r"\D", "", serial)) if serial else None
            qty, qty_unit = parse_quantity_cell(get("quantity"))
            unit = get("unit") or None
            if unit and number_cell(unit) is not None:
                unit = None
            unit = unit or qty_unit
            rate = number_cell(get("rate"))
            total = number_cell(get("amount"))
            gst_parts = [number_cell(cells[pos]) for pos in header.get("gst_rates", []) if pos < len(cells)]
            gst_parts = [part for part in gst_parts if part is not None]
            gst_rate = round(sum(gst_parts), 2) if gst_parts else None
            if qty is None and len(cells) >= 5:
                # Some supplier PDFs label the quantity as "Nos." or place it
                # in a narrow column that the text extractor joins to its unit.
                for pos in range(1, len(cells) - 2):
                    candidate = number_cell(cells[pos])
                    if candidate is not None and candidate > 0 and candidate < 1e7 and UNIT_RE.fullmatch(cells[pos + 1]):
                        qty, unit = candidate, cells[pos + 1]
                        break
            add_item(line_no, desc, qty, unit, rate, total, gst_rate)
        return items, warnings

    # Conservative fallback for text extractions that lost the table header.
    for line in lines:
        if TOTAL_LINE.search(line):
            continue
        cells = split_cells(line)
        if len(cells) < 4:
            continue
        serial = cells[0] if re.fullmatch(r"\d{1,3}[.)]?", cells[0]) else ""
        if not serial:
            continue
        line_no = int(re.sub(r"\D", "", serial)) if serial else None
        if serial:
            cells = cells[1:]
        qty = unit = None
        if len(cells) >= 4 and UNIT_RE.fullmatch(cells[-3]):
            qty = number_cell(cells[-4])
            unit = cells[-3]
            rate, total = number_cell(cells[-2]), number_cell(cells[-1])
            description = " ".join(cells[:-4])
        else:
            values = [(i, number_cell(c)) for i, c in enumerate(cells)]
            values = [(i, v) for i, v in values if v is not None]
            if len(values) < 3:
                continue
            (ri, rate), (ti, total) = values[-2], values[-1]
            if ti <= ri:
                continue
            description = " ".join(cells[:ri])
        add_item(line_no, description, qty, unit, rate, total)
    return items, warnings


def parse_quotation(raw_text: str, source: str = "pdf_text") -> dict:
    text = clean_text(raw_text)
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    if len(text) < 30:
        return {
            "ok": False, "source": source, "confidence": 0, "fields": {}, "items": [],
            "warnings": ["The document produced almost no readable text. Enter the figures by hand against the attached copy."],
        }

    vendor = find_vendor(lines)
    gstin = find_gstin(text, vendor)
    pan = find_pan(text, gstin)
    ref = find_reference(lines)
    quotation_date = find_doc_date(lines)
    validity, _ = find_period(lines, r"valid(?:ity)?", is_validity=True)
    delivery, delivery_text = find_period(lines, r"deliver|dispatch|despatch|lead\s*time|completion|supply\s*within")
    advance, credit, retention, payment_text = parse_payment(lines)
    gst_rate, warnings = find_gst_rate(text)
    if len(GSTIN_RE.findall(text)) > 1:
        warnings.append("More than one GSTIN appears in the document. The supplier-side GSTIN was selected; verify it before confirming.")
    basic, tax, grand, total_warnings = find_totals(lines)
    warnings.extend(total_warnings)
    items, item_warnings = parse_items(lines)
    warnings.extend(item_warnings)
    item_rates = {item["gst_rate"] for item in items if item.get("gst_rate") is not None}
    if gst_rate is None and len(item_rates) == 1:
        gst_rate = item_rates.pop()
    elif len(item_rates) > 1:
        warnings.append("Different GST rates were found across quotation items. Check the GST rate on each line.")

    item_sum = round(sum(float(item["amount"] or 0) for item in items), 2) if items else None
    if item_sum is not None and basic is not None and abs(item_sum - basic) > max(2, basic * 0.01):
        warnings.append(f"The line items add up to {item_sum:.2f}, but the printed basic total reads {basic:.2f}. Check for a missed or misread line.")

    if gstin and pan and gstin[2:12] != pan:
        warnings.append(f"The separately printed PAN ({pan}) differs from the PAN embedded in the GSTIN ({gstin[2:12]}). Check both values.")
    if vendor is None:
        warnings.append("No supplier name could be identified without guessing. Enter it from the quotation.")
    if not items:
        warnings.append("No line items could be mapped reliably. Add them by hand against the attached copy.")

    fields = {
        "vendor_name": vendor,
        "vendor_gstin": gstin,
        "vendor_pan": pan,
        "quotation_ref": ref,
        "quotation_date": quotation_date,
        "validity_days": validity,
        "delivery_days": delivery,
        "delivery_text": delivery_text,
        "delivery_basis": None,
        "advance_percent": advance,
        "credit_days": credit,
        "retention_percent": retention,
        "payment_terms_text": payment_text,
        "gst_rate": gst_rate,
        "quoted_basic": basic,
        "quoted_total": grand,
    }

    captured = sum(value is not None and value != "" for value in fields.values())
    reconciled_items = sum(item["reconciled"] for item in items)
    score = min(50, captured * 5) + min(25, len(items) * 5)
    if items and reconciled_items == len(items):
        score += 15
    if item_sum is not None and basic is not None and abs(item_sum - basic) <= max(2, basic * 0.01):
        score += 10
    if source == "ocr":
        score = round(score * 0.8)

    return {
        "ok": True,
        "source": source,
        "confidence": min(100, score),
        "fields": fields,
        "items": items,
        "warnings": warnings,
    }


def main() -> None:
    payload = json.load(sys.stdin)
    result = parse_quotation(payload.get("text", ""), payload.get("source", "pdf_text"))
    json.dump(result, sys.stdout, ensure_ascii=False, separators=(",", ":"))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:  # Keep stdout clean for the Node JSON adapter.
        print(f"quotation parser error: {type(error).__name__}: {error}", file=sys.stderr)
        sys.exit(1)
