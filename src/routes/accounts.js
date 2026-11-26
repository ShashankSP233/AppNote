import express from 'express';
import { one, many, query, tx } from '../db.js';
import { wrap, httpError, requireAuth, requireRole, audit } from '../middleware.js';
import { loadNote } from '../notes-repo.js';
import { TDS_SECTIONS, TCS_SECTIONS, GST_RATES, SUPPLY_TYPES, suggestTds, computeDeductions, TAX_DISCLAIMER } from '../tax.js';
import { num, round2, isValidGstin, isValidPan, panFromGstin, constitutionFromPan, stateNameFromCode } from '../domain.js';

const router = express.Router();

router.use(requireAuth);

/** The catalogue the accounts screen draws from. */
router.get('/tax/sections', (req, res) => {
  res.json({
    tds: TDS_SECTIONS,
    tcs: TCS_SECTIONS,
    gst_rates: GST_RATES,
    supply_types: SUPPLY_TYPES,
    disclaimer: TAX_DISCLAIMER,
  });
});

async function requireNote(id) {
  const note = await loadNote(Number(id), { includeSensitiveVendorDetails: true });
  if (!note) throw httpError(404, 'There is no note with that id.');
  return note;
}

/**
 * Item-wise tax verification — the check the business asked for by name.
 * Accounts confirms or corrects the GST rate on each line, and the note keeps
 * both figures so the document can show what changed.
 */
router.post('/notes/:id/tax-verify', requireRole('accounts', 'admin'), wrap(async (req, res) => {
  const noteId = Number(req.params.id);
  const note = await requireNote(noteId);

  const entries = Array.isArray(req.body?.items) ? req.body.items : [];
  if (!entries.length) throw httpError(400, 'Send the lines to verify.');

  const validIds = new Set(note.items.map((i) => i.id));

  await tx(async () => {
    for (const entry of entries) {
      const itemId = Number(entry.id);
      if (!validIds.has(itemId)) continue;

      const verified = entry.tax_verified !== false;
      const rate = entry.verified_gst_rate === null || entry.verified_gst_rate === undefined || entry.verified_gst_rate === ''
        ? null
        : num(entry.verified_gst_rate);

      if (verified && rate !== null && (rate < 0 || rate > 50)) {
        throw httpError(400, `${rate}% is not a sensible GST rate.`);
      }

      // The casts matter: against an untyped NULL in the ELSE branch Postgres
      // cannot infer the parameter's type and falls back to text.
      await query(
        `UPDATE note_items SET
           tax_verified = $1::boolean,
           verified_gst_rate = $2::numeric,
           tax_remark = $3::text,
           tds_section_override = COALESCE($4::text, tds_section_override),
           verified_by = CASE WHEN $1::boolean THEN $5::integer ELSE NULL::integer END,
           verified_at = CASE WHEN $1::boolean THEN now() ELSE NULL::timestamptz END
         WHERE id = $6 AND note_id = $7`,
        [verified, verified ? rate : null, entry.tax_remark || null,
          entry.tds_section_override ?? null, req.user.id, itemId, noteId],
      );
    }

    const outstanding = await one(
      'SELECT COUNT(*)::int AS count FROM note_items WHERE note_id = $1 AND NOT tax_verified',
      [noteId],
    );

    await query(
      `INSERT INTO accounts_review (note_id, all_items_tax_verified, reviewed_by, reviewed_at, updated_at)
       VALUES ($1,$2,$3,now(),now())
       ON CONFLICT (note_id) DO UPDATE
         SET all_items_tax_verified = EXCLUDED.all_items_tax_verified,
             reviewed_by = EXCLUDED.reviewed_by, reviewed_at = now(),
             workflow_reviewed_at = NULL, updated_at = now()`,
      [noteId, outstanding.count === 0, req.user.id],
    );
  });

  await audit(req, {
    noteId, action: 'tax_verified', entity: 'note', entityId: noteId,
    detail: { lines: entries.length },
  });

  const refreshed = await loadNote(noteId, { includeSensitiveVendorDetails: true });
  await refreshComputedAmounts(refreshed, req.user.id);
  res.json({ note: await loadNote(noteId, { includeSensitiveVendorDetails: true }) });
}));

/** Writes the computed totals onto the accounts record so they are on file. */
async function refreshComputedAmounts(note, userId) {
  await query(
    `INSERT INTO accounts_review (note_id, basic_amount, gst_amount, grand_total, net_payable, reviewed_by, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,now())
     ON CONFLICT (note_id) DO UPDATE
       SET basic_amount = EXCLUDED.basic_amount,
           gst_amount = EXCLUDED.gst_amount,
           grand_total = EXCLUDED.grand_total,
           net_payable = EXCLUDED.net_payable,
           updated_at = now()`,
    [note.id, note.totals.basic, note.totals.gstTotal, note.totals.grandTotal,
      note.deductions.netPayable, userId || null],
  );
}

/** A starting point for TDS, which accounts then accepts or overrides. */
router.get('/notes/:id/tax-suggestion', requireRole('accounts', 'admin'), wrap(async (req, res) => {
  const note = await requireNote(req.params.id);
  const selected = note.selected_quotation;

  if (!selected) throw httpError(400, 'No vendor has been selected on this note yet.');

  // The dominant supply type across the priced lines decides the section.
  const counts = note.items.reduce((acc, item) => {
    acc[item.supply_type] = (acc[item.supply_type] || 0) + 1;
    return acc;
  }, {});
  const supplyType = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'goods';

  const pan = note.vendor_pan;
  const suggestion = suggestTds({
    supplyType,
    basicAmount: note.totals.basic,
    constitution: note.vendor_constitution || constitutionFromPan(pan) || 'other',
    hasPan: Boolean(pan && isValidPan(pan)),
    isSpecifiedPerson: Boolean(selected.is_specified_person),
  });

  res.json({ suggestion, supplyType, disclaimer: TAX_DISCLAIMER });
}));

/** The accounts checklist and the TDS/TCS decision. */
router.put('/notes/:id/accounts', requireRole('accounts', 'admin'), wrap(async (req, res) => {
  const noteId = Number(req.params.id);
  const note = await requireNote(noteId);
  const b = req.body || {};

  if (b.tds_applicable && !b.tds_section) {
    throw httpError(400, 'Choose the TDS section.');
  }
  if (b.tcs_applicable && !b.tcs_section) {
    throw httpError(400, 'Choose the TCS section.');
  }

  const deductions = computeDeductions({
    basic: note.totals.basic,
    gstTotal: note.totals.gstTotal,
    grandTotal: note.totals.grandTotal,
    tds: {
      applicable: Boolean(b.tds_applicable),
      section: b.tds_section || null,
      rate: num(b.tds_rate, 0),
      base: b.tds_base === '' || b.tds_base === undefined ? null : num(b.tds_base),
      amount: b.tds_amount === '' || b.tds_amount === undefined ? null : num(b.tds_amount),
    },
    tcs: {
      applicable: Boolean(b.tcs_applicable),
      section: b.tcs_section || null,
      rate: num(b.tcs_rate, 0),
      base: b.tcs_base === '' || b.tcs_base === undefined ? null : num(b.tcs_base),
      amount: b.tcs_amount === '' || b.tcs_amount === undefined ? null : num(b.tcs_amount),
    },
  });

  const outstanding = await one(
    'SELECT COUNT(*)::int AS count FROM note_items WHERE note_id = $1 AND NOT tax_verified',
    [noteId],
  );

  const values = [
    noteId,
    Boolean(b.gst_number_checked), b.gst_status || null, b.gst_checked_on || null,
    Boolean(b.pan_number_checked), b.pan_status || null, b.pan_checked_on || null,
    Boolean(b.msme_checked), Boolean(b.bank_details_checked),
    Boolean(b.duplicate_checked), Boolean(b.budget_checked),
    outstanding.count === 0,
    deductions.tds.applicable, deductions.tds.section, deductions.tds.rate,
    deductions.tds.base, deductions.tds.amount, b.tds_remark || null,
    deductions.tcs.applicable, deductions.tcs.section, deductions.tcs.rate,
    deductions.tcs.base, deductions.tcs.amount, b.tcs_remark || null,
    note.totals.basic, note.totals.gstTotal, note.totals.grandTotal, deductions.netPayable,
    b.remarks || null, req.user.id,
  ];

  await query(
    `INSERT INTO accounts_review
       (note_id, gst_number_checked, gst_status, gst_checked_on,
        pan_number_checked, pan_status, pan_checked_on,
        msme_checked, bank_details_checked, duplicate_checked, budget_checked,
        all_items_tax_verified,
        tds_applicable, tds_section, tds_rate, tds_base, tds_amount, tds_remark,
        tcs_applicable, tcs_section, tcs_rate, tcs_base, tcs_amount, tcs_remark,
        basic_amount, gst_amount, grand_total, net_payable, remarks, reviewed_by, reviewed_at, updated_at,
        workflow_reviewed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,
             $25,$26,$27,$28,$29,$30,now(),now(),now())
     ON CONFLICT (note_id) DO UPDATE SET
        gst_number_checked = EXCLUDED.gst_number_checked,
        gst_status = EXCLUDED.gst_status,
        gst_checked_on = EXCLUDED.gst_checked_on,
        pan_number_checked = EXCLUDED.pan_number_checked,
        pan_status = EXCLUDED.pan_status,
        pan_checked_on = EXCLUDED.pan_checked_on,
        msme_checked = EXCLUDED.msme_checked,
        bank_details_checked = EXCLUDED.bank_details_checked,
        duplicate_checked = EXCLUDED.duplicate_checked,
        budget_checked = EXCLUDED.budget_checked,
        all_items_tax_verified = EXCLUDED.all_items_tax_verified,
        tds_applicable = EXCLUDED.tds_applicable,
        tds_section = EXCLUDED.tds_section,
        tds_rate = EXCLUDED.tds_rate,
        tds_base = EXCLUDED.tds_base,
        tds_amount = EXCLUDED.tds_amount,
        tds_remark = EXCLUDED.tds_remark,
        tcs_applicable = EXCLUDED.tcs_applicable,
        tcs_section = EXCLUDED.tcs_section,
        tcs_rate = EXCLUDED.tcs_rate,
        tcs_base = EXCLUDED.tcs_base,
        tcs_amount = EXCLUDED.tcs_amount,
        tcs_remark = EXCLUDED.tcs_remark,
        basic_amount = EXCLUDED.basic_amount,
        gst_amount = EXCLUDED.gst_amount,
        grand_total = EXCLUDED.grand_total,
        net_payable = EXCLUDED.net_payable,
        remarks = EXCLUDED.remarks,
        reviewed_by = EXCLUDED.reviewed_by,
        reviewed_at = now(),
        updated_at = now(),
        workflow_reviewed_at = now()`,
    values,
  );

  // Record the registration checks against the vendor too, so the next note
  // for the same vendor starts from a known position.
  if (note.selected_quotation?.vendor_source_id
      && (b.gst_number_checked || b.pan_number_checked || b.bank_details_checked || b.msme_checked)) {
    await query(
      `INSERT INTO vendor_reviews
         (source_system, source_vendor_id, gst_verified, pan_verified, bank_verified, msme_verified,
          verified_by, verified_at, updated_at)
       VALUES ('siteerp',$1,$2,$3,$4,$5,$6,now(),now())
       ON CONFLICT (source_system, source_vendor_id) DO UPDATE SET
         gst_verified=CASE WHEN $2 THEN TRUE ELSE vendor_reviews.gst_verified END,
         pan_verified=CASE WHEN $3 THEN TRUE ELSE vendor_reviews.pan_verified END,
         bank_verified=CASE WHEN $4 THEN TRUE ELSE vendor_reviews.bank_verified END,
         msme_verified=CASE WHEN $5 THEN TRUE ELSE vendor_reviews.msme_verified END,
         verified_by=$6, verified_at=now(), updated_at=now()`,
      [note.selected_quotation.vendor_source_id, Boolean(b.gst_number_checked), Boolean(b.pan_number_checked),
        Boolean(b.bank_details_checked), Boolean(b.msme_checked), req.user.id],
    );
  } else if (note.selected_quotation?.vendor_id && (b.gst_number_checked || b.pan_number_checked)) {
    await query(
      `UPDATE vendors SET
         gst_verified = CASE WHEN $1 THEN TRUE ELSE gst_verified END,
         pan_verified = CASE WHEN $2 THEN TRUE ELSE pan_verified END,
         bank_verified = CASE WHEN $3 THEN TRUE ELSE bank_verified END,
         msme_verified = CASE WHEN $4 THEN TRUE ELSE msme_verified END,
         verified_by = $5, verified_at = now(), updated_at = now()
       WHERE id = $6`,
      [Boolean(b.gst_number_checked), Boolean(b.pan_number_checked),
        Boolean(b.bank_details_checked), Boolean(b.msme_checked),
        req.user.id, note.selected_quotation.vendor_id],
    );
  }

  await audit(req, {
    noteId, action: 'accounts_updated', entity: 'note', entityId: noteId,
    detail: { tds: deductions.tds, tcs: deductions.tcs },
  });

  res.json({
    note: await loadNote(noteId, { includeSensitiveVendorDetails: true }),
    warnings: deductions.warnings,
  });
}));

/**
 * What accounts should look at: registration cross-checks, duplicate payment
 * detection and anything left unverified.
 */
router.get('/notes/:id/accounts/checklist', requireRole('accounts', 'approver', 'admin'), wrap(async (req, res) => {
  const noteId = Number(req.params.id);
  const note = await requireNote(noteId);
  const selected = note.selected_quotation;

  const findings = [];

  if (!selected) {
    findings.push({ level: 'blocking', label: 'Vendor', message: 'No vendor has been selected on this note.' });
  } else {
    const gstin = selected.vendor_gstin;
    const pan = note.vendor_pan;

    if (!gstin) {
      findings.push({ level: 'advisory', label: 'GST', message: 'No GSTIN is on record for this vendor. Confirm whether they are unregistered, which would make this a reverse-charge supply.' });
    } else if (!isValidGstin(gstin)) {
      findings.push({ level: 'blocking', label: 'GST', message: `${gstin} does not pass the GSTIN check digit. Confirm it on the GST portal before payment.` });
    } else {
      const derived = panFromGstin(gstin);
      if (pan && derived && pan !== derived) {
        findings.push({ level: 'blocking', label: 'PAN', message: `The PAN on record (${pan}) does not match the PAN inside the GSTIN (${derived}).` });
      } else {
        findings.push({ level: 'good', label: 'GST', message: `${gstin} is well formed — ${stateNameFromCode(gstin.slice(0, 2)) || 'unknown state'}.` });
      }
    }

    if (!pan) {
      findings.push({ level: 'blocking', label: 'PAN', message: 'No PAN is on record. Section 206AA requires deduction at 20% where PAN is not furnished.' });
    } else if (!isValidPan(pan)) {
      findings.push({ level: 'blocking', label: 'PAN', message: `${pan} is not a valid PAN format.` });
    }

    if (selected.is_specified_person) {
      findings.push({ level: 'advisory', label: 'TDS', message: 'This vendor is flagged as a specified person under 206AB. Check the compliance portal and apply the higher rate.' });
    }

    if (!selected.bank_verified && selected.bank_account) {
      findings.push({ level: 'advisory', label: 'Bank', message: 'The bank details have not been verified against a cancelled cheque.' });
    }
    if (!selected.bank_account) {
      findings.push({ level: 'advisory', label: 'Bank', message: 'No bank details are on record for this vendor.' });
    }

    // Duplicate payment: the same vendor and a near-identical value within 90 days.
    const similar = await many(
      `SELECT n.id, n.note_no, n.note_date, n.subject, ar.grand_total
         FROM approval_notes n
         JOIN quotations q ON q.id = n.selected_quotation_id
         LEFT JOIN accounts_review ar ON ar.note_id = n.id
        WHERE n.id <> $1
          AND (($2::text IS NOT NULL AND q.vendor_source_id = $2)
            OR ($3::int IS NOT NULL AND q.vendor_id = $3))
          AND n.note_date >= CURRENT_DATE - INTERVAL '90 days'
          AND n.status IN ('approved','pending_approval','pending_accounts')
        ORDER BY n.note_date DESC LIMIT 10`,
      [noteId, selected.vendor_source_id || null, selected.vendor_id || null],
    );

    const duplicates = similar.filter((s) => {
      if (s.grand_total === null || s.grand_total === undefined) return false;
      return Math.abs(num(s.grand_total) - note.totals.grandTotal) <= Math.max(100, note.totals.grandTotal * 0.02);
    });

    if (duplicates.length) {
      findings.push({
        level: 'blocking',
        label: 'Duplicate',
        message: `A note for the same vendor and a very similar amount exists: ${duplicates.map((d) => `${d.note_no || d.id} dated ${d.note_date}`).join('; ')}. Confirm this is not a repeat payment.`,
      });
    } else if (similar.length) {
      findings.push({
        level: 'advisory',
        label: 'Duplicate',
        message: `${similar.length} other note(s) for this vendor in the last 90 days, at different values.`,
      });
    }
  }

  const unverified = note.items.filter((i) => !i.tax_verified);
  if (unverified.length) {
    findings.push({
      level: 'blocking',
      label: 'Tax',
      message: `${unverified.length} of ${note.items.length} line(s) still need their tax rate confirmed.`,
    });
  } else if (note.items.length) {
    findings.push({ level: 'good', label: 'Tax', message: 'Every line has had its tax rate confirmed.' });
  }

  const changed = note.items.filter((i) => i.tax_verified && i.verified_gst_rate !== null
    && num(i.verified_gst_rate) !== num(i.gst_rate));
  if (changed.length) {
    findings.push({
      level: 'advisory',
      label: 'Tax',
      message: `${changed.length} line(s) had the proposed rate corrected: ${changed.map((i) => `${i.description.slice(0, 30)} ${num(i.gst_rate)}% → ${num(i.verified_gst_rate)}%`).join('; ')}.`,
    });
  }

  if (note.totals.mixedRates) {
    findings.push({ level: 'advisory', label: 'Tax', message: 'This note carries more than one GST rate. Check the rate against the HSN on each line.' });
  }

  findings.push(...note.deductions.warnings.map((message) => ({ level: 'advisory', label: 'TDS/TCS', message })));

  if (!note.schedule.reconciles && note.milestones.length) {
    findings.push({ level: 'advisory', label: 'Schedule', message: note.schedule.warnings.join(' ') });
  }

  res.json({
    findings,
    blocking: findings.filter((f) => f.level === 'blocking').length,
    totals: note.totals,
    deductions: note.deductions,
    disclaimer: TAX_DISCLAIMER,
  });
}));

export default router;
