/**
 * Outline Generator — Stage 3 of the Padeli Blog Pipeline
 *
 * Takes a research report + brief and produces the heading hierarchy,
 * DA paragraph plan, and FAQ questions for each post type.
 *
 * Node.js v24+ — zero external dependencies — CommonJS
 */

const { POST_TYPES, WORD_COUNT_TARGETS, getEnglishVariant, getCurrency } = require('./config');
const { countWords, slugify } = require('./utils');

// ---------------------------------------------------------------------------
// Blueprint Selection
// ---------------------------------------------------------------------------

/**
 * Map (postType, tier) to the correct builder function name.
 *
 * @param {string} postType - One of POST_TYPES values
 * @param {string} tier - 'cornerstone' | 'supporting' | etc.
 * @returns {string} Builder function name
 */
function selectBlueprint(postType, tier) {
  const map = {
    [POST_TYPES.CITY_LISTICLE]: 'buildCityListicleOutline',
    [POST_TYPES.PRODUCT_LISTICLE]: 'buildProductListicleOutline',
    [POST_TYPES.PILLAR]: 'buildPillarOutline',
    [POST_TYPES.CLUSTER]: 'buildClusterOutline',
    [POST_TYPES.LEAF]: 'buildLeafOutline',
  };
  return map[postType] || 'buildLeafOutline';
}

// ---------------------------------------------------------------------------
// DA Prompt Generator
// ---------------------------------------------------------------------------

/**
 * Build a prompt string instructing the writer how to compose the DA paragraph.
 *
 * @param {object} brief - The post brief
 * @param {Array} topItems - Top 3 venues/products from research
 * @returns {string} Instruction prompt for the DA paragraph
 */
function generateDAPrompt(brief, topItems) {
  const { post_type, focus_keyword, market } = brief;
  const variant = getEnglishVariant(market || brief.country_code);
  const items = topItems || [];
  const topNames = items.slice(0, 3).map((i) => i.name).filter(Boolean);
  const nameList = topNames.length ? topNames.join(', ') : '[top items from research]';

  switch (post_type) {
    case POST_TYPES.CITY_LISTICLE:
      return (
        `Write a 50-80 word direct answer paragraph for "${focus_keyword}". ` +
        `Summarise the top 3 venues (${nameList}) with one key differentiator each. ` +
        `Use ${variant}. No fluff, no filler phrases. ` +
        `Open with a factual statement about how many courts/venues exist in the area. ` +
        `End with a line that transitions to the ranked list below.`
      );

    case POST_TYPES.PRODUCT_LISTICLE:
      return (
        `Write a 100-130 word direct answer paragraph for "${focus_keyword}". ` +
        `Name the top 3 products (${nameList}), bold each name, state use case and price range. ` +
        `Use ${variant}. No fluff. ` +
        `Open with a clear statement about what makes a good choice in this category. ` +
        `End with a transition to the detailed reviews below.`
      );

    case POST_TYPES.PILLAR:
      return (
        `Write a 100-130 word direct answer paragraph for "${focus_keyword}". ` +
        `Cover the market scale (number of venues/courts) and name 2-3 key venues or areas. ` +
        `Use ${variant}. No fluff. ` +
        `This is a comprehensive guide, so set up the breadth of topics covered.`
      );

    case POST_TYPES.CLUSTER:
      return (
        `Write a 50-80 word direct answer paragraph for "${focus_keyword}". ` +
        `Use ${variant}. Be specific and factual. ` +
        `Directly answer the core question in the first sentence. ` +
        `Support with 1-2 key facts from the research.`
      );

    case POST_TYPES.LEAF:
      return (
        `Write a 50-60 word direct answer paragraph for "${focus_keyword}". ` +
        `Use ${variant}. Be concise and factual. ` +
        `Answer the question in the first sentence, then add one supporting detail.`
      );

    default:
      return (
        `Write a 50-80 word direct answer paragraph for "${focus_keyword}". ` +
        `Use ${variant}. Be specific and factual, no filler.`
      );
  }
}

// ---------------------------------------------------------------------------
// FAQ Question Generator
// ---------------------------------------------------------------------------

/**
 * Generate FAQ questions tailored to the post type and research data.
 *
 * @param {object} brief - The post brief
 * @param {object} researchReport - Parsed research report
 * @param {number} count - Number of FAQ questions to generate
 * @returns {string[]} Array of FAQ question strings
 */
function generateFAQQuestions(brief, researchReport, count) {
  const { post_type, focus_keyword, market, title } = brief;
  const location = extractLocation(brief);
  const currency = getCurrency(market || brief.country_code);
  const questions = [];

  switch (post_type) {
    case POST_TYPES.CITY_LISTICLE: {
      const venues = (researchReport && researchReport.venues) || [];
      const topVenue = venues.length ? venues[0].name : null;

      questions.push(`Where is the best padel court in ${location}?`);
      questions.push(`How much does padel cost in ${location}?`);
      questions.push(`Can you play padel indoors in ${location}?`);
      questions.push(`Do you need to be a member to play padel in ${location}?`);
      questions.push(`How do you book a padel court in ${location}?`);
      questions.push(`Are there padel coaching sessions in ${location}?`);
      questions.push(`What equipment do you need to play padel in ${location}?`);
      if (topVenue) {
        questions.push(`What are the court prices at ${topVenue}?`);
      }
      questions.push(`Is padel suitable for beginners in ${location}?`);
      questions.push(`Are there padel leagues or tournaments in ${location}?`);
      break;
    }

    case POST_TYPES.PRODUCT_LISTICLE: {
      const products = (researchReport && researchReport.products) || [];
      const topProduct = products.length ? products[0].name : null;
      const category = extractProductCategory(focus_keyword);

      questions.push(`What is the best ${category} for beginners?`);
      questions.push(`Where can I buy ${category} in the ${market || 'UK'}?`);
      questions.push(`How much should I spend on a ${category}?`);
      questions.push(`What is the difference between diamond, round, and teardrop padel rackets?`);
      if (topProduct) {
        questions.push(`Is the ${topProduct} worth the price?`);
      }
      questions.push(`How often should you replace your ${category}?`);
      questions.push(`What weight ${category} should I choose?`);
      questions.push(`Do expensive padel rackets make a difference?`);
      questions.push(`What ${category} do professional players use?`);
      questions.push(`Can you use a tennis racket for padel?`);
      questions.push(`What is the best ${category} for power?`);
      questions.push(`What is the best ${category} for control?`);
      break;
    }

    case POST_TYPES.PILLAR: {
      questions.push(`How popular is padel in ${location}?`);
      questions.push(`Where can you play padel in ${location}?`);
      questions.push(`How much does padel cost in ${location}?`);
      questions.push(`Is padel growing in ${location}?`);
      questions.push(`Are there indoor padel courts in ${location}?`);
      questions.push(`Can beginners play padel in ${location}?`);
      questions.push(`Are there padel tournaments in ${location}?`);
      questions.push(`What is the best area for padel in ${location}?`);
      questions.push(`Do you need your own equipment to play padel in ${location}?`);
      questions.push(`Is there padel coaching available in ${location}?`);
      break;
    }

    case POST_TYPES.CLUSTER: {
      // Cluster questions are more topic-specific; generate from focus keyword
      questions.push(...generateTopicFAQs(focus_keyword, location, 8));
      break;
    }

    case POST_TYPES.LEAF: {
      questions.push(...generateTopicFAQs(focus_keyword, location, 7));
      break;
    }
  }

  // Trim to requested count, ensure no duplicates
  const unique = [...new Set(questions)];
  return unique.slice(0, count);
}

// ---------------------------------------------------------------------------
// Pricing Post Detection
// ---------------------------------------------------------------------------

/**
 * Detect if a brief targets a pricing/cost topic, based on focus keyword.
 *
 * @param {object} brief - Post brief
 * @returns {boolean} True if the post is about pricing
 */
function isPricingPost(brief) {
  const pricingKeywords = ['cost', 'price', 'pricing', 'budget', 'cheap', 'expensive', 'how much', 'afford'];
  return pricingKeywords.some(kw => brief.focus_keyword?.toLowerCase().includes(kw));
}

// ---------------------------------------------------------------------------
// Builder Functions
// ---------------------------------------------------------------------------

/**
 * Build outline for a city listicle post.
 *
 * @param {object} brief - Post brief
 * @param {object} report - Research report
 * @param {object} options - Additional options
 * @returns {object} Outline object
 */
function buildCityListicleOutline(brief, report, options = {}) {
  const location = extractLocation(brief);
  const venues = (report && report.venues) || [];
  const pricing = (report && report.pricing_snapshot) || [];
  const rankedVenues = venues.slice(0, options.maxVenues || 7);
  const topItems = rankedVenues.slice(0, 3);

  const sections = [];

  // Ranked venue sections
  rankedVenues.forEach((venue, idx) => {
    const rank = idx + 1;
    const descriptor = venue.best_for || inferDescriptor(venue);
    const loc = venue.neighbourhood || '';
    const heading = `${rank}. ${venue.name} - Best for ${descriptor}${loc ? ` (${loc})` : ''}`;

    sections.push({
      level: 2,
      heading,
      subsections: [
        {
          level: 3,
          heading: 'What you get',
          notes: buildWhatYouGetNotes(venue),
        },
        {
          level: 3,
          heading: 'Price and booking',
          notes: buildPriceNotes(venue, brief),
        },
        {
          level: 3,
          heading: 'Who it is for',
          notes: buildAudienceNotes(venue),
        },
        {
          level: 3,
          heading: `What other players say about ${venue.name}`,
          notes: buildReviewNotes(venue),
        },
      ],
    });
  });

  // Supporting sections
  sections.push({
    level: 2,
    heading: `How we ranked the best padel courts in ${location}`,
    subsections: [],
    notes: 'Methodology: courts, facilities, pricing transparency, reviews, booking ease.',
  });

  sections.push({
    level: 2,
    heading: `${location} padel at a glance`,
    subsections: [],
    table: true,
    notes: 'Comparison table: venue, courts, indoor/outdoor, price range, rating.',
  });

  sections.push({
    level: 2,
    heading: 'Honourable mentions',
    subsections: [],
    notes: venues.length > rankedVenues.length
      ? `Cover ${venues.length - rankedVenues.length} additional venues briefly.`
      : 'Any venues that narrowly missed the ranked list.',
  });

  sections.push({
    level: 2,
    heading: 'Verified 2026 prices',
    subsections: [],
    table: true,
    notes: pricing.length
      ? `Table with ${pricing.length} venue price rows. Include off-peak and peak.`
      : 'Price comparison table — populate from research.',
  });

  sections.push({
    level: 2,
    heading: `What to know before you book in ${location}`,
    subsections: [],
    notes: 'Practical tips: booking apps, peak times, what to bring, cancellation policies.',
  });

  const faqCount = options.faqCount || 8;
  const faqQuestions = generateFAQQuestions(brief, report, faqCount);

  sections.push({
    level: 2,
    heading: `FAQ - Padel Courts in ${location}`,
    subsections: [],
    notes: `${faqCount} questions in details accordion.`,
  });

  const relatedSuggestions = generateRelatedSuggestions(brief, 11);

  sections.push({
    level: 2,
    heading: 'Related reading',
    subsections: [],
    notes: `${relatedSuggestions.length} internal links.`,
  });

  return {
    post_type: brief.post_type,
    tier: brief.tier,
    title: brief.title,
    slug: brief.slug,
    word_count_target: WORD_COUNT_TARGETS[brief.post_type] || [2500, 4500],
    da_prompt: generateDAPrompt(brief, topItems),
    sections,
    faq_questions: faqQuestions,
    related_reading_suggestions: relatedSuggestions,
    image_targets: {
      featured: rankedVenues.length ? rankedVenues[0].name : 'Top venue',
      per_section: 'One per ranked venue',
    },
  };
}

/**
 * Build outline for a product listicle post.
 *
 * @param {object} brief - Post brief
 * @param {object} report - Research report
 * @param {object} options - Additional options
 * @returns {object} Outline object
 */
function buildProductListicleOutline(brief, report, options = {}) {
  const products = (report && report.products) || [];
  const rankedProducts = products.slice(0, options.maxProducts || 7);
  const topItems = rankedProducts.slice(0, 3);
  const category = extractProductCategory(brief.focus_keyword);
  const market = brief.market || 'UK';

  const sections = [];

  // Ranked product sections
  rankedProducts.forEach((product, idx) => {
    const rank = idx + 1;
    const benefit = product.best_for || inferProductBenefit(product);
    const level = product.level || 'all levels';
    const heading = `${rank}. ${product.name} - Best ${benefit} (${level})`;

    sections.push({
      level: 2,
      heading,
      subsections: [
        {
          level: 3,
          heading: 'What you get:',
          notes: buildProductSpecNotes(product),
        },
        {
          level: 3,
          heading: `Where to buy in the ${market}:`,
          notes: buildStockistNotes(product),
        },
        {
          level: 3,
          heading: 'Who it is for:',
          notes: buildProductAudienceNotes(product),
        },
        {
          level: 3,
          heading: `What other players say about ${product.name}`,
          notes: buildProductReviewNotes(product),
        },
      ],
    });
  });

  // Honourable mentions
  sections.push({
    level: 2,
    heading: 'Honourable mentions',
    subsections: [],
    notes: products.length > rankedProducts.length
      ? `Cover ${products.length - rankedProducts.length} additional products briefly.`
      : 'Products that narrowly missed the ranked list.',
  });

  // Verified prices table
  sections.push({
    level: 2,
    heading: 'Verified 2026 prices',
    subsections: [],
    table: true,
    notes: 'Price comparison table: product, RRP, typical street price, stockists.',
  });

  // What to know before you buy — 5 subsections
  const buyingGuideH3s = [
    'How to choose the right shape',
    'Weight and balance explained',
    'Surface and core materials',
    `Where to try before you buy in the ${market}`,
    'How we tested and verified',
  ];

  sections.push({
    level: 2,
    heading: 'What to know before you buy',
    subsections: buyingGuideH3s.map((h) => ({
      level: 3,
      heading: h,
      notes: '',
    })),
  });

  const faqCount = options.faqCount || 10;
  const faqQuestions = generateFAQQuestions(brief, report, faqCount);

  sections.push({
    level: 2,
    heading: `FAQ - ${brief.title.replace(/\s*-\s*.*$/, '')}`,
    subsections: [],
    notes: `${faqCount} questions in details accordion.`,
  });

  const relatedSuggestions = generateRelatedSuggestions(brief, 11);

  sections.push({
    level: 2,
    heading: 'Related reading',
    subsections: [],
    notes: `${relatedSuggestions.length} internal links.`,
  });

  return {
    post_type: brief.post_type,
    tier: brief.tier,
    title: brief.title,
    slug: brief.slug,
    word_count_target: WORD_COUNT_TARGETS[brief.post_type] || [2500, 4500],
    da_prompt: generateDAPrompt(brief, topItems),
    sections,
    faq_questions: faqQuestions,
    related_reading_suggestions: relatedSuggestions,
    image_targets: {
      featured: rankedProducts.length ? rankedProducts[0].name : 'Top product',
      per_section: 'One per ranked product',
    },
  };
}

/**
 * Build outline for a pillar page.
 *
 * @param {object} brief - Post brief
 * @param {object} report - Research report
 * @param {object} options - Additional options
 * @returns {object} Outline object
 */
function buildPillarOutline(brief, report, options = {}) {
  const location = extractLocation(brief);
  const venues = (report && report.venues) || [];
  const localCtx = (report && report.local_context) || {};

  const sections = [];

  // Scene overview
  sections.push({
    level: 2,
    heading: `The padel scene in ${location}`,
    subsections: [],
    notes: 'Market overview: growth, number of venues, key players, timeline.',
  });

  // Where to play
  sections.push({
    level: 2,
    heading: `Where to play padel in ${location}`,
    subsections: buildNeighbourhoodH3s(venues),
    notes: 'Organised by neighbourhood/area, not ranked.',
  });

  // Indoor / covered / open
  sections.push({
    level: 2,
    heading: 'Indoor, covered, and open-air courts',
    subsections: [
      { level: 3, heading: 'Indoor courts', notes: listVenuesByType(venues, 'indoor') },
      { level: 3, heading: 'Covered courts', notes: listVenuesByType(venues, 'covered') },
      { level: 3, heading: 'Open-air courts', notes: listVenuesByType(venues, 'outdoor') },
    ],
  });

  // Pricing
  sections.push({
    level: 2,
    heading: `Padel pricing in ${location}`,
    subsections: [],
    table: true,
    notes: 'Comparison table: 24+ venues if available. Off-peak, peak, membership.',
  });

  // Coaching
  sections.push({
    level: 2,
    heading: `Padel coaching in ${location}`,
    subsections: [],
    notes: localCtx.coaching || 'Coaching options, group sessions, private lessons.',
  });

  // Tournaments
  sections.push({
    level: 2,
    heading: `Tournaments and competitions in ${location}`,
    subsections: [],
    notes: localCtx.tournaments || 'Local leagues, social tournaments, competitive scene.',
  });

  // Trip planning (for destination posts)
  sections.push({
    level: 2,
    heading: `Planning a padel trip to ${location}`,
    subsections: [
      { level: 3, heading: 'Best time to visit', notes: localCtx.climate || '' },
      { level: 3, heading: 'Getting around', notes: localCtx.transport || '' },
      { level: 3, heading: 'Booking culture', notes: localCtx.booking_culture || '' },
    ],
  });

  // Business of padel
  sections.push({
    level: 2,
    heading: `The business of padel in ${location}`,
    subsections: [],
    notes: localCtx.news || 'New builds, investments, franchise activity.',
  });

  // Courts by area
  sections.push({
    level: 2,
    heading: `Courts by area`,
    subsections: buildNeighbourhoodH3s(venues),
    table: true,
    notes: 'Neighbourhood breakdown with mini table per area.',
  });

  const faqCount = options.faqCount || 8;
  const faqQuestions = generateFAQQuestions(brief, report, faqCount);

  sections.push({
    level: 2,
    heading: `FAQ - Padel in ${location}`,
    subsections: [],
    notes: `${faqCount} questions in details accordion.`,
  });

  const relatedSuggestions = generateRelatedSuggestions(brief, 11);

  sections.push({
    level: 2,
    heading: 'Related reading',
    subsections: [],
    notes: `${relatedSuggestions.length} internal links.`,
  });

  return {
    post_type: brief.post_type,
    tier: brief.tier,
    title: brief.title,
    slug: brief.slug,
    word_count_target: WORD_COUNT_TARGETS[brief.post_type] || [2500, 4500],
    da_prompt: generateDAPrompt(brief, venues.slice(0, 3)),
    sections,
    faq_questions: faqQuestions,
    related_reading_suggestions: relatedSuggestions,
    image_targets: {
      featured: `${location} padel overview`,
      per_section: 'One per major section',
    },
  };
}

/**
 * Build outline for a cluster post.
 *
 * @param {object} brief - Post brief
 * @param {object} report - Research report
 * @param {object} options - Additional options
 * @returns {object} Outline object
 */
function buildClusterOutline(brief, report, options = {}) {
  const location = extractLocation(brief);
  const topicSections = generateTopicSections(brief.focus_keyword, location, report);

  const sections = [];

  // 4-6 H2 topic sections, each with 2-3 H3s
  topicSections.slice(0, 6).forEach((ts) => {
    sections.push({
      level: 2,
      heading: ts.heading,
      subsections: (ts.subsections || []).slice(0, 3).map((sub) => ({
        level: 3,
        heading: sub,
        notes: '',
      })),
    });
  });

  // Price tier segmentation for cost/pricing posts
  if (isPricingPost(brief)) {
    sections.push({
      level: 2,
      heading: 'What to expect at different price points',
      subsections: [
        {
          level: 3,
          heading: 'Budget',
          notes: 'Describe the experience at the lowest tier - what courts, facilities, and atmosphere to expect.',
        },
        {
          level: 3,
          heading: 'Mid-range',
          notes: 'The sweet spot for most players - what extra quality or convenience you get.',
        },
        {
          level: 3,
          heading: 'Premium',
          notes: 'Top-end venues or products - what justifies the higher price and who benefits most.',
        },
      ],
      notes: 'Focus on the EXPERIENCE at each tier, not just the numbers.',
    });
  }

  const faqCount = options.faqCount || 6;
  const faqQuestions = generateFAQQuestions(brief, report, faqCount);

  sections.push({
    level: 2,
    heading: `FAQ - ${stripYear(brief.title)}`,
    subsections: [],
    notes: `${faqCount} questions in details accordion.`,
  });

  const relatedSuggestions = generateRelatedSuggestions(brief, 8);

  sections.push({
    level: 2,
    heading: 'Related reading',
    subsections: [],
    notes: `${relatedSuggestions.length} internal links.`,
  });

  return {
    post_type: brief.post_type,
    tier: brief.tier,
    title: brief.title,
    slug: brief.slug,
    word_count_target: WORD_COUNT_TARGETS[brief.post_type] || [1200, 2000],
    da_prompt: generateDAPrompt(brief, []),
    sections,
    faq_questions: faqQuestions,
    related_reading_suggestions: relatedSuggestions,
    image_targets: {
      featured: brief.title,
      per_section: 'One per H2 where relevant',
    },
  };
}

/**
 * Build outline for a leaf post.
 *
 * @param {object} brief - Post brief
 * @param {object} report - Research report
 * @param {object} options - Additional options
 * @returns {object} Outline object
 */
function buildLeafOutline(brief, report, options = {}) {
  const location = extractLocation(brief);
  const topicSections = generateTopicSections(brief.focus_keyword, location, report);

  const sections = [];

  // 3-4 H2 sections
  topicSections.slice(0, 4).forEach((ts) => {
    sections.push({
      level: 2,
      heading: ts.heading,
      subsections: (ts.subsections || []).slice(0, 2).map((sub) => ({
        level: 3,
        heading: sub,
        notes: '',
      })),
    });
  });

  const faqCount = options.faqCount || 5;
  const faqQuestions = generateFAQQuestions(brief, report, faqCount);

  // FAQ is optional for leaf but we include it by default
  sections.push({
    level: 2,
    heading: `FAQ`,
    subsections: [],
    notes: `${faqCount} questions (optional section).`,
  });

  const relatedSuggestions = generateRelatedSuggestions(brief, 6);

  sections.push({
    level: 2,
    heading: 'Related reading',
    subsections: [],
    notes: `${relatedSuggestions.length} internal links.`,
  });

  return {
    post_type: brief.post_type,
    tier: brief.tier,
    title: brief.title,
    slug: brief.slug,
    word_count_target: WORD_COUNT_TARGETS[brief.post_type] || [800, 1500],
    da_prompt: generateDAPrompt(brief, []),
    sections,
    faq_questions: faqQuestions,
    related_reading_suggestions: relatedSuggestions,
    image_targets: {
      featured: brief.title,
      per_section: 'One supporting image if relevant',
    },
  };
}

// ---------------------------------------------------------------------------
// Main Entry Point
// ---------------------------------------------------------------------------

/**
 * Generate a complete outline from a brief and research report.
 *
 * @param {object} brief - Post brief object
 * @param {object} researchReport - Parsed research report
 * @param {object} [options] - Options (maxVenues, maxProducts, faqCount, etc.)
 * @returns {object} Complete outline object
 */
function generateOutline(brief, researchReport, options = {}) {
  const blueprint = selectBlueprint(brief.post_type, brief.tier);
  const report = researchReport || {};

  const builders = {
    buildCityListicleOutline,
    buildProductListicleOutline,
    buildPillarOutline,
    buildClusterOutline,
    buildLeafOutline,
  };

  const builder = builders[blueprint];
  if (!builder) {
    throw new Error(`Unknown blueprint: ${blueprint}`);
  }

  return builder(brief, report, options);
}

// ---------------------------------------------------------------------------
// Outline Formatter (to Markdown)
// ---------------------------------------------------------------------------

/**
 * Convert an outline object to a readable markdown string for human review.
 *
 * @param {object} outline - Outline object
 * @returns {string} Markdown string
 */
function formatOutline(outline) {
  const lines = [];

  lines.push(`# ${outline.title}`);
  lines.push('');
  lines.push(`**Post type:** ${outline.post_type}`);
  lines.push(`**Tier:** ${outline.tier}`);
  lines.push(`**Slug:** ${outline.slug}`);
  lines.push(`**Word count target:** ${outline.word_count_target[0]}-${outline.word_count_target[1]}`);
  lines.push('');

  lines.push('## DA Prompt');
  lines.push('');
  lines.push(`> ${outline.da_prompt}`);
  lines.push('');

  lines.push('---');
  lines.push('');
  lines.push('## Outline');
  lines.push('');

  for (const section of outline.sections) {
    const prefix = '#'.repeat(section.level);
    lines.push(`${prefix} ${section.heading}`);

    if (section.table) {
      lines.push('');
      lines.push('_[TABLE]_');
    }

    if (section.notes) {
      lines.push('');
      lines.push(`_Notes: ${section.notes}_`);
    }

    lines.push('');

    if (section.subsections && section.subsections.length) {
      for (const sub of section.subsections) {
        const subPrefix = '#'.repeat(sub.level);
        lines.push(`${subPrefix} ${sub.heading}`);

        if (sub.notes) {
          lines.push('');
          lines.push(`_Notes: ${sub.notes}_`);
        }

        lines.push('');
      }
    }
  }

  if (outline.faq_questions && outline.faq_questions.length) {
    lines.push('---');
    lines.push('');
    lines.push('## FAQ Questions');
    lines.push('');
    outline.faq_questions.forEach((q, i) => {
      lines.push(`${i + 1}. ${q}`);
    });
    lines.push('');
  }

  if (outline.related_reading_suggestions && outline.related_reading_suggestions.length) {
    lines.push('---');
    lines.push('');
    lines.push('## Related Reading Suggestions');
    lines.push('');
    outline.related_reading_suggestions.forEach((r) => {
      lines.push(`- ${r}`);
    });
    lines.push('');
  }

  if (outline.image_targets) {
    lines.push('---');
    lines.push('');
    lines.push('## Image Targets');
    lines.push('');
    lines.push(`- **Featured:** ${outline.image_targets.featured}`);
    lines.push(`- **Per section:** ${outline.image_targets.per_section}`);
    lines.push('');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Outline Validator
// ---------------------------------------------------------------------------

/**
 * Validate an outline against its blueprint expectations.
 *
 * @param {object} outline - Outline object
 * @param {string} postType - Expected post type
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateOutline(outline, postType) {
  const errors = [];

  // Check outline has required top-level fields
  const requiredFields = ['post_type', 'title', 'slug', 'word_count_target', 'da_prompt', 'sections', 'faq_questions'];
  for (const field of requiredFields) {
    if (!outline[field]) {
      errors.push(`Missing required field: ${field}`);
    }
  }

  // Check post_type matches
  if (outline.post_type && outline.post_type !== postType) {
    errors.push(`Post type mismatch: outline has "${outline.post_type}", expected "${postType}"`);
  }

  const sections = outline.sections || [];
  const h2Count = sections.filter((s) => s.level === 2).length;

  // Check H2/H3 hierarchy — no H3 without parent H2
  let lastH2 = false;
  for (const section of sections) {
    if (section.level === 2) {
      lastH2 = true;

      // Check subsections are H3
      if (section.subsections) {
        for (const sub of section.subsections) {
          if (sub.level !== 3) {
            errors.push(`Invalid subsection level ${sub.level} under H2 "${section.heading}"`);
          }
        }
      }
    }

    // H3 at top level without a parent H2 is invalid
    if (section.level === 3 && !lastH2) {
      errors.push(`H3 "${section.heading}" found without parent H2`);
    }
  }

  // Check FAQ section exists
  const hasFAQ = sections.some((s) => s.heading && s.heading.toLowerCase().includes('faq'));
  if (!hasFAQ) {
    errors.push('Missing FAQ section');
  }

  // Check Related Reading section exists
  const hasRelated = sections.some((s) => s.heading && s.heading.toLowerCase().includes('related reading'));
  if (!hasRelated) {
    errors.push('Missing Related Reading section');
  }

  // Check FAQ question count
  const faqQuestions = outline.faq_questions || [];
  if (faqQuestions.length < 5) {
    errors.push(`FAQ question count too low: ${faqQuestions.length} (minimum 5)`);
  }

  // Post-type specific section count checks
  const minH2 = {
    [POST_TYPES.CITY_LISTICLE]: 5,
    [POST_TYPES.PRODUCT_LISTICLE]: 5,
    [POST_TYPES.PILLAR]: 6,
    [POST_TYPES.CLUSTER]: 4,
    [POST_TYPES.LEAF]: 3,
  };

  const expectedMin = minH2[postType] || 3;
  if (h2Count < expectedMin) {
    errors.push(`Too few H2 sections: ${h2Count} (expected at least ${expectedMin} for ${postType})`);
  }

  // Post-type specific FAQ count expectations
  const minFAQ = {
    [POST_TYPES.CITY_LISTICLE]: 8,
    [POST_TYPES.PRODUCT_LISTICLE]: 10,
    [POST_TYPES.PILLAR]: 8,
    [POST_TYPES.CLUSTER]: 5,
    [POST_TYPES.LEAF]: 5,
  };

  const expectedFAQ = minFAQ[postType] || 5;
  if (faqQuestions.length < expectedFAQ) {
    errors.push(`FAQ count ${faqQuestions.length} below minimum ${expectedFAQ} for ${postType}`);
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

// ---------------------------------------------------------------------------
// Internal Helpers
// ---------------------------------------------------------------------------

/**
 * Extract a human-readable location from the brief.
 */
function extractLocation(brief) {
  // Try to extract location from title or focus keyword
  const kw = brief.focus_keyword || brief.title || '';

  // Pattern: "best padel courts in {location} 2026"
  const inMatch = kw.match(/\bin\s+(.+?)(?:\s+20\d{2})?$/i);
  if (inMatch) return titleCase(inMatch[1]);

  // Pattern: "padel in {location}"
  const padelIn = kw.match(/padel\s+in\s+(.+?)(?:\s+20\d{2})?$/i);
  if (padelIn) return titleCase(padelIn[1]);

  // Fallback: use market name
  return brief.market || brief.country_code || 'the area';
}

/**
 * Extract product category from focus keyword.
 * e.g. "best padel rackets uk 2026" => "padel racket"
 */
function extractProductCategory(keyword) {
  const kw = (keyword || '').toLowerCase();
  if (kw.includes('racket')) return 'padel racket';
  if (kw.includes('shoe')) return 'padel shoe';
  if (kw.includes('bag')) return 'padel bag';
  if (kw.includes('ball')) return 'padel ball';
  if (kw.includes('grip')) return 'padel grip';
  if (kw.includes('overgrip')) return 'padel overgrip';
  return 'padel racket'; // default
}

/**
 * Title case a string.
 */
function titleCase(str) {
  return str.replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Strip year from title for FAQ headings.
 */
function stripYear(title) {
  return (title || '').replace(/\s*20\d{2}\s*/g, ' ').replace(/\s*-\s*$/, '').trim();
}

/**
 * Infer a venue descriptor from its data (fallback when best_for is absent).
 */
function inferDescriptor(venue) {
  if (venue.indoor_outdoor === 'indoor') return 'indoor play';
  if (venue.courts && venue.courts >= 6) return 'variety and choice';
  if (venue.rating && venue.rating >= 4.8) return 'top-rated experience';
  if (venue.price_range && venue.price_range.includes('£') && parseInt(venue.price_range) < 30) return 'value';
  return 'all-round play';
}

/**
 * Infer a product benefit from its data.
 */
function inferProductBenefit(product) {
  if (product.shape === 'diamond') return 'for power';
  if (product.shape === 'round') return 'for control';
  if (product.shape === 'teardrop') return 'all-round performance';
  if (product.level === 'beginner') return 'for beginners';
  if (product.level === 'advanced') return 'for advanced players';
  return 'all-round performance';
}

/**
 * Build notes for "What you get" section of a venue.
 */
function buildWhatYouGetNotes(venue) {
  const parts = [];
  if (venue.courts) parts.push(`${venue.courts} courts`);
  if (venue.indoor_outdoor) parts.push(venue.indoor_outdoor);
  if (venue.positives && venue.positives.length) {
    parts.push(...venue.positives.slice(0, 2));
  }
  return parts.join(', ') || 'Court details from research.';
}

/**
 * Build notes for "Price and booking" section.
 */
function buildPriceNotes(venue, brief) {
  const currency = getCurrency(brief.market || brief.country_code);
  const parts = [];
  if (venue.price_range) parts.push(`Price range: ${venue.price_range}`);
  parts.push(`Currency: ${currency}`);
  if (venue.booking) parts.push(`Booking: ${venue.booking}`);
  return parts.join('. ') || 'Pricing details from research.';
}

/**
 * Build notes for "Who it is for" section.
 */
function buildAudienceNotes(venue) {
  const parts = [];
  if (venue.level) parts.push(`Suited for: ${venue.level}`);
  if (venue.best_for) parts.push(venue.best_for);
  return parts.join('. ') || 'Target audience from research.';
}

/**
 * Build notes for player reviews section.
 */
function buildReviewNotes(venue) {
  const parts = [];
  if (venue.rating) parts.push(`${venue.rating}/5 Google rating`);
  if (venue.review_count) parts.push(`${venue.review_count} reviews`);
  if (venue.positives && venue.positives.length) parts.push(`Positives: ${venue.positives.join(', ')}`);
  if (venue.negatives && venue.negatives.length) parts.push(`Negatives: ${venue.negatives.join(', ')}`);
  return parts.join('. ') || 'Review data from research.';
}

/**
 * Build notes for product specs.
 */
function buildProductSpecNotes(product) {
  const parts = [];
  if (product.shape) parts.push(`Shape: ${product.shape}`);
  if (product.weight) parts.push(`Weight: ${product.weight}`);
  if (product.balance) parts.push(`Balance: ${product.balance}`);
  if (product.face) parts.push(`Face: ${product.face}`);
  if (product.core) parts.push(`Core: ${product.core}`);
  if (product.price) parts.push(`RRP: ${product.price}`);
  return parts.join(', ') || 'Product specs from research.';
}

/**
 * Build notes for stockist section.
 */
function buildStockistNotes(product) {
  if (product.stockists && product.stockists.length) {
    return `${product.stockists.length} verified stockists: ${product.stockists.slice(0, 3).join(', ')}`;
  }
  return '3 retailer links to be added from research.';
}

/**
 * Build notes for product audience section.
 */
function buildProductAudienceNotes(product) {
  const parts = [];
  if (product.level) parts.push(`Player level: ${product.level}`);
  if (product.best_for) parts.push(product.best_for);
  return parts.join('. ') || 'Target player profile from research.';
}

/**
 * Build notes for product reviews section.
 */
function buildProductReviewNotes(product) {
  return product.reviews_summary || 'Player feedback and ratings from research.';
}

/**
 * Group venues by neighbourhood and produce H3 subsections.
 */
function buildNeighbourhoodH3s(venues) {
  const neighbourhoods = new Map();

  for (const v of venues) {
    const area = v.neighbourhood || 'Other';
    if (!neighbourhoods.has(area)) neighbourhoods.set(area, []);
    neighbourhoods.get(area).push(v.name);
  }

  if (neighbourhoods.size === 0) {
    return [{ level: 3, heading: 'All areas', notes: 'Venues grouped by area.' }];
  }

  return Array.from(neighbourhoods.entries()).map(([area, names]) => ({
    level: 3,
    heading: area,
    notes: names.join(', '),
  }));
}

/**
 * List venue names filtered by indoor/outdoor type.
 */
function listVenuesByType(venues, type) {
  const filtered = venues.filter((v) => {
    const io = (v.indoor_outdoor || '').toLowerCase();
    return io.includes(type);
  });
  if (filtered.length === 0) return `No ${type} venues found in research.`;
  return filtered.map((v) => v.name).join(', ');
}

/**
 * Generate topic-specific FAQ questions from the focus keyword.
 */
function generateTopicFAQs(focusKeyword, location, maxCount) {
  const kw = (focusKeyword || '').toLowerCase();
  const loc = location || 'the area';
  const questions = [];

  // Extract the core topic from the keyword
  const topicMatch = kw
    .replace(/best\s+/i, '')
    .replace(/\s+in\s+.+$/i, '')
    .replace(/\s+20\d{2}/i, '')
    .replace(/\s+uk$/i, '')
    .trim();

  const topic = topicMatch || 'padel';

  questions.push(`What is ${topic}?`);
  questions.push(`How much does ${topic} cost in ${loc}?`);
  questions.push(`Is ${topic} suitable for beginners?`);
  questions.push(`Where can I find ${topic} in ${loc}?`);
  questions.push(`What do I need to know about ${topic}?`);
  questions.push(`How do I get started with ${topic} in ${loc}?`);
  questions.push(`What are the options for ${topic} in ${loc}?`);
  questions.push(`When is the best time for ${topic} in ${loc}?`);

  return questions.slice(0, maxCount);
}

/**
 * Generate H2 topic sections for cluster/leaf posts.
 */
function generateTopicSections(focusKeyword, location, report) {
  const kw = (focusKeyword || '').toLowerCase();
  const loc = location || 'the area';

  // Extract core topic
  const topicMatch = kw
    .replace(/best\s+/i, '')
    .replace(/\s+in\s+.+$/i, '')
    .replace(/\s+20\d{2}/i, '')
    .replace(/\s+uk$/i, '')
    .trim();

  const topic = titleCase(topicMatch || 'padel');

  // Generate sensible H2/H3 structure based on the topic
  const sections = [
    {
      heading: `What is ${topic} and why it matters`,
      subsections: [`The basics of ${topic}`, `Why ${topic} is growing in ${loc}`],
    },
    {
      heading: `${topic} options in ${loc}`,
      subsections: [`Top choices for ${topic}`, `How to compare ${topic} options`, `What to look for`],
    },
    {
      heading: `Costs and value`,
      subsections: [`Typical pricing for ${topic}`, `How to get the best value`],
    },
    {
      heading: `Practical tips for ${topic}`,
      subsections: [`Getting started`, `Common mistakes to avoid`, `Expert recommendations`],
    },
    {
      heading: `${topic} in ${loc} compared`,
      subsections: [`How ${loc} compares to other areas`, `What makes ${loc} different`],
    },
    {
      heading: `Next steps`,
      subsections: [`How to book or buy`, `Where to go from here`],
    },
  ];

  return sections;
}

/**
 * Generate related reading suggestions based on the brief.
 */
function generateRelatedSuggestions(brief, count) {
  const suggestions = [];
  const loc = extractLocation(brief);
  const category = brief.category || 'Padel';
  const pillar = brief.pillar_slug || '';

  // Always suggest the pillar if it exists
  if (pillar) {
    suggestions.push(`Complete guide: ${pillar.replace(/-/g, ' ')}`);
  }

  // Category-based suggestions
  if (brief.post_type === POST_TYPES.CITY_LISTICLE) {
    suggestions.push(`Padel coaching in ${loc}`);
    suggestions.push(`Indoor padel courts near ${loc}`);
    suggestions.push(`Padel rules for beginners`);
    suggestions.push(`Best padel rackets 2026`);
    suggestions.push(`Padel vs tennis - key differences`);
    suggestions.push(`Padel court etiquette guide`);
    suggestions.push(`Padel scoring explained`);
    suggestions.push(`How to book padel courts online`);
    suggestions.push(`Padel equipment guide`);
    suggestions.push(`Padel tournaments in ${loc}`);
    suggestions.push(`Where to play padel in the UK`);
  } else if (brief.post_type === POST_TYPES.PRODUCT_LISTICLE) {
    suggestions.push(`How to choose a padel racket`);
    suggestions.push(`Padel racket shapes explained`);
    suggestions.push(`Best padel shoes 2026`);
    suggestions.push(`Padel grip guide`);
    suggestions.push(`Padel equipment for beginners`);
    suggestions.push(`Padel racket weight guide`);
    suggestions.push(`Padel balls - which ones to buy`);
    suggestions.push(`Where to play padel in the UK`);
    suggestions.push(`Padel rules for beginners`);
    suggestions.push(`Best padel bags 2026`);
    suggestions.push(`Padel racket maintenance tips`);
  } else {
    suggestions.push(`Best padel courts in ${loc}`);
    suggestions.push(`Padel coaching in ${loc}`);
    suggestions.push(`Padel rules for beginners`);
    suggestions.push(`Best padel rackets 2026`);
    suggestions.push(`Padel vs tennis`);
    suggestions.push(`Where to play padel near ${loc}`);
    suggestions.push(`Padel equipment guide`);
    suggestions.push(`Padel scoring explained`);
  }

  // Deduplicate and trim
  const unique = [...new Set(suggestions)];
  return unique.slice(0, count);
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  generateOutline,
  buildCityListicleOutline,
  buildProductListicleOutline,
  buildPillarOutline,
  buildClusterOutline,
  buildLeafOutline,
  selectBlueprint,
  generateDAPrompt,
  generateFAQQuestions,
  formatOutline,
  validateOutline,
  isPricingPost,
};
