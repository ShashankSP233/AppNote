// Optional AI reading of a quotation.
//
// This is the last resort, for the case the user described: a photograph of a
// quotation that is too poor for OCR to lay out as a table. It is off unless
// ANTHROPIC_API_KEY is set, and it is instructed to leave a field null rather
// than invent a figure. Nothing it returns is trusted either — it lands in the
// same review screen as every other extraction.

const MODEL = process.env.AI_EXTRACTION_MODEL || 'claude-sonnet-4-6';
const API_URL = 'https://api.anthropic.com/v1/messages';

export function isConfigured() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

const INSTRUCTIONS = `You are reading a supplier quotation for a purchase department.

Return ONLY a JSON object, no prose and no code fence, in exactly this shape:

{
  "vendor_name": string|null,
  "vendor_gstin": string|null,
  "vendor_pan": string|null,
  "quotation_ref": string|null,
  "quotation_date": "YYYY-MM-DD"|null,
  "validity_days": number|null,
  "delivery_days": number|null,
  "delivery_text": string|null,
  "advance_percent": number|null,
  "credit_days": number|null,
  "retention_percent": number|null,
  "payment_terms_text": string|null,
  "gst_rate": number|null,
  "freight_amount": number|null,
  "discount_amount": number|null,
  "quoted_basic": number|null,
  "quoted_total": number|null,
  "items": [
    {
      "description": string,
      "quantity": number|null,
      "unit": string|null,
      "rate": number|null,
      "amount": number|null,
      "legible": boolean
    }
  ],
  "unreadable_regions": string[]
}

Rules you must follow:
- Transcribe only what you can actually see. If a figure is blurred, cut off or
  ambiguous, set it to null and set "legible": false on that row.
- Never calculate a missing figure and present it as read. Never infer a rate
  from an amount, or an amount from a rate.
- delivery_days is a number of days. Convert weeks and months. "Ready stock" is 0.
- Amounts are plain numbers with no separators, no currency symbol and no "/-".
- Indian dates are day-first.
- List in unreadable_regions a short note for each part of the page you could
  not make out, so a person knows where to check.
- If the image is too poor to read at all, return every field null with an
  empty items array and say so in unreadable_regions.`;

/**
 * contents: [{ type: 'text', text }] or [{ type: 'image', mediaType, data }]
 */
export async function readQuotation(contents, { timeoutMs = 90000 } = {}) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { ok: false, reason: 'AI extraction is not configured. Set ANTHROPIC_API_KEY to enable it.' };
  }

  const blocks = contents.map((c) => {
    if (c.type === 'image') {
      return {
        type: 'image',
        source: { type: 'base64', media_type: c.mediaType, data: c.data },
      };
    }
    return { type: 'text', text: c.text };
  });

  blocks.push({ type: 'text', text: INSTRUCTIONS });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(API_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 4096,
        temperature: 0,
        messages: [{ role: 'user', content: blocks }],
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      return { ok: false, reason: `The extraction service returned ${response.status}. ${body.slice(0, 200)}` };
    }

    const payload = await response.json();
    const text = (payload.content || [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();

    const parsed = parseJsonLoosely(text);
    if (!parsed) {
      return { ok: false, reason: 'The extraction service did not return readable JSON.' };
    }

    return { ok: true, data: normalise(parsed), model: MODEL };
  } catch (error) {
    if (error.name === 'AbortError') {
      return { ok: false, reason: 'The extraction service timed out.' };
    }
    return { ok: false, reason: `The extraction service could not be reached: ${error.message}` };
  } finally {
    clearTimeout(timer);
  }
}

function parseJsonLoosely(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch { /* try harder */ }
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) {
    try { return JSON.parse(fenced[1]); } catch { /* keep going */ }
  }
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try { return JSON.parse(text.slice(first, last + 1)); } catch { /* give up */ }
  }
  return null;
}

function numOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalise(raw) {
  const items = Array.isArray(raw.items) ? raw.items : [];
  return {
    fields: {
      vendor_name: raw.vendor_name || null,
      vendor_gstin: raw.vendor_gstin ? String(raw.vendor_gstin).toUpperCase().replace(/\s/g, '') : null,
      vendor_pan: raw.vendor_pan ? String(raw.vendor_pan).toUpperCase().replace(/\s/g, '') : null,
      quotation_ref: raw.quotation_ref || null,
      quotation_date: raw.quotation_date || null,
      validity_days: numOrNull(raw.validity_days),
      delivery_days: numOrNull(raw.delivery_days),
      delivery_text: raw.delivery_text || null,
      delivery_basis: null,
      advance_percent: numOrNull(raw.advance_percent),
      credit_days: numOrNull(raw.credit_days),
      retention_percent: numOrNull(raw.retention_percent),
      payment_terms_text: raw.payment_terms_text || null,
      gst_rate: numOrNull(raw.gst_rate),
      freight_amount: numOrNull(raw.freight_amount),
      discount_amount: numOrNull(raw.discount_amount),
      quoted_basic: numOrNull(raw.quoted_basic),
      quoted_total: numOrNull(raw.quoted_total),
    },
    items: items.map((item, index) => {
      const quantity = numOrNull(item.quantity);
      const rate = numOrNull(item.rate);
      const amount = numOrNull(item.amount);
      const legible = item.legible !== false;
      const reconciled = quantity !== null && rate !== null && amount !== null
        ? Math.abs(quantity * rate - amount) <= Math.max(1, Math.abs(amount) * 0.01)
        : false;
      return {
        line_no: index + 1,
        description: item.description || `Line ${index + 1}`,
        quantity: quantity ?? 1,
        unit: item.unit || 'Nos',
        rate: rate ?? 0,
        amount: amount ?? null,
        reconciled,
        needs_review: !legible || !reconciled,
      };
    }),
    unreadable: Array.isArray(raw.unreadable_regions) ? raw.unreadable_regions : [],
  };
}
