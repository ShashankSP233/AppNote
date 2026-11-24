import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const workerPath = fileURLToPath(new URL('../../python/extract_quote.py', import.meta.url));
const pythonCommand = process.env.APPNOTE_PYTHON
  || (process.platform === 'win32' ? 'python' : 'python3');

/** Run the local Python quotation parser. No document content leaves this PC. */
export function parseQuotationPython(text, { source = 'pdf_text', timeoutMs = 45000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(pythonCommand, [workerPath], {
      cwd: path.dirname(workerPath),
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(reject, new Error(`Python extraction exceeded ${timeoutMs / 1000} seconds.`));
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (stdout.length > 8_000_000) {
        child.kill();
        finish(reject, new Error('Python extraction returned too much output.'));
      }
    });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4000); });
    child.on('error', (error) => finish(reject, new Error(`Could not start Python extraction (${pythonCommand}): ${error.message}`)));
    child.on('close', (code) => {
      if (settled) return;
      if (code !== 0) return finish(reject, new Error(`Python extraction exited with code ${code}: ${stderr.trim() || 'no details'}`));
      try {
        const result = JSON.parse(stdout);
        if (!result || typeof result !== 'object' || !result.fields || !Array.isArray(result.items)) {
          throw new Error('Python extraction returned an invalid result shape.');
        }
        finish(resolve, result);
      } catch (error) {
        finish(reject, new Error(`Could not read Python extraction result: ${error.message}`));
      }
    });

    child.stdin.on('error', (error) => finish(reject, new Error(`Could not send text to Python extraction: ${error.message}`)));
    child.stdin.end(JSON.stringify({ text: String(text || ''), source }));
  });
}
