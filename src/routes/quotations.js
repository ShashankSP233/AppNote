import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { one, many, query, tx } from '../db.js';
import { wrap, httpError, requireAuth, requireRole, audit, upload, storedPath } from '../middleware.js';
import { loadNote } from '../notes-repo.js';
import { extractFromFiles } from '../extract/index.js';
import { num, round2, panFromGstin, stateCodeFromGstin, isValidGstin } from '../domain.js';

const router = express.Router();

router.use(requireAuth);

async function requireNote(id) {
  const note = await loadNote(Number(id));
  if (!note) throw httpError(404, 'There is no note with that id.');
  return note;
}

function assertEditable(note, user) {
  if (!['draft', 'on_hold', 'rejected'].includes(note.status)) {
    throw httpError(409, 'This note has been submitted and its quotations can no longer be changed.');
  }
  if (user.role !== 'admin' && note.prepared_by && note.prepared_by !== user.id) {
    throw httpError(403, 'Only the person who prepared this note can change its quotations.');
  }
}

/** Resolve a quotation vendor against SiteERP without creating a local master. */
async function resolveSiteErpVendor({ sourceId, name, gstin }) {
  if (sourceId) {
    return one('SELECT * FROM fdw_siteerp.vendors WHERE id::text=$1 AND is_active', [String(sourceId)]);
  }
  if (gstin && name) {
    return one(
      `SELECT * FROM fdw_siteerp.vendors
        WHERE is_active
          AND upper(regexp_replace(COALESCE(gst_no, tax_identifier, ''), '\\s', '', 'g'))=$1
          AND lower(btrim(name))=lower($2)
        ORDER BY id LIMIT 1`, [gstin, name.trim()]);
  }
  if (gstin) {
    const byGstin = await one(
      `SELECT * FROM fdw_siteerp.vendors
        WHERE is_active AND upper(regexp_replace(COALESCE(gst_no, tax_identifier, ''), '\\s', '', 'g'))=$1
        ORDER BY id LIMIT 1`, [gstin]);
    if (byGstin) return byGstin;
  }
  if (name) {
    return one('SELECT * FROM fdw_siteerp.vendors WHERE lower(btrim(name))=lower($1) AND is_active ORDER BY id LIMIT 1',
      [name.trim()]);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Upload a quotation, with extraction
// ---------------------------------------------------------------------------

router.post('/notes/:id/quotations', upload.array('files', 12), wrap(async (req, res) => {
  const noteId = Number(req.params.id);
  const note = await requireNote(noteId);
  assertEditable(note, req.user);

  const body = req.body || {};
  const uploaded = req.files || [];

  let extraction = null;

  if (uploaded.length && body.extract !== 'false') {
    const buffers = await Promise.all(uploaded.map(async (file) => ({
      buffer: await fs.readFile(file.path),
      originalName: file.originalname,
      mimeType: file.mimetype,
    })));

    try {
      extraction = await extractFromFiles(buffers);
    } catch (error) {
      extraction = {
        ok: false, source: 'manual', method: 'manual', confidence: 0,
        fields: {}, items: [],
        warnings: [`Reading the attachment failed: ${error.message}. Enter the figures by hand.`],
        needsManualEntry: true,
      };
    }
  }

  const fields = extraction?.fields || {};

  // Anything typed by the person wins over anything read from the page.
  const requestedVendorName = body.vendor_name?.trim() || fields.vendor_name || null;
  const requestedGstin = (body.vendor_gstin || fields.vendor_gstin || '').toUpperCase().replace(/\s/g, '') || null;
  let vendor = null;
  if (body.vendor_source_id) {
    vendor = await resolveSiteErpVendor({ sourceId: body.vendor_source_id });
    if (!vendor) throw httpError(400, 'That SiteERP vendor is no longer available. You can still enter the vendor name manually.');
  } else if (body.vendor_name?.trim()) {
    vendor = await resolveSiteErpVendor({
      name: body.vendor_name.trim(),
      gstin: body.vendor_gstin?.trim() ? body.vendor_gstin.toUpperCase().replace(/\s/g, '') : null,
    });
  } else if (body.vendor_gstin?.trim()) {
    vendor = await resolveSiteErpVendor({ gstin: body.vendor_gstin.toUpperCase().replace(/\s/g, '') });
  } else if (fields.vendor_gstin) {
    // GSTIN is the stronger identity signal when the person leaves the vendor
    // selector blank; fall back to the PDF's name if SiteERP has no GSTIN match.
    vendor = await resolveSiteErpVendor({ gstin: String(fields.vendor_gstin).toUpperCase().replace(/\s/g, '') });
    if (!vendor && fields.vendor_name) vendor = await resolveSiteErpVendor({ name: fields.vendor_name.trim() });
  } else if (fields.vendor_name) {
    vendor = await resolveSiteErpVendor({ name: fields.vendor_name.trim() });
  }
  const vendorName = vendor?.name || requestedVendorName?.trim() || 'Vendor to be identified';
  const vendorSourceId = vendor ? String(vendor.id) : null;
  const vendorGstin = String(vendor?.gst_no || vendor?.tax_identifier || requestedGstin || '').toUpperCase().replace(/\s/g, '') || null;
  const vendorPan = String(vendor?.pan_no || body.vendor_pan || fields.vendor_pan || '').toUpperCase().replace(/\s/g, '')
    || (vendorGstin ? panFromGstin(vendorGstin) : null);

  const position = note.quotations.length + 1;

  const pick = (key, fallback = null) => {
    if (body[key] !== undefined && body[key] !== '') return body[key];
    if (fields[key] !== undefined && fields[key] !== null) return fields[key];
    return fallback;
  };

  const quotation = await tx(async () => {
    const created = await one(
      `INSERT INTO quotations
         (note_id, vendor_id, vendor_source_id, vendor_name, vendor_gstin, vendor_pan, vendor_city, position,
          quotation_ref, quotation_date, validity_days, delivery_days, delivery_text, delivery_basis,
          advance_percent, credit_days, retention_percent, retention_release_days, payment_terms_text,
          discount_amount, freight_amount, other_charges, gst_rate, quoted_basic, quoted_total,
          warranty_text, remarks, source, extraction_status, extraction_confidence,
          extraction_method, extraction_notes, extraction_raw)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,
               $25,$26,$27,$28,$29,$30,$31,$32,$33)
       RETURNING *`,
      [noteId, null, vendorSourceId, vendorName, vendorGstin, vendorPan, body.vendor_city || fields.vendor_city || null, position,
        pick('quotation_ref'), pick('quotation_date'),
        pick('validity_days') === null ? null : num(pick('validity_days')),
        pick('delivery_days') === null ? null : num(pick('delivery_days')),
        pick('delivery_text'), pick('delivery_basis'),
        pick('advance_percent') === null ? null : num(pick('advance_percent')),
        pick('credit_days') === null ? null : num(pick('credit_days')),
        pick('retention_percent') === null ? null : num(pick('retention_percent')),
        pick('retention_release_days') === null ? null : Math.max(0, num(pick('retention_release_days'))),
        pick('payment_terms_text'),
        num(pick('discount_amount', 0), 0), num(pick('freight_amount', 0), 0),
        num(pick('other_charges', 0), 0),
        pick('gst_rate') === null ? null : num(pick('gst_rate')),
        pick('quoted_basic') === null ? null : num(pick('quoted_basic')),
        pick('quoted_total') === null ? null : num(pick('quoted_total')),
        pick('warranty_text'), pick('remarks'),
        extraction?.source || 'manual',
        extraction?.ok ? 'extracted' : 'none',
        extraction?.confidence ?? null,
        extraction?.method || null,
        extraction?.warnings?.length ? extraction.warnings.join('\n') : null,
        extraction ? JSON.stringify({ fields: extraction.fields, items: extraction.items, warnings: extraction.warnings }) : null],
    );

    for (const [index, item] of (extraction?.items || []).entries()) {
      const quantity = num(item.quantity, 1);
      const rate = num(item.rate, 0);
      const amount = item.amount !== null && item.amount !== undefined
        ? round2(item.amount) : round2(quantity * rate);

      await query(
        `INSERT INTO quotation_items
           (quotation_id, line_no, line_key, description, quantity, unit, rate, amount, needs_review)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [created.id, item.line_no ?? index + 1, null, item.description,
          quantity, item.unit || 'Nos', rate, amount, Boolean(item.needs_review)],
      );
    }

    for (const file of uploaded) {
      await query(
        `INSERT INTO quotation_files
           (quotation_id, note_id, kind, original_name, stored_name, mime_type, size_bytes, uploaded_by)
         VALUES ($1,$2,'quotation',$3,$4,$5,$6,$7)`,
        [created.id, noteId, file.originalname, path.basename(file.path),
          file.mimetype, file.size, req.user.id],
      );
    }

    return created;
  });

  await audit(req, {
    noteId, action: 'quotation_added', entity: 'quotation', entityId: quotation.id,
    detail: { vendor: vendorName, source: extraction?.source, confidence: extraction?.confidence },
  });

  res.status(201).json({
    note: await loadNote(noteId),
    quotation_id: quotation.id,
    extraction: extraction
      ? {
        method: extraction.method,
        confidence: extraction.confidence,
        warnings: extraction.warnings,
        needsManualEntry: extraction.needsManualEntry,
        itemCount: extraction.items?.length || 0,
      }
      : null,
  });
}));

/**
 * A revised offer from the same vendor.
 *
 * The earlier version is kept and marked superseded rather than overwritten:
 * only the newest version is compared, but the chain is printed in the
 * annexure, which is what shows the approver that the price was negotiated.
 *
 * Where the revision carries no readable lines — a price change agreed over
 * the phone, say — the previous version's lines are copied across as a
 * starting point and flagged for checking, so nothing has to be retyped.
 */
router.post('/quotations/:id/revise', upload.array('files', 12), wrap(async (req, res) => {
  const previousId = Number(req.params.id);
  const previous = await one('SELECT * FROM quotations WHERE id = $1', [previousId]);
  if (!previous) throw httpError(404, 'There is no quotation with that id.');

  const note = await requireNote(previous.note_id);
  assertEditable(note, req.user);

  if (previous.is_superseded) {
    throw httpError(409, 'That version has already been replaced. Revise the current version instead.');
  }

  const body = req.body || {};
  const uploaded = req.files || [];
  let extraction = null;

  if (uploaded.length && body.extract !== 'false') {
    const buffers = await Promise.all(uploaded.map(async (file) => ({
      buffer: await fs.readFile(file.path),
      originalName: file.originalname,
      mimeType: file.mimetype,
    })));
    try {
      extraction = await extractFromFiles(buffers);
    } catch (error) {
      extraction = {
        ok: false, source: 'manual', method: 'manual', confidence: 0,
        fields: {}, items: [],
        warnings: [`Reading the attachment failed: ${error.message}. Enter the figures by hand.`],
        needsManualEntry: true,
      };
    }
  }

  const fields = extraction?.fields || {};
  const pick = (key, fallback = null) => {
    if (body[key] !== undefined && body[key] !== '') return body[key];
    if (fields[key] !== undefined && fields[key] !== null) return fields[key];
    return fallback;
  };

  const previousItems = await many(
    'SELECT * FROM quotation_items WHERE quotation_id = $1 ORDER BY line_no, id',
    [previousId],
  );

  // Lines copied from the previous version are last version's prices sitting
  // in a new version. That is exactly the situation the review gate exists
  // for, so the revision counts as unconfirmed until someone has been through
  // it — otherwise a note could go up claiming a requote at an unchanged price.
  const carriedOver = !extraction?.items?.length && previousItems.length > 0;
  const extractionStatus = (extraction || carriedOver) ? 'extracted' : 'none';

  const revision = await tx(async () => {
    // The vendor's identity carries over; only the commercial terms move.
    const created = await one(
      `INSERT INTO quotations
         (note_id, vendor_id, vendor_source_id, vendor_name, vendor_gstin, vendor_pan, vendor_city, position,
          quotation_ref, quotation_date, validity_days, delivery_days, delivery_text, delivery_basis,
          advance_percent, credit_days, retention_percent, retention_release_days, payment_terms_text,
          discount_amount, freight_amount, other_charges, gst_rate, quoted_basic, quoted_total,
          warranty_text, remarks, source, extraction_status, extraction_confidence,
          extraction_method, extraction_notes, extraction_raw,
          version_no, supersedes_id, revision_note, received_on)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,
               $25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37)
       RETURNING *`,
      [previous.note_id, previous.vendor_id, previous.vendor_source_id,
        body.vendor_name?.trim() || previous.vendor_name,
        previous.vendor_gstin, previous.vendor_pan, previous.vendor_city, previous.position,
        pick('quotation_ref', previous.quotation_ref),
        pick('quotation_date'),
        pick('validity_days') === null ? previous.validity_days : num(pick('validity_days')),
        pick('delivery_days') === null ? previous.delivery_days : num(pick('delivery_days')),
        pick('delivery_text', previous.delivery_text),
        pick('delivery_basis', previous.delivery_basis),
        pick('advance_percent') === null ? previous.advance_percent : num(pick('advance_percent')),
        pick('credit_days') === null ? previous.credit_days : num(pick('credit_days')),
        pick('retention_percent') === null ? previous.retention_percent : num(pick('retention_percent')),
        pick('retention_release_days') === null ? previous.retention_release_days : Math.max(0, num(pick('retention_release_days'))),
        pick('payment_terms_text', previous.payment_terms_text),
        body.discount_amount !== undefined ? num(body.discount_amount, 0) : previous.discount_amount,
        body.freight_amount !== undefined ? num(body.freight_amount, 0) : previous.freight_amount,
        body.other_charges !== undefined ? num(body.other_charges, 0) : previous.other_charges,
        pick('gst_rate') === null ? previous.gst_rate : num(pick('gst_rate')),
        pick('quoted_basic') === null ? null : num(pick('quoted_basic')),
        pick('quoted_total') === null ? null : num(pick('quoted_total')),
        pick('warranty_text', previous.warranty_text),
        body.remarks || null,
        extraction?.source || 'manual',
        extractionStatus,
        extraction?.confidence ?? null,
        extraction?.method || null,
        extraction?.warnings?.length
          ? extraction.warnings.join('\n')
          : (carriedOver ? 'The lines were copied from the previous version. Check every price against the revised offer before confirming.' : null),
        extraction ? JSON.stringify({ fields: extraction.fields, items: extraction.items, warnings: extraction.warnings }) : null,
        (previous.version_no || 1) + 1, previousId,
        body.revision_note?.trim() || null,
        body.received_on || null],
    );

    const sourceItems = (extraction?.items?.length ? extraction.items : previousItems);

    for (const [index, item] of sourceItems.entries()) {
      const quantity = num(item.quantity, 1);
      const rate = num(item.rate, 0);
      const amount = item.amount !== null && item.amount !== undefined
        ? round2(item.amount) : round2(quantity * rate);

      await query(
        `INSERT INTO quotation_items
           (quotation_id, line_no, line_key, description, specification, part_no, hsn_sac,
            quantity, unit, rate, amount, gst_rate, is_optional, not_quoted, needs_review)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [created.id, item.line_no ?? index + 1, item.line_key || null, item.description,
          item.specification || null, item.part_no || null, item.hsn_sac || null,
          quantity, item.unit || 'Nos', rate, amount, item.gst_rate ?? null,
          Boolean(item.is_optional), Boolean(item.not_quoted),
          // Lines carried over from the previous version are last version's
          // prices until someone says otherwise.
          carriedOver ? true : Boolean(item.needs_review)],
      );
    }

    for (const file of uploaded) {
      await query(
        `INSERT INTO quotation_files
           (quotation_id, note_id, kind, original_name, stored_name, mime_type, size_bytes, uploaded_by)
         VALUES ($1,$2,'quotation',$3,$4,$5,$6,$7)`,
        [created.id, previous.note_id, file.originalname, path.basename(file.path),
          file.mimetype, file.size, req.user.id],
      );
    }

    await query(
      'UPDATE quotations SET is_superseded = TRUE, updated_at = now() WHERE id = $1',
      [previousId],
    );

    // A selected vendor stays selected across a revision — it is the same
    // offer, at a new price.
    await query(
      'UPDATE approval_notes SET selected_quotation_id = $1, updated_at = now() WHERE id = $2 AND selected_quotation_id = $3',
      [created.id, previous.note_id, previousId],
    );

    return { created };
  });

  await audit(req, {
    noteId: previous.note_id, action: 'quotation_revised', entity: 'quotation', entityId: revision.created.id,
    detail: {
      vendor: previous.vendor_name,
      from_version: previous.version_no || 1,
      to_version: revision.created.version_no,
      supersedes: previousId,
      note: body.revision_note || null,
    },
  });

  res.status(201).json({
    note: await loadNote(previous.note_id),
    quotation_id: revision.created.id,
    version_no: revision.created.version_no,
    items_carried_over: carriedOver,
    extraction: extraction
      ? {
        method: extraction.method,
        confidence: extraction.confidence,
        warnings: extraction.warnings,
        itemCount: extraction.items?.length || 0,
      }
      : null,
  });
}));

/** Every version of an offer, newest first. */
router.get('/quotations/:id/versions', wrap(async (req, res) => {
  const id = Number(req.params.id);
  const quotation = await one('SELECT * FROM quotations WHERE id = $1', [id]);
  if (!quotation) throw httpError(404, 'There is no quotation with that id.');

  const chain = await many(
    `WITH RECURSIVE earlier AS (
       SELECT * FROM quotations WHERE id = $1
       UNION ALL
       SELECT q.* FROM quotations q JOIN earlier e ON q.id = e.supersedes_id
     )
     SELECT * FROM earlier ORDER BY version_no DESC`,
    [id],
  );

  res.json({ versions: chain });
}));

/** Runs extraction again, optionally in a different mode. */
router.post('/quotations/:id/reextract', wrap(async (req, res) => {
  const id = Number(req.params.id);
  const quotation = await one('SELECT * FROM quotations WHERE id = $1', [id]);
  if (!quotation) throw httpError(404, 'There is no quotation with that id.');

  const note = await requireNote(quotation.note_id);
  assertEditable(note, req.user);

  const files = await many('SELECT * FROM quotation_files WHERE quotation_id = $1', [id]);
  if (!files.length) throw httpError(400, 'There is no attachment on this quotation to read.');

  const buffers = [];
  for (const file of files) {
    try {
      buffers.push({
        buffer: await fs.readFile(storedPath(file.stored_name)),
        originalName: file.original_name,
        mimeType: file.mime_type,
      });
    } catch {
      // A missing file on disk should not stop the others.
    }
  }

  if (!buffers.length) throw httpError(400, 'The attached files could not be read from disk.');

  let extraction;
  try {
    extraction = await extractFromFiles(buffers, { mode: req.body?.mode || undefined });
  } catch (error) {
    throw httpError(422, `The attachment could not be read. The saved quotation was left unchanged. ${error.message}`);
  }
  if (!extraction.ok) {
    throw httpError(422, `${extraction.warnings?.[0] || 'The attachment could not be read.'} The saved quotation was left unchanged.`);
  }

  await tx(async () => {
    if (req.body?.replace_items !== false && extraction.items?.length) {
      await query('DELETE FROM quotation_items WHERE quotation_id = $1', [id]);
      for (const [index, item] of (extraction.items || []).entries()) {
        const quantity = num(item.quantity, 1);
        const rate = num(item.rate, 0);
        await query(
          `INSERT INTO quotation_items (quotation_id, line_no, description, quantity, unit, rate, amount, needs_review)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [id, item.line_no ?? index + 1, item.description, quantity, item.unit || 'Nos',
            rate, item.amount ?? round2(quantity * rate), Boolean(item.needs_review)],
        );
      }
    }

    await query(
      `UPDATE quotations SET
         source = $1, extraction_status = 'extracted', extraction_confidence = $2,
         extraction_method = $3, extraction_notes = $4, extraction_raw = $5,
         reviewed_by = NULL, reviewed_at = NULL, updated_at = now()
       WHERE id = $6`,
      [extraction.source, extraction.confidence, extraction.method,
        extraction.warnings?.join('\n') || null,
        JSON.stringify({ fields: extraction.fields, items: extraction.items, warnings: extraction.warnings }),
        id],
    );
  });

  await audit(req, { noteId: quotation.note_id, action: 'quotation_reextracted', entity: 'quotation', entityId: id });

  res.json({
    note: await loadNote(quotation.note_id),
    extraction: {
      method: extraction.method, confidence: extraction.confidence,
      warnings: extraction.warnings, fields: extraction.fields,
    },
  });
}));

/** Edits the header fields of a quotation. */
router.patch('/quotations/:id', wrap(async (req, res) => {
  const id = Number(req.params.id);
  const existing = await one('SELECT * FROM quotations WHERE id = $1', [id]);
  if (!existing) throw httpError(404, 'There is no quotation with that id.');

  const note = await requireNote(existing.note_id);
  assertEditable(note, req.user);

  const b = req.body || {};
  const fields = [];
  const values = [];
  const set = (column, value) => { values.push(value); fields.push(`${column} = $${values.length}`); };

  const submittedName = b.vendor_name === undefined ? existing.vendor_name : String(b.vendor_name || '').trim();
  const nameUnchanged = submittedName === existing.vendor_name;
  const requestedGstin = String(b.vendor_gstin || (nameUnchanged ? existing.vendor_gstin : '') || '')
    .toUpperCase().replace(/\s/g, '') || null;
  const sourceId = String(b.vendor_source_id || '').trim();
  let linkedVendor = null;
  if (sourceId) {
    linkedVendor = await resolveSiteErpVendor({ sourceId });
    if (!linkedVendor) throw httpError(400, 'That SiteERP vendor is no longer available. You can still enter the vendor name manually.');
  } else if (existing.vendor_source_id && nameUnchanged) {
    linkedVendor = await resolveSiteErpVendor({ sourceId: existing.vendor_source_id });
  } else if (submittedName) {
    linkedVendor = await resolveSiteErpVendor({ name: submittedName, gstin: requestedGstin });
  }

  const textFields = ['vendor_name', 'vendor_city', 'quotation_ref', 'quotation_date', 'delivery_text',
    'delivery_basis', 'payment_terms_text', 'warranty_text', 'remarks', 'exclusion_reason'];
  const numberFields = ['validity_days', 'delivery_days', 'advance_percent', 'credit_days',
    'retention_percent', 'retention_release_days', 'discount_amount', 'freight_amount', 'other_charges',
    'gst_rate', 'quoted_basic', 'quoted_total'];

  for (const key of textFields.filter((field) => field !== 'vendor_name')) {
    if (b[key] !== undefined) set(key, b[key] === '' ? null : b[key]);
  }
  for (const key of numberFields) {
    if (b[key] !== undefined) {
      const value = b[key] === '' || b[key] === null ? null : num(b[key]);
      set(key, key === 'retention_release_days' && value !== null ? Math.max(0, value) : value);
    }
  }

  if (b.vendor_name !== undefined || b.vendor_source_id !== undefined) {
    set('vendor_source_id', linkedVendor ? String(linkedVendor.id) : null);
    set('vendor_id', null);
    set('vendor_name', linkedVendor?.name || submittedName || null);
    if (!linkedVendor) set('vendor_gstin', requestedGstin);
    else set('vendor_gstin', String(linkedVendor.gst_no || linkedVendor.tax_identifier || '').toUpperCase().replace(/\s/g, '') || null);
    if (!linkedVendor) {
      const pan = b.vendor_pan || (requestedGstin ? panFromGstin(requestedGstin) : null);
      set('vendor_pan', pan ? String(pan).toUpperCase().replace(/\s/g, '') : null);
    } else {
      set('vendor_pan', String(linkedVendor.pan_no || '').toUpperCase().replace(/\s/g, '')
        || panFromGstin(linkedVendor.gst_no || linkedVendor.tax_identifier || '') || null);
    }
  } else {
    if (b.vendor_gstin !== undefined) {
      const gstin = b.vendor_gstin ? String(b.vendor_gstin).toUpperCase().replace(/\s/g, '') : null;
      set('vendor_gstin', gstin);
      if (b.vendor_pan === undefined && gstin) set('vendor_pan', panFromGstin(gstin));
    }
    if (b.vendor_pan !== undefined) {
      set('vendor_pan', b.vendor_pan ? String(b.vendor_pan).toUpperCase().replace(/\s/g, '') : null);
    }
  }
  if (b.is_excluded !== undefined) set('is_excluded', Boolean(b.is_excluded));
  if (b.vendor_id !== undefined) set('vendor_id', b.vendor_id ? Number(b.vendor_id) : null);

  if (!fields.length) throw httpError(400, 'There is nothing to change.');

  values.push(id);
  await query(`UPDATE quotations SET ${fields.join(', ')}, updated_at = now() WHERE id = $${values.length}`, values);

  const warnings = [];
  // Vendor master matching is optional; a name from the quotation is enough
  // to continue. The ERP list is a convenience and possible writeback source.
  if (b.vendor_gstin && !isValidGstin(String(b.vendor_gstin).toUpperCase().replace(/\s/g, ''))) {
    warnings.push('That GSTIN does not pass the check digit. Confirm it on the GST portal.');
  }

  await audit(req, { noteId: existing.note_id, action: 'quotation_updated', entity: 'quotation', entityId: id });
  res.json({ note: await loadNote(existing.note_id), warnings });
}));

/** Replaces the quoted lines — the manual correction the user asked for. */
router.put('/quotations/:id/items', wrap(async (req, res) => {
  const id = Number(req.params.id);
  const quotation = await one('SELECT * FROM quotations WHERE id = $1', [id]);
  if (!quotation) throw httpError(404, 'There is no quotation with that id.');

  const note = await requireNote(quotation.note_id);
  assertEditable(note, req.user);

  const items = Array.isArray(req.body?.items) ? req.body.items : [];

  await tx(async () => {
    await query('DELETE FROM quotation_items WHERE quotation_id = $1', [id]);
    for (const [index, item] of items.entries()) {
      if (!item.description?.trim()) continue;
      const quantity = num(item.quantity, 1);
      const rate = num(item.rate, 0);
      const amount = item.amount !== undefined && item.amount !== null && item.amount !== ''
        ? round2(item.amount) : round2(quantity * rate);

      await query(
        `INSERT INTO quotation_items
           (quotation_id, line_no, line_key, description, specification, part_no, hsn_sac,
            quantity, unit, rate, amount, gst_rate, is_optional, not_quoted, needs_review, remarks)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        [id, item.line_no ?? index + 1, item.line_key || null, item.description.trim(),
          item.specification || null, item.part_no || null, item.hsn_sac || null,
          quantity, item.unit || 'Nos', rate, amount,
          item.gst_rate === '' || item.gst_rate === undefined ? null : num(item.gst_rate),
          Boolean(item.is_optional), Boolean(item.not_quoted), Boolean(item.needs_review),
          item.remarks || null],
      );
    }
  });

  await audit(req, { noteId: quotation.note_id, action: 'quotation_items_updated', entity: 'quotation', entityId: id });
  res.json({ note: await loadNote(quotation.note_id) });
}));

/**
 * The review gate. Until this is done the note cannot be submitted, because
 * the figures are only what a machine thought it saw.
 */
router.post('/quotations/:id/confirm', wrap(async (req, res) => {
  const id = Number(req.params.id);
  const quotation = await one('SELECT * FROM quotations WHERE id = $1', [id]);
  if (!quotation) throw httpError(404, 'There is no quotation with that id.');

  const note = await requireNote(quotation.note_id);
  assertEditable(note, req.user);

  if (!quotation.vendor_name?.trim()) {
    throw httpError(400, 'The vendor name is empty. Fill it in before confirming.');
  }
  const items = await many('SELECT * FROM quotation_items WHERE quotation_id = $1', [id]);
  const quotedTotal = round2(items.filter((i) => !i.not_quoted).reduce((s, i) => s + num(i.amount, 0), 0));

  if (!items.length && (quotation.quoted_basic === null || quotation.quoted_basic === undefined)
      && (quotation.quoted_total === null || quotation.quoted_total === undefined)) {
    throw httpError(400, 'Enter line items, the quoted basic value, or the quoted total before confirming.');
  }

  await query(
    `UPDATE quotations
        SET extraction_status = 'reviewed', reviewed_by = $1, reviewed_at = now(),
            quoted_basic = COALESCE($2, quoted_basic), updated_at = now()
      WHERE id = $3`,
    [req.user.id, items.length ? quotedTotal : null, id],
  );

  await query('UPDATE quotation_items SET needs_review = FALSE WHERE quotation_id = $1', [id]);

  await audit(req, {
    noteId: quotation.note_id, action: 'quotation_confirmed', entity: 'quotation', entityId: id,
    detail: { vendor: quotation.vendor_name, basic: quotedTotal },
  });

  res.json({ note: await loadNote(quotation.note_id) });
}));

router.delete('/quotations/:id', wrap(async (req, res) => {
  const id = Number(req.params.id);
  const quotation = await one('SELECT * FROM quotations WHERE id = $1', [id]);
  if (!quotation) throw httpError(404, 'There is no quotation with that id.');

  const note = await requireNote(quotation.note_id);
  assertEditable(note, req.user);

  const files = await many('SELECT stored_name FROM quotation_files WHERE quotation_id = $1', [id]);

  await tx(async () => {
    // Deleting the newest version brings the one it replaced back into play,
    // rather than dropping the vendor out of the comparison altogether.
    if (quotation.supersedes_id) {
      await query(
        'UPDATE quotations SET is_superseded = FALSE, updated_at = now() WHERE id = $1',
        [quotation.supersedes_id],
      );
      await query(
        `UPDATE approval_notes SET selected_quotation_id = $1, updated_at = now()
          WHERE id = $2 AND selected_quotation_id = $3`,
        [quotation.supersedes_id, quotation.note_id, id],
      );
    }

    // Any later version now points at a row that is about to vanish; the FK is
    // ON DELETE SET NULL, so it would silently become a chain head. Re-link it
    // to this row's own predecessor so the history stays joined up.
    await query(
      'UPDATE quotations SET supersedes_id = $1 WHERE supersedes_id = $2',
      [quotation.supersedes_id || null, id],
    );

    await query('DELETE FROM quotations WHERE id = $1', [id]);
  });

  for (const file of files) {
    try { await fs.unlink(storedPath(file.stored_name)); } catch { /* already gone */ }
  }

  await audit(req, {
    noteId: quotation.note_id, action: 'quotation_deleted', entity: 'quotation', entityId: id,
    detail: { vendor: quotation.vendor_name, version: quotation.version_no },
  });
  res.json({ note: await loadNote(quotation.note_id) });
}));

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

/** Attaches further files to a note or a quotation (requisition scans etc). */
router.post('/notes/:id/files', upload.array('files', 12), wrap(async (req, res) => {
  const noteId = Number(req.params.id);
  const note = await requireNote(noteId);
  assertEditable(note, req.user);

  const kind = ['quotation', 'requisition', 'other'].includes(req.body?.kind) ? req.body.kind : 'other';
  const quotationId = req.body?.quotation_id ? Number(req.body.quotation_id) : null;

  for (const file of req.files || []) {
    await query(
      `INSERT INTO quotation_files
         (quotation_id, note_id, kind, original_name, stored_name, mime_type, size_bytes, uploaded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [quotationId, noteId, kind, file.originalname, path.basename(file.path),
        file.mimetype, file.size, req.user.id],
    );
  }

  await audit(req, { noteId, action: 'files_uploaded', entity: 'note', entityId: noteId, detail: { kind, count: (req.files || []).length } });
  res.status(201).json({ note: await loadNote(noteId) });
}));

router.get('/files/:id', wrap(async (req, res) => {
  const file = await one('SELECT * FROM quotation_files WHERE id = $1', [Number(req.params.id)]);
  if (!file) throw httpError(404, 'There is no file with that id.');

  const full = storedPath(file.stored_name);
  res.setHeader('Content-Type', file.mime_type || 'application/octet-stream');
  res.setHeader('Content-Disposition',
    `${req.query.download === '1' ? 'attachment' : 'inline'}; filename="${encodeURIComponent(file.original_name)}"`);
  res.sendFile(full);
}));

router.delete('/files/:id', wrap(async (req, res) => {
  const file = await one('SELECT * FROM quotation_files WHERE id = $1', [Number(req.params.id)]);
  if (!file) throw httpError(404, 'There is no file with that id.');

  const note = await requireNote(file.note_id);
  assertEditable(note, req.user);

  await query('DELETE FROM quotation_files WHERE id = $1', [file.id]);
  try { await fs.unlink(storedPath(file.stored_name)); } catch { /* already gone */ }

  res.json({ note: await loadNote(file.note_id) });
}));

export default router;
