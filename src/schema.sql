-- Approval Note Generator v0.2 — PostgreSQL schema
-- Dharti Dredging & Infrastructure Ltd
--
-- Idempotent: safe to run repeatedly. Every object uses IF NOT EXISTS.

-- ---------------------------------------------------------------------------
-- Users and roles
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS users (
  id              SERIAL PRIMARY KEY,
  username        TEXT NOT NULL UNIQUE,
  password_hash   TEXT NOT NULL,
  full_name       TEXT NOT NULL,
  designation     TEXT,
  email           TEXT,
  role            TEXT NOT NULL DEFAULT 'preparer'
                  CHECK (role IN ('preparer','checker','verifier','accounts','approver','admin')),
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_users_role ON users(role) WHERE is_active;

-- Set whenever a password is set by its owner. A seeded account has never had
-- one, which is what lets the admin screen show who is still on the shared
-- default handed out at install.
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMPTZ;

-- ---------------------------------------------------------------------------
-- Masters
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS projects (
  id              SERIAL PRIMARY KEY,
  code            TEXT UNIQUE,
  name            TEXT NOT NULL,
  location        TEXT,
  state_code      TEXT,              -- GST state code of place of supply
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS vendors (
  id                  SERIAL PRIMARY KEY,
  name                TEXT NOT NULL,
  short_name          TEXT,
  address             TEXT,
  city                TEXT,
  state_code          TEXT,
  contact_person      TEXT,
  phone               TEXT,
  email               TEXT,
  gstin               TEXT,
  pan                 TEXT,
  msme_number         TEXT,
  bank_name           TEXT,
  bank_account        TEXT,
  bank_ifsc           TEXT,
  vendor_constitution TEXT CHECK (vendor_constitution IN ('individual_huf','company','firm','other')),
  -- 206AB "specified person": has not filed returns, higher TDS applies
  is_specified_person BOOLEAN NOT NULL DEFAULT FALSE,
  -- Accounts-side verification flags
  gst_verified        BOOLEAN NOT NULL DEFAULT FALSE,
  pan_verified        BOOLEAN NOT NULL DEFAULT FALSE,
  bank_verified       BOOLEAN NOT NULL DEFAULT FALSE,
  msme_verified       BOOLEAN NOT NULL DEFAULT FALSE,
  verified_by         INTEGER REFERENCES users(id),
  verified_at         TIMESTAMPTZ,
  verification_remark TEXT,
  is_active           BOOLEAN NOT NULL DEFAULT TRUE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_vendors_name ON vendors(lower(name));
CREATE INDEX IF NOT EXISTS idx_vendors_gstin ON vendors(gstin);

-- ---------------------------------------------------------------------------
-- Requisitions — the originating demand. Mandatory, and an annexure.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS requisitions (
  id              SERIAL PRIMARY KEY,
  requisition_no  TEXT UNIQUE,
  project_id      INTEGER REFERENCES projects(id),
  raised_by       INTEGER REFERENCES users(id),
  raised_by_name  TEXT,
  raised_on       DATE NOT NULL DEFAULT CURRENT_DATE,
  required_by     DATE,
  vessel          TEXT,
  department      TEXT,
  purpose         TEXT,
  remarks         TEXT,
  status          TEXT NOT NULL DEFAULT 'open'
                  CHECK (status IN ('open','in_procurement','closed','cancelled')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS requisition_items (
  id              SERIAL PRIMARY KEY,
  requisition_id  INTEGER NOT NULL REFERENCES requisitions(id) ON DELETE CASCADE,
  line_no         INTEGER NOT NULL DEFAULT 1,
  description     TEXT NOT NULL,
  specification   TEXT,
  part_no         TEXT,
  quantity        NUMERIC(14,3) NOT NULL DEFAULT 1,
  unit            TEXT DEFAULT 'Nos',
  remarks         TEXT
);

CREATE INDEX IF NOT EXISTS idx_req_items_req ON requisition_items(requisition_id);

-- ---------------------------------------------------------------------------
-- Approval notes
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS approval_notes (
  id                  SERIAL PRIMARY KEY,
  note_no             TEXT UNIQUE,
  note_seq            INTEGER,
  financial_year      TEXT,
  note_date           DATE NOT NULL DEFAULT CURRENT_DATE,
  status_label        TEXT NOT NULL DEFAULT 'Live',

  subject             TEXT,
  item_description    TEXT,
  project_id          INTEGER REFERENCES projects(id),
  requisition_id      INTEGER REFERENCES requisitions(id),
  requisition_source  TEXT,
  requisition_source_id TEXT,
  source_requisition_snapshot JSONB,

  prepared_by         INTEGER REFERENCES users(id),
  prepared_by_name    TEXT,
  prepared_by_desig   TEXT,

  -- Selected vendor and the reason, both printed on the front page
  selected_quotation_id INTEGER,
  selection_reason    TEXT,
  selected_at         TIMESTAMPTZ,
  selected_by         INTEGER REFERENCES users(id),

  -- Commercial terms printed as bullets on the front page
  mode_of_payment     TEXT DEFAULT 'NEFT/RTGS',
  payment_terms       TEXT,
  transport_charges   TEXT,
  delivery_terms      TEXT,
  place_of_supply     TEXT,
  supply_state_code   TEXT,

  -- Workflow
  status              TEXT NOT NULL DEFAULT 'draft'
                      CHECK (status IN ('draft','pending_check','pending_verify','pending_accounts',
                                        'pending_approval','on_hold','approved','rejected','closed')),
  current_stage       TEXT,
  submitted_at        TIMESTAMPTZ,
  closed_at           TIMESTAMPTZ,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE approval_notes ADD COLUMN IF NOT EXISTS requisition_source TEXT;
ALTER TABLE approval_notes ADD COLUMN IF NOT EXISTS requisition_source_id TEXT;
ALTER TABLE approval_notes ADD COLUMN IF NOT EXISTS source_requisition_snapshot JSONB;

CREATE INDEX IF NOT EXISTS idx_notes_status ON approval_notes(status);
CREATE INDEX IF NOT EXISTS idx_notes_project ON approval_notes(project_id);
CREATE INDEX IF NOT EXISTS idx_notes_prepared ON approval_notes(prepared_by);

-- ---------------------------------------------------------------------------
-- Quotations — several per note, each an annexure, each comparable
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS quotations (
  id                  SERIAL PRIMARY KEY,
  note_id             INTEGER NOT NULL REFERENCES approval_notes(id) ON DELETE CASCADE,
  vendor_id           INTEGER REFERENCES vendors(id),
  vendor_source_id    TEXT,
  vendor_name         TEXT NOT NULL,
  vendor_gstin        TEXT,
  vendor_pan          TEXT,
  vendor_city         TEXT,
  position            INTEGER NOT NULL DEFAULT 1,

  quotation_ref       TEXT,
  quotation_date      DATE,
  validity_days       INTEGER,

  -- Delivery axis
  delivery_days       INTEGER,
  delivery_text       TEXT,
  delivery_basis      TEXT,            -- ex-works / FOR site / delivered

  -- Payment axis
  advance_percent     NUMERIC(6,2),
  credit_days         INTEGER,
  retention_percent   NUMERIC(6,2),
  retention_release_days INTEGER,
  payment_terms_text  TEXT,

  -- Commercials
  currency            TEXT NOT NULL DEFAULT 'INR',
  discount_amount     NUMERIC(16,2) NOT NULL DEFAULT 0,
  freight_amount      NUMERIC(16,2) NOT NULL DEFAULT 0,
  other_charges       NUMERIC(16,2) NOT NULL DEFAULT 0,
  gst_rate            NUMERIC(6,2),
  quoted_basic        NUMERIC(16,2),   -- as printed on the quotation
  quoted_total        NUMERIC(16,2),   -- as printed on the quotation
  warranty_text       TEXT,
  remarks             TEXT,

  -- Extraction provenance. Nothing here is trusted until reviewed.
  source              TEXT NOT NULL DEFAULT 'manual'
                      CHECK (source IN ('manual','pdf_text','ocr','ai')),
  extraction_status   TEXT NOT NULL DEFAULT 'none'
                      CHECK (extraction_status IN ('none','pending','extracted','reviewed','failed')),
  extraction_confidence INTEGER,
  extraction_method   TEXT,
  extraction_notes    TEXT,
  extraction_raw      JSONB,
  reviewed_by         INTEGER REFERENCES users(id),
  reviewed_at         TIMESTAMPTZ,

  is_excluded         BOOLEAN NOT NULL DEFAULT FALSE,
  exclusion_reason    TEXT,

  -- Revisions. A vendor who requotes after negotiation gets a new row linked
  -- back to the one it replaces, so the earlier offer is never lost: only the
  -- newest version is compared, and the chain is printed in the annexure as
  -- evidence that the price was negotiated.
  version_no          INTEGER NOT NULL DEFAULT 1,
  supersedes_id       INTEGER,
  is_superseded       BOOLEAN NOT NULL DEFAULT FALSE,
  revision_note       TEXT,
  received_on         DATE,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE quotations ADD COLUMN IF NOT EXISTS vendor_source_id TEXT;
ALTER TABLE quotations ADD COLUMN IF NOT EXISTS retention_release_days INTEGER;
CREATE INDEX IF NOT EXISTS idx_quotations_vendor_source ON quotations(vendor_source_id);

-- AppNote-owned accounts verification overlay for vendors mastered in SiteERP.
CREATE TABLE IF NOT EXISTS vendor_reviews (
  source_system       TEXT NOT NULL DEFAULT 'siteerp',
  source_vendor_id    TEXT NOT NULL,
  gst_verified        BOOLEAN NOT NULL DEFAULT FALSE,
  pan_verified        BOOLEAN NOT NULL DEFAULT FALSE,
  bank_verified       BOOLEAN NOT NULL DEFAULT FALSE,
  msme_verified       BOOLEAN NOT NULL DEFAULT FALSE,
  verification_remark TEXT,
  verified_by         INTEGER REFERENCES users(id),
  verified_at         TIMESTAMPTZ,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (source_system, source_vendor_id)
);

CREATE INDEX IF NOT EXISTS idx_quotations_note ON quotations(note_id);

-- Added after the first release; this block brings an existing database up.
ALTER TABLE quotations ADD COLUMN IF NOT EXISTS version_no INTEGER NOT NULL DEFAULT 1;
ALTER TABLE quotations ADD COLUMN IF NOT EXISTS supersedes_id INTEGER;
ALTER TABLE quotations ADD COLUMN IF NOT EXISTS is_superseded BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE quotations ADD COLUMN IF NOT EXISTS revision_note TEXT;
ALTER TABLE quotations ADD COLUMN IF NOT EXISTS received_on DATE;

ALTER TABLE quotations DROP CONSTRAINT IF EXISTS quotations_supersedes_fk;
ALTER TABLE quotations
  ADD CONSTRAINT quotations_supersedes_fk
  FOREIGN KEY (supersedes_id) REFERENCES quotations(id) ON DELETE SET NULL;

-- Only the newest version of each offer takes part in the comparison.
CREATE INDEX IF NOT EXISTS idx_quotations_current
  ON quotations(note_id) WHERE NOT is_superseded;
CREATE INDEX IF NOT EXISTS idx_quotations_supersedes ON quotations(supersedes_id);

ALTER TABLE approval_notes
  DROP CONSTRAINT IF EXISTS approval_notes_selected_quotation_fk;
ALTER TABLE approval_notes
  ADD CONSTRAINT approval_notes_selected_quotation_fk
  FOREIGN KEY (selected_quotation_id) REFERENCES quotations(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS quotation_items (
  id              SERIAL PRIMARY KEY,
  quotation_id    INTEGER NOT NULL REFERENCES quotations(id) ON DELETE CASCADE,
  line_no         INTEGER NOT NULL DEFAULT 1,
  -- line_key aligns comparable rows across vendors in the comparison annexure
  line_key        TEXT,
  description     TEXT NOT NULL,
  specification   TEXT,
  part_no         TEXT,
  hsn_sac         TEXT,
  quantity        NUMERIC(14,3) NOT NULL DEFAULT 1,
  unit            TEXT DEFAULT 'Nos',
  rate            NUMERIC(16,4) NOT NULL DEFAULT 0,
  amount          NUMERIC(16,2),
  gst_rate        NUMERIC(6,2),
  is_optional     BOOLEAN NOT NULL DEFAULT FALSE,
  not_quoted      BOOLEAN NOT NULL DEFAULT FALSE,
  needs_review    BOOLEAN NOT NULL DEFAULT FALSE,
  remarks         TEXT
);

CREATE INDEX IF NOT EXISTS idx_quot_items_quotation ON quotation_items(quotation_id);

CREATE TABLE IF NOT EXISTS quotation_files (
  id              SERIAL PRIMARY KEY,
  quotation_id    INTEGER REFERENCES quotations(id) ON DELETE CASCADE,
  note_id         INTEGER REFERENCES approval_notes(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL DEFAULT 'quotation'
                  CHECK (kind IN ('quotation','requisition','other')),
  original_name   TEXT NOT NULL,
  stored_name     TEXT NOT NULL,
  mime_type       TEXT,
  size_bytes      BIGINT,
  page_count      INTEGER,
  uploaded_by     INTEGER REFERENCES users(id),
  uploaded_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_quot_files_quotation ON quotation_files(quotation_id);
CREATE INDEX IF NOT EXISTS idx_quot_files_note ON quotation_files(note_id);

-- ---------------------------------------------------------------------------
-- Comparison beyond price: technical, commercial, delivery, payment
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS comparison_criteria (
  id              SERIAL PRIMARY KEY,
  note_id         INTEGER NOT NULL REFERENCES approval_notes(id) ON DELETE CASCADE,
  line_no         INTEGER NOT NULL DEFAULT 1,
  category        TEXT NOT NULL DEFAULT 'technical'
                  CHECK (category IN ('technical','commercial','delivery','payment','other')),
  label           TEXT NOT NULL,
  requirement     TEXT,
  weight          NUMERIC(6,2) NOT NULL DEFAULT 1,
  is_mandatory    BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS idx_criteria_note ON comparison_criteria(note_id);

CREATE TABLE IF NOT EXISTS comparison_values (
  id              SERIAL PRIMARY KEY,
  criterion_id    INTEGER NOT NULL REFERENCES comparison_criteria(id) ON DELETE CASCADE,
  quotation_id    INTEGER NOT NULL REFERENCES quotations(id) ON DELETE CASCADE,
  value_text      TEXT,
  score           NUMERIC(5,2),     -- 0..10
  complies        BOOLEAN,
  remarks         TEXT,
  UNIQUE (criterion_id, quotation_id)
);

-- ---------------------------------------------------------------------------
-- Note items — the priced schedule that appears on the front page
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS note_items (
  id                  SERIAL PRIMARY KEY,
  note_id             INTEGER NOT NULL REFERENCES approval_notes(id) ON DELETE CASCADE,
  source_requisition_item_id TEXT,
  line_no             INTEGER NOT NULL DEFAULT 1,
  description         TEXT NOT NULL,
  specification       TEXT,
  hsn_sac             TEXT,
  quantity            NUMERIC(14,3) NOT NULL DEFAULT 1,
  unit                TEXT DEFAULT 'Nos',
  rate                NUMERIC(16,4) NOT NULL DEFAULT 0,
  amount              NUMERIC(16,2),
  discount_amount     NUMERIC(16,2) NOT NULL DEFAULT 0,

  supply_type         TEXT NOT NULL DEFAULT 'goods'
                      CHECK (supply_type IN ('goods','services','works_contract')),
  gst_rate            NUMERIC(6,2) NOT NULL DEFAULT 18,

  -- Accounts confirms tax item by item; both figures are retained so the
  -- document can state "proposed 18%, confirmed 5%".
  tax_verified        BOOLEAN NOT NULL DEFAULT FALSE,
  verified_gst_rate   NUMERIC(6,2),
  tax_remark          TEXT,
  verified_by         INTEGER REFERENCES users(id),
  verified_at         TIMESTAMPTZ,

  tds_section_override TEXT,
  source_quotation_item_id INTEGER REFERENCES quotation_items(id) ON DELETE SET NULL
);

ALTER TABLE note_items ADD COLUMN IF NOT EXISTS source_requisition_item_id TEXT;

CREATE INDEX IF NOT EXISTS idx_note_items_note ON note_items(note_id);

-- ---------------------------------------------------------------------------
-- Payment schedule — an annexure
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS payment_milestones (
  id              SERIAL PRIMARY KEY,
  note_id         INTEGER NOT NULL REFERENCES approval_notes(id) ON DELETE CASCADE,
  line_no         INTEGER NOT NULL DEFAULT 1,
  milestone       TEXT NOT NULL,
  trigger_event   TEXT,
  due_offset_days INTEGER,
  due_date        DATE,
  percent         NUMERIC(6,2),
  basis           TEXT NOT NULL DEFAULT 'grand_total'
                  CHECK (basis IN ('basic','grand_total')),
  fixed_amount    NUMERIC(16,2),
  is_retention    BOOLEAN NOT NULL DEFAULT FALSE,
  remarks         TEXT
);

CREATE INDEX IF NOT EXISTS idx_milestones_note ON payment_milestones(note_id);

-- ---------------------------------------------------------------------------
-- Accounts review — GST/PAN checks, item-wise tax sign-off, TDS/TCS
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS accounts_review (
  note_id                 INTEGER PRIMARY KEY REFERENCES approval_notes(id) ON DELETE CASCADE,

  gst_number_checked      BOOLEAN NOT NULL DEFAULT FALSE,
  gst_status              TEXT,
  gst_checked_on          DATE,
  pan_number_checked      BOOLEAN NOT NULL DEFAULT FALSE,
  pan_status              TEXT,
  pan_checked_on          DATE,
  msme_checked            BOOLEAN NOT NULL DEFAULT FALSE,
  bank_details_checked    BOOLEAN NOT NULL DEFAULT FALSE,
  duplicate_checked       BOOLEAN NOT NULL DEFAULT FALSE,
  budget_checked          BOOLEAN NOT NULL DEFAULT FALSE,
  all_items_tax_verified  BOOLEAN NOT NULL DEFAULT FALSE,

  tds_applicable          BOOLEAN NOT NULL DEFAULT FALSE,
  tds_section             TEXT,
  tds_rate                NUMERIC(6,2),
  tds_base                NUMERIC(16,2),
  tds_amount              NUMERIC(16,2),
  tds_remark              TEXT,

  tcs_applicable          BOOLEAN NOT NULL DEFAULT FALSE,
  tcs_section             TEXT,
  tcs_rate                NUMERIC(6,2),
  tcs_base                NUMERIC(16,2),
  tcs_amount              NUMERIC(16,2),
  tcs_remark              TEXT,

  basic_amount            NUMERIC(16,2),
  gst_amount              NUMERIC(16,2),
  grand_total             NUMERIC(16,2),
  net_payable             NUMERIC(16,2),

  remarks                 TEXT,
  reviewed_by             INTEGER REFERENCES users(id),
  reviewed_at             TIMESTAMPTZ,
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The Accounts form must be saved during the current approval round, after
-- any preparer changes, before the Accounts workflow step can be approved.
ALTER TABLE accounts_review ADD COLUMN IF NOT EXISTS workflow_reviewed_at TIMESTAMPTZ;

-- ---------------------------------------------------------------------------
-- Workflow and audit
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS workflow_steps (
  id              SERIAL PRIMARY KEY,
  note_id         INTEGER NOT NULL REFERENCES approval_notes(id) ON DELETE CASCADE,
  step_order      INTEGER NOT NULL,
  step_type       TEXT NOT NULL CHECK (step_type IN ('check','verify','accounts','approve')),
  assignee_id     INTEGER REFERENCES users(id),
  assignee_name   TEXT,
  decision        TEXT CHECK (decision IN ('pending','approved','rejected','on_hold')),
  decided_at      TIMESTAMPTZ,
  comments        TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_steps_note ON workflow_steps(note_id, step_order);
CREATE INDEX IF NOT EXISTS idx_steps_assignee ON workflow_steps(assignee_id)
  WHERE decision = 'pending';

-- Edit requests return a submitted note to its preparer without losing who
-- asked for changes or the workflow comments from earlier approval rounds.
CREATE TABLE IF NOT EXISTS note_edit_requests (
  id                SERIAL PRIMARY KEY,
  note_id           INTEGER NOT NULL REFERENCES approval_notes(id) ON DELETE CASCADE,
  requested_by      INTEGER REFERENCES users(id),
  requested_by_name TEXT NOT NULL,
  requested_by_role TEXT NOT NULL,
  stage_type        TEXT NOT NULL CHECK (stage_type IN ('accounts','check','verify','approve')),
  request_text      TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','resubmitted')),
  requested_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  resubmitted_by    INTEGER REFERENCES users(id),
  resubmitted_at    TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_one_pending_edit_request
  ON note_edit_requests(note_id) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS workflow_comment_history (
  id                BIGSERIAL PRIMARY KEY,
  note_id           INTEGER NOT NULL REFERENCES approval_notes(id) ON DELETE CASCADE,
  workflow_step_id  INTEGER REFERENCES workflow_steps(id) ON DELETE SET NULL,
  stage_type        TEXT NOT NULL CHECK (stage_type IN ('accounts','check','verify','approve')),
  actor_name        TEXT NOT NULL,
  decision          TEXT NOT NULL CHECK (decision IN ('approved','rejected','on_hold')),
  comment           TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_workflow_comment_history_note
  ON workflow_comment_history(note_id, created_at, id);

-- Preserve comments already recorded before this history table was added.
INSERT INTO workflow_comment_history
  (note_id, workflow_step_id, stage_type, actor_name, decision, comment, created_at)
SELECT w.note_id, w.id, w.step_type, COALESCE(w.assignee_name, 'Reviewer'),
       CASE WHEN w.decision IN ('approved','rejected','on_hold') THEN w.decision ELSE 'on_hold' END,
       w.comments, COALESCE(w.decided_at, w.created_at)
  FROM workflow_steps w
 WHERE NULLIF(BTRIM(w.comments), '') IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM workflow_comment_history h
      WHERE h.note_id = w.note_id
        AND h.workflow_step_id = w.id
        AND h.comment = w.comments
        AND h.created_at = COALESCE(w.decided_at, w.created_at)
   );

CREATE TABLE IF NOT EXISTS audit_log (
  id              BIGSERIAL PRIMARY KEY,
  note_id         INTEGER REFERENCES approval_notes(id) ON DELETE CASCADE,
  user_id         INTEGER REFERENCES users(id),
  user_name       TEXT,
  action          TEXT NOT NULL,
  entity          TEXT,
  entity_id       INTEGER,
  detail          JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_note ON audit_log(note_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Read-only source caches. Source IDs remain separate from AppNote IDs.
-- These tables contain copies for lookup only; sync never writes upstream.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS source_projects (
  source_system TEXT NOT NULL,
  source_id     TEXT NOT NULL,
  code          TEXT,
  name          TEXT NOT NULL,
  company_id    TEXT,
  is_current    BOOLEAN NOT NULL DEFAULT TRUE,
  synced_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (source_system, source_id)
);

CREATE TABLE IF NOT EXISTS source_sites (
  source_system TEXT NOT NULL,
  source_id     TEXT NOT NULL,
  name          TEXT NOT NULL,
  company_id    TEXT,
  location      TEXT,
  is_current    BOOLEAN NOT NULL DEFAULT TRUE,
  synced_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (source_system, source_id)
);

CREATE TABLE IF NOT EXISTS source_requisitions (
  source_system     TEXT NOT NULL,
  source_id         TEXT NOT NULL,
  ref_number        TEXT NOT NULL,
  source_status     TEXT NOT NULL,
  project_id        TEXT,
  project_name      TEXT,
  site_id           TEXT,
  site_name         TEXT,
  raised_by_name    TEXT,
  requisition_date  TEXT,
  priority          TEXT,
  purpose           TEXT,
  notes             TEXT,
  submitted_at      TIMESTAMPTZ,
  approved_at       TIMESTAMPTZ,
  completed_at      TIMESTAMPTZ,
  source_created_at TIMESTAMPTZ,
  source_updated_at TIMESTAMPTZ,
  is_current        BOOLEAN NOT NULL DEFAULT TRUE,
  synced_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (source_system, source_id)
);

CREATE INDEX IF NOT EXISTS idx_source_requisitions_ref
  ON source_requisitions(source_system, lower(ref_number));
CREATE INDEX IF NOT EXISTS idx_source_requisitions_status
  ON source_requisitions(source_system, source_status, is_current);

CREATE TABLE IF NOT EXISTS source_requisition_items (
  source_system          TEXT NOT NULL,
  source_id              TEXT NOT NULL,
  source_requisition_id  TEXT NOT NULL,
  line_no                INTEGER NOT NULL DEFAULT 1,
  item_name              TEXT NOT NULL,
  quantity               NUMERIC(10,3) NOT NULL DEFAULT 1,
  unit                   TEXT,
  reference_no           TEXT,
  expected_cost          NUMERIC(12,2),
  expected_cost_is_unit  BOOLEAN,
  description            TEXT,
  remark                 TEXT,
  asset_id               TEXT,
  asset_name             TEXT,
  is_current             BOOLEAN NOT NULL DEFAULT TRUE,
  synced_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (source_system, source_id),
  FOREIGN KEY (source_system, source_requisition_id)
    REFERENCES source_requisitions(source_system, source_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_source_req_items_parent
  ON source_requisition_items(source_system, source_requisition_id, is_current, line_no);

CREATE TABLE IF NOT EXISTS source_vendors (
  source_system     TEXT NOT NULL,
  source_id         TEXT NOT NULL,
  vendor_code       TEXT,
  name              TEXT NOT NULL,
  contact_person    TEXT,
  email             TEXT,
  phone             TEXT,
  address           TEXT,
  tax_identifier    TEXT,
  gst_no            TEXT,
  pan_no            TEXT,
  udyam_id          TEXT,
  is_active         BOOLEAN NOT NULL DEFAULT TRUE,
  is_current        BOOLEAN NOT NULL DEFAULT TRUE,
  synced_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (source_system, source_id)
);

CREATE INDEX IF NOT EXISTS idx_source_vendors_name
  ON source_vendors(source_system, lower(name), is_current);
CREATE INDEX IF NOT EXISTS idx_source_vendors_code
  ON source_vendors(source_system, lower(vendor_code)) WHERE vendor_code IS NOT NULL;

-- Persistent session storage. Sessions survive a server restart and are shared
-- by every AppNote process connected to this database.
CREATE TABLE IF NOT EXISTS app_sessions (
  sid    TEXT PRIMARY KEY,
  sess   JSONB NOT NULL,
  expire TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_app_sessions_expire ON app_sessions(expire);
