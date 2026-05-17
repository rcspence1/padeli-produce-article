/**
 * Blog Researcher Module — Padeli Blog Pipeline (Stage 2)
 *
 * Generates research prompts for a sub-agent to conduct the 8-phase city
 * research workflow (or product/topical/pillar/YMYL variants). The sub-agent
 * produces a structured markdown research report that the drafting-agent
 * uses as its source of truth.
 *
 * Node.js v24+ — zero external dependencies — CommonJS
 */

const fs = require('fs');
const path = require('path');
const {
  POST_TYPES,
  WORD_COUNT_TARGETS,
  BANNED_SOURCES,
  getCurrency,
  getEnglishVariant,
  COUNTRY_NAMES,
} = require('./config');
const { slugify, countWords } = require('./utils');

// ---------------------------------------------------------------------------
// Research Sources — hierarchy of where to find data
// ---------------------------------------------------------------------------

const RESEARCH_SOURCES = {
  venue_directories: [
    { name: 'Padelful', url: 'https://padelful.com', notes: 'Most comprehensive global index, sometimes stale' },
    { name: 'Playtomic', url: 'https://playtomic.io', notes: 'Dominant booking platform, proves venue exists + bookable' },
    { name: 'MATCHi', url: 'https://www.matchi.se', notes: 'Secondary platform, UK/Nordics coverage' },
    { name: 'Google Maps', url: 'https://maps.google.com', notes: 'Search "padel courts in {city}", picks up non-platform venues' },
  ],
  federations: {
    UK: { name: 'LTA Padel', url: 'https://www.lta.org.uk/play/padel/' },
    GB: { name: 'LTA Padel', url: 'https://www.lta.org.uk/play/padel/' },
    ES: { name: 'FEP', url: 'https://www.padelfederacion.es' },
    ID: { name: 'PBBI', url: null },
    AE: { name: 'UAE Padel Association', url: null },
    US: { name: 'USPA', url: 'https://uspadel.org' },
  },
  review_sources: [
    { name: 'Google Maps', allowed: true },
    { name: 'Playtomic', allowed: true },
    { name: 'Tripadvisor', allowed: 'resort-only' },
    { name: 'Reddit', allowed: true, subreddits: ['r/padel', 'r/padel_uk'] },
  ],
  banned: ['hidubai.com', 'timeoutdubai.com', 'whatson.ae', 'provenexpert.com'],
  product_sources: [
    { name: 'Padel Nuestro', url: 'https://padelnuestro.com' },
    { name: 'Decathlon UK', url: 'https://www.decathlon.co.uk' },
    { name: 'PDH Sports', url: 'https://www.pdhsports.com' },
    { name: 'Amazon UK', url: 'https://www.amazon.co.uk' },
  ],
};

// ---------------------------------------------------------------------------
// Research Quality Bar — checks for each post type
// ---------------------------------------------------------------------------

const RESEARCH_QUALITY_BAR = {
  city_listicle: [
    'Every venue has 2+ independent sources for court count',
    'Every venue has 1+ published price source',
    'Every venue has 1+ review source (Google or Playtomic)',
    'No fact sourced from single Wikipedia paragraph or marketing page only',
    'Every URL in Sources cited returns 200',
    'Pricing in local currency with USD parenthetical',
    'No personal-visit framing',
    'No banned-source citations',
    'Minimum 6 venues for a city guide — if fewer exist, explain why in the report',
    'Both the cheapest AND most expensive venue identified to establish full price range',
    'All single-source claims flagged as SINGLE_SOURCE in the report',
  ],
  product_listicle: [
    'Every product has verified specs from manufacturer',
    'Every product has 3 UK/US stockists with prices',
    'Every product has review aggregates from 2+ sources',
    'Price verified within last 30 days',
  ],
  pillar: [
    'Total venue + court count from federation source',
    'Player count from federation or industry research',
    'Major cities/regions listed',
    'Tournament scene documented',
    'Minimum 6 venues listed across the country',
    'All single-source claims flagged as SINGLE_SOURCE in the report',
  ],
  cluster: [
    'For pricing/cost posts: both cheapest AND most expensive venues identified',
    'All single-source claims flagged as SINGLE_SOURCE in the report',
    'Pricing cross-referenced against venue website AND booking platform',
  ],
  topical: [
    'All claims backed by official rules or peer-reviewed sources',
    'Technique descriptions verified against coaching authority content',
    'No unsourced comparisons or subjective rankings',
    'All single-source claims flagged as SINGLE_SOURCE in the report',
  ],
  ymyl: [
    'Every health/fitness claim backed by peer-reviewed study or qualified authority',
    'No absolute medical advice — always include "consult a professional" where appropriate',
    'Injury risk sections cite sports medicine sources',
    'Supplement or nutrition claims cite RCTs or systematic reviews',
  ],
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Extract the city name from a focus keyword like "best padel courts in birmingham 2026".
 * @param {string} keyword
 * @returns {string}
 */
function _extractCity(keyword) {
  const cleaned = (keyword || '')
    .replace(/\b\d{4}\b/g, '')
    .replace(/best padel courts in/i, '')
    .replace(/padel courts in/i, '')
    .replace(/padel in/i, '')
    .trim();
  // Title-case each word
  return cleaned.replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Format the banned sources list as a markdown bullet list.
 * @returns {string}
 */
function _bannedSourcesBlock() {
  const allBanned = [...BANNED_SOURCES, ...RESEARCH_SOURCES.banned];
  const unique = [...new Set(allBanned)];
  return unique.map((d) => `- ${d}`).join('\n');
}

/**
 * Format the venue directory list for prompt injection.
 * @returns {string}
 */
function _venueDirectoryBlock() {
  return RESEARCH_SOURCES.venue_directories
    .map((d) => `- **${d.name}** (${d.url}) — ${d.notes}`)
    .join('\n');
}

/**
 * Format the review source list for prompt injection.
 * @returns {string}
 */
function _reviewSourceBlock() {
  return RESEARCH_SOURCES.review_sources
    .map((s) => {
      const rule = s.allowed === true ? 'allowed' : s.allowed === 'resort-only' ? 'resort venues only' : 'not allowed';
      const extra = s.subreddits ? ` (${s.subreddits.join(', ')})` : '';
      return `- **${s.name}** — ${rule}${extra}`;
    })
    .join('\n');
}

/**
 * Format the product sources for prompt injection.
 * @returns {string}
 */
function _productSourceBlock() {
  return RESEARCH_SOURCES.product_sources
    .map((s) => `- **${s.name}** (${s.url})`)
    .join('\n');
}

/**
 * Get the federation info for a country code.
 * @param {string} code
 * @returns {string}
 */
function _federationBlock(code) {
  const fed = RESEARCH_SOURCES.federations[code] || RESEARCH_SOURCES.federations[(code || '').toUpperCase()];
  if (!fed) return 'No known federation for this market.';
  return fed.url
    ? `**${fed.name}** — ${fed.url}`
    : `**${fed.name}** — no known URL (search for their latest listings)`;
}

/**
 * Format quality bar checks as a numbered list.
 * @param {string} postType
 * @returns {string}
 */
function _qualityBarBlock(postType) {
  const checks = RESEARCH_QUALITY_BAR[postType] || RESEARCH_QUALITY_BAR.city_listicle;
  return checks.map((c, i) => `${i + 1}. ${c}`).join('\n');
}

/**
 * Get today's date as YYYY-MM-DD.
 * @returns {string}
 */
function _today() {
  return new Date().toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Research Template Builder
// ---------------------------------------------------------------------------

/**
 * Build an empty research report template in markdown for the sub-agent to fill.
 *
 * @param {object} brief - The post brief object
 * @returns {string} Markdown template
 */
function buildResearchTemplate(brief) {
  const city = _extractCity(brief.focus_keyword);
  const currency = getCurrency(brief.country_code || brief.market);
  const country = COUNTRY_NAMES[brief.country_code] || COUNTRY_NAMES[brief.market] || brief.market;

  if (brief.post_type === POST_TYPES.PRODUCT_LISTICLE || brief.post_type === 'product_listicle') {
    return _buildProductTemplate(brief);
  }
  if (brief.post_type === POST_TYPES.PILLAR || brief.post_type === 'pillar') {
    return _buildPillarTemplate(brief, country);
  }

  // Default: city listicle template
  return `# Research Report: ${brief.title || brief.focus_keyword}

## Meta
- **Focus Keyword:** ${brief.focus_keyword}
- **Slug:** ${brief.slug}
- **Post Type:** ${brief.post_type}
- **Market:** ${brief.market}
- **Country:** ${country}
- **Currency:** ${currency}
- **Boundary:** ${brief.boundary || city}
- **Researched Date:** ${_today()}

---

## 1. Venue Inventory

| # | Venue | Neighbourhood | Courts | Indoor/Outdoor | Booking Platform | Source(s) | Year Opened |
|---|-------|--------------|--------|----------------|-----------------|-----------|-------------|
| 1 | | | | | | | |

---

## 2. Court Verification

For each venue, confirm:
- Exact court count (cite 2+ sources)
- Address
- Operating hours
- Surface type (glass-back, mesh, panoramic)
- Year opened (if available)

---

## 3. Pricing Snapshot

| Venue | Off-Peak (${currency}) | Peak (${currency}) | USD Equivalent | Membership | Source |
|-------|----------------------|-------------------|---------------|------------|--------|
| | | | | | |

---

## 4. Review Aggregation

### [Venue Name]
- **Google Maps:** X.X/5 (N reviews)
- **Playtomic:** X.X/5 (N reviews)
- **Positives:** 1. ... 2. ... 3. ...
- **Negatives:** 1. ... 2. ...

---

## 5. Coaching & Services

| Venue | Coach Credentials | Private Session | Group Session | Junior Programme | Amenities |
|-------|------------------|-----------------|---------------|-----------------|-----------|
| | | | | | |

---

## 6. Local Context

### Climate & Season
<!-- Best months, temperature range, indoor vs outdoor preference -->

### Booking Culture
<!-- How locals book, peak days/times, advance booking norms -->

### Transport
<!-- How to reach key venues, parking, public transport -->

### Tournaments & Events
<!-- Local leagues, tournament calendar, federation events -->

### Recent News
<!-- New venues opening, expansions, closures in past 12 months -->

---

## 7. Verified Facts

| # | Claim | Source URL | Direct Quote |
|---|-------|-----------|-------------|
| 1 | | | |

---

## 8. Open Claims (Unverified)

| # | Claim | Reason Unverified |
|---|-------|-------------------|
| 1 | | |

---

## Sources Cited

1. [Source title](URL) — accessed ${_today()}
`;
}

/**
 * @private Build product research template.
 */
function _buildProductTemplate(brief) {
  return `# Research Report: ${brief.title || brief.focus_keyword}

## Meta
- **Focus Keyword:** ${brief.focus_keyword}
- **Slug:** ${brief.slug}
- **Post Type:** product_listicle
- **Market:** ${brief.market}
- **Researched Date:** ${_today()}

---

## 1. Product Inventory (Ranked)

| # | Product | Brand | Weight (g) | Balance | Shape | Face | Core | RRP | Our Verdict |
|---|---------|-------|-----------|---------|-------|------|------|-----|-------------|
| 1 | | | | | | | | | |

---

## 2. Honourable Mentions

| # | Product | Brand | Why Mentioned |
|---|---------|-------|---------------|
| 1 | | | |

---

## 3. Spec Verification

For each product, confirm manufacturer specs:
- Weight, balance, shape, face material, core material
- Source: manufacturer website URL

---

## 4. Review Aggregation

### [Product Name]
- **Reddit r/padel:** Summary of sentiment (N mentions)
- **Amazon:** X.X/5 (N reviews)
- **Padel Nuestro:** X.X/5 (N reviews)
- **Decathlon:** X.X/5 (N reviews)
- **Key Praise:** ...
- **Key Criticism:** ...

---

## 5. Stockist & Pricing

| Product | Stockist 1 (Price) | Stockist 2 (Price) | Stockist 3 (Price) | Price Verified Date |
|---------|-------------------|-------------------|-------------------|-------------------|
| | | | | |

---

## 6. Verified Facts

| # | Claim | Source URL | Direct Quote |
|---|-------|-----------|-------------|
| 1 | | | |

---

## 7. Open Claims (Unverified)

| # | Claim | Reason Unverified |
|---|-------|-------------------|
| 1 | | |

---

## Sources Cited

1. [Source title](URL) — accessed ${_today()}
`;
}

/**
 * @private Build pillar research template.
 */
function _buildPillarTemplate(brief, country) {
  return `# Research Report: ${brief.title || brief.focus_keyword}

## Meta
- **Focus Keyword:** ${brief.focus_keyword}
- **Slug:** ${brief.slug}
- **Post Type:** pillar
- **Market:** ${brief.market}
- **Country:** ${country}
- **Researched Date:** ${_today()}

---

## 1. National Overview

- **Total Venues:**
- **Total Courts:**
- **Estimated Players:**
- **Federation:** ${_federationBlock(brief.country_code || brief.market)}
- **Source(s):**

---

## 2. Major Cities / Regions

| City/Region | Venues | Courts | Notable Clubs |
|-------------|--------|--------|--------------|
| | | | |

---

## 3. Tournament Scene

| Event | Level | Location | Dates | Source |
|-------|-------|----------|-------|--------|
| | | | | |

---

## 4. Growth & Trends

<!-- Player growth %, new venue openings, investment, media coverage -->

---

## 5. Practical Info

### Climate Considerations
### Booking Platforms Used
### Cost Range (national average)
### Equipment Availability

---

## 6. Verified Facts

| # | Claim | Source URL | Direct Quote |
|---|-------|-----------|-------------|
| 1 | | | |

---

## 7. Open Claims (Unverified)

| # | Claim | Reason Unverified |
|---|-------|-------------------|
| 1 | | |

---

## Sources Cited

1. [Source title](URL) — accessed ${_today()}
`;
}

// ---------------------------------------------------------------------------
// Prompt Builders
// ---------------------------------------------------------------------------

/**
 * Build the city-specific 8-phase research prompt.
 *
 * @param {object} brief - The post brief object
 * @returns {string} Complete prompt for the research sub-agent
 */
function buildCityResearchPrompt(brief) {
  const city = _extractCity(brief.focus_keyword);
  const currency = getCurrency(brief.country_code || brief.market);
  const country = COUNTRY_NAMES[brief.country_code] || COUNTRY_NAMES[brief.market] || brief.market;
  const englishVariant = getEnglishVariant(brief.country_code || brief.market);
  const boundary = brief.boundary || city;
  const federation = _federationBlock(brief.country_code || brief.market);

  return `# City Research Brief: ${city}, ${country}

You are a padel venue researcher. Your job is to produce a comprehensive, fact-checked research report for the article "${brief.title}".

**Focus Keyword:** ${brief.focus_keyword}
**Geographic Boundary:** ${boundary}
**Market:** ${brief.market} (${country})
**Currency:** ${currency}
**English Variant:** ${englishVariant}
**Federation:** ${federation}

---

## Your 8-Phase Research Workflow

### Phase 1: Define Scope
- Focus keyphrase: "${brief.focus_keyword}"
- Market: ${country}
- Geographic boundary: ${boundary}
- Search intent: informational + transactional (people want to find and book courts)
- You are researching EVERY padel venue within the boundary, not just the "best" ones.

### Phase 2: Build Venue Inventory
Find EVERY padel venue in the area, not just the top 3-5. A complete inventory is more important than deep detail on a few. Search ALL of these directories for padel venues in ${city}:

${_venueDirectoryBlock()}

Also check:
- Instagram location tags and geo-tagged posts for "${city} padel"
- Facebook groups (search: "${city} padel")
- ${federation}
- Local press (search: "${city} padel" site:*.${brief.country_code === 'GB' || brief.market === 'UK' ? 'co.uk' : 'com'}")
- Recent news (past 12 months) for new openings

**Completeness check:** After your initial search, do a SECOND PASS searching for "${city} padel" on Google Maps, Playtomic, and social media to catch any venues you missed. Compare your list against the Playtomic and Google Maps results — if either shows a venue not on your list, add it.

For pricing posts specifically, you MUST find the cheapest AND most expensive venue to establish the full price range.

Build a master table:
| Venue | Neighbourhood | Courts | Indoor/Outdoor | Booking Platform | Source(s) | First Seen |
|-------|--------------|--------|----------------|-----------------|-----------|------------|

Every venue must appear in 2+ sources. If a venue appears in only 1 source, flag it as unverified.

### Phase 3: Verify Court Counts
For each venue, confirm:
- Exact number of courts (cite 2+ independent sources)
- Full street address
- Operating hours (weekday + weekend)
- Surface type: glass-back, mesh, panoramic
- Year opened (if findable)

If sources disagree on court count, note the discrepancy and use the most recent source.

### Phase 4: Pricing Research
For each venue, find:
- **Off-peak rate** (per court per hour)
- **Peak rate** (per court per hour)
- **Membership options** (if any)
- **Packages** (10-session bundles, etc.)

All prices in ${currency} with USD equivalent in parentheses.
Source must be the venue's own website, Playtomic listing, or direct booking page.
Do NOT estimate or guess prices — if you cannot find a published price, mark as "Not published".

### Phase 5: Review Aggregation
For each venue, collect reviews from:

${_reviewSourceBlock()}

Per venue, provide:
- Overall rating (from each source)
- Review count
- 3 specific positive themes (with example quotes where possible)
- 1-2 specific negative themes (with example quotes where possible)

Do NOT fabricate or paraphrase reviews. Use actual quoted text where available.

### Phase 6: Coaching & Services
For each venue, document:
- Coach names and credentials (certifications, playing level)
- Private lesson pricing
- Group lesson pricing and schedule
- Junior / kids programmes
- Amenities: pro shop, cafe, changing rooms, parking, racket rental

### Phase 7: Local Context
Research and document:
- **Climate:** best months for outdoor play, temperature ranges, rainfall
- **Booking culture:** how locals book, peak days/times, how far in advance
- **Transport:** nearest train/bus stations, parking at venues, cycle access
- **Tournaments:** local leagues, upcoming events, federation-sanctioned tournaments
- **Recent news:** venue openings, expansions, closures in the past 12 months

### Phase 8: Write Verification Report
Compile everything into the structured markdown template below. Every factual claim must appear in the "Verified Facts" table with a source URL and direct quote. Any claim you cannot verify goes in "Open Claims".

---

## Quality Checks (ALL must pass)

${_qualityBarBlock('city_listicle')}

---

## Banned Sources (NEVER cite these)

${_bannedSourcesBlock()}

---

## Important Rules

1. **Spelling:** Always "padel" (never "paddle"). Use ${englishVariant} throughout.
2. **No personal visit framing:** Never say "we visited", "we tested", "we played at". You are a desk researcher.
3. **No marketing fluff:** Do not copy venue marketing copy. Report facts only.
4. **Currency:** All prices in ${currency} with (USD $X) equivalent.
5. **Recency:** Prioritise the most recent information. If a source is older than 6 months, flag it as potentially outdated. Prefer sources from the last 12 months. Flag anything older than 24 months.
6. **Completeness over speed:** A venue missing from the report is worse than taking extra time. Find EVERY venue.
7. **Disagreements:** When sources disagree, note both and state which you consider more reliable and why.
8. **Multi-source verification:** For any factual claim (pricing, court count, coach names, opening hours), verify against at least 2 independent sources. If only 1 source exists, mark the claim as SINGLE_SOURCE in your report.
9. **Primary source priority:** Check the venue's OWN website for the most current pricing and staff listings — third-party sites often have outdated information. Always check the venue's Playtomic page for current pricing, as this reflects live booking rates.
10. **Coach/staff recency:** For coach and staff names, check the venue's Instagram or website "team" page — these are updated more frequently than third-party directories.

---

## Output Format

Use this exact markdown structure:

${buildResearchTemplate(brief)}
`;
}

/**
 * Build the product listicle research prompt.
 *
 * @param {object} brief - The post brief object
 * @returns {string} Complete prompt for the research sub-agent
 */
function buildProductResearchPrompt(brief) {
  const currency = getCurrency(brief.country_code || brief.market);
  const englishVariant = getEnglishVariant(brief.country_code || brief.market);

  return `# Product Research Brief: ${brief.title}

You are a padel equipment researcher. Your job is to produce a comprehensive, fact-checked research report for the article "${brief.title}".

**Focus Keyword:** ${brief.focus_keyword}
**Market:** ${brief.market}
**Currency:** ${currency}
**English Variant:** ${englishVariant}

---

## Research Workflow

### Step 1: Build Product Inventory
Identify 6-8 products for the main ranked list, plus 4-6 honourable mentions.

Search these sources:
${_productSourceBlock()}

Also search:
- Manufacturer websites for official specs
- Reddit r/padel for community recommendations and reviews
- YouTube padel review channels for expert opinions

### Step 2: Verify Specs
For EVERY product in the list, confirm from the manufacturer's official page:
- Weight (grams)
- Balance (low / medium / high)
- Shape (round / diamond / teardrop / hybrid)
- Face material (carbon fibre, fibreglass, etc.)
- Core material (EVA soft, EVA hard, FOAM, etc.)
- RRP in ${currency}

If manufacturer specs are unavailable, use a major retailer and note this.

### Step 3: Aggregate Reviews
For each product, collect sentiment from:
- **Reddit r/padel** — search for product name, note number of mentions and overall sentiment
- **Amazon** — rating and review count
- **Padel Nuestro** — rating and review count
- **Decathlon** — rating and review count (if stocked)
- **Trustpilot** — only if product-specific reviews exist

Summarise: key praise themes, key criticism themes. Use actual quotes where available.

### Step 4: Verify Stockists
For each product, find 3+ current stockists with live prices:
- Note the price at each stockist
- Note the date you verified the price
- Flag any "out of stock" items

### Step 5: Compile Report
Fill in the structured template below. Every spec claim must link to its source.

---

## Quality Checks (ALL must pass)

${_qualityBarBlock('product_listicle')}

---

## Banned Sources (NEVER cite these)

${_bannedSourcesBlock()}

---

## Important Rules

1. **Spelling:** Always "padel" (never "paddle"). Use ${englishVariant} throughout.
2. **No personal testing framing:** Never say "we tested", "in our hands". You are a desk researcher.
3. **Objectivity:** Do not rank by personal preference. Rank by: value for money, review consensus, spec quality.
4. **Currency:** All prices in ${currency} with (USD $X) equivalent where the market is not US.
5. **Recency:** Only include products currently in production and available to buy. No discontinued items. If a source is older than 6 months, flag it as potentially outdated.
6. **Multi-source verification:** For any factual claim (pricing, specs, availability), verify against at least 2 independent sources. If only 1 source exists, mark the claim as SINGLE_SOURCE in your report.
7. **Primary source priority:** Check the manufacturer's OWN website for the most current specs and pricing — retailer sites may lag behind.

---

## Output Format

${_buildProductTemplate(brief)}
`;
}

/**
 * Build the country pillar research prompt.
 *
 * @param {object} brief - The post brief object
 * @returns {string} Complete prompt for the research sub-agent
 */
function buildPillarResearchPrompt(brief) {
  const country = COUNTRY_NAMES[brief.country_code] || COUNTRY_NAMES[brief.market] || brief.market;
  const currency = getCurrency(brief.country_code || brief.market);
  const englishVariant = getEnglishVariant(brief.country_code || brief.market);
  const federation = _federationBlock(brief.country_code || brief.market);

  return `# Pillar Research Brief: Padel in ${country}

You are a padel industry researcher. Your job is to produce a comprehensive, fact-checked national overview for the article "${brief.title}".

**Focus Keyword:** ${brief.focus_keyword}
**Country:** ${country}
**Market Code:** ${brief.market}
**Currency:** ${currency}
**English Variant:** ${englishVariant}
**Federation:** ${federation}

---

## Research Workflow

### Step 1: National Statistics
Find and verify:
- Total number of padel venues in ${country}
- Total number of padel courts
- Estimated number of active players
- Year-on-year growth (venues, players, investment)
- Source: federation data, industry reports, credible press

### Step 2: Major Cities & Regions
List every major city/region where padel is established:
- Number of venues and courts per city
- Notable clubs in each city
- This feeds the internal linking structure (each city gets its own article)

### Step 3: Tournament Scene
Document:
- National tournament calendar
- Federation-sanctioned events
- International events hosted in ${country}
- Local league structures
- Professional players from ${country}

### Step 4: Growth & Trends
Research:
- Investment and expansion news (past 24 months)
- New venue announcements
- Media coverage trends
- Padel vs tennis/squash participation comparisons
- Demographic trends (age, gender)

### Step 5: Practical Information
Document:
- Climate considerations for outdoor play
- Dominant booking platforms in ${country}
- Typical cost range (court hire per hour)
- Equipment availability and popular retailers

### Step 6: Compile Report

---

## Quality Checks (ALL must pass)

${_qualityBarBlock('pillar')}

---

## Banned Sources (NEVER cite these)

${_bannedSourcesBlock()}

---

## Important Rules

1. **Spelling:** Always "padel" (never "paddle"). Use ${englishVariant} throughout.
2. **Federation first:** Federation data is the primary source for national stats. If unavailable, use credible press/industry reports and note the source quality.
3. **No personal visit framing.**
4. **Recency:** Prioritise the most recent information. If a source is older than 6 months, flag it as potentially outdated. Prefer data from the last 12 months. Flag anything older than 24 months.
5. **Multi-source verification:** For any factual claim (venue counts, player numbers, pricing), verify against at least 2 independent sources. If only 1 source exists, mark the claim as SINGLE_SOURCE in your report.
6. **Primary source priority:** Check venue/federation OWN websites for the most current data — third-party aggregators often have stale information.

---

## Output Format

${_buildPillarTemplate(brief, country)}
`;
}

/**
 * Build the topical (technique/rules/comparison) research prompt.
 *
 * @param {object} brief - The post brief object
 * @returns {string} Complete prompt for the research sub-agent
 */
function buildTopicalResearchPrompt(brief) {
  const englishVariant = getEnglishVariant(brief.country_code || brief.market);

  return `# Topical Research Brief: ${brief.title}

You are a padel subject-matter researcher. Your job is to produce a comprehensive, fact-checked research report for the article "${brief.title}".

**Focus Keyword:** ${brief.focus_keyword}
**Post Type:** ${brief.post_type}
**Market:** ${brief.market}
**English Variant:** ${englishVariant}

---

## Research Workflow

### Step 1: Define the Topic
- What exactly does "${brief.focus_keyword}" cover?
- What is the searcher's intent? (learning, comparing, deciding)
- What subtopics must be addressed for completeness?

### Step 2: Authoritative Sources
Find and cite:
- Official rules from FIP (International Padel Federation) or relevant national federation
- Coaching content from certified padel coaches (WPT, APT, national federation coaches)
- Academic or sports science research (if applicable)
- Expert video content (WPT channel, professional player tutorials)

### Step 3: Fact Verification
For every factual claim:
- Cite the source URL
- Include a direct quote where possible
- Note if the claim is widely agreed upon or contested

### Step 4: Competitive Landscape
- What do the top 5 ranking articles for "${brief.focus_keyword}" cover?
- What do they miss?
- What unique angles can we add?

### Step 5: Compile Report

Use this structure:

# Research Report: ${brief.title}

## Meta
- **Focus Keyword:** ${brief.focus_keyword}
- **Slug:** ${brief.slug}
- **Post Type:** ${brief.post_type}
- **Market:** ${brief.market}
- **Researched Date:** ${_today()}

---

## Key Findings

### [Subtopic 1]
<!-- Facts, sources, quotes -->

### [Subtopic 2]
<!-- Facts, sources, quotes -->

---

## Verified Facts

| # | Claim | Source URL | Direct Quote |
|---|-------|-----------|-------------|
| 1 | | | |

---

## Open Claims (Unverified)

| # | Claim | Reason Unverified |
|---|-------|-------------------|
| 1 | | |

---

## Competitive Gap Analysis

| Ranking Article | URL | Covers | Misses |
|----------------|-----|--------|--------|
| | | | |

---

## Sources Cited

1. [Source title](URL) — accessed ${_today()}

---

## Quality Checks (ALL must pass)

${_qualityBarBlock('topical')}

---

## Banned Sources (NEVER cite these)

${_bannedSourcesBlock()}

---

## Important Rules

1. **Spelling:** Always "padel" (never "paddle"). Use ${englishVariant} throughout.
2. **No personal experience framing.**
3. **Accuracy over volume:** Better to have 5 verified facts than 20 unverified claims.
4. **Rules citations:** Always cite FIP rules by article number where applicable.
5. **Multi-source verification:** For any factual claim (pricing, court count, coach names, opening hours), verify against at least 2 independent sources. If only 1 source exists, mark the claim as SINGLE_SOURCE in your report.
6. **Primary source priority:** Check venue/brand OWN websites for the most current information — third-party sites often have outdated data. Always check Playtomic pages for current pricing.
7. **Recency:** Prioritise the most recent information. If a source is older than 6 months, flag it as potentially outdated.
8. **Coach/staff recency:** For coach and staff names, check venue Instagram or website "team" pages — these are updated more frequently than third-party directories.
`;
}

/**
 * Build the YMYL (health/fitness) research prompt with extra strictness.
 *
 * @param {object} brief - The post brief object
 * @returns {string} Complete prompt for the research sub-agent
 */
function buildYMYLResearchPrompt(brief) {
  const englishVariant = getEnglishVariant(brief.country_code || brief.market);

  // Start with the topical prompt as a base and add YMYL strictness
  return `# YMYL Research Brief: ${brief.title}

**THIS IS A YOUR-MONEY-YOUR-LIFE (YMYL) TOPIC. EXTRA STRICTNESS APPLIES.**

You are a padel health/fitness researcher. Your job is to produce a rigorously sourced research report for the article "${brief.title}". Because this topic touches health, fitness, or injury, every claim must meet a higher evidence bar.

**Focus Keyword:** ${brief.focus_keyword}
**Post Type:** ${brief.post_type}
**Market:** ${brief.market}
**English Variant:** ${englishVariant}
**YMYL:** YES

---

## YMYL Extra Rules (NON-NEGOTIABLE)

1. **Every health/fitness claim must be backed by:**
   - A peer-reviewed study (PubMed, Google Scholar), OR
   - A statement from a qualified professional (sports medicine doctor, certified physiotherapist, accredited sports scientist)
2. **Never give absolute medical advice.** Always include: "Consult a qualified healthcare professional before..."
3. **Injury risk sections** must cite sports medicine literature, not blog posts or forum opinions.
4. **Supplement/nutrition claims** must cite RCTs (randomised controlled trials) or systematic reviews.
5. **Exercise descriptions** must note contraindications and when to seek professional guidance.
6. **No anecdotal evidence** presented as fact. Personal stories must be clearly labelled as anecdotal.
7. **Author credentials matter.** Note the credentials of every expert you cite.

---

## Research Workflow

### Step 1: Define the Health/Fitness Topic
- What exactly does "${brief.focus_keyword}" cover?
- What health/fitness claims will the article need to make?
- What are the potential risks of misinformation on this topic?

### Step 2: Academic & Medical Sources
Search:
- **PubMed** for relevant studies (padel + the specific health topic)
- **Google Scholar** for sports science research
- **Sports medicine journals** (BJSM, JOSPT, ACSM)
- **National health services** (NHS, Mayo Clinic, etc.) for general health guidance

### Step 3: Expert Sources
Find statements from:
- Sports medicine doctors who have published on racquet sports
- Certified physiotherapists / physical therapists
- Accredited sports scientists
- Professional padel coaches with relevant certifications

### Step 4: Risk Assessment
For every recommendation in the article:
- What could go wrong if someone follows this advice incorrectly?
- What caveats or disclaimers are needed?
- Who should NOT follow this advice (contraindications)?

### Step 5: Compile Report

Use this structure:

# Research Report: ${brief.title}

## Meta
- **Focus Keyword:** ${brief.focus_keyword}
- **Slug:** ${brief.slug}
- **Post Type:** ${brief.post_type}
- **Market:** ${brief.market}
- **YMYL:** YES
- **Researched Date:** ${_today()}

---

## Key Findings

### [Subtopic 1]
<!-- Facts, study citations, expert quotes -->

### [Subtopic 2]
<!-- Facts, study citations, expert quotes -->

---

## Expert Sources Cited

| # | Expert | Credentials | Affiliation | Claim Supported |
|---|--------|-------------|-------------|-----------------|
| 1 | | | | |

---

## Study Citations

| # | Study Title | Authors | Journal | Year | DOI/URL | Key Finding |
|---|-------------|---------|---------|------|---------|-------------|
| 1 | | | | | | |

---

## Risk & Contraindications

| # | Recommendation | Risk if Done Wrong | Who Should Avoid | Disclaimer Needed |
|---|---------------|-------------------|-----------------|-------------------|
| 1 | | | | |

---

## Verified Facts

| # | Claim | Source URL | Direct Quote | Evidence Level |
|---|-------|-----------|-------------|----------------|
| 1 | | | | |

Evidence levels: RCT, Systematic Review, Cohort Study, Expert Opinion, Guideline

---

## Open Claims (Unverified)

| # | Claim | Reason Unverified |
|---|-------|-------------------|
| 1 | | |

---

## Sources Cited

1. [Source title](URL) — accessed ${_today()}

---

## Quality Checks — YMYL (ALL must pass)

${_qualityBarBlock('ymyl')}

**Plus all standard quality checks:**
${_qualityBarBlock('topical')}

---

## Banned Sources (NEVER cite these)

${_bannedSourcesBlock()}

---

## Important Rules

1. **Spelling:** Always "padel" (never "paddle"). Use ${englishVariant} throughout.
2. **No personal experience framing.**
3. **Evidence hierarchy:** RCT > Systematic Review > Cohort Study > Expert Opinion > Guideline > Anecdote.
4. **When in doubt, hedge.** "Research suggests..." is better than "Studies prove..."
5. **Always include professional consultation advice** for any actionable health recommendation.
6. **Multi-source verification:** For any factual claim, verify against at least 2 independent sources. If only 1 source exists, mark the claim as SINGLE_SOURCE in your report.
7. **Recency:** Prioritise the most recent research. If a source is older than 6 months, flag it as potentially outdated.
`;
}

/**
 * Main router: build the appropriate research prompt based on post type.
 *
 * @param {object} brief - The post brief object
 * @param {object} [options={}] - Additional options
 * @param {boolean} [options.includeTemplate=true] - Whether to include the output template
 * @returns {string} Complete prompt string for the research sub-agent
 */
function buildResearchPrompt(brief, options = {}) {
  // If YMYL, always use the YMYL prompt regardless of post type
  if (brief.is_ymyl) {
    return buildYMYLResearchPrompt(brief);
  }

  const postType = brief.post_type;

  switch (postType) {
    case POST_TYPES.CITY_LISTICLE:
    case 'city_listicle':
      return buildCityResearchPrompt(brief);

    case POST_TYPES.PRODUCT_LISTICLE:
    case 'product_listicle':
      return buildProductResearchPrompt(brief);

    case POST_TYPES.PILLAR:
    case 'pillar':
      return buildPillarResearchPrompt(brief);

    case POST_TYPES.CLUSTER:
    case 'cluster':
    case POST_TYPES.LEAF:
    case 'leaf':
    case 'topical':
    case 'technique':
    case 'rules':
    case 'comparison':
      return buildTopicalResearchPrompt(brief);

    default:
      // Fall back to topical for unknown types
      return buildTopicalResearchPrompt(brief);
  }
}

// ---------------------------------------------------------------------------
// Research Report Parser
// ---------------------------------------------------------------------------

/**
 * Parse a markdown research report into a structured data object.
 *
 * @param {string} markdown - The raw markdown research report
 * @returns {object} Structured research data
 */
function parseResearchReport(markdown) {
  const report = {
    slug: '',
    focus_keyword: '',
    market: '',
    boundary: '',
    researched_date: '',
    venues: [],
    products: [],
    pricing_snapshot: [],
    local_context: {
      climate: '',
      booking_culture: '',
      transport: '',
      tournaments: '',
      news: '',
    },
    national_overview: null,
    verified_facts: [],
    open_claims: [],
    sources_cited: [],
  };

  if (!markdown || typeof markdown !== 'string') return report;

  // --- Parse Meta block ---
  const metaPatterns = {
    slug: /\*\*Slug:\*\*\s*(.+)/i,
    focus_keyword: /\*\*Focus Keyword:\*\*\s*(.+)/i,
    market: /\*\*Market:\*\*\s*(.+)/i,
    boundary: /\*\*Boundary:\*\*\s*(.+)/i,
    researched_date: /\*\*Researched Date:\*\*\s*(.+)/i,
  };

  for (const [key, pattern] of Object.entries(metaPatterns)) {
    const match = markdown.match(pattern);
    if (match) report[key] = match[1].trim();
  }

  // --- Parse Venue Inventory table ---
  report.venues = _parseVenueTable(markdown);

  // --- Parse Pricing Snapshot table ---
  report.pricing_snapshot = _parsePricingTable(markdown);

  // --- Parse Review Aggregation sections ---
  _parseReviewsIntoVenues(markdown, report.venues);

  // --- Parse Local Context ---
  report.local_context = _parseLocalContext(markdown);

  // --- Parse Verified Facts table ---
  report.verified_facts = _parseFactsTable(markdown, 'Verified Facts');

  // --- Parse Open Claims table ---
  report.open_claims = _parseClaimsTable(markdown);

  // --- Parse Sources Cited ---
  report.sources_cited = _parseSourcesCited(markdown);

  // --- Parse Products (for product listicles) ---
  report.products = _parseProductTable(markdown);

  return report;
}

/**
 * @private Parse venue inventory table rows.
 */
function _parseVenueTable(markdown) {
  const venues = [];
  // Find the venue inventory section
  const venueSection = _extractSection(markdown, 'Venue Inventory');
  if (!venueSection) return venues;

  const rows = _parseTableRows(venueSection);
  for (const row of rows) {
    // Expect: # | Venue | Neighbourhood | Courts | Indoor/Outdoor | Booking | Source | Year
    if (row.length >= 4) {
      const venue = {
        name: (row[1] || '').trim(),
        neighbourhood: (row[2] || '').trim(),
        courts: parseInt(row[3], 10) || null,
        indoor_outdoor: (row[4] || '').trim(),
        booking: (row[5] || '').trim(),
        source: (row[6] || '').trim(),
        year_opened: (row[7] || '').trim(),
        rating: null,
        review_count: null,
        price_range: '',
        positives: [],
        negatives: [],
      };
      if (venue.name && venue.name !== '') {
        venues.push(venue);
      }
    }
  }
  return venues;
}

/**
 * @private Parse pricing snapshot table.
 */
function _parsePricingTable(markdown) {
  const pricing = [];
  const section = _extractSection(markdown, 'Pricing Snapshot');
  if (!section) return pricing;

  const rows = _parseTableRows(section);
  for (const row of rows) {
    if (row.length >= 4) {
      const entry = {
        venue: (row[0] || '').trim(),
        off_peak: (row[1] || '').trim(),
        peak: (row[2] || '').trim(),
        usd_equivalent: (row[3] || '').trim(),
        membership: (row[4] || '').trim(),
        source: (row[5] || '').trim(),
        currency: '',
      };
      // Try to extract currency from price strings
      const currencyMatch = (entry.off_peak + entry.peak).match(/([A-Z]{3}|[£$€])/);
      if (currencyMatch) entry.currency = currencyMatch[1];
      if (entry.venue && entry.venue !== '') {
        pricing.push(entry);
      }
    }
  }
  return pricing;
}

/**
 * @private Parse review aggregation sections and attach to venues.
 */
function _parseReviewsIntoVenues(markdown, venues) {
  const section = _extractSection(markdown, 'Review Aggregation');
  if (!section) return;

  // Split by venue headers (### Venue Name)
  const venueBlocks = section.split(/###\s+/).filter((b) => b.trim());
  for (const block of venueBlocks) {
    const lines = block.split('\n');
    const venueName = (lines[0] || '').trim();
    if (!venueName) continue;

    // Find matching venue
    const venue = venues.find(
      (v) => v.name.toLowerCase() === venueName.toLowerCase() ||
             venueName.toLowerCase().includes(v.name.toLowerCase()) ||
             v.name.toLowerCase().includes(venueName.toLowerCase())
    );
    if (!venue) continue;

    // Extract rating (first numeric rating found)
    const ratingMatch = block.match(/(\d+\.?\d*)\/5/);
    if (ratingMatch) venue.rating = parseFloat(ratingMatch[1]);

    // Extract review count
    const reviewMatch = block.match(/\((\d+)\s*reviews?\)/i);
    if (reviewMatch) venue.review_count = parseInt(reviewMatch[1], 10);

    // Extract positives
    const positivesMatch = block.match(/\*\*Positives?:\*\*\s*([\s\S]*?)(?=\*\*Negatives?|\n##|\n---|\n\n\n|$)/i);
    if (positivesMatch) {
      venue.positives = _extractListItems(positivesMatch[1]);
    }

    // Extract negatives
    const negativesMatch = block.match(/\*\*Negatives?:\*\*\s*([\s\S]*?)(?=\n##|\n---|\n\n\n|$)/i);
    if (negativesMatch) {
      venue.negatives = _extractListItems(negativesMatch[1]);
    }
  }
}

/**
 * @private Parse local context sections.
 */
function _parseLocalContext(markdown) {
  const context = {
    climate: '',
    booking_culture: '',
    transport: '',
    tournaments: '',
    news: '',
  };

  const section = _extractSection(markdown, 'Local Context');
  if (!section) return context;

  const subSections = {
    climate: /###\s*Climate\s*(?:&|and)?\s*Season\s*\n([\s\S]*?)(?=###|\n---|\n##|$)/i,
    booking_culture: /###\s*Booking\s*Culture\s*\n([\s\S]*?)(?=###|\n---|\n##|$)/i,
    transport: /###\s*Transport\s*\n([\s\S]*?)(?=###|\n---|\n##|$)/i,
    tournaments: /###\s*Tournaments?\s*(?:&|and)?\s*Events?\s*\n([\s\S]*?)(?=###|\n---|\n##|$)/i,
    news: /###\s*Recent\s*News\s*\n([\s\S]*?)(?=###|\n---|\n##|$)/i,
  };

  for (const [key, pattern] of Object.entries(subSections)) {
    const match = section.match(pattern);
    if (match) {
      context[key] = match[1].replace(/<!--[\s\S]*?-->/g, '').trim();
    }
  }

  return context;
}

/**
 * @private Parse verified facts table.
 */
function _parseFactsTable(markdown, sectionTitle) {
  const facts = [];
  const section = _extractSection(markdown, sectionTitle);
  if (!section) return facts;

  const rows = _parseTableRows(section);
  for (const row of rows) {
    if (row.length >= 3) {
      const fact = {
        claim: (row[1] || '').trim(),
        source_url: _extractUrl(row[2] || ''),
        quote: (row[3] || '').trim(),
      };
      if (fact.claim && fact.claim !== '') {
        facts.push(fact);
      }
    }
  }
  return facts;
}

/**
 * @private Parse open claims table.
 */
function _parseClaimsTable(markdown) {
  const claims = [];
  const section = _extractSection(markdown, 'Open Claims');
  if (!section) return claims;

  const rows = _parseTableRows(section);
  for (const row of rows) {
    if (row.length >= 2) {
      const claim = {
        claim: (row[1] || '').trim(),
        reason: (row[2] || '').trim(),
      };
      if (claim.claim && claim.claim !== '') {
        claims.push(claim);
      }
    }
  }
  return claims;
}

/**
 * @private Parse sources cited list.
 */
function _parseSourcesCited(markdown) {
  const urls = [];
  const section = _extractSection(markdown, 'Sources Cited');
  if (!section) return urls;

  // Match URLs in markdown link format or plain URLs
  const urlRegex = /https?:\/\/[^\s)>\]]+/g;
  let match;
  while ((match = urlRegex.exec(section)) !== null) {
    const url = match[0].replace(/[.,;:]+$/, ''); // strip trailing punctuation
    if (!urls.includes(url)) {
      urls.push(url);
    }
  }
  return urls;
}

/**
 * @private Parse product inventory table.
 */
function _parseProductTable(markdown) {
  const products = [];
  const section = _extractSection(markdown, 'Product Inventory');
  if (!section) return products;

  const rows = _parseTableRows(section);
  for (const row of rows) {
    if (row.length >= 5) {
      const product = {
        name: (row[1] || '').trim(),
        brand: (row[2] || '').trim(),
        weight: (row[3] || '').trim(),
        balance: (row[4] || '').trim(),
        shape: (row[5] || '').trim(),
        face: (row[6] || '').trim(),
        core: (row[7] || '').trim(),
        rrp: (row[8] || '').trim(),
        verdict: (row[9] || '').trim(),
      };
      if (product.name && product.name !== '') {
        products.push(product);
      }
    }
  }
  return products;
}

// --- Table parsing helpers ---

/**
 * @private Extract a section by heading from markdown.
 */
function _extractSection(markdown, heading) {
  // Match ## or ### heading containing the text
  const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(
    `(?:^|\\n)#{1,4}\\s*(?:\\d+\\.?\\s*)?${escapedHeading}[^\\n]*\\n([\\s\\S]*?)(?=\\n#{1,3}\\s|\\n---\\s*\\n|$)`,
    'i'
  );
  const match = markdown.match(pattern);
  return match ? match[1] : null;
}

/**
 * @private Parse rows from a markdown table. Returns array of arrays (cells).
 * Skips the header row and separator row.
 */
function _parseTableRows(section) {
  const rows = [];
  const lines = section.split('\n');
  let headerSeen = false;
  let separatorSeen = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) continue;

    // Check for separator row (|---|---|...)
    if (/^\|[\s-:|]+\|$/.test(trimmed)) {
      separatorSeen = true;
      continue;
    }

    if (!separatorSeen) {
      headerSeen = true;
      continue; // skip header
    }

    // Data row
    const cells = trimmed
      .split('|')
      .map((c) => c.trim())
      .filter((_, i, arr) => i > 0 && i < arr.length); // remove empty first/last from split

    if (cells.length > 0 && cells.some((c) => c !== '')) {
      rows.push(cells);
    }
  }
  return rows;
}

/**
 * @private Extract numbered/bulleted list items from text.
 */
function _extractListItems(text) {
  const items = [];
  const pattern = /(?:^|\n)\s*(?:\d+\.\s*|-\s*|\*\s*)(.*)/g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const item = match[1].trim();
    if (item) items.push(item);
  }
  // If no list items found, try splitting by numbered items in inline format
  if (items.length === 0 && text.includes('1.')) {
    const inlineItems = text.split(/\d+\.\s*/).filter((s) => s.trim());
    for (const item of inlineItems) {
      items.push(item.trim());
    }
  }
  return items;
}

/**
 * @private Extract a URL from a markdown cell (handles [text](url) or plain url).
 */
function _extractUrl(text) {
  const linkMatch = text.match(/\[.*?\]\((https?:\/\/[^\s)]+)\)/);
  if (linkMatch) return linkMatch[1];
  const plainMatch = text.match(/(https?:\/\/[^\s)>\]]+)/);
  if (plainMatch) return plainMatch[1];
  return text.trim();
}

// ---------------------------------------------------------------------------
// Research Report Validator
// ---------------------------------------------------------------------------

/**
 * Validate a parsed research report against the quality bar for its post type.
 *
 * @param {object} report - Parsed research report (output of parseResearchReport)
 * @param {string} postType - Post type key
 * @returns {{ valid: boolean, errors: string[], warnings: string[] }}
 */
function validateResearchReport(report, postType) {
  const errors = [];
  const warnings = [];

  if (!report) {
    return { valid: false, errors: ['Report is null or undefined'], warnings: [] };
  }

  // --- Common checks ---
  if (!report.focus_keyword) {
    errors.push('Missing focus_keyword in report meta');
  }
  if (!report.researched_date) {
    warnings.push('Missing researched_date in report meta');
  }
  if (report.sources_cited.length === 0) {
    errors.push('No sources cited — every report must have sources');
  }

  // Check for banned sources
  const allBanned = [...BANNED_SOURCES, ...RESEARCH_SOURCES.banned];
  const uniqueBanned = [...new Set(allBanned)];
  for (const url of report.sources_cited) {
    for (const banned of uniqueBanned) {
      if (url.includes(banned)) {
        errors.push(`Banned source cited: ${url} (contains ${banned})`);
      }
    }
  }

  // Check for personal visit framing in verified facts
  const visitPhrases = ['we visited', 'we tested', 'we played', 'we tried', 'i visited', 'i tested'];
  for (const fact of report.verified_facts) {
    const combined = `${fact.claim} ${fact.quote}`.toLowerCase();
    for (const phrase of visitPhrases) {
      if (combined.includes(phrase)) {
        errors.push(`Personal visit framing detected in fact: "${fact.claim}"`);
      }
    }
  }

  // --- Post-type-specific checks ---
  const type = postType || 'city_listicle';

  if (type === 'city_listicle' || type === POST_TYPES.CITY_LISTICLE) {
    _validateCityListicle(report, errors, warnings);
  } else if (type === 'product_listicle' || type === POST_TYPES.PRODUCT_LISTICLE) {
    _validateProductListicle(report, errors, warnings);
  } else if (type === 'pillar' || type === POST_TYPES.PILLAR) {
    _validatePillar(report, errors, warnings);
  }

  // Check open claims ratio
  if (report.open_claims.length > report.verified_facts.length) {
    warnings.push(
      `More open claims (${report.open_claims.length}) than verified facts (${report.verified_facts.length}) — research may be incomplete`
    );
  }

  // Count single-source claims across the entire report
  const allText = [
    ...report.verified_facts.map((f) => `${f.claim} ${f.quote}`),
    ...report.open_claims.map((c) => `${c.claim} ${c.reason}`),
  ].join(' ');
  const single_source_claims = (allText.match(/SINGLE_SOURCE/g) || []).length;

  // Sources-per-claim metric
  const total_claims = report.verified_facts.length + report.open_claims.length;
  const sources_per_claim = total_claims > 0
    ? +(report.sources_cited.length / total_claims).toFixed(2)
    : 0;

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    single_source_claims,
    sources_per_claim,
  };
}

/**
 * @private City listicle validation.
 */
function _validateCityListicle(report, errors, warnings) {
  if (report.venues.length === 0) {
    errors.push('No venues found in report — city listicle requires venue inventory');
    return;
  }

  // Minimum venue count for city guides
  if (report.venues.length < 6) {
    errors.push(
      `Only ${report.venues.length} venues found — city guides require at least 6. If fewer exist in the area, the report must explicitly explain why.`
    );
  }

  for (const venue of report.venues) {
    // Court count verification (need 2+ sources)
    if (!venue.courts || venue.courts <= 0) {
      errors.push(`Venue "${venue.name}": missing court count`);
    }

    // Check for review data
    if (venue.rating === null && venue.review_count === null) {
      warnings.push(`Venue "${venue.name}": no review data (needs 1+ review source)`);
    }

    // Check for positives/negatives
    if (venue.positives.length === 0) {
      warnings.push(`Venue "${venue.name}": no positive review themes documented`);
    }
    if (venue.negatives.length === 0) {
      warnings.push(`Venue "${venue.name}": no negative review themes documented`);
    }
  }

  // Check pricing
  if (report.pricing_snapshot.length === 0) {
    errors.push('No pricing data — every venue needs 1+ published price source');
  } else {
    // Check that pricing covers most venues
    const venuesWithPricing = new Set(report.pricing_snapshot.map((p) => p.venue.toLowerCase()));
    for (const venue of report.venues) {
      if (!venuesWithPricing.has(venue.name.toLowerCase())) {
        warnings.push(`Venue "${venue.name}": missing from pricing snapshot`);
      }
    }
  }

  // Check pricing cross-reference — need both cheapest and most expensive
  if (report.pricing_snapshot.length >= 2) {
    const prices = report.pricing_snapshot
      .map((p) => parseFloat((p.off_peak || p.peak || '').replace(/[^0-9.]/g, '')))
      .filter((n) => !isNaN(n) && n > 0);
    if (prices.length >= 2) {
      const range = Math.max(...prices) - Math.min(...prices);
      if (range === 0) {
        warnings.push('All venues show the same price — verify this is accurate and not a single-source copy');
      }
    }
  }

  // Count single-source claims
  const singleSourceCount = report.verified_facts.filter(
    (f) => (f.claim || '').includes('SINGLE_SOURCE') || (f.quote || '').includes('SINGLE_SOURCE')
  ).length + report.open_claims.filter(
    (c) => (c.claim || '').includes('SINGLE_SOURCE') || (c.reason || '').includes('SINGLE_SOURCE')
  ).length;
  if (singleSourceCount > 0) {
    warnings.push(`${singleSourceCount} claim(s) flagged as SINGLE_SOURCE — these need additional verification`);
  }

  // Check local context completeness
  const ctx = report.local_context;
  if (!ctx.climate) warnings.push('Local context: climate section empty');
  if (!ctx.booking_culture) warnings.push('Local context: booking culture section empty');
  if (!ctx.transport) warnings.push('Local context: transport section empty');
  if (!ctx.tournaments) warnings.push('Local context: tournaments section empty');
}

/**
 * @private Product listicle validation.
 */
function _validateProductListicle(report, errors, warnings) {
  if (report.products.length === 0) {
    errors.push('No products found in report — product listicle requires product inventory');
    return;
  }

  if (report.products.length < 6) {
    warnings.push(`Only ${report.products.length} products — target is 6-8 ranked products`);
  }

  for (const product of report.products) {
    if (!product.weight) warnings.push(`Product "${product.name}": missing weight spec`);
    if (!product.balance) warnings.push(`Product "${product.name}": missing balance spec`);
    if (!product.shape) warnings.push(`Product "${product.name}": missing shape spec`);
    if (!product.rrp) warnings.push(`Product "${product.name}": missing RRP`);
  }
}

/**
 * @private Pillar validation.
 */
function _validatePillar(report, errors, warnings) {
  if (report.verified_facts.length < 3) {
    errors.push('Pillar post needs at least 3 verified facts for national statistics');
  }
  if (report.sources_cited.length < 5) {
    warnings.push('Pillar post should cite 5+ sources for comprehensive national coverage');
  }
  if (report.venues.length > 0 && report.venues.length < 6) {
    warnings.push(`Only ${report.venues.length} venues listed — pillar posts should cover at least 6 venues across the country`);
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  buildResearchPrompt,
  buildCityResearchPrompt,
  buildProductResearchPrompt,
  buildPillarResearchPrompt,
  buildTopicalResearchPrompt,
  buildYMYLResearchPrompt,
  parseResearchReport,
  validateResearchReport,
  buildResearchTemplate,
  RESEARCH_SOURCES,
  RESEARCH_QUALITY_BAR,
};
