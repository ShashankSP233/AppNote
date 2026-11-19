import express from 'express';
import { many, one } from '../db.js';
import { wrap, httpError, requireAuth } from '../middleware.js';

const router = express.Router();
router.use(requireAuth);

router.get('/siteerp/vendors', wrap(async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 120);
  const includeInactive = req.query.include_inactive === '1';
  const vendors = await many(
    `SELECT id::text AS source_id, vendor_code, name, contact_person, email, phone, address,
            tax_identifier, gst_no, pan_no, udyam_id, is_active
       FROM fdw_siteerp.vendors
      WHERE ($1::boolean OR is_active)
        AND ($2='' OR concat_ws(' ', vendor_code, name, contact_person, email, phone,
                                address, tax_identifier, gst_no, pan_no, udyam_id)
             ILIKE '%' || $2 || '%')
      ORDER BY lower(name), source_id`, [includeInactive, q]);
  res.json({ vendors, total: vendors.length });
}));

router.get('/reqflow/projects', wrap(async (req, res) => {
  const projects = await many(
    `SELECT id::text AS source_id, code, name, company_id::text AS company_id
       FROM fdw_reqflow.projects ORDER BY lower(name), id`);
  res.json({ projects });
}));

router.get('/reqflow/requisitions', wrap(async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 120);
  const status = String(req.query.status || '').trim().slice(0, 40);
  const projectId = req.query.project_id ? Number.parseInt(req.query.project_id, 10) : null;
  if (projectId !== null && (!Number.isSafeInteger(projectId) || projectId < 1)) {
    throw httpError(400, 'Choose a valid Reqflow project filter.');
  }
  const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 50));
  const offset = Math.max(0, Number.parseInt(req.query.offset, 10) || 0);
  const sortBy = String(req.query.sort || 'updated').toLowerCase();
  const direction = String(req.query.direction || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  const sortColumns = {
    updated: 'r.updated_at', date: 'r.requisition_date', reference: 'r.ref_number',
    project: 'p.name', status: 'r.status',
  };
  if (!sortColumns[sortBy]) throw httpError(400, 'Choose a valid requisition sort order.');
  const orderBy = `${sortColumns[sortBy]} ${direction} NULLS LAST, r.id ${direction}`;
  const rows = await many(
    `SELECT r.id::text AS source_id, r.ref_number, r.status AS source_status,
            r.project_id, p.name AS project_name,
            r.site_id, COALESCE(r.site_name,s.name) AS site_name, r.raised_by_name, r.requisition_date, r.priority,
            r.purpose, r.notes, r.submitted_at, r.approved_at, r.completed_at, r.updated_at AS source_updated_at,
            (SELECT count(*) FROM fdw_reqflow.requisition_items i
              WHERE i.requisition_id=r.id) AS item_count
       FROM fdw_reqflow.requisitions r
       LEFT JOIN fdw_reqflow.projects p ON p.id=r.project_id
       LEFT JOIN fdw_reqflow.sites s ON s.id=r.site_id
      WHERE ($1='' OR r.status=$1)
        AND ($2::bigint IS NULL OR r.project_id=$2)
        AND ($3='' OR concat_ws(' ', r.ref_number, r.purpose, COALESCE(r.site_name,s.name),
             r.raised_by_name, p.name, (SELECT string_agg(i.item_name, ' ') FROM fdw_reqflow.requisition_items i
               WHERE i.requisition_id=r.id))
             ILIKE '%' || $3 || '%')
      ORDER BY ${orderBy}
      LIMIT $4 OFFSET $5`, [status, projectId, q, limit, offset]);
  const total = await one(
    `SELECT count(*)::int AS count FROM fdw_reqflow.requisitions r
      LEFT JOIN fdw_reqflow.projects p ON p.id=r.project_id
      LEFT JOIN fdw_reqflow.sites s ON s.id=r.site_id
      WHERE ($1='' OR r.status=$1)
        AND ($2::bigint IS NULL OR r.project_id=$2)
        AND ($3='' OR concat_ws(' ', r.ref_number, r.purpose, COALESCE(r.site_name,s.name), r.raised_by_name, p.name,
             (SELECT string_agg(i.item_name, ' ') FROM fdw_reqflow.requisition_items i
               WHERE i.requisition_id=r.id))
             ILIKE '%' || $3 || '%')`, [status, projectId, q]);
  const statuses = await many(
    `SELECT DISTINCT status AS source_status FROM fdw_reqflow.requisitions ORDER BY status`);
  res.json({ requisitions: rows, total: total.count, limit, offset, status,
    project_id: projectId, sort: sortBy, direction: direction.toLowerCase(),
    statuses: statuses.map((x) => x.source_status) });
}));

router.get('/reqflow/requisitions/:id', wrap(async (req, res) => {
  const requisition = await one(
    `SELECT r.id::text AS source_id, r.ref_number, r.status AS source_status,
            r.project_id, p.name AS project_name, r.site_id,
            COALESCE(r.site_name, s.name) AS site_name, r.raised_by_name, r.requisition_date,
            r.priority, r.purpose, r.notes, r.submitted_at, r.approved_at, r.completed_at,
            r.created_at AS source_created_at, r.updated_at AS source_updated_at
       FROM fdw_reqflow.requisitions r
       LEFT JOIN fdw_reqflow.projects p ON p.id=r.project_id
       LEFT JOIN fdw_reqflow.sites s ON s.id=r.site_id
      WHERE r.id::text=$1`, [String(req.params.id)]);
  if (!requisition) throw httpError(404, 'That Reqflow requisition was not found.');
  const items = await many(
    `SELECT id::text AS source_id, sort_order AS line_no, item_name, quantity, unit, reference_no,
            expected_cost, expected_cost_is_unit, description, remark, asset_id, asset_name
       FROM fdw_reqflow.requisition_items
      WHERE requisition_id::text=$1 ORDER BY sort_order, id`, [String(req.params.id)]);
  res.json({ requisition, items });
}));

export default router;
