// Extraction orchestrator.
//
// Chain: PDF text layer → OCR → local Python interpretation. Each attempt
// returns the same shape. Nothing goes straight into a comparison:
// the result lands in the review screen with its confidence and its warnings,
// and a person confirms it before the note can be submitted.

import path from 'node:path';
import { parseQuotationPython } from './python.js';
import { extractPdfText, renderPdfPages } from './pdf.js';
import * as ocr from './ocr.js';

export const CONFIDENCE_FLOOR = Number(process.env.EXTRACTION_CONFIDENCE_FLOOR || 45);

/** auto | text | ocr | off */
export const EXTRACTION_MODE = (process.env.EXTRACTION_MODE || 'off').toLowerCase();

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/bmp', 'image/tiff']);

export function isPdf(mimeType, filename) {
  if (mimeType === 'application/pdf') return true;
  return path.extname(filename || '').toLowerCase() === '.pdf';
}

export function isImage(mimeType, filename) {
  if (mimeType && IMAGE_TYPES.has(mimeType)) return true;
  return ['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tif', '.tiff']
    .includes(path.extname(filename || '').toLowerCase());
}

function emptyResult(reason, { source = 'manual' } = {}) {
  return {
    ok: false,
    source,
    method: 'manual',
    confidence: 0,
    fields: {},
    items: [],
    warnings: [reason],
    needsManualEntry: true,
  };
}

/**
 * files: [{ buffer, originalName, mimeType }]
 */
export async function extractFromFiles(files, { mode = EXTRACTION_MODE } = {}) {
  if (mode === 'off') {
    return emptyResult('Automatic extraction is switched off. Enter the figures from the attached copy.');
  }
  if (!files || !files.length) {
    return emptyResult('No file was attached, so there is nothing to read.');
  }

  const attempts = [];
  const notes = [];

  const pdfFiles = files.filter((f) => isPdf(f.mimeType, f.originalName));
  const imageFiles = files.filter((f) => isImage(f.mimeType, f.originalName));

  let scannedPdfBuffers = [];
  let pdfPageCount = 0;

  if (mode === 'ocr') scannedPdfBuffers = pdfFiles;

  // --- Stage 1: PDF text layer -------------------------------------------
  if (pdfFiles.length && (mode === 'auto' || mode === 'text')) {
    const texts = [];
    for (const file of pdfFiles) {
      try {
        const result = await extractPdfText(file.buffer);
        pdfPageCount += result.pageCount;
        if (result.likelyScanned) {
          notes.push(`${file.originalName} appears to be a scan with no text layer.`);
          scannedPdfBuffers.push(file);
        } else if (result.text.trim()) {
          // Keep each source page boundary. Table rows frequently continue on
          // the next page, and explicit boundaries help the local parser avoid
          // joining unrelated header/footer fragments into one item.
          texts.push((result.perPage?.length ? result.perPage : [result.text])
            .join('\n\n__PAGE_BREAK__\n\n'));
        }
      } catch (error) {
        notes.push(`${file.originalName} could not be opened as a PDF: ${error.message}`);
      }
    }

    if (texts.length) {
      const parsed = await parseQuotationPython(texts.join('\n\n'), { source: 'pdf_text' });
      attempts.push({ ...parsed, method: 'PDF text layer', rawText: texts.join('\n\n') });
    }
  }

  const bestSoFar = attempts.sort((a, b) => b.confidence - a.confidence)[0];
  const needMore = mode === 'ocr'
    || !bestSoFar || bestSoFar.confidence < CONFIDENCE_FLOOR;

  // --- Stage 2: OCR -------------------------------------------------------
  if (needMore && mode !== 'text') {
    const ocrTargets = [];

    for (const file of imageFiles) ocrTargets.push(file.buffer);

    for (const file of scannedPdfBuffers) {
      const rendered = await renderPdfPages(file.buffer);
      if (!rendered.available) {
        notes.push(rendered.reason);
      } else {
        ocrTargets.push(...rendered.pages);
      }
    }

    if (ocrTargets.length) {
      const available = await ocr.isAvailable();
      if (!available) {
        notes.push(ocr.getUnavailableReason() || 'OCR is not available in this installation.');
      } else {
        const result = await ocr.ocrMany(ocrTargets);
        if (result && result.text.trim()) {
          const parsed = await parseQuotationPython(result.text, { source: 'ocr' });
          if (result.confidence !== null && result.confidence < 70) {
            parsed.warnings.push(`The image itself read poorly (OCR confidence ${result.confidence}%). Check every figure against the attached copy.`);
          }
          attempts.push({ ...parsed, method: 'OCR', rawText: result.text });
        } else {
          notes.push('OCR produced no readable text from the attached images.');
        }
      }
    }
  }

  return finalise(attempts, notes, { pdfPageCount });
}

function finalise(attempts, notes, { pdfPageCount = 0 } = {}) {
  if (!attempts.length) {
    const result = emptyResult('Nothing could be read from the attachment automatically. Enter the figures by hand against the attached copy.');
    result.warnings.push(...notes);
    result.pageCount = pdfPageCount;
    return result;
  }

  const ranked = attempts.slice().sort((a, b) => b.confidence - a.confidence);
  const best = ranked[0];

  const warnings = [...(best.warnings || []), ...notes];
  const fields = { ...(best.fields || {}) };
  if (/dharti/i.test(String(fields.vendor_name || ''))) {
    const alternateName = ranked
      .slice(1)
      .map((attempt) => attempt.fields?.vendor_name)
      .find((name) => String(name || '').trim() && !/dharti/i.test(String(name).trim()));
    fields.vendor_name = alternateName ? String(alternateName).trim() : null;
    warnings.push(alternateName
      ? 'The reader mistook Dharti Dredging & Infrastructure Limited (the buyer) for the supplier. Another detected vendor name is shown; verify it against the quotation.'
      : 'The reader found Dharti Dredging & Infrastructure Limited (the buyer) as the vendor. That name was removed; enter the supplier name from the quotation.');
  }

  if (best.confidence < CONFIDENCE_FLOOR) {
    warnings.unshift(`Confidence is only ${best.confidence}%. Treat every figure below as a draft and check it line by line against the attached copy.`);
  }

  if (ranked.length > 1) {
    const others = ranked.slice(1).map((a) => `${a.method} ${a.confidence}%`).join(', ');
    warnings.push(`Other reading attempts scored lower: ${others}.`);
  }

  return {
    ok: true,
    source: best.source,
    method: best.method,
    confidence: best.confidence,
    fields,
    items: best.items || [],
    warnings,
    pageCount: pdfPageCount,
    needsManualEntry: best.confidence < CONFIDENCE_FLOOR || !(best.items || []).length,
  };
}

export { parseQuotationPython as parseQuotation };
export const shutdown = ocr.shutdownOcr;
