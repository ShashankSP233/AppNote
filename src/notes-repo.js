// Assembling a note: every related row, plus the computed totals, comparison,
// deductions, schedule and readiness assessment. One function so the document
// generator, the API and the tests all see exactly the same object.

import { many, one, query, tx } from './db.js';
import { num, round2, financialYear, monthName, stateCodeFromGstin, panFromGstin, constitutionFromPan } from './domain.js';
import { noteTotals, computeDeductions, schedulePayments } from './tax.js';
import { buildComparison, comparisonSummary, quotationCost, DEFAULT_WEIGHTS } from './comparison.js';

const COMPANY_STATE = process.env.COMPANY_STATE_CODE || '27'; // Maharashtra

/**
 * Turns a flat list of quotations into one entry per offer, newest version
 * first, with the versions it replaced hanging off it as `history` (newest
 * replaced version first).
 *
 * A revision chain is followed through `supersedes_id`. A row whose
 * predecessor is missing — deleted at some point — still stands on its own
 * rather than disappearing, so no quotation is ever lost from the note.
 */
export function attachVersionHistory(quotations = []) {
  const byId = new Map(quotations.map((q) => [q.id, q]));
  const replacedBy = new Map();

  for (const quotation of quotations) {
    if (quotation.supersedes_id && byId.has(quotation.supersedes_id)) {
      replacedBy.set(quotation.supersedes_id, quotation);
    }
  }

  // Current = anything nothing else replaced. The is_superseded flag is the
  // intent; this check is what the rows actually say, and the two agree except
  // where a later version was deleted.
  const current = quotations.filter((q) => !replacedBy.has(q.id));

  for (const quotation of current) {
    const history = [];
    let previous = quotation.supersedes_id ? byId.get(quotation.supersedes_id) : null;
    const seen = new Set([quotation.id]);

    while (previous && !seen.has(previous.id)) {
      seen.add(previous.id);
      history.push(previous);
      previous = previous.supersedes_id ? byId.get(previous.supersedes_id) : null;
    }

    quotation.history = history;
    quotation.version_count = history.length + 1;
  }

  return current;
}

export async function loadNote(noteId, { includeFiles = true, includeSensitiveVendorDetails = false } = {}) {
  const note = await one(
    `SELECT n.*,
            p.name AS project_name, p.code AS project_code,
            p.location AS project_location,
            p.state_code AS project_state_code,
            r.requisition_no, r.raised_on::text AS requisition_raised_on,
            r.raised_by_name AS requisition_raised_by, r.vessel AS requisition_vessel,
            r.department AS requisition_department,
            r.purpose AS requisition_purpose,
            r.required_by AS requisition_required_by,
            r.remarks AS requisition_remarks,
            u.full_name AS preparer_name, u.designation AS preparer_designation
       FROM approval_notes n
       LEFT JOIN projects p ON p.id = n.project_id
       LEFT JOIN requisitions r ON r.id = n.requisition_id
       LEFT JOIN users u ON u.id = n.prepared_by
      WHERE n.id = $1`,
    [noteId],
  );

  if (!note) return null;

  const localBankFields = includeSensitiveVendorDetails
    ? 'v.bank_name, v.bank_account, v.bank_ifsc'
    : 'NULL::text AS bank_name, NULL::text AS bank_account, NULL::text AS bank_ifsc';

  let externalRequisitionItems = null;
  if (note.requisition_source === 'reqflow') {
    const snapshot = note.source_requisition_snapshot;
    if (snapshot) {
      note.project_name = snapshot.project_name || note.project_name;
      note.project_code = snapshot.project_code || note.project_code;
      note.requisition_no = snapshot.ref_number;
      note.requisition_raised_on = snapshot.requisition_date;
      note.requisition_raised_by = snapshot.raised_by_name;
      note.requisition_vessel = snapshot.site_name;
      note.requisition_purpose = snapshot.purpose;
      note.requisition_remarks = snapshot.notes;
      externalRequisitionItems = (snapshot.items || []).map((item, index) => ({
        line_no: item.line_no || index + 1,
        description: item.item_name,
        specification: null,
        part_no: item.reference_no,
        quantity: item.quantity,
        unit: item.unit,
        remarks: item.remark,
      }));
    } else {
      try {
        const sourceRequisition = await one(
          `SELECT r.ref_number AS requisition_no, r.requisition_date AS requisition_raised_on,
                  r.raised_by_name AS requisition_raised_by,
                  COALESCE(r.site_name, s.name) AS requisition_vessel,
                  r.purpose AS requisition_purpose, r.notes AS requisition_remarks,
                  p.name AS project_name, p.code AS project_code
             FROM fdw_reqflow.requisitions r
             LEFT JOIN fdw_reqflow.projects p ON p.id=r.project_id
             LEFT JOIN fdw_reqflow.sites s ON s.id=r.site_id
            WHERE r.id::text=$1`, [note.requisition_source_id]);
        if (!sourceRequisition) {
          note.requisition_source_unavailable = true;
        } else {
          Object.assign(note, sourceRequisition);
          externalRequisitionItems = await many(
            `SELECT sort_order AS line_no, item_name AS description, NULL::text AS specification,
                    reference_no AS part_no, quantity, unit, remark AS remarks
               FROM fdw_reqflow.requisition_items
              WHERE requisition_id::text=$1 ORDER BY sort_order, id`, [note.requisition_source_id]);
        }
      } catch {
        note.requisition_source_unavailable = true;
      }
    }
  }
  delete note.source_requisition_snapshot;

  const [quotations, noteItems, criteriaRows, criteriaValues, milestones, accounts, steps, requisitionItems] =
    await Promise.all([
      many(
        `SELECT q.*,
                COALESCE(vr.gst_verified, v.gst_verified, FALSE) AS gst_verified,
                COALESCE(vr.pan_verified, v.pan_verified, FALSE) AS pan_verified,
                COALESCE(vr.bank_verified, v.bank_verified, FALSE) AS bank_verified,
                COALESCE(vr.msme_verified, v.msme_verified, FALSE) AS msme_verified,
                v.is_specified_person, v.vendor_constitution,
                ${localBankFields}, v.msme_number,
                v.address AS vendor_address
           FROM quotations q
           LEFT JOIN vendors v ON v.id = q.vendor_id
           LEFT JOIN vendor_reviews vr ON vr.source_system='siteerp' AND vr.source_vendor_id=q.vendor_source_id
          WHERE q.note_id = $1
          ORDER BY q.position, q.id`,
        [noteId],
      ),
      many('SELECT * FROM note_items WHERE note_id = $1 ORDER BY line_no, id', [noteId]),
      many('SELECT * FROM comparison_criteria WHERE note_id = $1 ORDER BY line_no, id', [noteId]),
      many(
        `SELECT cv.* FROM comparison_values cv
           JOIN comparison_criteria cc ON cc.id = cv.criterion_id
          WHERE cc.note_id = $1`,
        [noteId],
      ),
      many('SELECT * FROM payment_milestones WHERE note_id = $1 ORDER BY line_no, id', [noteId]),
      one('SELECT * FROM accounts_review WHERE note_id = $1', [noteId]),
      many(
        `SELECT w.*, u.full_name AS assignee_full_name, u.designation AS assignee_designation
           FROM workflow_steps w
           LEFT JOIN users u ON u.id = w.assignee_id
          WHERE w.note_id = $1
          ORDER BY w.step_order, w.id`,
        [noteId],
      ),
      note.requisition_source === 'reqflow'
        ? Promise.resolve(externalRequisitionItems || [])
        : note.requisition_id
          ? many('SELECT * FROM requisition_items WHERE requisition_id = $1 ORDER BY line_no, id', [note.requisition_id])
          : Promise.resolve([]),
    ]);

  const externalVendorIds = [...new Set(quotations.map((q) => q.vendor_source_id).filter(Boolean))];
  if (externalVendorIds.length) {
    try {
      const sourceBankFields = includeSensitiveVendorDetails
        ? ', bank_name, bank_account_no, ifsc_code'
        : '';
      const sourceVendors = await many(
        `SELECT id::text AS source_id${sourceBankFields}, udyam_id, address, is_active
           FROM fdw_siteerp.vendors WHERE id::text=ANY($1::text[])`, [externalVendorIds]);
      const byId = new Map(sourceVendors.map((vendor) => [vendor.source_id, vendor]));
      for (const quotation of quotations) {
        const vendor = byId.get(quotation.vendor_source_id);
        quotation.vendor_source_active = Boolean(vendor?.is_active);
        if (!vendor) continue;
        if (includeSensitiveVendorDetails) {
          quotation.bank_name = vendor.bank_name || quotation.bank_name;
          quotation.bank_account = vendor.bank_account_no || quotation.bank_account;
          quotation.bank_ifsc = vendor.ifsc_code || quotation.bank_ifsc;
        }
        quotation.msme_number = vendor.udyam_id || quotation.msme_number;
        quotation.vendor_address = vendor.address || quotation.vendor_address;
      }
    } catch {
      note.vendor_source_unavailable = true;
    }
  }

  const quotationIds = quotations.map((q) => q.id);

  const quotationItems = quotationIds.length
    ? await many(
      'SELECT * FROM quotation_items WHERE quotation_id = ANY($1::int[]) ORDER BY quotation_id, line_no, id',
      [quotationIds],
    )
    : [];

  let files = [];
  if (includeFiles) {
    files = await many(
      'SELECT * FROM quotation_files WHERE note_id = $1 OR quotation_id = ANY($2::int[]) ORDER BY uploaded_at',
      [noteId, quotationIds.length ? quotationIds : [0]],
    );
  }

  // Attach children
  for (const quotation of quotations) {
    quotation.items = quotationItems.filter((i) => i.quotation_id === quotation.id);
    quotation.files = files.filter((f) => f.quotation_id === quotation.id);
  }

  // Fold each offer's earlier versions into the version that replaced them, so
  // the rest of the system sees one entry per vendor while the negotiation
  // history stays available for the annexure.
  const currentQuotations = attachVersionHistory(quotations);

  const criteria = criteriaRows.map((criterion) => {
    const values = {};
    for (const value of criteriaValues.filter((v) => v.criterion_id === criterion.id)) {
      values[value.quotation_id] = {
        value_text: value.value_text,
        score: value.score,
        complies: value.complies,
        remarks: value.remarks,
      };
    }
    return { ...criterion, values };
  });

  // The selected quotation may itself have been superseded by a later
  // revision; in that case the revision is what the note is really about.
  const selected = currentQuotations.find((q) => q.id === note.selected_quotation_id)
    || currentQuotations.find((q) => q.history?.some((h) => h.id === note.selected_quotation_id))
    || null;

  // Place of supply decides CGST+SGST against IGST.
  const supplyState = note.supply_state_code || note.project_state_code || COMPANY_STATE;
  const vendorState = selected?.vendor_gstin ? stateCodeFromGstin(selected.vendor_gstin) : null;
  const interState = Boolean(vendorState && supplyState && vendorState !== supplyState);

  const totals = noteTotals(noteItems, { interState });

  const comparison = buildComparison({
    quotations: currentQuotations,
    criteria,
    weights: DEFAULT_WEIGHTS,
    interState,
    selectedQuotationId: note.selected_quotation_id,
  });

  const vendorPan = selected?.vendor_pan || (selected?.vendor_gstin ? panFromGstin(selected.vendor_gstin) : null);
  const constitution = selected?.vendor_constitution || constitutionFromPan(vendorPan) || 'other';

  const deductions = computeDeductions({
    basic: totals.basic,
    gstTotal: totals.gstTotal,
    grandTotal: totals.grandTotal,
    tds: {
      applicable: accounts?.tds_applicable || false,
      section: accounts?.tds_section || null,
      rate: accounts?.tds_rate ?? 0,
      base: accounts?.tds_base ?? null,
      amount: accounts?.tds_amount ?? null,
    },
    tcs: {
      applicable: accounts?.tcs_applicable || false,
      section: accounts?.tcs_section || null,
      rate: accounts?.tcs_rate ?? 0,
      base: accounts?.tcs_base ?? null,
      amount: accounts?.tcs_amount ?? null,
    },
  });

  const schedule = schedulePayments(milestones, {
    basic: totals.basic,
    grandTotal: totals.grandTotal,
    netPayable: deductions.netPayable,
  });

  // Each earlier version is priced the same way as the live one, so the
  // annexure can show what the negotiation actually moved.
  for (const quotation of currentQuotations) {
    for (const earlier of quotation.history || []) {
      earlier.cost = quotationCost(earlier, { interState });
    }
    quotation.cost = quotationCost(quotation, { interState });
  }

  const assembled = {
    ...note,
    quotations: currentQuotations,
    all_quotations: quotations,
    items: noteItems,
    criteria,
    milestones,
    accounts: accounts || null,
    steps,
    files,
    requisition_items: requisitionItems,
    selected_quotation: selected,
    vendor_pan: vendorPan,
    vendor_constitution: constitution,
    interState,
    supply_state_code: supplyState,
    totals,
    comparison,
    comparison_summary: comparisonSummary(comparison),
    deductions,
    schedule,
  };

  assembled.readiness = assessReadiness(assembled);
  return assembled;
}

/**
 * What stops this note being submitted, and what merely deserves a second look.
 *
 * The central rule the business asked for: machine-read figures that nobody has
 * confirmed are blocking. Extraction is a time-saver, not a source of truth.
 */
export function assessReadiness(note) {
  const blocking = [];
  const advisory = [];

  if (!note.subject?.trim()) blocking.push('The subject has not been written.');
  if (!note.project_id && !(note.requisition_source === 'reqflow' && note.requisition_source_id)) {
    blocking.push('No project has been chosen.');
  }
  if (note.requisition_source_unavailable) {
    blocking.push('The linked Reqflow requisition could not be loaded. Reconnect Reqflow before submitting this note.');
  }
  if (!note.requisition_id && !(note.requisition_source === 'reqflow' && note.requisition_source_id)) {
    blocking.push('No requisition is linked. A requisition is required and forms Annexure A.');
  }

  const liveQuotations = note.quotations.filter((q) => !q.is_excluded);
  if (!liveQuotations.length) {
    blocking.push('No quotation has been attached.');
  }

  // SiteERP is a convenience vendor directory. A quotation's reviewed vendor
  // name remains valid even when it has no ERP link or ERP is unavailable.

  const unreviewed = liveQuotations.filter((q) => q.extraction_status === 'extracted');
  if (unreviewed.length) {
    blocking.push(`Machine-read figures are still unconfirmed on ${unreviewed.map((q) => q.vendor_name).join(', ')}. Open each one, check it against the attached copy and mark it confirmed.`);
  }

  const failedExtraction = liveQuotations.filter((q) => q.extraction_status === 'pending');
  if (failedExtraction.length) {
    advisory.push(`Extraction has not finished on ${failedExtraction.map((q) => q.vendor_name).join(', ')}.`);
  }

  if (!note.selected_quotation_id) {
    blocking.push('No vendor has been selected.');
  } else if (!note.selection_reason?.trim()) {
    blocking.push('The reason for selecting the vendor has not been written. It is printed on the front page.');
  }

  if (!note.items.length) {
    blocking.push('The priced schedule is empty.');
  }

  if (liveQuotations.length === 1) {
    advisory.push('Only one quotation is on record. A single-source purchase needs a written justification.');
  }

  const quotationsWithoutFiles = liveQuotations.filter((q) => !(q.files || []).length);
  if (quotationsWithoutFiles.length) {
    advisory.push(`No copy is attached for ${quotationsWithoutFiles.map((q) => q.vendor_name).join(', ')}. Each quotation is an annexure to this note.`);
  }

  const requisitionFiles = (note.files || []).filter((f) => f.kind === 'requisition');
  if (!requisitionFiles.length && !note.requisition_items?.length && !note.requisition_source_id) {
    advisory.push('The requisition has neither a scanned copy nor any line items, so Annexure A will be thin.');
  }

  if (!note.milestones.length) {
    advisory.push('No payment schedule has been entered. It forms Annexure C.');
  } else if (!note.schedule.reconciles) {
    advisory.push(...note.schedule.warnings);
  }

  for (const flag of note.comparison.flags) {
    if (flag.level === 'blocking') blocking.push(flag.message);
    else advisory.push(flag.message);
  }

  advisory.push(...note.deductions.warnings);

  if (!note.payment_terms?.trim()) advisory.push('Payment terms have not been written for the front page.');
  if (!note.delivery_terms?.trim()) advisory.push('Delivery terms have not been written for the front page.');

  return {
    canSubmit: blocking.length === 0,
    blocking,
    advisory: [...new Set(advisory)],
  };
}

/** Accounts-stage gate. Separate because it applies at decision time. */
export function assessAccountsReadiness(note) {
  const blocking = [];
  const accounts = note.accounts;

  const unverified = note.items.filter((i) => !i.tax_verified);
  if (unverified.length) {
    blocking.push(`${unverified.length} of ${note.items.length} line(s) have not had their tax rate confirmed.`);
  }

  if (!accounts) {
    blocking.push('The accounts checklist has not been filled in.');
    return { canApprove: false, blocking };
  }

  if (!accounts.gst_number_checked) blocking.push("The vendor's GST number has not been verified.");
  if (!accounts.pan_number_checked) blocking.push("The vendor's PAN has not been verified.");

  if (accounts.tds_applicable && !accounts.tds_section) {
    blocking.push('TDS is marked applicable but no section has been chosen.');
  }
  if (accounts.tcs_applicable && !accounts.tcs_section) {
    blocking.push('TCS is marked applicable but no section has been chosen.');
  }

  return { canApprove: blocking.length === 0, blocking };
}

/** Stores the preparer-supplied note number, or generates a fallback for API callers. */
export async function allocateNoteNumber(noteId, date = new Date(), requestedNoteNo = null) {
  const customNoteNo = String(requestedNoteNo || '').trim();
  const prefix = process.env.NOTE_PREFIX || 'YG/ Port-Dharti';
  const fy = financialYear(date);
  const month = monthName(date);

  return tx(async () => {
    // Serialize allocation within a financial year across app instances.
    await query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`approval-note-number:${fy}`]);
    const row = await one(
      `SELECT COALESCE(MAX(note_seq), 0) + 1 AS next FROM approval_notes WHERE financial_year = $1`,
      [fy],
    );
    const seq = row?.next || 1;
    const noteNo = customNoteNo || `${prefix}/${fy}/${month}/${seq}`;
    await query(
      `UPDATE approval_notes
          SET note_no = $1, note_seq = $2, financial_year = $3, updated_at = now()
        WHERE id = $4`,
      [noteNo, seq, fy, noteId],
    );

    return { noteNo, seq, financialYear: fy };
  });
}

/**
 * The note list, with filters. Parameters are collected through a closure so
 * placeholder numbering can never drift out of step with the values array.
 */
export async function listNotes({
  status = null,
  projectId = null,
  preparedBy = null,
  assignedTo = null,
  search = null,
  limit = 50,
  offset = 0,
} = {}) {
  const values = [];
  const param = (value) => {
    values.push(value);
    return `$${values.length}`;
  };

  const where = [];

  if (status) {
    if (Array.isArray(status)) where.push(`n.status = ANY(${param(status)}::text[])`);
    else where.push(`n.status = ${param(status)}`);
  }
  if (projectId) where.push(`n.project_id = ${param(Number(projectId))}`);
  if (preparedBy) where.push(`n.prepared_by = ${param(Number(preparedBy))}`);
  if (assignedTo) {
    where.push(`EXISTS (
      SELECT 1 FROM workflow_steps w
       WHERE w.note_id = n.id
         AND w.assignee_id = ${param(Number(assignedTo))}
         AND w.decision = 'pending'
    )`);
  }
  if (search) {
    const needle = `%${String(search).trim()}%`;
    where.push(`(n.subject ILIKE ${param(needle)} OR n.note_no ILIKE ${param(needle)} OR n.item_description ILIKE ${param(needle)})`);
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const limitSql = param(Math.min(200, Math.max(1, Number(limit) || 50)));
  const offsetSql = param(Math.max(0, Number(offset) || 0));

  const rows = await many(
    `SELECT n.id, n.note_no, n.note_date, n.subject, n.status, n.current_stage,
            n.status_label, n.created_at, n.updated_at,
            COALESCE(n.source_requisition_snapshot->>'ref_number', r.requisition_no) AS requisition_no,
            COALESCE(n.source_requisition_snapshot->>'project_name', p.name) AS project_name,
            u.full_name AS preparer_name,
            sel.vendor_name AS selected_vendor,
            (SELECT COUNT(*) FROM quotations q WHERE q.note_id = n.id AND NOT q.is_excluded) AS quotation_count,
            (SELECT COUNT(*) FROM quotations q WHERE q.note_id = n.id AND q.extraction_status = 'extracted') AS unreviewed_count,
            (SELECT COALESCE(SUM(
                CASE WHEN ni.amount IS NOT NULL THEN ni.amount
                     ELSE ni.quantity * ni.rate END
              ), 0) FROM note_items ni WHERE ni.note_id = n.id) AS basic_amount
       FROM approval_notes n
       LEFT JOIN projects p ON p.id = n.project_id
       LEFT JOIN requisitions r ON r.id = n.requisition_id
       LEFT JOIN users u ON u.id = n.prepared_by
       LEFT JOIN quotations sel ON sel.id = n.selected_quotation_id
       ${whereSql}
       ORDER BY n.updated_at DESC
       LIMIT ${limitSql} OFFSET ${offsetSql}`,
    values,
  );

  return rows;
}

/** Totals for a note without loading everything — used by list screens. */
export async function quickTotals(noteId) {
  const items = await many('SELECT * FROM note_items WHERE note_id = $1', [noteId]);
  return noteTotals(items);
}

export function effectiveGstRate(item) {
  if (item.tax_verified && item.verified_gst_rate !== null && item.verified_gst_rate !== undefined) {
    return num(item.verified_gst_rate);
  }
  return num(item.gst_rate, 18);
}

export function lineAmount(item) {
  if (item.amount !== null && item.amount !== undefined && item.amount !== '') return round2(item.amount);
  return round2(num(item.quantity, 0) * num(item.rate, 0));
}
