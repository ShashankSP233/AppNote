// Approval Note Generator — browser application.
//
// Plain ES modules, no build step, so this can be edited on the server and
// reloaded. The screen that matters most is the quotation review (tab 2 of a
// note): the attached copy on one side, the machine-read figures on the other,
// every field editable, and nothing leaves that screen until a person confirms
// it.

const api = {
  async call(path, { method = 'GET', body, form } = {}) {
    const options = { method, headers: {} };

    if (form) {
      options.body = form;
    } else if (body !== undefined) {
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(body);
    }

    const response = await fetch(`/api${path}`, options);
    const text = await response.text();
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch { payload = { error: text }; }

    if (!response.ok) {
      const error = new Error(payload?.error || `Request failed (${response.status})`);
      error.detail = payload?.detail;
      error.status = response.status;
      throw error;
    }
    return payload;
  },
  get(path) { return this.call(path); },
  post(path, body) { return this.call(path, { method: 'POST', body }); },
  put(path, body) { return this.call(path, { method: 'PUT', body }); },
  patch(path, body) { return this.call(path, { method: 'PATCH', body }); },
  del(path) { return this.call(path, { method: 'DELETE' }); },
  upload(path, form) { return this.call(path, { method: 'POST', form }); },
};

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const inr = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const inr0 = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });

const money = (value, decimals = 2) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return decimals === 0 ? inr0.format(n) : inr.format(n);
};

const qty = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return Number.isInteger(n) ? inr0.format(n) : n.toString();
};

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

const fmtDate = (value) => {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return `${String(d.getDate()).padStart(2, '0')}-${MONTHS[d.getMonth()]}-${d.getFullYear()}`;
};

const fmtDateTime = (value) => {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return `${fmtDate(value)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

const esc = (value) => String(value ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const bytes = (n) => {
  if (!n) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
};

const STATUS_LABEL = {
  draft: 'Draft',
  pending_check: 'With checkers',
  pending_verify: 'With verifiers',
  pending_accounts: 'With accounts',
  pending_approval: 'With approvers',
  on_hold: 'On hold',
  approved: 'Approved',
  rejected: 'Rejected',
  closed: 'Closed',
};

const STATUS_CLASS = {
  draft: 'draft',
  pending_check: 'pending', pending_verify: 'pending',
  pending_accounts: 'pending', pending_approval: 'pending',
  on_hold: 'hold', approved: 'approved', rejected: 'rejected', closed: 'draft',
};

/**
 * How much competition there was, which decides the heading colour on both the
 * screen and the printed note. Three or more offers is normal, two is thin,
 * one is a single-source purchase. Kept in step with headerTheme() in
 * src/doc/helpers.js — change both together.
 */
function offerLevel(note) {
  const count = note?.comparison?.rows?.length
    ?? (note?.quotations || []).filter((q) => !q.is_excluded && !q.is_superseded).length;

  if (count >= 3) return { key: 'competitive', count, label: `${count} offers compared` };
  if (count === 2) return { key: 'limited', count, label: 'Only two offers — three is the norm' };
  return { key: 'single', count, label: count === 1 ? 'Single offer — needs a written justification' : 'No offers yet' };
}

const statusBadge = (status, editRequestPending = false) =>
  `<span class="badge ${STATUS_CLASS[status] || 'draft'}">${esc(editRequestPending ? 'Edits required' : (STATUS_LABEL[status] || status))}</span>`;

const SOURCE_LABEL = {
  manual: 'Typed in', pdf_text: 'Read from PDF', ocr: 'Read by OCR', ai: 'Read by AI',
};

// ---------------------------------------------------------------------------
// Chrome
// ---------------------------------------------------------------------------

const state = {
  user: null,
  note: null,
  tab: 'details',
  reviewQuotationId: null,
  projects: [],
  vendors: [],
  reqflowProjects: [],
  users: [],
  taxCatalogue: null,
};

const el = (id) => document.getElementById(id);
const view = () => el('view');

function toast(message, kind = '') {
  const node = document.createElement('div');
  node.className = `toast ${kind}`;
  node.textContent = message;
  el('toasts').append(node);
  setTimeout(() => node.remove(), kind === 'bad' || kind === 'warn' ? 7000 : 3800);
}

function showError(error) {
  console.error(error);
  let message = error.message || 'Something went wrong.';
  if (error.detail?.blocking?.length) {
    message += ` — ${error.detail.blocking.join(' ')}`;
  }
  toast(message, 'bad');
}

function openModal(title, html) {
  el('modal-title').textContent = title;
  el('modal-body').innerHTML = html;
  el('modal').hidden = false;
}
function closeModal() { el('modal').hidden = true; el('modal').classList.remove('new-note-modal'); el('modal-body').innerHTML = ''; }

el('modal-close').addEventListener('click', closeModal);
el('modal').addEventListener('click', (event) => {
  if (event.target === el('modal')) closeModal();
});

function loading(message = 'Loading…') {
  view().innerHTML = `<div class="loading"><span class="spinner"></span> ${esc(message)}</div>`;
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

function go(hash) {
  if (location.hash === hash) route();
  else location.hash = hash;
}

async function route() {
  if (!state.user) return;

  const hash = location.hash.slice(1) || 'notes';
  const [section, id, sub] = hash.split('/');

  try {
    if (section === 'notes' && id) {
      await renderNote(Number(id), sub);
    } else if (section === 'inbox') {
      await renderList({ inbox: true });
    } else if (section === 'masters') {
      await renderMasters();
    } else {
      await renderList({});
    }
  } catch (error) {
    showError(error);
    view().innerHTML = `<div class="empty"><h3>That did not load</h3><p>${esc(error.message)}</p>
      <button class="btn" onclick="location.hash='notes'">Back to the list</button></div>`;
  }
}

window.addEventListener('hashchange', route);

document.querySelectorAll('[data-nav]').forEach((node) => {
  node.addEventListener('click', () => {
    const target = node.dataset.nav;
    go(target === 'list' ? '#notes' : `#${target}`);
  });
});

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

el('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = new FormData(event.target);
  const errorNode = el('login-error');
  errorNode.hidden = true;

  try {
    const result = await api.post('/auth/login', {
      username: form.get('username'),
      password: form.get('password'),
    });
    state.user = result.user;
    await start();
  } catch (error) {
    errorNode.textContent = error.message;
    errorNode.hidden = false;
  }
});

el('change-password').addEventListener('click', changePasswordDialog);

el('logout').addEventListener('click', async () => {
  await api.post('/auth/logout').catch(() => {});
  location.reload();
});

async function start() {
  el('login').hidden = true;
  el('app').hidden = false;
  el('who-name').textContent = state.user.full_name;
  el('who-role').textContent = state.user.role;

  await Promise.all([
    api.get('/projects').then((r) => { state.projects = r.projects; }).catch(() => {}),
    api.get('/integrations/siteerp/vendors').then((r) => { state.vendors = r.vendors; }).catch(() => {}),
    api.get('/auth/users').then((r) => { state.users = r.users; }).catch(() => {}),
    api.get('/tax/sections').then((r) => { state.taxCatalogue = r; }).catch(() => {}),
  ]);

  refreshInboxCount();
  await route();

  // Anyone still on a password that was given to them is told so at every
  // sign-in, which is the right amount of pressure: visible, not blocking.
  if (!state.user.password_changed_at) {
    toast('You are still using the password you were given. Use "Change password" above to set your own.', 'bad');
  }
}

async function refreshInboxCount() {
  try {
    const { notes } = await api.get('/notes/inbox');
    const badge = el('inbox-count');
    badge.textContent = notes.length;
    badge.hidden = notes.length === 0;
  } catch { /* not critical */ }
}

// ---------------------------------------------------------------------------
// Note list
// ---------------------------------------------------------------------------

async function renderList({ inbox = false }) {
  loading();

  const { notes } = inbox
    ? await api.get('/notes/inbox')
    : await api.get('/notes?limit=100');

  const canCreate = ['preparer', 'checker', 'verifier', 'accounts', 'approver', 'admin'].includes(state.user.role);

  view().innerHTML = `
    <div class="toolbar">
      <h1>${inbox ? 'Waiting on you' : 'Approval notes'}</h1>
      <div class="spacer"></div>
      ${inbox ? '' : '<input type="search" id="search" placeholder="Search subject or number…">'}
      ${canCreate ? '<button class="btn primary" id="new-note">New note</button>' : ''}
    </div>
    <div class="card">
      <div class="card-body tight" id="list-body">${listTable(notes, inbox)}</div>
    </div>`;

  el('new-note')?.addEventListener('click', newNoteDialog);

  el('search')?.addEventListener('input', debounce(async (event) => {
    const q = event.target.value.trim();
    const result = await api.get(`/notes?limit=100${q ? `&q=${encodeURIComponent(q)}` : ''}`);
    el('list-body').innerHTML = listTable(result.notes, false);
    wireRows();
  }, 250));

  wireRows();
}

function wireRows() {
  view().querySelectorAll('tr[data-id]').forEach((tr) => {
    tr.addEventListener('click', () => go(`#notes/${tr.dataset.id}`));
  });
}

function listTable(notes, inbox) {
  if (!notes.length) {
    return `<div class="empty">
      <h3>${inbox ? 'Nothing is waiting on you' : 'No notes yet'}</h3>
      <p>${inbox ? 'Notes appear here when they reach your stage.' : 'Create the first approval note to get started.'}</p>
    </div>`;
  }

  return `<table class="data">
    <thead><tr>
      <th>Number</th><th>Reqflow requisition</th><th>Date</th><th>Subject</th><th>Project</th>
      <th>Vendor</th><th class="right">Value</th><th>Quotes</th><th>Status</th>
    </tr></thead>
    <tbody>${notes.map((note) => `
      <tr data-id="${note.id}" class="clickable">
        <td class="mono nowrap">${esc(note.note_no || `#${note.id}`)}</td>
        <td class="mono nowrap">${esc(note.requisition_no || '—')}</td>
        <td class="nowrap">${fmtDate(note.note_date)}</td>
        <td>${esc(truncate(note.subject, 70))}
          ${Number(note.unreviewed_count) > 0
            ? `<br><span class="badge bad">${note.unreviewed_count} unconfirmed quotation(s)</span>`
            : ''}</td>
        <td>${esc(note.project_name || '—')}</td>
        <td>${esc(note.selected_vendor || '—')}</td>
        <td class="num">${money(note.basic_amount, 0)}</td>
        <td class="center">${note.quotation_count}</td>
        <td>${statusBadge(note.status, note.edit_request_pending)}</td>
      </tr>`).join('')}
    </tbody></table>`;
}

const truncate = (value, length) => {
  const s = String(value || '');
  return s.length > length ? `${s.slice(0, length - 1)}…` : s;
};

function debounce(fn, ms) {
  let timer;
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
}

async function newNoteDialog() {
  try {
    const { projects } = await api.get('/integrations/reqflow/projects');
    state.reqflowProjects = projects;
  } catch (error) {
    showError(error);
    return;
  }

  openModal('New approval note', `
    <form id="new-note-form" class="new-note-form">
      <div class="field"><label for="new-note-number">Approval note number</label>
        <input id="new-note-number" name="note_no" required maxlength="160" autocomplete="off"
          placeholder="e.g. YG/Port/26-27/November/3">
        <small>Enter the number approved for this note. The format is flexible, but it must be unique.</small>
      </div>
      <div class="field new-note-subject"><span>Subject</span>
        <textarea name="subject" required placeholder="Requirement of … for our vessel … at …"></textarea>
        <small>Write a short title that explains what approval is needed.</small>
      </div>
      <section class="req-picker" aria-labelledby="req-picker-title">
        <div class="req-picker-heading">
          <div><h3 id="req-picker-title">Reqflow requisition <span class="req-required">Required · Annexure A</span></h3>
            <p>Search and select the requisition this approval note will cover.</p></div>
        </div>
        <div class="field req-search-field"><label for="req-search">Search requisitions</label>
          <input id="req-search" type="search" placeholder="Number, item, purpose or site…" autocomplete="off">
        </div>
        <div class="req-filters">
          <div class="field"><label for="req-status">Status</label><select id="req-status"><option value="" selected>All statuses</option></select></div>
          <div class="field"><label for="req-project">Project</label><select id="req-project"><option value="">All projects</option>
          ${state.reqflowProjects.map((p) => `<option value="${esc(p.source_id)}">${esc(p.name)}</option>`).join('')}
        </select></div>
          <div class="field"><label for="req-sort">Sort by</label><select id="req-sort">
          <option value="updated">Recently updated</option><option value="date">Requisition date</option>
          <option value="reference">Requisition number</option><option value="project">Project</option>
          <option value="status">Status</option>
        </select></div>
          <div class="field"><label for="req-direction">Order</label><select id="req-direction">
          <option value="desc">Descending</option><option value="asc">Ascending</option>
        </select></div>
        </div>
        <div class="req-results-panel">
          <div class="req-results-heading"><strong>Matching requisitions</strong><span class="req-page-count" id="req-page">Loading…</span></div>
          <select id="req-results" name="source_requisition_id" class="req-results" required size="7">
            <option value="">Loading live Reqflow data…</option>
          </select>
          <div class="req-pagination">
            <button type="button" class="btn small" id="req-prev">Previous</button>
            <button type="button" class="btn small" id="req-next">Next</button>
            <span class="spacer"></span><button type="button" class="btn small ghost" id="req-refresh">Refresh list</button>
          </div>
        </div>
        <div id="req-selected-project" class="req-selected-card" hidden></div>
        <p class="req-help">New Reqflow requisitions appear when you refresh. Check the status before choosing; approval notes should normally use an approved requisition.</p>
      </section>
      <div class="field"><span>Item description (printed on the front page)</span>
        <textarea name="item_description" placeholder="We need … We have received quotes from … The detail is as under."></textarea>
        <small>Describe the items or work being considered for approval.</small>
      </div>
      <div class="new-note-actions"><span class="muted">You can add quotations and assessment details after creating the note.</span>
        <button class="btn primary" type="submit">Create approval note</button></div>
    </form>`);
  el('modal').classList.add('new-note-modal');

  const pageSize = 50;
  let offset = 0;
  let total = 0;
  let latestRequest = 0;
  const statusSelect = el('req-status');
  const results = el('req-results');
  const search = el('req-search');
  const queryRows = async () => {
    const requestNumber = ++latestRequest;
    const params = new URLSearchParams({
      q: search.value.trim(), status: statusSelect.value,
      project_id: el('req-project').value, sort: el('req-sort').value,
      direction: el('req-direction').value, limit: String(pageSize), offset: String(offset),
    });
    results.innerHTML = '<option value="">Loading…</option>';
    el('req-page').textContent = 'Loading…';
    try {
      const data = await api.get(`/integrations/reqflow/requisitions?${params}`);
      if (requestNumber !== latestRequest) return;
      total = data.total;
      const currentStatus = statusSelect.value;
      statusSelect.innerHTML = `<option value="">All statuses</option>${data.statuses.map((s) => `<option value="${esc(s)}">${esc(s.replaceAll('_', ' '))}</option>`).join('')}`;
      if ([...statusSelect.options].some((o) => o.value === currentStatus)) statusSelect.value = currentStatus;
      else {
        statusSelect.value = '';
        if (currentStatus) { offset = 0; return queryRows(); }
      }
      if (offset >= total && offset > 0) { offset = Math.max(0, Math.floor((total - 1) / pageSize) * pageSize); return queryRows(); }
      results.innerHTML = data.requisitions.length
        ? `<option value="">Choose a requisition…</option>${data.requisitions.map((r) => {
          const requisitionStatus = String(r.source_status || 'unknown');
          return `<option value="${esc(r.source_id)}" data-project="${esc(r.project_name || r.site_name || 'No project')}" data-reference="${esc(r.ref_number)}" data-status="${esc(requisitionStatus)}" data-items="${r.item_count}">${esc(r.ref_number)} · ${esc(r.project_name || r.site_name || 'No project')} · ${esc(requisitionStatus.replaceAll('_', ' '))} · ${fmtDate(r.requisition_date)} · ${r.item_count} item(s)</option>`;
        }).join('')}`
        : '<option value="">No requisitions match these filters.</option>';
      el('req-page').textContent = total ? `${offset + 1}–${Math.min(offset + pageSize, total)} of ${total}` : '0 requisitions';
      el('req-prev').disabled = offset === 0;
      el('req-next').disabled = offset + pageSize >= total;
      showSelectedProject();
    } catch (error) {
      if (requestNumber !== latestRequest) return;
      results.innerHTML = '<option value="">Could not load Reqflow requisitions.</option>';
      el('req-page').textContent = 'Connection error';
      showError(error);
    }
  };
  const showSelectedProject = () => {
    const option = results.selectedOptions[0];
    const holder = el('req-selected-project');
    if (!option?.value) { holder.hidden = true; holder.textContent = ''; return; }
    holder.hidden = false;
    holder.innerHTML = `<span class="req-selected-check">✓</span><div class="req-selected-copy"><small>Selected requisition</small><strong>${esc(option.dataset.reference || option.textContent.split(' · ')[0])}</strong><span>${esc(option.dataset.project || 'No project')} · ${esc(option.dataset.items || '0')} item(s)</span></div><span class="badge ${option.dataset.status === 'approved' ? 'approved' : 'draft'}">${esc((option.dataset.status || '').replaceAll('_', ' '))}</span>`;
  };
  const debouncedSearch = debounce(() => { offset = 0; queryRows(); }, 300);
  search.addEventListener('input', debouncedSearch);
  for (const id of ['req-status', 'req-project', 'req-sort', 'req-direction']) {
    el(id).addEventListener('change', () => { offset = 0; queryRows(); });
  }
  results.addEventListener('change', showSelectedProject);
  el('req-prev').addEventListener('click', () => { offset = Math.max(0, offset - pageSize); queryRows(); });
  el('req-next').addEventListener('click', () => { if (offset + pageSize < total) { offset += pageSize; queryRows(); } });
  el('req-refresh').addEventListener('click', queryRows);
  queryRows();

  el('new-note-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = Object.fromEntries(new FormData(event.target));
    try {
      const { note } = await api.post('/notes', form);
      closeModal();
      toast('Note created.', 'good');
      go(`#notes/${note.id}`);
    } catch (error) { showError(error); }
  });
}

// ---------------------------------------------------------------------------
// A single note
// ---------------------------------------------------------------------------

async function renderNote(id, tab) {
  loading('Loading the note…');
  const { note } = await api.get(`/notes/${id}`);
  state.note = note;
  state.tab = tab || 'details';

  const unconfirmed = note.quotations.filter((q) => q.extraction_status === 'extracted').length;
  const unverifiedTax = note.items.filter((i) => !i.tax_verified).length;

  // Table headings take their colour from how many vendors actually quoted,
  // matching the printed document so the screen carries the same warning.
  const offers = offerLevel(note);
  view().dataset.offers = offers.key;

  const tabs = [
    { key: 'details', label: 'Details' },
    { key: 'quotations', label: 'Quotations', count: note.quotations.length, alert: unconfirmed > 0 },
    { key: 'compare', label: 'Comparison' },
    { key: 'items', label: 'Priced schedule', count: note.items.length },
    { key: 'accounts', label: 'Accounts', alert: unverifiedTax > 0 && note.items.length > 0 },
    { key: 'schedule', label: 'Payment schedule', count: note.milestones.length },
    { key: 'workflow', label: 'Workflow' },
  ];

  view().innerHTML = `
    <div class="toolbar">
      <button class="btn ghost small" onclick="location.hash='notes'">← All notes</button>
      <h1 style="margin:0">${esc(note.note_no || `Note #${note.id}`)}</h1>
      ${statusBadge(note.status, note.edit_request_pending)}
      <div class="spacer"></div>
      <a class="btn" href="/api/notes/${note.id}/document" download>Download .docx</a>
      <a class="btn" href="/api/notes/${note.id}/package" download>Download package (.zip)</a>
    </div>

    <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:-8px 0 14px">
      <p class="muted" style="margin:0;flex:1;min-width:240px">${esc(note.subject || '')}</p>
      <span class="offer-key" title="Table headings are coloured by how many vendors quoted">
        <span class="swatch"></span>${esc(offers.label)}</span>
    </div>

    ${readinessBanner(note)}

    <div class="tabs">${tabs.map((t) => `
      <button class="tab ${state.tab === t.key ? 'active' : ''}" data-tab="${t.key}">
        ${esc(t.label)}${t.count !== undefined ? `<span class="count">${t.count}</span>` : ''}${t.alert ? '<span class="dot"></span>' : ''}
      </button>`).join('')}</div>

    <div id="tab-body"></div>`;

  view().querySelectorAll('[data-tab]').forEach((button) => {
    button.addEventListener('click', () => go(`#notes/${note.id}/${button.dataset.tab}`));
  });

  renderTab();
}

function readinessBanner(note) {
  const { blocking, advisory } = note.readiness;
  let html = '';

  if (note.edit_request_pending) {
    html += `<div class="notice warn"><strong>Edits required before approval can continue</strong>
      <p>${esc(note.edit_request.request_text)}</p>
      <p class="muted">Requested by ${esc(note.edit_request.requested_by_name)} (${esc(note.edit_request.requested_by_role)}) on ${fmtDateTime(note.edit_request.requested_at)}. Update the note, then resubmit it for every approval stage.</p></div>`;
  }

  if (blocking.length) {
    html += `<div class="notice warn"><strong>This note cannot be submitted yet</strong>
      <ul>${blocking.map((item) => `<li>${esc(item)}</li>`).join('')}</ul></div>`;
  } else if (note.status === 'draft') {
    html += `<div class="notice good"><strong>Ready to submit</strong>
      Everything required is in place.</div>`;
  }

  if (advisory.length) {
    html += `<div class="notice amber"><strong>Worth a look before you send it</strong>
      <ul>${advisory.map((item) => `<li>${esc(item)}</li>`).join('')}</ul></div>`;
  }

  return html;
}

function renderTab() {
  const body = el('tab-body');
  const note = state.note;

  const renderers = {
    details: detailsTab,
    quotations: quotationsTab,
    compare: compareTab,
    items: itemsTab,
    accounts: accountsTab,
    schedule: scheduleTab,
    workflow: workflowTab,
  };

  body.innerHTML = (renderers[state.tab] || detailsTab)(note);
  (WIRE[state.tab] || (() => {}))(note);
}

const WIRE = {};

async function reload() {
  const { note } = await api.get(`/notes/${state.note.id}`);
  state.note = note;
  await renderNote(note.id, state.tab);
  refreshInboxCount();
}

const editable = (note) => ['draft', 'on_hold', 'rejected'].includes(note.status)
  && (state.user.role === 'admin' || note.prepared_by === state.user.id);

// --- Details ---------------------------------------------------------------

function detailsTab(note) {
  const locked = !editable(note);
  const t = note.totals;

  return `
  <div class="grid-side">
    <div>
      <div class="card">
        <header><h2>Note details</h2>${locked ? '<span class="spacer"></span><span class="muted">Read only at this stage</span>' : ''}</header>
        <div class="card-body">
          <form id="details-form" ${locked ? 'inert' : ''}>
            <div class="field"><label for="note-number">Approval note number</label>
              <input id="note-number" name="note_no" value="${esc(note.note_no || '')}" required maxlength="160" autocomplete="off">
              <small>Use the number approved for this note. It can be changed while the note is editable.</small>
            </div>
            <div class="field"><span>Subject</span>
              <textarea name="subject">${esc(note.subject)}</textarea></div>
            <div class="field"><span>Item description</span>
              <textarea name="item_description">${esc(note.item_description || '')}</textarea></div>
            <div class="field-row">
              <div class="field"><span>Project</span>
                ${note.requisition_source === 'reqflow'
                  ? `<input value="${esc(note.project_name || 'Project from Reqflow')}" disabled>`
                  : `<select name="project_id">${state.projects.map((p) => `<option value="${p.id}" ${p.id === note.project_id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>`}</div>
              <div class="field"><span>Note date</span>
                <input type="date" name="note_date" value="${esc((note.note_date || '').slice(0, 10))}"></div>
              <div class="field"><span>Status label</span>
                <select name="status_label">
                  ${['Live', 'Active', 'Closed'].map((s) => `<option ${note.status_label === s ? 'selected' : ''}>${s}</option>`).join('')}
                </select></div>
            </div>
            <h4 style="margin-top:18px">Terms printed on the front page</h4>
            <div class="field-row">
              <div class="field"><span>Mode of payment</span>
                <input name="mode_of_payment" value="${esc(note.mode_of_payment || 'NEFT/RTGS')}"></div>
              <div class="field"><span>Transport charges</span>
                <input name="transport_charges" value="${esc(note.transport_charges || '')}" placeholder="Extra (at actuals)"></div>
            </div>
            <div class="field"><span>Payment terms</span>
              <input name="payment_terms" value="${esc(note.payment_terms || '')}" placeholder="50% advance along with PO and balance 50% against proforma invoice"></div>
            <div class="field"><span>Delivery / dispatch</span>
              <input name="delivery_terms" value="${esc(note.delivery_terms || '')}" placeholder="Within 10 days from receipt of payment"></div>
            ${locked ? '' : '<button class="btn primary" type="submit">Save</button>'}
          </form>
        </div>
      </div>

      <div class="card">
        <header><h3>Requisition — Annexure A</h3></header>
        <div class="card-body">
          ${note.requisition_id || (note.requisition_source === 'reqflow' && note.requisition_source_id) ? `
            ${note.requisition_source_unavailable ? '<div class="notice warn">Reqflow is unavailable. Requisition details could not be loaded.</div>' : ''}
            <div class="field-row">
              <div><span class="muted">${note.requisition_source === 'reqflow' ? 'Reqflow number' : 'Number'}</span><br>${esc(note.requisition_no || '—')}</div>
              <div><span class="muted">Raised on</span><br>${fmtDate(note.requisition_raised_on)}</div>
              <div><span class="muted">Raised by</span><br>${esc(note.requisition_raised_by || '—')}</div>
              <div><span class="muted">Vessel</span><br>${esc(note.requisition_vessel || '—')}</div>
            </div>
            <p style="margin-top:10px">${esc(note.requisition_purpose || '')}</p>
            ${note.requisition_items.length ? `<table class="data"><thead><tr>
              <th>#</th><th>Description</th><th>Specification</th><th class="right">Qty</th><th>Unit</th>
            </tr></thead><tbody>${note.requisition_items.map((item) => `<tr>
              <td>${item.line_no}</td><td>${esc(item.description)}</td>
              <td class="muted">${esc(item.specification || item.part_no || '—')}</td>
              <td class="num">${qty(item.quantity)}</td><td>${esc(item.unit || '')}</td>
            </tr>`).join('')}</tbody></table>` : '<p class="muted">No lines on the requisition.</p>'}
          ` : '<div class="notice warn">No requisition is linked. A requisition is required and becomes Annexure A.</div>'}
        </div>
      </div>
    </div>

    <div>
      <div class="card">
        <header><h3>Figures</h3></header>
        <div class="figures">
          <div class="figure"><div class="label">Basic</div><div class="value small">${money(t.basic)}</div></div>
          <div class="figure"><div class="label">GST</div><div class="value small">${money(t.gstTotal)}</div></div>
          <div class="figure accent"><div class="label">Grand total</div><div class="value">${money(t.grandTotal, 0)}</div></div>
          ${note.deductions.tds.applicable || note.deductions.tcs.applicable ? `
            <div class="figure good"><div class="label">Net payable</div><div class="value">${money(note.deductions.netPayable, 0)}</div></div>` : ''}
        </div>
      </div>

      <div class="card">
        <header><h3>Selected vendor</h3></header>
        <div class="card-body">
          ${note.selected_quotation ? `
            <b>${esc(note.selected_quotation.vendor_name)}</b><br>
            <span class="mono muted">${esc(note.selected_quotation.vendor_gstin || 'No GSTIN on record')}</span>
            <p style="margin-top:9px">${esc(note.selection_reason || '')}</p>
            ${note.comparison_summary?.selectedPriceComparable
              ? (note.comparison_summary.selectedIsLowest
                ? '<span class="badge good">Lowest offer</span>'
                : `<div class="notice amber" style="margin:0">Not the lowest offer — ₹${money(note.comparison_summary.premium)} above ${esc(note.comparison_summary.lowestName)}.</div>`)
              : '<div class="notice amber" style="margin:0">Price comparison is incomplete; the selected offer has no comparable quoted total.</div>'}
          ` : '<p class="muted">No vendor selected yet. Choose one on the Comparison tab.</p>'}
        </div>
      </div>

      ${annexureCard(note)}
    </div>
  </div>`;
}

function annexureCard(note) {
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const plan = ['Requisition', 'Comparative statement'];
  if (note.milestones.length) plan.push('Payment schedule');
  const sorted = [...note.quotations].sort((a, b) => {
    if (a.id === note.selected_quotation_id) return -1;
    if (b.id === note.selected_quotation_id) return 1;
    return a.position - b.position;
  });
  for (const q of sorted) plan.push(`Quotation — ${q.vendor_name}`);

  return `<div class="card">
    <header><h3>Annexures</h3></header>
    <div class="card-body">
      <ol style="margin:0;padding-left:0;list-style:none">
        ${plan.map((title, index) => `<li style="padding:3px 0">
          <b>${letters[index]}</b> &nbsp;${esc(title)}</li>`).join('')}
      </ol>
      <p class="muted" style="margin-top:9px">PDF attachments cannot sit inside a Word file, so the ZIP package carries the originals alongside the document.</p>
    </div>
  </div>`;
}

WIRE.details = (note) => {
  el('details-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = Object.fromEntries(new FormData(event.target));
    try {
      await api.patch(`/notes/${note.id}`, form);
      toast('Saved.', 'good');
      await reload();
    } catch (error) { showError(error); }
  });
};

// --- Quotations: upload and the review screen ------------------------------

function quotationsTab(note) {
  const locked = !editable(note);
  const reviewing = state.reviewQuotationId
    ? note.quotations.find((q) => q.id === state.reviewQuotationId)
    : null;

  if (reviewing) return reviewScreen(note, reviewing);

  return `
  ${locked ? '' : `
  <div class="card">
    <header><h2>Add a quotation</h2></header>
    <div class="card-body">
      <div class="dropzone" id="dropzone">
        <b>Drop the quotation here, or click to choose files</b>
        PDF, photograph or scan. Several pages of the same quotation can go together.
        <input type="file" id="file-input" multiple hidden
               accept=".pdf,.png,.jpg,.jpeg,.webp,.bmp,.tif,.tiff,.doc,.docx,.xls,.xlsx">
      </div>
      <div id="pending-files"></div>
      <div class="field-row" style="margin-top:12px">
        <div class="field"><span>Vendor name (optional — leave blank to read it from the PDF)</span>
          <input id="up-vendor" list="vendor-list" placeholder="M/s …">
          <datalist id="vendor-list">
            ${state.vendors.map((v) => `<option value="${esc(v.name)}">`).join('')}
          </datalist></div>
        <div class="field"><span>GSTIN (optional)</span><input id="up-gstin" placeholder="27ABCDE1234F1Z5"></div>
      </div>
      <button class="btn primary" id="upload-btn">Upload and read</button>
      <span class="muted" id="upload-status" style="margin-left:9px"></span>
      <p class="muted">Choose a SiteERP suggestion or type any vendor name. Leave blank to use the name read from the quotation. SiteERP is only updated if you later select this vendor and the quotation includes a GSTIN or PAN.</p>
    </div>
  </div>`}

  <div class="card">
    <header><h2>Quotations on this note</h2>
      <span class="spacer"></span>
      <span class="muted">Every one of these becomes an annexure</span>
    </header>
    <div class="card-body tight">
      ${note.quotations.length ? `<table class="data">
        <thead><tr>
          <th>Vendor</th><th>Ref / date</th><th class="right">Basic</th><th class="right">Landed</th>
          <th>Delivery</th><th>Payment</th><th>Read by</th><th>Confirmed</th><th></th>
        </tr></thead>
        <tbody>${note.quotations.map((q) => {
          const comparisonRow = note.comparison.rows.find((r) => r.quotation_id === q.id);
          const confirmed = q.extraction_status === 'reviewed' || q.source === 'manual';
          return `<tr class="${q.extraction_status === 'extracted' ? 'needs-review' : ''}">
            <td><b>${esc(q.vendor_name)}</b>
              ${q.vendor_source_active === false ? ' <span class="badge hold">SiteERP vendor inactive</span>' : ''}
              ${(q.version_count || 1) > 1 ? ` <span class="badge hold" title="Revised ${q.version_count - 1} time(s)">v${q.version_no}</span>` : ''}
              ${q.id === note.selected_quotation_id ? ' <span class="badge good">Selected</span>' : ''}
              ${q.is_excluded ? ' <span class="badge bad">Excluded</span>' : ''}
              <br><span class="mono muted">${esc(q.vendor_gstin || '—')}</span>
              ${(q.history || []).length ? `<br><button class="btn small ghost" data-history="${q.id}" style="padding:1px 5px;font-size:11px">${q.history.length} earlier version(s)</button>` : ''}</td>
            <td>${esc(q.quotation_ref || '—')}<br><span class="muted">${fmtDate(q.quotation_date)}</span></td>
            <td class="num">${comparisonRow ? (comparisonRow.cost.basic !== null ? money(comparisonRow.cost.basic) : '—') : (q.quoted_basic !== null ? money(q.quoted_basic) : '—')}</td>
            <td class="num"><b>${comparisonRow ? (comparisonRow.cost.hasComparableValue ? money(comparisonRow.cost.landed) : '—') : '—'}</b>
              ${comparisonRow?.negotiated > 0 ? `<br><span class="badge good" title="Reduced from the first offer">−${money(comparisonRow.negotiated, 0)}</span>` : ''}
              ${comparisonRow?.price_rank ? `<br><span class="badge ${comparisonRow.price_rank === 1 ? 'l1' : 'draft'}">L${comparisonRow.price_rank}</span>` : ''}</td>
            <td>${q.delivery_days !== null ? `${q.delivery_days} days` : esc(truncate(q.delivery_text, 22) || '—')}</td>
            <td>${esc(truncate(q.payment_terms_text, 26) || '—')}</td>
            <td><span class="muted">${esc(SOURCE_LABEL[q.source] || q.source)}</span>
              ${q.extraction_confidence !== null ? `<br>${confidenceBar(q.extraction_confidence)}` : ''}</td>
            <td>${confirmed
              ? '<span class="badge approved">Yes</span>'
              : '<span class="badge bad">Not yet</span>'}</td>
            <td class="shrink">
              <button class="btn small" data-review="${q.id}">${confirmed ? 'Edit' : 'Review'}</button>
              ${locked ? '' : `<button class="btn small" data-revise="${q.id}" title="The vendor has sent a revised offer">Revise</button>`}
              ${locked ? '' : `<button class="btn small danger" data-delete-quote="${q.id}">✕</button>`}
            </td>
          </tr>`;
        }).join('')}</tbody></table>`
      : '<div class="empty"><h3>No quotations yet</h3><p>Upload the first one above.</p></div>'}
    </div>
  </div>`;
}

function confidenceBar(confidence) {
  const level = confidence >= 75 ? 'high' : confidence >= 50 ? 'mid' : 'low';
  return `<div class="confidence-bar" title="Extraction confidence ${confidence}%">
    <i class="${level}" style="width:${Math.max(4, confidence)}%"></i></div>
    <span class="muted" style="font-size:11px">${confidence}%</span>`;
}

/**
 * The review screen. Attached copy on the left, every read field on the right,
 * all of it editable. This is the manual intervention the business asked for:
 * extraction proposes, a person disposes.
 */
function reviewScreen(note, q) {
  const locked = !editable(note);
  const warnings = (q.extraction_notes || '').split('\n').filter(Boolean);
  const file = (q.files || [])[0];

  return `
  <div class="toolbar">
    <button class="btn ghost small" id="back-to-quotes">← Back to the list</button>
    <h2 style="margin:0">${esc(q.vendor_name)}</h2>
    ${q.vendor_source_active === false ? '<span class="badge hold">SiteERP vendor inactive</span>'
      : q.vendor_source_id ? '<span class="badge approved">SiteERP linked</span>' : '<span class="badge hold">Not in SiteERP yet</span>'}
    ${q.extraction_status === 'reviewed'
      ? '<span class="badge approved">Confirmed</span>'
      : '<span class="badge bad">Not yet confirmed</span>'}
    <div class="spacer"></div>
    ${locked ? '' : `<button class="btn" id="reextract">Read it again</button>`}
  </div>

  ${!q.vendor_source_id ? '<div class="notice">SiteERP is optional. Keep the vendor name from the quotation or type it here; this will not block confirmation.</div>' : ''}

  ${q.extraction_status === 'extracted' ? `<div class="notice amber">
    <strong>Check these figures against the copy before you confirm</strong>
    They were ${esc((SOURCE_LABEL[q.source] || q.source).toLowerCase())}${q.extraction_confidence !== null ? ` with ${q.extraction_confidence}% confidence` : ''}.
    Nothing here is trusted until you confirm it, and the note cannot be submitted while any quotation is unconfirmed.
  </div>` : ''}

  ${warnings.length ? `<div class="notice warn">
    <strong>What the reader could not settle</strong>
    <ul>${warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></div>` : ''}

  <div class="review-split">
    <div class="doc-preview">
      <header>
        <span>${esc(file ? file.original_name : 'No copy attached')}</span>
        <span class="spacer"></span>
        ${file ? `<a class="btn ghost small" href="/api/files/${file.id}?download=1" download style="color:#cfd8e3">Download</a>` : ''}
      </header>
      ${filePreview(file)}
      ${(q.files || []).length > 1 ? `<div style="padding:8px 12px;background:#1f2731">
        ${q.files.map((f, i) => `<a class="btn ghost small" href="/api/files/${f.id}" target="_blank" style="color:#cfd8e3">Page ${i + 1}</a>`).join(' ')}
      </div>` : ''}
    </div>

    <div>
      <div class="card">
        <header><h3>Header read from the quotation</h3></header>
        <div class="card-body">
          <form id="quote-form" ${locked ? 'inert' : ''}>
            <div class="field-row">
              <div class="field"><span>Vendor from quotation / SiteERP</span>
                <input id="review-vendor" name="vendor_name" list="review-vendor-list" value="${esc(q.vendor_name)}">
                <datalist id="review-vendor-list">${state.vendors.map((v) => `<option value="${esc(v.name)}">`).join('')}</datalist>
                <small class="muted">Choose a SiteERP suggestion or keep/type the vendor name from the quotation. An ERP match is optional.</small>
              </div>
              <div class="field"><span>City</span><input name="vendor_city" value="${esc(q.vendor_city || '')}"></div>
            </div>
            <div class="field-row">
              <div class="field"><span>GSTIN</span><input name="vendor_gstin" value="${esc(q.vendor_gstin || '')}" class="mono"></div>
              <div class="field"><span>PAN</span><input name="vendor_pan" value="${esc(q.vendor_pan || '')}" class="mono"></div>
            </div>
            <div class="field-row">
              <div class="field"><span>Quotation ref.</span><input name="quotation_ref" value="${esc(q.quotation_ref || '')}"></div>
              <div class="field"><span>Dated</span><input type="date" name="quotation_date" value="${esc((q.quotation_date || '').slice(0, 10))}"></div>
              <div class="field"><span>Validity (days)</span><input type="number" name="validity_days" value="${q.validity_days ?? ''}"></div>
            </div>

            <h4 style="margin-top:16px">Delivery</h4>
            <div class="field-row">
              <div class="field"><span>Delivery (days)</span><input type="number" name="delivery_days" value="${q.delivery_days ?? ''}"></div>
              <div class="field"><span>Basis</span><input name="delivery_basis" value="${esc(q.delivery_basis || '')}" placeholder="FOR site / ex-works"></div>
            </div>
            <div class="field"><span>Delivery as written on the quotation</span>
              <input name="delivery_text" value="${esc(q.delivery_text || '')}"></div>

            <h4 style="margin-top:16px">Payment terms</h4>
            <div class="field-row">
              <div class="field"><span>Advance %</span><input type="number" step="0.01" name="advance_percent" value="${q.advance_percent ?? ''}"></div>
              <div class="field"><span>Credit days</span><input type="number" name="credit_days" value="${q.credit_days ?? ''}"></div>
              <div class="field"><span>Retention %</span><input type="number" step="0.01" name="retention_percent" value="${q.retention_percent ?? ''}"></div>
              <div class="field"><span>Retention release (days after delivery)</span><input type="number" min="0" name="retention_release_days" value="${q.retention_release_days ?? ''}"></div>
            </div>
            <div class="field"><span>Terms as written</span>
              <input name="payment_terms_text" value="${esc(q.payment_terms_text || '')}"></div>

            <h4 style="margin-top:16px">Commercials</h4>
            <div class="field-row">
              <div class="field"><span>Discount ₹</span><input type="number" step="0.01" name="discount_amount" value="${q.discount_amount ?? 0}"></div>
              <div class="field"><span>Freight ₹</span><input type="number" step="0.01" name="freight_amount" value="${q.freight_amount ?? 0}"></div>
              <div class="field"><span>Other ₹</span><input type="number" step="0.01" name="other_charges" value="${q.other_charges ?? 0}"></div>
              <div class="field"><span>GST %</span><input type="number" step="0.01" name="gst_rate" value="${q.gst_rate ?? ''}"></div>
            </div>
            <div class="field-row">
              <div class="field"><span>Basic as printed ₹</span><input type="number" step="0.01" name="quoted_basic" value="${q.quoted_basic ?? ''}"></div>
              <div class="field"><span>Total as printed ₹</span><input type="number" step="0.01" name="quoted_total" value="${q.quoted_total ?? ''}"></div>
            </div>
            <div class="field"><span>Warranty</span><input name="warranty_text" value="${esc(q.warranty_text || '')}"></div>
            <div class="field"><span>Remarks</span><input name="remarks" value="${esc(q.remarks || '')}"></div>
            ${locked ? '' : '<button class="btn" type="submit">Save header</button>'}
          </form>
        </div>
      </div>
    </div>
  </div>

  <div class="card">
    <header><h3>Lines read from the quotation</h3>
      <span class="spacer"></span>
      ${locked ? '' : '<button class="btn small" id="add-line">Add a line</button>'}
    </header>
    <div class="card-body tight">
      <table class="data" id="lines-table">
        <thead><tr>
          <th class="shrink">#</th><th>Description</th><th class="shrink">Qty</th>
          <th class="shrink">Unit</th><th class="shrink">Rate</th><th class="shrink">Amount</th>
          <th class="shrink">Not quoted</th><th class="shrink">Optional</th><th class="shrink"></th>
        </tr></thead>
        <tbody id="lines-body">
          ${(q.items || []).map((item, index) => lineRow(item, index, locked)).join('')}
        </tbody>
        <tfoot><tr>
          <td colspan="5" class="right">Total as quoted</td>
          <td class="num" id="lines-total">0.00</td>
          <td colspan="3"></td>
        </tr></tfoot>
      </table>
    </div>
    ${locked ? '' : `<div class="card-body" style="border-top:1px solid var(--line-2);display:flex;gap:8px;align-items:center">
      <button class="btn" id="save-lines">Save lines</button>
      <button class="btn good" id="confirm-quote">
        ${q.extraction_status === 'reviewed' ? 'Re-confirm' : 'I have checked this against the copy — confirm'}
      </button>
      <span class="muted">Confirming unlocks submission of the note.</span>
    </div>`}
  </div>`;
}

function filePreview(file) {
  if (!file) return '<div class="no-file">No copy was attached to this quotation.</div>';
  const name = (file.original_name || '').toLowerCase();
  if (name.endsWith('.pdf')) return `<iframe src="/api/files/${file.id}#view=FitH" title="Quotation"></iframe>`;
  if (/\.(png|jpe?g|webp|bmp|gif|tiff?)$/.test(name)) return `<img src="/api/files/${file.id}" alt="Quotation">`;
  return `<div class="no-file">${esc(file.original_name)} cannot be shown here.<br>
    <a href="/api/files/${file.id}?download=1" style="color:#9fb6d4">Download it</a> to check the figures.</div>`;
}

function lineRow(item, index, locked) {
  const attrs = locked ? 'disabled' : '';
  return `<tr data-line class="${item.needs_review ? 'needs-review' : ''} ${item.not_quoted ? 'not-quoted' : ''}">
    <td class="shrink">${index + 1}</td>
    <td><input name="description" value="${esc(item.description || '')}" ${attrs}>
      ${item.needs_review ? '<div class="flag">This line did not multiply out — check it.</div>' : ''}</td>
    <td class="shrink"><input name="quantity" type="number" step="0.001" style="width:72px" value="${item.quantity ?? 1}" ${attrs}></td>
    <td class="shrink"><input name="unit" style="width:58px" value="${esc(item.unit || 'Nos')}" ${attrs}></td>
    <td class="shrink"><input name="rate" type="number" step="0.0001" style="width:96px" value="${item.rate ?? 0}" ${attrs}></td>
    <td class="shrink"><input name="amount" type="number" step="0.01" style="width:104px" value="${item.amount ?? ''}" ${attrs}></td>
    <td class="shrink center"><input name="not_quoted" type="checkbox" ${item.not_quoted ? 'checked' : ''} ${attrs}></td>
    <td class="shrink center"><input name="is_optional" type="checkbox" ${item.is_optional ? 'checked' : ''} ${attrs}></td>
    <td class="shrink">${locked ? '' : '<button class="btn small ghost" data-remove-line>✕</button>'}</td>
  </tr>`;
}

WIRE.quotations = (note) => {
  // --- Upload ---
  const dropzone = el('dropzone');
  const input = el('file-input');
  let pending = [];

  const vendorInputs = [el('up-vendor'), el('review-vendor')].filter(Boolean);
  for (const vendorInput of vendorInputs) {
    let vendorLookupSequence = 0;
    const vendorList = el(vendorInput.id === 'up-vendor' ? 'vendor-list' : 'review-vendor-list');
    const lookupVendors = async (q = '') => {
      const sequence = ++vendorLookupSequence;
      try {
        const params = new URLSearchParams({ q });
        const result = await api.get(`/integrations/siteerp/vendors?${params}`);
        if (sequence !== vendorLookupSequence) return;
        state.vendors = result.vendors;
        vendorList.innerHTML = result.vendors.map((v) => `<option value="${esc(v.name)}">`).join('');
      } catch (error) { showError(error); }
    };
    vendorInput.addEventListener('focus', () => lookupVendors(''));
    vendorInput.addEventListener('input', debounce(() => lookupVendors(vendorInput.value.trim()), 250));
  }

  if (dropzone) {
    dropzone.addEventListener('click', () => input.click());
    dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('over'); });
    dropzone.addEventListener('dragleave', () => dropzone.classList.remove('over'));
    dropzone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropzone.classList.remove('over');
      pending = [...e.dataTransfer.files];
      showPending();
    });
    input.addEventListener('change', () => { pending = [...input.files]; showPending(); });
  }

  function showPending() {
    el('pending-files').innerHTML = pending.length
      ? `<ul class="filelist">${pending.map((f) => `<li>📄 ${esc(f.name)}<span class="spacer"></span><span class="size">${bytes(f.size)}</span></li>`).join('')}</ul>`
      : '';
  }

  el('upload-btn')?.addEventListener('click', async () => {
    if (!pending.length) { toast('Choose a file first.', 'bad'); return; }

    const form = new FormData();
    for (const file of pending) form.append('files', file);
    const vendor = el('up-vendor').value.trim();
    const gstin = el('up-gstin').value.trim();
    if (vendor) form.append('vendor_name', vendor);
    if (gstin) form.append('vendor_gstin', gstin);

    const button = el('upload-btn');
    button.disabled = true;
    el('upload-status').innerHTML = '<span class="spinner"></span> Reading the quotation…';

    try {
      const result = await api.upload(`/notes/${note.id}/quotations`, form);
      const extraction = result.extraction;
      toast(extraction
        ? `Read ${extraction.itemCount} line(s) at ${extraction.confidence}% confidence. Check them before confirming.`
        : 'Quotation added.', 'good');
      state.reviewQuotationId = result.quotation_id;
      await reload();
    } catch (error) {
      showError(error);
      button.disabled = false;
      el('upload-status').textContent = '';
    }
  });

  // --- Open the review screen ---
  view().querySelectorAll('[data-review]').forEach((button) => {
    button.addEventListener('click', async () => {
      state.reviewQuotationId = Number(button.dataset.review);
      renderTab();
    });
  });

  // --- A revised offer from the same vendor ---
  view().querySelectorAll('[data-revise]').forEach((button) => {
    button.addEventListener('click', () => {
      const quotation = note.quotations.find((q) => q.id === Number(button.dataset.revise));
      const row = note.comparison.rows.find((r) => r.quotation_id === quotation.id);

      openModal(`Revised offer from ${quotation.vendor_name}`, `
        <p class="muted">The current offer stays on file as version ${quotation.version_no} and is
        kept out of the comparison. Only this new version is compared, and the
        revision history is printed in the annexure.</p>
        <form id="revise-form">
          <div class="field"><span>The revised quotation (optional — leave empty if the new price came by phone or email)</span>
            <input type="file" name="files" multiple
                   accept=".pdf,.png,.jpg,.jpeg,.webp,.bmp,.tif,.tiff,.doc,.docx,.xls,.xlsx"></div>
          <div class="field"><span>Why it was revised</span>
            <input name="revision_note" placeholder="After negotiation on 2 August" required></div>
          <div class="field-row">
            <div class="field"><span>New reference</span>
              <input name="quotation_ref" value="${esc(quotation.quotation_ref || '')}"></div>
            <div class="field"><span>Dated</span><input type="date" name="quotation_date"></div>
            <div class="field"><span>Received on</span><input type="date" name="received_on"></div>
          </div>
          <p class="muted">Current landed value <b>₹${money(row ? row.cost.landed : 0)}</b>.
          Anything you leave blank carries over from version ${quotation.version_no}, and the
          quoted lines are copied across for you to edit.</p>
          <button class="btn primary wide" type="submit">Create the revision</button>
        </form>`);

      el('revise-form').addEventListener('submit', async (event) => {
        event.preventDefault();
        const form = new FormData(event.target);
        // An empty file input still posts one empty part, which the server
        // would reject as a zero-byte upload.
        const files = [...form.getAll('files')].filter((f) => f && f.size > 0);
        form.delete('files');
        for (const file of files) form.append('files', file);
        if (!files.length) form.append('extract', 'false');

        const submit = event.target.querySelector('button[type=submit]');
        submit.disabled = true;
        submit.textContent = 'Working…';

        try {
          const result = await api.upload(`/quotations/${quotation.id}/revise`, form);
          closeModal();
          toast(result.items_carried_over
            ? `Version ${result.version_no} created. The lines were copied from the previous version — check the prices.`
            : `Version ${result.version_no} created.`, 'good');
          state.reviewQuotationId = result.quotation_id;
          await reload();
        } catch (error) {
          showError(error);
          submit.disabled = false;
          submit.textContent = 'Create the revision';
        }
      });
    });
  });

  // --- Earlier versions ---
  view().querySelectorAll('[data-history]').forEach((button) => {
    button.addEventListener('click', () => {
      const quotation = note.quotations.find((q) => q.id === Number(button.dataset.history));
      const chain = [quotation, ...(quotation.history || [])];

      openModal(`${quotation.vendor_name} — revision history`, `
        <table class="data">
          <thead><tr><th>Version</th><th>Dated</th><th>Reference</th>
            <th class="right">Landed</th><th class="right">Change</th><th>Why</th><th></th></tr></thead>
          <tbody>${[...chain].reverse().map((version, index, ordered) => {
            const landed = version.cost?.landed ?? null;
            const earlier = index > 0 ? ordered[index - 1].cost?.landed ?? null : null;
            const movement = landed !== null && earlier !== null ? landed - earlier : null;
            const isCurrent = version.id === quotation.id;
            return `<tr>
              <td><b>v${version.version_no}</b>${isCurrent ? ' <span class="badge good">current</span>' : ''}</td>
              <td>${fmtDate(version.quotation_date)}</td>
              <td>${esc(version.quotation_ref || '—')}</td>
              <td class="num">${landed !== null ? money(landed) : '—'}</td>
              <td class="num" style="color:${movement === null ? 'inherit' : movement < 0 ? 'var(--good)' : 'var(--warn)'}">
                ${movement === null ? '—' : `${movement < 0 ? '−' : '+'}${money(Math.abs(movement))}`}</td>
              <td class="muted">${esc(version.revision_note || '—')}</td>
              <td>${(version.files || []).map((f) =>
                `<a class="btn small ghost" href="/api/files/${f.id}" target="_blank">copy</a>`).join('') || ''}</td>
            </tr>`;
          }).join('')}</tbody>
        </table>
        <p class="muted" style="margin-top:10px">Earlier versions take no part in the comparison.
        Deleting the current version brings the one before it back.</p>`);
    });
  });

  view().querySelectorAll('[data-delete-quote]').forEach((button) => {
    button.addEventListener('click', async (event) => {
      event.stopPropagation();
      if (!confirm('Remove this quotation and its attachment?')) return;
      try {
        await api.del(`/quotations/${button.dataset.deleteQuote}`);
        toast('Quotation removed.');
        await reload();
      } catch (error) { showError(error); }
    });
  });

  // --- Review screen wiring ---
  el('back-to-quotes')?.addEventListener('click', () => {
    state.reviewQuotationId = null;
    renderTab();
  });

  const q = note.quotations.find((item) => item.id === state.reviewQuotationId);
  if (!q) return;

  el('quote-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = Object.fromEntries(new FormData(event.target));
    try {
      const result = await api.patch(`/quotations/${q.id}`, form);
      for (const warning of result.warnings || []) toast(warning, 'bad');
      toast('Header saved.', 'good');
      await reload();
    } catch (error) { showError(error); }
  });

  el('reextract')?.addEventListener('click', async () => {
    if (!confirm('Read the attachment again? Any corrections you made to the lines will be replaced.')) return;
    try {
      const result = await api.post(`/quotations/${q.id}/reextract`, {});
      toast(`Read again at ${result.extraction.confidence}% confidence.`, 'good');
      await reload();
    } catch (error) { showError(error); }
  });

  const recalcTotal = () => {
    let total = 0;
    view().querySelectorAll('tr[data-line]').forEach((tr) => {
      if (tr.querySelector('[name=not_quoted]')?.checked) return;
      const amount = Number(tr.querySelector('[name=amount]')?.value);
      const quantity = Number(tr.querySelector('[name=quantity]')?.value);
      const rate = Number(tr.querySelector('[name=rate]')?.value);
      total += Number.isFinite(amount) && amount ? amount : (quantity * rate || 0);
    });
    const node = el('lines-total');
    if (node) node.textContent = money(total);
  };

  const wireLine = (tr) => {
    tr.querySelector('[data-remove-line]')?.addEventListener('click', () => { tr.remove(); recalcTotal(); });
    tr.querySelectorAll('input').forEach((field) => {
      field.addEventListener('input', () => {
        // Keep amount in step with quantity × rate unless it was typed over.
        if (['quantity', 'rate'].includes(field.name)) {
          const quantity = Number(tr.querySelector('[name=quantity]').value) || 0;
          const rate = Number(tr.querySelector('[name=rate]').value) || 0;
          const amountField = tr.querySelector('[name=amount]');
          if (!amountField.dataset.touched) amountField.value = (quantity * rate).toFixed(2);
        }
        if (field.name === 'amount') field.dataset.touched = '1';
        tr.classList.remove('needs-review');
        tr.querySelector('.flag')?.remove();
        recalcTotal();
      });
    });
  };

  view().querySelectorAll('tr[data-line]').forEach(wireLine);
  recalcTotal();

  el('add-line')?.addEventListener('click', () => {
    const body = el('lines-body');
    const temp = document.createElement('tbody');
    temp.innerHTML = lineRow({ description: '', quantity: 1, unit: 'Nos', rate: 0, amount: '' },
      body.children.length, false);
    const tr = temp.firstElementChild;
    body.append(tr);
    wireLine(tr);
    tr.querySelector('[name=description]').focus();
  });

  const collectLines = () => [...view().querySelectorAll('tr[data-line]')].map((tr, index) => ({
    line_no: index + 1,
    description: tr.querySelector('[name=description]').value,
    quantity: tr.querySelector('[name=quantity]').value,
    unit: tr.querySelector('[name=unit]').value,
    rate: tr.querySelector('[name=rate]').value,
    amount: tr.querySelector('[name=amount]').value,
    not_quoted: tr.querySelector('[name=not_quoted]').checked,
    is_optional: tr.querySelector('[name=is_optional]').checked,
  })).filter((item) => item.description.trim());

  el('save-lines')?.addEventListener('click', async () => {
    try {
      await api.put(`/quotations/${q.id}/items`, { items: collectLines() });
      toast('Lines saved.', 'good');
      await reload();
    } catch (error) { showError(error); }
  });

  el('confirm-quote')?.addEventListener('click', async () => {
    try {
      await api.put(`/quotations/${q.id}/items`, { items: collectLines() });
      await api.post(`/quotations/${q.id}/confirm`, {});
      toast('Confirmed. These figures now count.', 'good');
      state.reviewQuotationId = null;
      await reload();
    } catch (error) { showError(error); }
  });
};

// --- Comparison ------------------------------------------------------------

function compareTab(note) {
  const rows = note.comparison.rows;
  const locked = !editable(note);

  if (!rows.length) {
    return '<div class="empty"><h3>Nothing to compare yet</h3><p>Add quotations first.</p></div>';
  }

  const cols = rows.map((r) => `<th class="${r.is_selected ? 'selected-col' : ''}">
    ${esc(r.vendor_name)}${r.is_selected ? '<br><span class="badge good">Selected</span>' : ''}</th>`).join('');

  const line = (label, valueOf, options = {}) => `<tr>
    <th class="rowlabel">${esc(label)}</th>
    ${rows.map((r) => {
      const value = valueOf(r);
      const best = options.bestOf ? options.bestOf(r) : false;
      return `<td class="${best ? 'best' : ''} ${r.is_selected ? 'selected-col' : ''}">${value}</td>`;
    }).join('')}</tr>`;

  const section = (label) => `<tr class="section"><th colspan="${rows.length + 1}">${esc(label)}</th></tr>`;

  return `
  <div class="card">
    <header><h2>Comparison</h2>
      <span class="spacer"></span>
      <span class="muted">Price ${note.comparison.weights.price}% · delivery ${note.comparison.weights.delivery}% · payment ${note.comparison.weights.payment}% · criteria ${note.comparison.weights.technical}%</span>
    </header>
    <div class="card-body compare-wrap">
      <p class="muted">Scores use relative 0–10 scales; higher is better. Missing information scores 0 on an applicable axis. Criteria use the same total weight for every offer; once anyone scores a criterion, a blank score counts as 0. If nobody scores any criteria, that axis is omitted. Other axes with no data for any offer are also omitted and the remaining weights are scaled proportionally. Vendors with mandatory failures are not ranked.</p>
      <table class="compare">
        <thead><tr><th>Particulars</th>${cols}</tr></thead>
        <tbody>
          ${section('Commercial')}
          ${line('Items value', (r) => (r.cost.lineCount > 0 && r.cost.hasBreakdown ? money(r.cost.itemsTotal) : '—'))}
          ${line('Less discount', (r) => (r.cost.hasBreakdown && r.cost.discount ? money(r.cost.discount) : '—'))}
          ${line('Add freight', (r) => (r.cost.hasBreakdown && r.cost.freight ? money(r.cost.freight) : '—'))}
          ${line('Taxable value', (r) => (r.cost.basic !== null ? `<b>${money(r.cost.basic)}</b>` : '—'))}
          ${line('GST', (r) => (r.cost.gstAmount !== null ? `${money(r.cost.gstAmount)} <span class="muted">@${esc(r.cost.gstRateLabel || `${r.cost.gstRate}%`)}</span>` : '—'))}
          ${rows.some((r) => r.quoted_total !== null) ? line('Total as quoted', (r) => (r.quoted_total !== null ? money(r.quoted_total) : '—')) : ''}
          ${line('Landed cost', (r) => (r.cost.hasComparableValue ? `<b>${money(r.cost.landed)}</b>` : '—'), { bestOf: (r) => r.price_rank === 1 })}
          ${line('Price position', (r) => (r.price_rank ? `<span class="badge ${r.price_rank === 1 ? 'l1' : 'draft'}">L${r.price_rank}</span>` : '—'))}
          ${rows.some((r) => (r.version_count || 1) > 1 || r.negotiated > 0) ? `
            ${line('Version compared', (r) => ((r.version_count || 1) > 1
              ? `<span class="badge hold">v${r.version_no} of ${r.version_count}</span>` : '<span class="muted">first offer</span>'))}
            ${line('First offer', (r) => (r.first_offer !== null ? money(r.first_offer) : '—'))}
            ${line('Negotiated', (r) => (r.negotiated > 0
              ? `<span style="color:var(--good);font-weight:600">−${money(r.negotiated)}</span>` : '—'))}
          ` : ''}

          ${section('Delivery')}
          ${line('Delivery period', (r) => (r.delivery_days !== null ? `${r.delivery_days} days` : esc(r.delivery_text || '—')),
            { bestOf: (r) => r.delivery_rank === 1 })}
          ${line('Basis', (r) => esc(r.delivery_basis || '—'))}

          ${section('Payment terms')}
          ${line('Advance', (r) => (r.advance_percent !== null ? `${r.advance_percent}%` : '—'))}
          ${line('Credit', (r) => (r.credit_days !== null ? `${r.credit_days} days` : '—'))}
          ${line('Retention', (r) => (r.retention_percent !== null ? `${r.retention_percent}%` : '—'))}
          ${line('Retention release', (r) => (r.retention_release_days !== null ? `${r.retention_release_days} days after delivery` : '—'))}
          ${line('As quoted', (r) => `<span class="muted">${esc(truncate(r.payment_terms_text, 40) || '—')}</span>`)}
          ${line('Buyer cash-flow position', (r) => (r.payment_timing_days === null ? 'Not scored'
            : `${r.payment_timing_days > 0 ? '+' : ''}${r.payment_timing_days} days (${r.payment_timing_days > 0 ? 'deferred payment' : r.payment_timing_days < 0 ? 'advance before delivery' : 'neutral'})`))}

          ${note.criteria.length ? section('Assessment criteria') : ''}
          ${note.criteria.map((criterion) => `<tr>
            <th class="rowlabel">${esc(criterion.label)}
              ${criterion.is_mandatory ? '<span class="badge bad" style="font-size:10px">must</span>' : ''}
              ${criterion.requirement ? `<br><span class="muted" style="font-weight:400">${esc(criterion.requirement)}</span>` : ''}</th>
            ${rows.map((r) => {
              const value = criterion.values?.[r.quotation_id] || {};
              return `<td class="${r.is_selected ? 'selected-col' : ''}">
                ${esc(value.value_text || '—')}
                ${value.score !== null && value.score !== undefined ? `<br><b>${value.score}/10</b>` : ''}
                ${value.complies === false ? '<br><span class="badge bad">does not comply</span>' : ''}
                ${criterion.is_mandatory && value.complies !== true && value.complies !== false ? '<br><span class="badge hold">not confirmed</span>' : ''}
              </td>`;
            }).join('')}
          </tr>`).join('')}

          ${section('Weighted assessment')}
          ${line('Price score', (r) => (r.price_score === null ? '—' : `${r.price_score}/10`))}
          ${line('Delivery score', (r) => (r.delivery_score === null ? '—' : `${r.delivery_score}/10`))}
          ${line('Payment score', (r) => (r.payment_score === null ? '—' : `${r.payment_score}/10`))}
          ${line('Criteria score', (r) => (r.technical_score === null ? '<span class="muted">not scored</span>' : `${r.technical_score}/10`))}
          ${line('Overall', (r) => (r.overall_score === null ? '—' : `<b>${r.overall_score}/10</b>`), { bestOf: (r) => r.overall_rank === 1 })}
          ${line('Rank', (r) => (r.overall_rank ? `#${r.overall_rank}` : '—'))}
          ${line('Scoring completeness', (r) => {
            const incomplete = (r.incomplete_axes || []).map((axis) => axis === 'technical' ? 'criteria' : axis);
            if (r.mandatory_failures) incomplete.push('mandatory criterion failed or unconfirmed; not ranked');
            return incomplete.length ? `Incomplete: ${incomplete.join(', ')}` : 'Complete on applicable axes';
          })}

          ${section('How these figures were captured')}
          ${line('Source', (r) => `<span class="muted">${esc(SOURCE_LABEL[r.source] || r.source)}</span>`)}
          ${line('Checked by a person', (r) => (r.extraction_status === 'reviewed' || r.source === 'manual'
            ? '<span class="badge approved">Yes</span>' : '<span class="badge bad">Not yet</span>'))}

          ${locked ? '' : `<tr><th class="rowlabel">Select this vendor</th>
            ${rows.map((r) => {
              const blocked = !r.cost.hasComparableValue || r.mandatory_failures > 0;
              const reason = !r.cost.hasComparableValue ? 'Add price first' : 'Mandatory criterion failed or unconfirmed';
              return `<td class="${r.is_selected ? 'selected-col' : ''}">
                ${blocked && !r.is_selected ? `<span class="muted" title="${esc(reason)}">${esc(reason)}</span><br>` : ''}
                <button class="btn small ${r.is_selected ? 'good' : ''}" data-select="${r.quotation_id}" ${blocked ? 'disabled' : ''}>
                  ${r.is_selected ? 'Selected' : blocked ? 'Cannot select' : 'Select'}</button></td>`;
            }).join('')}</tr>`}
        </tbody>
      </table>
    </div>
  </div>

  ${note.comparison.flags.length ? `<div class="notice ${note.comparison.flags.some((f) => f.level === 'blocking') ? 'warn' : 'amber'}">
    <strong>Points for the reviewer</strong>
    <ul>${note.comparison.flags.map((f) => `<li>${esc(f.message)}</li>`).join('')}</ul></div>` : ''}

  <div class="card">
    <header><h3>Assessment criteria</h3>
      <span class="spacer"></span>
      <span class="muted">Enter a 0–10 score for each offer; criterion weights combine the scores. Categories are labels only.</span>
      ${locked ? '' : '<button class="btn small" id="add-criterion">Add a criterion</button>'}
    </header>
    <div class="card-body tight">
      <table class="data">
        <thead><tr>
          <th>Criterion</th><th>Category</th><th>Required</th><th class="shrink">Weight</th><th class="shrink">Must</th>
          ${rows.map((r) => `<th>${esc(truncate(r.vendor_name, 18))}</th>`).join('')}
          <th class="shrink"></th>
        </tr></thead>
        <tbody id="criteria-body">
          ${note.criteria.map((criterion, index) => criterionRow(criterion, index, rows, locked)).join('')}
        </tbody>
      </table>
    </div>
    ${locked ? '' : '<div class="card-body" style="border-top:1px solid var(--line-2)"><button class="btn primary" id="save-criteria">Save criteria and scores</button></div>'}
  </div>`;
}

function criterionRow(criterion, index, rows, locked) {
  const attrs = locked ? 'disabled' : '';
  return `<tr data-criterion>
    <td><input name="label" value="${esc(criterion.label || '')}" ${attrs}></td>
    <td><select name="category" ${attrs}>
      ${['technical', 'commercial', 'delivery', 'payment', 'other'].map((c) =>
        `<option value="${c}" ${criterion.category === c ? 'selected' : ''}>${c}</option>`).join('')}
    </select></td>
    <td><input name="requirement" value="${esc(criterion.requirement || '')}" ${attrs}></td>
    <td class="shrink"><input name="weight" type="number" step="0.5" style="width:60px" value="${criterion.weight ?? 1}" ${attrs}></td>
    <td class="shrink center"><input name="is_mandatory" type="checkbox" ${criterion.is_mandatory ? 'checked' : ''} ${attrs}></td>
    ${rows.map((r) => {
      const value = criterion.values?.[r.quotation_id] || {};
      return `<td data-quote="${r.quotation_id}">
        <input name="value_text" value="${esc(value.value_text || '')}" placeholder="what they offer" ${attrs}>
        <div style="display:flex;gap:3px;margin-top:3px;align-items:center">
          <input name="score" type="number" min="0" max="10" step="0.5" style="width:58px"
                 value="${value.score ?? ''}" placeholder="/10" ${attrs}>
          <select name="complies" style="width:auto;flex:1" ${attrs}>
            <option value="" ${value.complies === null || value.complies === undefined ? 'selected' : ''}>—</option>
            <option value="1" ${value.complies === true ? 'selected' : ''}>complies</option>
            <option value="0" ${value.complies === false ? 'selected' : ''}>no</option>
          </select>
        </div></td>`;
    }).join('')}
    <td class="shrink">${locked ? '' : '<button class="btn small ghost" data-remove-criterion>✕</button>'}</td>
  </tr>`;
}

WIRE.compare = (note) => {
  view().querySelectorAll('[data-select]').forEach((button) => {
    button.addEventListener('click', () => {
      const quotationId = Number(button.dataset.select);
      const quotation = note.quotations.find((q) => q.id === quotationId);
      const row = note.comparison.rows.find((r) => r.quotation_id === quotationId);
      const lowest = note.comparison.lowest;
      const isLowest = lowest && lowest.quotation_id === quotationId;

      openModal(`Select ${quotation.vendor_name}`, `
        ${isLowest ? '<div class="notice good">This is the lowest offer.</div>' : `
          <div class="notice amber"><strong>This is not the lowest offer</strong>
          ₹${money(row.cost.landed - lowest.cost.landed)} above ${esc(lowest.vendor_name)}.
          The reason you write below is printed on the front page and is the justification for the choice.</div>`}
        <form id="select-form">
          <div class="field"><span>Reason for selecting this vendor</span>
            <textarea name="reason" required rows="4"
              placeholder="${isLowest ? 'Lowest offer meeting the technical requirement.' : 'Why this offer is preferred despite the price.'}">${esc(note.selection_reason || '')}</textarea></div>
          <button class="btn primary wide" type="submit">Select this vendor</button>
        </form>`);

      el('select-form').addEventListener('submit', async (event) => {
        event.preventDefault();
        const reason = new FormData(event.target).get('reason');
        try {
          const result = await api.post(`/notes/${note.id}/select-vendor`, { quotation_id: quotationId, reason });
          closeModal();
          const sync = result.vendor_sync;
          const message = sync?.status === 'created'
            ? `Vendor selected and added to SiteERP (${sync.vendor_code}).`
            : sync?.status === 'linked' ? `Vendor selected and linked to SiteERP (${sync.vendor}).`
              : sync?.status === 'skipped' ? `Vendor selected. ${sync.reason}` : 'Vendor selected.';
          toast(message, sync?.status === 'skipped' ? 'warn' : 'good');
          await reload();
        } catch (error) { showError(error); }
      });
    });
  });

  const rows = note.comparison.rows;

  const wireCriterion = (tr) => {
    tr.querySelector('[data-remove-criterion]')?.addEventListener('click', () => tr.remove());
  };
  view().querySelectorAll('[data-criterion]').forEach(wireCriterion);

  el('add-criterion')?.addEventListener('click', () => {
    const body = el('criteria-body');
    const temp = document.createElement('tbody');
    temp.innerHTML = criterionRow({ label: '', category: 'technical', weight: 1, values: {} },
      body.children.length, rows, false);
    const tr = temp.firstElementChild;
    body.append(tr);
    wireCriterion(tr);
    tr.querySelector('[name=label]').focus();
  });

  el('save-criteria')?.addEventListener('click', async () => {
    const criteria = [...view().querySelectorAll('[data-criterion]')].map((tr, index) => {
      const values = {};
      tr.querySelectorAll('[data-quote]').forEach((cell) => {
        const compliesRaw = cell.querySelector('[name=complies]').value;
        values[cell.dataset.quote] = {
          value_text: cell.querySelector('[name=value_text]').value,
          score: cell.querySelector('[name=score]').value,
          complies: compliesRaw === '' ? null : compliesRaw === '1',
        };
      });
      return {
        line_no: index + 1,
        label: tr.querySelector('[name=label]').value,
        category: tr.querySelector('[name=category]').value,
        requirement: tr.querySelector('[name=requirement]').value,
        weight: tr.querySelector('[name=weight]').value,
        is_mandatory: tr.querySelector('[name=is_mandatory]').checked,
        values,
      };
    }).filter((criterion) => criterion.label.trim());

    try {
      await api.put(`/notes/${note.id}/criteria`, { criteria });
      toast('Criteria saved.', 'good');
      await reload();
    } catch (error) { showError(error); }
  });
};

// --- Priced schedule -------------------------------------------------------

function itemsTab(note) {
  const locked = !editable(note);
  const t = note.totals;

  return `
  <div class="card">
    <header><h2>Priced schedule</h2>
      <span class="spacer"></span>
      ${locked ? '' : `
        ${note.selected_quotation ? `<button class="btn small" id="copy-from-quote">Copy the lines from ${esc(truncate(note.selected_quotation.vendor_name, 24))}</button>` : ''}
        <button class="btn small" id="add-item">Add a line</button>`}
    </header>
    <div class="card-body tight">
      <table class="data">
        <thead><tr>
          <th class="shrink">#</th><th>Description</th><th class="shrink">HSN/SAC</th>
          <th class="shrink">Qty</th><th class="shrink">Unit</th><th class="shrink">Rate</th>
          <th class="shrink">Amount</th><th class="shrink">Supply</th><th class="shrink">GST %</th>
          <th class="shrink">Tax checked</th><th class="shrink"></th>
        </tr></thead>
        <tbody id="items-body">
          ${note.items.map((item, index) => itemRow(item, index, locked)).join('')}
        </tbody>
        <tfoot>
          <tr><td colspan="6" class="right">Basic</td><td class="num">${money(t.basic)}</td><td colspan="4"></td></tr>
          ${t.breakdown.map((g) => `<tr><td colspan="6" class="right">
            ${g.interState ? `IGST @ ${g.rate}%` : `CGST+SGST @ ${g.rate}%`}</td>
            <td class="num">${money(g.total)}</td><td colspan="4"></td></tr>`).join('')}
          ${t.rounding ? `<tr><td colspan="6" class="right">Round off</td>
            <td class="num">${t.rounding > 0 ? '+' : '−'}${money(Math.abs(t.rounding))}</td><td colspan="4"></td></tr>` : ''}
          <tr><td colspan="6" class="right">Grand total</td>
            <td class="num">${money(t.grandTotal, 0)}</td><td colspan="4"></td></tr>
        </tfoot>
      </table>
    </div>
    ${locked ? '' : '<div class="card-body" style="border-top:1px solid var(--line-2)"><button class="btn primary" id="save-items">Save the schedule</button></div>'}
  </div>

  ${t.mixedRates ? '<div class="notice info">This note carries more than one GST rate. Accounts will confirm the rate on each line.</div>' : ''}`;
}

function itemRow(item, index, locked) {
  const attrs = locked ? 'disabled' : '';
  const corrected = item.tax_verified && item.verified_gst_rate !== null
    && Number(item.verified_gst_rate) !== Number(item.gst_rate);

  return `<tr data-item data-id="${item.id || ''}" data-source-req-item="${esc(item.source_requisition_item_id || '')}">
    <td class="shrink">${index + 1}</td>
    <td><input name="description" value="${esc(item.description || '')}" ${attrs}></td>
    <td class="shrink"><input name="hsn_sac" style="width:84px" value="${esc(item.hsn_sac || '')}" ${attrs}></td>
    <td class="shrink"><input name="quantity" type="number" step="0.001" style="width:76px" value="${item.quantity ?? 1}" ${attrs}></td>
    <td class="shrink"><input name="unit" style="width:58px" value="${esc(item.unit || 'Nos')}" ${attrs}></td>
    <td class="shrink"><input name="rate" type="number" step="0.0001" style="width:100px" value="${item.rate ?? 0}" ${attrs}></td>
    <td class="shrink"><input name="amount" type="number" step="0.01" style="width:108px" value="${item.amount ?? ''}" ${attrs}></td>
    <td class="shrink"><select name="supply_type" style="width:96px" ${attrs}>
      ${[['goods', 'Goods'], ['services', 'Services'], ['works_contract', 'Works']].map(([v, l]) =>
        `<option value="${v}" ${item.supply_type === v ? 'selected' : ''}>${l}</option>`).join('')}
    </select></td>
    <td class="shrink"><input name="gst_rate" type="number" step="0.01" style="width:66px" value="${item.gst_rate ?? 18}" ${attrs}>
      ${corrected ? `<div class="flag">accounts: ${item.verified_gst_rate}%</div>` : ''}</td>
    <td class="shrink center">${item.tax_verified
      ? '<span class="badge approved">Yes</span>'
      : '<span class="badge draft">No</span>'}</td>
    <td class="shrink">${locked ? '' : '<button class="btn small ghost" data-remove-item>✕</button>'}</td>
  </tr>`;
}

WIRE.items = (note) => {
  const wireItem = (tr) => {
    tr.querySelector('[data-remove-item]')?.addEventListener('click', () => tr.remove());
    tr.querySelectorAll('[name=quantity],[name=rate]').forEach((field) => {
      field.addEventListener('input', () => {
        const quantity = Number(tr.querySelector('[name=quantity]').value) || 0;
        const rate = Number(tr.querySelector('[name=rate]').value) || 0;
        const amount = tr.querySelector('[name=amount]');
        if (!amount.dataset.touched) amount.value = (quantity * rate).toFixed(2);
      });
    });
    tr.querySelector('[name=amount]')?.addEventListener('input', (event) => {
      event.target.dataset.touched = '1';
    });
  };

  view().querySelectorAll('[data-item]').forEach(wireItem);

  el('add-item')?.addEventListener('click', () => {
    const body = el('items-body');
    const temp = document.createElement('tbody');
    temp.innerHTML = itemRow({ description: '', quantity: 1, unit: 'Nos', rate: 0, gst_rate: 18, supply_type: 'goods' },
      body.children.length, false);
    const tr = temp.firstElementChild;
    body.append(tr);
    wireItem(tr);
    tr.querySelector('[name=description]').focus();
  });

  el('copy-from-quote')?.addEventListener('click', async () => {
    if (!confirm('Replace the priced schedule with the selected vendor\'s quoted lines?')) return;
    try {
      await api.post(`/notes/${note.id}/items/from-quotation`, {
        quotation_id: note.selected_quotation_id, replace: true,
      });
      toast('Lines copied from the quotation.', 'good');
      await reload();
    } catch (error) { showError(error); }
  });

  el('save-items')?.addEventListener('click', async () => {
    const items = [...view().querySelectorAll('[data-item]')].map((tr, index) => ({
      id: tr.dataset.id || undefined,
      source_requisition_item_id: tr.dataset.sourceReqItem || null,
      line_no: index + 1,
      description: tr.querySelector('[name=description]').value,
      hsn_sac: tr.querySelector('[name=hsn_sac]').value,
      quantity: tr.querySelector('[name=quantity]').value,
      unit: tr.querySelector('[name=unit]').value,
      rate: tr.querySelector('[name=rate]').value,
      amount: tr.querySelector('[name=amount]').value,
      supply_type: tr.querySelector('[name=supply_type]').value,
      gst_rate: tr.querySelector('[name=gst_rate]').value,
    })).filter((item) => item.description.trim());

    try {
      await api.put(`/notes/${note.id}/items`, { items });
      toast('Schedule saved.', 'good');
      await reload();
    } catch (error) { showError(error); }
  });
};

// --- Accounts --------------------------------------------------------------

function accountsTab(note) {
  const isAccounts = ['accounts', 'admin'].includes(state.user.role);
  const accounts = note.accounts || {};
  const catalogue = state.taxCatalogue;
  const deductions = note.deductions;
  const unverified = note.items.filter((i) => !i.tax_verified).length;

  if (!note.items.length) {
    return '<div class="empty"><h3>Nothing to check yet</h3><p>The priced schedule is empty.</p></div>';
  }

  return `
  ${!isAccounts ? '<div class="notice info">This is the accounts view. Only the accounts team can change anything here.</div>' : ''}
  ${isAccounts && !accounts.workflow_reviewed_at ? '<div class="notice warn">Accounts must save this review during the current approval round before the Accounts stage can approve it.</div>' : ''}

  <div class="card">
    <header><h2>Item-wise tax verification</h2>
      <span class="spacer"></span>
      ${unverified
        ? `<span class="badge bad">${unverified} of ${note.items.length} still to confirm</span>`
        : '<span class="badge approved">All lines confirmed</span>'}
    </header>
    <div class="card-body tight">
      <table class="data">
        <thead><tr>
          <th class="shrink">#</th><th>Description</th><th class="shrink">HSN/SAC</th>
          <th class="right shrink">Amount</th><th class="shrink">Supply</th>
          <th class="shrink">Proposed</th><th class="shrink">Confirmed rate</th>
          <th>Remark</th><th class="shrink">OK</th>
        </tr></thead>
        <tbody id="tax-body">
          ${note.items.map((item, index) => {
            const amount = Number(item.amount ?? (item.quantity * item.rate));
            return `<tr data-tax data-id="${item.id}" class="${item.tax_verified ? '' : 'needs-review'}">
              <td class="shrink">${index + 1}</td>
              <td>${esc(item.description)}</td>
              <td class="shrink mono">${esc(item.hsn_sac || '—')}</td>
              <td class="num shrink">${money(amount)}</td>
              <td class="shrink">${esc(item.supply_type)}</td>
              <td class="shrink center">${item.gst_rate}%</td>
              <td class="shrink"><input name="verified_gst_rate" type="number" step="0.01" style="width:72px"
                value="${item.verified_gst_rate ?? item.gst_rate}" ${isAccounts ? '' : 'disabled'}></td>
              <td><input name="tax_remark" value="${esc(item.tax_remark || '')}"
                placeholder="why the rate differs, if it does" ${isAccounts ? '' : 'disabled'}></td>
              <td class="shrink center"><input name="tax_verified" type="checkbox"
                ${item.tax_verified ? 'checked' : ''} ${isAccounts ? '' : 'disabled'}></td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>
    ${isAccounts ? `<div class="card-body" style="border-top:1px solid var(--line-2);display:flex;gap:8px">
      <button class="btn primary" id="save-tax">Save the tax check</button>
      <button class="btn" id="verify-all">Confirm every line at the proposed rate</button>
    </div>` : ''}
  </div>

  <div class="grid-2">
    <div class="card">
      <header><h3>Vendor checks</h3>
        <span class="spacer"></span>
        <button class="btn small" id="run-checklist">Run the checks</button>
      </header>
      <div class="card-body">
        <div id="checklist-output"><p class="muted">Run the checks to cross-verify the GSTIN against the PAN and look for a duplicate payment.</p></div>
        <form id="accounts-form" ${isAccounts ? '' : 'inert'} style="margin-top:14px">
          <label style="display:block;margin-bottom:7px">
            <input type="checkbox" name="gst_number_checked" ${accounts.gst_number_checked ? 'checked' : ''}>
            GST number verified on the portal</label>
          <div class="field"><input name="gst_status" value="${esc(accounts.gst_status || '')}" placeholder="e.g. Active, regular taxpayer"></div>
          <label style="display:block;margin-bottom:7px">
            <input type="checkbox" name="pan_number_checked" ${accounts.pan_number_checked ? 'checked' : ''}>
            PAN verified</label>
          <div class="field"><input name="pan_status" value="${esc(accounts.pan_status || '')}" placeholder="e.g. Valid, matches the GSTIN"></div>
          <label style="display:block;margin-bottom:5px"><input type="checkbox" name="bank_details_checked" ${accounts.bank_details_checked ? 'checked' : ''}> Bank details checked against a cancelled cheque</label>
          <label style="display:block;margin-bottom:5px"><input type="checkbox" name="msme_checked" ${accounts.msme_checked ? 'checked' : ''}> MSME status checked</label>
          <label style="display:block;margin-bottom:5px"><input type="checkbox" name="duplicate_checked" ${accounts.duplicate_checked ? 'checked' : ''}> Checked for a duplicate payment</label>
          <label style="display:block;margin-bottom:5px"><input type="checkbox" name="budget_checked" ${accounts.budget_checked ? 'checked' : ''}> Budget availability confirmed</label>
        </form>
      </div>
    </div>

    <div class="card">
      <header><h3>TDS and TCS</h3>
        <span class="spacer"></span>
        ${isAccounts ? '<button class="btn small" id="suggest-tds">Suggest</button>' : ''}
      </header>
      <div class="card-body">
        <form id="deduction-form" ${isAccounts ? '' : 'inert'}>
          <label style="display:block;margin-bottom:8px">
            <input type="checkbox" name="tds_applicable" ${accounts.tds_applicable ? 'checked' : ''}> TDS applies</label>
          <div class="field-row">
            <div class="field"><span>Section</span>
              <select name="tds_section">
                <option value="">—</option>
                ${(catalogue?.tds || []).map((s) => `<option value="${s.code}" ${accounts.tds_section === s.code ? 'selected' : ''}>${s.code} — ${esc(s.label)}</option>`).join('')}
              </select></div>
            <div class="field"><span>Rate %</span><input type="number" step="0.01" name="tds_rate" value="${accounts.tds_rate ?? ''}"></div>
            <div class="field"><span>Base ₹</span><input type="number" step="0.01" name="tds_base" value="${accounts.tds_base ?? note.totals.basic}"></div>
          </div>
          <div class="field"><span>Remark</span><input name="tds_remark" value="${esc(accounts.tds_remark || '')}"></div>

          <label style="display:block;margin:14px 0 8px">
            <input type="checkbox" name="tcs_applicable" ${accounts.tcs_applicable ? 'checked' : ''}> TCS applies</label>
          <div class="field-row">
            <div class="field"><span>Section</span>
              <select name="tcs_section">
                <option value="">—</option>
                ${(catalogue?.tcs || []).map((s) => `<option value="${s.code}" ${accounts.tcs_section === s.code ? 'selected' : ''}>${s.code} — ${esc(s.label)}</option>`).join('')}
              </select></div>
            <div class="field"><span>Rate %</span><input type="number" step="0.01" name="tcs_rate" value="${accounts.tcs_rate ?? ''}"></div>
            <div class="field"><span>Base ₹</span><input type="number" step="0.01" name="tcs_base" value="${accounts.tcs_base ?? note.totals.grandTotal}"></div>
          </div>
          <div class="field"><span>Remark</span><input name="tcs_remark" value="${esc(accounts.tcs_remark || '')}"></div>
          <div class="field"><span>Accounts remarks (printed on the note)</span>
            <textarea name="remarks">${esc(accounts.remarks || '')}</textarea></div>
          ${isAccounts ? '<button class="btn primary" type="submit">Save</button>' : ''}
        </form>
      </div>
      <div class="figures">
        <div class="figure"><div class="label">Grand total</div><div class="value small">${money(deductions.grandTotal, 0)}</div></div>
        ${deductions.tds.applicable ? `<div class="figure warn"><div class="label">Less TDS</div><div class="value small">${money(deductions.tds.amount)}</div></div>` : ''}
        ${deductions.tcs.applicable ? `<div class="figure"><div class="label">Add TCS</div><div class="value small">${money(deductions.tcs.amount)}</div></div>` : ''}
        <div class="figure good"><div class="label">Net payable</div><div class="value">${money(deductions.netPayable, 0)}</div></div>
      </div>
    </div>
  </div>

  ${deductions.warnings.length ? `<div class="notice amber">
    <strong>Worth checking</strong>
    <ul>${deductions.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></div>` : ''}

  <p class="muted">${esc(catalogue?.disclaimer || '')}</p>`;
}

WIRE.accounts = (note) => {
  const collectTax = () => [...view().querySelectorAll('[data-tax]')].map((tr) => ({
    id: Number(tr.dataset.id),
    tax_verified: tr.querySelector('[name=tax_verified]').checked,
    verified_gst_rate: tr.querySelector('[name=verified_gst_rate]').value,
    tax_remark: tr.querySelector('[name=tax_remark]').value,
  }));

  el('save-tax')?.addEventListener('click', async () => {
    try {
      await api.post(`/notes/${note.id}/tax-verify`, { items: collectTax() });
      toast('Tax check saved.', 'good');
      await reload();
    } catch (error) { showError(error); }
  });

  el('verify-all')?.addEventListener('click', async () => {
    view().querySelectorAll('[data-tax] [name=tax_verified]').forEach((box) => { box.checked = true; });
    try {
      await api.post(`/notes/${note.id}/tax-verify`, { items: collectTax() });
      toast('Every line confirmed.', 'good');
      await reload();
    } catch (error) { showError(error); }
  });

  el('run-checklist')?.addEventListener('click', async () => {
    const output = el('checklist-output');
    output.innerHTML = '<span class="spinner"></span> Running the checks…';
    try {
      const result = await api.get(`/notes/${note.id}/accounts/checklist`);
      output.innerHTML = result.findings.length
        ? result.findings.map((finding) => {
          const kind = finding.level === 'blocking' ? 'warn' : finding.level === 'good' ? 'good' : 'amber';
          return `<div class="notice ${kind}" style="margin-bottom:7px">
            <strong>${esc(finding.label)}</strong>${esc(finding.message)}</div>`;
        }).join('')
        : '<p class="muted">Nothing to report.</p>';
    } catch (error) {
      output.innerHTML = `<p class="error">${esc(error.message)}</p>`;
    }
  });

  el('suggest-tds')?.addEventListener('click', async () => {
    try {
      const { suggestion } = await api.get(`/notes/${note.id}/tax-suggestion`);
      const form = el('deduction-form');
      form.tds_applicable.checked = suggestion.applicable;
      form.tds_section.value = suggestion.section || '';
      form.tds_rate.value = suggestion.rate || '';
      form.tds_base.value = suggestion.base || '';
      form.tds_remark.value = (suggestion.reasons || []).join(' ');
      toast('Suggestion filled in — check it before saving.', 'good');
      for (const warning of suggestion.warnings || []) toast(warning, 'bad');
    } catch (error) { showError(error); }
  });

  el('deduction-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const deduction = Object.fromEntries(new FormData(event.target));
    const checks = Object.fromEntries(new FormData(el('accounts-form')));

    const body = {
      ...deduction,
      tds_applicable: event.target.tds_applicable.checked,
      tcs_applicable: event.target.tcs_applicable.checked,
      gst_number_checked: Boolean(checks.gst_number_checked),
      pan_number_checked: Boolean(checks.pan_number_checked),
      bank_details_checked: Boolean(checks.bank_details_checked),
      msme_checked: Boolean(checks.msme_checked),
      duplicate_checked: Boolean(checks.duplicate_checked),
      budget_checked: Boolean(checks.budget_checked),
      gst_status: checks.gst_status,
      pan_status: checks.pan_status,
    };

    try {
      const result = await api.put(`/notes/${note.id}/accounts`, body);
      for (const warning of result.warnings || []) toast(warning, 'bad');
      toast('Accounts saved.', 'good');
      await reload();
    } catch (error) { showError(error); }
  });
};

// --- Payment schedule ------------------------------------------------------

function scheduleTab(note) {
  const locked = !editable(note);
  const schedule = note.schedule;

  return `
  <div class="card">
    <header><h2>Payment schedule — Annexure C</h2>
      <span class="spacer"></span>
      ${locked ? '' : `<button class="btn small" id="preset-5050">50 / 50 preset</button>
      <button class="btn small" id="add-milestone">Add a milestone</button>`}
    </header>
    <div class="card-body tight">
      <table class="data">
        <thead><tr>
          <th class="shrink">#</th><th>Milestone</th><th>Trigger</th>
          <th class="shrink">Days</th><th class="shrink">%</th><th class="shrink">Basis</th>
          <th class="shrink">Fixed ₹</th><th class="shrink">Retention</th>
          <th class="right shrink">Amount</th><th class="shrink"></th>
        </tr></thead>
        <tbody id="milestones-body">
          ${schedule.rows.map((m, index) => milestoneRow(m, index, locked)).join('')}
        </tbody>
        <tfoot>
          <tr><td colspan="8" class="right">Scheduled</td>
            <td class="num">${money(schedule.scheduled)}</td><td></td></tr>
          <tr><td colspan="8" class="right">Net payable</td>
            <td class="num">${money(schedule.target)}</td><td></td></tr>
        </tfoot>
      </table>
    </div>
    ${locked ? '' : '<div class="card-body" style="border-top:1px solid var(--line-2)"><button class="btn primary" id="save-milestones">Save the schedule</button></div>'}
  </div>

  ${!schedule.reconciles && schedule.rows.length ? `<div class="notice amber">
    <strong>The schedule does not add up to the payable value</strong>
    ${schedule.warnings.map(esc).join(' ')}</div>` : ''}`;
}

function milestoneRow(m, index, locked) {
  const attrs = locked ? 'disabled' : '';
  return `<tr data-milestone>
    <td class="shrink">${index + 1}</td>
    <td><input name="milestone" value="${esc(m.milestone || '')}" ${attrs}></td>
    <td><input name="trigger_event" value="${esc(m.trigger_event || '')}" placeholder="PO release / proforma invoice" ${attrs}></td>
    <td class="shrink"><input name="due_offset_days" type="number" style="width:62px" value="${m.due_offset_days ?? ''}" ${attrs}></td>
    <td class="shrink"><input name="percent" type="number" step="0.01" style="width:68px" value="${m.percent ?? ''}" ${attrs}></td>
    <td class="shrink"><select name="basis" style="width:88px" ${attrs}>
      <option value="grand_total" ${m.basis === 'grand_total' ? 'selected' : ''}>Gross</option>
      <option value="basic" ${m.basis === 'basic' ? 'selected' : ''}>Basic</option>
    </select></td>
    <td class="shrink"><input name="fixed_amount" type="number" step="0.01" style="width:100px" value="${m.fixed_amount ?? ''}" ${attrs}></td>
    <td class="shrink center"><input name="is_retention" type="checkbox" ${m.is_retention ? 'checked' : ''} ${attrs}></td>
    <td class="num shrink">${money(m.amount)}</td>
    <td class="shrink">${locked ? '' : '<button class="btn small ghost" data-remove-milestone>✕</button>'}</td>
  </tr>`;
}

WIRE.schedule = (note) => {
  const wireMilestone = (tr) => {
    tr.querySelector('[data-remove-milestone]')?.addEventListener('click', () => tr.remove());
  };
  view().querySelectorAll('[data-milestone]').forEach(wireMilestone);

  const addRow = (data) => {
    const body = el('milestones-body');
    const temp = document.createElement('tbody');
    temp.innerHTML = milestoneRow(data, body.children.length, false);
    const tr = temp.firstElementChild;
    body.append(tr);
    wireMilestone(tr);
    return tr;
  };

  el('add-milestone')?.addEventListener('click', () => {
    addRow({ milestone: '', basis: 'grand_total' }).querySelector('[name=milestone]').focus();
  });

  el('preset-5050')?.addEventListener('click', () => {
    el('milestones-body').innerHTML = '';
    addRow({ milestone: '50% advance along with Purchase Order', trigger_event: 'PO release', percent: 50, basis: 'grand_total', due_offset_days: 0 });
    addRow({ milestone: '50% against Proforma Invoice before dispatch', trigger_event: 'Proforma invoice', percent: 50, basis: 'grand_total', due_offset_days: 10 });
  });

  el('save-milestones')?.addEventListener('click', async () => {
    const milestones = [...view().querySelectorAll('[data-milestone]')].map((tr, index) => ({
      line_no: index + 1,
      milestone: tr.querySelector('[name=milestone]').value,
      trigger_event: tr.querySelector('[name=trigger_event]').value,
      due_offset_days: tr.querySelector('[name=due_offset_days]').value,
      percent: tr.querySelector('[name=percent]').value,
      basis: tr.querySelector('[name=basis]').value,
      fixed_amount: tr.querySelector('[name=fixed_amount]').value,
      is_retention: tr.querySelector('[name=is_retention]').checked,
    })).filter((m) => m.milestone.trim());

    try {
      await api.put(`/notes/${note.id}/milestones`, { milestones });
      toast('Schedule saved.', 'good');
      await reload();
    } catch (error) { showError(error); }
  });
};

// --- Workflow --------------------------------------------------------------

const STAGE_ROLE = { check: 'checker', verify: 'verifier', accounts: 'accounts', approve: 'approver' };
const STAGE_LABEL = { accounts: 'Accounts', check: 'Checkers', verify: 'Verification', approve: 'Approvers' };
const STAGE_STATUS = {
  pending_check: 'check', pending_verify: 'verify',
  pending_accounts: 'accounts', pending_approval: 'approve',
};

function workflowTab(note) {
  const currentStage = STAGE_STATUS[note.status];
  const myTurn = currentStage
    && (state.user.role === 'admin' || state.user.role === STAGE_ROLE[currentStage])
    && note.steps.some((s) => s.step_type === currentStage && s.decision === 'pending'
      && (s.assignee_id === state.user.id || s.assignee_id === null));

  const canSubmit = ['draft', 'on_hold', 'rejected'].includes(note.status)
    && (state.user.role === 'admin' || note.prepared_by === state.user.id);
  const canRequestEdits = currentStage
    && ['checker', 'verifier', 'accounts', 'approver', 'admin'].includes(state.user.role);

  return `
  <div class="grid-2">
    <div class="card">
      <header><h3>Progress</h3></header>
      <div class="card-body">
        <ul class="timeline">
          <li><span class="dot approved"></span><div class="what">
            <b>Prepared</b> by ${esc(note.prepared_by_name || '—')}
            <div class="when">${fmtDateTime(note.created_at)}</div></div></li>
          ${note.steps.map((step) => `<li>
            <span class="dot ${step.decision}"></span>
            <div class="what">
              <b>${esc(STAGE_LABEL[step.step_type] || step.step_type)}</b>
              — ${esc(step.assignee_name || 'anyone holding the role')}
              ${note.edit_request_pending && step.decision === 'pending'
                ? '<span class="badge hold">awaiting edits</span>'
                : step.decision !== 'pending'
                  ? `<span class="badge ${step.decision === 'approved' ? 'approved' : step.decision === 'rejected' ? 'rejected' : 'hold'}">${step.decision}</span>`
                  : '<span class="badge pending">waiting</span>'}
              ${step.comments ? `<div class="muted">${esc(step.comments)}</div>` : ''}
              <div class="when">${step.decided_at ? fmtDateTime(step.decided_at) : ''}</div>
            </div></li>`).join('')}
        </ul>
      </div>
    </div>

    <div class="card">
      <header><h3>Actions</h3></header>
      <div class="card-body">
        ${note.edit_request_pending ? `<div class="notice warn"><strong>Edits were requested by ${esc(note.edit_request.requested_by_name)} (${esc(note.edit_request.requested_by_role)}) on ${fmtDateTime(note.edit_request.requested_at)}</strong>
          <p>${esc(note.edit_request.request_text)}</p>
          <p class="muted">Update the requested information. On resubmission, all assigned reviewers will approve again, starting with Accounts.</p></div>` : ''}

        ${canSubmit ? `
          ${note.readiness.canSubmit
            ? `<p>${note.edit_request_pending ? 'The updated note is ready to return to the full approval workflow.' : 'Everything required is in place.'}</p><button class="btn primary wide" id="submit-note">${note.edit_request_pending ? 'Resubmit for all approvals' : 'Submit for approval'}</button>`
            : `<div class="notice warn"><strong>Not ready yet</strong>
               <ul>${note.readiness.blocking.map((b) => `<li>${esc(b)}</li>`).join('')}</ul></div>`}
        ` : ''}

        ${canRequestEdits ? `
          <div class="card-body" style="border:1px solid var(--line);border-radius:8px;margin-top:12px;padding:12px">
            <label style="display:flex;gap:8px;align-items:center;font-weight:600">
              <input type="checkbox" id="edit-required-toggle"> Edits are required from the preparer
            </label>
            <div id="edit-request-fields" hidden style="margin-top:10px">
              <div class="field"><span>Describe the required changes</span>
                <textarea id="edit-request-text" rows="3" placeholder="For example: correct the GST rate and update the payment schedule."></textarea></div>
              <button class="btn danger" id="send-edit-request">Return note to preparer</button>
            </div>
          </div>` : ''}

        ${myTurn ? `
          <h4>This note is waiting on you at the ${esc(STAGE_LABEL[currentStage].toLowerCase())} stage</h4>
          ${currentStage === 'accounts' ? '<div class="notice info">The accounts checks must be complete before this can be approved.</div>' : ''}
          <div class="field"><span>Comments</span><textarea id="decision-comments" rows="3"></textarea></div>
          <div style="display:flex;gap:8px">
            <button class="btn good" data-decision="approved">Approve</button>
            <button class="btn" data-decision="on_hold">Put on hold</button>
            <button class="btn danger" data-decision="rejected">Reject</button>
          </div>
        ` : ''}

        ${!canSubmit && !myTurn ? `<p class="muted">
          ${note.status === 'approved' ? 'This note has been approved in full.'
            : note.status === 'draft' ? 'This note is still being prepared.'
            : `This note is at the ${esc(STAGE_LABEL[currentStage] || note.status)} stage. There is nothing for you to do on it.`}</p>` : ''}

        ${['on_hold', 'rejected'].includes(note.status) && !note.edit_request_pending && (state.user.role === 'admin' || note.prepared_by === state.user.id)
          ? '<button class="btn wide" id="resume-note" style="margin-top:9px">Put it back into the flow</button>' : ''}
      </div>
    </div>
  </div>`;
}

WIRE.workflow = (note) => {
  el('submit-note')?.addEventListener('click', () => {
    if (note.edit_request_pending) {
      api.post(`/notes/${note.id}/submit`, {}).then(async () => {
        toast('Resubmitted. All approval stages will review the updated note.', 'good');
        await reload();
      }).catch(showError);
      return;
    }
    const byRole = (role) => state.users.filter((u) => u.role === role && u.is_active);

    openModal('Submit for approval', `
      <p class="muted">Leave a stage unassigned and anyone holding that role can act on it.</p>
      <form id="submit-form">
        ${['accounts', 'check', 'verify', 'approve'].map((stage) => `
          <fieldset class="field assignment-field">
            <legend>${esc(STAGE_LABEL[stage])}</legend>
            <div class="assignment-options">
              ${byRole(STAGE_ROLE[stage]).map((u) => `
                <label class="assignment-option">
                  <input type="checkbox" name="${stage}" value="${u.id}">
                  <span>${esc(u.full_name)}</span>
                </label>`).join('') || '<p class="muted">No active users for this stage.</p>'}
            </div>
          </fieldset>`).join('')}
        <button class="btn primary wide" type="submit">Submit</button>
      </form>`);

    el('submit-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const assignments = {};
      for (const stage of ['accounts', 'check', 'verify', 'approve']) {
        const selected = [...event.target.querySelectorAll(`input[name="${stage}"]:checked`)]
          .map((input) => Number(input.value));
        if (selected.length) assignments[stage] = selected;
      }
      try {
        await api.post(`/notes/${note.id}/submit`, { assignments });
        closeModal();
        toast('Submitted.', 'good');
        await reload();
      } catch (error) { showError(error); }
    });
  });

  el('edit-required-toggle')?.addEventListener('change', (event) => {
    el('edit-request-fields').hidden = !event.target.checked;
    if (event.target.checked) el('edit-request-text').focus();
  });

  el('send-edit-request')?.addEventListener('click', async () => {
    const requestText = el('edit-request-text').value.trim();
    if (!requestText) {
      toast('Describe what needs to change so the preparer can update it.', 'bad');
      el('edit-request-text').focus();
      return;
    }
    try {
      await api.post(`/notes/${note.id}/request-edits`, { request_text: requestText });
      toast('Edits required. The note was returned to its preparer.', 'good');
      await reload();
    } catch (error) { showError(error); }
  });

  view().querySelectorAll('[data-decision]').forEach((button) => {
    button.addEventListener('click', async () => {
      const decision = button.dataset.decision;
      const comments = el('decision-comments').value.trim();
      if (decision !== 'approved' && !comments) {
        toast('Write a comment explaining the decision.', 'bad');
        el('decision-comments').focus();
        return;
      }
      try {
        await api.post(`/notes/${note.id}/decision`, { decision, comments });
        toast(`Recorded as ${decision}.`, 'good');
        await reload();
      } catch (error) { showError(error); }
    });
  });

  el('resume-note')?.addEventListener('click', async () => {
    try {
      await api.post(`/notes/${note.id}/resume`, {});
      toast('Back in the flow.', 'good');
      await reload();
    } catch (error) { showError(error); }
  });
};

// ---------------------------------------------------------------------------
// Masters
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// People and access
// ---------------------------------------------------------------------------

/**
 * What each role can actually do. Shown wherever a role is chosen, because
 * "verifier" and "checker" mean nothing until someone tells you the difference.
 */
const ROLE_GUIDE = [
  { value: 'preparer', label: 'Preparer (Purchase)', can: 'Creates notes, uploads and confirms quotations, selects the vendor, submits for approval.' },
  { value: 'accounts', label: 'Accounts', can: 'First review stage. Verifies GST and PAN, confirms tax on every line, and sets TDS and TCS.' },
  { value: 'checker', label: 'Checker', can: 'Second review stage, after Accounts. Approves, holds or rejects the note.' },
  { value: 'verifier', label: 'Verifier', can: 'Third review stage, after the checkers.' },
  { value: 'approver', label: 'Approver', can: 'Final approval. Chairman and Managing Director sit here.' },
  { value: 'admin', label: 'Administrator', can: 'Everything above, plus creating users and resetting passwords.' },
];

const roleLabel = (value) => ROLE_GUIDE.find((r) => r.value === value)?.label || value;

const roleOptions = (selected) => ROLE_GUIDE
  .map((r) => `<option value="${r.value}" ${r.value === selected ? 'selected' : ''}>${esc(r.label)}</option>`)
  .join('');

const roleHelp = () => `<details style="margin:-4px 0 12px">
  <summary class="muted" style="cursor:pointer;font-size:12.5px">What can each role do?</summary>
  <ul style="margin:7px 0 0;padding-left:18px;font-size:12.5px" class="muted">
    ${ROLE_GUIDE.map((r) => `<li style="margin-bottom:4px"><b>${esc(r.label)}</b> — ${esc(r.can)}</li>`).join('')}
  </ul></details>`;

function usersCard(users) {
  const isAdmin = state.user.role === 'admin';
  const neverSet = users.filter((u) => u.is_active && !u.password_changed_at).length;
  const securityColumns = isAdmin ? '<th>Own password set</th><th>Status</th><th></th>' : '';

  return `
  <div class="card">
    <header><h2>People and access</h2>
      <span class="spacer"></span>
      ${isAdmin ? '<button class="btn small primary" id="new-user">Add a person</button>' : '<span class="muted">Only an administrator can change these</span>'}
    </header>

    ${neverSet && isAdmin ? `<div class="card-body" style="padding-bottom:0">
      <div class="notice amber" style="margin:0"><strong>${neverSet} account(s) are on a password someone else knows</strong>
      Either the shared password from installation, or one an administrator set for them. Ask each person to sign in and
      set their own under <b>${esc(state.user.full_name)} → Change password</b>. Until they do, that account is only as
      private as the password you handed over.</div>
    </div>` : ''}

    <div class="card-body tight">
      <table class="data">
        <thead><tr>
          <th>Name</th><th>Username</th><th>Designation</th><th>Role</th>
          ${securityColumns}
        </tr></thead>
        <tbody>${users.map((u) => `<tr${u.is_active ? '' : ' style="opacity:.55"'}>
          <td><b>${esc(u.full_name)}</b>${u.id === state.user.id ? ' <span class="badge hold">you</span>' : ''}
            ${isAdmin && u.email ? `<br><span class="muted">${esc(u.email)}</span>` : ''}</td>
          <td class="mono">${esc(u.username)}</td>
          <td>${esc(u.designation || '—')}</td>
          <td>${esc(roleLabel(u.role))}</td>
          ${isAdmin ? `<td>${u.password_changed_at
            ? `<span class="badge approved">${fmtDate(u.password_changed_at)}</span>`
            : '<span class="badge bad">not yet</span>'}</td>
          <td>${u.is_active ? '<span class="badge good">Active</span>' : '<span class="badge draft">Inactive</span>'}</td>
          <td class="shrink"><button class="btn small" data-edit-user="${u.id}">Edit</button></td>` : ''}
        </tr>`).join('')}</tbody>
      </table>
    </div>
  </div>`;
}

function wireUsers() {
  el('new-user')?.addEventListener('click', () => {
    openModal('Add a person', `
      <form id="user-form">
        <div class="field-row">
          <div class="field"><span>Full name</span><input name="full_name" required placeholder="Jaswinder Singh"></div>
          <div class="field"><span>Designation</span><input name="designation" placeholder="Manager-Purchase"></div>
        </div>
        <div class="field-row">
          <div class="field"><span>Username (how they sign in)</span><input name="username" required placeholder="jaswinder" autocapitalize="off"></div>
          <div class="field"><span>Email</span><input name="email" type="email"></div>
        </div>
        <div class="field"><span>Role</span><select name="role" required>${roleOptions('preparer')}</select></div>
        ${roleHelp()}
        <div class="field"><span>Starting password (at least 8 characters)</span>
          <input name="password" required minlength="8" value="${esc(suggestPassword())}">
          <p class="muted" style="margin:5px 0 0">Give this to them directly, not by email if you can avoid it.
          They should set their own as soon as they sign in — until they do, this account shows as
          <b>not yet</b> in the list above.</p></div>
        <button class="btn primary wide" type="submit">Create</button>
      </form>`);

    el('user-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = Object.fromEntries(new FormData(event.target));
      try {
        await api.post('/auth/users', form);
        closeModal();
        toast(`${form.full_name} can now sign in as ${form.username}.`, 'good');
        await renderMasters();
      } catch (error) { showError(error); }
    });
  });

  view().querySelectorAll('[data-edit-user]').forEach((button) => {
    button.addEventListener('click', () => {
      const user = state.users.find((u) => u.id === Number(button.dataset.editUser));
      const isSelf = user.id === state.user.id;

      openModal(`Edit ${user.full_name}`, `
        <form id="user-edit-form">
          <div class="field-row">
            <div class="field"><span>Full name</span><input name="full_name" value="${esc(user.full_name)}"></div>
            <div class="field"><span>Designation</span><input name="designation" value="${esc(user.designation || '')}"></div>
          </div>
          <div class="field"><span>Email</span><input name="email" type="email" value="${esc(user.email || '')}"></div>
          <div class="field"><span>Role</span><select name="role">${roleOptions(user.role)}</select></div>
          ${roleHelp()}
          <p class="muted" style="margin-bottom:12px">Username <b class="mono">${esc(user.username)}</b> cannot be changed —
          it appears against every decision this person has recorded.</p>

          <label style="display:block;margin-bottom:12px">
            <input type="checkbox" name="is_active" ${user.is_active ? 'checked' : ''} ${isSelf ? 'disabled' : ''}>
            Active — can sign in
            ${isSelf ? '<span class="muted">(you cannot deactivate your own account)</span>' : ''}
          </label>
          <p class="muted" style="margin:-8px 0 14px">Deactivate rather than delete someone who has left.
          Their past decisions stay on the notes they signed.</p>

          <div class="field"><span>Reset their password (leave blank to keep it)</span>
            <input name="password" minlength="8" placeholder="at least 8 characters">
            <p class="muted" style="margin:5px 0 0">Use this only when someone is locked out. They should then set
            their own, since a password you typed is one two people know.</p></div>

          <button class="btn primary wide" type="submit">Save</button>
        </form>`);

      el('user-edit-form').addEventListener('submit', async (event) => {
        event.preventDefault();
        const form = Object.fromEntries(new FormData(event.target));
        const body = {
          full_name: form.full_name,
          designation: form.designation,
          email: form.email,
          role: form.role,
          is_active: isSelf ? undefined : event.target.is_active.checked,
        };
        if (form.password) body.password = form.password;

        try {
          await api.patch(`/auth/users/${user.id}`, body);
          closeModal();
          toast(form.password ? 'Saved, and the password was reset.' : 'Saved.', 'good');
          await renderMasters();
        } catch (error) { showError(error); }
      });
    });
  });
}

/** A readable starting password, so an admin is not tempted to type "123456789". */
function suggestPassword() {
  const words = ['anchor', 'dredge', 'harbour', 'cutter', 'barge', 'winch', 'pontoon',
    'channel', 'tidal', 'survey', 'ballast', 'spud'];
  const pick = () => words[Math.floor(Math.random() * words.length)];
  const digits = String(Math.floor(Math.random() * 90) + 10);
  return `${pick()}-${pick()}-${digits}`;
}

/** Everyone can change their own password; this is reachable from the top bar. */
function changePasswordDialog() {
  openModal('Change your password', `
    <form id="pw-form">
      <div class="field"><span>Current password</span>
        <input name="current_password" type="password" required autocomplete="current-password" autofocus></div>
      <div class="field"><span>New password (at least 8 characters)</span>
        <input name="new_password" type="password" required minlength="8" autocomplete="new-password"></div>
      <div class="field"><span>New password again</span>
        <input name="confirm" type="password" required minlength="8" autocomplete="new-password"></div>
      <button class="btn primary wide" type="submit">Change it</button>
    </form>`);

  el('pw-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = Object.fromEntries(new FormData(event.target));
    if (form.new_password !== form.confirm) {
      toast('The two new passwords do not match.', 'bad');
      return;
    }
    try {
      await api.post('/auth/password', {
        current_password: form.current_password,
        new_password: form.new_password,
      });
      closeModal();
      toast('Password changed. It is yours alone now.', 'good');
    } catch (error) { showError(error); }
  });
}

async function renderMasters() {
  loading();
  const [{ vendors }, { projects }, { requisitions }] = await Promise.all([
    api.get('/integrations/siteerp/vendors'), api.get('/integrations/reqflow/projects'),
    api.get('/integrations/reqflow/requisitions?limit=20&sort=updated&direction=desc'),
  ]);
  state.vendors = vendors;
  state.projects = projects;

  const { users } = await api.get('/auth/users').catch(() => ({ users: [] }));
  state.users = users;

  view().innerHTML = `
  <div class="toolbar"><h1>Masters</h1></div>

  ${usersCard(users)}

  <div class="card">
    <header><h2>Vendors from SiteERP</h2><span class="spacer"></span>
      <span class="muted">Live source of truth · ${vendors.length} active</span></header>
    <div class="card-body tight">
      <table class="data">
        <thead><tr><th>Vendor code</th><th>Name</th><th>Contact</th><th>Phone / email</th><th>GSTIN</th><th>PAN</th></tr></thead>
        <tbody>${vendors.map((v) => `<tr>
          <td class="mono">${esc(v.vendor_code || '—')}</td>
          <td><b>${esc(v.name)}</b></td>
          <td>${esc(v.contact_person || '—')}</td>
          <td>${esc(v.phone || '—')}${v.email ? `<br><span class="muted">${esc(v.email)}</span>` : ''}</td>
          <td class="mono">${esc(v.gst_no || v.tax_identifier || '—')}</td>
          <td class="mono">${esc(v.pan_no || '—')}</td>
        </tr>`).join('')}</tbody>
      </table>
      <p class="muted" style="padding:8px 12px">Add or update vendor records in SiteERP. AppNote reads them live and does not keep a separate editable vendor master.</p>
    </div>
  </div>

  <div class="grid-2">
    <div class="card">
      <header><h3>Projects from Reqflow</h3></header>
      <div class="card-body tight">
        <table class="data"><thead><tr><th>Code</th><th>Name</th><th>Company ID</th></tr></thead>
          <tbody>${projects.map((p) => `<tr>
            <td class="mono">${esc(p.code || '—')}</td><td>${esc(p.name)}</td>
            <td>${esc(p.company_id || '—')}</td>
          </tr>`).join('')}</tbody></table>
      </div>
    </div>

    <div class="card">
      <header><h3>Recent Reqflow requisitions</h3></header>
      <div class="card-body tight">
        <table class="data"><thead><tr><th>Number</th><th>Raised</th><th>Purpose</th><th>Status</th></tr></thead>
          <tbody>${requisitions.map((r) => `<tr>
            <td class="mono">${esc(r.ref_number)}</td>
            <td>${fmtDate(r.requisition_date)}</td>
            <td>${esc(truncate(r.purpose, 44))}</td>
            <td><span class="badge ${r.source_status === 'approved' ? 'approved' : 'draft'}">${esc(r.source_status)}</span></td>
          </tr>`).join('')}</tbody></table>
      </div>
    </div>
  </div>`;

  wireUsers();

}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

(async function boot() {
  try {
    const { user } = await api.get('/auth/me');
    if (user) {
      state.user = user;
      await start();
    }
  } catch { /* not signed in */ }
}());
