// Vendor comparison across four axes: price, delivery, payment terms and
// technical compliance. The comparison is NOT limited to price — landed cost
// decides L1, but delivery and payment terms carry their own weight, and
// technical criteria are scored by the preparer.

import { num, round2 } from './domain.js';
import { gstSplit } from './tax.js';

export const DEFAULT_WEIGHTS = Object.freeze({
  price: 50,
  delivery: 20,
  payment: 15,
  technical: 15,
});

export const CRITERION_CATEGORIES = [
  { value: 'technical', label: 'Technical' },
  { value: 'commercial', label: 'Commercial' },
  { value: 'delivery', label: 'Delivery' },
  { value: 'payment', label: 'Payment' },
  { value: 'other', label: 'Other' },
];

/**
 * Landed cost = items − discount + freight + other charges, then GST.
 * Optional and not-quoted lines are excluded from the comparable value, so
 * vendors are compared on the same scope.
 */
export function quotationCost(quotation, { interState = false, includeOptional = false } = {}) {
  const items = quotation.items || [];
  const hasPricedLines = items.some((item) => !item.not_quoted && (includeOptional || !item.is_optional)
    && (num(item.amount, 0) !== 0 || num(item.rate, 0) !== 0));
  const hasOptionalOnlyPricing = !hasPricedLines && items.some((item) => !item.not_quoted && item.is_optional
    && (num(item.amount, 0) !== 0 || num(item.rate, 0) !== 0));
  const hasQuotedBasic = quotation.quoted_basic !== null && quotation.quoted_basic !== undefined && quotation.quoted_basic !== '';
  const hasQuotedTotal = quotation.quoted_total !== null && quotation.quoted_total !== undefined && quotation.quoted_total !== '';
  const lineGstRates = [...new Set(items.filter((item) => !item.not_quoted && item.gst_rate !== null
    && item.gst_rate !== undefined && item.gst_rate !== '').map((item) => num(item.gst_rate)))];
  const headerGstRate = quotation.gst_rate !== null && quotation.gst_rate !== undefined && quotation.gst_rate !== ''
    ? num(quotation.gst_rate) : null;
  let itemsTotal = 0;
  let optionalTotal = 0;
  let notQuoted = 0;

  for (const item of items) {
    if (item.not_quoted) { notQuoted += 1; continue; }
    const amount = item.amount !== null && item.amount !== undefined && item.amount !== ''
      ? num(item.amount)
      : round2(num(item.quantity, 0) * num(item.rate, 0));
    if (item.is_optional) {
      optionalTotal = round2(optionalTotal + amount);
      if (!includeOptional) continue;
    }
    itemsTotal = round2(itemsTotal + amount);
  }

  // Fall back to printed figures when line pricing was not captured.
  if (!hasPricedLines && hasQuotedBasic) {
    itemsTotal = round2(quotation.quoted_basic);
  }

  const discount = num(quotation.discount_amount, 0);
  const freight = num(quotation.freight_amount, 0);
  const other = num(quotation.other_charges, 0);

  const hasLineBreakdown = hasPricedLines || hasQuotedBasic;
  const taxable = hasLineBreakdown ? round2(itemsTotal - discount + freight + other) : null;
  const gstRateAssumed = headerGstRate === null && lineGstRates.length !== 1;
  const gstRate = headerGstRate ?? (lineGstRates.length === 1 ? lineGstRates[0] : 18);
  const gst = hasLineBreakdown ? gstSplit(taxable, gstRate, { interState }) : null;
  const quotedTotal = hasQuotedTotal ? round2(quotation.quoted_total) : null;
  // A total that includes only optional lines cannot stand in for the
  // comparable required scope. Ask for a required-line value or quoted basic.
  const useQuotedTotal = !hasPricedLines && !hasOptionalOnlyPricing && quotedTotal !== null;
  const invalidPrice = useQuotedTotal ? quotedTotal < 0 : (hasLineBreakdown && taxable < 0);

  return {
    itemsTotal,
    optionalTotal,
    notQuotedCount: notQuoted,
    discount,
    freight,
    other,
    basic: hasLineBreakdown ? taxable : null,
    gstRate,
    gstRateAssumed,
    mixedItemGstRates: lineGstRates.length > 1,
    gstAmount: gst?.total ?? null,
    landed: useQuotedTotal ? quotedTotal : (hasLineBreakdown ? round2(taxable + gst.total) : 0),
    calculatedLanded: hasLineBreakdown ? round2(taxable + gst.total) : null,
    lineCount: items.length,
    hasComparableValue: !invalidPrice && (hasPricedLines || hasQuotedBasic || (quotedTotal !== null && !hasOptionalOnlyPricing)),
    hasOptionalOnlyPricing,
    invalidPrice,
    hasBreakdown: hasLineBreakdown,
    quotedTotal,
  };
}

/**
 * Converts payment terms into a cash-flow score input. Positive days mean
 * payment is deferred (better for the buyer); negative days mean money is paid
 * before delivery (worse for the buyer). Retention needs its actual release
 * period; we do not invent a default. Higher is better.
 */
export function paymentTimingDays(quotation) {
  const hasNumericTerms = [quotation.advance_percent, quotation.retention_percent, quotation.credit_days]
    .some((value) => value !== null && value !== undefined && value !== '');
  if (!hasNumericTerms) return null;

  const advance = Math.min(100, Math.max(0, num(quotation.advance_percent, 0)));
  const retention = Math.min(100 - advance, Math.max(0, num(quotation.retention_percent, 0)));
  const credit = Math.max(0, num(quotation.credit_days, 0));
  if (advance > 0 && (quotation.delivery_days === null || quotation.delivery_days === undefined || quotation.delivery_days === '')) {
    return null;
  }
  if (retention > 0 && (quotation.retention_release_days === null || quotation.retention_release_days === undefined
    || quotation.retention_release_days === '')) return null;
  const deliveryDays = num(quotation.delivery_days, 0);

  const balance = Math.max(0, 100 - advance - retention);

  // Advance leaves our hands immediately: zero days of holding, and we carry
  // the money across the delivery period, so it scores worst.
  const advanceDays = -deliveryDays;
  const balanceDays = credit;
  const retentionDays = retention > 0 ? Math.max(0, num(quotation.retention_release_days, 0)) : 0;

  const weighted = (advance * advanceDays + balance * balanceDays + retention * retentionDays) / 100;
  return round2(weighted);
}

function rankAscending(entries, valueOf) {
  const sortable = entries
    .map((e, index) => ({ index, value: valueOf(e) }))
    .filter((e) => Number.isFinite(e.value));
  sortable.sort((a, b) => a.value - b.value);

  const ranks = new Array(entries.length).fill(null);
  let lastValue = null;
  let lastRank = 0;
  sortable.forEach((entry, position) => {
    if (lastValue !== null && Math.abs(entry.value - lastValue) < 0.005) {
      ranks[entry.index] = lastRank;
    } else {
      lastRank = position + 1;
      ranks[entry.index] = lastRank;
      lastValue = entry.value;
    }
  });
  return ranks;
}

/** Best value scores 10, worst scores 0, the rest interpolate. */
function normaliseLowerIsBetter(values) {
  const finite = values.filter((v) => Number.isFinite(v));
  if (!finite.length) return values.map(() => null);
  const min = Math.min(...finite);
  const max = Math.max(...finite);
  if (Math.abs(max - min) < 0.005) return values.map((v) => (Number.isFinite(v) ? 10 : null));
  return values.map((v) => (Number.isFinite(v) ? round2(10 * (max - v) / (max - min)) : null));
}

function normaliseHigherIsBetter(values) {
  const finite = values.filter((v) => Number.isFinite(v));
  if (!finite.length) return values.map(() => null);
  const min = Math.min(...finite);
  const max = Math.max(...finite);
  if (Math.abs(max - min) < 0.005) return values.map((v) => (Number.isFinite(v) ? 10 : null));
  return values.map((v) => (Number.isFinite(v) ? round2(10 * (v - min) / (max - min)) : null));
}

/**
 * Builds the complete comparison for a note.
 *
 * quotations: rows with .items, .id, .vendor_name and the term fields
 * criteria:   [{ id, category, label, requirement, weight, values: {quotationId: {score, value_text, complies}} }]
 */
export function buildComparison({
  quotations = [],
  criteria = [],
  weights = DEFAULT_WEIGHTS,
  interState = false,
  selectedQuotationId = null,
} = {}) {
  // Superseded versions are normally filtered out upstream, but a direct
  // caller may hand over a whole chain; only the live offers are compared.
  const live = quotations.filter((q) => !q.is_excluded && !q.is_superseded);

  const w = { ...DEFAULT_WEIGHTS, ...(weights || {}) };
  for (const key of ['price', 'delivery', 'payment', 'technical']) {
    w[key] = Math.max(0, num(w[key], 0));
  }
  let weightTotal = num(w.price) + num(w.delivery) + num(w.payment) + num(w.technical);
  if (weightTotal <= 0) {
    Object.assign(w, DEFAULT_WEIGHTS);
    weightTotal = DEFAULT_WEIGHTS.price + DEFAULT_WEIGHTS.delivery + DEFAULT_WEIGHTS.payment + DEFAULT_WEIGHTS.technical;
  }
  const normWeights = weightTotal > 0
    ? {
      price: num(w.price) / weightTotal,
      delivery: num(w.delivery) / weightTotal,
      payment: num(w.payment) / weightTotal,
      technical: num(w.technical) / weightTotal,
    }
    : { price: 0.5, delivery: 0.2, payment: 0.15, technical: 0.15 };

  const rows = live.map((q) => {
    const cost = quotationCost(q, { interState });
    const timing = paymentTimingDays(q);
    const deliveryDays = q.delivery_days !== null && q.delivery_days !== undefined && q.delivery_days !== ''
      ? num(q.delivery_days)
      : null;
    return {
      quotation_id: q.id,
      vendor_name: q.vendor_name,
      vendor_id: q.vendor_id ?? null,
      vendor_gstin: q.vendor_gstin || null,
      vendor_city: q.vendor_city || null,
      quotation_ref: q.quotation_ref || null,
      quotation_date: q.quotation_date || null,
      validity_days: q.validity_days ?? null,
      cost,
      quoted_total: q.quoted_total === null || q.quoted_total === undefined || q.quoted_total === '' ? null : num(q.quoted_total),
      delivery_days: deliveryDays,
      delivery_text: q.delivery_text || null,
      delivery_basis: q.delivery_basis || null,
      advance_percent: q.advance_percent !== null && q.advance_percent !== undefined ? num(q.advance_percent) : null,
      credit_days: q.credit_days ?? null,
      retention_percent: q.retention_percent !== null && q.retention_percent !== undefined ? num(q.retention_percent) : null,
      retention_release_days: q.retention_release_days !== null && q.retention_release_days !== undefined
        ? num(q.retention_release_days) : null,
      payment_terms_text: q.payment_terms_text || null,
      payment_timing_days: timing,
      warranty_text: q.warranty_text || null,
      remarks: q.remarks || null,
      extraction_status: q.extraction_status || 'none',
      extraction_confidence: q.extraction_confidence ?? null,
      source: q.source || 'manual',
      version_no: q.version_no ?? 1,
      version_count: q.version_count ?? 1,
      revision_note: q.revision_note || null,
      // What the first offer from this vendor came in at, so the comparison
      // can show what negotiation actually achieved.
      first_offer: (q.history && q.history.length)
        ? (() => {
          const firstCost = quotationCost(q.history[q.history.length - 1], { interState });
          return firstCost.hasComparableValue ? firstCost.landed : null;
        })()
        : null,
      is_selected: selectedQuotationId !== null
        && (q.id === selectedQuotationId
          || Boolean(q.history?.some((h) => h.id === selectedQuotationId))),
    };
  });

  for (const row of rows) {
    row.negotiated = row.first_offer !== null && row.cost.hasComparableValue
      ? round2(row.first_offer - row.cost.landed)
      : 0;
  }

  // --- Technical scores from the criteria grid -----------------------------
  const technicalScores = rows.map((row) => {
    let weighted = 0;
    let weightSum = 0;
    let mandatoryFailures = 0;

    for (const criterion of criteria) {
      const value = criterion.values?.[row.quotation_id];
      const cw = Math.max(0, num(criterion.weight, 1));
      if (criterion.is_mandatory && (!value || value.complies !== true)) mandatoryFailures += 1;
      if (cw === 0) continue;
      if (!value || value.score === null || value.score === undefined || value.score === '') continue;
      weighted += num(value.score) * cw;
      weightSum += cw;
    }
    return {
      score: weightSum > 0 ? round2(weighted / weightSum) : null,
      mandatoryFailures,
      scored: weightSum > 0,
    };
  });

  // --- Per-axis normalisation ---------------------------------------------
  const priceScores = normaliseLowerIsBetter(rows.map((r) => (r.cost.hasComparableValue ? r.cost.landed : NaN)));
  const deliveryScores = normaliseLowerIsBetter(
    rows.map((r) => (r.delivery_days === null ? NaN : r.delivery_days)),
  );
  const paymentScores = normaliseHigherIsBetter(rows.map((r) => r.payment_timing_days));

  const priceRanks = rankAscending(rows, (r) => (r.cost.hasComparableValue ? r.cost.landed : NaN));
  const deliveryRanks = rankAscending(rows, (r) => (r.delivery_days === null ? NaN : r.delivery_days));

  rows.forEach((row, i) => {
    row.price_rank = priceRanks[i];
    row.price_score = priceScores[i];
    row.delivery_rank = deliveryRanks[i];
    row.delivery_score = deliveryScores[i];
    row.payment_score = paymentScores[i];
    row.technical_score = technicalScores[i].score;
    row.technical_scored = technicalScores[i].scored;
    row.mandatory_failures = technicalScores[i].mandatoryFailures;

    // Keep a common denominator for every vendor. An applicable axis with
    // missing vendor data scores zero; an axis absent for all vendors is
    // omitted so it cannot distort the comparison.
    const parts = [
      { key: 'price', score: row.price_score, weight: normWeights.price, active: rows.some((r) => r.price_score !== null) },
      { key: 'delivery', score: row.delivery_score, weight: normWeights.delivery, active: rows.some((r) => r.delivery_score !== null) },
      { key: 'payment', score: row.payment_score, weight: normWeights.payment, active: rows.some((r) => r.payment_score !== null) },
      { key: 'technical', score: row.technical_score, weight: normWeights.technical, active: criteria.some((c) => Math.max(0, num(c.weight, 1)) > 0) },
    ].filter((p) => p.active && p.weight > 0);

    const availableWeight = parts.reduce((s, p) => s + p.weight, 0);
    // A non-price score is not a complete procurement comparison. Offers
    // without a comparable landed value stay visible but cannot receive an
    // overall score or rank (the selection flow has the same requirement).
    row.overall_score = row.cost.hasComparableValue && availableWeight > 0
      ? round2(parts.reduce((s, p) => s + (Number.isFinite(p.score) ? p.score : 0) * p.weight, 0) / availableWeight)
      : null;
    row.scored_axes = parts.filter((p) => Number.isFinite(p.score)).map((p) => p.key);
    row.incomplete_axes = parts.filter((p) => !Number.isFinite(p.score)).map((p) => p.key);
  });

  const overallRanks = rankAscending(rows, (r) => (
    !r.cost.hasComparableValue || r.overall_score === null || r.mandatory_failures > 0 ? NaN : -r.overall_score
  ));
  rows.forEach((row, i) => { row.overall_rank = overallRanks[i]; });

  // L1/L2/L3 by landed cost
  const byPrice = rows.filter((r) => r.cost.hasComparableValue).sort((a, b) => a.cost.landed - b.cost.landed);
  const lowest = byPrice[0] || null;
  const best = [...rows].filter((r) => r.cost.hasComparableValue && r.overall_score !== null && r.mandatory_failures === 0)
    .sort((a, b) => b.overall_score - a.overall_score)[0] || null;
  const selected = rows.find((r) => r.is_selected) || null;

  // --- Flags the reviewer should see --------------------------------------
  const flags = [];

  if (rows.length === 0) {
    flags.push({ level: 'blocking', message: 'No quotations have been captured for this note.' });
  } else if (rows.length === 1) {
    flags.push({ level: 'advisory', message: 'Only one quotation is on record. A single-source purchase needs a written justification.' });
  }

  const unreviewed = rows.filter((r) => r.extraction_status === 'extracted');
  if (unreviewed.length) {
    flags.push({
      level: 'blocking',
      message: `${unreviewed.length} quotation(s) carry machine-read figures that nobody has confirmed: ${unreviewed.map((r) => r.vendor_name).join(', ')}.`,
    });
  }

  const lowConfidence = rows.filter((r) => r.extraction_confidence !== null && r.extraction_confidence < 60 && r.source !== 'manual');
  if (lowConfidence.length) {
    flags.push({
      level: 'advisory',
      message: `Low extraction confidence on ${lowConfidence.map((r) => `${r.vendor_name} (${r.extraction_confidence}%)`).join(', ')}. Check these against the attached copy line by line.`,
    });
  }

  const noDelivery = rows.filter((r) => r.delivery_days === null);
  if (noDelivery.length && rows.length > 1) {
    flags.push({
      level: 'advisory',
      message: `Delivery period is not recorded for ${noDelivery.map((r) => r.vendor_name).join(', ')}, so the delivery comparison is incomplete.`,
    });
  }

  const noPrice = rows.filter((r) => !r.cost.hasComparableValue && !r.cost.invalidPrice);
  if (noPrice.length) {
    flags.push({
      level: 'advisory',
      message: `No comparable quotation total or priced lines are recorded for ${noPrice.map((r) => r.vendor_name).join(', ')}. The price axis cannot be scored for these offers.`,
    });
  }

  const optionalOnlyPrice = rows.filter((r) => r.cost.hasOptionalOnlyPricing && !r.cost.hasComparableValue);
  if (optionalOnlyPrice.length) {
    flags.push({
      level: 'advisory',
      message: `Only optional lines have prices for ${optionalOnlyPrice.map((r) => r.vendor_name).join(', ')}. Enter the value for the required scope before comparing or selecting these offers.`,
    });
  }

  const invalidPrice = rows.filter((r) => r.cost.invalidPrice);
  if (invalidPrice.length) {
    flags.push({
      level: 'advisory',
      message: `The recorded discount or quoted total results in a negative value for ${invalidPrice.map((r) => r.vendor_name).join(', ')}. Correct the quotation figures; these offers are excluded from price ranking.`,
    });
  }

  const totalMismatch = rows.filter((r) => r.cost.calculatedLanded !== null && r.quoted_total !== null
    && Math.abs(r.quoted_total - r.cost.calculatedLanded) > 1);
  if (totalMismatch.length) {
    flags.push({
      level: 'advisory',
      message: `The calculated landed value differs from the printed quotation total by more than ₹1 for ${totalMismatch.map((r) => `${r.vendor_name} (printed ₹${r.quoted_total.toFixed(2)}, calculated ₹${r.cost.calculatedLanded.toFixed(2)})`).join('; ')}. The ranking uses the printed total when no priced lines were captured; check tax, freight, discount and scope.`,
    });
  }

  const gstAssumed = rows.filter((r) => r.cost.hasBreakdown && r.cost.gstRateAssumed && !r.cost.mixedItemGstRates);
  if (gstAssumed.length) {
    flags.push({
      level: 'advisory',
      message: `No GST rate was captured for ${gstAssumed.map((r) => r.vendor_name).join(', ')}. Their calculated landed value assumes 18% GST; confirm the printed quotation before relying on the price ranking.`,
    });
  }

  const mixedGst = rows.filter((r) => r.cost.hasBreakdown && r.cost.mixedItemGstRates);
  if (mixedGst.length) {
    flags.push({
      level: 'advisory',
      message: `Multiple item GST rates were captured for ${mixedGst.map((r) => r.vendor_name).join(', ')}. The comparison currently applies one rate across the taxable amount; check those offers manually.`,
    });
  }

  const noPaymentTerms = rows.filter((r) => r.payment_timing_days === null);
  if (noPaymentTerms.length) {
    flags.push({
      level: 'advisory',
      message: `Payment terms cannot be scored from structured fields for ${noPaymentTerms.map((r) => r.vendor_name).join(', ')}. Enter advance, credit or retention values; advance needs a delivery period and retention needs its release period.`,
    });
  }

  const scopeMismatch = rows.filter((r) => r.cost.notQuotedCount > 0);
  if (scopeMismatch.length) {
    flags.push({
      level: 'advisory',
      message: `Some lines are not quoted by ${scopeMismatch.map((r) => `${r.vendor_name} (${r.cost.notQuotedCount})`).join(', ')}. The offers do not cover identical scope.`,
    });
  }

  const failedMandatory = rows.filter((r) => r.mandatory_failures > 0);
  if (failedMandatory.length) {
    flags.push({
      level: 'advisory',
      message: `Mandatory criteria not met by ${failedMandatory.map((r) => r.vendor_name).join(', ')}.`,
    });
  }

  const incomplete = rows.filter((r) => r.incomplete_axes?.length);
  if (incomplete.length) {
    flags.push({
      level: 'advisory',
      message: `Weighted scores use zero for missing information on applicable axes: ${incomplete.map((r) => `${r.vendor_name} (${r.incomplete_axes.join(', ')})`).join('; ')}. Complete those fields before relying on the ranking.`,
    });
  }

  if (selected && lowest && selected.cost.hasComparableValue && selected.quotation_id !== lowest.quotation_id) {
    const extra = round2(selected.cost.landed - lowest.cost.landed);
    flags.push({
      level: 'advisory',
      message: `The selected vendor is not the lowest offer. ${selected.vendor_name} is ₹${extra.toFixed(2)} above ${lowest.vendor_name}; the reason for selection must justify this.`,
    });
  }

  if (selected && selected.mandatory_failures > 0) {
    flags.push({ level: 'blocking', message: `${selected.vendor_name} has been selected but fails a mandatory criterion.` });
  }

  const expired = rows.filter((r) => {
    if (!r.quotation_date || !r.validity_days) return false;
    const d = new Date(r.quotation_date);
    if (Number.isNaN(d.getTime())) return false;
    d.setDate(d.getDate() + num(r.validity_days));
    return d < new Date();
  });
  if (expired.length) {
    flags.push({ level: 'advisory', message: `Validity has lapsed on the offer from ${expired.map((r) => r.vendor_name).join(', ')}.` });
  }

  return {
    rows,
    criteria,
    weights: w,
    lowest,
    best,
    selected,
    flags,
    interState,
    savingAgainstHighest: rows.length > 1 && selected?.cost.hasComparableValue && lowest
      ? round2(Math.max(...rows.filter((r) => r.cost.hasComparableValue).map((r) => r.cost.landed)) - selected.cost.landed)
      : 0,
  };
}

export function shortTerms(row) {
  if (!row) return '';
  const bits = [];
  if (row.advance_percent !== null && row.advance_percent !== undefined) bits.push(`${num(row.advance_percent)}% advance`);
  if (row.credit_days !== null && row.credit_days !== undefined) bits.push(`${num(row.credit_days)} days credit`);
  if (row.retention_percent !== null && row.retention_percent !== undefined) bits.push(`${num(row.retention_percent)}% retention`);
  if (row.retention_release_days !== null && row.retention_release_days !== undefined) {
    bits.push(`retention released ${num(row.retention_release_days)} days after delivery`);
  }
  if (!bits.length && row.payment_terms_text) {
    const text = String(row.payment_terms_text).trim();
    return text.length > 70 ? `${text.slice(0, 67)}…` : text;
  }
  if (!bits.length) return 'Not recorded';
  return bits.join(', ');
}

export function shortDelivery(row) {
  if (!row) return '';
  if (row.delivery_days !== null && row.delivery_days !== undefined) {
    const basis = row.delivery_basis ? ` (${row.delivery_basis})` : '';
    return `${num(row.delivery_days)} days${basis}`;
  }
  if (row.delivery_text) {
    const text = String(row.delivery_text).trim();
    return text.length > 50 ? `${text.slice(0, 47)}…` : text;
  }
  return 'Not recorded';
}

/** The condensed block that goes on the approval note front page. */
export function comparisonSummary(comparison) {
  if (!comparison || !comparison.rows.length) return null;
  const { rows, selected, lowest } = comparison;

  return {
    vendorCount: rows.length,
    rows: rows
      .slice()
      .sort((a, b) => Number(b.cost.hasComparableValue) - Number(a.cost.hasComparableValue)
        || a.cost.landed - b.cost.landed)
      .map((r) => ({
        vendor_name: r.vendor_name,
        landed: r.cost.hasComparableValue ? r.cost.landed : null,
        basic: r.cost.hasComparableValue ? r.cost.basic : null,
        price_rank: r.price_rank,
        overall_rank: r.overall_rank,
        delivery: shortDelivery(r),
        payment: shortTerms(r),
        is_selected: r.is_selected,
      })),
    selectedName: selected?.vendor_name || null,
    selectedLanded: selected?.cost.hasComparableValue ? selected.cost.landed : null,
    lowestName: lowest?.vendor_name || null,
    lowestLanded: lowest?.cost.landed ?? null,
    selectedPriceComparable: Boolean(selected?.cost.hasComparableValue),
    selectedIsLowest: Boolean(selected?.cost.hasComparableValue && lowest && selected.quotation_id === lowest.quotation_id),
    premium: selected?.cost.hasComparableValue && lowest ? round2(selected.cost.landed - lowest.cost.landed) : 0,
  };
}
