// The approval note front page, in the house format.
//
// The front page carries a SUMMARY of the comparison only. The full
// comparative statement is Annexure B.

import {
  para, text, heading, spacer, bullet, cell, headCell, moneyCell, table, row,
  labelledBox, calloutBox, themed, ALIGN, BOX, GRID, NO_BORDER, COLOURS,
} from './helpers.js';
import { money, qty, amountInWords, formatDate, num } from '../domain.js';

const COMPANY = process.env.COMPANY_NAME || 'Dharti Dredging & Infrastructure Limited';

function titleBlock(note) {
  const children = [];

  // Date left, serial right, on one line.
  children.push(table([
    row([
      cell(`Date: ${formatDate(note.note_date)}`, { width: 50, size: 10, borders: NO_BORDER }),
      cell(`Sr. No.: ${note.note_no || '________'}`, {
        width: 50, size: 10, align: ALIGN.RIGHT, borders: NO_BORDER,
      }),
    ]),
  ], { borders: NO_BORDER }));

  children.push(para(`Status – ${note.status_label || 'Live'}`, { size: 9.5, align: ALIGN.RIGHT, after: 4 }));

  children.push(para('APPROVAL NOTE', {
    align: ALIGN.CENTER, bold: true, size: 15, before: 4, after: 8,
  }));

  children.push(para('To: Hon. Chairman Sir, Managing Director Sir', { size: 10, after: 6 }));

  children.push(labelledBox('Subject', note.subject));
  children.push(labelledBox('From',
    `${note.prepared_by_name || note.preparer_name || ''}${note.prepared_by_desig || note.preparer_designation ? ` (${note.prepared_by_desig || note.preparer_designation})` : ''}`));
  children.push(labelledBox('Project Name', note.project_name || ''));
  children.push(labelledBox('Item Description', note.item_description || ''));

  return children;
}

/**
 * The condensed comparison. One row per vendor, lowest first, with the price,
 * delivery and payment position and where the vendor ranked.
 */
function comparisonSummaryBlock(note) {
  // Headings take their colour from how many vendors actually quoted.
  const { headCell } = themed(note);
  const summary = note.comparison_summary;
  const children = [];

  children.push(spacer(6));
  children.push(para('Quotation details and comparison', { bold: true, size: 11, after: 4 }));

  if (!summary || !summary.rows.length) {
    children.push(para('No quotation has been recorded on this note.', { size: 9.5, italic: true, color: COLOURS.WARN }));
    return children;
  }

  const rows = [
    row([
      headCell('Vendor', { width: 28, align: ALIGN.LEFT }),
      headCell('Landed value (₹)', { width: 16 }),
      headCell('Price rank', { width: 10 }),
      headCell('Delivery', { width: 17 }),
      headCell('Payment terms', { width: 20 }),
      headCell('Overall', { width: 9 }),
    ], { header: true }),
  ];

  for (const entry of summary.rows) {
    const selectedMark = entry.is_selected ? ' ✓' : '';
    rows.push(row([
      cell(`${entry.vendor_name}${selectedMark}`, { align: ALIGN.LEFT, bold: entry.is_selected }),
      cell(entry.landed === null ? '—' : money(entry.landed), { align: ALIGN.RIGHT, bold: entry.is_selected }),
      cell(entry.price_rank ? `L${entry.price_rank}` : '—', { align: ALIGN.CENTER }),
      cell(entry.delivery, { align: ALIGN.LEFT, size: 9 }),
      cell(entry.payment, { align: ALIGN.LEFT, size: 9 }),
      cell(entry.overall_rank ? `#${entry.overall_rank}` : '—', { align: ALIGN.CENTER }),
    ]));
  }

  children.push(table(rows, { borders: GRID }));
  children.push(para(
    `${summary.vendorCount} offer(s) compared using the recorded price, delivery, payment and criteria information. The full comparative statement is at Annexure B.`,
    { size: 8.5, italic: true, color: COLOURS.MUTED, before: 2, after: 4 },
  ));

  // Without a key, a yellow or orange document is just a puzzle.
  const { theme } = themed(note);
  if (theme.note) {
    children.push(calloutBox(theme.note, {
      tone: theme.key === 'single' ? 'warn' : 'neutral',
      boldFirst: false,
    }));
    children.push(spacer(4));
  }

  return children;
}

/** The selected vendor and the reason — both required on the front page. */
function selectionBlock(note) {
  const children = [];
  const selected = note.selected_quotation;

  if (!selected) {
    children.push(para('Vendor Selected – not yet selected', { bold: true, size: 10.5, color: COLOURS.WARN }));
    return children;
  }

  children.push(para([
    text('Vendor Selected – ', { bold: true, size: 10.5 }),
    text(selected.vendor_name, { bold: true, size: 10.5 }),
    text(selected.vendor_gstin ? ` (GST No: ${selected.vendor_gstin})` : ' (GST No: ____________)', { size: 10 }),
    ...((selected.version_count || 1) > 1
      ? [text(`  —  revision ${selected.version_no} of ${selected.version_count}`, { size: 9, color: COLOURS.MUTED })]
      : []),
  ], { before: 6, after: 2 }));

  children.push(para([
    text('Reason for selected vendor :- ', { bold: true, size: 10 }),
    text(note.selection_reason || '', { size: 10 }),
  ], { after: 4 }));

  // A price that moved during negotiation is part of the case for the choice,
  // so it belongs on the front page rather than only in the annexure.
  const selectedRow = note.comparison?.rows?.find((r) => r.is_selected);
  if (selectedRow?.negotiated > 0) {
    children.push(para([
      text('Negotiated: ', { bold: true, size: 10, color: COLOURS.GOOD }),
      text(`the first offer from ${selected.vendor_name} was ₹${money(selectedRow.first_offer)}; it was brought down to ₹${money(selectedRow.cost.landed)}, a saving of ₹${money(selectedRow.negotiated)}. The full revision history is in the annexure.`,
        { size: 10 }),
    ], { after: 4 }));
  }

  const summary = note.comparison_summary;
  if (summary && !summary.selectedIsLowest && summary.premium > 0) {
    children.push(calloutBox([
      'This is not the lowest offer.',
      `${summary.selectedName} is ₹${money(summary.premium)} above ${summary.lowestName}, the lowest at ₹${money(summary.lowestLanded)}. The reason recorded above is the justification for this choice.`,
    ], { tone: 'warn' }));
    children.push(spacer(4));
  }

  return children;
}

/** The priced schedule, with GST split by rate and by place of supply. */
function costTable(note) {
  // Headings take their colour from how many vendors actually quoted.
  const { headCell, band } = themed(note);
  const children = [];
  const totals = note.totals;

  children.push(para('Payment Terms', { bold: true, size: 11, before: 6, after: 3 }));

  const rows = [
    row([
      headCell('Sr. No.', { width: 7 }),
      headCell('Description', { width: 41, align: ALIGN.LEFT }),
      headCell('Qty', { width: 9 }),
      headCell('Units', { width: 9 }),
      headCell('Price', { width: 16 }),
      headCell('Amount', { width: 18 }),
    ], { header: true }),
  ];

  if (!note.items.length) {
    rows.push(row([cell('No priced lines have been entered.', {
      span: 6, align: ALIGN.CENTER, italic: true, color: COLOURS.WARN,
    })]));
  }

  note.items.forEach((item, index) => {
    const amount = item.amount !== null && item.amount !== undefined
      ? num(item.amount) : num(item.quantity) * num(item.rate);

    const descriptionRuns = [text(item.description, { size: 9.5 })];
    if (item.specification) {
      descriptionRuns.push(text(`\n${item.specification}`, { size: 8.5, color: COLOURS.MUTED, break: 1 }));
    }
    // Where accounts corrected the rate, say so on the line.
    if (item.tax_verified && item.verified_gst_rate !== null
      && num(item.verified_gst_rate) !== num(item.gst_rate)) {
      descriptionRuns.push(text(
        `\nGST corrected by accounts: ${num(item.gst_rate)}% → ${num(item.verified_gst_rate)}%`,
        { size: 8, color: COLOURS.WARN, break: 1 },
      ));
    }

    rows.push(row([
      cell(String(item.line_no ?? index + 1), { align: ALIGN.CENTER }),
      cell([para(descriptionRuns, { after: 0 })], { align: ALIGN.LEFT }),
      cell(qty(item.quantity), { align: ALIGN.CENTER }),
      cell(item.unit || 'Nos', { align: ALIGN.CENTER }),
      moneyCell(money(item.rate)),
      moneyCell(money(amount)),
    ]));
  });

  // Totals
  rows.push(row([
    cell('TOTAL', { span: 5, align: ALIGN.RIGHT, bold: true, fill: COLOURS.SOFT }),
    moneyCell(money(totals.basic), { bold: true, fill: COLOURS.SOFT }),
  ]));

  for (const group of totals.breakdown) {
    if (group.total === 0 && totals.breakdown.length > 1) continue;
    if (group.interState) {
      rows.push(row([
        cell(`IGST @ ${num(group.rate)}%`, { span: 5, align: ALIGN.RIGHT }),
        moneyCell(money(group.igst)),
      ]));
    } else {
      rows.push(row([
        cell(`CGST @ ${num(group.rate) / 2}%`, { span: 5, align: ALIGN.RIGHT }),
        moneyCell(money(group.cgst)),
      ]));
      rows.push(row([
        cell(`SGST @ ${num(group.rate) / 2}%`, { span: 5, align: ALIGN.RIGHT }),
        moneyCell(money(group.sgst)),
      ]));
    }
  }

  if (totals.rounding) {
    rows.push(row([
      cell('Round off', { span: 5, align: ALIGN.RIGHT }),
      moneyCell(`${totals.rounding > 0 ? '+' : '−'}${money(Math.abs(totals.rounding))}`),
    ]));
  }

  rows.push(row([
    cell('Grand Total', { span: 5, align: ALIGN.RIGHT, bold: true, fill: band }),
    moneyCell(money(totals.grandTotal, { decimals: 0 }), { bold: true, fill: band }),
  ]));

  children.push(table(rows, { borders: GRID }));

  children.push(para([
    text('Amount in words: ', { bold: true, size: 10 }),
    text(amountInWords(totals.grandTotal), { size: 10 }),
  ], { before: 4, after: 4 }));

  return children;
}

/** The commercial bullets. */
function termsBlock(note) {
  const children = [];

  children.push(bullet(`Mode of Payment : ${note.mode_of_payment || 'NEFT/RTGS'}`));
  children.push(bullet(`Payment to be paid by M/s ${COMPANY}.`));
  if (note.transport_charges) children.push(bullet(`Transportation Charges: ${note.transport_charges}`));
  if (note.payment_terms) children.push(bullet(`Payment Terms: ${note.payment_terms}`));
  if (note.delivery_terms) children.push(bullet(`Delivery/Dispatch: ${note.delivery_terms}`));
  if (note.milestones.length) {
    children.push(bullet('The payment schedule is at Annexure C.'));
  }

  return children;
}

/**
 * The accounts block: the registration checks, the item-wise tax position and
 * the TDS/TCS settlement, which is what actually gets paid.
 */
function accountsBlock(note) {
  // Headings take their colour from how many vendors actually quoted.
  const { headCell, band } = themed(note);
  const children = [];
  const accounts = note.accounts;
  const deductions = note.deductions;

  if (!accounts && !deductions.tds.applicable && !deductions.tcs.applicable) return children;

  children.push(para('Accounts verification', { bold: true, size: 11, before: 8, after: 3 }));

  const verifiedCount = note.items.filter((i) => i.tax_verified).length;
  const tick = (value) => (value ? 'Verified' : 'Not verified');

  children.push(table([
    row([
      headCell('GST No.', { width: 25 }),
      headCell('PAN No.', { width: 25 }),
      headCell('Bank details', { width: 25 }),
      headCell('Item-wise tax', { width: 25 }),
    ], { header: true }),
    row([
      cell(tick(accounts?.gst_number_checked), {
        align: ALIGN.CENTER,
        color: accounts?.gst_number_checked ? COLOURS.GOOD : COLOURS.WARN,
      }),
      cell(tick(accounts?.pan_number_checked), {
        align: ALIGN.CENTER,
        color: accounts?.pan_number_checked ? COLOURS.GOOD : COLOURS.WARN,
      }),
      cell(tick(accounts?.bank_details_checked), {
        align: ALIGN.CENTER,
        color: accounts?.bank_details_checked ? COLOURS.GOOD : COLOURS.WARN,
      }),
      cell(`${verifiedCount} of ${note.items.length} confirmed`, {
        align: ALIGN.CENTER,
        color: verifiedCount === note.items.length && note.items.length ? COLOURS.GOOD : COLOURS.WARN,
      }),
    ]),
  ], { borders: GRID }));

  if (deductions.tds.applicable || deductions.tcs.applicable) {
    const settlement = [
      row([
        headCell('Particulars', { width: 55, align: ALIGN.LEFT }),
        headCell('Section', { width: 15 }),
        headCell('Rate', { width: 10 }),
        headCell('Amount (₹)', { width: 20 }),
      ], { header: true }),
      row([
        cell('Grand total of the note', { align: ALIGN.LEFT }),
        cell('—', { align: ALIGN.CENTER }),
        cell('—', { align: ALIGN.CENTER }),
        moneyCell(money(deductions.grandTotal)),
      ]),
    ];

    if (deductions.tds.applicable) {
      settlement.push(row([
        cell(`Less: TDS on ₹${money(deductions.tds.base)}`, { align: ALIGN.LEFT }),
        cell(deductions.tds.section || '—', { align: ALIGN.CENTER }),
        cell(`${num(deductions.tds.rate)}%`, { align: ALIGN.CENTER }),
        moneyCell(`(${money(deductions.tds.amount)})`, { color: COLOURS.WARN }),
      ]));
    }

    if (deductions.tcs.applicable) {
      settlement.push(row([
        cell(`Add: TCS on ₹${money(deductions.tcs.base)}`, { align: ALIGN.LEFT }),
        cell(deductions.tcs.section || '—', { align: ALIGN.CENTER }),
        cell(`${num(deductions.tcs.rate)}%`, { align: ALIGN.CENTER }),
        moneyCell(money(deductions.tcs.amount)),
      ]));
    }

    settlement.push(row([
      cell('Net amount payable to the vendor', { align: ALIGN.LEFT, bold: true, fill: band }),
      cell('', { fill: band }),
      cell('', { fill: band }),
      moneyCell(money(deductions.netPayable), { bold: true, fill: band }),
    ]));

    children.push(spacer(3));
    children.push(table(settlement, { borders: GRID }));

    children.push(para([
      text('Net payable in words: ', { bold: true, size: 9.5 }),
      text(amountInWords(deductions.netPayable), { size: 9.5 }),
    ], { before: 3, after: 3 }));

    if (accounts?.tds_remark) children.push(para(`TDS note: ${accounts.tds_remark}`, { size: 8.5, color: COLOURS.MUTED }));
    if (accounts?.tcs_remark) children.push(para(`TCS note: ${accounts.tcs_remark}`, { size: 8.5, color: COLOURS.MUTED }));
  }

  if (accounts?.remarks) {
    children.push(para([text('Accounts remarks: ', { bold: true, size: 9 }), text(accounts.remarks, { size: 9 })], { before: 2 }));
  }

  return children;
}

/**
 * Post-delivery verification — the last page of the document.
 *
 * This page is filled in by hand after the goods arrive, long after the note
 * itself is approved, so it stands on its own at the back where it can be
 * printed or detached without carrying the rest of the note with it. That is
 * also why it repeats the note number, vendor and date: on its own it still
 * has to say which purchase it belongs to.
 */
export function buildPostDeliveryPage(note) {
  // Headings take their colour from how many vendors actually quoted.
  const { headCell } = themed(note);
  const children = [];

  children.push(para('POST-DELIVERY VERIFICATION', {
    bold: true, size: 13, align: ALIGN.CENTER, color: COLOURS.ACCENT,
    pageBreakBefore: true, after: 2,
  }));
  children.push(para('To be completed on receipt of the goods or on completion of the service', {
    size: 9.5, italic: true, align: ALIGN.CENTER, color: COLOURS.MUTED, after: 8,
  }));

  // The page may be detached, so it restates what it belongs to.
  children.push(table([
    row([
      headCell('Approval Note', { width: 18, align: ALIGN.LEFT }),
      cell(note.note_no || `#${note.id}`, { width: 32, align: ALIGN.LEFT }),
      headCell('Dated', { width: 14, align: ALIGN.LEFT }),
      cell(formatDate(note.note_date), { width: 36, align: ALIGN.LEFT }),
    ]),
    row([
      headCell('Vendor', { align: ALIGN.LEFT }),
      cell(note.selected_quotation?.vendor_name || '—', { align: ALIGN.LEFT }),
      headCell('Project', { align: ALIGN.LEFT }),
      cell(note.project_name || '—', { align: ALIGN.LEFT }),
    ]),
    row([
      headCell('Subject', { align: ALIGN.LEFT }),
      cell(note.subject || '', { span: 3, align: ALIGN.LEFT }),
    ]),
  ], { borders: GRID }));

  children.push(spacer(8));

  const rows = [
    row([
      headCell('Sr. no', { width: 7 }),
      headCell('Particulars', { width: 38, align: ALIGN.LEFT }),
      headCell('Qty ordered', { width: 11 }),
      headCell('Item delivered / Service availed', { width: 22 }),
      headCell('Name & Sign', { width: 22 }),
    ], { header: true }),
  ];

  // The whole schedule goes on this page — it is no longer sharing space with
  // the front page, so there is no reason to cap the list.
  const lines = note.items.length
    ? note.items
    : [{ description: note.item_description || note.subject || '' }];

  lines.forEach((item, index) => {
    rows.push(row([
      cell(String(item.line_no ?? index + 1), { align: ALIGN.CENTER }),
      cell(item.description, { align: ALIGN.LEFT }),
      cell(item.quantity !== undefined ? `${qty(item.quantity)} ${item.unit || ''}`.trim() : '', { align: ALIGN.CENTER }),
      cell('', {}),
      cell('', {}),
    ]));
  });

  children.push(table(rows, { borders: GRID }));

  children.push(spacer(10));

  // Space to record when it actually arrived and who accepted it.
  children.push(table([
    row([
      headCell('Date of receipt', { width: 25, align: ALIGN.LEFT }),
      cell('', { width: 25 }),
      headCell('Challan / Invoice no.', { width: 25, align: ALIGN.LEFT }),
      cell('', { width: 25 }),
    ]),
    row([
      headCell('Remarks on condition / shortfall', { align: ALIGN.LEFT }),
      cell('', { span: 3 }),
    ]),
  ], { borders: GRID }));

  children.push(spacer(14));

  children.push(table([
    row([
      cell([para('Received and verified by', { bold: true, size: 9, after: 20 })],
        { width: 33, borders: NO_BORDER, align: ALIGN.LEFT }),
      cell([para('Store / Site in-charge', { bold: true, size: 9, after: 20 })],
        { width: 33, borders: NO_BORDER, align: ALIGN.LEFT }),
      cell([para('Project In-charge', { bold: true, size: 9, after: 20 })],
        { width: 34, borders: NO_BORDER, align: ALIGN.LEFT }),
    ]),
    row([
      cell([para('Name & Sign: ________________', { size: 9 }), para('Date: ____________', { size: 9 })],
        { borders: NO_BORDER, align: ALIGN.LEFT }),
      cell([para('Name & Sign: ________________', { size: 9 }), para('Date: ____________', { size: 9 })],
        { borders: NO_BORDER, align: ALIGN.LEFT }),
      cell([para('Name & Sign: ________________', { size: 9 }), para('Date: ____________', { size: 9 })],
        { borders: NO_BORDER, align: ALIGN.LEFT }),
    ]),
  ], { borders: NO_BORDER }));

  return children;
}

/** Signature strip, four to a row, showing any decision already recorded. */
function signatureBlock(note) {
  const children = [];

  const stageLabel = {
    check: 'Checked by', verify: 'Verified by', accounts: 'Accounts', approve: 'Approved by',
  };

  const slots = [{
    role: 'Prepared by',
    name: note.prepared_by_name || note.preparer_name || '',
    decision: 'approved',
    at: note.submitted_at,
  }];

  for (const step of note.steps) {
    slots.push({
      role: stageLabel[step.step_type] || step.step_type,
      name: step.assignee_name || step.assignee_full_name || '',
      decision: step.decision,
      at: step.decided_at,
    });
  }

  if (note.steps.length === 0) {
    slots.push(
      { role: 'Checked by', name: '' }, { role: 'Checked by', name: '' },
      { role: 'Verified by', name: '' }, { role: 'Verified by', name: '' },
      { role: 'Approved by', name: 'Managing Director Sir' },
      { role: 'Approved by', name: 'Hon. Chairman Sir' },
    );
  }

  children.push(spacer(10));

  for (let i = 0; i < slots.length; i += 4) {
    const group = slots.slice(i, i + 4);
    while (group.length < 4) group.push(null);

    children.push(table([
      row(group.map((slot) => cell(
        slot ? [para(slot.role, { bold: true, size: 9, after: 14 })] : [para('', { after: 14 })],
        { width: 25, borders: NO_BORDER, align: ALIGN.LEFT },
      ))),
      row(group.map((slot) => {
        if (!slot) return cell('', { width: 25, borders: NO_BORDER });
        const runs = [text(slot.name || '________________', { size: 9 })];
        if (slot.decision && slot.decision !== 'pending') {
          const colour = slot.decision === 'approved' ? COLOURS.GOOD
            : slot.decision === 'rejected' ? COLOURS.WARN : COLOURS.MUTED;
          runs.push(text(`\n${slot.decision === 'approved' ? 'Approved' : slot.decision === 'rejected' ? 'Rejected' : 'On hold'}${slot.at ? ` ${formatDate(slot.at, { style: 'short' })}` : ''}`,
            { size: 7.5, color: colour, break: 1 }));
        } else if (slot.decision === 'pending') {
          runs.push(text('\nPending', { size: 7.5, color: COLOURS.MUTED, break: 1 }));
        }
        return cell([para(runs, { after: 4 })], { width: 25, borders: NO_BORDER, align: ALIGN.LEFT });
      })),
    ], { borders: NO_BORDER }));

    children.push(spacer(6));
  }

  return children;
}

export function buildFrontPage(note, { annexureIndex = [] } = {}) {
  const children = [];

  children.push(...titleBlock(note));
  children.push(...comparisonSummaryBlock(note));
  children.push(...selectionBlock(note));
  children.push(...costTable(note));
  children.push(...termsBlock(note));
  children.push(...accountsBlock(note));
  // Post-delivery verification is not here: it is filled in weeks later, so it
  // sits on its own page at the back of the document.
  children.push(...signatureBlock(note));

  // The enclosure list, naming every annexure by its letter.
  if (annexureIndex.length) {
    children.push(para([
      text('Encl: ', { bold: true, size: 9.5 }),
      text(annexureIndex.map((a) => `${a.letter} — ${a.title}`).join('; '), { size: 9.5 }),
    ], { before: 4 }));
  } else {
    children.push(para('Encl:. Quotations Enclosed.', { bold: true, size: 9.5, before: 4 }));
  }

  return children;
}

export default buildFrontPage;
