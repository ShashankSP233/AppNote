import express from 'express';
import { one, many, query, tx } from '../db.js';
import { wrap, httpError, requireAuth, requireRole, audit } from '../middleware.js';
import { isValidGstin, isValidPan, panFromGstin, stateCodeFromGstin, stateNameFromCode, constitutionFromPan, GST_STATE_NAMES } from '../domain.js';

const router = express.Router();

router.use(requireAuth);

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

router.get('/projects', wrap(async (req, res) => {
  const rows = await many(
    'SELECT * FROM projects WHERE is_active OR $1 ORDER BY name',
    [req.query.all === '1'],
  );
  res.json({ projects: rows });
}));

router.post('/projects', requireRole('preparer', 'admin'), wrap(async (req, res) => {
  const { code, name, location, state_code: stateCode } = req.body || {};
  if (!name?.trim()) throw httpError(400, 'The project needs a name.');
  if (stateCode && !GST_STATE_NAMES[String(stateCode).padStart(2, '0')]) {
    throw httpError(400, 'That is not a valid GST state code.');
  }

  const project = await one(
    'INSERT INTO projects (code, name, location, state_code) VALUES ($1,$2,$3,$4) RETURNING *',
    [code || null, name.trim(), location || null, stateCode ? String(stateCode).padStart(2, '0') : null],
  );
  await audit(req, { action: 'project_created', entity: 'project', entityId: project.id });
  res.status(201).json({ project });
}));

router.patch('/projects/:id', requireRole('preparer', 'admin'), wrap(async (req, res) => {
  const id = Number(req.params.id);
  const { code, name, location, state_code: stateCode, is_active: isActive } = req.body || {};

  const project = await one(
    `UPDATE projects SET
        code = COALESCE($1, code),
        name = COALESCE($2, name),
        location = COALESCE($3, location),
        state_code = COALESCE($4, state_code),
        is_active = COALESCE($5, is_active)
      WHERE id = $6 RETURNING *`,
    [code ?? null, name ?? null, location ?? null,
      stateCode ? String(stateCode).padStart(2, '0') : null,
      isActive === undefined ? null : Boolean(isActive), id],
  );
  if (!project) throw httpError(404, 'There is no project with that id.');
  res.json({ project });
}));

// ---------------------------------------------------------------------------
// Vendors
// ---------------------------------------------------------------------------

/**
 * Cleans up what was typed and cross-checks GSTIN against PAN. A mismatch is
 * reported but not rejected — the data may simply need correcting, and the
 * accounts screen is where it gets settled.
 */
export function normaliseVendor(input = {}) {
  const warnings = [];

  const gstin = input.gstin ? String(input.gstin).toUpperCase().replace(/\s/g, '') : null;
  let pan = input.pan ? String(input.pan).toUpperCase().replace(/\s/g, '') : null;

  if (gstin && !isValidGstin(gstin)) {
    warnings.push(`${gstin} does not pass the GSTIN check digit. Confirm it on the GST portal.`);
  }

  if (gstin) {
    const derived = panFromGstin(gstin);
    if (derived) {
      if (!pan) {
        pan = derived;
      } else if (pan !== derived) {
        warnings.push(`The PAN entered (${pan}) does not match the PAN inside the GSTIN (${derived}).`);
      }
    }
  }

  if (pan && !isValidPan(pan)) {
    warnings.push(`${pan} is not a valid PAN format.`);
  }

  const stateCode = input.state_code
    ? String(input.state_code).padStart(2, '0')
    : (gstin ? stateCodeFromGstin(gstin) : null);

  const constitution = input.vendor_constitution || constitutionFromPan(pan) || null;

  return {
    values: {
      name: input.name ? String(input.name).trim() : null,
      short_name: input.short_name || null,
      address: input.address || null,
      city: input.city || null,
      state_code: stateCode,
      contact_person: input.contact_person || null,
      phone: input.phone || null,
      email: input.email || null,
      gstin,
      pan,
      msme_number: input.msme_number || null,
      bank_name: input.bank_name || null,
      bank_account: input.bank_account || null,
      bank_ifsc: input.bank_ifsc ? String(input.bank_ifsc).toUpperCase().replace(/\s/g, '') : null,
      vendor_constitution: constitution,
      is_specified_person: Boolean(input.is_specified_person),
    },
    warnings,
  };
}

router.get('/vendors', requireRole('accounts', 'admin'), wrap(async (req, res) => {
  const search = req.query.q ? `%${String(req.query.q).trim()}%` : null;
  const rows = await many(
    `SELECT v.id, v.vendor_code AS short_name, v.name, v.address, NULL::text AS city,
            substring(COALESCE(v.gst_no, v.tax_identifier) from 1 for 2) AS state_code,
            v.contact_person, v.phone, v.email, COALESCE(v.gst_no, v.tax_identifier) AS gstin,
            v.pan_no AS pan, v.udyam_id AS msme_number, v.bank_name,
            v.bank_account_no AS bank_account, v.ifsc_code AS bank_ifsc, v.is_active,
            FALSE AS is_specified_person,
            COALESCE(vr.gst_verified, FALSE) AS gst_verified,
            COALESCE(vr.pan_verified, FALSE) AS pan_verified,
            COALESCE(vr.bank_verified, FALSE) AS bank_verified,
            COALESCE(vr.msme_verified, FALSE) AS msme_verified,
            vr.verification_remark, vr.verified_at
       FROM fdw_siteerp.vendors v
       LEFT JOIN vendor_reviews vr ON vr.source_system='siteerp' AND vr.source_vendor_id=v.id::text
      WHERE ($1::boolean OR v.is_active)
        AND ($2::text IS NULL OR concat_ws(' ', v.vendor_code, v.name, v.contact_person,
             v.email, v.phone, v.gst_no, v.pan_no) ILIKE $2)
      ORDER BY lower(v.name) LIMIT 300`,
    [req.query.all === '1', search],
  );
  res.json({ vendors: rows.map((v) => ({
    ...v,
    vendor_constitution: constitutionFromPan(v.pan),
    state_name: stateNameFromCode(v.state_code),
  })) });
}));

router.get('/vendors/:id', requireRole('accounts', 'admin'), wrap(async (req, res) => {
  const vendor = await one(
    `SELECT v.*, v.gst_no AS gstin, v.pan_no AS pan, v.udyam_id AS msme_number,
            substring(COALESCE(v.gst_no, v.tax_identifier) from 1 for 2) AS state_code,
            vr.gst_verified, vr.pan_verified, vr.bank_verified, vr.msme_verified,
            vr.verification_remark, vr.verified_at
       FROM fdw_siteerp.vendors v
       LEFT JOIN vendor_reviews vr ON vr.source_system='siteerp' AND vr.source_vendor_id=v.id::text
      WHERE v.id::text=$1`, [String(req.params.id)]);
  if (!vendor) throw httpError(404, 'There is no vendor with that id.');

  const history = await many(
    `SELECT n.id, n.note_no, n.note_date, n.subject, n.status
       FROM quotations q JOIN approval_notes n ON n.id = q.note_id
      WHERE (q.vendor_source_id = $1 OR (q.vendor_source_id IS NULL AND q.vendor_id = $2))
        AND n.selected_quotation_id = q.id
      ORDER BY n.note_date DESC LIMIT 20`,
    [String(vendor.id), Number(vendor.id)],
  );

  res.json({ vendor: { ...vendor, state_name: stateNameFromCode(vendor.state_code) }, history });
}));

router.post('/vendors', requireRole('preparer', 'accounts', 'admin'), wrap(async (req, res) => {
  throw httpError(409, 'Vendor records are managed in SiteERP. AppNote reads the current vendor list from there.');
}));

router.patch('/vendors/:id', requireRole('preparer', 'accounts', 'admin'), wrap(async (req, res) => {
  throw httpError(409, 'Vendor records are managed in SiteERP. Update the vendor there and AppNote will see the change.');
}));

/** Accounts records that it has checked the vendor's registrations. */
router.post('/vendors/:id/verify', requireRole('accounts', 'admin'), wrap(async (req, res) => {
  const id = String(req.params.id);
  const { gst_verified: gst, pan_verified: pan, bank_verified: bank,
    msme_verified: msme, remark } = req.body || {};

  const exists = await one('SELECT id FROM fdw_siteerp.vendors WHERE id::text=$1', [id]);
  if (!exists) throw httpError(404, 'There is no SiteERP vendor with that id.');
  const vendor = await one(
    `INSERT INTO vendor_reviews
       (source_system, source_vendor_id, gst_verified, pan_verified, bank_verified, msme_verified,
        verification_remark, verified_by, verified_at, updated_at)
     VALUES ('siteerp',$1,COALESCE($2,FALSE),COALESCE($3,FALSE),COALESCE($4,FALSE),COALESCE($5,FALSE),$6,$7,now(),now())
     ON CONFLICT (source_system, source_vendor_id) DO UPDATE SET
       gst_verified=COALESCE($2,vendor_reviews.gst_verified),
       pan_verified=COALESCE($3,vendor_reviews.pan_verified),
       bank_verified=COALESCE($4,vendor_reviews.bank_verified),
       msme_verified=COALESCE($5,vendor_reviews.msme_verified),
       verification_remark=COALESCE($6,vendor_reviews.verification_remark),
       verified_by=$7, verified_at=now(), updated_at=now()
     RETURNING *`,
    [id, gst === undefined ? null : Boolean(gst),
      pan === undefined ? null : Boolean(pan),
      bank === undefined ? null : Boolean(bank),
      msme === undefined ? null : Boolean(msme), remark ?? null, req.user.id],
  );

  if (!vendor) throw httpError(404, 'There is no vendor with that id.');

  await audit(req, { action: 'vendor_verified', entity: 'vendor', entityId: id, detail: req.body });
  res.json({ vendor });
}));

// ---------------------------------------------------------------------------
// Requisitions
// ---------------------------------------------------------------------------

router.get('/requisitions', wrap(async (req, res) => {
  const status = req.query.status || null;
  const rows = await many(
    `SELECT r.*, p.name AS project_name,
            (SELECT COUNT(*) FROM requisition_items ri WHERE ri.requisition_id = r.id) AS item_count,
            (SELECT COUNT(*) FROM approval_notes n WHERE n.requisition_id = r.id) AS note_count
       FROM requisitions r
       LEFT JOIN projects p ON p.id = r.project_id
      WHERE ($1::text IS NULL OR r.status = $1)
      ORDER BY r.raised_on DESC, r.id DESC
      LIMIT 200`,
    [status],
  );
  res.json({ requisitions: rows });
}));

router.get('/requisitions/:id', wrap(async (req, res) => {
  const id = Number(req.params.id);
  const requisition = await one(
    `SELECT r.*, p.name AS project_name FROM requisitions r
       LEFT JOIN projects p ON p.id = r.project_id WHERE r.id = $1`,
    [id],
  );
  if (!requisition) throw httpError(404, 'There is no requisition with that id.');

  requisition.items = await many(
    'SELECT * FROM requisition_items WHERE requisition_id = $1 ORDER BY line_no, id',
    [id],
  );
  res.json({ requisition });
}));

router.post('/requisitions', requireRole('preparer', 'checker', 'admin'), wrap(async () => {
  throw httpError(409, 'Raise new requisitions in Reqflow. AppNote uses Reqflow as its requisition source.');
}));

router.put('/requisitions/:id/items', requireRole('preparer', 'checker', 'admin'), wrap(async (req, res) => {
  const id = Number(req.params.id);
  const items = Array.isArray(req.body?.items) ? req.body.items : [];

  await tx(async () => {
    await query('DELETE FROM requisition_items WHERE requisition_id = $1', [id]);
    for (const [index, item] of items.entries()) {
      if (!item.description?.trim()) continue;
      await query(
        `INSERT INTO requisition_items (requisition_id, line_no, description, specification,
                                        part_no, quantity, unit, remarks)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [id, item.line_no ?? index + 1, item.description.trim(), item.specification || null,
          item.part_no || null, item.quantity ?? 1, item.unit || 'Nos', item.remarks || null],
      );
    }
  });

  const rows = await many('SELECT * FROM requisition_items WHERE requisition_id = $1 ORDER BY line_no, id', [id]);
  res.json({ items: rows });
}));

router.patch('/requisitions/:id', requireRole('preparer', 'checker', 'admin'), wrap(async (req, res) => {
  const id = Number(req.params.id);
  const b = req.body || {};
  const requisition = await one(
    `UPDATE requisitions SET
        requisition_no = COALESCE($1, requisition_no),
        project_id = COALESCE($2, project_id),
        required_by = COALESCE($3, required_by),
        vessel = COALESCE($4, vessel),
        department = COALESCE($5, department),
        purpose = COALESCE($6, purpose),
        remarks = COALESCE($7, remarks),
        status = COALESCE($8, status)
      WHERE id = $9 RETURNING *`,
    [b.requisition_no ?? null, b.project_id ?? null, b.required_by ?? null, b.vessel ?? null,
      b.department ?? null, b.purpose ?? null, b.remarks ?? null, b.status ?? null, id],
  );
  if (!requisition) throw httpError(404, 'There is no requisition with that id.');
  res.json({ requisition });
}));

export default router;
