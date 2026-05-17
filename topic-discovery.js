/**
 * topic-discovery.js — Automated topic discovery and tracker population for Padeli blog.
 *
 * Generates keyword-driven blog post topics by market/region,
 * cross-references existing live posts on padeli.com,
 * and writes approved topics into the blog tracker.
 *
 * Node.js v24+, zero external deps, CommonJS.
 *
 * CLI:
 *   node topic-discovery.js discover AU                    # discover topics for Australia
 *   node topic-discovery.js discover UK --gaps-only        # only show gaps (not already live)
 *   node topic-discovery.js discover all                   # all markets
 *   node topic-discovery.js populate AU --status approved  # write AU topics to tracker
 *   node topic-discovery.js populate AU --status proposed  # write as proposed (default)
 *   node topic-discovery.js live-slugs                     # fetch all live slugs from WP
 *   node topic-discovery.js summary                        # show coverage summary
 */

const { POST_TYPES } = require('./config');
const { addPost, getPost, loadTracker } = require('./blog-tracker');
const { wpGet } = require('./wp-client');

// ---------------------------------------------------------------------------
// Market definitions — cities, country codes, pillar slugs
// ---------------------------------------------------------------------------

const MARKETS = {
  // --- ACTIVE MARKETS (from Content Domination Strategy) ---
  UK: {
    code: 'UK',
    country: 'United Kingdom',
    pillar_slug: 'complete-guide-padel-uk-2026',
    cities: [
      // Already covered (will be filtered by cross-ref)
      { name: 'London', slug: 'london', sub_areas: ['central-london', 'east-london', 'south-london', 'west-london', 'canary-wharf', 'battersea'] },
      { name: 'Manchester', slug: 'manchester' },
      { name: 'Birmingham', slug: 'birmingham' },
      { name: 'Leeds', slug: 'leeds' },
      { name: 'Liverpool', slug: 'liverpool' },
      { name: 'Edinburgh', slug: 'edinburgh' },
      { name: 'Glasgow', slug: 'glasgow' },
      { name: 'Newcastle', slug: 'newcastle' },
      { name: 'Bristol', slug: 'bristol' },
      { name: 'Sheffield', slug: 'sheffield' },
      { name: 'Nottingham', slug: 'nottingham' },
      { name: 'Brighton', slug: 'brighton' },
      { name: 'Wales', slug: 'wales' },
      { name: 'Scotland', slug: 'scotland' },
      // Gaps
      { name: 'Oxford', slug: 'oxford' },
      { name: 'Cambridge', slug: 'cambridge' },
      { name: 'Bath', slug: 'bath' },
      { name: 'Southampton', slug: 'southampton' },
      { name: 'Cardiff', slug: 'cardiff' },
      { name: 'Belfast', slug: 'belfast' },
      { name: 'York', slug: 'york' },
      { name: 'Exeter', slug: 'exeter' },
      { name: 'Leicester', slug: 'leicester' },
      { name: 'Coventry', slug: 'coventry' },
      { name: 'Aberdeen', slug: 'aberdeen' },
      { name: 'Derby', slug: 'derby' },
      { name: 'Plymouth', slug: 'plymouth' },
      { name: 'Cheltenham', slug: 'cheltenham' },
      { name: 'Reading', slug: 'reading' },
      { name: 'Surrey', slug: 'surrey' },
      { name: 'Kent', slug: 'kent' },
      { name: 'Essex', slug: 'essex' },
      { name: 'North London', slug: 'north-london' },
    ],
  },

  AU: {
    code: 'AU',
    country: 'Australia',
    pillar_slug: 'padel-australia-2026',
    cities: [
      { name: 'Sydney', slug: 'sydney' },
      { name: 'Melbourne', slug: 'melbourne' },
      { name: 'Brisbane', slug: 'brisbane' },
      { name: 'Perth', slug: 'perth' },
      { name: 'Adelaide', slug: 'adelaide' },
      { name: 'Gold Coast', slug: 'gold-coast' },
      { name: 'Canberra', slug: 'canberra' },
      { name: 'Newcastle', slug: 'newcastle-australia' },
      { name: 'Hobart', slug: 'hobart' },
      { name: 'Sunshine Coast', slug: 'sunshine-coast' },
    ],
  },

  AE: {
    code: 'AE',
    country: 'UAE',
    pillar_slug: 'padel-dubai-2026',
    cities: [
      { name: 'Dubai', slug: 'dubai' },
      { name: 'Abu Dhabi', slug: 'abu-dhabi' },
      { name: 'Sharjah', slug: 'sharjah' },
      { name: 'Al Ain', slug: 'al-ain' },
    ],
  },

  US: {
    code: 'US',
    country: 'United States',
    pillar_slug: null,
    cities: [
      { name: 'New York', slug: 'new-york' },
      { name: 'Los Angeles', slug: 'los-angeles' },
      { name: 'Miami', slug: 'miami' },
      { name: 'Austin', slug: 'austin' },
      { name: 'Dallas', slug: 'dallas' },
      { name: 'Houston', slug: 'houston' },
      { name: 'Chicago', slug: 'chicago' },
      { name: 'San Francisco', slug: 'san-francisco' },
      { name: 'Boston', slug: 'boston' },
      { name: 'Denver', slug: 'denver' },
      { name: 'San Diego', slug: 'san-diego' },
      { name: 'Phoenix', slug: 'phoenix' },
      { name: 'Atlanta', slug: 'atlanta' },
      { name: 'Seattle', slug: 'seattle' },
      { name: 'Las Vegas', slug: 'las-vegas' },
    ],
  },

  ID: {
    code: 'ID',
    country: 'Indonesia',
    pillar_slug: 'padel-indonesia-2026',
    cities: [
      { name: 'Bali', slug: 'bali', sub_areas: ['canggu', 'ubud', 'kuta', 'uluwatu', 'jimbaran', 'sanur', 'nusa-dua', 'seminyak'] },
      { name: 'Jakarta', slug: 'jakarta' },
      { name: 'Surabaya', slug: 'surabaya' },
      { name: 'Bandung', slug: 'bandung' },
    ],
  },

  ES: {
    code: 'ES',
    country: 'Spain',
    pillar_slug: 'padel-spain-2026',
    cities: [
      { name: 'Madrid', slug: 'madrid' },
      { name: 'Barcelona', slug: 'barcelona' },
      { name: 'Valencia', slug: 'valencia' },
      { name: 'Marbella', slug: 'marbella' },
      { name: 'Malaga', slug: 'malaga' },
      { name: 'Seville', slug: 'seville' },
      { name: 'Alicante', slug: 'alicante' },
    ],
  },

  PT: {
    code: 'PT',
    country: 'Portugal',
    pillar_slug: 'padel-portugal-2026',
    cities: [
      { name: 'Lisbon', slug: 'lisbon' },
      { name: 'Porto', slug: 'porto' },
      { name: 'Algarve', slug: 'algarve' },
      { name: 'Cascais', slug: 'cascais' },
    ],
  },

  SG: {
    code: 'SG',
    country: 'Singapore',
    pillar_slug: 'padel-singapore-2026',
    cities: [
      { name: 'Singapore', slug: 'singapore' },
    ],
  },

  TH: {
    code: 'TH',
    country: 'Thailand',
    pillar_slug: 'padel-thailand-2026',
    cities: [
      { name: 'Bangkok', slug: 'bangkok' },
      { name: 'Phuket', slug: 'phuket' },
      { name: 'Chiang Mai', slug: 'chiang-mai' },
    ],
  },

  SA: {
    code: 'SA',
    country: 'Saudi Arabia',
    pillar_slug: null,
    cities: [
      { name: 'Riyadh', slug: 'riyadh' },
      { name: 'Jeddah', slug: 'jeddah' },
    ],
  },

  QA: {
    code: 'QA',
    country: 'Qatar',
    pillar_slug: null,
    cities: [
      { name: 'Doha', slug: 'doha' },
    ],
  },
};

// ---------------------------------------------------------------------------
// Post templates — 24-template strategy (5 pillars, geo/currency/global)
// See Notion page 35fd1b51-fb30-819b-9bce-cefc3b10ef8b for full strategy.
// ---------------------------------------------------------------------------

/**
 * LOCATION PILLAR — City-level templates. Each generates one post per city.
 * Pillar: /clubs/. BV = Business Value (0-3).
 * {city} and {year} are replaced at generation time.
 */
const CITY_TEMPLATES = [
  // --- #1 Location: Best courts cornerstone ---
  {
    id: 'courts',
    slug: 'best-padel-courts-{city}-2026',
    title: 'Best Padel Courts in {City} 2026',
    focus_keyword: 'best padel courts in {City} 2026',
    post_type: 'city_listicle',
    tier: 'cornerstone',
    category: 'Where to Play',
    pillar: 'location',
    business_value: 3,
    priority: 1,
  },
  // --- #2 Location: Beginner-filtered courts ---
  {
    id: 'beginner-courts',
    slug: 'best-padel-courts-beginners-{city}-2026',
    title: 'Best Padel Courts for Beginners in {City} 2026',
    focus_keyword: 'best padel courts for beginners {City} 2026',
    post_type: 'cluster',
    tier: 'cluster',
    category: 'Where to Play',
    pillar: 'location',
    business_value: 3,
    priority: 2,
  },
  // --- #3 Location: Indoor courts ---
  {
    id: 'indoor',
    slug: 'indoor-padel-courts-{city}-2026',
    title: 'Indoor Padel Courts in {City} 2026',
    focus_keyword: 'indoor padel courts {City} 2026',
    post_type: 'cluster',
    tier: 'cluster',
    category: 'Where to Play',
    pillar: 'location',
    business_value: 2,
    priority: 3,
  },
  // --- #4 Location: Cost guide ---
  {
    id: 'cost',
    slug: 'padel-cost-{city}-2026',
    title: 'How Much Does Padel Cost in {City}? 2026 Pricing Guide',
    focus_keyword: 'padel cost {City} 2026',
    post_type: 'cluster',
    tier: 'cluster',
    category: 'Where to Play',
    pillar: 'location',
    business_value: 2,
    priority: 3,
  },
  // --- #5 Location: City pillar ---
  {
    id: 'city-guide',
    slug: 'padel-in-{city}-complete-guide-2026',
    title: 'Padel in {City}: Complete Guide 2026',
    focus_keyword: 'padel in {City} 2026',
    post_type: 'pillar',
    tier: 'cornerstone',
    category: 'Where to Play',
    pillar: 'location',
    business_value: 2,
    priority: 2,
  },
  // --- #6 Location: Courts with amenities ---
  {
    id: 'amenity-courts',
    slug: 'padel-courts-gym-pool-{city}-2026',
    title: 'Best Padel Courts with Gym/Pool in {City} 2026',
    focus_keyword: 'padel courts with gym {City} 2026',
    post_type: 'cluster',
    tier: 'cluster',
    category: 'Where to Play',
    pillar: 'location',
    business_value: 2,
    priority: 4,
  },
  // --- #9 Coaching: Coach directory ---
  {
    id: 'coaches',
    slug: 'best-padel-coaches-{city}-2026',
    title: 'Best Padel Coaches in {City} 2026',
    focus_keyword: 'best padel coaches {City} 2026',
    post_type: 'city_listicle',
    tier: 'cornerstone',
    category: 'Coaching & Training',
    pillar: 'coaching',
    business_value: 3,
    priority: 2,
  },
  // --- #10 Coaching: Private vs group ---
  {
    id: 'private-vs-group',
    slug: 'private-vs-group-padel-lessons-{city}-2026',
    title: 'Private vs Group Padel Lessons in {City} 2026',
    focus_keyword: 'private vs group padel lessons {City} 2026',
    post_type: 'cluster',
    tier: 'cluster',
    category: 'Coaching & Training',
    pillar: 'coaching',
    business_value: 2,
    priority: 3,
  },
  // --- #11 Coaching: Beginner coaching ---
  {
    id: 'beginner-coaching',
    slug: 'padel-coaching-beginners-{city}-2026',
    title: 'Best Padel Coaching for Beginners in {City} 2026',
    focus_keyword: 'padel coaching for beginners {City} 2026',
    post_type: 'cluster',
    tier: 'cluster',
    category: 'Coaching & Training',
    pillar: 'coaching',
    business_value: 3,
    priority: 3,
  },
  // --- Legacy city templates (kept for coverage) ---
  {
    id: 'leagues',
    slug: 'padel-leagues-{city}-2026',
    title: 'Padel Leagues and Social Sessions in {City} 2026',
    focus_keyword: 'padel leagues {City} 2026',
    post_type: 'leaf',
    tier: 'leaf',
    category: 'Events',
    pillar: 'lifestyle',
    business_value: 1,
    priority: 5,
  },
  {
    id: 'events',
    slug: 'padel-events-{city}-2026',
    title: 'Padel Events and Tournaments in {City} 2026',
    focus_keyword: 'padel events {City} 2026',
    post_type: 'leaf',
    tier: 'leaf',
    category: 'Events',
    pillar: 'lifestyle',
    business_value: 1,
    priority: 5,
  },
  {
    id: 'junior',
    slug: 'junior-padel-{city}-2026',
    title: 'Junior Padel in {City} 2026 - Getting Kids Into the Game',
    focus_keyword: 'junior padel {City} 2026',
    post_type: 'leaf',
    tier: 'leaf',
    category: 'Juniors',
    pillar: 'coaching',
    business_value: 1,
    priority: 6,
  },
];

/**
 * LOCATION + COACHING PILLAR — Country-level templates. One per market.
 */
const COUNTRY_TEMPLATES = [
  {
    id: 'country-guide',
    slug: 'padel-in-{country_slug}-2026',
    title: 'Padel in {Country} 2026 - Complete Guide',
    focus_keyword: 'padel in {Country} 2026',
    post_type: 'pillar',
    tier: 'cornerstone',
    category: 'Where to Play',
    pillar: 'location',
    business_value: 2,
    priority: 0,
  },
  {
    id: 'country-coaching',
    slug: 'padel-coaching-{country_slug}-2026',
    title: 'Padel Coaching in {Country} 2026 - Complete Guide',
    focus_keyword: 'padel coaching {Country} 2026',
    post_type: 'cluster',
    tier: 'cluster',
    category: 'Coaching & Training',
    pillar: 'coaching',
    business_value: 2,
    priority: 2,
  },
  {
    id: 'country-cost',
    slug: 'padel-cost-{country_slug}-2026',
    title: 'How Much Does Padel Cost in {Country} 2026?',
    focus_keyword: 'padel cost {Country} 2026',
    post_type: 'cluster',
    tier: 'cluster',
    category: 'Where to Play',
    pillar: 'location',
    business_value: 2,
    priority: 3,
  },
  {
    id: 'country-events',
    slug: 'padel-events-tournaments-{country_slug}-2026',
    title: 'Padel Events and Tournaments in {Country} 2026',
    focus_keyword: 'padel events {Country} 2026',
    post_type: 'cluster',
    tier: 'cluster',
    category: 'Events',
    pillar: 'lifestyle',
    business_value: 1,
    priority: 3,
  },
  {
    id: 'country-beginners',
    slug: 'beginners-guide-padel-{country_slug}-2026',
    title: "Beginner's Guide to Padel in {Country} 2026",
    focus_keyword: 'padel for beginners {Country} 2026',
    post_type: 'cluster',
    tier: 'cluster',
    category: 'Getting Started',
    pillar: 'coaching',
    business_value: 1,
    priority: 4,
  },
  {
    id: 'country-holidays',
    slug: 'padel-holidays-{country_slug}-2026',
    title: 'Padel Holidays in {Country} 2026',
    focus_keyword: 'padel holidays {Country} 2026',
    post_type: 'cluster',
    tier: 'cluster',
    category: 'Padel Holidays',
    pillar: 'lifestyle',
    business_value: 1,
    priority: 4,
  },
  // --- #23 Lifestyle: Growth stats per country ---
  {
    id: 'country-growth',
    slug: 'is-padel-growing-{country_slug}-2026',
    title: 'Is Padel Growing in {Country}? 2026 Stats & Trends',
    focus_keyword: 'is padel growing in {Country} 2026',
    post_type: 'cluster',
    tier: 'cluster',
    category: 'Where to Play',
    pillar: 'lifestyle',
    business_value: 1,
    priority: 4,
  },
];

/**
 * GEAR PILLAR — Currency-multiplied templates.
 * Generated once per currency (GBP/USD/EUR). Affiliate revenue.
 * {currency_symbol}, {currency_code} replaced at generation time.
 */
const GEAR_TEMPLATES = [
  // --- #12 Gear: Price-band rackets ---
  {
    id: 'rackets-under-100',
    slug: 'best-padel-rackets-under-{currency_code}100-2026',
    title: 'Best Padel Rackets Under {currency_symbol}100 in 2026',
    focus_keyword: 'best padel rackets under {currency_symbol}100 2026',
    post_type: 'product_listicle',
    tier: 'cornerstone',
    category: 'Equipment',
    pillar: 'gear',
    business_value: 3,
    priority: 1,
    price_bands: [100, 200, 300],
  },
  // --- #13 Gear: Beginner rackets ---
  {
    id: 'rackets-beginners',
    slug: 'best-padel-rackets-beginners-2026',
    title: 'Best Padel Rackets for Beginners 2026',
    focus_keyword: 'best padel rackets for beginners 2026',
    post_type: 'product_listicle',
    tier: 'cornerstone',
    category: 'Equipment',
    pillar: 'gear',
    business_value: 3,
    priority: 1,
    per_currency: false,
  },
  // --- #14 Gear: Player-type rackets ---
  {
    id: 'rackets-player-type',
    slug: 'best-padel-rackets-{player_type}-2026',
    title: 'Best Padel Rackets for {Player_Type} 2026',
    focus_keyword: 'best padel rackets for {player_type} 2026',
    post_type: 'product_listicle',
    tier: 'cornerstone',
    category: 'Equipment',
    pillar: 'gear',
    business_value: 3,
    priority: 1,
    player_types: ['women', 'intermediate', 'advanced', 'power', 'control', 'juniors'],
  },
  // --- #15 Gear: Brand comparisons ---
  {
    id: 'brand-vs-brand',
    slug: '{brand_a}-vs-{brand_b}-padel-rackets-2026',
    title: '{Brand_A} vs {Brand_B} Padel Rackets 2026',
    focus_keyword: '{brand_a} vs {brand_b} padel rackets 2026',
    post_type: 'cluster',
    tier: 'cluster',
    category: 'Equipment',
    pillar: 'gear',
    business_value: 2,
    priority: 3,
    brand_pairs: [
      ['bullpadel', 'nox'], ['adidas', 'wilson'], ['head', 'babolat'],
      ['bullpadel', 'head'], ['nox', 'adidas'],
    ],
  },
  // --- #16 Gear: Shoes ---
  {
    id: 'shoes',
    slug: 'best-padel-shoes-2026',
    title: 'Best Padel Shoes 2026',
    focus_keyword: 'best padel shoes 2026',
    post_type: 'product_listicle',
    tier: 'cornerstone',
    category: 'Equipment',
    pillar: 'gear',
    business_value: 3,
    priority: 1,
    per_currency: false,
  },
  // --- #17 Gear: Bags ---
  {
    id: 'bags',
    slug: 'best-padel-bags-2026',
    title: 'Best Padel Bags 2026',
    focus_keyword: 'best padel bags 2026',
    post_type: 'product_listicle',
    tier: 'cornerstone',
    category: 'Equipment',
    pillar: 'gear',
    business_value: 2,
    priority: 2,
    per_currency: false,
  },
  // --- #18 Gear: Balls ---
  {
    id: 'balls',
    slug: 'best-padel-balls-2026',
    title: 'Best Padel Balls 2026',
    focus_keyword: 'best padel balls 2026',
    post_type: 'cluster',
    tier: 'cluster',
    category: 'Equipment',
    pillar: 'gear',
    business_value: 2,
    priority: 3,
    per_currency: false,
  },
];

/**
 * TECHNIQUE + LIFESTYLE — Universal templates (no geo, no currency).
 * Authority builders and LLM citation targets.
 */
const GLOBAL_TEMPLATES = [
  // --- #20 Technique: Shot guides ---
  {
    id: 'shot-guide',
    slug: 'how-to-hit-{shot_type}-padel',
    title: 'How to Hit a {Shot_Type} in Padel - Complete Guide',
    focus_keyword: 'how to hit a {shot_type} in padel',
    post_type: 'cluster',
    tier: 'cluster',
    category: 'Improve Your Game',
    pillar: 'technique',
    business_value: 1,
    priority: 4,
    shot_types: ['bandeja', 'vibora', 'volley', 'smash', 'serve', 'lob'],
  },
  // --- #21 Technique: Rules guide ---
  {
    id: 'rules',
    slug: 'padel-rules-complete-guide-beginners',
    title: 'Padel Rules: Complete Guide for Beginners',
    focus_keyword: 'padel rules',
    post_type: 'pillar',
    tier: 'cornerstone',
    category: 'Getting Started',
    pillar: 'technique',
    business_value: 1,
    priority: 2,
  },
  // --- #22 Lifestyle: Padel vs X ---
  {
    id: 'padel-vs',
    slug: 'padel-vs-{sport}',
    title: 'Padel vs {Sport}: Which Sport Is Right for You?',
    focus_keyword: 'padel vs {sport}',
    post_type: 'cluster',
    tier: 'cornerstone',
    category: 'Getting Started',
    pillar: 'lifestyle',
    business_value: 1,
    priority: 3,
    sports: ['tennis', 'pickleball', 'squash'],
  },
  // --- #24 Lifestyle: What is padel ---
  {
    id: 'what-is-padel',
    slug: 'what-is-padel-complete-beginner-guide',
    title: 'What is Padel? Complete Beginner Guide',
    focus_keyword: 'what is padel',
    post_type: 'pillar',
    tier: 'cornerstone',
    category: 'Getting Started',
    pillar: 'lifestyle',
    business_value: 1,
    priority: 2,
  },
];

// ---------------------------------------------------------------------------
// Slug helpers
// ---------------------------------------------------------------------------

function slugify(str) {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

function fillTemplate(template, vars) {
  let s = template;
  for (const [key, val] of Object.entries(vars)) {
    s = s.replaceAll(`{${key}}`, val);
  }
  return s;
}

// ---------------------------------------------------------------------------
// Fetch live slugs from WP REST API
// ---------------------------------------------------------------------------

/**
 * Fetch all published post slugs from padeli.com via WP REST API.
 * Paginates through all pages (100 per page).
 *
 * @returns {Promise<Set<string>>} Set of slug strings
 */
async function fetchLiveSlugs() {
  const slugs = new Set();
  let page = 1;
  const perPage = 100;

  while (true) {
    const endpoint = `/wp-json/wp/v2/posts?per_page=${perPage}&page=${page}&_fields=slug&status=publish`;
    try {
      const posts = await wpGet(endpoint);
      if (!Array.isArray(posts) || posts.length === 0) break;
      for (const p of posts) {
        slugs.add(p.slug);
      }
      if (posts.length < perPage) break;
      page++;
    } catch (err) {
      // WP returns 400 when page exceeds max — that's our stop signal
      if (err.message && err.message.includes('400')) break;
      throw err;
    }
  }

  return slugs;
}

// ---------------------------------------------------------------------------
// Topic generation
// ---------------------------------------------------------------------------

/**
 * Generate all possible topics for a market.
 *
 * @param {string} marketCode - Market code (e.g. 'AU', 'UK')
 * @returns {object[]} Array of topic objects ready for addPost()
 */
function generateTopics(marketCode) {
  const market = MARKETS[marketCode];
  if (!market) throw new Error(`Unknown market: ${marketCode}. Valid: ${Object.keys(MARKETS).join(', ')}`);

  const topics = [];
  const countrySlug = slugify(market.country);

  // 1. Country-level posts
  for (const tmpl of COUNTRY_TEMPLATES) {
    const slug = fillTemplate(tmpl.slug, { country_slug: countrySlug });
    const title = fillTemplate(tmpl.title, { Country: market.country });
    const keyword = fillTemplate(tmpl.focus_keyword, { Country: market.country });

    topics.push({
      slug,
      title,
      focus_keyword: keyword,
      post_type: tmpl.post_type,
      tier: tmpl.tier,
      market: marketCode,
      category: tmpl.category,
      pillar_slug: market.pillar_slug,
      country_code: market.code,
      priority: tmpl.priority,
      business_value: tmpl.business_value,
      template_id: tmpl.id,
      level: 'country',
    });
  }

  // 2. City-level posts
  for (const city of market.cities) {
    for (const tmpl of CITY_TEMPLATES) {
      const slug = fillTemplate(tmpl.slug, { city: city.slug });
      const title = fillTemplate(tmpl.title, { City: city.name });
      const keyword = fillTemplate(tmpl.focus_keyword, { City: city.name });

      topics.push({
        slug,
        title,
        focus_keyword: keyword,
        post_type: tmpl.post_type,
        tier: tmpl.tier,
        market: marketCode,
        category: tmpl.category,
        pillar_slug: market.pillar_slug,
        country_code: market.code,
        priority: tmpl.priority,
        business_value: tmpl.business_value,
        template_id: tmpl.id,
        level: 'city',
        city: city.name,
      });
    }

    // 3. Sub-area posts (e.g. London → Central London, East London)
    if (city.sub_areas) {
      for (const sub of city.sub_areas) {
        const subName = sub.split('-').map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
        // Only generate the cornerstone city listicle for sub-areas
        const tmpl = CITY_TEMPLATES[0]; // courts template
        const slug = fillTemplate(tmpl.slug, { city: sub });
        const title = fillTemplate(tmpl.title, { City: subName });
        const keyword = fillTemplate(tmpl.focus_keyword, { City: subName });

        topics.push({
          slug,
          title,
          focus_keyword: keyword,
          post_type: 'city_listicle',
          tier: 'cluster', // sub-areas are cluster, not cornerstone
          market: marketCode,
          category: 'Where to Play',
          pillar_slug: `best-padel-courts-${city.slug}-2026`,
          country_code: market.code,
          priority: 2,
          business_value: 3,
          template_id: 'sub-area-courts',
          level: 'sub_area',
          city: subName,
          parent_city: city.name,
        });
      }
    }
  }

  // 4. Gear-level posts (currency-multiplied or standalone)
  //    Only generate once to avoid duplicates across markets.
  //    Trigger on 'UK' (first/primary market) or when called with 'all'.
  if (marketCode === 'UK' || marketCode === 'all') {
  const CURRENCIES = [
    { symbol: '£', code: 'GBP' },
    { symbol: '$', code: 'USD' },
    { symbol: '€', code: 'EUR' },
  ];

  for (const tmpl of GEAR_TEMPLATES) {
    if (tmpl.price_bands) {
      // One topic per price band per currency
      for (const cur of CURRENCIES) {
        for (const band of tmpl.price_bands) {
          const vars = { currency_symbol: cur.symbol, currency_code: cur.code.toLowerCase() };
          const bandSlug = tmpl.slug.replace('100', String(band));
          const bandTitle = tmpl.title.replace('100', String(band));
          const bandKeyword = tmpl.focus_keyword.replace('100', String(band));

          topics.push({
            slug: fillTemplate(bandSlug, vars),
            title: fillTemplate(bandTitle, vars),
            focus_keyword: fillTemplate(bandKeyword, vars),
            post_type: tmpl.post_type,
            tier: tmpl.tier,
            market: marketCode,
            category: tmpl.category,
            pillar_slug: market.pillar_slug,
            country_code: market.code,
            template_id: `${tmpl.id}-${cur.code.toLowerCase()}-${band}`,
            level: 'gear',
            priority: tmpl.priority,
            business_value: tmpl.business_value,
            city: null,
          });
        }
      }
    } else if (tmpl.player_types) {
      // One topic per player type
      for (const pt of tmpl.player_types) {
        const ptTitle = pt[0].toUpperCase() + pt.slice(1);
        const vars = { player_type: pt, Player_Type: ptTitle };

        topics.push({
          slug: fillTemplate(tmpl.slug, vars),
          title: fillTemplate(tmpl.title, vars),
          focus_keyword: fillTemplate(tmpl.focus_keyword, vars),
          post_type: tmpl.post_type,
          tier: tmpl.tier,
          market: marketCode,
          category: tmpl.category,
          pillar_slug: market.pillar_slug,
          country_code: market.code,
          template_id: `${tmpl.id}-${pt}`,
          level: 'gear',
          priority: tmpl.priority,
          business_value: tmpl.business_value,
          city: null,
        });
      }
    } else if (tmpl.brand_pairs) {
      // One topic per brand pair
      for (const [a, b] of tmpl.brand_pairs) {
        const aTitle = a[0].toUpperCase() + a.slice(1);
        const bTitle = b[0].toUpperCase() + b.slice(1);
        const vars = { brand_a: a, brand_b: b, Brand_A: aTitle, Brand_B: bTitle };

        topics.push({
          slug: fillTemplate(tmpl.slug, vars),
          title: fillTemplate(tmpl.title, vars),
          focus_keyword: fillTemplate(tmpl.focus_keyword, vars),
          post_type: tmpl.post_type,
          tier: tmpl.tier,
          market: marketCode,
          category: tmpl.category,
          pillar_slug: market.pillar_slug,
          country_code: market.code,
          template_id: `${tmpl.id}-${a}-${b}`,
          level: 'gear',
          priority: tmpl.priority,
          business_value: tmpl.business_value,
          city: null,
        });
      }
    } else if (tmpl.per_currency === false) {
      // Generate once (no currency multiplication)
      topics.push({
        slug: tmpl.slug,
        title: tmpl.title,
        focus_keyword: tmpl.focus_keyword,
        post_type: tmpl.post_type,
        tier: tmpl.tier,
        market: marketCode,
        category: tmpl.category,
        pillar_slug: market.pillar_slug,
        country_code: market.code,
        template_id: tmpl.id,
        level: 'gear',
        priority: tmpl.priority,
        business_value: tmpl.business_value,
        city: null,
      });
    }
  }

  } // end gear guard (marketCode === 'UK' || 'all')

  // 5. Global posts (technique + lifestyle — NOT market-specific)
  //    Only generate once to avoid duplicates across markets.
  //    Trigger on 'UK' (first/primary market) or when called with 'all'.
  if (marketCode === 'UK' || marketCode === 'all') {
    for (const tmpl of GLOBAL_TEMPLATES) {
      if (tmpl.shot_types) {
        for (const shot of tmpl.shot_types) {
          const shotTitle = shot[0].toUpperCase() + shot.slice(1);
          const vars = { shot_type: shot, Shot_Type: shotTitle };

          topics.push({
            slug: fillTemplate(tmpl.slug, vars),
            title: fillTemplate(tmpl.title, vars),
            focus_keyword: fillTemplate(tmpl.focus_keyword, vars),
            post_type: tmpl.post_type,
            tier: tmpl.tier,
            market: 'GLOBAL',
            category: tmpl.category,
            pillar_slug: null,
            country_code: null,
            template_id: `${tmpl.id}-${shot}`,
            level: 'global',
            priority: tmpl.priority,
            business_value: tmpl.business_value,
            city: null,
          });
        }
      } else if (tmpl.sports) {
        for (const sport of tmpl.sports) {
          const sportTitle = sport[0].toUpperCase() + sport.slice(1);
          const vars = { sport, Sport: sportTitle };

          topics.push({
            slug: fillTemplate(tmpl.slug, vars),
            title: fillTemplate(tmpl.title, vars),
            focus_keyword: fillTemplate(tmpl.focus_keyword, vars),
            post_type: tmpl.post_type,
            tier: tmpl.tier,
            market: 'GLOBAL',
            category: tmpl.category,
            pillar_slug: null,
            country_code: null,
            template_id: `${tmpl.id}-${sport}`,
            level: 'global',
            priority: tmpl.priority,
            business_value: tmpl.business_value,
            city: null,
          });
        }
      } else {
        // Simple template — generate once
        topics.push({
          slug: tmpl.slug,
          title: tmpl.title,
          focus_keyword: tmpl.focus_keyword,
          post_type: tmpl.post_type,
          tier: tmpl.tier,
          market: 'GLOBAL',
          category: tmpl.category,
          pillar_slug: null,
          country_code: null,
          template_id: tmpl.id,
          level: 'global',
          priority: tmpl.priority,
          business_value: tmpl.business_value,
          city: null,
        });
      }
    }
  }

  // Deduplicate by slug (e.g. Singapore city = Singapore country produces same slug)
  const seen = new Set();
  const deduped = [];
  for (const t of topics) {
    if (!seen.has(t.slug)) {
      seen.add(t.slug);
      deduped.push(t);
    }
  }

  return deduped;
}

// ---------------------------------------------------------------------------
// Cross-reference and gap analysis
// ---------------------------------------------------------------------------

/**
 * Cross-reference generated topics against live slugs and tracker.
 *
 * @param {object[]} topics - Generated topics
 * @param {Set<string>} liveSlugs - Slugs already live on padeli.com
 * @returns {object} { gaps: [], existing: [], inTracker: [] }
 */
async function crossReference(topics, liveSlugs) {
  const tracker = await loadTracker();
  const trackerSlugs = new Set(tracker.posts.map(p => p.slug));

  const gaps = [];
  const existing = [];
  const inTracker = [];

  for (const topic of topics) {
    if (liveSlugs.has(topic.slug)) {
      existing.push(topic);
    } else if (trackerSlugs.has(topic.slug)) {
      inTracker.push(topic);
    } else {
      gaps.push(topic);
    }
  }

  // Sort gaps: priority first, then tier (cornerstone > cluster > leaf)
  const tierOrder = { cornerstone: 0, cluster: 1, leaf: 2 };
  gaps.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return (tierOrder[a.tier] || 9) - (tierOrder[b.tier] || 9);
  });

  return { gaps, existing, inTracker };
}

// ---------------------------------------------------------------------------
// Populate tracker
// ---------------------------------------------------------------------------

/**
 * Write discovered topics into the blog tracker.
 *
 * @param {object[]} topics - Topics to add (typically the gaps array)
 * @param {object} opts
 * @param {string} opts.status - 'proposed' (default) or 'approved'
 * @param {boolean} opts.dryRun - If true, return what would be added without writing
 * @returns {object} { added: number, skipped: number, errors: [], entries: [] }
 */
async function populateTracker(topics, opts = {}) {
  const status = opts.status || 'proposed';
  const dryRun = opts.dryRun !== false; // default true

  const result = { added: 0, skipped: 0, errors: [], entries: [] };

  for (const topic of topics) {
    const postData = {
      slug: topic.slug,
      title: topic.title,
      focus_keyword: topic.focus_keyword,
      post_type: topic.post_type,
      tier: topic.tier,
      market: topic.market,
      category: topic.category,
      pillar_slug: topic.pillar_slug,
      country_code: topic.country_code,
      business_value: topic.business_value,
      priority_score: topic.priority,
      is_ymyl: false,
      status,
      notes: `Auto-discovered. Template: ${topic.template_id}. Level: ${topic.level}.${topic.city ? ' City: ' + topic.city + '.' : ''}`,
    };

    if (dryRun) {
      result.entries.push(postData);
      result.added++;
      continue;
    }

    try {
      await addPost(postData);
      result.entries.push(postData);
      result.added++;
    } catch (err) {
      if (err.message.includes('already exists')) {
        result.skipped++;
      } else {
        result.errors.push({ slug: topic.slug, error: err.message });
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Discovery — full pipeline
// ---------------------------------------------------------------------------

/**
 * Run full discovery for one or all markets.
 *
 * @param {string} marketCode - Market code or 'all'
 * @param {object} opts
 * @param {boolean} opts.gapsOnly - Only return gaps (not already live)
 * @param {Set<string>} opts.liveSlugs - Pre-fetched live slugs (skips WP fetch if provided)
 * @returns {Promise<object>} Discovery report
 */
async function discover(marketCode, opts = {}) {
  const liveSlugs = opts.liveSlugs || await fetchLiveSlugs();
  const codes = marketCode === 'all' ? Object.keys(MARKETS) : [marketCode.toUpperCase()];

  const report = {
    markets: {},
    totals: { generated: 0, live: 0, in_tracker: 0, gaps: 0 },
    live_slug_count: liveSlugs.size,
  };

  for (const code of codes) {
    const topics = generateTopics(code);
    const { gaps, existing, inTracker } = await crossReference(topics, liveSlugs);

    report.markets[code] = {
      country: MARKETS[code].country,
      generated: topics.length,
      live: existing.length,
      in_tracker: inTracker.length,
      gaps: gaps.length,
      gap_topics: opts.gapsOnly !== false ? gaps : topics,
      coverage_pct: topics.length > 0 ? Math.round((existing.length / topics.length) * 100) : 0,
    };

    report.totals.generated += topics.length;
    report.totals.live += existing.length;
    report.totals.in_tracker += inTracker.length;
    report.totals.gaps += gaps.length;
  }

  return report;
}

// ---------------------------------------------------------------------------
// Coverage summary — compact view
// ---------------------------------------------------------------------------

function formatSummary(report) {
  const lines = [];
  lines.push('PADELI TOPIC DISCOVERY REPORT');
  lines.push(`Live posts on padeli.com: ${report.live_slug_count}`);
  lines.push('');
  lines.push('Market           | Generated | Live | Tracker | Gaps | Coverage');
  lines.push('-----------------|-----------|------|---------|------|---------');

  for (const [code, m] of Object.entries(report.markets)) {
    const name = (m.country + '          ').slice(0, 16);
    lines.push(
      `${name} | ${String(m.generated).padStart(9)} | ${String(m.live).padStart(4)} | ${String(m.in_tracker).padStart(7)} | ${String(m.gaps).padStart(4)} | ${String(m.coverage_pct).padStart(4)}%`
    );
  }

  lines.push('-----------------|-----------|------|---------|------|---------');
  const t = report.totals;
  const totalPct = t.generated > 0 ? Math.round((t.live / t.generated) * 100) : 0;
  lines.push(
    `TOTAL            | ${String(t.generated).padStart(9)} | ${String(t.live).padStart(4)} | ${String(t.in_tracker).padStart(7)} | ${String(t.gaps).padStart(4)} | ${String(totalPct).padStart(4)}%`
  );

  return lines.join('\n');
}

function formatGaps(marketReport) {
  const lines = [];
  const gaps = marketReport.gap_topics || [];
  if (gaps.length === 0) {
    lines.push('No gaps found — full coverage.');
    return lines.join('\n');
  }

  lines.push(`${gaps.length} gap topics for ${marketReport.country}:`);
  lines.push('');
  lines.push('P | Tier         | Type            | Slug');
  lines.push('--|--------------|-----------------|-----');

  for (const g of gaps) {
    lines.push(
      `${g.priority} | ${(g.tier + '          ').slice(0, 12)} | ${(g.post_type + '              ').slice(0, 15)} | ${g.slug}`
    );
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Add custom market or city at runtime
// ---------------------------------------------------------------------------

/**
 * Add a city to an existing market (for runtime expansion).
 */
function addCity(marketCode, cityName, citySlug, subAreas) {
  const market = MARKETS[marketCode];
  if (!market) throw new Error(`Unknown market: ${marketCode}`);
  if (market.cities.find(c => c.slug === citySlug)) return; // already exists
  const entry = { name: cityName, slug: citySlug };
  if (subAreas) entry.sub_areas = subAreas;
  market.cities.push(entry);
}

/**
 * Get list of available markets.
 */
function listMarkets() {
  return Object.entries(MARKETS).map(([code, m]) => ({
    code,
    country: m.country,
    cities: m.cities.length,
  }));
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  MARKETS,
  CITY_TEMPLATES,
  COUNTRY_TEMPLATES,
  GEAR_TEMPLATES,
  GLOBAL_TEMPLATES,
  fetchLiveSlugs,
  generateTopics,
  crossReference,
  populateTracker,
  discover,
  formatSummary,
  formatGaps,
  addCity,
  listMarkets,
};

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

if (require.main === module) {
  const args = process.argv.slice(2);
  const cmd = args[0];

  (async () => {
    try {
      if (cmd === 'discover') {
        const market = args[1] || 'all';
        const gapsOnly = args.includes('--gaps-only');
        const report = await discover(market, { gapsOnly });
        console.log(formatSummary(report));
        if (market !== 'all') {
          console.log('');
          console.log(formatGaps(report.markets[market.toUpperCase()]));
        }
      } else if (cmd === 'populate') {
        const market = args[1];
        if (!market) { console.error('Usage: populate <market> [--status approved]'); process.exit(1); }
        const status = args.includes('--status') ? args[args.indexOf('--status') + 1] : 'proposed';
        const dryRun = !args.includes('--live');
        const report = await discover(market, { gapsOnly: true });
        const gaps = report.markets[market.toUpperCase()].gap_topics;
        const result = await populateTracker(gaps, { status, dryRun });
        console.log(`${dryRun ? 'DRY RUN — ' : ''}Added: ${result.added}, Skipped: ${result.skipped}, Errors: ${result.errors.length}`);
        if (result.errors.length > 0) console.log('Errors:', result.errors);
      } else if (cmd === 'live-slugs') {
        const slugs = await fetchLiveSlugs();
        console.log(`${slugs.size} live slugs fetched`);
        for (const s of slugs) console.log(s);
      } else if (cmd === 'summary') {
        const report = await discover('all');
        console.log(formatSummary(report));
      } else {
        console.log('Usage: node topic-discovery.js <discover|populate|live-slugs|summary> [market] [options]');
      }
    } catch (err) {
      console.error('Error:', err.message);
      process.exit(1);
    }
  })();
}
