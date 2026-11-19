// OCR for photographed and scanned quotations.
//
// tesseract.js is an optional dependency. When it is not installed the module
// reports itself unavailable and the pipeline falls through to manual entry
// with an explanation, rather than failing the upload.

let workerPromise = null;
let unavailableReason = null;

async function getWorker() {
  if (unavailableReason) return null;
  if (workerPromise) return workerPromise;

  workerPromise = (async () => {
    let tesseract;
    try {
      tesseract = await import('tesseract.js');
    } catch {
      unavailableReason = 'The tesseract.js package is not installed, so scanned images cannot be read automatically.';
      return null;
    }

    try {
      const createWorker = tesseract.createWorker || tesseract.default?.createWorker;
      const worker = await createWorker('eng', 1, {
        cachePath: process.env.OCR_CACHE_PATH || undefined,
        logger: () => {},
      });
      // Quotations are tables: preserving the layout matters more than prose
      // accuracy, so page segmentation stays automatic with OSD off.
      await worker.setParameters({
        preserve_interword_spaces: '1',
      });
      return worker;
    } catch (error) {
      unavailableReason = `OCR could not start: ${error.message}`;
      return null;
    }
  })();

  return workerPromise;
}

export async function isAvailable() {
  const worker = await getWorker();
  return Boolean(worker);
}

export function getUnavailableReason() {
  return unavailableReason;
}

/**
 * Reads one image buffer. Returns { text, confidence } or null when OCR is
 * not available.
 */
export async function ocrImage(buffer) {
  const worker = await getWorker();
  if (!worker) return null;

  try {
    const { data } = await worker.recognize(buffer);
    return {
      text: data.text || '',
      confidence: typeof data.confidence === 'number' ? Math.round(data.confidence) : null,
    };
  } catch (error) {
    return { text: '', confidence: 0, error: error.message };
  }
}

/** Reads several images and joins the pages in order. */
export async function ocrMany(buffers) {
  const worker = await getWorker();
  if (!worker) return null;

  const pages = [];
  let confidenceSum = 0;
  let counted = 0;

  for (const buffer of buffers) {
    const result = await ocrImage(buffer);
    if (!result) break;
    pages.push(result.text);
    if (typeof result.confidence === 'number') {
      confidenceSum += result.confidence;
      counted += 1;
    }
  }

  return {
    text: pages.join('\n\n'),
    confidence: counted ? Math.round(confidenceSum / counted) : null,
    pageCount: pages.length,
  };
}

export async function shutdownOcr() {
  if (!workerPromise) return;
  const worker = await workerPromise;
  if (worker) {
    try { await worker.terminate(); } catch { /* already gone */ }
  }
  workerPromise = null;
}
