// Extraction orchestrator.
//
// Chain: PDF text layer → OCR → AI. Each stage returns the same shape, and the
// best attempt wins. Nothing here is ever written straight into a comparison:
// the result lands in the review screen with its confidence and its warnings,
// and a person confirms it before the note can be submitted.

import path from 'node:path';
import { parseQuotation } from './heuristics.js';
import { extractPdfText, renderPdfPages } from './pdf.js';
import * as ocr from './ocr.js';
import * as ai from './ai.js';

export const CONFIDENCE_FLOOR = Number(process.env.EXTRACTION_CONFIDENCE_FLOOR || 45);

/** auto | text | ocr | ai | off */
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
          texts.push(result.text);
        }
      } catch (error) {
        notes.push(`${file.originalName} could not be opened as a PDF: ${error.message}`);
      }
    }

    if (texts.length) {
      const parsed = parseQuotation(texts.join('\n\n'), { source: 'pdf_text' });
      attempts.push({ ...parsed, method: 'PDF text layer', rawText: texts.join('\n\n') });
    }
  }

  const bestSoFar = attempts.sort((a, b) => b.confidence - a.confidence)[0];
  const needMore = mode === 'ocr' || mode === 'ai'
    || !bestSoFar || bestSoFar.confidence < CONFIDENCE_FLOOR;

  // --- Stage 2: OCR -------------------------------------------------------
  if (needMore && mode !== 'ai' && mode !== 'text') {
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
          const parsed = parseQuotation(result.text, { source: 'ocr' });
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

  const bestAfterOcr = attempts.sort((a, b) => b.confidence - a.confidence)[0];
  const stillWeak = !bestAfterOcr || bestAfterOcr.confidence < CONFIDENCE_FLOOR;

  // --- Stage 3: AI --------------------------------------------------------
  if ((mode === 'ai' || (mode === 'auto' && stillWeak)) && ai.isConfigured()) {
    const contents = [];

    for (const file of imageFiles.slice(0, 5)) {
      contents.push({
        type: 'image',
        mediaType: file.mimeType === 'image/jpg' ? 'image/jpeg' : (file.mimeType || 'image/png'),
        data: file.buffer.toString('base64'),
      });
    }

    for (const file of scannedPdfBuffers.slice(0, 2)) {
      const rendered = await renderPdfPages(file.buffer, { maxPages: 3 });
      for (const page of rendered.pages || []) {
        contents.push({ type: 'image', mediaType: 'image/png', data: Buffer.from(page).toString('base64') });
      }
    }

    if (bestAfterOcr?.rawText) {
      contents.push({ type: 'text', text: `Text already read from this document:\n\n${bestAfterOcr.rawText.slice(0, 20000)}` });
    }

    if (contents.length) {
      const result = await ai.readQuotation(contents);
      if (result.ok) {
        const warnings = [];
        for (const region of result.data.unreadable) warnings.push(`Could not read: ${region}`);
        const illegible = result.data.items.filter((i) => i.needs_review).length;
        if (illegible) warnings.push(`${illegible} line(s) were not fully legible and are flagged for checking.`);

        const captured = Object.values(result.data.fields).filter((v) => v !== null && v !== '').length;
        const confidence = Math.max(0, Math.min(92,
          Math.round(captured * 4 + Math.min(30, result.data.items.length * 4) - illegible * 5 - result.data.unreadable.length * 4),
        ));

        attempts.push({
          ok: true,
          source: 'ai',
          method: 'AI reading',
          confidence,
          fields: result.data.fields,
          items: result.data.items,
          warnings,
        });
      } else {
        notes.push(result.reason);
      }
    }
  } else if (mode === 'auto' && stillWeak && !ai.isConfigured()) {
    notes.push('AI reading is not configured, so nothing further could be attempted automatically.');
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

export { parseQuotation };
export const shutdown = ocr.shutdownOcr;
