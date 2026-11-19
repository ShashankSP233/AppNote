// Domain primitives: Indian number formatting, amount in words, GSTIN/PAN
// handling, financial year. No database and no framework dependencies, so this
// file is directly unit-testable.

export function num(value, fallback = 0) {
  if (value === null || value === undefined || value === '') return fallback;
  const n = typeof value === 'number' ? value : Number(String(value).replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : fallback;
}

export function round2(value) {
  const n = num(value);
  // Avoid the classic 1.005 → 1.00 float error by nudging in the last place.
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export function round3(value) {
  const n = num(value);
  return Math.round((n + Number.EPSILON) * 1000) / 1000;
}

/** Indian digit grouping: 1,68,315.20 */
export function money(value, { decimals = 2, symbol = false } = {}) {
  const n = round2(value);
  const formatted = new Intl.NumberFormat('en-IN', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(Math.abs(n));
  const sign = n < 0 ? '-' : '';
  return `${sign}${symbol ? '₹' : ''}${formatted}`;
}

/** Quantities print without trailing zeros: 2, 5000, 1.5 */
export function qty(value) {
  const n = round3(value);
  if (Number.isInteger(n)) return new Intl.NumberFormat('en-IN').format(n);
  return new Intl.NumberFormat('en-IN', { maximumFractionDigits: 3 }).format(n);
}

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine',
  'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen',
  'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function twoDigits(n) {
  if (n < 20) return ONES[n];
  const t = Math.floor(n / 10);
  const o = n % 10;
  return TENS[t] + (o ? ' ' + ONES[o] : '');
}

function threeDigits(n) {
  const h = Math.floor(n / 100);
  const rest = n % 100;
  let out = '';
  if (h) out += ONES[h] + ' Hundred';
  if (rest) out += (out ? ' and ' : '') + twoDigits(rest);
  return out;
}

/**
 * Indian system: Crore / Lakh / Thousand / Hundred, with paise.
 * Matches the house phrasing: "Rupees One Lakh Sixty Eight Thousand Three
 * Hundred and Fifteen Only."
 */
export function amountInWords(value, { currency = 'Rupees', suffix = 'Only' } = {}) {
  const n = round2(value);
  if (!Number.isFinite(n)) return '';
  const negative = n < 0;
  const abs = Math.abs(n);

  const rupees = Math.floor(abs);
  const paise = Math.round((abs - rupees) * 100);

  const parts = [];
  let remainder = rupees;

  const crore = Math.floor(remainder / 10000000);
  remainder %= 10000000;
  const lakh = Math.floor(remainder / 100000);
  remainder %= 100000;
  const thousand = Math.floor(remainder / 1000);
  remainder %= 1000;

  if (crore) parts.push(threeDigits(crore) + ' Crore');
  if (lakh) parts.push(threeDigits(lakh) + ' Lakh');
  if (thousand) parts.push(threeDigits(thousand) + ' Thousand');
  if (remainder) parts.push(threeDigits(remainder));

  let words = parts.join(' ').replace(/\s+/g, ' ').trim();
  if (!words) words = 'Zero';

  let out = `${currency} ${words}`;
  if (paise) out += ` and ${twoDigits(paise)} Paise`;
  if (negative) out = 'Minus ' + out;
  if (suffix) out += ` ${suffix}`;
  return out.replace(/\s+/g, ' ').trim();
}

/** Indian financial year label for a date: 2026-07-30 → "26-27" */
export function financialYear(date = new Date(), { short = true } = {}) {
  const d = date instanceof Date ? date : new Date(date);
  const y = d.getFullYear();
  const m = d.getMonth(); // 0-based; April = 3
  const start = m >= 3 ? y : y - 1;
  const end = start + 1;
  if (short) return `${String(start).slice(2)}-${String(end).slice(2)}`;
  return `${start}-${end}`;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

/** House date style: 30-July-2026 */
export function formatDate(date, { style = 'house' } = {}) {
  if (!date) return '';
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return String(date);
  const dd = String(d.getDate()).padStart(2, '0');
  if (style === 'house') return `${dd}-${MONTHS[d.getMonth()]}-${d.getFullYear()}`;
  if (style === 'short') return `${dd}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
  if (style === 'iso') return d.toISOString().slice(0, 10);
  return d.toDateString();
}

export function monthName(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  return MONTHS[d.getMonth()];
}

// ---------------------------------------------------------------------------
// GSTIN / PAN
// ---------------------------------------------------------------------------

export const GST_STATE_NAMES = {
  '01': 'Jammu & Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh',
  '05': 'Uttarakhand', '06': 'Haryana', '07': 'Delhi', '08': 'Rajasthan',
  '09': 'Uttar Pradesh', '10': 'Bihar', '11': 'Sikkim', '12': 'Arunachal Pradesh',
  '13': 'Nagaland', '14': 'Manipur', '15': 'Mizoram', '16': 'Tripura',
  '17': 'Meghalaya', '18': 'Assam', '19': 'West Bengal', '20': 'Jharkhand',
  '21': 'Odisha', '22': 'Chhattisgarh', '23': 'Madhya Pradesh', '24': 'Gujarat',
  '26': 'Dadra & Nagar Haveli and Daman & Diu', '27': 'Maharashtra',
  '29': 'Karnataka', '30': 'Goa', '31': 'Lakshadweep', '32': 'Kerala',
  '33': 'Tamil Nadu', '34': 'Puducherry', '35': 'Andaman & Nicobar Islands',
  '36': 'Telangana', '37': 'Andhra Pradesh', '38': 'Ladakh',
  '97': 'Other Territory', '99': 'Centre Jurisdiction',
};

const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z{1}[0-9A-Z]{1}$/;
const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

export function isValidGstin(value) {
  if (!value) return false;
  const v = String(value).toUpperCase().replace(/\s/g, '');
  if (!GSTIN_RE.test(v)) return false;
  if (!GST_STATE_NAMES[v.slice(0, 2)]) return false;
  return gstinChecksum(v) === v[14];
}

/** GSTIN check digit, modulus 36 with alternating weights. */
export function gstinChecksum(gstin) {
  const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const v = String(gstin).toUpperCase();
  let sum = 0;
  for (let i = 0; i < 14; i += 1) {
    const idx = chars.indexOf(v[i]);
    if (idx < 0) return null;
    const weight = (i % 2 === 0) ? 1 : 2;
    const product = idx * weight;
    sum += Math.floor(product / 36) + (product % 36);
  }
  return chars[(36 - (sum % 36)) % 36];
}

export function isValidPan(value) {
  if (!value) return false;
  return PAN_RE.test(String(value).toUpperCase().replace(/\s/g, ''));
}

/** Characters 3..12 of a GSTIN are the holder's PAN. */
export function panFromGstin(gstin) {
  if (!gstin) return null;
  const v = String(gstin).toUpperCase().replace(/\s/g, '');
  if (v.length < 12) return null;
  const pan = v.slice(2, 12);
  return isValidPan(pan) ? pan : null;
}

export function stateCodeFromGstin(gstin) {
  if (!gstin) return null;
  const v = String(gstin).replace(/\s/g, '');
  const code = v.slice(0, 2);
  return GST_STATE_NAMES[code] ? code : null;
}

export function stateNameFromCode(code) {
  if (!code) return null;
  return GST_STATE_NAMES[String(code).padStart(2, '0')] || null;
}

const PAN_FOURTH = {
  P: 'individual_huf',
  H: 'individual_huf',
  C: 'company',
  F: 'firm',
  A: 'other',   // Association of persons
  B: 'other',   // Body of individuals
  G: 'other',   // Government
  J: 'other',   // Artificial juridical person
  L: 'other',   // Local authority
  T: 'other',   // Trust
};

/**
 * The fourth character of a PAN gives the holder's constitution, which decides
 * the TDS rate under several sections (individual/HUF vs others).
 */
export function constitutionFromPan(pan) {
  if (!isValidPan(pan)) return null;
  return PAN_FOURTH[String(pan).toUpperCase()[3]] || 'other';
}

export function titleCase(value) {
  if (!value) return '';
  return String(value)
    .toLowerCase()
    .replace(/\b([a-z])/g, (m) => m.toUpperCase());
}

export function slugify(value, fallback = 'item') {
  const s = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || fallback;
}
