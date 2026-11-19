import { tx } from '../db.js';
import { withReadOnlySource } from './source-databases.js';

const SOURCE = 'reqflow';

/** Copy Reqflow reference data into AppNote's lookup cache. The source read is
 * transactionally read-only; all writes below target AppNote only. */
export async function syncReqflow() {
  const snapshot = await withReadOnlySource(SOURCE, async (client) => {
    const projects = await client.query('SELECT id, code, name, company_id FROM public.projects ORDER BY id');
    const sites = await client.query('SELECT id, name, company_id, location FROM public.sites ORDER BY id');
    const requisitions = await client.query(`SELECT r.id, r.ref_number, r.status, r.project_id, p.name AS project_name,
                           r.site_id, COALESCE(r.site_name, s.name) AS site_name,
                           r.raised_by_name, r.requisition_date, r.priority, r.purpose, r.notes,
                           r.submitted_at, r.approved_at, r.completed_at, r.created_at, r.updated_at
                      FROM public.requisitions r
                      LEFT JOIN public.projects p ON p.id = r.project_id
                      LEFT JOIN public.sites s ON s.id = r.site_id
                     ORDER BY r.id`);
    const items = await client.query(`SELECT id, requisition_id, sort_order, item_name, quantity, unit, reference_no,
                           expected_cost, expected_cost_is_unit, description, remark, asset_id, asset_name
                      FROM public.requisition_items ORDER BY requisition_id, sort_order, id`);
    return { projects: projects.rows, sites: sites.rows, requisitions: requisitions.rows, items: items.rows };
  });

  await tx(async (db) => {
    for (const table of ['source_projects', 'source_sites', 'source_requisitions', 'source_requisition_items']) {
      await db.query(`UPDATE ${table} SET is_current = false WHERE source_system = $1`, [SOURCE]);
    }

    for (const row of snapshot.projects) await db.query(
      `INSERT INTO source_projects (source_system, source_id, code, name, company_id, is_current, synced_at)
       VALUES ($1,$2,$3,$4,$5,true,now()) ON CONFLICT (source_system, source_id) DO UPDATE SET
       code=EXCLUDED.code, name=EXCLUDED.name, company_id=EXCLUDED.company_id, is_current=true, synced_at=now()`,
      [SOURCE, String(row.id), row.code, row.name, row.company_id == null ? null : String(row.company_id)],
    );
    for (const row of snapshot.sites) await db.query(
      `INSERT INTO source_sites (source_system, source_id, name, company_id, location, is_current, synced_at)
       VALUES ($1,$2,$3,$4,$5,true,now()) ON CONFLICT (source_system, source_id) DO UPDATE SET
       name=EXCLUDED.name, company_id=EXCLUDED.company_id, location=EXCLUDED.location, is_current=true, synced_at=now()`,
      [SOURCE, String(row.id), row.name, row.company_id == null ? null : String(row.company_id), row.location],
    );
    for (const row of snapshot.requisitions) await db.query(
      `INSERT INTO source_requisitions (source_system, source_id, ref_number, source_status, project_id,
       project_name, site_id, site_name, raised_by_name, requisition_date, priority, purpose, notes,
       submitted_at, approved_at, completed_at, source_created_at, source_updated_at, is_current, synced_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,true,now())
       ON CONFLICT (source_system, source_id) DO UPDATE SET ref_number=EXCLUDED.ref_number,
       source_status=EXCLUDED.source_status, project_id=EXCLUDED.project_id, project_name=EXCLUDED.project_name,
       site_id=EXCLUDED.site_id, site_name=EXCLUDED.site_name, raised_by_name=EXCLUDED.raised_by_name,
       requisition_date=EXCLUDED.requisition_date, priority=EXCLUDED.priority, purpose=EXCLUDED.purpose,
       notes=EXCLUDED.notes, submitted_at=EXCLUDED.submitted_at, approved_at=EXCLUDED.approved_at,
       completed_at=EXCLUDED.completed_at, source_created_at=EXCLUDED.source_created_at,
       source_updated_at=EXCLUDED.source_updated_at, is_current=true, synced_at=now()`,
      [SOURCE, String(row.id), row.ref_number, row.status, row.project_id == null ? null : String(row.project_id),
        row.project_name, row.site_id == null ? null : String(row.site_id), row.site_name, row.raised_by_name,
        row.requisition_date, row.priority, row.purpose, row.notes, row.submitted_at, row.approved_at,
        row.completed_at, row.created_at, row.updated_at],
    );
    for (const row of snapshot.items) await db.query(
      `INSERT INTO source_requisition_items (source_system, source_id, source_requisition_id, line_no,
       item_name, quantity, unit, reference_no, expected_cost, expected_cost_is_unit, description, remark,
       asset_id, asset_name, is_current, synced_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,true,now())
       ON CONFLICT (source_system, source_id) DO UPDATE SET source_requisition_id=EXCLUDED.source_requisition_id,
       line_no=EXCLUDED.line_no, item_name=EXCLUDED.item_name, quantity=EXCLUDED.quantity, unit=EXCLUDED.unit,
       reference_no=EXCLUDED.reference_no, expected_cost=EXCLUDED.expected_cost,
       expected_cost_is_unit=EXCLUDED.expected_cost_is_unit, description=EXCLUDED.description,
       remark=EXCLUDED.remark, asset_id=EXCLUDED.asset_id, asset_name=EXCLUDED.asset_name,
       is_current=true, synced_at=now()`,
      [SOURCE, String(row.id), String(row.requisition_id), Number(row.sort_order || 0) + 1, row.item_name,
        row.quantity, row.unit, row.reference_no, row.expected_cost, row.expected_cost_is_unit,
        row.description, row.remark, row.asset_id == null ? null : String(row.asset_id), row.asset_name],
    );
  });

  return { projects: snapshot.projects.length, sites: snapshot.sites.length,
    requisitions: snapshot.requisitions.length, items: snapshot.items.length };
}
