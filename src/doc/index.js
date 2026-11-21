// Assembling the whole document.
//
// The front page and most annexures are portrait; the comparative statement is
// landscape, because a wide table of vendors will not fit otherwise. docx
// handles this with separate sections.

import fs from 'node:fs';
import { Document, Packer, PageOrientation, Header, Footer, AlignmentType, PageNumber, TextRun, ImageRun } from 'docx';
import { buildFrontPage, buildPostDeliveryPage } from './approval-note.js';
import { requisitionAnnexure, comparisonAnnexure, scheduleAnnexure, quotationAnnexure } from './annexures.js';
import { DOC_STYLES, PAGE_MARGINS, LANDSCAPE_MARGINS, para, text, FONT, pt, COLOURS } from './helpers.js';
import { formatDate, slugify } from '../domain.js';

const COMPANY = process.env.COMPANY_NAME || 'Dharti Dredging & Infrastructure Limited';

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/**
 * Works out which annexures this note has and what letter each one gets.
 * A is always the requisition, B the comparison, C the schedule, then the
 * quotations with the selected vendor first.
 */
export function buildAnnexures(note) {
  const plan = [];

  plan.push({ kind: 'requisition', title: 'Requisition' });
  plan.push({ kind: 'comparison', title: 'Comparative statement of quotations' });

  if (note.milestones.length) {
    plan.push({ kind: 'schedule', title: 'Payment schedule' });
  }

  const quotations = [...note.quotations].sort((a, b) => {
    if (a.id === note.selected_quotation_id) return -1;
    if (b.id === note.selected_quotation_id) return 1;
    return (a.position || 0) - (b.position || 0);
  });

  for (const quotation of quotations) {
    plan.push({
      kind: 'quotation',
      title: `Quotation — ${quotation.vendor_name}`,
      quotation,
    });
  }

  return plan.map((entry, index) => ({
    ...entry,
    letter: LETTERS[index] || `${LETTERS[Math.floor(index / 26) - 1]}${LETTERS[index % 26]}`,
  }));
}

function headerFor(note, { includeLogo = false } = {}) {
  const logoPath = new URL('../../public/logo.png', import.meta.url);
  const logo = includeLogo && fs.existsSync(logoPath)
    ? new ImageRun({
      data: fs.readFileSync(logoPath),
      transformation: { width: 142, height: 100 },
    })
    : null;

  return new Header({
    children: [
      logo
        ? para([logo], { align: AlignmentType.RIGHT, after: 0 })
        : para(`Approval Note ${note.note_no || ''}`, { size: 8, color: COLOURS.MUTED, align: AlignmentType.RIGHT, after: 0 }),
    ],
  });
}

function footerFor(note) {
  return new Footer({
    children: [
      para([
        text(`${note.note_no || 'Approval Note'} · ${formatDate(note.note_date)} · `, { size: 8, color: COLOURS.MUTED }),
        new TextRun({ children: ['Page ', PageNumber.CURRENT, ' of ', PageNumber.TOTAL_PAGES], font: FONT, size: pt(8), color: COLOURS.MUTED }),
      ], { align: AlignmentType.CENTER, after: 0 }),
    ],
  });
}

export async function generateApprovalNote(note) {
  const annexures = buildAnnexures(note);
  const header = headerFor(note);
  const footer = footerFor(note);

  const sections = [];
  const frontHeader = headerFor(note, { includeLogo: true });
  const annexureHeader = headerFor(note);

  // --- Front page (portrait) ----------------------------------------------
  sections.push({
    properties: {
      page: { margin: { ...PAGE_MARGINS, top: 1200 }, size: { orientation: PageOrientation.PORTRAIT } },
    },
    headers: { default: frontHeader },
    footers: { default: footer },
    children: buildFrontPage(note, { annexureIndex: annexures }),
  });

  // --- Portrait annexures before the comparison ---------------------------
  const requisition = annexures.find((a) => a.kind === 'requisition');
  if (requisition) {
    sections.push({
      properties: {
        page: { margin: PAGE_MARGINS, size: { orientation: PageOrientation.PORTRAIT } },
      },
      headers: { default: annexureHeader },
      footers: { default: footer },
      children: requisitionAnnexure(note, requisition.letter),
    });
  }

  // --- The comparison, landscape ------------------------------------------
  const comparison = annexures.find((a) => a.kind === 'comparison');
  if (comparison) {
    sections.push({
      properties: {
        page: { margin: LANDSCAPE_MARGINS, size: { orientation: PageOrientation.LANDSCAPE } },
      },
      headers: { default: annexureHeader },
      footers: { default: footer },
      children: comparisonAnnexure(note, comparison.letter),
    });
  }

  // --- The rest, portrait --------------------------------------------------
  const remaining = annexures.filter((a) => !['requisition', 'comparison'].includes(a.kind));
  if (remaining.length) {
    const children = [];
    for (const [index, annexure] of remaining.entries()) {
      if (annexure.kind === 'schedule') {
        children.push(...scheduleAnnexure(note, annexure.letter));
      } else if (annexure.kind === 'quotation') {
        children.push(...quotationAnnexure(note, annexure.quotation, annexure.letter));
      }
      void index;
    }

    sections.push({
      properties: {
        page: { margin: PAGE_MARGINS, size: { orientation: PageOrientation.PORTRAIT } },
      },
      headers: { default: annexureHeader },
      footers: { default: footer },
      children,
    });
  }

  // --- Post-delivery verification, the last page --------------------------
  // Its own section so it always lands at the very back, whatever annexures
  // the note happens to carry.
  sections.push({
    properties: {
      page: { margin: PAGE_MARGINS, size: { orientation: PageOrientation.PORTRAIT } },
    },
    headers: { default: annexureHeader },
    footers: { default: footer },
    children: buildPostDeliveryPage(note),
  });

  const document = new Document({
    styles: DOC_STYLES,
    creator: COMPANY,
    title: `Approval Note ${note.note_no || note.id}`,
    description: note.subject || '',
    sections,
  });

  return Packer.toBuffer(document);
}

export function documentFilename(note, extension = 'docx') {
  const vendor = note.selected_quotation?.vendor_name;
  const parts = [
    'Approval-Note',
    note.note_no ? note.note_no.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '') : `id-${note.id}`,
    vendor ? slugify(vendor).slice(0, 40) : null,
  ].filter(Boolean);

  return `${parts.join('_')}.${extension}`;
}

export { buildFrontPage, buildPostDeliveryPage };
