import express from 'express';
import fs from 'node:fs';
import archiver from 'archiver';
import { wrap, httpError, requireAuth, audit, storedPath } from '../middleware.js';
import { loadNote } from '../notes-repo.js';
import { generateApprovalNote, documentFilename, buildAnnexures } from '../doc/index.js';
import { formatDate, money, slugify } from '../domain.js';

const router = express.Router();

router.use(requireAuth);

async function requireNote(id) {
  const note = await loadNote(Number(id));
  if (!note) throw httpError(404, 'There is no note with that id.');
  return note;
}

/** The .docx itself. */
router.get('/notes/:id/document', wrap(async (req, res) => {
  const note = await requireNote(req.params.id);

  const buffer = await generateApprovalNote(note);
  const filename = documentFilename(note);

  await audit(req, { noteId: note.id, action: 'document_generated', entity: 'note', entityId: note.id });

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Length', buffer.length);
  res.send(buffer);
}));

/** What the annexure list will look like, for the UI to show before download. */
router.get('/notes/:id/annexures', wrap(async (req, res) => {
  const note = await requireNote(req.params.id);
  const annexures = buildAnnexures(note).map((a) => ({
    letter: a.letter,
    title: a.title,
    kind: a.kind,
    has_attachment: a.kind === 'quotation'
      ? Boolean(a.quotation?.files?.length)
      : a.kind === 'requisition'
        ? Boolean(note.files.some((f) => f.kind === 'requisition') || note.requisition_items.length)
        : true,
  }));
  res.json({ annexures });
}));

/**
 * The complete package: the .docx plus every original attachment, because a
 * PDF quotation cannot live inside a Word file.
 */
router.get('/notes/:id/package', wrap(async (req, res) => {
  const note = await requireNote(req.params.id);
  const docxBuffer = await generateApprovalNote(note);
  const baseName = documentFilename(note, '').replace(/\.$/, '');

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${baseName}.zip"`);

  const archive = archiver('zip', { zlib: { level: 9 } });

  archive.on('warning', (error) => {
    if (error.code !== 'ENOENT') console.error('[zip warning]', error.message);
  });
  archive.on('error', (error) => {
    console.error('[zip error]', error.message);
    res.destroy();
  });

  archive.pipe(res);

  archive.append(docxBuffer, { name: `${baseName}.docx` });

  const annexures = buildAnnexures(note);
  const manifest = [];

  manifest.push(`APPROVAL NOTE PACKAGE`);
  manifest.push(`${'='.repeat(60)}`);
  manifest.push(`Note number : ${note.note_no || note.id}`);
  manifest.push(`Date        : ${formatDate(note.note_date)}`);
  manifest.push(`Subject     : ${note.subject || ''}`);
  manifest.push(`Project     : ${note.project_name || ''}`);
  manifest.push(`Prepared by : ${note.prepared_by_name || ''}`);
  manifest.push(`Status      : ${note.status}`);
  manifest.push('');
  manifest.push(`Vendor selected : ${note.selected_quotation?.vendor_name || 'not selected'}`);
  manifest.push(`Grand total     : Rs. ${money(note.totals.grandTotal)}`);
  if (note.deductions.tds.applicable || note.deductions.tcs.applicable) {
    manifest.push(`Net payable     : Rs. ${money(note.deductions.netPayable)}`);
  }
  manifest.push('');
  manifest.push('CONTENTS');
  manifest.push('-'.repeat(60));
  manifest.push(`${baseName}.docx — the approval note with all annexures`);
  manifest.push('');
  manifest.push('ANNEXURES');
  manifest.push('-'.repeat(60));

  for (const annexure of annexures) {
    manifest.push(`${annexure.letter}. ${annexure.title}`);
  }

  manifest.push('');
  manifest.push('ORIGINAL ATTACHMENTS');
  manifest.push('-'.repeat(60));

  // Requisition scans
  const requisitionFiles = note.files.filter((f) => f.kind === 'requisition');
  for (const file of requisitionFiles) {
    const entry = `requisition/${file.original_name}`;
    try {
      archive.file(storedPath(file.stored_name), { name: entry });
      manifest.push(entry);
    } catch {
      manifest.push(`${entry} — MISSING from storage`);
    }
  }

  // One folder per vendor
  for (const annexure of annexures.filter((a) => a.kind === 'quotation')) {
    const quotation = annexure.quotation;
    const folder = `quotations/${annexure.letter}-${slugify(quotation.vendor_name).slice(0, 40)}`;

    if (!quotation.files?.length) {
      manifest.push(`${folder}/ — no copy attached`);
    }

    for (const file of quotation.files || []) {
      const entry = `${folder}/${file.original_name}`;
      try {
        archive.file(storedPath(file.stored_name), { name: entry });
        manifest.push(entry);
      } catch {
        manifest.push(`${entry} — MISSING from storage`);
      }
    }

    // Earlier versions of the same offer, kept so the negotiation can be
    // audited against the originals rather than only the summary table.
    for (const earlier of quotation.history || []) {
      for (const file of earlier.files || []) {
        const entry = `${folder}/superseded/v${earlier.version_no}-${file.original_name}`;
        try {
          archive.file(storedPath(file.stored_name), { name: entry });
          manifest.push(entry);
        } catch {
          manifest.push(`${entry} — MISSING from storage`);
        }
      }
    }
  }

  const otherFiles = note.files.filter((f) => f.kind === 'other');
  for (const file of otherFiles) {
    const entry = `other/${file.original_name}`;
    try {
      archive.file(storedPath(file.stored_name), { name: entry });
      manifest.push(entry);
    } catch {
      manifest.push(`${entry} — MISSING from storage`);
    }
  }

  manifest.push('');
  manifest.push(`Generated ${new Date().toISOString()}`);

  archive.append(manifest.join('\n'), { name: 'CONTENTS.txt' });

  await audit(req, { noteId: note.id, action: 'package_generated', entity: 'note', entityId: note.id });

  await archive.finalize();
}));

export default router;
