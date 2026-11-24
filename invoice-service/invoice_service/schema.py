"""The structure the model is asked to fill in.

All values are nullable strings copied exactly as printed. The model is never
asked to convert, calculate or reformat anything: parsing and validation happen
in normalize.py, where every value is checked against the document text.
"""

from __future__ import annotations

MAX_LINE_ITEMS = 60

HEADER_KEYS = (
    "supplier_name", "supplier_gstin", "supplier_pan", "supplier_address",
    "buyer_name", "buyer_gstin",
    "invoice_number", "invoice_date", "due_date",
    "po_reference", "requisition_reference", "currency",
    "subtotal", "total_discount", "freight", "other_charges", "taxable_total",
    "cgst_total", "sgst_total", "igst_total", "total_tax", "round_off",
    "total", "amount_payable",
    "bank_name", "account_number", "ifsc", "payment_terms",
)

# Short keys keep the model's output (and CPU time) down on long invoices.
ITEM_KEYS = (
    "desc", "hsn", "qty", "unit", "rate", "disc_pct", "disc_amt",
    "taxable", "gst_pct", "cgst", "sgst", "igst", "total",
)

_NULLABLE_STRING = {"anyOf": [{"type": "string"}, {"type": "null"}]}


def model_schema() -> dict:
    item = {
        "type": "object",
        "properties": {key: _NULLABLE_STRING for key in ITEM_KEYS},
        "required": list(ITEM_KEYS),
        "additionalProperties": False,
    }
    properties = {key: _NULLABLE_STRING for key in HEADER_KEYS}
    properties["line_items"] = {"type": "array", "items": item, "maxItems": MAX_LINE_ITEMS}
    return {
        "type": "object",
        "properties": properties,
        "required": [*HEADER_KEYS, "line_items"],
        "additionalProperties": False,
    }
