// Tests for the calculation and parsing logic. No database needed.
//
// The money arithmetic is checked against the three real approval notes the
// office supplied, so the output can be compared line for line with what was
// issued by hand.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  amountInWords, money, qty, round2, financialYear, formatDate,
  isValidGstin, isValidPan, panFromGstin, stateCodeFromGstin, constitutionFromPan,
  gstinChecksum,
} from '../src/domain.js';

import {
  gstSplit, noteTotals, suggestTds, computeDeductions, schedulePayments,
  findTdsSection, findTcsSection,
} from '../src/tax.js';

import {
  quotationCost, paymentTimingDays, buildComparison, comparisonSummary,
} from '../src/comparison.js';

import { attachVersionHistory, assessReadiness } from '../src/notes-repo.js';

import {
  parseAmount, parseLineItems, parseQuotation, findGstin, findPan,
  findDelivery, findPaymentTerms, findGstRate, findTotals, findVendorName, findDate,
} from '../src/extract/heuristics.js';

// ---------------------------------------------------------------------------
// Amount in words — checked against the issued notes
// ---------------------------------------------------------------------------

test('amount in words matches the Rainbow Marine note', () => {
  assert.equal(
    amountInWords(168315),
    'Rupees One Lakh Sixty Eight Thousand Three Hundred and Fifteen Only',
  );
});

test('amount in words matches the DK Enterprises note', () => {
  assert.equal(amountInWords(82600), 'Rupees Eighty Two Thousand Six Hundred Only');
});

test('amount in words matches the Jogighopa note', () => {
  assert.equal(
    amountInWords(487700),
    'Rupees Four Lakh Eighty Seven Thousand Seven Hundred Only',
  );
});

test('amount in words handles crores and paise', () => {
  assert.equal(amountInWords(12345678.5), 'Rupees One Crore Twenty Three Lakh Forty Five Thousand Six Hundred and Seventy Eight and Fifty Paise Only');
  assert.equal(amountInWords(0), 'Rupees Zero Only');
  assert.equal(amountInWords(100000), 'Rupees One Lakh Only');
  assert.equal(amountInWords(1000), 'Rupees One Thousand Only');
});

test('Indian digit grouping', () => {
  assert.equal(money(168315.2), '1,68,315.20');
  assert.equal(money(487700), '4,87,700.00');
  assert.equal(money(1234567.89), '12,34,567.89');
  assert.equal(qty(5000), '5,000');
  assert.equal(qty(2), '2');
  assert.equal(qty(1.5), '1.5');
});

test('rounding does not lose a paisa on the half', () => {
  assert.equal(round2(1.005), 1.01);
  assert.equal(round2(25675.199999), 25675.2);
});

// ---------------------------------------------------------------------------
// GSTIN and PAN
// ---------------------------------------------------------------------------

test('the real GSTINs from the sample notes validate', () => {
  assert.equal(isValidGstin('27CLLPV6143B1ZW'), true, 'Rainbow Marine');
  assert.equal(isValidGstin('19AISPB5151D1ZC'), true, 'DK Enterprises');
});

test('a tampered GSTIN fails the check digit', () => {
  assert.equal(isValidGstin('27CLLPV6143B1ZX'), false);
  assert.equal(isValidGstin('27CLLPV6143B1Z'), false);
  assert.equal(isValidGstin('99CLLPV6143B1ZW'), false, 'state code 99 is not a supply state');
  assert.equal(gstinChecksum('27CLLPV6143B1ZW'), 'W');
});

test('PAN is derived from the GSTIN and gives the constitution', () => {
  assert.equal(panFromGstin('27CLLPV6143B1ZW'), 'CLLPV6143B');
  assert.equal(stateCodeFromGstin('27CLLPV6143B1ZW'), '27');
  assert.equal(constitutionFromPan('AISPB5151D'), 'individual_huf');
  assert.equal(constitutionFromPan('AAACX1234C'), 'company');
  assert.equal(constitutionFromPan('AAAFX1234C'), 'firm');
  assert.equal(isValidPan('AISPB5151D'), true);
  assert.equal(isValidPan('AISPB5151'), false);
});

// ---------------------------------------------------------------------------
// Financial year and dates
// ---------------------------------------------------------------------------

test('the financial year rolls over on 1 April', () => {
  assert.equal(financialYear(new Date(2026, 6, 30)), '26-27', 'July 2026');
  assert.equal(financialYear(new Date(2026, 2, 31)), '25-26', '31 March 2026');
  assert.equal(financialYear(new Date(2026, 3, 1)), '26-27', '1 April 2026');
});

test('house date format', () => {
  assert.equal(formatDate(new Date(2026, 6, 30)), '30-July-2026');
});

// ---------------------------------------------------------------------------
// GST
// ---------------------------------------------------------------------------

test('intra-state supply splits into CGST and SGST that re-add exactly', () => {
  const split = gstSplit(142640, 18, { interState: false });
  assert.equal(split.total, 25675.2);
  assert.equal(round2(split.cgst + split.sgst), 25675.2);
  assert.equal(split.igst, 0);
});

test('inter-state supply is IGST', () => {
  const split = gstSplit(70000, 18, { interState: true });
  assert.equal(split.igst, 12600);
  assert.equal(split.cgst, 0);
  assert.equal(split.total, 12600);
});

test('halving an odd number of paise keeps the total exact', () => {
  const split = gstSplit(100.05, 18);
  assert.equal(round2(split.cgst + split.sgst), split.total);
});

test('note totals reproduce the Rainbow Marine note', () => {
  // The 19 lines exactly as printed on the issued note.
  const items = [
    { description: 'Hoist Turbo Charger Repair Service Kit', quantity: 2, rate: 20000, gst_rate: 18 },
    { description: 'Turbo charger Service and Labour Charges', quantity: 2, rate: 5500, gst_rate: 18 },
    { description: 'Pump Gasket Set', quantity: 2, rate: 3200, gst_rate: 18 },
    { description: 'Oil Seal Set', quantity: 2, rate: 1875, gst_rate: 18 },
    { description: 'Drive Shaft', quantity: 2, rate: 2100, gst_rate: 18 },
    { description: 'Teco Shaft', quantity: 2, rate: 1500, gst_rate: 18 },
    { description: 'Bearings', quantity: 2, rate: 325, gst_rate: 18 },
    { description: 'WC Assembly', quantity: 1, rate: 1570, gst_rate: 18 },
    { description: 'WC Bush and PIN', quantity: 1, rate: 1690, gst_rate: 18 },
    { description: 'Body Elbow', quantity: 2, rate: 815, gst_rate: 18 },
    { description: 'Screen Filter', quantity: 2, rate: 240, gst_rate: 18 },
    { description: 'Screen Filter Cup', quantity: 2, rate: 440, gst_rate: 18 },
    { description: 'Gear Pump Elbow', quantity: 2, rate: 410, gst_rate: 18 },
    { description: 'Drive Gear', quantity: 1, rate: 1125, gst_rate: 18 },
    { description: 'Mus Lock', quantity: 2, rate: 285, gst_rate: 18 },
    { description: 'Gear Pump', quantity: 1, rate: 15625, gst_rate: 18 },
    { description: 'Pump Calibration', quantity: 2, rate: 4375, gst_rate: 18 },
    { description: 'Injector Cup', quantity: 12, rate: 1500, gst_rate: 18 },
    { description: 'Injector Calibration', quantity: 12, rate: 1875, gst_rate: 18 },
  ];

  const totals = noteTotals(items, { interState: false });
  assert.equal(totals.basic, 142640);
  assert.equal(totals.gstTotal, 25675.2);
  assert.equal(totals.beforeRounding, 168315.2);
  assert.equal(totals.rounding, -0.2, 'settled to whole rupees as the issued note does');
  assert.equal(totals.grandTotal, 168315, 'matches the 1,68,315/- printed on the note');
  assert.equal(
    amountInWords(totals.grandTotal),
    'Rupees One Lakh Sixty Eight Thousand Three Hundred and Fifteen Only',
  );
});

test('round-off can be switched off where paise must be carried', () => {
  const items = [{ quantity: 1, rate: 142640, gst_rate: 18 }];
  const exact = noteTotals(items, { roundOff: false });
  assert.equal(exact.grandTotal, 168315.2);
  assert.equal(exact.rounding, 0);
});

test('note totals reproduce the DK Enterprises note', () => {
  const items = [
    { description: 'Pipe', quantity: 1, rate: 15000, gst_rate: 18 },
    { description: 'Sensor', quantity: 1, rate: 3500, gst_rate: 18 },
    { description: 'Thermostat', quantity: 1, rate: 2500, gst_rate: 18 },
    { description: 'Hose Pipe Set', quantity: 1, rate: 4500, gst_rate: 18 },
    { description: 'Clamp (BIG)', quantity: 1, rate: 2500, gst_rate: 18 },
    { description: 'Hose Clamp Set', quantity: 1, rate: 2000, gst_rate: 18 },
    { description: 'Turbo Exhaust Bend 5"', quantity: 6, rate: 5133.333333, gst_rate: 18 },
    { description: 'Turbo C-clamp 5"', quantity: 8, rate: 1150, gst_rate: 18 },
  ];

  const totals = noteTotals(items, { interState: true });
  assert.equal(totals.basic, 70000);
  assert.equal(totals.igstTotal, 12600);
  assert.equal(totals.grandTotal, 82600);
  assert.equal(amountInWords(82600), 'Rupees Eighty Two Thousand Six Hundred Only');
});

test('note totals reproduce the Jogighopa HSD note', () => {
  const items = [{ description: 'High Speed Diesel', quantity: 5000, rate: 97.54, gst_rate: 0 }];
  const totals = noteTotals(items);
  assert.equal(totals.basic, 487700);
  assert.equal(totals.grandTotal, 487700);
});

test("accounts' verified rate overrides the rate purchase proposed", () => {
  const items = [{ quantity: 1, rate: 1000, gst_rate: 18, tax_verified: true, verified_gst_rate: 5 }];
  const totals = noteTotals(items);
  assert.equal(totals.gstTotal, 50, 'tax is charged at the rate accounts confirmed');
  assert.equal(totals.breakdown[0].rate, 5);
});

test('mixed rates are grouped and reported', () => {
  const items = [
    { quantity: 1, rate: 1000, gst_rate: 18 },
    { quantity: 1, rate: 1000, gst_rate: 5 },
  ];
  const totals = noteTotals(items);
  assert.equal(totals.mixedRates, true);
  assert.equal(totals.breakdown.length, 2);
  assert.equal(totals.gstTotal, 230);
});

// ---------------------------------------------------------------------------
// TDS and TCS
// ---------------------------------------------------------------------------

test('TDS is withheld and TCS is added', () => {
  const result = computeDeductions({
    basic: 100000, gstTotal: 18000, grandTotal: 118000,
    tds: { applicable: true, section: '194C', rate: 2, base: 100000 },
    tcs: { applicable: false },
  });
  assert.equal(result.tds.amount, 2000);
  assert.equal(result.netPayable, 116000, 'grand total less TDS');

  const withTcs = computeDeductions({
    basic: 100000, gstTotal: 18000, grandTotal: 118000,
    tds: { applicable: false },
    tcs: { applicable: true, section: '206C-1', rate: 1, base: 118000 },
  });
  assert.equal(withTcs.tcs.amount, 1180);
  assert.equal(withTcs.netPayable, 119180, 'grand total plus TCS');
});

test('deducting TDS on the GST-inclusive value raises a warning', () => {
  const result = computeDeductions({
    basic: 100000, gstTotal: 18000, grandTotal: 118000,
    tds: { applicable: true, section: '194C', rate: 2, base: 118000 },
  });
  assert.ok(result.warnings.some((w) => /GST-inclusive/i.test(w)));
});

test('194Q and 206C(1H) together raise a warning', () => {
  const result = computeDeductions({
    basic: 6000000, gstTotal: 0, grandTotal: 6000000,
    tds: { applicable: true, section: '194Q', rate: 0.1, base: 1000000 },
    tcs: { applicable: true, section: '206C-1H', rate: 0.1, base: 1000000 },
  });
  assert.ok(result.warnings.some((w) => /cannot both apply/i.test(w)));
});

test('206AA raises the rate to 20% where there is no PAN', () => {
  const suggestion = suggestTds({
    supplyType: 'services', basicAmount: 200000,
    constitution: 'individual_huf', hasPan: false,
  });
  assert.equal(suggestion.rate, 20);
  assert.equal(suggestion.applicable, true, 'no threshold waiver applies without a PAN');
  assert.ok(suggestion.warnings.some((w) => /206AA/.test(w)));
});

test('206AB applies the higher of twice the rate or 5%', () => {
  // 194C at 2% doubles to 4%, but the 5% floor is higher, so 5% governs.
  const low = suggestTds({
    supplyType: 'services', basicAmount: 200000,
    constitution: 'company', hasPan: true, isSpecifiedPerson: true,
  });
  assert.equal(low.rate, 5, 'the 5% floor beats 2% doubled');
  assert.ok(low.warnings.some((w) => /206AB/.test(w)));

  // 194J-P at 10% doubles to 20%, which is above the floor.
  const high = suggestTds({
    supplyType: 'services', basicAmount: 200000,
    constitution: 'company', hasPan: true, isSpecifiedPerson: true,
    sectionOverride: '194J-P',
  });
  assert.ok(high.rate >= 5);
});

test('a payment below the 194C single threshold is not deducted', () => {
  const suggestion = suggestTds({
    supplyType: 'works_contract', basicAmount: 20000,
    constitution: 'firm', hasPan: true,
  });
  assert.equal(suggestion.applicable, false);
  assert.equal(suggestion.amount, 0);
  assert.ok(suggestion.reasons.some((r) => /30000/.test(r)));
});

test('the section catalogue is searchable', () => {
  assert.equal(findTdsSection('194c')?.code, '194C');
  assert.equal(findTcsSection('206C-1H')?.withdrawnFrom, '2025-04-01');
  assert.equal(findTdsSection('nonsense'), null);
});

// ---------------------------------------------------------------------------
// Payment schedule
// ---------------------------------------------------------------------------

test('the payment schedule reconciles against the net payable', () => {
  const schedule = schedulePayments([
    { milestone: '50% advance with PO', percent: 50, basis: 'grand_total' },
    { milestone: '50% against proforma invoice', percent: 50, basis: 'grand_total' },
  ], { basic: 142640, grandTotal: 168315.2, netPayable: 168315.2 });

  assert.equal(schedule.rows.length, 2);
  assert.equal(schedule.scheduled, 168315.2);
  assert.equal(schedule.reconciles, true);
});

test('a short schedule is flagged', () => {
  const schedule = schedulePayments([
    { milestone: 'Advance', percent: 40, basis: 'grand_total' },
  ], { basic: 100000, grandTotal: 118000, netPayable: 118000 });

  assert.equal(schedule.reconciles, false);
  assert.ok(schedule.warnings.length);
  assert.equal(schedule.difference, 70800);
});

test('retention is reported separately', () => {
  const schedule = schedulePayments([
    { milestone: 'On delivery', percent: 90, basis: 'grand_total' },
    { milestone: 'Retention', percent: 10, basis: 'grand_total', is_retention: true },
  ], { basic: 100000, grandTotal: 100000, netPayable: 100000 });

  assert.equal(schedule.retention, 10000);
  assert.equal(schedule.reconciles, true);
});

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

function makeQuotation(overrides = {}) {
  return {
    id: overrides.id || 1,
    vendor_name: overrides.vendor_name || 'Vendor',
    is_excluded: false,
    extraction_status: 'reviewed',
    source: 'manual',
    extraction_confidence: null,
    discount_amount: 0,
    freight_amount: 0,
    other_charges: 0,
    gst_rate: 18,
    items: [],
    ...overrides,
  };
}

test('landed cost includes freight and discount, not just the item total', () => {
  const cost = quotationCost(makeQuotation({
    items: [{ quantity: 2, rate: 1000, amount: 2000 }],
    discount_amount: 100,
    freight_amount: 300,
  }));

  assert.equal(cost.itemsTotal, 2000);
  assert.equal(cost.basic, 2200, '2000 less 100 plus 300');
  assert.equal(cost.gstAmount, 396);
  assert.equal(cost.landed, 2596);
});

test('optional lines are left out of the comparable value', () => {
  const cost = quotationCost(makeQuotation({
    items: [
      { quantity: 1, rate: 1000, amount: 1000 },
      { quantity: 1, rate: 500, amount: 500, is_optional: true },
      { quantity: 1, rate: 700, amount: 700, not_quoted: true },
    ],
  }));

  assert.equal(cost.itemsTotal, 1000);
  assert.equal(cost.optionalTotal, 500);
  assert.equal(cost.notQuotedCount, 1);
});

test('payment terms become a cash-flow number, and advance scores worst', () => {
  const allAdvance = paymentTimingDays({ advance_percent: 100, delivery_days: 30 });
  const allCredit = paymentTimingDays({ advance_percent: 0, credit_days: 45 });

  assert.ok(allAdvance < 0, 'paying everything up front is money out early');
  assert.ok(allCredit > allAdvance, '45 days credit is better for us than full advance');
  assert.equal(allCredit, 45);
});

test('L1 is decided by landed cost, not by the basic figure', () => {
  const comparison = buildComparison({
    quotations: [
      makeQuotation({
        id: 1, vendor_name: 'Cheap basic, heavy freight',
        items: [{ quantity: 1, rate: 10000, amount: 10000 }],
        freight_amount: 3000,
      }),
      makeQuotation({
        id: 2, vendor_name: 'Higher basic, free delivery',
        items: [{ quantity: 1, rate: 11000, amount: 11000 }],
        freight_amount: 0,
      }),
    ],
  });

  assert.equal(comparison.lowest.vendor_name, 'Higher basic, free delivery');
  assert.equal(comparison.rows.find((r) => r.quotation_id === 2).price_rank, 1);
});

test('unconfirmed machine-read figures block the note', () => {
  const comparison = buildComparison({
    quotations: [
      makeQuotation({ id: 1, vendor_name: 'Unchecked', extraction_status: 'extracted', source: 'ocr', extraction_confidence: 40 }),
    ],
  });

  const blocking = comparison.flags.filter((f) => f.level === 'blocking');
  assert.ok(blocking.some((f) => /nobody has confirmed/i.test(f.message)));
});

test('choosing other than the lowest is flagged for justification', () => {
  const comparison = buildComparison({
    quotations: [
      makeQuotation({ id: 1, vendor_name: 'Low', items: [{ quantity: 1, rate: 1000, amount: 1000 }] }),
      makeQuotation({ id: 2, vendor_name: 'High', items: [{ quantity: 1, rate: 2000, amount: 2000 }] }),
    ],
    selectedQuotationId: 2,
  });

  assert.ok(comparison.flags.some((f) => /not the lowest offer/i.test(f.message)));
  assert.equal(comparison.selected.vendor_name, 'High');
});

test('a single quotation is flagged as single-source', () => {
  const comparison = buildComparison({
    quotations: [makeQuotation({ id: 1, items: [{ quantity: 1, rate: 100, amount: 100 }] })],
  });
  assert.ok(comparison.flags.some((f) => /single-source/i.test(f.message)));
});

test('technical criteria shift the overall ranking away from price alone', () => {
  const quotations = [
    makeQuotation({ id: 1, vendor_name: 'Cheaper but weak', items: [{ quantity: 1, rate: 1000, amount: 1000 }], delivery_days: 30 }),
    makeQuotation({ id: 2, vendor_name: 'Dearer but strong', items: [{ quantity: 1, rate: 1100, amount: 1100 }], delivery_days: 7 }),
  ];

  const criteria = [{
    id: 1, label: 'Make', category: 'technical', weight: 1,
    values: { 1: { score: 2 }, 2: { score: 10 } },
  }];

  const comparison = buildComparison({
    quotations,
    criteria,
    weights: { price: 25, delivery: 25, payment: 0, technical: 50 },
  });

  const strong = comparison.rows.find((r) => r.quotation_id === 2);
  assert.equal(strong.overall_rank, 1, 'the stronger offer wins on the weighted view');
  assert.equal(comparison.lowest.vendor_name, 'Cheaper but weak', 'while L1 on price is still the cheaper one');
});

test('a failed mandatory criterion on the selected vendor is blocking', () => {
  const comparison = buildComparison({
    quotations: [makeQuotation({ id: 1, vendor_name: 'Non-compliant', items: [{ quantity: 1, rate: 100, amount: 100 }] })],
    criteria: [{ id: 1, label: 'Class approval', is_mandatory: true, weight: 1, values: { 1: { complies: false } } }],
    selectedQuotationId: 1,
  });

  assert.ok(comparison.flags.some((f) => f.level === 'blocking' && /mandatory/i.test(f.message)));
});

test('the front-page summary condenses the comparison', () => {
  const comparison = buildComparison({
    quotations: [
      makeQuotation({ id: 1, vendor_name: 'A', items: [{ quantity: 1, rate: 1000, amount: 1000 }], delivery_days: 10, advance_percent: 50 }),
      makeQuotation({ id: 2, vendor_name: 'B', items: [{ quantity: 1, rate: 900, amount: 900 }], delivery_days: 20 }),
    ],
    selectedQuotationId: 1,
  });

  const summary = comparisonSummary(comparison);
  assert.equal(summary.vendorCount, 2);
  assert.equal(summary.rows[0].vendor_name, 'B', 'cheapest first');
  assert.equal(summary.selectedIsLowest, false);
  assert.ok(summary.premium > 0);
});

// ---------------------------------------------------------------------------
// Quotation versions
// ---------------------------------------------------------------------------

test('a revision chain folds into one offer with its history', () => {
  const rows = [
    makeQuotation({ id: 1, vendor_name: 'Rainbow', version_no: 1, is_superseded: true }),
    makeQuotation({ id: 2, vendor_name: 'Rainbow', version_no: 2, supersedes_id: 1, is_superseded: true }),
    makeQuotation({ id: 3, vendor_name: 'Rainbow', version_no: 3, supersedes_id: 2 }),
    makeQuotation({ id: 4, vendor_name: 'Coastal', version_no: 1 }),
  ];

  const current = attachVersionHistory(rows);

  assert.equal(current.length, 2, 'two offers, not four rows');
  const rainbow = current.find((q) => q.vendor_name === 'Rainbow');
  assert.equal(rainbow.id, 3, 'the newest version is the live one');
  assert.equal(rainbow.version_count, 3);
  assert.deepEqual(rainbow.history.map((h) => h.id), [2, 1], 'history runs newest replaced first');
  assert.equal(current.find((q) => q.vendor_name === 'Coastal').version_count, 1);
});

test('a chain whose middle was deleted still keeps both ends', () => {
  // v2 was deleted and the FK set v3's pointer to null.
  const current = attachVersionHistory([
    makeQuotation({ id: 1, vendor_name: 'Rainbow', version_no: 1, is_superseded: true }),
    makeQuotation({ id: 3, vendor_name: 'Rainbow', version_no: 3, supersedes_id: null }),
  ]);

  assert.equal(current.length, 2, 'neither row is lost');
});

test('a self-referential chain cannot loop forever', () => {
  const a = makeQuotation({ id: 1, version_no: 1, supersedes_id: 2 });
  const b = makeQuotation({ id: 2, version_no: 2, supersedes_id: 1 });
  const current = attachVersionHistory([a, b]);
  assert.equal(current.length, 0, 'every row is superseded by the other, so none is current');
});

test('only the newest version is compared', () => {
  const comparison = buildComparison({
    quotations: [
      makeQuotation({
        id: 1, vendor_name: 'Rainbow', version_no: 1,
        is_superseded: true, items: [{ quantity: 1, rate: 1000, amount: 1000 }],
      }),
      makeQuotation({
        id: 2, vendor_name: 'Rainbow', version_no: 2, supersedes_id: 1,
        items: [{ quantity: 1, rate: 900, amount: 900 }],
      }),
    ],
  });

  assert.equal(comparison.rows.length, 1, 'the superseded version is not a competing offer');
  assert.equal(comparison.rows[0].quotation_id, 2);
});

test('the comparison reports what negotiation achieved', () => {
  const first = makeQuotation({
    id: 1, vendor_name: 'Rainbow', version_no: 1,
    items: [{ quantity: 1, rate: 10000, amount: 10000 }],
  });
  const revised = makeQuotation({
    id: 2, vendor_name: 'Rainbow', version_no: 2, supersedes_id: 1, version_count: 2,
    items: [{ quantity: 1, rate: 8000, amount: 8000 }],
    history: [first],
  });

  const comparison = buildComparison({ quotations: [revised], selectedQuotationId: 2 });
  const row = comparison.rows[0];

  assert.equal(row.first_offer, 11800, 'the first offer, landed');
  assert.equal(row.cost.landed, 9440);
  assert.equal(row.negotiated, 2360, 'the reduction achieved');
  assert.equal(row.version_no, 2);
});

test('a vendor selected before a revision is still the selected vendor', () => {
  const first = makeQuotation({ id: 1, vendor_name: 'Rainbow', version_no: 1 });
  const revised = makeQuotation({
    id: 2, vendor_name: 'Rainbow', version_no: 2, supersedes_id: 1,
    items: [{ quantity: 1, rate: 900, amount: 900 }],
    history: [first],
  });

  // The note still points at version 1, which the revision replaced.
  const comparison = buildComparison({ quotations: [revised], selectedQuotationId: 1 });
  assert.equal(comparison.rows[0].is_selected, true);
  assert.equal(comparison.selected.quotation_id, 2, 'selection follows the offer, not the row');
});

test('a revision that goes up rather than down is still reported', () => {
  const first = makeQuotation({ id: 1, items: [{ quantity: 1, rate: 1000, amount: 1000 }] });
  const revised = makeQuotation({
    id: 2, version_no: 2, supersedes_id: 1, version_count: 2,
    items: [{ quantity: 1, rate: 1200, amount: 1200 }],
    history: [first],
  });

  const row = buildComparison({ quotations: [revised] }).rows[0];
  assert.ok(row.negotiated < 0, 'a price increase shows as a negative saving');
});

// ---------------------------------------------------------------------------
// Extraction heuristics
// ---------------------------------------------------------------------------

test('Indian amount formats parse', () => {
  assert.equal(parseAmount('1,68,315.20'), 168315.2);
  assert.equal(parseAmount('Rs.70,000/-'), 70000);
  assert.equal(parseAmount('₹ 4,87,700'), 487700);
  assert.equal(parseAmount('97.54'), 97.54);
  assert.equal(parseAmount('(1,200)'), -1200);
  assert.equal(parseAmount('not a number'), null);
  assert.equal(parseAmount(''), null);
});

test('a GSTIN and a PAN are found in running text', () => {
  const text = 'M/s Rainbow Marine Engineering Services\nGSTIN: 27CLLPV6143B1ZW\nPAN No: CLLPV6143B';
  assert.equal(findGstin(text), '27CLLPV6143B1ZW');
  assert.equal(findPan(text), 'CLLPV6143B');
});

test('delivery periods in several phrasings', () => {
  assert.equal(findDelivery('Delivery: within 10 days from receipt of payment').days, 10);
  assert.equal(findDelivery('Delivery: Ready Stock').days, 0);
  assert.equal(findDelivery('Dispatch within 2-3 weeks').days, 21, 'the upper bound is the commitment');
  assert.equal(findDelivery('Lead time 2 months').days, 60);
  assert.equal(findDelivery('No mention of timing here').days, null);
});

test('payment terms yield advance, credit and retention', () => {
  const terms = findPaymentTerms('Payment Terms: 50% advance along with PO and balance 50% against proforma invoice');
  assert.equal(terms.advancePercent, 50);

  const credit = findPaymentTerms('Payment: 30 days credit from date of invoice, 5% retention');
  assert.equal(credit.creditDays, 30);
  assert.equal(credit.retentionPercent, 5);

  const full = findPaymentTerms('100% Payment against PO acknowledgement and Performa Invoice');
  assert.equal(full.advancePercent, 100);
});

test('CGST and SGST combine into one rate', () => {
  assert.equal(findGstRate('CGST @ 9% SGST @ 9%'), 18);
  assert.equal(findGstRate('IGST@18%'), 18);
  assert.equal(findGstRate('GST @ 5 %'), 5);
  assert.equal(findGstRate('no tax mentioned'), null);
});

test('the printed totals are picked out of the house table', () => {
  const totals = findTotals('TOTAL  142640/-\nGST @18%  25,675/-\nTotal Amount  1,68,315/-');
  assert.equal(totals.basic, 142640);
  assert.equal(totals.grand, 168315);
});

test('the vendor name is taken from an M/s line', () => {
  assert.equal(
    findVendorName('QUOTATION\nM/s. Rainbow Marine Engineering Services\nMumbai'),
    'Rainbow Marine Engineering Services',
  );
});

test('an Indian date is read day-first', () => {
  assert.equal(findDate('Date: 30-July-2026'), '2026-07-30');
  assert.equal(findDate('Dated 05/08/2026'), '2026-08-05');
});

test('line items are read and reconciled against quantity x rate', () => {
  const text = [
    'Sr No | Description | Qty | Unit | Rate | Amount',
    '1 | Hoist Turbo Charger Repair Service Kit | 2 | Nos | 20,000.00 | 40,000.00',
    '2 | Pump Gasket Set | 2 | Nos | 3,200.00 | 6,400.00',
    '3 | Gear Pump | 1 | Nos | 15,625.00 | 15,625.00',
  ].join('\n');

  const { items } = parseLineItems(text);

  assert.equal(items.length, 3);
  assert.equal(items[0].description, 'Hoist Turbo Charger Repair Service Kit');
  assert.equal(items[0].quantity, 2);
  assert.equal(items[0].unit, 'Nos');
  assert.equal(items[0].rate, 20000);
  assert.equal(items[0].amount, 40000);
  assert.ok(items.every((i) => i.reconciled), 'every line multiplies out');
  assert.equal(items[2].description, 'Gear Pump');
});

test('total rows are not mistaken for line items', () => {
  const text = [
    'Sr No | Description | Qty | Unit | Rate | Amount',
    '1 | Widget | 2 | Nos | 100.00 | 200.00',
    'TOTAL | | | | | 200.00',
    'GST @18% | | | | | 36.00',
    'Grand Total | | | | | 236.00',
  ].join('\n');

  const { items } = parseLineItems(text);
  assert.equal(items.length, 1);
  assert.equal(items[0].description, 'Widget');
});

test('a line that does not multiply out is flagged for review', () => {
  const text = [
    'Sr No | Description | Qty | Unit | Rate | Amount',
    '1 | Mis-typed line | 2 | Nos | 100.00 | 500.00',
  ].join('\n');

  const { items, warnings } = parseLineItems(text);
  assert.equal(items.length, 1);
  assert.equal(items[0].reconciled, false);
  assert.equal(items[0].needs_review, true);
  assert.ok(warnings.length);
});

test('a whole quotation parses with usable confidence', () => {
  const text = [
    'M/s. Rainbow Marine Engineering Services',
    'Mumbai 400001',
    'GSTIN: 27CLLPV6143B1ZW',
    'Quotation No: RMES/2026/114    Date: 30-July-2026',
    '',
    'Sr No | Description | Qty | Unit | Rate | Amount',
    '1 | Hoist Turbo Charger Repair Service Kit | 2 | Nos | 20,000.00 | 40,000.00',
    '2 | Turbo charger Service and Labour Charges | 2 | Nos | 5,500.00 | 11,000.00',
    '',
    'TOTAL  51,000.00',
    'GST @18%  9,180.00',
    'Total Amount  60,180.00',
    '',
    'Payment Terms: 50% advance along with PO and balance 50% against proforma invoice',
    'Delivery: within 10 days from receipt of payment',
    'Validity: 30 days',
  ].join('\n');

  const result = parseQuotation(text);

  assert.equal(result.ok, true);
  assert.equal(result.fields.vendor_gstin, '27CLLPV6143B1ZW');
  assert.equal(result.fields.delivery_days, 10);
  assert.equal(result.fields.advance_percent, 50);
  assert.equal(result.fields.gst_rate, 18);
  assert.equal(result.fields.quoted_basic, 51000);
  assert.equal(result.fields.validity_days, 30);
  assert.equal(result.items.length, 2);
  assert.ok(result.confidence >= 70, `confidence was ${result.confidence}`);
});

test('a mismatch between the lines and the printed total is reported', () => {
  const text = [
    'M/s Some Vendor Engineering Pvt Ltd',
    'GSTIN: 27CLLPV6143B1ZW',
    'Sr No | Description | Qty | Unit | Rate | Amount',
    '1 | Widget | 1 | Nos | 100.00 | 100.00',
    'TOTAL  9,999.00',
  ].join('\n');

  const result = parseQuotation(text);
  assert.ok(result.warnings.some((w) => /line items add up/i.test(w)));
});

test('an unreadable document asks for manual entry rather than guessing', () => {
  const result = parseQuotation('   \n  \n ');
  assert.equal(result.ok, false);
  assert.equal(result.confidence, 0);
  assert.deepEqual(result.items, []);
  assert.ok(result.warnings[0].includes('by hand'));
});
