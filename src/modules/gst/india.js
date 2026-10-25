// Indian GST reference data and checks: state codes, GSTIN/PAN validation, financial years.

/** GST state codes (the first two digits of a GSTIN), with names and the usual short forms. */
export const GST_STATES = [
  { code: '01', name: 'Jammu and Kashmir', short: ['JK'] },
  { code: '02', name: 'Himachal Pradesh', short: ['HP'] },
  { code: '03', name: 'Punjab', short: ['PB'] },
  { code: '04', name: 'Chandigarh', short: ['CH'] },
  { code: '05', name: 'Uttarakhand', short: ['UK', 'UT'] },
  { code: '06', name: 'Haryana', short: ['HR'] },
  { code: '07', name: 'Delhi', short: ['DL'] },
  { code: '08', name: 'Rajasthan', short: ['RJ'] },
  { code: '09', name: 'Uttar Pradesh', short: ['UP'] },
  { code: '10', name: 'Bihar', short: ['BR'] },
  { code: '11', name: 'Sikkim', short: ['SK'] },
  { code: '12', name: 'Arunachal Pradesh', short: ['AR'] },
  { code: '13', name: 'Nagaland', short: ['NL'] },
  { code: '14', name: 'Manipur', short: ['MN'] },
  { code: '15', name: 'Mizoram', short: ['MZ'] },
  { code: '16', name: 'Tripura', short: ['TR'] },
  { code: '17', name: 'Meghalaya', short: ['ML'] },
  { code: '18', name: 'Assam', short: ['AS'] },
  { code: '19', name: 'West Bengal', short: ['WB'] },
  { code: '20', name: 'Jharkhand', short: ['JH'] },
  { code: '21', name: 'Odisha', short: ['OD', 'OR'] },
  { code: '22', name: 'Chhattisgarh', short: ['CT', 'CG'] },
  { code: '23', name: 'Madhya Pradesh', short: ['MP'] },
  { code: '24', name: 'Gujarat', short: ['GJ'] },
  { code: '26', name: 'Dadra and Nagar Haveli and Daman and Diu', short: ['DN', 'DH', 'DD'] },
  { code: '27', name: 'Maharashtra', short: ['MH'] },
  { code: '29', name: 'Karnataka', short: ['KA'] },
  { code: '30', name: 'Goa', short: ['GA'] },
  { code: '31', name: 'Lakshadweep', short: ['LD'] },
  { code: '32', name: 'Kerala', short: ['KL'] },
  { code: '33', name: 'Tamil Nadu', short: ['TN'] },
  { code: '34', name: 'Puducherry', short: ['PY'] },
  { code: '35', name: 'Andaman and Nicobar Islands', short: ['AN'] },
  { code: '36', name: 'Telangana', short: ['TG', 'TS'] },
  { code: '37', name: 'Andhra Pradesh', short: ['AP'] },
  { code: '38', name: 'Ladakh', short: ['LA'] },
  { code: '97', name: 'Other Territory', short: ['OT'] },
];

const STATE_CODES = new Set(GST_STATES.map((s) => s.code));
const LOOKUP = new Map();
for (const s of GST_STATES) {
  LOOKUP.set(s.code, s.code);
  LOOKUP.set(s.name.toLowerCase(), s.code);
  for (const short of s.short) LOOKUP.set(short.toLowerCase(), s.code);
}

export const isStateCode = (code) => STATE_CODES.has(code);

/** "29", "KA", "ka", "Karnataka" → "29"; anything else → null. */
export function toStateCode(value) {
  if (value === null || value === undefined) return null;
  const key = String(value).trim().toLowerCase().replace(/\s+/g, ' ').replace(/&/g, 'and');
  if (!key) return null;
  return LOOKUP.get(/^\d$/.test(key) ? `0${key}` : key) ?? null;
}

export const stateName = (code) => GST_STATES.find((s) => s.code === code)?.name ?? null;

const GSTIN_FORMAT = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const GSTIN_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** The 15th character of a GSTIN, from the first 14 (the official mod-36 checksum). */
export function gstinCheckChar(first14) {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const product = GSTIN_CHARS.indexOf(first14[i]) * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return GSTIN_CHARS[(36 - (sum % 36)) % 36];
}

/** Format, state code and checksum. */
export function isValidGstin(value) {
  const gstin = String(value ?? '').trim().toUpperCase();
  if (!GSTIN_FORMAT.test(gstin)) return false;
  if (!isStateCode(gstin.slice(0, 2))) return false;
  return gstinCheckChar(gstin.slice(0, 14)) === gstin[14];
}

export const isValidPan = (value) => /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(String(value ?? '').trim().toUpperCase());

/** Indian financial year (April–March, India time) of a date: 25 Oct 2026 → "2026-27". */
export function financialYear(date = new Date()) {
  const [year, month] = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit' })
    .format(date)
    .split('-')
    .map(Number);
  const start = month >= 4 ? year : year - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

/** Common GST slabs, offered in pickers; any rate 0–100 with two decimals is accepted. */
export const GST_RATES = [0, 0.25, 3, 5, 12, 18, 28];

/** Goods/services that carry no GST on the invoice, whatever the rate. */
export const TAXABILITY = ['TAXABLE', 'NIL_RATED', 'EXEMPT', 'NON_GST'];
