/**
 * Test Data Generator — produces realistic test data based on form field
 * types, names, and placeholders. Used by the Generator to fill form fields
 * with appropriate values instead of generic "test input".
 *
 * This is generic and works for any website — it inspects field metadata
 * (type, name, placeholder, aria-label) to determine the appropriate value.
 */

// ── Data pools ──────────────────────────────────────────────

const FIRST_NAMES = ['John', 'Jane', 'Michael', 'Sarah', 'David', 'Emily', 'Robert', 'Lisa'];
const LAST_NAMES = ['Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Davis', 'Miller', 'Wilson'];
const COMPANIES = ['Acme Corp', 'TechStart Inc', 'Global Systems', 'BlueWave LLC', 'Summit Partners'];
const STREETS = ['123 Main St', '456 Oak Ave', '789 Pine Rd', '321 Elm Blvd', '654 Maple Dr'];
const CITIES = ['Springfield', 'Portland', 'Austin', 'Denver', 'Seattle', 'Boston'];
const STATES = ['CA', 'NY', 'TX', 'WA', 'MA', 'CO', 'OR'];
const ZIPS = ['94102', '10001', '73301', '98101', '02101', '80201'];
const COUNTRIES = ['United States', 'Canada', 'United Kingdom', 'Australia', 'Germany'];

// ── Helpers ─────────────────────────────────────────────────

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomEmail() {
  const first = pick(FIRST_NAMES).toLowerCase();
  const last = pick(LAST_NAMES).toLowerCase();
  const num = Math.floor(Math.random() * 999);
  return `test.${first}.${last}${num}@example.com`;
}

function randomPhone() {
  const area = 200 + Math.floor(Math.random() * 799);
  const prefix = 200 + Math.floor(Math.random() * 799);
  const line = 1000 + Math.floor(Math.random() * 8999);
  return `(${area}) ${prefix}-${line}`;
}

function randomDate() {
  const year = 1980 + Math.floor(Math.random() * 25);
  const month = 1 + Math.floor(Math.random() * 12);
  const day = 1 + Math.floor(Math.random() * 28);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function randomCardNumber() {
  const groups = [];
  for (let i = 0; i < 4; i++) {
    groups.push(String(1000 + Math.floor(Math.random() * 8999)));
  }
  return groups.join('-');
}

function randomCardCVV() {
  return String(100 + Math.floor(Math.random() * 899));
}

function randomCardExpiry() {
  const month = 1 + Math.floor(Math.random() * 12);
  const year = 26 + Math.floor(Math.random() * 10);
  return `${String(month).padStart(2, '0')}/${year}`;
}

function randomUrl() {
  const slug = pick(['my-site', 'portfolio', 'blog', 'store', 'app']);
  return `https://${slug}.example.com`;
}

function randomNumber(min = 1, max = 100) {
  return String(min + Math.floor(Math.random() * (max - min)));
}

function randomText(words = 5) {
  const wordPool = ['test', 'sample', 'demo', 'validation', 'quality', 'automated', 'generated', 'input', 'data', 'value'];
  const parts = [];
  for (let i = 0; i < words; i++) {
    parts.push(pick(wordPool));
  }
  return parts.join(' ');
}

function randomUsername() {
  const first = pick(FIRST_NAMES).toLowerCase();
  const num = Math.floor(Math.random() * 999);
  return `${first}${num}`;
}

function randomPassword() {
  return `Test@${randomNumber(1000, 9999)}!`;
}

function randomSearchQuery() {
  const queries = ['test', 'sample', 'demo', 'product', 'item', 'search term', 'query'];
  return pick(queries);
}

// ── Main API ────────────────────────────────────────────────

/**
 * Generate realistic test data for a form field based on its metadata.
 * @param {object} field — Form field descriptor from the explorer snapshot
 * @param {string} field.type — Input type (text, email, tel, password, etc.)
 * @param {string} field.name — Field name attribute
 * @param {string} field.placeholder — Placeholder text
 * @param {string} field.ariaLabel — ARIA label
 * @returns {string} A realistic test value for the field
 */
function generateFieldValue(field) {
  const type = (field.type || 'text').toLowerCase();
  const name = (field.name || '').toLowerCase();
  const placeholder = (field.placeholder || '').toLowerCase();
  const ariaLabel = (field.ariaLabel || '').toLowerCase();

  // Combine all text attributes for pattern matching
  const allText = `${name} ${placeholder} ${ariaLabel}`;

  // ── Type-based matching (highest priority) ──
  switch (type) {
    case 'email':
      return randomEmail();
    case 'tel':
      return randomPhone();
    case 'password':
      return randomPassword();
    case 'url':
      return randomUrl();
    case 'date':
      return randomDate();
    case 'datetime-local':
      return `${randomDate()}T10:30`;
    case 'time':
      return '10:30';
    case 'month':
      return '2026-06';
    case 'week':
      return '2026-W26';
    case 'color':
      return '#3366cc';
    case 'range':
      return '50';
    case 'file':
      return ''; // Can't generate file uploads — skip
    case 'checkbox':
    case 'radio':
      return 'true';
    case 'number':
      return randomNumber(1, 100);
    case 'hidden':
      return ''; // Hidden fields shouldn't be filled
    case 'textarea':
      return randomText(10);
    case 'select':
    case 'select-one':
    case 'select-multiple':
      return ''; // Selects need options — handled by the planner
    default:
      break;
  }

  // ── Name/placeholder-based matching (fallback) ──
  if (/email|e-mail/.test(allText)) return randomEmail();
  if (/phone|tel|mobile|cell/.test(allText)) return randomPhone();
  if (/password|passwd|pwd/.test(allText)) return randomPassword();
  if (/username|user|login|userid|user_id/.test(allText)) return randomUsername();
  if (/first.?name|fname|given.?name/.test(allText)) return pick(FIRST_NAMES);
  if (/last.?name|lname|surname|family.?name/.test(allText)) return pick(LAST_NAMES);
  if (/full.?name|name$/.test(allText)) return `${pick(FIRST_NAMES)} ${pick(LAST_NAMES)}`;
  if (/company|organization|org|business/.test(allText)) return pick(COMPANIES);
  if (/address|street/.test(allText)) return pick(STREETS);
  if (/city|town/.test(allText)) return pick(CITIES);
  if (/state|province|region/.test(allText)) return pick(STATES);
  if (/zip|postal/.test(allText)) return pick(ZIPS);
  if (/country|nation/.test(allText)) return pick(COUNTRIES);
  if (/card|credit.?card|cc/.test(allText)) return randomCardNumber();
  if (/cvv|cvc|security.?code/.test(allText)) return randomCardCVV();
  if (/expir/.test(allText)) return randomCardExpiry();
  if (/url|website|link|domain/.test(allText)) return randomUrl();
  if (/date|dob|birthday/.test(allText)) return randomDate();
  if (/search|query|keyword|find/.test(allText)) return randomSearchQuery();
  if (/comment|message|description|feedback|note|body|content/.test(allText)) return randomText(10);
  if (/subject|title|topic/.test(allText)) return randomText(3);

  // ── Default: generic text ──
  return 'Test Input';
}

/**
 * Generate test data for all fields in a form.
 * @param {Array} fields — Array of field descriptors
 * @returns {object} Map of field name -> generated value
 */
function generateFormData(fields) {
  const data = {};
  for (const field of fields) {
    if (!field.name) continue;
    const value = generateFieldValue(field);
    if (value !== '') {
      data[field.name] = value;
    }
  }
  return data;
}

module.exports = { generateFieldValue, generateFormData };
