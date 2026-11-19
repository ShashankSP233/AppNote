// GST split, TDS and TCS.
//
// IMPORTANT — the rates below are DEFAULTS to save typing, not authority.
// Finance Act rates, thresholds and section numbers change every year, and the
// right section for a given supply is a judgement call. Accounts must confirm
// the section and rate on each note; every figure this module produces is
// editable in the accounts screen before it reaches the document.

import { num, round2 } from './domain.js';

export const GST_RATES = [0, 0.1, 0.25, 1, 1.5, 3, 5, 6, 7.5, 12, 18, 28];

export const SUPPLY_TYPES = [
  { value: 'goods', label: 'Goods' },
  { value: 'services', label: 'Services' },
  { value: 'works_contract', label: 'Works contract' },
];

/**
 * Intra-state supply splits into CGST + SGST; inter-state is IGST.
 * Halving is done on the paise so the two halves always re-add to the total.
 */
export function gstSplit(taxableValue, rate, { interState = false } = {}) {
  const base = round2(taxableValue);
  const r = num(rate);
  const total = round2(base * r / 100);
  if (interState) {
    return { interState: true, rate: r, taxable: base, igst: total, cgst: 0, sgst: 0, total };
  }
  const halfPaise = Math.round(total * 100) / 2;
  const cgst = round2(Math.floor(halfPaise) / 100);
  const sgst = round2(total - cgst);
  return { interState: false, rate: r, taxable: base, igst: 0, cgst, sgst, total };
}

/**
 * Totals for a note. Items are grouped by the effective GST rate — accounts'
 * verified rate wins over the rate purchase proposed.
 */
export function noteTotals(items = [], { interState = false, roundOff = true } = {}) {
  const groups = new Map();
  let basic = 0;

  for (const item of items) {
    const quantity = num(item.quantity, 0);
    const rate = num(item.rate, 0);
    const lineAmount = item.amount !== null && item.amount !== undefined && item.amount !== ''
      ? num(item.amount)
      : round2(quantity * rate);
    const discount = num(item.discount_amount, 0);
    const taxable = round2(lineAmount - discount);

    const effectiveRate = item.tax_verified && item.verified_gst_rate !== null
      && item.verified_gst_rate !== undefined && item.verified_gst_rate !== ''
      ? num(item.verified_gst_rate)
      : num(item.gst_rate, 18);

    basic = round2(basic + taxable);
    const key = String(effectiveRate);
    const prev = groups.get(key) || { rate: effectiveRate, taxable: 0 };
    prev.taxable = round2(prev.taxable + taxable);
    groups.set(key, prev);
  }

  const breakdown = [...groups.values()]
    .sort((a, b) => a.rate - b.rate)
    .map((g) => ({ ...gstSplit(g.taxable, g.rate, { interState }) }));

  const gstTotal = round2(breakdown.reduce((s, g) => s + g.total, 0));
  const cgstTotal = round2(breakdown.reduce((s, g) => s + g.cgst, 0));
  const sgstTotal = round2(breakdown.reduce((s, g) => s + g.sgst, 0));
  const igstTotal = round2(breakdown.reduce((s, g) => s + g.igst, 0));

  const beforeRounding = round2(basic + gstTotal);

  // Indian invoices settle to whole rupees with a round-off line. All three
  // house samples do this, so it is on by default.
  const grandTotal = roundOff ? Math.round(beforeRounding) : beforeRounding;
  const rounding = round2(grandTotal - beforeRounding);

  return {
    interState,
    basic,
    breakdown,
    cgstTotal,
    sgstTotal,
    igstTotal,
    gstTotal,
    beforeRounding,
    rounding,
    grandTotal,
    mixedRates: breakdown.length > 1,
  };
}

// ---------------------------------------------------------------------------
// TDS — tax deducted at source, withheld from the vendor's payment
// ---------------------------------------------------------------------------

export const TDS_SECTIONS = [
  {
    code: '194C',
    label: 'Payment to contractors / sub-contractors',
    rates: { individual_huf: 1, company: 2, firm: 2, other: 2 },
    singleThreshold: 30000,
    annualThreshold: 100000,
    appliesTo: ['services', 'works_contract'],
    note: 'Single payment above ₹30,000 or aggregate above ₹1,00,000 in the year.',
  },
  {
    code: '194J-P',
    label: 'Professional fees',
    rates: { individual_huf: 10, company: 10, firm: 10, other: 10 },
    annualThreshold: 30000,
    appliesTo: ['services'],
    note: 'Professional or technical services — professional rate.',
  },
  {
    code: '194J-T',
    label: 'Technical services / call centre',
    rates: { individual_huf: 2, company: 2, firm: 2, other: 2 },
    annualThreshold: 30000,
    appliesTo: ['services'],
    note: 'Technical services other than professional.',
  },
  {
    code: '194I-a',
    label: 'Rent — plant, machinery, equipment',
    rates: { individual_huf: 2, company: 2, firm: 2, other: 2 },
    annualThreshold: 240000,
    appliesTo: ['services'],
    note: 'Hire of plant, machinery or equipment.',
  },
  {
    code: '194I-b',
    label: 'Rent — land, building, furniture',
    rates: { individual_huf: 10, company: 10, firm: 10, other: 10 },
    annualThreshold: 240000,
    appliesTo: ['services'],
    note: 'Rent of land, building or furniture.',
  },
  {
    code: '194H',
    label: 'Commission or brokerage',
    rates: { individual_huf: 2, company: 2, firm: 2, other: 2 },
    annualThreshold: 20000,
    appliesTo: ['services'],
    note: 'Commission or brokerage payments.',
  },
  {
    code: '194Q',
    label: 'Purchase of goods',
    rates: { individual_huf: 0.1, company: 0.1, firm: 0.1, other: 0.1 },
    annualThreshold: 5000000,
    appliesTo: ['goods'],
    note: 'On value above ₹50 lakh to one seller in the year, where buyer turnover exceeds ₹10 crore. Mutually exclusive with TCS 206C(1H).',
    excessOnly: true,
  },
];

export const TCS_SECTIONS = [
  {
    code: '206C-1',
    label: 'Scrap, minerals, forest produce',
    rates: { individual_huf: 1, company: 1, firm: 1, other: 1 },
    note: 'Collected by the seller on specified goods such as scrap.',
  },
  {
    code: '206C-1F',
    label: 'Motor vehicle above ₹10 lakh',
    rates: { individual_huf: 1, company: 1, firm: 1, other: 1 },
    note: 'On sale of a motor vehicle exceeding ₹10 lakh.',
  },
  {
    code: '206C-1H',
    label: 'Sale of goods above ₹50 lakh',
    rates: { individual_huf: 0.1, company: 0.1, firm: 0.1, other: 0.1 },
    annualThreshold: 5000000,
    excessOnly: true,
    withdrawnFrom: '2025-04-01',
    note: 'Withdrawn with effect from 01-Apr-2025; retained for older notes. Mutually exclusive with TDS 194Q.',
  },
];

export function findTdsSection(code) {
  if (!code) return null;
  return TDS_SECTIONS.find((s) => s.code.toLowerCase() === String(code).toLowerCase()) || null;
}

export function findTcsSection(code) {
  if (!code) return null;
  return TCS_SECTIONS.find((s) => s.code.toLowerCase() === String(code).toLowerCase()) || null;
}

/**
 * A starting suggestion only. Returns the section, the rate after any
 * 206AA/206AB escalation, and the reasons so accounts can see the working.
 */
export function suggestTds({
  supplyType = 'goods',
  basicAmount = 0,
  constitution = 'other',
  hasPan = true,
  isSpecifiedPerson = false,
} = {}) {
  const base = round2(basicAmount);
  const warnings = [];

  const candidates = TDS_SECTIONS.filter((s) => s.appliesTo?.includes(supplyType));
  const section = candidates[0] || null;

  if (!section) {
    return { applicable: false, section: null, rate: 0, base, amount: 0, warnings, reasons: ['No default section matches this supply type.'] };
  }

  const reasons = [];
  let rate = section.rates[constitution] ?? section.rates.other;
  reasons.push(`${section.code} at ${rate}% for a ${constitution.replace('_', '/')} payee.`);

  let applicable = true;
  if (section.singleThreshold && base < section.singleThreshold) {
    applicable = false;
    reasons.push(`Single payment ₹${base} is below the ₹${section.singleThreshold} threshold — confirm the year-to-date aggregate before waiving.`);
  }
  if (section.annualThreshold && base < section.annualThreshold && !section.singleThreshold) {
    applicable = false;
    reasons.push(`Below the ₹${section.annualThreshold} annual threshold — confirm the year-to-date aggregate before waiving.`);
  }

  // 206AA: no PAN → higher of the section rate or 20%.
  if (!hasPan) {
    const escalated = Math.max(rate, 20);
    if (escalated !== rate) {
      reasons.push(`Section 206AA: PAN not available, rate raised from ${rate}% to ${escalated}%.`);
      rate = escalated;
    }
    applicable = true;
    warnings.push('PAN is not on record. Section 206AA applies and deduction cannot be waived on threshold.');
  }

  // 206AB: non-filer → higher of twice the rate or 5%.
  if (isSpecifiedPerson) {
    const escalated = Math.max(rate * 2, 5);
    reasons.push(`Section 206AB: payee flagged as a non-filer, rate raised from ${rate}% to ${escalated}%.`);
    rate = escalated;
    applicable = true;
    warnings.push('Vendor is flagged as a specified person under 206AB. Verify on the income-tax compliance portal before deducting.');
  }

  let taxBase = base;
  if (section.excessOnly && section.annualThreshold) {
    taxBase = round2(Math.max(0, base - section.annualThreshold));
    reasons.push(`${section.code} applies only to the value above ₹${section.annualThreshold}.`);
  }

  const amount = applicable ? round2(taxBase * rate / 100) : 0;

  if (section.code === '194Q') {
    warnings.push('194Q and TCS 206C(1H) are mutually exclusive. If the seller is already collecting TCS, do not also deduct under 194Q.');
  }

  return { applicable, section: section.code, sectionLabel: section.label, rate, base: taxBase, amount, reasons, warnings };
}

/**
 * Final deduction figures for a note.
 * TDS is withheld from the payment; TCS is charged by the seller and added to
 * it. Net payable = grand total − TDS + TCS.
 */
export function computeDeductions({
  basic = 0,
  gstTotal = 0,
  grandTotal = 0,
  tds = {},
  tcs = {},
  tdsOnGrossTotal = false,
} = {}) {
  const warnings = [];

  const tdsApplicable = Boolean(tds.applicable);
  const tdsRate = num(tds.rate, 0);
  const tdsBase = tds.base !== undefined && tds.base !== null && tds.base !== ''
    ? round2(tds.base)
    : round2(tdsOnGrossTotal ? grandTotal : basic);
  const tdsAmount = tds.amount !== undefined && tds.amount !== null && tds.amount !== ''
    ? round2(tds.amount)
    : (tdsApplicable ? round2(tdsBase * tdsRate / 100) : 0);

  if (tdsApplicable && gstTotal > 0 && round2(tdsBase) >= round2(grandTotal)) {
    warnings.push('TDS has been computed on the GST-inclusive value. Where GST is shown separately on the invoice, CBDT Circular 23/2017 requires deduction on the taxable value only.');
  }
  if (tdsApplicable && tdsRate <= 0) {
    warnings.push('TDS is marked applicable but the rate is zero.');
  }

  const tcsApplicable = Boolean(tcs.applicable);
  const tcsRate = num(tcs.rate, 0);
  const tcsBase = tcs.base !== undefined && tcs.base !== null && tcs.base !== ''
    ? round2(tcs.base)
    : round2(grandTotal);
  const tcsAmount = tcs.amount !== undefined && tcs.amount !== null && tcs.amount !== ''
    ? round2(tcs.amount)
    : (tcsApplicable ? round2(tcsBase * tcsRate / 100) : 0);

  if (tdsApplicable && tcsApplicable && tds.section === '194Q' && tcs.section === '206C-1H') {
    warnings.push('194Q and 206C(1H) cannot both apply to the same transaction. Decide which one governs.');
  }

  const netPayable = round2(num(grandTotal) - tdsAmount + tcsAmount);

  return {
    tds: { applicable: tdsApplicable, section: tds.section || null, rate: tdsRate, base: tdsBase, amount: tdsAmount },
    tcs: { applicable: tcsApplicable, section: tcs.section || null, rate: tcsRate, base: tcsBase, amount: tcsAmount },
    grandTotal: round2(grandTotal),
    netPayable,
    warnings,
  };
}

/**
 * Turns the milestone definitions into money, and reports whether they
 * reconcile against the payable value.
 */
export function schedulePayments(milestones = [], { basic = 0, grandTotal = 0, netPayable = null } = {}) {
  const target = netPayable !== null && netPayable !== undefined ? round2(netPayable) : round2(grandTotal);

  const rows = milestones.map((m, index) => {
    const basisValue = m.basis === 'basic' ? num(basic) : num(grandTotal);
    let amount;
    if (m.fixed_amount !== null && m.fixed_amount !== undefined && m.fixed_amount !== '') {
      amount = round2(m.fixed_amount);
    } else {
      amount = round2(basisValue * num(m.percent, 0) / 100);
    }
    return {
      line_no: m.line_no ?? index + 1,
      milestone: m.milestone,
      trigger_event: m.trigger_event || null,
      due_offset_days: m.due_offset_days ?? null,
      due_date: m.due_date || null,
      percent: m.percent !== null && m.percent !== undefined ? num(m.percent) : null,
      basis: m.basis || 'grand_total',
      is_retention: Boolean(m.is_retention),
      amount,
      remarks: m.remarks || null,
    };
  });

  const scheduled = round2(rows.reduce((s, r) => s + r.amount, 0));
  const difference = round2(target - scheduled);
  const retention = round2(rows.filter((r) => r.is_retention).reduce((s, r) => s + r.amount, 0));

  const warnings = [];
  if (rows.length && Math.abs(difference) > 1) {
    warnings.push(`The payment schedule totals ${scheduled.toFixed(2)} against a payable value of ${target.toFixed(2)}, a difference of ${difference.toFixed(2)}.`);
  }

  return { rows, scheduled, target, difference, retention, reconciles: Math.abs(difference) <= 1, warnings };
}

export const TAX_DISCLAIMER =
  'Rates and thresholds shown are defaults for convenience. They change with each Finance Act and the correct section depends on the nature of the supply. Accounts must confirm every figure before the note is approved.';
