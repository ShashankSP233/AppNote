// The annexures.
//
//   A  Requisition           — required, so always present
//   B  Comparative statement — landscape, the full multi-axis comparison
//   C  Payment schedule
//   D… Quotations            — one per vendor, selected vendor first
//
// Each one carries its letter in its heading, and the front page lists them.

import fs from 'node:fs';
import { ImageRun, Paragraph } from 'docx';
import {
  para, text, heading, spacer, cell, headCell, moneyCell, table, row,
  calloutBox, themed, ALIGN, GRID, BOX, NO_BORDER, COLOURS,
} from './helpers.js';
import { money, qty, formatDate, num, round2, amountInWords } from '../domain.js';
import { shortTerms, shortDelivery } from '../comparison.js';
import { storedPath } from '../middleware.js';

function annexureHeading(letter, title, { pageBreak = true } = {}) {
  return [
    para(`ANNEXURE ${letter}`, {
      bold: true, size: 13, align: ALIGN.CENTER, color: COLOURS.ACCENT,
      pageBreakBefore: pageBreak, after: 2,
    }),
    para(title, { bold: true, size: 11, align: ALIGN.CENTER, after: 8 }),
  ];
}

// ---------------------------------------------------------------------------
// Annexure A — the requisition
// ---------------------------------------------------------------------------

export function requisitionAnnexure(note, letter) {
  // Headings take their colour from how many vendors actually quoted.
  const { headCell } = themed(note);
  const children = [...annexureHeading(letter, 'Requisition')];

  if ((!note.requisition_id && !(note.requisition_source === 'reqflow' && note.requisition_source_id))
      || note.requisition_source_unavailable) {
    children.push(calloutBox('No requisition is linked to this note. A requisition is required.', { tone: 'warn' }));
    return children;
  }

  children.push(table([
    row([
      headCell('Requisition No.', { width: 25, align: ALIGN.LEFT }),
      cell(note.requisition_no || '—', { width: 25 }),
      headCell('Raised on', { width: 25, align: ALIGN.LEFT }),
      cell(formatDate(note.requisition_raised_on), { width: 25 }),
    ]),
    row([
      headCell('Raised by', { align: ALIGN.LEFT }),
      cell(note.requisition_raised_by || '—'),
      headCell('Required by', { align: ALIGN.LEFT }),
      cell(note.requisition_required_by ? formatDate(note.requisition_required_by) : '—'),
    ]),
    row([
      headCell('Project', { align: ALIGN.LEFT }),
      cell(note.project_name || '—'),
      headCell('Vessel', { align: ALIGN.LEFT }),
      cell(note.requisition_vessel || '—'),
    ]),
    row([
      headCell('Department', { align: ALIGN.LEFT }),
      cell(note.requisition_department || '—'),
      headCell('Purpose', { align: ALIGN.LEFT }),
      cell(note.requisition_purpose || '—'),
    ]),
  ], { borders: GRID }));

  if (note.requisition_items?.length) {
    children.push(spacer(6));
    children.push(para('Items requisitioned', { bold: true, size: 10, after: 3 }));

    const rows = [
      row([
        headCell('Sr.', { width: 7 }),
        headCell('Description', { width: 43, align: ALIGN.LEFT }),
        headCell('Specification', { width: 24, align: ALIGN.LEFT }),
        headCell('Qty', { width: 10 }),
        headCell('Unit', { width: 8 }),
        headCell('Remarks', { width: 8, align: ALIGN.LEFT }),
      ], { header: true }),
    ];

    note.requisition_items.forEach((item, index) => {
      rows.push(row([
        cell(String(item.line_no ?? index + 1), { align: ALIGN.CENTER }),
        cell(item.description, { align: ALIGN.LEFT }),
        cell(item.specification || item.part_no || '—', { align: ALIGN.LEFT, size: 9 }),
        cell(qty(item.quantity), { align: ALIGN.CENTER }),
        cell(item.unit || 'Nos', { align: ALIGN.CENTER }),
        cell(item.remarks || '', { align: ALIGN.LEFT, size: 8.5 }),
      ]));
    });

    children.push(table(rows, { borders: GRID }));
  }

  if (note.requisition_remarks) {
    children.push(spacer(4));
    children.push(para([text('Remarks: ', { bold: true, size: 9.5 }), text(note.requisition_remarks, { size: 9.5 })]));
  }

  const scans = (note.files || []).filter((f) => f.kind === 'requisition');
  if (scans.length) {
    children.push(spacer(6));
    children.push(...embedFiles(scans, 'Scanned requisition'));
  }

  return children;
}

// ---------------------------------------------------------------------------
// Annexure B — the comparative statement (landscape)
// ---------------------------------------------------------------------------

export function comparisonAnnexure(note, letter) {
  // Headings take their colour from how many vendors actually quoted.
  const { headCell } = themed(note);
  const children = [...annexureHeading(letter, 'Comparative statement of quotations', { pageBreak: false })];
  const comparison = note.comparison;
  const rows = comparison.rows;

  if (!rows.length) {
    children.push(calloutBox('No quotation has been recorded on this note.', { tone: 'warn' }));
    return children;
  }

  const vendorWidth = Math.floor(64 / rows.length);
  const labelWidth = 100 - (vendorWidth * rows.length);

  const header = row([
    headCell('Particulars', { width: labelWidth, align: ALIGN.LEFT }),
    ...rows.map((r) => headCell(
      [
        para(r.vendor_name, { bold: true, size: 9, align: ALIGN.CENTER, after: 0 }),
        para(r.is_selected ? 'SELECTED' : '', {
          size: 7.5, bold: true, align: ALIGN.CENTER, color: COLOURS.GOOD, after: 0,
        }),
      ],
      { width: vendorWidth },
    )),
  ], { header: true });

  const sectionRow = (label) => row([
    cell(label, { span: rows.length + 1, bold: true, fill: COLOURS.SOFT, align: ALIGN.LEFT, size: 9 }),
  ]);

  const dataRow = (label, valueOf, options = {}) => row([
    cell(label, { align: ALIGN.LEFT, size: 9, bold: options.bold }),
    ...rows.map((r) => cell(valueOf(r), {
      align: options.align || ALIGN.CENTER,
      size: options.size || 9,
      bold: options.bold || (options.boldSelected && r.is_selected),
      color: options.colorOf ? options.colorOf(r) : undefined,
      fill: options.fillOf ? options.fillOf(r) : undefined,
    })),
  ]);

  const body = [header];

  // --- Offer particulars ---------------------------------------------------
  body.push(sectionRow('Offer particulars'));
  body.push(dataRow('GSTIN', (r) => r.vendor_gstin || '—', { size: 8 }));
  body.push(dataRow('Place', (r) => r.vendor_city || '—'));
  body.push(dataRow('Quotation ref.', (r) => r.quotation_ref || '—', { size: 8 }));
  body.push(dataRow('Quotation date', (r) => (r.quotation_date ? formatDate(r.quotation_date) : '—')));
  body.push(dataRow('Validity', (r) => (r.validity_days ? `${r.validity_days} days` : '—')));
  if (rows.some((r) => (r.version_count || 1) > 1)) {
    body.push(dataRow('Version compared', (r) => ((r.version_count || 1) > 1
      ? `Revision ${r.version_no} of ${r.version_count}` : 'First offer')));
    body.push(dataRow('First offer (₹)', (r) => (r.first_offer !== null ? money(r.first_offer) : '—'),
      { align: ALIGN.RIGHT }));
    body.push(dataRow('Negotiated (₹)', (r) => (r.negotiated > 0 ? `−${money(r.negotiated)}` : '—'), {
      align: ALIGN.RIGHT,
      colorOf: (r) => (r.negotiated > 0 ? COLOURS.GOOD : undefined),
    }));
  }

  // --- Commercial ----------------------------------------------------------
  body.push(sectionRow('Commercial'));
  body.push(dataRow('Items value (₹)', (r) => (r.cost.lineCount > 0 && r.cost.hasBreakdown ? money(r.cost.itemsTotal) : '—'), { align: ALIGN.RIGHT }));
  body.push(dataRow('Less discount (₹)', (r) => (r.cost.discount ? money(r.cost.discount) : '—'), { align: ALIGN.RIGHT }));
  body.push(dataRow('Add freight (₹)', (r) => (r.cost.freight ? money(r.cost.freight) : '—'), { align: ALIGN.RIGHT }));
  body.push(dataRow('Add other charges (₹)', (r) => (r.cost.other ? money(r.cost.other) : '—'), { align: ALIGN.RIGHT }));
  body.push(dataRow('Taxable value (₹)', (r) => (r.cost.basic !== null ? money(r.cost.basic) : '—'), { align: ALIGN.RIGHT, bold: true }));
  body.push(dataRow('GST rate', (r) => (r.cost.gstAmount !== null
    ? `${num(r.cost.gstRate)}%${r.cost.gstRateAssumed ? ' (assumed)' : ''}` : '—')));
  body.push(dataRow('GST (₹)', (r) => (r.cost.gstAmount !== null ? money(r.cost.gstAmount) : '—'), { align: ALIGN.RIGHT }));
  if (rows.some((r) => r.quoted_total !== null)) {
    body.push(dataRow('Total as quoted (₹)', (r) => (r.quoted_total !== null ? money(r.quoted_total) : '—'), { align: ALIGN.RIGHT }));
  }
  body.push(dataRow('Landed cost (₹)', (r) => (r.cost.hasComparableValue ? money(r.cost.landed) : '—'), {
    align: ALIGN.RIGHT,
    bold: true,
    fillOf: (r) => (r.price_rank === 1 ? 'E6F4EA' : undefined),
  }));
  body.push(dataRow('Price position', (r) => (r.price_rank ? `L${r.price_rank}` : '—'), {
    colorOf: (r) => (r.price_rank === 1 ? COLOURS.GOOD : undefined),
    bold: true,
  }));

  // --- Delivery ------------------------------------------------------------
  body.push(sectionRow('Delivery'));
  body.push(dataRow('Delivery period', (r) => shortDelivery(r)));
  body.push(dataRow('Delivery basis', (r) => r.delivery_basis || '—'));
  body.push(dataRow('Delivery position', (r) => (r.delivery_rank ? `D${r.delivery_rank}` : '—'), {
    colorOf: (r) => (r.delivery_rank === 1 ? COLOURS.GOOD : undefined),
  }));

  // --- Payment -------------------------------------------------------------
  body.push(sectionRow('Payment terms'));
  body.push(dataRow('Advance', (r) => (r.advance_percent !== null ? `${num(r.advance_percent)}%` : '—')));
  body.push(dataRow('Credit period', (r) => (r.credit_days !== null ? `${num(r.credit_days)} days` : '—')));
  body.push(dataRow('Retention', (r) => (r.retention_percent !== null ? `${num(r.retention_percent)}%` : '—')));
  body.push(dataRow('Retention release', (r) => (r.retention_release_days !== null ? `${num(r.retention_release_days)} days after delivery` : '—')));
  body.push(dataRow('Terms as quoted', (r) => r.payment_terms_text || '—', { align: ALIGN.LEFT, size: 8 }));
  body.push(dataRow('Buyer cash-flow position', (r) => (r.payment_timing_days === null ? 'Not recorded'
    : `${num(r.payment_timing_days) > 0 ? '+' : ''}${num(r.payment_timing_days)} days (${num(r.payment_timing_days) > 0 ? 'deferred payment' : num(r.payment_timing_days) < 0 ? 'advance before delivery' : 'neutral'})`), {
    size: 8,
  }));
  body.push(dataRow('Warranty', (r) => r.warranty_text || '—', { align: ALIGN.LEFT, size: 8 }));

  // --- Technical criteria --------------------------------------------------
  if (note.criteria.length) {
    body.push(sectionRow('Assessment criteria'));
    for (const criterion of note.criteria) {
      const label = `${criterion.label}${criterion.is_mandatory ? ' (mandatory)' : ''}${criterion.requirement ? ` — required: ${criterion.requirement}` : ''}`;
      body.push(row([
        cell(label, { align: ALIGN.LEFT, size: 8.5 }),
        ...rows.map((r) => {
          const value = criterion.values?.[r.quotation_id];
          const parts = [];
          if (value?.value_text) parts.push(value.value_text);
          if (value?.score !== null && value?.score !== undefined) parts.push(`score ${num(value.score)}/10`);
          if (value?.complies === false) parts.push('does not comply');
          else if (value?.complies === true) parts.push('complies');
          else if (criterion.is_mandatory) parts.push('not confirmed');

          return cell(parts.join(' · ') || '—', {
            align: ALIGN.CENTER,
            size: 8.5,
            color: value?.complies === false ? COLOURS.WARN
              : value?.complies === true ? COLOURS.GOOD : undefined,
          });
        }),
      ]));
    }
  }

  // --- Weighted assessment -------------------------------------------------
  body.push(sectionRow(`Weighted assessment (price ${num(comparison.weights.price)}%, delivery ${num(comparison.weights.delivery)}%, payment ${num(comparison.weights.payment)}%, criteria ${num(comparison.weights.technical)}%)`));
  body.push(dataRow('Price score', (r) => (r.price_score === null ? '—' : `${num(r.price_score)}/10`)));
  body.push(dataRow('Delivery score', (r) => (r.delivery_score === null ? '—' : `${num(r.delivery_score)}/10`)));
  body.push(dataRow('Payment score', (r) => (r.payment_score === null ? '—' : `${num(r.payment_score)}/10`)));
  body.push(dataRow('Criteria score', (r) => (r.technical_score === null ? 'not scored' : `${num(r.technical_score)}/10`)));
  body.push(dataRow('Overall score', (r) => (r.overall_score === null ? '—' : `${num(r.overall_score)}/10`), {
    bold: true,
    fillOf: (r) => (r.overall_rank === 1 ? 'E6F4EA' : undefined),
  }));
  body.push(dataRow('Overall rank', (r) => (r.overall_rank ? `#${r.overall_rank}` : '—'), { bold: true }));
  body.push(dataRow('Scoring completeness', (r) => {
    const incomplete = (r.incomplete_axes || []).map((axis) => axis === 'technical' ? 'criteria' : axis);
    if (r.mandatory_failures) incomplete.push('mandatory criterion failed or unconfirmed; not ranked');
    return incomplete.length ? `Incomplete: ${incomplete.join(', ')}` : 'Complete on applicable axes';
  }, { size: 8 }));
  body.push(dataRow('Recommendation', (r) => (r.is_selected ? 'SELECTED' : ''), {
    bold: true,
    colorOf: (r) => (r.is_selected ? COLOURS.GOOD : undefined),
  }));

  // --- Provenance ----------------------------------------------------------
  body.push(sectionRow('How these figures were captured'));
  body.push(dataRow('Source', (r) => ({
    manual: 'Entered by hand',
    pdf_text: 'Read from PDF text',
    ocr: 'Read by OCR',
    ai: 'Read by AI',
  }[r.source] || r.source), { size: 8 }));
  body.push(dataRow('Confidence', (r) => (r.extraction_confidence === null ? '—' : `${r.extraction_confidence}%`), { size: 8 }));
  body.push(dataRow('Checked by a person', (r) => (r.extraction_status === 'reviewed' ? 'Yes' : r.source === 'manual' ? 'Entered by hand' : 'NO'), {
    size: 8,
    colorOf: (r) => (r.extraction_status === 'reviewed' || r.source === 'manual' ? COLOURS.GOOD : COLOURS.WARN),
  }));

  children.push(table(body, { borders: GRID }));
  children.push(para('Scores use relative 0–10 scales; higher is better. Missing information scores zero on an applicable axis. Criterion weights combine manual scores; category labels are for reference. An axis with no data for any offer is omitted, and the remaining axis weights are scaled proportionally. Vendors that fail or have not demonstrated a mandatory criterion are not ranked.', {
    size: 8, italic: true, color: COLOURS.MUTED, before: 4, after: 2,
  }));

  // Selection note
  if (comparison.selected) {
    children.push(spacer(6));
    children.push(para([
      text('Selected vendor: ', { bold: true, size: 10 }),
      text(comparison.selected.cost.hasComparableValue
        ? `${comparison.selected.vendor_name} at ₹${money(comparison.selected.cost.landed)} landed. `
        : `${comparison.selected.vendor_name} (quotation total not recorded). `, { size: 10 }),
      text(note.selection_reason || '', { size: 10, italic: true }),
    ]));
  }

  const flags = comparison.flags.filter((f) => f.level !== 'good');
  if (flags.length) {
    children.push(spacer(4));
    children.push(calloutBox(
      ['Points for the reviewer', ...flags.map((f) => `• ${f.message}`)],
      { tone: flags.some((f) => f.level === 'blocking') ? 'warn' : 'neutral' },
    ));
  }

  return children;
}

// ---------------------------------------------------------------------------
// Annexure C — the payment schedule
// ---------------------------------------------------------------------------

export function scheduleAnnexure(note, letter) {
  // Headings take their colour from how many vendors actually quoted.
  const { headCell, band } = themed(note);
  const children = [...annexureHeading(letter, 'Payment schedule')];
  const schedule = note.schedule;

  if (!schedule.rows.length) {
    children.push(calloutBox('No payment schedule has been entered on this note.', { tone: 'warn' }));
    return children;
  }

  const rows = [
    row([
      headCell('Sr.', { width: 6 }),
      headCell('Milestone', { width: 28, align: ALIGN.LEFT }),
      headCell('Trigger', { width: 22, align: ALIGN.LEFT }),
      headCell('Due', { width: 13 }),
      headCell('%', { width: 8 }),
      headCell('Basis', { width: 10 }),
      headCell('Amount (₹)', { width: 13 }),
    ], { header: true }),
  ];

  schedule.rows.forEach((milestone, index) => {
    const due = milestone.due_date
      ? formatDate(milestone.due_date)
      : milestone.due_offset_days !== null
        ? `+${milestone.due_offset_days} days`
        : '—';

    rows.push(row([
      cell(String(milestone.line_no ?? index + 1), { align: ALIGN.CENTER }),
      cell([
        para(milestone.milestone, { size: 9.5, after: 0 }),
        ...(milestone.is_retention ? [para('Retention', { size: 8, color: COLOURS.MUTED, after: 0 })] : []),
      ], { align: ALIGN.LEFT }),
      cell(milestone.trigger_event || '—', { align: ALIGN.LEFT, size: 9 }),
      cell(due, { align: ALIGN.CENTER, size: 9 }),
      cell(milestone.percent !== null ? `${num(milestone.percent)}%` : '—', { align: ALIGN.CENTER }),
      cell(milestone.basis === 'basic' ? 'Basic' : 'Gross', { align: ALIGN.CENTER, size: 8.5 }),
      moneyCell(money(milestone.amount)),
    ]));
  });

  rows.push(row([
    cell('Total scheduled', { span: 6, align: ALIGN.RIGHT, bold: true, fill: COLOURS.SOFT }),
    moneyCell(money(schedule.scheduled), { bold: true, fill: COLOURS.SOFT }),
  ]));

  rows.push(row([
    cell('Net payable on this note', { span: 6, align: ALIGN.RIGHT, bold: true, fill: band }),
    moneyCell(money(schedule.target), { bold: true, fill: band }),
  ]));

  children.push(table(rows, { borders: GRID }));

  children.push(para([
    text('Total scheduled in words: ', { bold: true, size: 9.5 }),
    text(amountInWords(schedule.scheduled), { size: 9.5 }),
  ], { before: 4 }));

  if (!schedule.reconciles) {
    children.push(spacer(4));
    children.push(calloutBox(schedule.warnings, { tone: 'warn' }));
  }

  if (schedule.retention > 0) {
    children.push(spacer(3));
    children.push(para(`Of the above, ₹${money(schedule.retention)} is retention, released on the terms stated against that milestone.`,
      { size: 9, italic: true, color: COLOURS.MUTED }));
  }

  if (note.deductions.tds.applicable || note.deductions.tcs.applicable) {
    children.push(spacer(3));
    children.push(para(
      `The schedule is drawn against the net payable, after ${note.deductions.tds.applicable ? `TDS of ₹${money(note.deductions.tds.amount)} under ${note.deductions.tds.section}` : ''}${note.deductions.tds.applicable && note.deductions.tcs.applicable ? ' and ' : ''}${note.deductions.tcs.applicable ? `TCS of ₹${money(note.deductions.tcs.amount)} under ${note.deductions.tcs.section}` : ''}.`,
      { size: 9, italic: true, color: COLOURS.MUTED },
    ));
  }

  return children;
}

// ---------------------------------------------------------------------------
// Annexure D onwards — the quotations themselves
// ---------------------------------------------------------------------------

const IMAGE_EXT = { '.png': 'png', '.jpg': 'jpg', '.jpeg': 'jpg', '.bmp': 'bmp', '.gif': 'gif' };

function embedFiles(files, label) {
  const children = [];

  for (const file of files) {
    const ext = (file.original_name || '').toLowerCase().match(/\.[a-z0-9]+$/)?.[0] || '';
    const imageType = IMAGE_EXT[ext];

    if (imageType) {
      try {
        const data = fs.readFileSync(storedPath(file.stored_name));
        children.push(para(`${label}: ${file.original_name}`, { size: 8.5, color: COLOURS.MUTED, after: 2 }));
        children.push(new Paragraph({
          children: [new ImageRun({
            data,
            type: imageType === 'jpg' ? 'jpg' : imageType,
            transformation: { width: 540, height: 700 },
          })],
          alignment: ALIGN.CENTER,
        }));
      } catch (error) {
        children.push(para(`${label}: ${file.original_name} — the image could not be embedded (${error.message}).`,
          { size: 8.5, color: COLOURS.WARN }));
      }
    } else {
      // A PDF cannot be embedded in a .docx. The ZIP package carries the
      // original, and this line tells the reader where to find it.
      children.push(para(
        `${label}: ${file.original_name} is attached separately in the document package (${Math.round((file.size_bytes || 0) / 1024)} KB).`,
        { size: 9, color: COLOURS.MUTED },
      ));
    }
  }

  return children;
}

export function quotationAnnexure(note, quotation, letter) {
  // Headings take their colour from how many vendors actually quoted.
  const { headCell } = themed(note);
  const versions = quotation.version_count || 1;
  const children = [...annexureHeading(
    letter,
    versions > 1
      ? `Quotation — ${quotation.vendor_name} (revision ${quotation.version_no})`
      : `Quotation — ${quotation.vendor_name}`,
  )];

  if (quotation.id === note.selected_quotation_id) {
    children.push(para('This is the selected vendor.', {
      bold: true, size: 9.5, color: COLOURS.GOOD, align: ALIGN.CENTER, after: 6,
    }));
  }
  if (quotation.is_excluded) {
    children.push(calloutBox([
      'This offer was excluded from the comparison.',
      quotation.exclusion_reason || 'No reason was recorded.',
    ], { tone: 'warn' }));
    children.push(spacer(4));
  }

  children.push(table([
    row([
      headCell('Vendor', { width: 20, align: ALIGN.LEFT }),
      cell(quotation.vendor_name, { width: 30, align: ALIGN.LEFT }),
      headCell('GSTIN', { width: 20, align: ALIGN.LEFT }),
      cell(quotation.vendor_gstin || '—', { width: 30, align: ALIGN.LEFT }),
    ]),
    row([
      headCell('PAN', { align: ALIGN.LEFT }),
      cell(quotation.vendor_pan || '—', { align: ALIGN.LEFT }),
      headCell('Place', { align: ALIGN.LEFT }),
      cell(quotation.vendor_city || '—', { align: ALIGN.LEFT }),
    ]),
    row([
      headCell('Quotation ref.', { align: ALIGN.LEFT }),
      cell(quotation.quotation_ref || '—', { align: ALIGN.LEFT }),
      headCell('Dated', { align: ALIGN.LEFT }),
      cell(quotation.quotation_date ? formatDate(quotation.quotation_date) : '—', { align: ALIGN.LEFT }),
    ]),
    row([
      headCell('Delivery', { align: ALIGN.LEFT }),
      cell(quotation.delivery_text || (quotation.delivery_days !== null ? `${num(quotation.delivery_days)} days` : '—'), { align: ALIGN.LEFT }),
      headCell('Validity', { align: ALIGN.LEFT }),
      cell(quotation.validity_days ? `${num(quotation.validity_days)} days` : '—', { align: ALIGN.LEFT }),
    ]),
    row([
      headCell('Payment terms', { align: ALIGN.LEFT }),
      cell(quotation.payment_terms_text || '—', { span: 3, align: ALIGN.LEFT }),
    ]),
  ], { borders: GRID }));

  if (quotation.items?.length) {
    children.push(spacer(6));
    children.push(para('As quoted', { bold: true, size: 10, after: 3 }));

    const rows = [
      row([
        headCell('Sr.', { width: 6 }),
        headCell('Description', { width: 42, align: ALIGN.LEFT }),
        headCell('Qty', { width: 10 }),
        headCell('Unit', { width: 8 }),
        headCell('Rate (₹)', { width: 15 }),
        headCell('Amount (₹)', { width: 19 }),
      ], { header: true }),
    ];

    let total = 0;
    quotation.items.forEach((item, index) => {
      const amount = num(item.amount, num(item.quantity) * num(item.rate));
      if (!item.not_quoted && !item.is_optional) total += amount;

      const noteRuns = [];
      if (item.not_quoted) noteRuns.push('not quoted');
      if (item.is_optional) noteRuns.push('optional');
      if (item.needs_review) noteRuns.push('needs checking');

      rows.push(row([
        cell(String(item.line_no ?? index + 1), { align: ALIGN.CENTER }),
        cell([
          para(item.description, { size: 9.5, after: 0 }),
          ...(noteRuns.length ? [para(noteRuns.join(', '), { size: 8, color: COLOURS.WARN, after: 0 })] : []),
        ], { align: ALIGN.LEFT }),
        cell(item.not_quoted ? '—' : qty(item.quantity), { align: ALIGN.CENTER }),
        cell(item.unit || 'Nos', { align: ALIGN.CENTER }),
        moneyCell(item.not_quoted ? '—' : money(item.rate)),
        moneyCell(item.not_quoted ? '—' : money(amount)),
      ]));
    });

    rows.push(row([
      cell('Total as quoted', { span: 5, align: ALIGN.RIGHT, bold: true, fill: COLOURS.SOFT }),
      moneyCell(money(total), { bold: true, fill: COLOURS.SOFT }),
    ]));

    children.push(table(rows, { borders: GRID }));
  } else if (quotation.quoted_basic !== null && quotation.quoted_basic !== undefined) {
    children.push(spacer(4));
    children.push(para(`Quoted basic value: ₹${money(quotation.quoted_basic)}`, { size: 10, bold: true }));
  }

  // --- Revision history --------------------------------------------------
  // What the vendor first asked for, and what they settled at. This is the
  // evidence that the price was negotiated rather than simply accepted.
  if (quotation.history?.length) {
    const chain = [quotation, ...quotation.history];
    const first = chain[chain.length - 1];
    const firstLanded = first.cost?.landed ?? null;
    const currentLanded = quotation.cost?.landed ?? null;

    children.push(spacer(8));
    children.push(para('Revision history', { bold: true, size: 10, after: 3 }));

    const historyRows = [
      row([
        headCell('Version', { width: 10 }),
        headCell('Dated', { width: 14 }),
        headCell('Reference', { width: 18, align: ALIGN.LEFT }),
        headCell('Landed value (₹)', { width: 16 }),
        headCell('Change', { width: 14 }),
        headCell('Delivery', { width: 12 }),
        headCell('Note', { width: 16, align: ALIGN.LEFT }),
      ], { header: true }),
    ];

    // Oldest first, so the table reads as the negotiation unfolded.
    [...chain].reverse().forEach((version, index, ordered) => {
      const landed = version.cost?.landed ?? null;
      const earlier = index > 0 ? ordered[index - 1].cost?.landed ?? null : null;
      const movement = landed !== null && earlier !== null ? round2(landed - earlier) : null;
      const isCurrent = version.id === quotation.id;

      historyRows.push(row([
        cell(`v${version.version_no || index + 1}${isCurrent ? ' (current)' : ''}`, {
          align: ALIGN.CENTER, bold: isCurrent,
        }),
        cell(version.quotation_date ? formatDate(version.quotation_date) : '—', { align: ALIGN.CENTER, size: 9 }),
        cell(version.quotation_ref || '—', { align: ALIGN.LEFT, size: 9 }),
        moneyCell(landed !== null ? money(landed) : '—', { bold: isCurrent }),
        cell(movement === null ? '—' : `${movement < 0 ? '−' : '+'}${money(Math.abs(movement))}`, {
          align: ALIGN.RIGHT,
          color: movement === null ? undefined : movement < 0 ? COLOURS.GOOD : COLOURS.WARN,
        }),
        cell(version.delivery_days !== null && version.delivery_days !== undefined
          ? `${num(version.delivery_days)} days` : '—', { align: ALIGN.CENTER, size: 9 }),
        cell(version.revision_note || '—', { align: ALIGN.LEFT, size: 8.5 }),
      ]));
    });

    children.push(table(historyRows, { borders: GRID }));

    if (firstLanded !== null && currentLanded !== null) {
      const saved = round2(firstLanded - currentLanded);
      if (saved > 0) {
        children.push(para(
          `Negotiated down by ₹${money(saved)} from the first offer of ₹${money(firstLanded)}, a reduction of ${round2(saved / firstLanded * 100)}%.`,
          { size: 9, bold: true, color: COLOURS.GOOD, before: 3 },
        ));
      } else if (saved < 0) {
        children.push(para(
          `This revision is ₹${money(Math.abs(saved))} above the vendor's first offer of ₹${money(firstLanded)}. The reason should be on record.`,
          { size: 9, bold: true, color: COLOURS.WARN, before: 3 },
        ));
      }
    }

    children.push(para(
      'Earlier versions are superseded and take no part in the comparison. Copies of each are in the document package.',
      { size: 8.5, italic: true, color: COLOURS.MUTED, before: 2 },
    ));
  }

  // Provenance — how this was captured, and whether a person checked it.
  const sourceLabel = {
    manual: 'entered by hand', pdf_text: 'read from the PDF text layer',
    ocr: 'read by OCR', ai: 'read by AI',
  }[quotation.source] || quotation.source;

  const provenance = [`These figures were ${sourceLabel}.`];
  if (quotation.extraction_confidence !== null && quotation.source !== 'manual') {
    provenance.push(`Extraction confidence was ${quotation.extraction_confidence}%.`);
  }
  provenance.push(quotation.extraction_status === 'reviewed'
    ? 'They were checked against the attached copy and confirmed.'
    : quotation.source === 'manual'
      ? ''
      : 'They have NOT been confirmed against the attached copy.');

  children.push(spacer(4));
  children.push(para(provenance.filter(Boolean).join(' '), {
    size: 8.5,
    italic: true,
    color: quotation.extraction_status === 'reviewed' || quotation.source === 'manual' ? COLOURS.MUTED : COLOURS.WARN,
  }));

  if (quotation.remarks) {
    children.push(para([text('Remarks: ', { bold: true, size: 9 }), text(quotation.remarks, { size: 9 })], { before: 2 }));
  }

  if (quotation.files?.length) {
    children.push(spacer(6));
    children.push(para('Copy of the quotation as received', { bold: true, size: 10, after: 3 }));
    children.push(...embedFiles(quotation.files, 'Attachment'));
  } else {
    children.push(spacer(4));
    children.push(calloutBox('No copy of this quotation is attached.', { tone: 'warn' }));
  }

  return children;
}

export { embedFiles };
