// Builds a sample approval note without touching the database, so the
// document output can be checked by eye.
//
//   npm run sample
//
// The figures are the Rainbow Marine note from the office, plus two invented
// competing offers so the comparison annexure has something to compare.

import fs from 'node:fs/promises';
import path from 'node:path';
import { noteTotals, computeDeductions, schedulePayments } from '../src/tax.js';
import { buildComparison, comparisonSummary, quotationCost } from '../src/comparison.js';
import { generateApprovalNote, documentFilename } from '../src/doc/index.js';
import { assessReadiness } from '../src/notes-repo.js';

const RAINBOW_ITEMS = [
  ['Hoist Turbo Charger Repair Service Kit', 2, 20000],
  ['Turbo charger Service and Labour Charges', 2, 5500],
  ['Pump Gasket Set', 2, 3200],
  ['Oil Seal Set', 2, 1875],
  ['Drive Shaft', 2, 2100],
  ['Teco Shaft', 2, 1500],
  ['Bearings', 2, 325],
  ['WC Assembly', 1, 1570],
  ['WC Bush and PIN', 1, 1690],
  ['Body Elbow', 2, 815],
  ['Screen Filter', 2, 240],
  ['Screen Filter Cup', 2, 440],
  ['Gear Pump Elbow', 2, 410],
  ['Drive Gear', 1, 1125],
  ['Mus Lock', 2, 285],
  ['Gear Pump', 1, 15625],
  ['Pump Calibration', 2, 4375],
  ['Injector Cup', 12, 1500],
  ['Injector Calibration', 12, 1875],
];

function toItems(rows, { factor = 1, gstRate = 18 } = {}) {
  return rows.map(([description, quantity, rate], index) => ({
    id: index + 1,
    line_no: index + 1,
    description,
    quantity,
    unit: 'Nos',
    rate: Math.round(rate * factor * 100) / 100,
    amount: Math.round(quantity * rate * factor * 100) / 100,
    gst_rate: gstRate,
    supply_type: 'services',
    discount_amount: 0,
    tax_verified: true,
    verified_gst_rate: gstRate,
  }));
}

/**
 * SAMPLE_VENDORS trims the offers so the heading colour can be checked:
 * 3 keeps it blue, 2 turns it yellow, 1 turns it orange.
 */
const VENDOR_LIMIT = Math.max(1, Math.min(3, Number(process.env.SAMPLE_VENDORS) || 3));

function buildNote() {
  const quotations = [
    {
      id: 1,
      note_id: 1,
      vendor_id: 1,
      vendor_name: 'Rainbow Marine Engineering Services',
      vendor_gstin: '27CLLPV6143B1ZW',
      vendor_pan: 'CLLPV6143B',
      vendor_city: 'Mumbai',
      vendor_constitution: 'firm',
      position: 1,
      quotation_ref: 'RMES/2026-27/114',
      quotation_date: '2026-07-28',
      validity_days: 30,
      delivery_days: 10,
      delivery_text: 'within 10 days from receipt of payment',
      delivery_basis: 'FOR Jogighopa',
      advance_percent: 50,
      credit_days: null,
      retention_percent: null,
      payment_terms_text: '50% advance along with PO and balance 50% along Proforma Invoice',
      discount_amount: 0,
      freight_amount: 0,
      other_charges: 0,
      gst_rate: 18,
      quoted_basic: 142640,
      quoted_total: 168315.2,
      warranty_text: '6 months on workmanship',
      source: 'pdf_text',
      extraction_status: 'reviewed',
      extraction_confidence: 88,
      extraction_method: 'PDF text layer',
      is_excluded: false,
      items: toItems(RAINBOW_ITEMS).map((i) => ({ ...i, quotation_id: 1 })),
      files: [],
      // This vendor requoted after negotiation; the first offer is kept.
      version_no: 2,
      version_count: 2,
      revision_note: 'Revised after negotiation on 29-July-2026',
      history: [{
        id: 101,
        vendor_name: 'Rainbow Marine Engineering Services',
        version_no: 1,
        quotation_ref: 'RMES/2026-27/098',
        quotation_date: '2026-07-21',
        delivery_days: 14,
        advance_percent: 50,
        payment_terms_text: '50% advance along with PO and balance 50% along Proforma Invoice',
        discount_amount: 0,
        freight_amount: 4500,
        other_charges: 0,
        gst_rate: 18,
        revision_note: 'First offer',
        items: toItems(RAINBOW_ITEMS, { factor: 1.085 }).map((i) => ({ ...i, quotation_id: 101 })),
        files: [],
      }],
    },
    {
      id: 2,
      note_id: 1,
      vendor_id: 2,
      vendor_name: 'Coastal Diesel Services',
      vendor_gstin: '18AISPB5151D1ZC',
      vendor_pan: 'AISPB5151D',
      vendor_city: 'Guwahati',
      position: 2,
      quotation_ref: 'CDS/Q/2026/771',
      quotation_date: '2026-07-26',
      validity_days: 15,
      delivery_days: 21,
      delivery_text: '3 weeks ex-works',
      delivery_basis: 'Ex-works Guwahati',
      advance_percent: 0,
      credit_days: 30,
      retention_percent: null,
      payment_terms_text: '30 days credit from date of invoice',
      discount_amount: 2500,
      freight_amount: 8500,
      other_charges: 0,
      gst_rate: 18,
      quoted_basic: 139000,
      source: 'ocr',
      extraction_status: 'reviewed',
      extraction_confidence: 61,
      extraction_method: 'OCR',
      is_excluded: false,
      items: toItems(RAINBOW_ITEMS, { factor: 0.974 }).map((i) => ({ ...i, quotation_id: 2 })),
      files: [],
    },
    {
      id: 3,
      note_id: 1,
      vendor_id: 3,
      vendor_name: 'Brahmaputra Marine Works',
      vendor_gstin: null,
      vendor_pan: null,
      vendor_city: 'Dhubri',
      position: 3,
      quotation_ref: 'BMW-249',
      quotation_date: '2026-07-25',
      validity_days: 7,
      delivery_days: 45,
      delivery_text: '6 weeks',
      advance_percent: 100,
      payment_terms_text: '100% advance against PO',
      discount_amount: 0,
      freight_amount: 0,
      other_charges: 0,
      gst_rate: 18,
      source: 'manual',
      extraction_status: 'reviewed',
      extraction_confidence: null,
      is_excluded: false,
      items: toItems(RAINBOW_ITEMS, { factor: 1.09 }).map((i) => ({ ...i, quotation_id: 3 })),
      files: [],
    },
  ].slice(0, VENDOR_LIMIT);

  const criteria = [
    {
      id: 1, line_no: 1, category: 'technical', label: 'Genuine OEM spares',
      requirement: 'Bosch / Cummins genuine', weight: 2, is_mandatory: true,
      values: {
        1: { value_text: 'Genuine Bosch', score: 10, complies: true },
        2: { value_text: 'Mixed OEM and aftermarket', score: 6, complies: true },
        3: { value_text: 'Aftermarket only', score: 3, complies: false },
      },
    },
    {
      id: 2, line_no: 2, category: 'technical', label: 'Calibration test report',
      requirement: 'Bench test report with each pump', weight: 2, is_mandatory: true,
      values: {
        1: { value_text: 'Provided for each unit', score: 10, complies: true },
        2: { value_text: 'On request', score: 5, complies: true },
        3: { value_text: 'Not offered', score: 0, complies: false },
      },
    },
    {
      id: 3, line_no: 3, category: 'commercial', label: 'Past performance at Jogighopa',
      requirement: 'Prior work on our vessels', weight: 1, is_mandatory: false,
      values: {
        1: { value_text: 'Worked on Titan-VI in 2025', score: 9, complies: true },
        2: { value_text: 'No prior work', score: 4 },
        3: { value_text: 'No prior work', score: 4 },
      },
    },
    {
      id: 4, line_no: 4, category: 'delivery', label: 'Site attendance',
      requirement: 'Technician at site for fitment', weight: 1, is_mandatory: false,
      values: {
        1: { value_text: 'Technician deputed, included', score: 10, complies: true },
        2: { value_text: 'Chargeable extra', score: 5, complies: true },
        3: { value_text: 'Not offered', score: 0, complies: false },
      },
    },
  ];

  const items = toItems(RAINBOW_ITEMS);
  const totals = noteTotals(items, { interState: true });

  const deductions = computeDeductions({
    basic: totals.basic,
    gstTotal: totals.gstTotal,
    grandTotal: totals.grandTotal,
    tds: { applicable: true, section: '194C', rate: 2, base: totals.basic },
    tcs: { applicable: false },
  });

  const milestones = [
    { line_no: 1, milestone: '50% advance along with Purchase Order', trigger_event: 'PO release', percent: 50, basis: 'grand_total', due_offset_days: 0 },
    { line_no: 2, milestone: '50% against Proforma Invoice before dispatch', trigger_event: 'Proforma invoice', percent: 50, basis: 'grand_total', due_offset_days: 10 },
  ];

  const schedule = schedulePayments(milestones, {
    basic: totals.basic,
    grandTotal: totals.grandTotal,
    netPayable: deductions.netPayable,
  });

  // loadNote() prices each version so the annexure can show the movement;
  // the sample has no database, so it does the same here.
  for (const quotation of quotations) {
    quotation.cost = quotationCost(quotation, { interState: true });
    for (const earlier of quotation.history || []) {
      earlier.cost = quotationCost(earlier, { interState: true });
    }
  }

  const comparison = buildComparison({
    quotations,
    criteria,
    interState: true,
    selectedQuotationId: 1,
  });

  const note = {
    id: 1,
    note_no: 'YG/ Port-Dharti/26-27/July/1',
    note_seq: 1,
    financial_year: '26-27',
    note_date: '2026-07-30',
    status_label: 'Live',
    subject: 'Repair and replacement of spares along with calibration and service charges of Fuel Pump, Injectors and Turbocharger of our vessel Titan-VI at Jogighopa, Assam',
    item_description: 'Repair and replacement of spares along with calibration charges and service charges of Fuel Pump, Turbocharger and Injectors of vessel Titan-VI at Jogighopa, Assam. Three quotations have been obtained and compared. The detail is as under.',
    project_id: 1,
    project_name: 'Jogighopa / Dhubri, Assam',
    project_state_code: '18',
    supply_state_code: '18',
    requisition_id: 1,
    requisition_no: 'REQ/JOG/26-27/041',
    requisition_raised_on: '2026-07-18',
    requisition_raised_by: 'Site Engineer, Titan-VI',
    requisition_vessel: 'Titan-VI',
    requisition_department: 'Marine Engineering',
    requisition_purpose: 'Fuel pump, injector and turbocharger overhaul required to restore the vessel to service.',
    requisition_required_by: '2026-08-15',
    requisition_remarks: 'Vessel is off hire until these are fitted.',
    prepared_by: 2,
    prepared_by_name: 'Mansi Shinde',
    prepared_by_desig: 'Asst. Manager-Purchase',
    selected_quotation_id: 1,
    selection_reason: 'Genuine Bosch spares with a bench calibration report for each unit, a technician deputed to site at no extra cost, and the shortest delivery at 10 days. The lowest offer does not meet the mandatory calibration report requirement and quotes aftermarket parts.',
    mode_of_payment: 'NEFT/RTGS',
    payment_terms: '50% advance along with PO and balance 50% along Proforma Invoice',
    transport_charges: 'Extra (at actuals)',
    delivery_terms: 'Within 10 days from receipt of payment',
    status: 'pending_approval',
    current_stage: 'approve',
    submitted_at: '2026-07-30T10:00:00Z',
    quotations,
    items,
    criteria,
    milestones,
    files: [],
    requisition_items: [
      { line_no: 1, description: 'Fuel pump overhaul kit with calibration', specification: 'Bosch, for Cummins KTA-19', quantity: 2, unit: 'Set' },
      { line_no: 2, description: 'Turbocharger repair kit', specification: 'Holset HX series', quantity: 2, unit: 'Set' },
      { line_no: 3, description: 'Injector cups and calibration', specification: 'OEM', quantity: 12, unit: 'Nos' },
    ],
    steps: [
      { step_order: 1, step_type: 'check', assignee_name: 'Saurabh Patki', decision: 'approved', decided_at: '2026-07-30T11:00:00Z' },
      { step_order: 1, step_type: 'check', assignee_name: 'Abhishek Agarwal', decision: 'approved', decided_at: '2026-07-30T11:30:00Z' },
      { step_order: 2, step_type: 'verify', assignee_name: 'Vipul Save', decision: 'approved', decided_at: '2026-07-30T12:00:00Z' },
      { step_order: 2, step_type: 'verify', assignee_name: 'Harshada Save', decision: 'approved', decided_at: '2026-07-30T12:15:00Z' },
      { step_order: 3, step_type: 'accounts', assignee_name: 'Accounts Department', decision: 'approved', decided_at: '2026-07-31T09:00:00Z' },
      { step_order: 4, step_type: 'approve', assignee_name: 'Managing Director', decision: 'pending' },
      { step_order: 4, step_type: 'approve', assignee_name: 'Hon. Chairman', decision: 'pending' },
    ],
    accounts: {
      note_id: 1,
      gst_number_checked: true,
      gst_status: 'Active on the GST portal',
      pan_number_checked: true,
      pan_status: 'Valid, matches the GSTIN',
      bank_details_checked: true,
      msme_checked: true,
      duplicate_checked: true,
      budget_checked: true,
      all_items_tax_verified: true,
      tds_applicable: true,
      tds_section: '194C',
      tds_rate: 2,
      tds_base: 142640,
      tds_amount: 2852.8,
      tds_remark: 'Repair and service work, deducted on the taxable value as GST is shown separately.',
      tcs_applicable: false,
      remarks: 'Vendor is registered in Maharashtra and the supply is to Assam, so IGST applies.',
    },
    selected_quotation: quotations[0],
    vendor_pan: 'CLLPV6143B',
    vendor_constitution: 'firm',
    interState: true,
    totals,
    comparison,
    comparison_summary: comparisonSummary(comparison),
    deductions,
    schedule,
  };

  note.readiness = assessReadiness(note);
  return note;
}

async function main() {
  const note = buildNote();

  console.log('Sample note');
  console.log('-'.repeat(60));
  console.log(`Number        : ${note.note_no}`);
  console.log(`Basic         : ${note.totals.basic}`);
  console.log(`IGST          : ${note.totals.igstTotal}`);
  console.log(`Grand total   : ${note.totals.grandTotal}`);
  console.log(`TDS 194C @2%  : ${note.deductions.tds.amount}`);
  console.log(`Net payable   : ${note.deductions.netPayable}`);
  console.log(`Vendors       : ${note.comparison.rows.length}`);
  console.log(`L1 on price   : ${note.comparison.lowest.vendor_name}`);
  console.log(`Best overall  : ${note.comparison.best.vendor_name}`);
  console.log(`Selected      : ${note.selected_quotation.vendor_name}`);
  console.log(`Ready to send : ${note.readiness.canSubmit}`);
  if (note.readiness.blocking.length) {
    console.log('Blocking:');
    for (const item of note.readiness.blocking) console.log(`  - ${item}`);
  }
  if (note.readiness.advisory.length) {
    console.log('Advisory:');
    for (const item of note.readiness.advisory) console.log(`  - ${item}`);
  }

  const buffer = await generateApprovalNote(note);
  const outDir = process.env.SAMPLE_DIR || path.resolve('./sample-output');
  await fs.mkdir(outDir, { recursive: true });

  const filename = documentFilename(note);
  const target = path.join(outDir,
    VENDOR_LIMIT === 3 ? filename : filename.replace(/\.docx$/, `_${VENDOR_LIMIT}-vendor.docx`));
  await fs.writeFile(target, buffer);

  console.log('-'.repeat(60));
  console.log(`Written: ${target} (${Math.round(buffer.length / 1024)} KB)`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
