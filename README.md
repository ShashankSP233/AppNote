# Approval Note Generator v0.2

Prepares approval notes for Dharti Dredging & Infrastructure Ltd: several
quotations compared on price, delivery, payment terms and technical fit; the
accounts checks done line by line; and a Word document produced with every
annexure attached.

Built on Node.js and PostgreSQL. It runs on localhost first and can move to a
server later without changes.

---

## What it does

**Quotations go in as files.** Upload the PDF, the scan or the photograph. The
system reads what it can — the PDF text layer first, then OCR, then an AI
reader for the really poor images — and puts the figures in front of you beside
the attached copy.

**Nothing read by a machine is trusted.** Every extracted quotation sits at
*unconfirmed* until a person has opened it, checked it against the copy on the
screen and pressed confirm. A note **cannot be submitted** while any quotation
is unconfirmed. Extraction saves typing; it never decides anything.

**The heading colour says how much competition there was.** Before reading a
single figure, anyone can see whether the purchase was properly tendered:

| Offers compared | Table headings | What it means |
|---|---|---|
| 3 or more | Blue | Normal competitive purchase |
| 2 | Yellow | Thin — three is the norm |
| 1 | Orange | Single-source — needs a written justification |

This applies to every table on the note and to the screen, and the note itself
carries a line explaining the colour so a yellow or orange document is never a
puzzle to whoever receives it.

**A vendor who requotes keeps both offers.** Press *Revise* against a vendor
and the earlier offer is kept and marked superseded rather than overwritten.
Only the newest version is compared, but the whole chain is printed in that
vendor's annexure with what each revision moved, so the approver can see that
the price was negotiated rather than simply accepted. If the revision carries
no readable lines — a price agreed by phone — the previous version's lines are
copied across for editing and flagged for checking, which also means the note
cannot be submitted until someone has been through them. Deleting the newest
version brings the one before it back.

**The comparison is not limited to price.** Vendors are ranked on four axes:

| Axis | What it measures |
|---|---|
| Price | Landed cost — items, less discount, plus freight and other charges, plus GST |
| Delivery | Days to deliver, and on what basis |
| Payment terms | Advance, credit and retention, converted to a single cash-flow figure |
| Technical | Whatever criteria you set for this purchase, scored out of ten |

L1 is decided on **landed** cost, so a cheap quotation with heavy freight does
not win on a technicality. The weighted overall ranking sits alongside it, and
where the two disagree the note says so.

**The front page carries only a summary.** The full comparative statement is
Annexure B, in landscape.

**The note number is entered by the preparer.** This lets each approval use
the prefix and format authorized for it; the number must be unique and can be
corrected while the note is still editable.

**Accounts verify tax line by line.** Each line keeps both the rate purchase
proposed and the rate accounts confirmed, so the document can print "18%
proposed, 5% confirmed". The accounts stage cannot be approved until every
line is signed off and the GST and PAN are checked.

**TDS and TCS are worked out and settled.** TDS is withheld from the payment
and TCS added to it, so the note states the net amount actually payable.

**Annexures are assembled automatically:**

```
A    Requisition                      (required — a note cannot be submitted without one)
B    Comparative statement            (landscape)
C    Payment schedule
D…   Every quotation, selected vendor first
```

---

## Running it on your machine

You need **Node.js 20.11 or newer** and **PostgreSQL 14 or newer**.

```bash
# 1. Create the database
createdb approval_notes

# 2. Settings
cp .env.example .env
#    Edit APPNOTE_DB_URL if your PostgreSQL user or port differs.

# 3. Install
npm install

# 4. Create the tables and load the demo users, projects and vendors
npm run db:reset

# 5. Start
npm run dev
```

Open **http://localhost:8080** on this PC. From another device on the same
private network, open **http://192.168.1.143:8080** (or use this PC's current
LAN address if it changes). The `.env` binds the app to all network interfaces;
if Windows blocks the connection, add an inbound firewall rule for TCP 8080 on
the Private profile, limited to `LocalSubnet`.

### Preparing Reqflow and SiteERP data sources

Keep the source databases separate from AppNote's database. Set
`REQFLOW_DATABASE_URL` to Reqflow and `SITEERP_DATABASE_URL` to SiteERP, then
run:

```bash
npm run db:check-sources
```

This reads only the database name and public table/column metadata. It does not
read business rows or write to either source database. Once both source
databases are available, set up live PostgreSQL foreign tables with:

```bash
npm run db:init
npm run db:setup-fdw
```

For `db:setup-fdw`, supply the AppNote, Reqflow, and SiteERP administrator
URLs temporarily as `APPNOTE_FDW_SETUP_DB_URL`, `REQFLOW_FDW_SETUP_URL`, and
`SITEERP_FDW_SETUP_URL`. Do not save them in `.env`. Use the exact restored
database names on ServerPC (including `site_erp_v2` if that is its actual
SiteERP database name).

Elevated credentials are needed for the initial schema/seed and one-time FDW
setup. The FDW setup creates a restricted AppNote runtime login and maps the Reqflow and SiteERP foreign servers
to narrowly scoped remote roles, and changes `APPNOTE_DB_URL` in `.env` to the
restricted login. It also creates a separate SiteERP role limited to reading
the vendor fields AppNote needs and inserting vendors. The setup stops if one
of its dedicated PostgreSQL role names already belongs to something else.
Pass `APPNOTE_FDW_SETUP_DB_URL`, `REQFLOW_FDW_SETUP_URL`, and
`SITEERP_FDW_SETUP_URL` as temporary PowerShell environment variables; do not
store administrator URLs in the app's `.env`. The setup removes source URLs
from `.env` after creating the mappings; supply restricted source URLs again
only if you later run `db:check-sources`. Start PM2 from a fresh PowerShell
session after setup so it cannot inherit temporary credentials.
The runtime login is not a PostgreSQL superuser or database owner: it can
change AppNote records, read the approved Reqflow/SiteERP tables, and request
the narrowly limited SiteERP vendor insert.

AppNote accepts quotation vendor names without an ERP match; it only attempts to add a
new ERP vendor after a user selects that quotation, and only when a GSTIN or
PAN is present. If the write connection is unavailable, the local selection
still succeeds.

AppNote reads Reqflow and SiteERP through live foreign tables, so new source
records appear on the next AppNote query without a refresh job. The setup
creates separate source login roles with read-only access and stores their
random credentials in the ignored `.env` file. New approval notes link to a
Reqflow requisition and capture its project and line items when the note is
created, preserving a stable Annexure A snapshot for that approval record.
The requisition picker supports search, status and project filters, sorting,
and paging. SiteERP supplies vendor suggestions; users can still enter any
quotation vendor name. AppNote keeps accounts verification as a separate local
overlay. The vendor list endpoint omits bank details and certificate paths;
accounts views can read bank information live when required. Vendor creation
uses its own foreign server and a role limited to reading and inserting vendor
rows. Reqflow remains read-only until its update fields are defined.

### Adding your own people

Sign in as `admin` and go to **Masters → People and access**:

- **Add a person** — name, username, role and a starting password. The form
  suggests a readable one; hand it over directly rather than by email.
- **Edit** — change someone's role or designation, reset a forgotten password,
  or deactivate someone who has left. Deactivate rather than delete: their past
  decisions stay attached to the notes they signed.
- Usernames cannot be changed, because they appear against every decision that
  person has recorded.

Everyone can set their own password from **Change password** in the top bar,
and should. The list has an **Own password set** column: until someone sets
their own, it reads *not yet*, meaning the account is still on a password a
second person knows. An administrator resetting a password does not clear that
flag, which is the point.

The system will not let you deactivate your own account or demote the last
remaining administrator — either would lock everybody out of user management
with no way back in from inside the application.

### Demo sign-ins

Every seeded user has the password from `DEMO_PASSWORD` in `.env`
(`ChangeMe123!` unless you changed it). **Change these before anyone else uses
the system.**

| Username | Role | Can do |
|---|---|---|
| `jaswinder`, `mansi` | preparer | Create notes, upload and confirm quotations, select a vendor, submit |
| `saurabh`, `abhishek` | checker | Act at the checking stage |
| `vipul`, `harshada` | verifier | Act at the verification stage |
| `accounts` | accounts | Verify tax line by line, check GST and PAN, set TDS and TCS |
| `md`, `chairman` | approver | Final approval |
| `admin` | admin | Everything, plus user administration |

---

## How a note moves

```
draft ─► checking ─► verification ─► accounts ─► approval ─► approved
                                                     │
                 on hold / rejected ◄────────────────┘
```

Every stage can take more than one person; the note moves on only when all of
them have acted. Leave a stage unassigned at submission and anyone holding that
role can act on it.

A note will not leave draft until:

- the subject, project and **requisition** are set,
- at least one quotation is attached,
- **every quotation has been confirmed by a person**,
- a vendor is selected **and a reason is written**,
- the priced schedule has lines.

The accounts stage will not approve until every line's tax is verified and the
GST and PAN are checked.

---

## Reading quotations

`EXTRACTION_MODE` in `.env` controls this.

| Stage | Needs | When it is used |
|---|---|---|
| PDF text layer | nothing extra | A PDF produced by a computer. Exact and fast. |
| OCR | `tesseract.js` (installed by default) | Scans and photographs |
| AI | `ANTHROPIC_API_KEY` set | Images too poor for OCR to lay out as a table |

Each stage reports a confidence score. Below `EXTRACTION_CONFIDENCE_FLOOR`
(45 by default) the screen says plainly that the figures are a draft and should
be checked line by line.

If OCR or AI is unavailable the upload still succeeds — it simply asks you to
type the figures in, and says why.

Rasterising a scanned PDF for OCR additionally needs `@napi-rs/canvas`, which
is not installed by default:

```bash
npm install @napi-rs/canvas
```

Without it, scanned PDFs fall back to manual entry; photographs and image files
still go through OCR normally.

---

## The documents

Two downloads from any note:

- **`.docx`** — the approval note with every annexure.
- **`.zip`** — the same document, plus every original attachment in per-vendor
  folders, plus a `CONTENTS.txt` manifest.

The ZIP exists because a PDF cannot be embedded inside a Word file. Image
quotations *are* embedded in the document; PDF ones are referenced by name and
carried in the package.

---

## Tax rates

The rates in `src/tax.js` are **defaults to save typing, not authority**. They
change with each Finance Act, and the right section depends on the nature of
the supply. Every figure is editable in the accounts screen, and the system
says so on that screen.

The checks it does run:

- GSTIN check digit, and that its embedded PAN matches the PAN on record
- 206AA — rate raised to 20% where no PAN is on file
- 206AB — rate raised for a flagged non-filer
- 194Q against 206C(1H) — warns when both are set, as they are mutually exclusive
- warns when TDS has been computed on a GST-inclusive value
- duplicate payment — same vendor, near-identical amount, within 90 days

---

## Tests

```bash
npm test                      # 61 unit tests: money, GST, TDS/TCS, comparison, versions, parsing
npm run sample                # builds a sample .docx into ./sample-output
bash test/e2e.sh              # 32 API checks against a running server
bash test/e2e-versions.sh     # 26 API checks covering revised quotations
bash test/e2e-users.sh        # 24 API checks covering people, roles and passwords
node test/ui-check.mjs        # 26 browser checks (needs Chrome and puppeteer-core)
```

`SAMPLE_VENDORS=2 npm run sample` (or `=1`) builds the same note with fewer
offers, which is the quickest way to see the yellow and orange headings.

The unit tests check the arithmetic against three approval notes the office
issued by hand, so the figures can be compared line for line with what was
sent out.

---

## Layout

```
src/
  schema.sql          every table
  domain.js           money, amount in words, GSTIN/PAN, dates
  tax.js              GST split, TDS/TCS, payment schedule
  comparison.js       the four-axis ranking
  notes-repo.js       assembling a note, and whether it is ready to submit
  db.js               connection pool and transactions
  middleware.js       auth, uploads, errors, audit
  extract/
    heuristics.js     reading a quotation from text
    pdf.js            PDF text layer, row grouping, page rasterising
    ocr.js            tesseract.js, optional
    ai.js             AI reader, optional
    index.js          the fallback chain
  routes/             auth, masters, notes, quotations, accounts, documents
  doc/                the .docx: front page and annexures
public/               the browser application
test/                 unit, end-to-end and browser tests
```

---

## Moving it to a server

1. On a new, empty AppNote database, set a unique temporary `DEMO_PASSWORD`
   and run `npm run db:seed` once to create the initial administrator and
   accounts. This also adds demo users and master records; change the admin
   password and deactivate unused demo accounts before opening the app to staff.
   Do not run `db:reset` on a database containing data.
2. Set `APPNOTE_DB_URL` to an administrator connection for the one-time schema
   and seed setup. Run `npm run db:setup-fdw` with the three temporary FDW
   setup URLs described above. The script replaces `APPNOTE_DB_URL` in `.env`
   with the restricted AppNote login; the web app must run with that URL.
3. Set `NODE_ENV=production` and a real `SESSION_SECRET` — the server refuses
   to start in production without one. `PGSSL=require` is only needed when the
   AppNote connection is remote and configured for TLS.
4. Put it behind HTTPS. Session cookies are marked `secure` in production. If
   the trusted internal Nginx route is HTTP-only, set `SESSION_COOKIE_SECURE=false`
   explicitly; otherwise sign-in cookies will not be sent. HTTPS is preferred.
5. Move `UPLOAD_DIR` onto storage that is backed up — the attachments are the
   evidence behind every note.

---

## Known limits

- PDFs cannot be embedded in the Word file; the ZIP package carries them.
- Scanned-PDF OCR needs `@napi-rs/canvas` as described above.
- Uploads are stored on the local filesystem, not in object storage.
- Sessions are stored in the AppNote PostgreSQL database, so they survive a
  server restart and can be shared by multiple AppNote processes using the same
  database and `SESSION_SECRET`. They expire after the rolling inactivity
  period configured by `SESSION_HOURS` (12 hours by default).
