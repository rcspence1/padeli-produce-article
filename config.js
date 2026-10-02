/**
 * Centralized Constants and Lookups for Padeli
 *
 * Single source of truth for banned phrases, country mappings, currency
 * lookups, post types, word/image targets, and other shared config.
 *
 * Extracts duplicated constants from qc-validator.js, discover-clubs.js,
 * enrichment.js, create-listing.js, and blog SOP rules.
 *
 * Node.js v24+ — zero external dependencies — CommonJS
 */

const fs = require('fs');
const path = require('path');
const { SITE_URL } = require('./wp-client');

// ---------------------------------------------------------------------------
// Data directory
//
// Every module that persists state (pipeline ledger, tracker cache + backups,
// image gaps log, page index, Notion DB caches) resolves its files under ONE
// directory:
//
//   $PADELI_BLOG_DATA_DIR            if set (absolute path recommended)
//   <repo root>/data                 otherwise
//
// The directory is created on first use. It is git-ignored. Previously the
// modules resolved to ../data relative to the repo (i.e. ~/Projects/data),
// which does not exist on every machine.
// ---------------------------------------------------------------------------

const DATA_DIR = process.env.PADELI_BLOG_DATA_DIR
  ? path.resolve(process.env.PADELI_BLOG_DATA_DIR)
  : path.join(__dirname, 'data');

/**
 * Ensure DATA_DIR (or a sub-directory of it) exists and return its path.
 *
 * @param {...string} segments - optional sub-path segments
 * @returns {string} absolute path
 */
function ensureDataDir(...segments) {
  const dir = path.join(DATA_DIR, ...segments);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Resolve a file path under DATA_DIR, creating the parent directory.
 *
 * @param {...string} segments - path segments, the last one is the file name
 * @returns {string} absolute file path
 */
function dataPath(...segments) {
  const file = path.join(DATA_DIR, ...segments);
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return file;
}

// ---------------------------------------------------------------------------
// Banned / flagged phrase lists (from qc-validator.js)
// ---------------------------------------------------------------------------

/**
 * Full 19-phrase banned list. Used in body copy, FAQs, and hero hooks.
 */
const BANNED_PHRASES = [
  'located in the heart of',
  'state-of-the-art',
  'state of the art',
  'boasts',
  'boasting',
  'nestled',
  'vibrant community',
  'world-class facilities',
  'perfect for players of all levels',
  'look no further',
  'prestigious',
  'stunning facilities',
  'for all your padel needs',
  'second to none',
  'passion for padel',
  "whether you're a beginner or a seasoned pro",
  'renowned',
  'unparalleled',
  'haven for padel enthusiasts',
  'destination of choice',
];

/**
 * Extra banned phrases checked only in hero hooks.
 */
const HERO_HOOK_EXTRA_BANNED = [
  'state-of-the-art',
  'nestled',
  'world-class',
  'haven',
  'vibrant community',
  'perfect for players of all levels',
];

/**
 * Phrases that imply a personal visit (we don't visit venues).
 */
const PERSONAL_VISIT_PHRASES = [
  'we have played',
  'we visited',
  'we tested',
  'we tried',
];

/**
 * Mechanical transition openers that sound robotic.
 */
const MECHANICAL_TRANSITION_OPENERS = [
  'moreover',
  'furthermore',
  'additionally',
  'in addition',
  'consequently',
  'nevertheless',
];

// ---------------------------------------------------------------------------
// Country code -> full name mapping
// (union of discover-clubs.js + enrichment.js)
// ---------------------------------------------------------------------------

const COUNTRY_NAMES = {
  GB: 'United Kingdom', UK: 'United Kingdom',
  US: 'United States', CA: 'Canada', AU: 'Australia',
  DE: 'Germany', FR: 'France', ES: 'Spain', IT: 'Italy',
  NL: 'Netherlands', BE: 'Belgium', SE: 'Sweden', DK: 'Denmark',
  NO: 'Norway', FI: 'Finland', PT: 'Portugal', AT: 'Austria',
  CH: 'Switzerland', IE: 'Ireland', PL: 'Poland', CZ: 'Czech Republic',
  AE: 'United Arab Emirates', SA: 'Saudi Arabia', QA: 'Qatar', BH: 'Bahrain',
  MX: 'Mexico', BR: 'Brazil', AR: 'Argentina', CL: 'Chile',
  IN: 'India', JP: 'Japan', KR: 'South Korea', SG: 'Singapore',
  MY: 'Malaysia', TH: 'Thailand', ID: 'Indonesia', PH: 'Philippines',
  ZA: 'South Africa', EG: 'Egypt', KE: 'Kenya', NG: 'Nigeria',
};

// ---------------------------------------------------------------------------
// Currency lookup (from create-listing.js)
// ---------------------------------------------------------------------------

/**
 * Return the display currency string for a country code or name.
 *
 * @param {string} countryCodeOrName - e.g. 'GB', 'US', 'BALI'
 * @returns {string} Currency string like 'GBP (£)' or 'EUR (€)' as default
 */
function getCurrency(countryCodeOrName) {
  const code = (countryCodeOrName || '').toUpperCase();
  const map = {
    'GB': 'GBP (£)', 'UK': 'GBP (£)', 'UNITED KINGDOM': 'GBP (£)',
    'US': 'USD ($)', 'USA': 'USD ($)', 'UNITED STATES': 'USD ($)',
    'ID': 'IDR', 'INDONESIA': 'IDR', 'BALI': 'IDR',
    'AE': 'AED', 'UAE': 'AED', 'UNITED ARAB EMIRATES': 'AED',
    'DE': 'EUR (€)', 'GERMANY': 'EUR (€)',
    'ES': 'EUR (€)', 'SPAIN': 'EUR (€)',
    'FR': 'EUR (€)', 'FRANCE': 'EUR (€)',
    'IT': 'EUR (€)', 'ITALY': 'EUR (€)',
    'AU': 'AUD (A$)', 'AUSTRALIA': 'AUD (A$)',
    'SG': 'SGD (S$)', 'SINGAPORE': 'SGD (S$)',
    'TH': 'THB (฿)', 'THAILAND': 'THB (฿)',
    'PT': 'EUR (€)', 'PORTUGAL': 'EUR (€)',
    'QA': 'QAR', 'QATAR': 'QAR',
    'SA': 'SAR', 'SAUDI ARABIA': 'SAR',
    'SE': 'SEK', 'SWEDEN': 'SEK',
    'DK': 'DKK', 'DENMARK': 'DKK',
    'NO': 'NOK', 'NORWAY': 'NOK',
  };
  return map[code] || 'EUR (€)';
}

// ---------------------------------------------------------------------------
// English variant lookup (from create-listing.js)
// ---------------------------------------------------------------------------

/**
 * Return 'US English' or 'British English' based on country code.
 *
 * @param {string} countryCodeOrName - e.g. 'GB', 'US', 'CA'
 * @returns {string} 'US English' | 'British English'
 */
function getEnglishVariant(countryCodeOrName) {
  const code = (countryCodeOrName || '').toUpperCase();
  const usVariants = ['US', 'USA', 'UNITED STATES', 'CA', 'CANADA'];
  return usVariants.includes(code) ? 'US English' : 'British English';
}

// ---------------------------------------------------------------------------
// Banned sources (from blog SOP)
// ---------------------------------------------------------------------------

/**
 * Domains that must never be cited or linked to in blog content.
 */
const BANNED_SOURCES = [
  'hidubai.com',
  'timeoutdubai.com',
  'whatson.ae',
  'provenexpert.com',
];

// ---------------------------------------------------------------------------
// Post types and content targets (for blog pipeline)
// ---------------------------------------------------------------------------

/**
 * Blog post type constants.
 */
const POST_TYPES = {
  CITY_LISTICLE: 'city_listicle',
  PRODUCT_LISTICLE: 'product_listicle',
  PILLAR: 'pillar',
  CLUSTER: 'cluster',
  LEAF: 'leaf',
};

/**
 * Target word count ranges [min, max] by post type.
 */
const WORD_COUNT_TARGETS = {
  city_listicle: [2500, 4500],
  product_listicle: [2500, 4500],
  pillar: [2500, 4500],
  cluster: [1200, 2000],
  leaf: [800, 1500],
};

/**
 * Target image count ranges [min, max] by post type.
 */
const IMAGE_COUNT_TARGETS = {
  city_listicle: [6, 12],
  product_listicle: [7, 10],
  pillar: [5, 8],
  cluster: [4, 7],
  leaf: [2, 3],
};

// ---------------------------------------------------------------------------
// Display currency lookup (for in-article price conversions)
// ---------------------------------------------------------------------------

/**
 * Local currency is what the venue charges in (IDR, AED, GBP, etc.)
 * Display currency is what the reader converts to mentally.
 */
const DISPLAY_CURRENCY = {
  UK: 'GBP', GB: 'GBP',
  US: 'USD', CA: 'USD',
  AU: 'AUD',
  ID: 'GBP',   // Bali content targets British/European audience
  AE: 'GBP',   // Dubai content targets British/European audience
  ES: 'EUR', PT: 'EUR', IT: 'EUR', FR: 'EUR', DE: 'EUR', NL: 'EUR', SE: 'EUR',
  TH: 'GBP',   // Thailand targets British/European audience
  MX: 'USD',
};

/**
 * Return the currency to use for CONVERSIONS in article text -
 * i.e., what currency the reader thinks in.
 *
 * @param {string} countryCode - e.g. 'GB', 'ID', 'AE'
 * @returns {string} Currency code like 'GBP', 'EUR', 'USD'
 */
function getDisplayCurrency(countryCode) {
  return DISPLAY_CURRENCY[countryCode?.toUpperCase()] || 'GBP';
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  SITE_URL,
  DATA_DIR,
  ensureDataDir,
  dataPath,
  BANNED_PHRASES,
  HERO_HOOK_EXTRA_BANNED,
  PERSONAL_VISIT_PHRASES,
  MECHANICAL_TRANSITION_OPENERS,
  COUNTRY_NAMES,
  getCurrency,
  getDisplayCurrency,
  getEnglishVariant,
  BANNED_SOURCES,
  POST_TYPES,
  WORD_COUNT_TARGETS,
  IMAGE_COUNT_TARGETS,
};
