import { tx } from '../db.js';
import { withReadOnlySource } from './source-databases.js';

const SOURCE = 'siteerp';

/** Cache the vendor identity fields used for procurement lookups. Bank details
 * and certificate file paths are deliberately not copied into AppNote. */
export async function syncSiteErpVendors() {
  const vendors = await withReadOnlySource(SOURCE, async (client) => {
    const result = await client.query(
      `SELECT id, vendor_code, name, contact_person, email, phone, address,
              tax_identifier, gst_no, pan_no, udyam_id, is_active
         FROM public.vendors ORDER BY id`,
    );
    return result.rows;
  });

  await tx(async (db) => {
    await db.query("UPDATE source_vendors SET is_current=false WHERE source_system=$1", [SOURCE]);
    for (const vendor of vendors) await db.query(
      `INSERT INTO source_vendors (source_system, source_id, vendor_code, name, contact_person,
       email, phone, address, tax_identifier, gst_no, pan_no, udyam_id, is_active, is_current, synced_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,true,now())
       ON CONFLICT (source_system, source_id) DO UPDATE SET vendor_code=EXCLUDED.vendor_code,
       name=EXCLUDED.name, contact_person=EXCLUDED.contact_person, email=EXCLUDED.email,
       phone=EXCLUDED.phone, address=EXCLUDED.address, tax_identifier=EXCLUDED.tax_identifier,
       gst_no=EXCLUDED.gst_no, pan_no=EXCLUDED.pan_no, udyam_id=EXCLUDED.udyam_id,
       is_active=EXCLUDED.is_active, is_current=true, synced_at=now()`,
      [SOURCE, String(vendor.id), vendor.vendor_code, vendor.name, vendor.contact_person,
        vendor.email, vendor.phone, vendor.address, vendor.tax_identifier, vendor.gst_no,
        vendor.pan_no, vendor.udyam_id, vendor.is_active],
    );
  });
  return { vendors: vendors.length, active: vendors.filter((vendor) => vendor.is_active).length };
}
