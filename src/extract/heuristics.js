// Reading a quotation from plain text.
//
// This is deliberately conservative. Every figure it produces is a candidate
// for a human to confirm, and it reports a confidence score plus the specific
// things it could not reconcile. It would rather return nothing for a field
// than guess.

import { round2, isValidGstin, isValidPan } from '../domain.js';

/**
 * Parses an Indian-format amount. Handles 1,68,315.20, ₹70,000/-, Rs. 4,87,700
 * and parenthesised negatives.
 */
export function parseAmount(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;

  let text = String(raw).trim();
  if (!text) return null;

  const negative = /^\(.*\)$/.test(text) || /^-/.test(text);

  text = text
    .replace(/[()]/g, '')
    .replace(/(?:rs\.?|inr|₹)/gi, '')
    .replace(/\/-\s*$/, '')
    .replace(/\/=\s*$/, '')
    .replace(/[^0-9.,-]/g, '')
    .replace(/,/g, '')
    .replace(/^-/, '')
    .trim();

  if (!text || text === '.' || text === '-') return null;

  // Reject things that are clearly not one number (e.g. "12.34.56")
  if ((text.match(/\./g) || []).length > 1) return null;

  const n = Number(text);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

export function cleanText(raw) {
  return String(raw || '')
    .replace(/\r\n?/g, '\n')
    .replace(/ /g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function findGstin(text) {
  const matches = String(text || '').toUpperCase().match(/\b[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]\b/g);
  if (!matches) return null;
  const valid = matches.find((m) => isValidGstin(m));
  return valid || matches[0];
}

export function findPan(text) {
  const upper = String(text || '').toUpperCase();
  // Prefer a PAN that is explicitly labelled.
  const labelled = upper.match(/PAN\s*(?:NO\.?|NUMBER|#)?\s*[:\-]?\s*([A-Z]{5}[0-9]{4}[A-Z])\b/);
  if (labelled && isValidPan(labelled[1])) return labelled[1];
  const matches = upper.match(/\b[A-Z]{5}[0-9]{4}[A-Z]\b/g);
  if (!matches) return null;
  return matches.find((m) => isValidPan(m)) || null;
}

export function findQuoteRef(text) {
  const m = String(text || '').match(
    /(?:quotation|quote|offer|ref|reference|proforma|pi)\s*(?:no\.?|number|#)?\s*[:\-]\s*([A-Za-z0-9][A-Za-z0-9\/\-_.]{2,40})/i,
  );
  return m ? m[1].replace(/[.,;]$/, '') : null;
}

const MONTH_WORDS = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11,
};

export function findDate(text) {
  const src = String(text || '');

  // 30-July-2026 / 30 Jul 2026 / 30-07-2026
  const worded = src.match(/\b(\d{1,2})[\s\-\/.]([A-Za-z]{3,9})[\s\-\/.](\d{2,4})\b/);
  if (worded) {
    const month = MONTH_WORDS[worded[2].toLowerCase().slice(0, 4)] ?? MONTH_WORDS[worded[2].toLowerCase().slice(0, 3)];
    if (month !== undefined) {
      let year = Number(worded[3]);
      if (year < 100) year += year < 70 ? 2000 : 1900;
      const d = new Date(Date.UTC(year, month, Number(worded[1])));
      if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
    }
  }

  const numeric = src.match(/\b(\d{1,2})[\-\/.](\d{1,2})[\-\/.](\d{2,4})\b/);
  if (numeric) {
    let year = Number(numeric[3]);
    if (year < 100) year += year < 70 ? 2000 : 1900;
    // Indian convention is day first.
    const day = Number(numeric[1]);
    const month = Number(numeric[2]) - 1;
    if (day <= 31 && month <= 11) {
      const d = new Date(Date.UTC(year, month, day));
      if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
    }
  }

  const iso = src.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) return iso[0];

  return null;
}

/**
 * Delivery period in days, plus the sentence it came from.
 * Handles "within 10 days", "2-3 weeks", "ready stock", "4 to 6 weeks".
 */
export function findDelivery(text) {
  const src = String(text || '');

  const line = src.split('\n').find((l) => /deliver|dispatch|despatch|lead\s*time|fabricat|completion|supply\s*within/i.test(l));
  const scope = line || src;

  if (/ready\s*stock|ex[\s-]*stock|immediate|readily\s*available/i.test(scope)) {
    return { days: 0, text: (line || 'Ready stock').trim(), basis: 'ready stock' };
  }

  // Ranges first — take the upper bound, which is the commitment.
  const range = scope.match(/(\d{1,3})\s*(?:-|to|–)\s*(\d{1,3})\s*(day|week|month)/i);
  if (range) {
    const upper = Number(range[2]);
    const unit = range[3].toLowerCase();
    const mult = unit.startsWith('week') ? 7 : unit.startsWith('month') ? 30 : 1;
    return { days: upper * mult, text: (line || range[0]).trim(), basis: null };
  }

  const single = scope.match(/(\d{1,3})\s*(day|week|month)s?/i);
  if (single) {
    const n = Number(single[1]);
    const unit = single[2].toLowerCase();
    const mult = unit.startsWith('week') ? 7 : unit.startsWith('month') ? 30 : 1;
    return { days: n * mult, text: (line || single[0]).trim(), basis: null };
  }

  if (line) return { days: null, text: line.trim(), basis: null };
  return { days: null, text: null, basis: null };
}

/**
 * Payment terms: advance %, credit days, retention %, plus the raw sentence.
 */
export function findPaymentTerms(text) {
  const src = String(text || '');
  const lines = src.split('\n').filter((l) => /payment|advance|credit|against\s*delivery|retention|pdc|100\s*%/i.test(l));
  const scope = lines.join(' ') || src;

  const result = { advancePercent: null, creditDays: null, retentionPercent: null, text: lines.join(' ').trim() || null };

  const advance = scope.match(/(\d{1,3}(?:\.\d+)?)\s*%?\s*(?:payment\s*)?(?:as\s*)?advance/i)
    || scope.match(/advance\s*(?:of\s*)?(\d{1,3}(?:\.\d+)?)\s*%/i);
  if (advance) {
    const pct = Number(advance[1]);
    if (pct >= 0 && pct <= 100) result.advancePercent = pct;
  }

  if (result.advancePercent === null && /100\s*%\s*(?:payment\s*)?(?:against|before|along\s*with)\s*(?:po|purchase\s*order|proforma|performa)/i.test(scope)) {
    result.advancePercent = 100;
  }

  const credit = scope.match(/(\d{1,3})\s*days?\s*(?:credit|from\s*(?:the\s*)?(?:date\s*of\s*)?(?:invoice|delivery|receipt))/i)
    || scope.match(/credit\s*(?:period\s*)?(?:of\s*)?(\d{1,3})\s*days?/i)
    || scope.match(/net\s*(\d{1,3})\b/i);
  if (credit) result.creditDays = Number(credit[1]);

  const retention = scope.match(/(\d{1,3}(?:\.\d+)?)\s*%\s*retention/i)
    || scope.match(/retention\s*(?:of\s*)?(\d{1,3}(?:\.\d+)?)\s*%/i);
  if (retention) {
    const pct = Number(retention[1]);
    if (pct >= 0 && pct <= 100) result.retentionPercent = pct;
  }

  return result;
}

export function findValidity(text) {
  const m = String(text || '').match(/valid(?:ity)?\s*(?:for|up\s*to|until|till)?\s*[:\-]?\s*(\d{1,3})\s*(day|week|month)s?/i);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  return unit.startsWith('week') ? n * 7 : unit.startsWith('month') ? n * 30 : n;
}

/**
 * GST rate. Where CGST and SGST are shown separately, they are combined.
 */
export function findGstRate(text) {
  const src = String(text || '');

  const igst = src.match(/i\.?\s*gst\s*@?\s*(\d{1,2}(?:\.\d+)?)\s*%/i);
  if (igst) return Number(igst[1]);

  const cgst = src.match(/c\.?\s*gst\s*@?\s*(\d{1,2}(?:\.\d+)?)\s*%/i);
  const sgst = src.match(/s\.?\s*gst\s*@?\s*(\d{1,2}(?:\.\d+)?)\s*%/i);
  if (cgst && sgst) return round2(Number(cgst[1]) + Number(sgst[1]));
  if (cgst) return round2(Number(cgst[1]) * 2);

  const plain = src.match(/\bgst\s*@?\s*(\d{1,2}(?:\.\d+)?)\s*%/i);
  if (plain) return Number(plain[1]);

  const tax = src.match(/\btax\s*@?\s*(\d{1,2}(?:\.\d+)?)\s*%/i);
  if (tax) return Number(tax[1]);

  return null;
}

/**
 * Printed totals. Grand total wins over sub-total where both are present.
 */
export function findTotals(text) {
  const lines = String(text || '').split('\n');
  const result = { basic: null, gst: null, grand: null };

  for (const line of lines) {
    const amounts = line.match(/(?:₹|rs\.?|inr)?\s*[\d,]+(?:\.\d{1,2})?\s*(?:\/-)?/gi) || [];
    const last = amounts.length ? parseAmount(amounts[amounts.length - 1]) : null;
    if (last === null) continue;

    if (/grand\s*total|net\s*(?:payable|amount)|total\s*amount\s*(?:payable)?|total\s*invoice/i.test(line)) {
      result.grand = last;
    } else if (/\b(?:sub\s*-?\s*total|total\s*basic|basic\s*(?:value|amount)|taxable\s*value)\b/i.test(line)) {
      result.basic = last;
    } else if (/^\s*total\b/i.test(line.trim()) && result.basic === null) {
      result.basic = last;
    } else if (/\b(?:c?gst|igst|sgst|tax)\b.*%/i.test(line) && !/total/i.test(line)) {
      result.gst = result.gst === null ? last : round2(result.gst + last);
    }
  }

  // "TOTAL / GST@18% / Total Amount" — the house pattern
  if (result.basic !== null && result.gst !== null && result.grand === null) {
    result.grand = round2(result.basic + result.gst);
  }
  if (result.basic === null && result.grand !== null && result.gst !== null) {
    result.basic = round2(result.grand - result.gst);
  }

  return result;
}

const VENDOR_NOISE = /^(quotation|quote|proforma|performa|invoice|tax\s*invoice|estimate|offer|to|from|date|ref|subject|sir|dear|gstin|gst|pan|phone|mobile|email|address|page)\b/i;

export function findVendorName(text) {
  const lines = String(text || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  // A line starting with M/s is almost always the vendor.
  const ms = lines.find((l) => /^m\/s\.?\s+\S/i.test(l));
  if (ms) return ms.replace(/^m\/s\.?\s*/i, '').replace(/[,.]$/, '').trim();

  // Otherwise the first substantial line that looks like a business name.
  for (const line of lines.slice(0, 12)) {
    if (line.length < 4 || line.length > 90) continue;
    if (VENDOR_NOISE.test(line)) continue;
    if (/^\d/.test(line)) continue;
    if (/(pvt|private|ltd|limited|llp|enterprise|engineering|services|industries|traders|trading|corporation|company|&\s*co|agencies|marine|supplier)/i.test(line)) {
      return line.replace(/[,.]$/, '').trim();
    }
  }

  for (const line of lines.slice(0, 6)) {
    if (line.length >= 4 && line.length <= 70 && !VENDOR_NOISE.test(line) && !/^\d/.test(line)) {
      return line.replace(/[,.]$/, '').trim();
    }
  }
  return null;
}

const UNIT_WORDS = /^(nos?|no\.|pcs?|pieces?|set|sets|unit|units|ltr|lit|litre|liters?|litres?|kg|kgs|mt|ton|tons|tonnes?|mtr|mtrs|meter|metre|meters|metres|rm|sqm|cum|cbm|box|boxes|pkt|packet|packets|roll|rolls|pair|pairs|drum|drums|can|cans|bag|bags|job|lot|ls|each|ea|hrs?|hours?|days?|months?)$/i;

const TOTAL_ROW = /^\s*(?:sub\s*-?\s*)?(?:total|grand\s*total|net|amount\s*in\s*words|gst|cgst|sgst|igst|tax|round\s*off|discount|freight|packing|forwarding|insurance|less|add)\b/i;

const HEADER_ROW = /(?:^|\s)(?:s\.?\s*no|sl\.?\s*no|sr\.?\s*no|item\s*no|#)\b/i;

/**
 * Reads line items out of a flattened table.
 *
 * Each input line is one table row, columns separated by two-or-more spaces,
 * tabs or pipes. The strategy is to peel numeric columns off the tail, because
 * descriptions are variable-length but the trailing numbers are positional.
 */
export function parseLineItems(text) {
  const rawLines = String(text || '').split('\n');
  const items = [];
  const warnings = [];
  let sawHeader = false;

  for (const rawLine of rawLines) {
    const line = rawLine.trim();
    if (!line) continue;

    // Header row: note it and move on.
    if (!sawHeader
      && HEADER_ROW.test(line)
      && /(qty|quantity|rate|price|amount|description|particulars)/i.test(line)) {
      sawHeader = true;
      continue;
    }

    if (TOTAL_ROW.test(line)) continue;

    // Split into columns.
    let cols = line.split(/\s*\|\s*/).map((c) => c.trim()).filter(Boolean);
    if (cols.length < 3) {
      cols = line.split(/\t+|\s{2,}/).map((c) => c.trim()).filter(Boolean);
    }
    if (cols.length < 3) {
      cols = line.split(/\s+/).map((c) => c.trim()).filter(Boolean);
    }
    if (cols.length < 3) continue;

    const working = [...cols];

    // Drop a leading serial number.
    let lineNo = null;
    if (/^\d{1,3}[.)]?$/.test(working[0]) && working.length > 3) {
      lineNo = Number(working[0].replace(/[.)]/g, ''));
      working.shift();
    }

    // Peel numeric values off the tail.
    const tail = [];
    while (working.length > 1 && tail.length < 4) {
      const candidate = working[working.length - 1];
      const value = parseAmount(candidate);
      if (value === null) break;
      // A bare unit word is not a number even though it may parse.
      if (UNIT_WORDS.test(candidate)) break;
      tail.unshift(value);
      working.pop();
    }

    if (tail.length < 2) continue;

    // A unit may now sit at the tail of the remaining head.
    let unit = null;
    if (working.length > 1 && UNIT_WORDS.test(working[working.length - 1])) {
      unit = working.pop();
    }

    // And the quantity may sit just before the unit.
    let quantity = null;
    if (unit && working.length > 1) {
      const maybeQty = parseAmount(working[working.length - 1]);
      if (maybeQty !== null && maybeQty > 0 && maybeQty < 1e7) {
        quantity = maybeQty;
        working.pop();
      }
    }

    const description = working.join(' ').replace(/\s+/g, ' ').trim();
    if (!description || description.length < 2) continue;
    if (/^\d+$/.test(description)) continue;

    let rate = null;
    let amount = null;

    if (quantity !== null) {
      // Head gave us the quantity; tail is [rate, amount] or [amount].
      if (tail.length >= 2) {
        rate = tail[tail.length - 2];
        amount = tail[tail.length - 1];
      } else {
        amount = tail[tail.length - 1];
        rate = quantity ? round2(amount / quantity) : amount;
      }
    } else if (tail.length >= 3) {
      // [qty, rate, amount]
      quantity = tail[tail.length - 3];
      rate = tail[tail.length - 2];
      amount = tail[tail.length - 1];
    } else {
      // [rate, amount] — derive the quantity
      rate = tail[0];
      amount = tail[1];
      quantity = rate ? round2(amount / rate) : 1;
    }

    if (amount === null || amount === 0) continue;
    if (quantity === null || quantity === 0) quantity = 1;
    if (rate === null) rate = round2(amount / quantity);

    const expected = round2(quantity * rate);
    const reconciled = Math.abs(expected - amount) <= Math.max(1, Math.abs(amount) * 0.01);

    if (!reconciled) {
      warnings.push(`Line "${description.slice(0, 40)}": ${quantity} × ${rate} is ${expected}, but the amount reads ${amount}.`);
    }

    items.push({
      line_no: lineNo ?? items.length + 1,
      description,
      quantity,
      unit: unit || 'Nos',
      rate,
      amount,
      reconciled,
      needs_review: !reconciled,
    });
  }

  return { items, warnings, sawHeader };
}

/**
 * The whole quotation, with a confidence score and the things that did not
 * add up. Confidence is a rough guide for the reviewer, nothing more.
 */
export function parseQuotation(rawText, { source = 'pdf_text' } = {}) {
  const text = cleanText(rawText);
  const warnings = [];

  if (!text || text.length < 30) {
    return {
      ok: false,
      source,
      confidence: 0,
      fields: {},
      items: [],
      warnings: ['The document produced almost no readable text. Enter the figures by hand against the attached copy.'],
    };
  }

  const vendorName = findVendorName(text);
  const gstin = findGstin(text);
  const pan = findPan(text) || null;
  const quotationRef = findQuoteRef(text);
  const quotationDate = findDate(text);
  const validityDays = findValidity(text);
  const delivery = findDelivery(text);
  const payment = findPaymentTerms(text);
  const gstRate = findGstRate(text);
  const totals = findTotals(text);
  const { items, warnings: itemWarnings } = parseLineItems(text);

  warnings.push(...itemWarnings);

  // Cross-checks: do the parts agree with each other?
  let score = 0;
  if (vendorName) score += 12;
  if (gstin) score += 14;
  if (quotationRef) score += 6;
  if (quotationDate) score += 8;
  if (delivery.days !== null) score += 10;
  else if (delivery.text) score += 4;
  if (payment.text) score += 8;
  if (gstRate !== null) score += 8;
  if (totals.basic !== null || totals.grand !== null) score += 12;
  if (items.length) score += Math.min(16, items.length * 3);

  const itemsSum = items.length
    ? round2(items.reduce((s, i) => s + (i.amount || 0), 0))
    : null;

  if (itemsSum !== null && totals.basic !== null) {
    const diff = Math.abs(itemsSum - totals.basic);
    const tolerance = Math.max(2, totals.basic * 0.01);
    if (diff <= tolerance) {
      score += 14;
    } else {
      score -= 12;
      warnings.push(`The line items add up to ${itemsSum.toFixed(2)} but the printed total reads ${totals.basic.toFixed(2)}. Check for a missed or misread line.`);
    }
  }

  if (totals.basic !== null && totals.grand !== null && gstRate !== null) {
    const expected = round2(totals.basic * (1 + gstRate / 100));
    if (Math.abs(expected - totals.grand) > Math.max(2, totals.grand * 0.01)) {
      score -= 8;
      warnings.push(`Basic ${totals.basic.toFixed(2)} at ${gstRate}% should give ${expected.toFixed(2)}, but the grand total reads ${totals.grand.toFixed(2)}.`);
    }
  }

  if (gstin && pan) {
    const derived = gstin.slice(2, 12);
    if (derived !== pan) {
      warnings.push(`The PAN on the document (${pan}) does not match the PAN inside the GSTIN (${derived}).`);
      score -= 6;
    }
  }

  if (items.some((i) => !i.reconciled)) score -= 5;
  if (source === 'ocr') score = Math.round(score * 0.82);

  const confidence = Math.max(0, Math.min(100, Math.round(score)));

  if (!items.length) {
    warnings.push('No line items could be read. Add them by hand, or pull them from another vendor and adjust.');
  }

  return {
    ok: true,
    source,
    confidence,
    fields: {
      vendor_name: vendorName,
      vendor_gstin: gstin,
      vendor_pan: pan,
      quotation_ref: quotationRef,
      quotation_date: quotationDate,
      validity_days: validityDays,
      delivery_days: delivery.days,
      delivery_text: delivery.text,
      delivery_basis: delivery.basis,
      advance_percent: payment.advancePercent,
      credit_days: payment.creditDays,
      retention_percent: payment.retentionPercent,
      payment_terms_text: payment.text,
      gst_rate: gstRate,
      quoted_basic: totals.basic,
      quoted_total: totals.grand,
    },
    items,
    warnings,
  };
}
