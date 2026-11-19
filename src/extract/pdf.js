// PDF text-layer extraction.
//
// A born-digital PDF carries its text, and reading it is both exact and fast.
// A scanned one carries only pixels, which is reported back so the caller can
// fall through to OCR.

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let pdfjsPromise = null;

async function getPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      // The legacy build runs under Node without a DOM.
      const mod = await import('pdfjs-dist/legacy/build/pdf.mjs');
      return mod;
    })();
  }
  return pdfjsPromise;
}

/**
 * Groups positioned text items into visual rows.
 *
 * This is the part that makes table parsing work: pdf.js hands back fragments
 * with coordinates and no notion of rows, so fragments whose baselines sit
 * within a tolerance of each other are one row, ordered left to right, and
 * wide horizontal gaps become column separators.
 */
export function itemsToLines(items, { yTolerance = 3, columnGap = 12 } = {}) {
  const fragments = items
    .filter((it) => typeof it.str === 'string' && it.str.trim() !== '')
    .map((it) => ({
      text: it.str,
      x: it.transform[4],
      y: it.transform[5],
      width: it.width || 0,
    }));

  if (!fragments.length) return [];

  fragments.sort((a, b) => (b.y - a.y) || (a.x - b.x));

  const rows = [];
  let current = [fragments[0]];

  for (let i = 1; i < fragments.length; i += 1) {
    const frag = fragments[i];
    const reference = current[0];
    if (Math.abs(frag.y - reference.y) <= yTolerance) {
      current.push(frag);
    } else {
      rows.push(current);
      current = [frag];
    }
  }
  rows.push(current);

  return rows.map((row) => {
    row.sort((a, b) => a.x - b.x);
    let line = '';
    let previousEnd = null;
    for (const frag of row) {
      if (previousEnd !== null) {
        const gap = frag.x - previousEnd;
        if (gap > columnGap) line += '  |  ';
        else if (gap > 1) line += ' ';
      }
      line += frag.text;
      previousEnd = frag.x + frag.width;
    }
    return line.replace(/\s+/g, ' ').trim();
  }).filter(Boolean);
}

/**
 * Extracts text from a PDF buffer.
 * Returns { text, pageCount, likelyScanned, perPage }.
 */
/**
 * pdf.js checks the constructor, and a Node Buffer — though it is a Uint8Array
 * subclass — is rejected. This always hands over a plain Uint8Array view.
 */
function toUint8(buffer) {
  if (Buffer.isBuffer(buffer)) {
    return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  }
  if (buffer instanceof Uint8Array) return buffer;
  return new Uint8Array(buffer);
}

export async function extractPdfText(buffer, { maxPages = 20 } = {}) {
  const pdfjs = await getPdfjs();

  const data = toUint8(buffer);
  const task = pdfjs.getDocument({
    data,
    isEvalSupported: false,
    useSystemFonts: false,
    disableFontFace: true,
    verbosity: 0,
  });

  const doc = await task.promise;
  const pageCount = doc.numPages;
  const pages = [];
  let totalChars = 0;

  const limit = Math.min(pageCount, maxPages);
  for (let p = 1; p <= limit; p += 1) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    const lines = itemsToLines(content.items);
    const pageText = lines.join('\n');
    totalChars += pageText.replace(/\s/g, '').length;
    pages.push(pageText);
    page.cleanup();
  }

  await doc.destroy();

  const text = pages.join('\n\n');

  // Fewer than ~80 non-space characters per page means there is no real text
  // layer — almost certainly a scan.
  const likelyScanned = limit > 0 && (totalChars / limit) < 80;

  return { text, pageCount, pagesRead: limit, likelyScanned, perPage: pages };
}

/**
 * Renders pages to PNG for OCR. Needs @napi-rs/canvas, which is not a
 * dependency — when it is absent this returns an empty list and the caller
 * falls back to manual entry.
 */
export async function renderPdfPages(buffer, { maxPages = 5, scale = 2 } = {}) {
  let canvasLib;
  try {
    canvasLib = require('@napi-rs/canvas');
  } catch {
    return { pages: [], available: false, reason: 'The @napi-rs/canvas package is not installed, so scanned PDF pages cannot be rasterised for OCR.' };
  }

  const pdfjs = await getPdfjs();
  const data = toUint8(buffer);
  const doc = await pdfjs.getDocument({ data, isEvalSupported: false, disableFontFace: true, verbosity: 0 }).promise;

  const pages = [];
  const limit = Math.min(doc.numPages, maxPages);

  for (let p = 1; p <= limit; p += 1) {
    const page = await doc.getPage(p);
    const viewport = page.getViewport({ scale });
    const canvas = canvasLib.createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const context = canvas.getContext('2d');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: context, viewport }).promise;
    pages.push(await canvas.encode('png'));
    page.cleanup();
  }

  await doc.destroy();
  return { pages, available: true };
}
