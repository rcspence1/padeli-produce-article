/**
 * Draft Writer — Stage 4 of the Padeli Blog Pipeline
 *
 * Builds the comprehensive prompt that a Claude sub-agent uses to write
 * the full prose body in Gutenberg blocks. Does NOT write the article
 * itself - it generates the research/writing prompt.
 *
 * Node.js v24+ — zero external dependencies — CommonJS
 */

const {
  BANNED_PHRASES,
  PERSONAL_VISIT_PHRASES,
  MECHANICAL_TRANSITION_OPENERS,
  POST_TYPES,
  WORD_COUNT_TARGETS,
  IMAGE_COUNT_TARGETS,
  getCurrency,
  getDisplayCurrency,
  getEnglishVariant,
} = require('./config');
const { countWords, slugify } = require('./utils');

// ---------------------------------------------------------------------------
// Output schema — the JSON shape the sub-agent must return
// ---------------------------------------------------------------------------

const DRAFT_OUTPUT_SCHEMA = {
  title: 'string - the H1 title',
  slug: 'string - URL slug',
  body_html: 'string - full Gutenberg block HTML (includes TLDR table near top)',
  excerpt: 'string - 150-160 char excerpt',
  da_paragraph: 'string - 50-80 word direct answer',
  tldr_table_html: 'string - the comparison table HTML (wp:table block) shown near top of post',
  faqs: '[{ question, answer }] - 5-8 FAQ pairs',
  yoast_title: 'string - 50-65 chars',
  yoast_meta: 'string - 120-156 chars',
  focus_keyword: 'string',
  word_count: 'number',
  related_reading: '[{ title, slug }] - 6-12 suggestions',
  featured_image_alt: 'string - 60-160 chars',
  featured_image_caption: 'string',
};

// ---------------------------------------------------------------------------
// Voice and style rules
// ---------------------------------------------------------------------------

/**
 * Build the voice and style rules section of the prompt.
 * These are universal across all post types.
 *
 * @param {object} [options] - Optional config
 * @param {string} [options.displayCurrency] - Currency code for reader-facing conversions (e.g. 'GBP')
 * @returns {string} Voice rules block for the prompt
 */
function buildVoiceRules(options = {}) {
  const displayCurrency = options.displayCurrency || null;

  const currencySymbols = { GBP: '\u00a3', USD: '$', EUR: '\u20ac', AUD: 'A$' };
  const currencyRules = displayCurrency
    ? `
### Currency conversions
- When converting local prices for reader context, use ${displayCurrency} (${currencySymbols[displayCurrency] || displayCurrency}) - not USD unless the market is US/CA.
- Format: "IDR 150,000 (roughly ${currencySymbols[displayCurrency] || ''}9)" - parenthetical conversion, not a separate sentence.
- Only convert the headline price range in the DA block and once in the body. Do not convert every single price - readers can do the maths.
`
    : '';

  return `
## VOICE AND STYLE RULES (mandatory - every rule must be followed)

### Language
- Write in British English (organise, colour, centre, -ise endings) unless the target market is US or CA, in which case use US English (organize, color, center, -ize endings).
- No em-dashes or en-dashes anywhere. Use " - " (space hyphen space) instead.
- No emojis anywhere in the output.
${currencyRules}
### Tone
- Direct, confident, warm, proactive.
- Write like a knowledgeable friend who plays padel - not a corporate brochure.
- Never use "At Padeli.com" framing. You are not referring to yourself or the site.

### Paragraph and sentence rules
- Every body paragraph must be under 60 words. Target 30-50 words per paragraph.
- More than 75% of sentences must be under 20 words.
- Active voice in more than 90% of sentences.
- Sentence variation: never start 3 consecutive sentences the same way.

### Formatting variety (mandatory)
- Vary the structure across sections. Not every section should be paragraph-paragraph-paragraph.
- Roughly 25% of H2 sections should use a different format: bullet lists, comparison mini-tables, numbered steps, or bold-lead paragraphs.
- This prevents monotonous AI-style prose. Readers engage longer with varied formatting, which improves dwell time and reduces bounce rate.
- Never use the same structural pattern in 3 consecutive H2 sections.

### Reading level
- Write at a high school reading level. Never college-level. Short sentences, common words, dense meaning.
- Lead every section with the core point first (BLUF - Bottom Line Up Front), then supporting detail.

### Personal visit claims - FORBIDDEN
You have NOT visited any venue. Never imply otherwise. These phrases are banned:
${PERSONAL_VISIT_PHRASES.map((p) => `- "${p}"`).join('\n')}

### Mechanical transitions - FORBIDDEN
Never open a sentence or paragraph with any of these:
${MECHANICAL_TRANSITION_OPENERS.map((t) => `- "${t}"`).join('\n')}

Use natural connectors instead: "That said", "On the flip side", "Worth noting", "The trade-off", or just start a new thought directly.

${buildBannedPhrasesList()}
`.trim();
}

// ---------------------------------------------------------------------------
// Banned phrases list
// ---------------------------------------------------------------------------

/**
 * Build the formatted banned phrases list for inclusion in prompts.
 *
 * @returns {string} Formatted banned phrases block
 */
function buildBannedPhrasesList() {
  const lines = BANNED_PHRASES.map((p) => `- "${p}"`).join('\n');
  return `### BANNED PHRASES (never use any of these - instant fail)
${lines}

If you catch yourself writing any phrase from this list, delete it and rephrase. There is no exception.`;
}

// ---------------------------------------------------------------------------
// Structure rules per post type
// ---------------------------------------------------------------------------

/**
 * Build structure rules for a given post type.
 *
 * @param {string} postType - One of POST_TYPES values
 * @returns {string} Structure rules block for the prompt
 */
function buildStructureRules(postType) {
  const [minWords, maxWords] = WORD_COUNT_TARGETS[postType] || [1500, 3000];
  const [minImages, maxImages] = IMAGE_COUNT_TARGETS[postType] || [3, 6];

  const base = `
## STRUCTURE RULES

### Word count
- Target: ${minWords}-${maxWords} words total body content.
- Do NOT pad to hit the target. Every sentence must earn its place.

### Image placeholders
- Include ${minImages}-${maxImages} image placeholders using: <!-- wp:image {"alt":"descriptive alt text"} -->
- Alt text: 60-160 characters, descriptive, includes location/product context.
`;

  switch (postType) {
    case POST_TYPES.CITY_LISTICLE:
      return base + buildCityListicleStructure();
    case POST_TYPES.PRODUCT_LISTICLE:
      return base + buildProductListicleStructure();
    case POST_TYPES.PILLAR:
      return base + buildPillarStructure();
    case POST_TYPES.CLUSTER:
      return base + buildClusterStructure();
    case POST_TYPES.LEAF:
      return base + buildLeafStructure();
    default:
      return base;
  }
}

function buildCityListicleStructure() {
  return `
### Heading hierarchy (city listicle)

**H1:** "Best Padel Courts in {City} 2026 - {Subtitle}"

**Opening:** Lead with court count + city + booking platform in the hero paragraph. Example: "{City} has {N} padel venues across {areas}. Most book through Playtomic or direct."

**DA paragraph:** ~50-80 words summarising the top 3 venues with clear differentiators (best for beginners, best facilities, best value, etc.)

**TLDR box (immediately after DA paragraph):**
Write a scannable summary box using a Gutenberg wp:table block. This is critical for AI citation - LLMs extract tables preferentially. Format:

| Venue | Courts | Type | Price (per hour) | Best For |
|-------|--------|------|-----------------|----------|
| Venue 1 | N | Indoor/Outdoor | £XX-£XX | descriptor |
| Venue 2 | N | Indoor/Outdoor | £XX-£XX | descriptor |
| ... | ... | ... | ... | ... |

Place this table ABOVE the individual venue sections. Front-load the answer - a reader (or AI) should get the core information from the DA paragraph and this table alone.

**Per venue - H2:** "[Rank]. [Venue Name] - Best for [descriptor] ([location])"

**Per venue - H3s (in this exact order):**
1. "What you get" - courts, surface, indoor/outdoor, facilities
2. "Price and booking" - rates, booking method, peak/off-peak
3. "Who it is for" - skill level, play style, social/competitive
4. "What other players say about [Venue Name]" - aggregated reviews

**Review block format:**
- Bold line: "Rating: [X.X/5]" (aggregated from sources)
- 2-3 sentences of player commentary paraphrased from reviews. Never copy-paste reviews verbatim.

**Additional sections (after all venues):**
- H2: "How we ranked the best padel courts in {City}" - methodology
- H2: "Honourable mentions" - 2-4 venues that didn't make the main list
- H2: "Verified {City} padel prices in 2026" - expanded pricing comparison table with peak/off-peak columns
- H2: "What to know before you book in {City}" - local tips, etiquette, gear
- H2: "FAQ" - 5-8 questions
- H2: "Related reading" - 6-12 internal link suggestions
`;
}

function buildProductListicleStructure() {
  return `
### Heading hierarchy (product listicle)

**H1:** "Best {Product} {Market} 2026 - {Subtitle}"

**DA paragraph:** ~130 words. Top 3 picks with bold product name + primary use case + price point.

**TLDR box (immediately after DA paragraph):**
Write a scannable comparison table using a Gutenberg wp:table block. AI systems pull directly from tables - this is critical for LLM citation. Format:

| Racket | Weight | Shape | Balance | Price | Best For |
|--------|--------|-------|---------|-------|----------|
| Brand Model | XXXg | Round/Diamond/Teardrop | Low/Mid/High | £XXX | descriptor |
| ... | ... | ... | ... | ... | ... |

Place this table ABOVE the individual product sections.

**Per product - H2:** "[Rank]. [Brand Model Year] - Best [benefit] ([level])"

**Per product - H3s (in this exact order):**
1. "What you get:" followed by bullet specs:
   - Shape, Weight, Balance, Face material, Core material, Profile/thickness
2. "Where to buy:" - 3 retailer links per product with brief rationale for each retailer
3. "Who it is for:" - skill level, play style, what type of player benefits
4. "What other players say" - aggregated player feedback

**Rating:** X.X/10 aggregated from multiple sources. Display as bold line.

**Specs format:** Use a bullet list, not a table, within each product section.

**Additional sections (after all products):**
- H2: "How we chose" - methodology, testing criteria
- H2: "Buying guide" - what to look for (shape, weight, materials)
- H2: "FAQ" - 5-8 questions
- H2: "Related reading" - 6-12 internal link suggestions
`;
}

function buildPillarStructure() {
  return `
### Heading hierarchy (pillar page)

**IMPORTANT:** This is NOT a ranked list. Organise by topic then by neighbourhood/area.

**H1:** Descriptive title covering the full topic scope.

**H2s:** Topic sections (e.g. "Indoor courts", "Outdoor courts", "Courts by area", "Booking platforms", "Pricing overview")

**H3s:** Neighbourhood or sub-topic breakdowns within each H2.

**TLDR box (near top, after opening section):**
Write a scannable summary table covering ALL key venues. AI systems extract tables preferentially - this is critical for LLM citation.

**Comparison table:** Include a comprehensive table covering 24+ venues with key columns (name, area, courts, surface, indoor/outdoor, booking, price range).

**Internal linking:** Hub-and-spoke model. Include 40+ internal links to cluster and leaf posts. Every cluster and leaf in the topic silo should be linked from this pillar.

**Additional sections:**
- H2: "FAQ" - 5-8 questions
- H2: "Related reading" - 6-12 internal link suggestions
`;
}

function buildClusterStructure() {
  return `
### Heading hierarchy (cluster post)

**H2s:** 4-6 main sections covering the cluster topic in depth.
**H3s:** 2-3 sub-sections under each H2.

**Internal linking:**
- Link UP to the parent pillar page (at least 2-3 links)
- Link ACROSS to sibling cluster posts (at least 2-3 links)
- Link DOWN to child leaf posts where relevant

**Additional sections:**
- H2: "FAQ" - 5-8 questions
- H2: "Related reading" - 6-12 internal link suggestions
`;
}

function buildLeafStructure() {
  return `
### Heading hierarchy (leaf post)

**H2s:** 3-4 main sections. Keep focused and tight.

**Internal linking:**
- Link UP to the parent cluster post (at least 1-2 links)
- Link UP to the pillar page (at least 1 link)

**Additional sections:**
- H2: "FAQ" - 3-5 questions
- H2: "Related reading" - 4-8 internal link suggestions
`;
}

// ---------------------------------------------------------------------------
// FAQ prompt builder
// ---------------------------------------------------------------------------

/**
 * Build FAQ writing instructions for the sub-agent.
 *
 * @param {Array<string>} questions - List of FAQ questions to answer
 * @param {string} postContext - Brief context about the post topic
 * @returns {string} FAQ instructions block
 */
function buildFAQPrompt(questions, postContext) {
  const questionList = (questions || []).map((q, i) => `${i + 1}. ${q}`).join('\n');

  return `
## FAQ SECTION

Write answers for the following questions in the context of: ${postContext || 'this article'}

${questionList}

### FAQ rules:
- Each answer: 40-80 words. Concise and direct.
- Lead with the answer, then add context. No throat-clearing.
- Use the same voice rules as the rest of the article.
- Wrap in FAQ schema markup (wp:html block with application/ld+json).
- Return as array of { question, answer } in the JSON output.
`.trim();
}

// ---------------------------------------------------------------------------
// Direct Answer (DA) prompt builder
// ---------------------------------------------------------------------------

/**
 * Build DA paragraph writing instructions.
 *
 * @param {object} brief - The content brief with topic/city/market info
 * @param {Array<object>} topItems - Top 3 items (venues or products) to feature
 * @returns {string} DA instructions block
 */
function buildDAPrompt(brief, topItems) {
  const itemSummary = (topItems || [])
    .map((item, i) => `${i + 1}. ${item.name || item.title} - ${item.differentiator || item.bestFor || 'top pick'}`)
    .join('\n');

  const isProduct = brief?.postType === POST_TYPES.PRODUCT_LISTICLE;
  const wordTarget = isProduct ? '~130 words' : '~50-80 words';

  return `
## DIRECT ANSWER PARAGRAPH

Write a DA paragraph of ${wordTarget} that:
- Immediately answers the search query
- Names the top 3 picks with their key differentiator
${isProduct ? '- Includes bold product names, primary use case, and price point' : '- Includes venue names with what makes each one stand out'}
- Is self-contained (a reader should get value from this paragraph alone)

Top items to feature:
${itemSummary || '(Use the top 3 from your ranked list)'}
`.trim();
}

// ---------------------------------------------------------------------------
// Review block prompt builder
// ---------------------------------------------------------------------------

/**
 * Build review block writing instructions for a venue.
 *
 * @param {object} venue - Venue object with name, ratings
 * @param {Array<object>} reviews - Array of review snippets
 * @returns {string} Review block instructions
 */
function buildReviewBlockPrompt(venue, reviews) {
  const reviewSnippets = (reviews || [])
    .map((r) => `- "${r.text || r.snippet}" (${r.source || 'player review'}, ${r.rating || 'no rating'})`)
    .join('\n');

  return `
## REVIEW BLOCK FOR: ${venue?.name || 'this venue'}

Write the "What other players say about ${venue?.name || 'this venue'}" section:

1. Bold opening line: "Rating: [X.X/5]" - aggregate from available sources
2. 2-3 sentences paraphrasing player sentiment. NEVER copy-paste reviews verbatim.
3. Balance positive and critical feedback where available.
4. If reviews mention specific courts, coaching, or facilities, include those details.

Available review data:
${reviewSnippets || '(No specific reviews provided - use cautious language: "Reviews on Google and Playtomic suggest...")'}
`.trim();
}

// ---------------------------------------------------------------------------
// Post-type-specific prompt builders
// ---------------------------------------------------------------------------

/**
 * Build complete prompt for a city listicle post.
 *
 * @param {object} outline - The outline with heading hierarchy
 * @param {string} researchReport - The research report content
 * @param {object} brief - The content brief
 * @param {object} options - Additional options
 * @returns {string} Complete prompt string
 */
function buildCityListiclePrompt(outline, researchReport, brief, options = {}) {
  const city = brief?.city || outline?.city || 'the city';
  const country = brief?.country_code || brief?.market || brief?.country || outline?.country || '';
  const currency = getCurrency(country);
  const displayCurrency = getDisplayCurrency(brief?.country_code || country);
  const englishVariant = getEnglishVariant(country);
  const year = options.year || new Date().getFullYear();

  return `
# WRITING TASK: City Listicle - Best Padel Courts in ${city} ${year}

You are writing a comprehensive guide to the best padel courts in ${city}.
Your job is to produce the FULL article as Gutenberg block HTML and return it as structured JSON.

## LANGUAGE
- Use ${englishVariant} throughout.
- Currency: ${currency}
- Display currency for conversions: ${displayCurrency}

${buildVoiceRules({ displayCurrency })}

${buildStructureRules(POST_TYPES.CITY_LISTICLE)}

## OUTLINE TO FOLLOW
Use this exact heading hierarchy. Do not add, remove, or reorder sections:

\`\`\`
${typeof outline === 'string' ? outline : JSON.stringify(outline, null, 2)}
\`\`\`

## RESEARCH DATA (your source material)
Use this research to write accurate, specific content. Cite numbers, prices, and details from this data:

\`\`\`
${researchReport || '(No research report provided - use cautious language for all claims)'}
\`\`\`

${buildVerificationFallback()}

${buildOutputInstructions()}
`.trim();
}

/**
 * Build complete prompt for a product listicle post.
 *
 * @param {object} outline - The outline with heading hierarchy
 * @param {string} researchReport - The research report content
 * @param {object} brief - The content brief
 * @param {object} options - Additional options
 * @returns {string} Complete prompt string
 */
function buildProductListiclePrompt(outline, researchReport, brief, options = {}) {
  const product = brief?.product || outline?.product || 'padel equipment';
  const market = brief?.market || outline?.market || '';
  const country = brief?.country_code || brief?.market || brief?.country || outline?.country || '';
  const currency = getCurrency(country);
  const displayCurrency = getDisplayCurrency(brief?.country_code || country);
  const englishVariant = getEnglishVariant(country);
  const year = options.year || new Date().getFullYear();

  return `
# WRITING TASK: Product Listicle - Best ${product} ${market} ${year}

You are writing a comprehensive product guide for padel players.
Your job is to produce the FULL article as Gutenberg block HTML and return it as structured JSON.

## LANGUAGE
- Use ${englishVariant} throughout.
- Currency: ${currency}
- Display currency for conversions: ${displayCurrency}

${buildVoiceRules({ displayCurrency })}

${buildStructureRules(POST_TYPES.PRODUCT_LISTICLE)}

## OUTLINE TO FOLLOW
Use this exact heading hierarchy. Do not add, remove, or reorder sections:

\`\`\`
${typeof outline === 'string' ? outline : JSON.stringify(outline, null, 2)}
\`\`\`

## RESEARCH DATA (your source material)
Use this research to write accurate, specific content. Cite specs, prices, and details from this data:

\`\`\`
${researchReport || '(No research report provided - use cautious language for all claims)'}
\`\`\`

${buildVerificationFallback()}

${buildOutputInstructions()}
`.trim();
}

/**
 * Build complete prompt for a pillar page.
 *
 * @param {object} outline - The outline with heading hierarchy
 * @param {string} researchReport - The research report content
 * @param {object} brief - The content brief
 * @param {object} options - Additional options
 * @returns {string} Complete prompt string
 */
function buildPillarPrompt(outline, researchReport, brief, options = {}) {
  const topic = brief?.topic || outline?.topic || 'padel';
  const country = brief?.country || outline?.country || '';
  const displayCurrency = getDisplayCurrency(brief?.country_code || country);
  const englishVariant = getEnglishVariant(country);
  const year = options.year || new Date().getFullYear();

  return `
# WRITING TASK: Pillar Page - ${topic} ${year}

You are writing the main pillar page for a topic silo.
This is the hub page that links out to all cluster and leaf posts in this topic.
Your job is to produce the FULL article as Gutenberg block HTML and return it as structured JSON.

## LANGUAGE
- Use ${englishVariant} throughout.
- Display currency for conversions: ${displayCurrency}

${buildVoiceRules({ displayCurrency })}

${buildStructureRules(POST_TYPES.PILLAR)}

## OUTLINE TO FOLLOW
Use this exact heading hierarchy. Do not add, remove, or reorder sections:

\`\`\`
${typeof outline === 'string' ? outline : JSON.stringify(outline, null, 2)}
\`\`\`

## RESEARCH DATA (your source material)

\`\`\`
${researchReport || '(No research report provided - use cautious language for all claims)'}
\`\`\`

${buildVerificationFallback()}

${buildOutputInstructions()}
`.trim();
}

/**
 * Build complete prompt for a cluster post.
 *
 * @param {object} outline - The outline with heading hierarchy
 * @param {string} researchReport - The research report content
 * @param {object} brief - The content brief
 * @param {object} options - Additional options
 * @returns {string} Complete prompt string
 */
function buildClusterPrompt(outline, researchReport, brief, options = {}) {
  const topic = brief?.topic || outline?.topic || 'padel';
  const parentPillar = brief?.parentPillar || outline?.parentPillar || '';
  const country = brief?.country || outline?.country || '';
  const displayCurrency = getDisplayCurrency(brief?.country_code || country);
  const englishVariant = getEnglishVariant(country);
  const year = options.year || new Date().getFullYear();

  return `
# WRITING TASK: Cluster Post - ${topic} ${year}

You are writing a cluster post that supports the pillar page: "${parentPillar}".
Link UP to that pillar and ACROSS to sibling cluster posts.
Your job is to produce the FULL article as Gutenberg block HTML and return it as structured JSON.

## LANGUAGE
- Use ${englishVariant} throughout.
- Display currency for conversions: ${displayCurrency}

${buildVoiceRules({ displayCurrency })}

${buildStructureRules(POST_TYPES.CLUSTER)}

## OUTLINE TO FOLLOW
Use this exact heading hierarchy. Do not add, remove, or reorder sections:

\`\`\`
${typeof outline === 'string' ? outline : JSON.stringify(outline, null, 2)}
\`\`\`

## RESEARCH DATA (your source material)

\`\`\`
${researchReport || '(No research report provided - use cautious language for all claims)'}
\`\`\`

${buildVerificationFallback()}

${buildOutputInstructions()}
`.trim();
}

/**
 * Build complete prompt for a leaf post.
 *
 * @param {object} outline - The outline with heading hierarchy
 * @param {string} researchReport - The research report content
 * @param {object} brief - The content brief
 * @param {object} options - Additional options
 * @returns {string} Complete prompt string
 */
function buildLeafPrompt(outline, researchReport, brief, options = {}) {
  const topic = brief?.topic || outline?.topic || 'padel';
  const parentCluster = brief?.parentCluster || outline?.parentCluster || '';
  const parentPillar = brief?.parentPillar || outline?.parentPillar || '';
  const country = brief?.country || outline?.country || '';
  const displayCurrency = getDisplayCurrency(brief?.country_code || country);
  const englishVariant = getEnglishVariant(country);
  const year = options.year || new Date().getFullYear();

  return `
# WRITING TASK: Leaf Post - ${topic} ${year}

You are writing a focused leaf post.
${parentCluster ? `Link UP to the parent cluster: "${parentCluster}".` : ''}
${parentPillar ? `Link UP to the pillar page: "${parentPillar}".` : ''}
Your job is to produce the FULL article as Gutenberg block HTML and return it as structured JSON.

## LANGUAGE
- Use ${englishVariant} throughout.
- Display currency for conversions: ${displayCurrency}

${buildVoiceRules({ displayCurrency })}

${buildStructureRules(POST_TYPES.LEAF)}

## OUTLINE TO FOLLOW
Use this exact heading hierarchy. Do not add, remove, or reorder sections:

\`\`\`
${typeof outline === 'string' ? outline : JSON.stringify(outline, null, 2)}
\`\`\`

## RESEARCH DATA (your source material)

\`\`\`
${researchReport || '(No research report provided - use cautious language for all claims)'}
\`\`\`

${buildVerificationFallback()}

${buildOutputInstructions()}
`.trim();
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Build the verification fallback instruction block.
 * @returns {string}
 */
function buildVerificationFallback() {
  return `
## IF YOU CANNOT VERIFY A CLAIM

Use measured language for unverified specifics. Do not refuse - return JSON with KNOWN facts and cautious language for anything unverified.

Examples of cautious language:
- "appears to be"
- "live rates show at the booking step on Playtomic"
- "at the time of writing"
- "check the venue's website for current pricing"
- "typically ranges from"

Never invent prices, court counts, or ratings. If data is missing, say so naturally rather than guessing.
`.trim();
}

/**
 * Build the output format instructions including the schema.
 * @returns {string}
 */
function buildOutputInstructions() {
  return `
## OUTPUT FORMAT

Return a single JSON object with exactly these fields:

\`\`\`json
${JSON.stringify(DRAFT_OUTPUT_SCHEMA, null, 2)}
\`\`\`

### Field requirements:
- **title**: The H1 title. Do not wrap in H1 tags - just the text.
- **slug**: URL-safe slug derived from the title.
- **body_html**: The FULL article body as Gutenberg block HTML. Every paragraph wrapped in <!-- wp:paragraph --><p>...</p><!-- /wp:paragraph -->. Every heading in <!-- wp:heading {"level":N} --><hN>...</hN><!-- /wp:heading -->.
- **excerpt**: 150-160 characters. Compelling summary for search results.
- **da_paragraph**: The direct answer paragraph (50-80 words for city listicle, ~130 words for product listicle).
- **faqs**: Array of { question, answer } objects. 5-8 pairs.
- **yoast_title**: 50-65 characters. Include focus keyword near the start.
- **yoast_meta**: 120-156 characters. Compelling, includes focus keyword.
- **focus_keyword**: The primary keyword this post targets.
- **word_count**: Your count of words in body_html (excluding HTML tags).
- **related_reading**: Array of { title, slug } objects. 6-12 suggestions for internal links.
- **featured_image_alt**: 60-160 characters. Descriptive alt text for the featured image.
- **featured_image_caption**: Brief caption for the featured image.

### Gutenberg block format:
- Paragraphs: \`<!-- wp:paragraph --><p>Text here.</p><!-- /wp:paragraph -->\`
- Headings: \`<!-- wp:heading {"level":2} --><h2>Heading</h2><!-- /wp:heading -->\`
- Lists: \`<!-- wp:list --><ul><li>Item</li></ul><!-- /wp:list -->\`
- Tables: \`<!-- wp:table --><figure class="wp-block-table"><table><thead>...</thead><tbody>...</tbody></table></figure><!-- /wp:table -->\`
- Images: \`<!-- wp:image {"alt":"descriptive alt"} --><!-- /wp:image -->\` (placeholder only)
- FAQ schema: \`<!-- wp:html --><script type="application/ld+json">...</script><!-- /wp:html -->\`

Return ONLY the JSON object. No markdown wrapping, no explanation, no preamble.
`.trim();
}

// ---------------------------------------------------------------------------
// Main prompt builder — dispatches to post-type-specific builder
// ---------------------------------------------------------------------------

/**
 * Build the complete draft prompt for a given post type.
 * Dispatches to the appropriate post-type-specific builder.
 *
 * @param {object} outline - The outline with heading hierarchy
 * @param {string} researchReport - The research report content
 * @param {object} brief - The content brief (must include postType)
 * @param {object} [options] - Additional options (year, etc.)
 * @returns {string} Complete prompt string for the sub-agent
 */
function buildDraftPrompt(outline, researchReport, brief, options = {}) {
  const postType = brief?.postType || outline?.postType || POST_TYPES.CITY_LISTICLE;

  switch (postType) {
    case POST_TYPES.CITY_LISTICLE:
      return buildCityListiclePrompt(outline, researchReport, brief, options);
    case POST_TYPES.PRODUCT_LISTICLE:
      return buildProductListiclePrompt(outline, researchReport, brief, options);
    case POST_TYPES.PILLAR:
      return buildPillarPrompt(outline, researchReport, brief, options);
    case POST_TYPES.CLUSTER:
      return buildClusterPrompt(outline, researchReport, brief, options);
    case POST_TYPES.LEAF:
      return buildLeafPrompt(outline, researchReport, brief, options);
    default:
      throw new Error(`Unknown post type: "${postType}". Expected one of: ${Object.values(POST_TYPES).join(', ')}`);
  }
}

// ---------------------------------------------------------------------------
// Draft output validation
// ---------------------------------------------------------------------------

/**
 * Validate the sub-agent's draft output against quality rules.
 *
 * @param {string} html - The body_html from the sub-agent's output
 * @param {string} postType - The post type to validate against
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateDraftOutput(html, postType) {
  const errors = [];

  if (!html || typeof html !== 'string') {
    return { valid: false, errors: ['body_html is missing or not a string'] };
  }

  // 1. Word count within target range
  const wordCount = countWords(html);
  const [minWords, maxWords] = WORD_COUNT_TARGETS[postType] || [800, 4500];

  if (wordCount < minWords) {
    errors.push(`Word count ${wordCount} is below minimum ${minWords} for ${postType}`);
  }
  if (wordCount > maxWords) {
    errors.push(`Word count ${wordCount} exceeds maximum ${maxWords} for ${postType}`);
  }

  // 2. No banned phrases
  const lowerHtml = html.toLowerCase();
  for (const phrase of BANNED_PHRASES) {
    if (lowerHtml.includes(phrase.toLowerCase())) {
      errors.push(`Banned phrase found: "${phrase}"`);
    }
  }

  // 3. No personal visit claims
  for (const phrase of PERSONAL_VISIT_PHRASES) {
    if (lowerHtml.includes(phrase.toLowerCase())) {
      errors.push(`Personal visit claim found: "${phrase}"`);
    }
  }

  // 4. No em/en dashes
  if (html.includes('\u2014')) {
    errors.push('Em-dash (\u2014) found. Use " - " (space hyphen space) instead.');
  }
  if (html.includes('\u2013')) {
    errors.push('En-dash (\u2013) found. Use " - " (space hyphen space) instead.');
  }

  // 5. Paragraphs under 60 words
  const pRegex = /<p[^>]*>([\s\S]*?)<\/p>/gi;
  let match;
  let paraIndex = 0;
  const longParagraphs = [];
  while ((match = pRegex.exec(html)) !== null) {
    const paraText = match[1].replace(/<[^>]*>/g, '').trim();
    if (!paraText) continue;
    paraIndex++;
    const paraWords = paraText.split(/\s+/).length;
    if (paraWords > 60) {
      longParagraphs.push({ index: paraIndex, words: paraWords });
    }
  }
  if (longParagraphs.length > 0) {
    const details = longParagraphs.map((p) => `para ${p.index} (${p.words} words)`).join(', ');
    errors.push(`${longParagraphs.length} paragraph(s) exceed 60 words: ${details}`);
  }

  // 6. Has FAQ section
  if (!html.includes('FAQ') && !html.includes('faq') && !html.includes('Frequently')) {
    errors.push('No FAQ section found in body_html');
  }

  // 7. Has Related Reading section
  const hasRelated = /related\s+reading/i.test(html) || /related\s+articles/i.test(html) || /further\s+reading/i.test(html);
  if (!hasRelated) {
    errors.push('No "Related reading" section found in body_html');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  buildDraftPrompt,
  buildCityListiclePrompt,
  buildProductListiclePrompt,
  buildPillarPrompt,
  buildClusterPrompt,
  buildLeafPrompt,
  buildVoiceRules,
  buildStructureRules,
  buildBannedPhrasesList,
  buildFAQPrompt,
  buildDAPrompt,
  buildReviewBlockPrompt,
  validateDraftOutput,
  DRAFT_OUTPUT_SCHEMA,
};
