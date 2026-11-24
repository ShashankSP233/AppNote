import express from 'express';
import fs from 'node:fs/promises';
import { one, many, query, tx } from '../db.js';
import { wrap, httpError, requireAuth, audit, storedPath } from '../middleware.js';
import { loadNote, listNotes, allocateNoteNumber, assessAccountsReadiness } from '../notes-repo.js';
import { round2, num } from '../domain.js';
import { CRITERION_CATEGORIES } from '../comparison.js';

const router = express.Router();

router.use(requireAuth);

// The sequence of stages, and which role owns each one.
const STAGE_ORDER = [
  { type: 'check', status: 'pending_check', role: 'checker', label: 'Checking' },
  { type: 'verify', status: 'pending_verify', role: 'verifier', label: 'Verification' },
  { type: 'accounts', status: 'pending_accounts', role: 'accounts', label: 'Accounts' },
  { type: 'approve', status: 'pending_approval', role: 'approver', label: 'Approval' },
];

function stageFor(type) {
  return STAGE_ORDER.find((s) => s.type === type) || null;
}

async function requireNote(id) {
  const note = await loadNote(Number(id));
  if (!note) throw httpError(404, 'There is no note with that id.');
  return note;
}

/** A draft can only be edited by its preparer, or by an admin. */
function assertEditable(note, user) {
  if (!['draft', 'on_hold', 'rejected'].includes(note.status)) {
    throw httpError(409, `This note is at the ${note.current_stage || note.status} stage and can no longer be edited. Put it on hold first.`);
  }
  if (user.role !== 'admin' && note.prepared_by && note.prepared_by !== user.id) {
    throw httpError(403, 'Only the person who prepared this note can edit it.');
  }
}

function normalizeNoteNumber(value) {
  if (typeof value !== 'string') throw httpError(400, 'Enter the approval note number.');
  const noteNo = value.trim();
  if (!noteNo) throw httpError(400, 'Enter the approval note number.');
  if (noteNo.length > 160 || /[\u0000-\u001f\u007f]/.test(noteNo)) {
    throw httpError(400, 'The approval note number must be a single line of 160 characters or fewer.');
  }
  return noteNo;
}

async function ensureNoteNumberAvailable(noteNo, exceptId = null) {
  const existing = await one(
    `SELECT id FROM approval_notes WHERE note_no = $1 AND ($2::integer IS NULL OR id <> $2) LIMIT 1`,
    [noteNo, exceptId],
  );
  if (existing) throw httpError(409, `The approval note number “${noteNo}” is already in use.`);
}

/** Best-effort ERP vendor registration, called only after a user selects it. */
async function addSelectedVendorToSiteErp(quotation) {
  const name = String(quotation.vendor_name || '').trim();
  const gstin = String(quotation.vendor_gstin || '').toUpperCase().replace(/\s/g, '') || null;
  const pan = String(quotation.vendor_pan || '').toUpperCase().replace(/\s/g, '') || null;
  // A name alone is accepted in AppNote but is too little to create a useful,
  // safely deduplicated ERP master record.
  if (!name || (!gstin && !pan)) return { status: 'skipped', reason: 'Add a GSTIN or PAN to this quotation if you want it added to SiteERP.' };

  try {
    const duplicates = await many(
      `SELECT id, name, is_active FROM fdw_siteerp.vendors
        WHERE ($1::text IS NOT NULL AND upper(regexp_replace(COALESCE(gst_no, tax_identifier, ''), '\\s', '', 'g'))=$1)
           OR ($2::text IS NOT NULL AND upper(regexp_replace(COALESCE(pan_no, ''), '\\s', '', 'g'))=$2)
        ORDER BY CASE WHEN is_active THEN 0 ELSE 1 END, id LIMIT 3`, [gstin, pan],
    );
    if (duplicates.length > 1) {
      return { status: 'skipped', reason: 'The GSTIN and PAN point to different SiteERP vendors. Please check the vendor master before adding this vendor.' };
    }
    const duplicate = duplicates[0];
    if (duplicate) {
      if (!duplicate.is_active) return { status: 'skipped', reason: 'A matching inactive SiteERP vendor exists. The vendor remains available on this note but was not reactivated.' };
      await query('UPDATE quotations SET vendor_source_id=$1, updated_at=now() WHERE id=$2', [String(duplicate.id), quotation.id]);
      return { status: 'linked', vendor: duplicate.name };
    }

    const vendorCodes = await many('SELECT vendor_code FROM fdw_siteerp_write.vendors ORDER BY id DESC');
    const currentCode = vendorCodes.length ? /^(.*?)(\d+)$/.exec(String(vendorCodes[0].vendor_code).trim()) : null;
    const prefix = currentCode?.[1] || 'VEN-';
    const width = currentCode?.[2]?.length || 4;
    let maxCode = 0;
    for (const row of vendorCodes) {
      const code = String(row.vendor_code).trim();
      if (!code.startsWith(prefix)) continue;
      const suffix = code.slice(prefix.length);
      if (/^\d+$/.test(suffix)) maxCode = Math.max(maxCode, Number(suffix));
    }
    const nextCode = `${prefix}${String(maxCode + 1).padStart(width, '0')}`;
    const created = await one(
      `INSERT INTO fdw_siteerp_write.vendors (vendor_code, name, gst_no, pan_no, is_active)
       VALUES ($1,$2,$3,$4,TRUE) RETURNING id, name`,
      [nextCode, name, gstin, pan],
    );
    await query('UPDATE quotations SET vendor_source_id=$1, updated_at=now() WHERE id=$2', [String(created.id), quotation.id]);
    return { status: 'created', vendor: created.name, vendor_code: nextCode };
  } catch (error) {
    // ERP writeback is a convenience: never make the user lose a valid local
    // selection because the integration is unavailable or not configured.
    return { status: 'skipped', reason: 'The vendor was selected in AppNote, but SiteERP could not be updated. Check the ERP write connection and vendor details.' };
  }
}

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

router.get('/', wrap(async (req, res) => {
  const rows = await listNotes({
    status: req.query.status || null,
    projectId: req.query.project_id || null,
    preparedBy: req.query.mine === '1' ? req.user.id : (req.query.prepared_by || null),
    search: req.query.q || null,
    limit: req.query.limit,
    offset: req.query.offset,
  });
  res.json({ notes: rows });
}));

/** Notes waiting on the signed-in person. */
router.get('/inbox', wrap(async (req, res) => {
  const rows = await listNotes({ assignedTo: req.user.id, limit: 100 });
  res.json({ notes: rows });
}));

router.get('/:id', wrap(async (req, res) => {
  const note = await requireNote(req.params.id);
  res.json({ note });
}));

// ---------------------------------------------------------------------------
// Create and edit
// ---------------------------------------------------------------------------

router.post('/', wrap(async (req, res) => {
  const b = req.body || {};
  if (!b.subject?.trim()) throw httpError(400, 'The note needs a subject.');
  const requestedNoteNo = b.note_no === undefined || b.note_no === ''
    ? null
    : normalizeNoteNumber(b.note_no);

  if (!b.source_requisition_id) {
    throw httpError(400, 'Choose a requisition from Reqflow before creating the approval note.');
  }
  const requisitionSourceId = String(b.source_requisition_id).trim();
  const sourceRequisition = await one(
    `SELECT r.id, r.ref_number, r.status, r.project_id, p.name AS project_name, p.code AS project_code,
            r.site_id, COALESCE(r.site_name, s.name) AS site_name,
            r.raised_by_name, r.requisition_date, r.priority, r.purpose, r.notes,
            r.submitted_at, r.approved_at, r.completed_at, r.created_at, r.updated_at
       FROM fdw_reqflow.requisitions r
       LEFT JOIN fdw_reqflow.projects p ON p.id=r.project_id
       LEFT JOIN fdw_reqflow.sites s ON s.id=r.site_id
      WHERE r.id::text=$1`, [requisitionSourceId]);
  if (!sourceRequisition) throw httpError(400, 'That Reqflow requisition is no longer available. Refresh the list and choose it again.');
  const sourceItems = await many(
    `SELECT id::text AS source_item_id, sort_order, item_name, reference_no, quantity, unit,
            expected_cost, expected_cost_is_unit, description, remark, asset_id, asset_name
       FROM fdw_reqflow.requisition_items
      WHERE requisition_id=$1 ORDER BY sort_order, id`, [sourceRequisition.id]);
  const requisitionSnapshot = {
    ...sourceRequisition,
    id: String(sourceRequisition.id),
    project_id: sourceRequisition.project_id == null ? null : String(sourceRequisition.project_id),
    site_id: sourceRequisition.site_id == null ? null : String(sourceRequisition.site_id),
    items: sourceItems.map((item, index) => ({
      ...item, id: item.source_item_id, line_no: index + 1,
    })),
  };

  let note;
  try {
    note = await tx(async () => {
      if (requestedNoteNo) await ensureNoteNumberAvailable(requestedNoteNo);
      const created = await one(
        `INSERT INTO approval_notes
           (subject, item_description, project_id, requisition_id, requisition_source, requisition_source_id,
            source_requisition_snapshot,
            prepared_by, prepared_by_name, prepared_by_desig, note_date, mode_of_payment, payment_terms,
            transport_charges, delivery_terms, place_of_supply, supply_state_code, status_label)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,COALESCE($11, CURRENT_DATE),$12,$13,$14,$15,$16,$17,$18)
         RETURNING *`,
        [b.subject.trim(), b.item_description || null, null, null,
          'reqflow', requisitionSourceId, requisitionSnapshot, req.user.id, req.user.full_name,
          req.user.designation || null, b.note_date || null,
          b.mode_of_payment || 'NEFT/RTGS', b.payment_terms || null, b.transport_charges || null,
          b.delivery_terms || null, b.place_of_supply || null, b.supply_state_code || null,
          b.status_label || 'Live'],
      );
      for (const [index, item] of sourceItems.entries()) await query(
        `INSERT INTO note_items (note_id, source_requisition_item_id, line_no, description,
                                 specification, quantity, unit, rate)
         VALUES ($1,$2,$3,$4,$5,$6,$7,0)`,
        [created.id, item.source_item_id, index + 1, item.item_name, item.reference_no,
          item.quantity, item.unit || 'Nos'],
      );
      await allocateNoteNumber(created.id, created.note_date ? new Date(created.note_date) : new Date(), requestedNoteNo);
      return created;
    });
  } catch (error) {
    if (error.code === '23505' && error.constraint === 'approval_notes_note_no_key') {
      throw httpError(409, requestedNoteNo
        ? `The approval note number “${requestedNoteNo}” is already in use.`
        : 'The generated approval note number is already in use. Please try again.');
    }
    throw error;
  }

  await audit(req, { noteId: note.id, action: 'note_created', entity: 'note', entityId: note.id });
  res.status(201).json({ note: await loadNote(note.id) });
}));

router.patch('/:id', wrap(async (req, res) => {
  const id = Number(req.params.id);
  const existing = await requireNote(id);
  assertEditable(existing, req.user);

  const b = req.body || {};
  const fields = [];
  const values = [];
  const set = (column, value) => { values.push(value); fields.push(`${column} = $${values.length}`); };

  const allowed = ['subject', 'item_description', 'project_id', 'requisition_id', 'note_date',
    'mode_of_payment', 'payment_terms', 'transport_charges', 'delivery_terms',
    'place_of_supply', 'supply_state_code', 'status_label', 'selection_reason'];

  for (const key of allowed) {
    if (b[key] !== undefined) set(key, b[key] === '' ? null : b[key]);
  }

  if (b.note_no !== undefined) {
    const noteNo = normalizeNoteNumber(b.note_no);
    await ensureNoteNumberAvailable(noteNo, id);
    set('note_no', noteNo);
  }

  if (!fields.length) throw httpError(400, 'There is nothing to change.');

  values.push(id);
  try {
    await query(`UPDATE approval_notes SET ${fields.join(', ')}, updated_at = now() WHERE id = $${values.length}`, values);
  } catch (error) {
    if (error.code === '23505' && error.constraint === 'approval_notes_note_no_key') {
      throw httpError(409, 'That approval note number is already in use.');
    }
    throw error;
  }

  await audit(req, { noteId: id, action: 'note_updated', entity: 'note', entityId: id, detail: b });
  res.json({ note: await loadNote(id) });
}));

router.delete('/:id', wrap(async (req, res) => {
  const id = Number(req.params.id);
  const note = await requireNote(id);
  if (note.status !== 'draft' && req.user.role !== 'admin') {
    throw httpError(409, 'Only a draft can be deleted.');
  }
  if (req.user.role !== 'admin' && note.prepared_by !== req.user.id) {
    throw httpError(403, 'Only the person who prepared this note can delete it.');
  }
  const storedFiles = (note.files || []).map((file) => file.stored_name).filter(Boolean);
  await query('DELETE FROM approval_notes WHERE id = $1', [id]);
  await Promise.all(storedFiles.map(async (storedName) => {
    try { await fs.unlink(storedPath(storedName)); }
    catch (error) {
      if (error.code !== 'ENOENT') console.error('[files] Could not remove an attachment after note deletion:', error.message);
    }
  }));
  await audit(req, { action: 'note_deleted', entity: 'note', entityId: id, detail: { note_no: note.note_no } });
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Priced schedule
// ---------------------------------------------------------------------------

router.put('/:id/items', wrap(async (req, res) => {
  const id = Number(req.params.id);
  const note = await requireNote(id);
  assertEditable(note, req.user);

  const items = Array.isArray(req.body?.items) ? req.body.items : [];

  // Accounts' tax sign-off is preserved on any line that has not changed in a
  // way that affects tax, so editing a description does not silently discard
  // a verification.
  const existingById = new Map(note.items.map((i) => [i.id, i]));

  await tx(async () => {
    await query('DELETE FROM note_items WHERE note_id = $1', [id]);

    for (const [index, item] of items.entries()) {
      if (!item.description?.trim()) continue;

      const previous = item.id ? existingById.get(Number(item.id)) : null;
      const unchangedForTax = previous
        && String(previous.description) === String(item.description)
        && num(previous.gst_rate) === num(item.gst_rate, 18)
        && previous.supply_type === (item.supply_type || 'goods')
        && num(previous.quantity) === num(item.quantity, 1)
        && num(previous.rate) === num(item.rate, 0);

      const quantity = num(item.quantity, 1);
      const rate = num(item.rate, 0);
      const amount = item.amount !== undefined && item.amount !== null && item.amount !== ''
        ? round2(item.amount)
        : round2(quantity * rate);

      await query(
        `INSERT INTO note_items
           (note_id, source_requisition_item_id, line_no, description, specification, hsn_sac, quantity, unit, rate, amount,
            discount_amount, supply_type, gst_rate, tax_verified, verified_gst_rate, tax_remark,
            verified_by, verified_at, tds_section_override, source_quotation_item_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
        [id, item.source_requisition_item_id || previous?.source_requisition_item_id || null,
          item.line_no ?? index + 1, item.description.trim(), item.specification || null,
          item.hsn_sac || null, quantity, item.unit || 'Nos', rate, amount,
          num(item.discount_amount, 0), item.supply_type || 'goods', num(item.gst_rate, 18),
          unchangedForTax ? previous.tax_verified : false,
          unchangedForTax ? previous.verified_gst_rate : null,
          unchangedForTax ? previous.tax_remark : null,
          unchangedForTax ? previous.verified_by : null,
          unchangedForTax ? previous.verified_at : null,
          item.tds_section_override || null,
          item.source_quotation_item_id || null],
      );
    }

    // Any line that lost its sign-off invalidates the "all verified" flag.
    await query(
      `UPDATE accounts_review SET all_items_tax_verified = FALSE, updated_at = now()
        WHERE note_id = $1
          AND EXISTS (SELECT 1 FROM note_items ni WHERE ni.note_id = $1 AND NOT ni.tax_verified)`,
      [id],
    );
  });

  await audit(req, { noteId: id, action: 'items_updated', entity: 'note', entityId: id, detail: { count: items.length } });
  res.json({ note: await loadNote(id) });
}));

/** Copies a vendor's quoted lines into the note's priced schedule. */
router.post('/:id/items/from-quotation', wrap(async (req, res) => {
  const id = Number(req.params.id);
  const note = await requireNote(id);
  assertEditable(note, req.user);

  const quotationId = Number(req.body?.quotation_id || note.selected_quotation_id);
  if (!quotationId) throw httpError(400, 'Choose which quotation to copy the lines from.');

  const quotation = note.quotations.find((q) => q.id === quotationId);
  if (!quotation) throw httpError(404, 'That quotation does not belong to this note.');

  if (quotation.extraction_status === 'extracted') {
    throw httpError(409, 'The figures on that quotation have not been confirmed yet. Review it first, then copy the lines.');
  }

  const source = quotation.items.filter((i) => !i.not_quoted && (req.body?.include_optional ? true : !i.is_optional));
  if (!source.length) throw httpError(400, 'That quotation has no lines to copy.');

  const defaultGst = quotation.gst_rate ?? 18;

  await tx(async () => {
    if (req.body?.replace !== false) {
      await query('DELETE FROM note_items WHERE note_id = $1', [id]);
    }
    const offset = req.body?.replace === false ? note.items.length : 0;

    for (const [index, item] of source.entries()) {
      const quantity = num(item.quantity, 1);
      const rate = num(item.rate, 0);
      const amount = item.amount !== null && item.amount !== undefined
        ? round2(item.amount)
        : round2(quantity * rate);

      await query(
        `INSERT INTO note_items
           (note_id, line_no, description, specification, hsn_sac, quantity, unit, rate, amount,
            supply_type, gst_rate, source_quotation_item_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [id, offset + index + 1, item.description, item.specification || null, item.hsn_sac || null,
          quantity, item.unit || 'Nos', rate, amount,
          req.body?.supply_type || 'goods', item.gst_rate ?? defaultGst, item.id],
      );
    }
  });

  await audit(req, { noteId: id, action: 'items_from_quotation', entity: 'quotation', entityId: quotationId });
  res.json({ note: await loadNote(id) });
}));

// ---------------------------------------------------------------------------
// Vendor selection — printed on the front page
// ---------------------------------------------------------------------------

router.post('/:id/select-vendor', wrap(async (req, res) => {
  const id = Number(req.params.id);
  const note = await requireNote(id);
  assertEditable(note, req.user);

  const quotationId = Number(req.body?.quotation_id);
  const reason = String(req.body?.reason || '').trim();

  if (!quotationId) throw httpError(400, 'Choose a vendor.');
  if (!reason) throw httpError(400, 'Write the reason for selecting this vendor. It is printed on the front page.');

  const quotation = note.quotations.find((q) => q.id === quotationId);
  if (!quotation) throw httpError(404, 'That quotation does not belong to this note.');
  if (quotation.is_excluded) throw httpError(400, 'That quotation has been excluded from the comparison.');
  const comparisonRow = note.comparison.rows.find((row) => row.quotation_id === quotationId);
  if (!comparisonRow?.cost.hasComparableValue) {
    throw httpError(400, 'Add a quoted total or at least one priced line before selecting this vendor.');
  }
  if (comparisonRow.mandatory_failures > 0) {
    throw httpError(400, 'This vendor fails or has not demonstrated a mandatory criterion. Update the assessment before selecting it.');
  }

  const vendorSync = quotation.vendor_source_id
    ? { status: 'already_linked' }
    : await addSelectedVendorToSiteErp(quotation);

  await query(
    `UPDATE approval_notes
        SET selected_quotation_id = $1, selection_reason = $2, selected_by = $3,
            selected_at = now(), updated_at = now()
      WHERE id = $4`,
    [quotationId, reason, req.user.id, id],
  );

  await audit(req, {
    noteId: id, action: 'vendor_selected', entity: 'quotation', entityId: quotationId,
    detail: { vendor: quotation.vendor_name, reason },
  });

  res.json({ note: await loadNote(id), vendor_sync: vendorSync });
}));

// ---------------------------------------------------------------------------
// Comparison criteria — the non-price axes
// ---------------------------------------------------------------------------

router.get('/:id/criteria/categories', (req, res) => {
  res.json({ categories: CRITERION_CATEGORIES });
});

router.put('/:id/criteria', wrap(async (req, res) => {
  const id = Number(req.params.id);
  const note = await requireNote(id);
  assertEditable(note, req.user);

  const criteria = Array.isArray(req.body?.criteria) ? req.body.criteria : [];
  const validIds = new Set(note.quotations.map((q) => q.id));

  await tx(async () => {
    await query('DELETE FROM comparison_criteria WHERE note_id = $1', [id]);

    for (const [index, criterion] of criteria.entries()) {
      if (!criterion.label?.trim()) continue;

      const created = await one(
        `INSERT INTO comparison_criteria (note_id, line_no, category, label, requirement, weight, is_mandatory)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [id, criterion.line_no ?? index + 1, criterion.category || 'technical',
          criterion.label.trim(), criterion.requirement || null,
          Math.max(0, num(criterion.weight, 1)), Boolean(criterion.is_mandatory)],
      );

      const values = criterion.values || {};
      for (const [quotationId, value] of Object.entries(values)) {
        const qid = Number(quotationId);
        if (!validIds.has(qid)) continue;
        if (!value) continue;

        const score = value.score === null || value.score === undefined || value.score === ''
          ? null
          : Math.max(0, Math.min(10, num(value.score)));

        await query(
          `INSERT INTO comparison_values (criterion_id, quotation_id, value_text, score, complies, remarks)
           VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (criterion_id, quotation_id) DO UPDATE
             SET value_text = EXCLUDED.value_text, score = EXCLUDED.score,
                 complies = EXCLUDED.complies, remarks = EXCLUDED.remarks`,
          [created.id, qid, value.value_text || null, score,
            value.complies === undefined || value.complies === null ? null : Boolean(value.complies),
            value.remarks || null],
        );
      }
    }
  });

  await audit(req, { noteId: id, action: 'criteria_updated', entity: 'note', entityId: id });
  res.json({ note: await loadNote(id) });
}));

// ---------------------------------------------------------------------------
// Payment schedule — Annexure C
// ---------------------------------------------------------------------------

router.put('/:id/milestones', wrap(async (req, res) => {
  const id = Number(req.params.id);
  const note = await requireNote(id);
  assertEditable(note, req.user);

  const milestones = Array.isArray(req.body?.milestones) ? req.body.milestones : [];

  await tx(async () => {
    await query('DELETE FROM payment_milestones WHERE note_id = $1', [id]);
    for (const [index, m] of milestones.entries()) {
      if (!m.milestone?.trim()) continue;
      await query(
        `INSERT INTO payment_milestones
           (note_id, line_no, milestone, trigger_event, due_offset_days, due_date,
            percent, basis, fixed_amount, is_retention, remarks)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [id, m.line_no ?? index + 1, m.milestone.trim(), m.trigger_event || null,
          m.due_offset_days ?? null, m.due_date || null,
          m.percent === '' || m.percent === undefined ? null : num(m.percent),
          m.basis || 'grand_total',
          m.fixed_amount === '' || m.fixed_amount === undefined ? null : num(m.fixed_amount),
          Boolean(m.is_retention), m.remarks || null],
      );
    }
  });

  await audit(req, { noteId: id, action: 'milestones_updated', entity: 'note', entityId: id });
  res.json({ note: await loadNote(id) });
}));

// ---------------------------------------------------------------------------
// Workflow
// ---------------------------------------------------------------------------

router.post('/:id/submit', wrap(async (req, res) => {
  const id = Number(req.params.id);
  const note = await requireNote(id);

  if (!['draft', 'on_hold', 'rejected'].includes(note.status)) {
    throw httpError(409, 'This note has already been submitted.');
  }
  if (req.user.role !== 'admin' && note.prepared_by !== req.user.id) {
    throw httpError(403, 'Only the person who prepared this note can submit it.');
  }

  if (!note.readiness.canSubmit) {
    throw httpError(422, 'This note is not ready to submit.', { blocking: note.readiness.blocking });
  }

  const assignments = req.body?.assignments ?? {};
  if (!assignments || typeof assignments !== 'object' || Array.isArray(assignments)) {
    throw httpError(400, 'Reviewer assignments must be provided as a stage-by-stage selection.');
  }
  const stageTypes = new Set(STAGE_ORDER.map((stage) => stage.type));
  if (Object.keys(assignments).some((type) => !stageTypes.has(type))) {
    throw httpError(400, 'One or more reviewer stages are not valid. Refresh the page and try again.');
  }

  const assignedUsers = new Map();
  for (const stage of STAGE_ORDER) {
    const assigned = assignments[stage.type];
    const requested = assigned == null || assigned === '' ? [] : (Array.isArray(assigned) ? assigned : [assigned]);
    if (requested.length > 20) throw httpError(400, `Choose no more than 20 reviewers for the ${stage.label.toLowerCase()} stage.`);
    const ids = [...new Set(requested.map(Number))];
    if (ids.some((userId) => !Number.isSafeInteger(userId) || userId < 1)) {
      throw httpError(400, `Choose valid reviewers for the ${stage.label.toLowerCase()} stage.`);
    }
    const users = ids.length
      ? await many('SELECT id, full_name, role FROM users WHERE id = ANY($1::int[]) AND is_active', [ids])
      : [];
    if (users.length !== ids.length) {
      throw httpError(400, `A selected reviewer for the ${stage.label.toLowerCase()} stage is no longer active. Refresh the page and try again.`);
    }
    if (users.some((user) => user.role !== stage.role && user.role !== 'admin')) {
      throw httpError(400, `Reviewers at the ${stage.label.toLowerCase()} stage must have the ${stage.role} role.`);
    }
    assignedUsers.set(stage.type, users);
  }

  await tx(async () => {
    await query('DELETE FROM workflow_steps WHERE note_id = $1', [id]);

    let order = 1;
    for (const stage of STAGE_ORDER) {
      const list = assignedUsers.get(stage.type) || [];

      if (list.length) {
        for (const user of list) {
          await query(
            `INSERT INTO workflow_steps (note_id, step_order, step_type, assignee_id, assignee_name, decision)
             VALUES ($1,$2,$3,$4,$5,'pending')`,
            [id, order, stage.type, user.id, user.full_name],
          );
        }
      } else {
        // Unassigned stages stay open to anyone holding the role.
        await query(
          `INSERT INTO workflow_steps (note_id, step_order, step_type, decision)
           VALUES ($1,$2,$3,'pending')`,
          [id, order, stage.type],
        );
      }
      order += 1;
    }

    await query(
      `UPDATE approval_notes
          SET status = 'pending_check', current_stage = 'check',
              submitted_at = now(), updated_at = now()
        WHERE id = $1`,
      [id],
    );
  });

  await audit(req, { noteId: id, action: 'note_submitted', entity: 'note', entityId: id });
  res.json({ note: await loadNote(id) });
}));

router.post('/:id/decision', wrap(async (req, res) => {
  const id = Number(req.params.id);
  const note = await requireNote(id);

  const decision = String(req.body?.decision || '').toLowerCase();
  const comments = req.body?.comments ? String(req.body.comments).trim() : null;

  if (!['approved', 'rejected', 'on_hold'].includes(decision)) {
    throw httpError(400, 'The decision must be approved, rejected or on_hold.');
  }
  if (decision !== 'approved' && !comments) {
    throw httpError(400, 'Write a comment explaining the decision.');
  }

  const stage = STAGE_ORDER.find((s) => s.status === note.status);
  if (!stage) throw httpError(409, 'This note is not waiting on a decision.');

  if (req.user.role !== 'admin' && req.user.role !== stage.role) {
    throw httpError(403, `This note is at the ${stage.label.toLowerCase()} stage and needs a ${stage.role} to act on it.`);
  }

  // The accounts stage has its own gate.
  if (stage.type === 'accounts' && decision === 'approved') {
    const accountsReadiness = assessAccountsReadiness(note);
    if (!accountsReadiness.canApprove) {
      throw httpError(422, 'The accounts checks are not complete.', { blocking: accountsReadiness.blocking });
    }
  }

  const pending = note.steps.filter((s) => s.step_type === stage.type && s.decision === 'pending');
  const mine = pending.find((s) => s.assignee_id === req.user.id)
    || pending.find((s) => s.assignee_id === null);

  if (!mine) {
    throw httpError(403, 'There is no decision pending for you at this stage.');
  }

  await tx(async () => {
    const updatedStep = await query(
      `UPDATE workflow_steps
          SET decision = $1, comments = $2, decided_at = now(),
              assignee_id = COALESCE(assignee_id, $3),
              assignee_name = COALESCE(assignee_name, $4)
        WHERE id = $5 AND decision = 'pending' RETURNING id`,
      [decision, comments, req.user.id, req.user.full_name, mine.id],
    );
    if (!updatedStep.rowCount) throw httpError(409, 'Someone has already acted on this step. Refresh the note to see its current status.');

    if (decision === 'rejected') {
      await query(
        `UPDATE approval_notes SET status = 'rejected', current_stage = NULL, updated_at = now() WHERE id = $1`,
        [id],
      );
      return;
    }
    if (decision === 'on_hold') {
      await query(
        `UPDATE approval_notes SET status = 'on_hold', updated_at = now() WHERE id = $1`,
        [id],
      );
      return;
    }

    // Approved: move on only when every pending step at this stage is done.
    const stillPending = await one(
      `SELECT COUNT(*)::int AS count FROM workflow_steps
        WHERE note_id = $1 AND step_type = $2 AND decision = 'pending'`,
      [id, stage.type],
    );

    if (stillPending.count > 0) return;

    const index = STAGE_ORDER.findIndex((s) => s.type === stage.type);
    const next = STAGE_ORDER[index + 1];

    if (next) {
      await query(
        `UPDATE approval_notes SET status = $1, current_stage = $2, updated_at = now() WHERE id = $3`,
        [next.status, next.type, id],
      );
    } else {
      await query(
        `UPDATE approval_notes
            SET status = 'approved', current_stage = NULL, closed_at = now(), updated_at = now()
          WHERE id = $1`,
        [id],
      );
      await query(
        `UPDATE requisitions SET status = 'closed'
          WHERE id = (SELECT requisition_id FROM approval_notes WHERE id = $1)`,
        [id],
      );
    }
  });

  await audit(req, {
    noteId: id, action: `decision_${decision}`, entity: 'workflow_step', entityId: mine.id,
    detail: { stage: stage.type, comments },
  });

  res.json({ note: await loadNote(id) });
}));

/** Puts a held or rejected note back into the flow at the stage it stopped. */
router.post('/:id/resume', wrap(async (req, res) => {
  const id = Number(req.params.id);
  const note = await requireNote(id);

  if (!['on_hold', 'rejected'].includes(note.status)) {
    throw httpError(409, 'Only a held or rejected note can be resumed.');
  }
  if (req.user.role !== 'admin' && note.prepared_by !== req.user.id) {
    throw httpError(403, 'Only the person who prepared this note can resume it.');
  }

  const freshReadiness = note.readiness;
  if (!freshReadiness.canSubmit) {
    throw httpError(422, 'This note is still not ready.', { blocking: freshReadiness.blocking });
  }

  // Reopen the earliest stage that has not been fully approved.
  const firstOpen = STAGE_ORDER.find((stage) => note.steps
    .filter((s) => s.step_type === stage.type)
    .some((s) => s.decision !== 'approved')) || STAGE_ORDER[0];

  await tx(async () => {
    await query(
      `UPDATE workflow_steps SET decision = 'pending', decided_at = NULL
        WHERE note_id = $1 AND step_type = $2 AND decision <> 'approved'`,
      [id, firstOpen.type],
    );
    await query(
      `UPDATE approval_notes SET status = $1, current_stage = $2, updated_at = now() WHERE id = $3`,
      [firstOpen.status, firstOpen.type, id],
    );
  });

  await audit(req, { noteId: id, action: 'note_resumed', entity: 'note', entityId: id });
  res.json({ note: await loadNote(id) });
}));

router.get('/:id/audit', wrap(async (req, res) => {
  const rows = await many(
    'SELECT * FROM audit_log WHERE note_id = $1 ORDER BY created_at DESC LIMIT 200',
    [Number(req.params.id)],
  );
  res.json({ entries: rows });
}));

export { STAGE_ORDER, stageFor };
export default router;
