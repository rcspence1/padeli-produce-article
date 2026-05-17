/**
 * JSON-LD Schema Builder for Padeli Blog Pipeline
 *
 * Builds structured data (JSON-LD) for blog posts: FAQ, ItemList, Article,
 * HowTo, WebPage, BreadcrumbList, Organization, Person.
 *
 * Node.js v24+ — zero external dependencies — CommonJS
 */

const { SITE_URL } = require('./wp-client');
const { POST_TYPES } = require('./config');

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_AUTHOR = { name: 'Mark Lamb', url: `${SITE_URL}/author/mark-lamb/` };
const DEFAULT_PUBLISHER = {
  '@type': 'Organization',
  name: 'Padeli',
  url: SITE_URL,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Wrap a schema object (or array of objects) in a wp:html block with
 * a <script type="application/ld+json"> tag.
 *
 * @param {object|object[]} schemaObj - One schema object or array of them
 * @returns {string} WordPress HTML block string
 */
function wrapInWpHtml(schemaObj) {
  const json = JSON.stringify(schemaObj);
  return `<!-- wp:html -->\n<script type="application/ld+json">\n${json}\n</script>\n<!-- /wp:html -->`;
}

/**
 * Resolve a relative URL against SITE_URL.
 * Absolute URLs pass through unchanged.
 *
 * @param {string} url
 * @returns {string}
 */
function resolveUrl(url) {
  if (!url) return SITE_URL;
  if (url.startsWith('http://') || url.startsWith('https://')) return url;
  return `${SITE_URL}${url.startsWith('/') ? '' : '/'}${url}`;
}

// ---------------------------------------------------------------------------
// Individual Schema Builders
// ---------------------------------------------------------------------------

/**
 * Build FAQPage schema.
 *
 * @param {Array<{question: string, answer: string}>} faqs
 * @returns {string} wp:html block string, or empty string if no FAQs
 */
function buildFaqSchema(faqs) {
  if (!faqs || faqs.length === 0) return '';
  const schema = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faqs.map((faq) => ({
      '@type': 'Question',
      name: faq.question,
      acceptedAnswer: { '@type': 'Answer', text: faq.answer },
    })),
  };
  return wrapInWpHtml(schema);
}

/**
 * Build ItemList schema for listicle posts.
 *
 * @param {Array<object>} items - List items with position, name, url, etc.
 * @param {'venue'|'product'} listType - Determines ListItem structure
 * @returns {string} wp:html block string, or empty string if no items
 */
function buildItemListSchema(items, listType) {
  if (!items || items.length === 0) return '';

  const schema = {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    itemListElement: items.map((item, i) => {
      const position = item.position || i + 1;

      if (listType === 'product') {
        const listItem = {
          '@type': 'ListItem',
          position,
          item: {
            '@type': 'Product',
            name: item.name,
          },
        };
        if (item.description) listItem.item.description = item.description;
        if (item.brand) listItem.item.brand = { '@type': 'Brand', name: item.brand };
        if (item.image) listItem.item.image = item.image;
        if (item.price && item.currency) {
          listItem.item.offers = {
            '@type': 'Offer',
            price: item.price,
            priceCurrency: item.currency,
            availability: 'https://schema.org/InStock',
          };
        }
        return listItem;
      }

      // Default: venue / generic list item
      const listItem = {
        '@type': 'ListItem',
        position,
        name: item.name,
      };
      if (item.url) listItem.url = resolveUrl(item.url);
      return listItem;
    }),
  };

  return wrapInWpHtml(schema);
}

/**
 * Build Article schema.
 *
 * @param {object} post - Post data object
 * @returns {string} wp:html block string
 */
function buildArticleSchema(post) {
  const author = post.author || DEFAULT_AUTHOR;
  const schema = {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: post.title,
    description: post.excerpt || '',
    datePublished: post.date_published || new Date().toISOString().slice(0, 10),
    dateModified: post.date_modified || post.date_published || new Date().toISOString().slice(0, 10),
    author: buildPersonSchema(author.name, author.url),
    publisher: { ...DEFAULT_PUBLISHER },
  };
  if (post.featured_image && post.featured_image.url) {
    schema.image = post.featured_image.url;
  }
  return wrapInWpHtml(schema);
}

/**
 * Build HowTo schema for technique/guide posts.
 *
 * @param {Array<{name: string, text: string, image?: string}>} steps
 * @param {string} name - Title of the how-to
 * @param {string} description - Summary
 * @param {string} [totalTime] - ISO 8601 duration, e.g. 'PT30M'
 * @returns {string} wp:html block string, or empty string if no steps
 */
function buildHowToSchema(steps, name, description, totalTime) {
  if (!steps || steps.length === 0) return '';

  const schema = {
    '@context': 'https://schema.org',
    '@type': 'HowTo',
    name,
    description: description || '',
    step: steps.map((s) => {
      const step = {
        '@type': 'HowToStep',
        name: s.name,
        text: s.text,
      };
      if (s.image) step.image = s.image;
      return step;
    }),
  };
  if (totalTime) schema.totalTime = totalTime;

  return wrapInWpHtml(schema);
}

/**
 * Build WebPage schema.
 *
 * @param {object} post - Post data object
 * @returns {string} wp:html block string
 */
function buildWebPageSchema(post) {
  const schema = {
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    name: post.title,
    description: post.excerpt || '',
    url: resolveUrl(post.slug ? `/${post.slug}/` : '/'),
    isPartOf: {
      '@type': 'WebSite',
      name: 'Padeli',
      url: SITE_URL,
    },
  };
  return wrapInWpHtml(schema);
}

/**
 * Build BreadcrumbList schema.
 *
 * @param {Array<{name: string, url: string}>} crumbs - Breadcrumb items in order
 * @returns {string} wp:html block string, or empty string if no crumbs
 */
function buildBreadcrumbSchema(crumbs) {
  if (!crumbs || crumbs.length === 0) return '';

  const schema = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: crumbs.map((crumb, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: crumb.name,
      item: resolveUrl(crumb.url),
    })),
  };
  return wrapInWpHtml(schema);
}

/**
 * Build Organization schema object (not wrapped — used as sub-schema).
 *
 * @param {object} [opts] - Optional overrides
 * @param {string} [opts.logo] - Logo URL
 * @param {string[]} [opts.sameAs] - Social profile URLs
 * @returns {object} Organization schema object
 */
function buildOrganizationSchema(opts = {}) {
  const schema = {
    '@type': 'Organization',
    name: 'Padeli',
    url: SITE_URL,
  };
  if (opts.logo) schema.logo = opts.logo;
  if (opts.sameAs && opts.sameAs.length > 0) schema.sameAs = opts.sameAs;
  return schema;
}

/**
 * Build Person schema object (not wrapped — used as sub-schema).
 *
 * @param {string} name
 * @param {string} [url]
 * @returns {object} Person schema object
 */
function buildPersonSchema(name, url) {
  const schema = {
    '@type': 'Person',
    name,
  };
  if (url) schema.url = resolveUrl(url);
  return schema;
}

// ---------------------------------------------------------------------------
// Breadcrumb Helper
// ---------------------------------------------------------------------------

/**
 * Build default breadcrumbs from post data if none are provided.
 *
 * @param {object} postData
 * @returns {Array<{name: string, url: string}>}
 */
function defaultBreadcrumbs(postData) {
  const crumbs = [
    { name: 'Home', url: '/' },
    { name: 'Blog', url: '/blog/' },
  ];
  if (postData.category) {
    const catSlug = postData.category.toLowerCase().replace(/\s+/g, '-');
    crumbs.push({ name: postData.category, url: `/blog/category/${catSlug}/` });
  }
  if (postData.title) {
    const postUrl = postData.slug ? `/${postData.slug}/` : '/';
    crumbs.push({ name: postData.title, url: postUrl });
  }
  return crumbs;
}

// ---------------------------------------------------------------------------
// Main Builder
// ---------------------------------------------------------------------------

/**
 * Build all relevant schemas for a post based on its type.
 * Returns a single wp:html block containing multiple <script> tags.
 *
 * Schema mapping:
 * - city_listicle:    Article + FAQPage + ItemList (venues) + BreadcrumbList
 * - product_listicle: Article + FAQPage + ItemList (products) + BreadcrumbList
 * - pillar:           Article + FAQPage + BreadcrumbList + WebPage
 * - cluster:          Article + FAQPage + BreadcrumbList
 * - leaf:             Article + BreadcrumbList (FAQ optional)
 * - howto/technique:  Article + HowTo + BreadcrumbList
 *
 * @param {object} postData - Full post data object
 * @param {string} postType - One of POST_TYPES values or 'howto'/'technique'
 * @returns {string} Combined wp:html block string with all schemas
 */
function buildSchemasForPost(postData, postType) {
  const schemas = [];
  const crumbs = postData.breadcrumbs || defaultBreadcrumbs(postData);

  // Article is always included
  schemas.push(buildArticleSchema(postData));

  switch (postType) {
    case POST_TYPES.CITY_LISTICLE:
      if (postData.faqs && postData.faqs.length > 0) schemas.push(buildFaqSchema(postData.faqs));
      schemas.push(buildItemListSchema(postData.items, 'venue'));
      schemas.push(buildBreadcrumbSchema(crumbs));
      break;

    case POST_TYPES.PRODUCT_LISTICLE:
      if (postData.faqs && postData.faqs.length > 0) schemas.push(buildFaqSchema(postData.faqs));
      schemas.push(buildItemListSchema(postData.items, 'product'));
      schemas.push(buildBreadcrumbSchema(crumbs));
      break;

    case POST_TYPES.PILLAR:
      if (postData.faqs && postData.faqs.length > 0) schemas.push(buildFaqSchema(postData.faqs));
      schemas.push(buildBreadcrumbSchema(crumbs));
      schemas.push(buildWebPageSchema(postData));
      break;

    case POST_TYPES.CLUSTER:
      if (postData.faqs && postData.faqs.length > 0) schemas.push(buildFaqSchema(postData.faqs));
      schemas.push(buildBreadcrumbSchema(crumbs));
      break;

    case POST_TYPES.LEAF:
      if (postData.faqs && postData.faqs.length > 0) schemas.push(buildFaqSchema(postData.faqs));
      schemas.push(buildBreadcrumbSchema(crumbs));
      break;

    case 'howto':
    case 'technique':
      schemas.push(
        buildHowToSchema(postData.steps, postData.title, postData.excerpt, postData.totalTime)
      );
      schemas.push(buildBreadcrumbSchema(crumbs));
      break;

    default:
      // Unknown type — just Article + Breadcrumbs
      schemas.push(buildBreadcrumbSchema(crumbs));
      break;
  }

  // Filter out empty strings and combine into a single wp:html block
  const validSchemas = schemas.filter((s) => s && s.length > 0);
  if (validSchemas.length === 0) return '';

  // Extract the JSON from each individual wp:html block and combine into one
  const scripts = validSchemas.map((block) => {
    const match = block.match(/<script type="application\/ld\+json">\n([\s\S]*?)\n<\/script>/);
    return match ? `<script type="application/ld+json">\n${match[1]}\n</script>` : '';
  }).filter(Boolean);

  if (scripts.length === 0) return '';
  return `<!-- wp:html -->\n${scripts.join('\n')}\n<!-- /wp:html -->`;
}

// ---------------------------------------------------------------------------
// Validator
// ---------------------------------------------------------------------------

/**
 * Validate a JSON-LD string for common issues.
 *
 * Checks:
 * - Valid JSON
 * - Has @context and @type
 * - No HTML entities in strings (&amp; &lt; &gt; &quot; etc.)
 * - No empty required fields
 *
 * @param {string} jsonString - Raw JSON-LD string to validate
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateSchema(jsonString) {
  const errors = [];

  // 1. Valid JSON
  let parsed;
  try {
    parsed = JSON.parse(jsonString);
  } catch (e) {
    return { valid: false, errors: [`Invalid JSON: ${e.message}`] };
  }

  // Handle arrays of schemas
  const schemas = Array.isArray(parsed) ? parsed : [parsed];

  for (let i = 0; i < schemas.length; i++) {
    const schema = schemas[i];
    const prefix = schemas.length > 1 ? `Schema[${i}]: ` : '';

    // 2. Required top-level fields
    if (!schema['@type']) {
      errors.push(`${prefix}Missing @type`);
    }

    // @context check (only for top-level, not nested)
    if (!schema['@context'] && schemas.length === 1) {
      errors.push(`${prefix}Missing @context`);
    }

    // 3. Check for HTML entities in all string values
    checkHtmlEntities(schema, prefix, errors);
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Recursively check for HTML entities in string values.
 *
 * @param {*} obj
 * @param {string} prefix
 * @param {string[]} errors
 */
function checkHtmlEntities(obj, prefix, errors) {
  if (typeof obj === 'string') {
    if (/&(amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);/i.test(obj)) {
      errors.push(`${prefix}HTML entity found in string: "${obj.slice(0, 80)}..."`);
    }
    return;
  }
  if (Array.isArray(obj)) {
    obj.forEach((item) => checkHtmlEntities(item, prefix, errors));
    return;
  }
  if (obj && typeof obj === 'object') {
    for (const val of Object.values(obj)) {
      checkHtmlEntities(val, prefix, errors);
    }
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  buildFaqSchema,
  buildItemListSchema,
  buildArticleSchema,
  buildHowToSchema,
  buildWebPageSchema,
  buildBreadcrumbSchema,
  buildOrganizationSchema,
  buildPersonSchema,
  buildSchemasForPost,
  wrapInWpHtml,
  validateSchema,
};
