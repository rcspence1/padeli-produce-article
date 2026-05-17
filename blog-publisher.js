/**
 * Blog Publisher for Padeli
 *
 * Pushes blog posts to WordPress via /wp/v2/posts REST API.
 * Builds Gutenberg block HTML for body, FAQ accordions, pricing tables,
 * related reading lists, and direct-answer blocks.
 *
 * Key differences from wp-payload.js (listing publisher):
 *   - Endpoint: /wp-json/wp/v2/posts (not /listing)
 *   - No Listeo meta — standard WP post meta + Yoast SEO
 *   - WP categories taxonomy (not listing_category)
 *   - WP tags taxonomy
 *   - Featured image via featured_media (no _gallery)
 *   - Author is Mark Lamb (resolved by name lookup)
 *
 * Node.js v24+ — CommonJS — zero external dependencies
 * Always publishes as WP draft (status: 'draft'). No dry-run mode.
 */

const fs = require('fs');
const path = require('path');
const { SITE_URL, wpGet, wpPost, wpPut } = require('./wp-client');
const { POST_TYPES, WORD_COUNT_TARGETS } = require('./config');
const { countWords, slugify } = require('./utils');

// ---------------------------------------------------------------------------
// Category Map — populated by fetchCategories()
// ---------------------------------------------------------------------------

const CATEGORY_MAP = {
  'Where to Play': null,
  'Equipment': null,
  'Events': null,
  'Juniors': null,
  'Getting Started': null,
  'Coaching & Training': null,
  'Padel Holidays': null,
};

// Cache for author lookups
let _authorCache = {};

// ---------------------------------------------------------------------------
// Dry-run check
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Category + Author Fetchers
// ---------------------------------------------------------------------------

/**
 * Fetch all WP categories and populate CATEGORY_MAP with real term IDs.
 * Results are cached in-memory for the process lifetime.
 *
 * @returns {Promise<object>} The populated CATEGORY_MAP
 */
async function fetchCategories() {
  let page = 1;
  let allCats = [];

  // Paginate through all categories (WP default max 100 per page)
  while (true) {
    const batch = await wpGet(`/wp-json/wp/v2/categories?per_page=100&page=${page}`);
    if (!Array.isArray(batch) || batch.length === 0) break;
    allCats = allCats.concat(batch);
    if (batch.length < 100) break;
    page++;
  }

  // Match by name (case-insensitive)
  for (const cat of allCats) {
    const wpName = (cat.name || '').trim();
    for (const key of Object.keys(CATEGORY_MAP)) {
      if (wpName.toLowerCase() === key.toLowerCase()) {
        CATEGORY_MAP[key] = cat.id;
      }
    }
  }

  console.log('[blog-publisher] Category map populated:');
  for (const [name, id] of Object.entries(CATEGORY_MAP)) {
    console.log(`  ${name}: ${id ?? 'NOT FOUND'}`);
  }

  return CATEGORY_MAP;
}

/**
 * Fetch a WP author ID by display name.
 * Caches results so repeated lookups are instant.
 *
 * @param {string} authorName - e.g. 'Mark Lamb'
 * @returns {Promise<number|null>} Author ID or null if not found
 */
async function fetchAuthorId(authorName) {
  if (_authorCache[authorName]) return _authorCache[authorName];

  const users = await wpGet(`/wp-json/wp/v2/users?search=${encodeURIComponent(authorName)}&per_page=10`);
  if (!Array.isArray(users)) return null;

  const match = users.find(u =>
    (u.name || '').toLowerCase() === authorName.toLowerCase()
  );

  if (match) {
    _authorCache[authorName] = match.id;
    return match.id;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Category Resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a category name to its WP term ID.
 * Uses cached CATEGORY_MAP; fetches if empty.
 *
 * @param {string} categoryName
 * @returns {Promise<number|null>}
 */
async function resolveCategoryId(categoryName) {
  if (!categoryName) return null;

  // Check if map is populated
  const populated = Object.values(CATEGORY_MAP).some(v => v !== null);
  if (!populated) {
    await fetchCategories();
  }

  // Direct match
  if (CATEGORY_MAP[categoryName] != null) return CATEGORY_MAP[categoryName];

  // Case-insensitive fallback
  for (const [name, id] of Object.entries(CATEGORY_MAP)) {
    if (name.toLowerCase() === categoryName.toLowerCase() && id != null) {
      return id;
    }
  }

  console.warn(`[blog-publisher] Category not found in map: "${categoryName}"`);
  return null;
}

// ---------------------------------------------------------------------------
// Gutenberg Block Builders
// ---------------------------------------------------------------------------

/**
 * Escape HTML entities in text content.
 *
 * @param {string} text
 * @returns {string}
 */
function escapeHtml(text) {
  return (text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Build Gutenberg block HTML from an array of content sections.
 *
 * Each section: { heading: string, body: string|string[] }
 * - heading becomes an H2 block
 * - body strings become paragraph blocks (one per string, or split on \n\n)
 * - If body is a single string, it is split on double newlines
 *
 * @param {Array<{heading: string, body: string|string[]}>} sections
 * @returns {string} Gutenberg block HTML
 */
function buildGutenbergBody(sections) {
  if (!Array.isArray(sections) || sections.length === 0) return '';

  const blocks = [];

  for (const section of sections) {
    // Heading
    if (section.heading) {
      blocks.push(
        `<!-- wp:heading -->\n<h2 class="wp-block-heading">${escapeHtml(section.heading)}</h2>\n<!-- /wp:heading -->`
      );
    }

    // Body paragraphs
    let paragraphs = [];
    if (Array.isArray(section.body)) {
      paragraphs = section.body;
    } else if (typeof section.body === 'string') {
      paragraphs = section.body.split(/\n\n+/).filter(p => p.trim());
    }

    for (const p of paragraphs) {
      const trimmed = p.trim();
      if (!trimmed) continue;
      // If already contains HTML tags, use as-is; otherwise wrap
      const content = trimmed.startsWith('<') ? trimmed : `<p>${trimmed}</p>`;
      blocks.push(
        `<!-- wp:paragraph -->\n${content}\n<!-- /wp:paragraph -->`
      );
    }
  }

  return blocks.join('\n\n');
}

/**
 * Build an FAQ accordion using details/summary in a Gutenberg group block.
 *
 * @param {Array<{question: string, answer: string}>} faqs
 * @returns {string} Gutenberg block HTML
 */
function buildFaqAccordion(faqs) {
  if (!Array.isArray(faqs) || faqs.length === 0) return '';

  const items = faqs.map(faq => {
    const q = escapeHtml(faq.question);
    const a = faq.answer || '';
    return `<!-- wp:html -->\n<details>\n<summary>${q}</summary>\n<p>${a}</p>\n</details>\n<!-- /wp:html -->`;
  });

  return [
    '<!-- wp:group {"className":"padeli-faq-accordion"} -->',
    '<div class="wp-block-group padeli-faq-accordion">',
    items.join('\n'),
    '</div>',
    '<!-- /wp:group -->',
  ].join('\n');
}

/**
 * Build a Gutenberg table block.
 *
 * @param {Array<Array<string>>} rows - Array of row arrays (each row = array of cell values)
 * @param {string[]} columns - Column header names
 * @returns {string} Gutenberg table block HTML
 */
function buildPricingTable(rows, columns) {
  if (!Array.isArray(columns) || columns.length === 0) return '';
  if (!Array.isArray(rows)) rows = [];

  const thead = '<thead><tr>' + columns.map(c => `<th>${escapeHtml(c)}</th>`).join('') + '</tr></thead>';
  const tbody = '<tbody>' + rows.map(row => {
    const cells = columns.map((_, i) => `<td>${escapeHtml(String(row[i] || ''))}</td>`).join('');
    return `<tr>${cells}</tr>`;
  }).join('') + '</tbody>';

  return [
    '<!-- wp:table -->',
    `<figure class="wp-block-table"><table>${thead}${tbody}</table></figure>`,
    '<!-- /wp:table -->',
  ].join('\n');
}

/**
 * Build a "Related reading" section with heading + list block.
 *
 * @param {Array<{url: string, text: string}>} links
 * @returns {string} Gutenberg block HTML
 */
function buildRelatedReading(links) {
  if (!Array.isArray(links) || links.length === 0) return '';

  const listItems = links.map(link => {
    const href = link.url || link.href || '#';
    const text = escapeHtml(link.text || link.title || href);
    return `<li><a href="${href}">${text}</a></li>`;
  }).join('\n');

  return [
    '<!-- wp:heading -->',
    '<h2 class="wp-block-heading">Related reading</h2>',
    '<!-- /wp:heading -->',
    '',
    '<!-- wp:list -->',
    `<ul class="wp-block-list">\n${listItems}\n</ul>`,
    '<!-- /wp:list -->',
  ].join('\n');
}

/**
 * Build a direct-answer paragraph block with the "direct-answer" class.
 *
 * @param {string} text
 * @returns {string} Gutenberg block HTML
 */
function buildDABlock(text) {
  if (!text) return '';

  return [
    '<!-- wp:paragraph {"className":"direct-answer"} -->',
    `<p class="direct-answer">${text}</p>`,
    '<!-- /wp:paragraph -->',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Payload Builder
// ---------------------------------------------------------------------------

/**
 * Build the WP REST API payload for a blog post.
 *
 * @param {object} postData
 * @param {string} postData.title
 * @param {string} postData.slug
 * @param {string} postData.body_html - Full Gutenberg HTML content
 * @param {string} [postData.excerpt]
 * @param {string} [postData.status] - 'draft' (default) or 'publish'
 * @param {string} [postData.category] - Category name (resolved to ID)
 * @param {number[]} [postData.tags] - Array of WP tag term IDs
 * @param {string} [postData.focus_keyword]
 * @param {string} [postData.yoast_title]
 * @param {string} [postData.yoast_meta]
 * @param {number} [postData.featured_media] - Media attachment ID
 * @param {number} [postData.author_id]
 * @param {Array<{question: string, answer: string}>} [postData.faqs]
 * @param {string} [postData.schema_html] - Pre-built schema wp:html block
 * @returns {Promise<object>} WP REST payload
 */
async function buildBlogPayload(postData) {
  // Resolve category
  let categoryIds = [];
  if (postData.category) {
    const catId = await resolveCategoryId(postData.category);
    if (catId != null) categoryIds.push(catId);
  }

  const payload = {
    title: postData.title,
    slug: postData.slug || slugify(postData.title),
    content: postData.body_html || '',
    excerpt: postData.excerpt || '',
    status: postData.status || 'draft',
    categories: categoryIds,
    tags: postData.tags || [],
    featured_media: postData.featured_media || 0,
    author: postData.author_id || 0,
    meta: {
      _yoast_wpseo_title: postData.yoast_title || '',
      _yoast_wpseo_metadesc: postData.yoast_meta || '',
      _yoast_wpseo_focuskw: postData.focus_keyword || '',
    },
  };

  return payload;
}

// ---------------------------------------------------------------------------
// Publish / Update / Get / Search
// ---------------------------------------------------------------------------

/**
 * Publish a blog post to WordPress as a draft.
 *
 * @param {object} postData - Post data object (see buildBlogPayload)
 * @returns {Promise<{status: string, postId: number|null, url: string|null}>}
 */
async function publishBlogPost(postData) {
  const payload = await buildBlogPayload(postData);

  // Publish
  const data = await wpPost('/wp-json/wp/v2/posts', payload);
  const postId = data.id;
  const url = data.link || `${SITE_URL}/?p=${postId}`;

  console.log(`[blog-publisher] Created post ${postId} — ${url}`);

  // Set featured image if provided and not already in payload
  if (postData.featured_media && postData.featured_media > 0) {
    try {
      await setFeaturedImage(postId, postData.featured_media);
    } catch (err) {
      console.warn(`[blog-publisher] Failed to set featured image on post ${postId}: ${err.message}`);
    }
  }

  return { status: 'created', postId, url };
}

/**
 * Update an existing blog post.
 *
 * @param {number} postId - WP post ID
 * @param {object} updates - Partial payload fields to update
 * @returns {Promise<object>} Updated post data from WP
 */
async function updateBlogPost(postId, updates) {
  const data = await wpPut(`/wp-json/wp/v2/posts/${postId}`, updates);
  console.log(`[blog-publisher] Updated post ${postId} — status: ${data.status}`);
  return data;
}

/**
 * Get a blog post by ID or slug.
 *
 * @param {string|number} postIdOrSlug - Numeric ID or string slug
 * @returns {Promise<object>} Post data from WP
 */
async function getBlogPost(postIdOrSlug) {
  // Numeric ID
  if (!isNaN(postIdOrSlug)) {
    return wpGet(`/wp-json/wp/v2/posts/${postIdOrSlug}?context=edit`);
  }

  // Slug lookup
  const results = await wpGet(`/wp-json/wp/v2/posts?slug=${encodeURIComponent(postIdOrSlug)}&context=edit`);
  if (Array.isArray(results) && results.length > 0) {
    return results[0];
  }

  throw new Error(`Blog post not found: ${postIdOrSlug}`);
}

/**
 * Search blog posts by query string.
 *
 * @param {string} query - Search term
 * @returns {Promise<Array>} Array of matching post objects
 */
async function searchBlogPosts(query) {
  return wpGet(`/wp-json/wp/v2/posts?search=${encodeURIComponent(query)}&per_page=20`);
}

/**
 * Set the featured image (featured_media) on a post.
 *
 * @param {number} postId - WP post ID
 * @param {number} mediaId - WP media attachment ID
 * @returns {Promise<object>} Updated post data
 */
async function setFeaturedImage(postId, mediaId) {
  const data = await wpPut(`/wp-json/wp/v2/posts/${postId}`, { featured_media: mediaId });
  console.log(`[blog-publisher] Set featured_media=${mediaId} on post ${postId}`);
  return data;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function cli() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command) {
    console.log(`
Usage:
  node blog-publisher.js publish /path/to/post-data.json
  node blog-publisher.js search "padel courts birmingham"
  node blog-publisher.js get <postId or slug>
  node blog-publisher.js categories
`);
    process.exit(0);
  }

  switch (command) {
    case 'publish': {
      const filePath = args[1];
      if (!filePath) {
        console.error('Error: provide path to post-data JSON file');
        process.exit(1);
      }

      const resolved = path.resolve(filePath);
      if (!fs.existsSync(resolved)) {
        console.error(`Error: file not found: ${resolved}`);
        process.exit(1);
      }

      const postData = JSON.parse(fs.readFileSync(resolved, 'utf-8'));
      const options = {};

      const result = await publishBlogPost(postData, options);
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case 'search': {
      const query = args[1];
      if (!query) {
        console.error('Error: provide a search query');
        process.exit(1);
      }

      const results = await searchBlogPosts(query);
      console.log(`Found ${results.length} post(s):\n`);
      for (const post of results) {
        const title = post.title?.rendered || post.title || 'Untitled';
        console.log(`  [${post.id}] ${title}`);
        console.log(`        ${post.link || ''}`);
        console.log(`        status: ${post.status}  |  date: ${post.date || ''}`);
        console.log('');
      }
      break;
    }

    case 'get': {
      const idOrSlug = args[1];
      if (!idOrSlug) {
        console.error('Error: provide a post ID or slug');
        process.exit(1);
      }

      const post = await getBlogPost(idOrSlug);
      const title = post.title?.rendered || post.title?.raw || post.title || '';
      const wordCount = countWords(post.content?.rendered || post.content?.raw || '');
      console.log(`Post ${post.id}: ${title}`);
      console.log(`  Status:    ${post.status}`);
      console.log(`  Slug:      ${post.slug}`);
      console.log(`  Link:      ${post.link || ''}`);
      console.log(`  Author:    ${post.author}`);
      console.log(`  Words:     ${wordCount}`);
      console.log(`  Categories: ${JSON.stringify(post.categories || [])}`);
      console.log(`  Tags:       ${JSON.stringify(post.tags || [])}`);
      console.log(`  Featured:   ${post.featured_media || 'none'}`);
      break;
    }

    case 'categories': {
      const map = await fetchCategories();
      console.log('\nCategory Map:');
      for (const [name, id] of Object.entries(map)) {
        console.log(`  ${name}: ${id ?? 'NOT FOUND'}`);
      }
      break;
    }

    default:
      console.error(`Unknown command: ${command}`);
      process.exit(1);
  }
}

// Run CLI if invoked directly
if (require.main === module) {
  cli().catch(err => {
    console.error(`[blog-publisher] Fatal: ${err.message}`);
    process.exit(1);
  });
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  buildBlogPayload,
  publishBlogPost,
  updateBlogPost,
  getBlogPost,
  searchBlogPosts,
  setFeaturedImage,
  fetchCategories,
  fetchAuthorId,
  buildGutenbergBody,
  buildFaqAccordion,
  buildPricingTable,
  buildRelatedReading,
  buildDABlock,
  CATEGORY_MAP,
};
