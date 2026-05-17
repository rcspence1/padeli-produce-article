/**
 * blog-tracker.js — Notion-backed blog production tracker for Padeli.
 *
 * Source of truth: Notion Blog Tracker DB (35bd1b51-fb30-813b-996f-e67ac30f6418)
 * Backup: data/blog-tracker.json (written on every Notion read)
 *
 * All functions are async (Notion API calls). Same exported API as the
 * original JSON-based tracker so the orchestrator and topic-discovery
 * work unchanged (just need await).
 *
 * Node.js v24+, zero external dependencies, CommonJS.
 *
 * CLI:
 *   node blog-tracker.js summary
 *   node blog-tracker.js status approved
 *   node blog-tracker.js add "slug" "title" city_listicle cornerstone UK
 *   node blog-tracker.js next
 *   node blog-tracker.js stale 7
 *   node blog-tracker.js stats
 *   node blog-tracker.js export output.csv
 *   node blog-tracker.js sync               # force full Notion → local sync
 */

const fs = require('fs');
const path = require('path');
const { POST_TYPES, WORD_COUNT_TARGETS } = require('./config');

// ---------------------------------------------------------------------------
// Paths & constants
// ---------------------------------------------------------------------------

const DATA_DIR = path.join(__dirname, '..', 'data');
const BACKUPS_DIR = path.join(DATA_DIR, 'backups');
const TRACKER_PATH = path.join(DATA_DIR, 'blog-tracker.json');
const DB_META_PATH = path.join(DATA_DIR, 'blog-notion-db.json');

const NOTION_BASE = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

const STATUSES = ['proposed', 'approved', 'in_production', 'draft', 'published', 'archived'];
const VALID_STATUSES = new Set(STATUSES);

const TRANSITIONS = {
  proposed:      new Set(['approved', 'archived']),
  approved:      new Set(['in_production', 'archived']),
  in_production: new Set(['draft', 'archived']),
  draft:         new Set(['published', 'in_production', 'archived']),
  published:     new Set(['archived']),
  archived:      new Set(),
};

const REQUIRED_ADD_FIELDS = ['slug', 'title', 'focus_keyword', 'post_type', 'tier', 'market'];

// ---------------------------------------------------------------------------
// Status & type mappings (internal ↔ Notion)
// ---------------------------------------------------------------------------

const STATUS_TO_NOTION = {
  proposed: 'Proposed',
  approved: 'Approved',
  in_production: 'In Production',
  draft: 'Drafted',
  published: 'Published',
  archived: 'Archived',
};

const STATUS_FROM_NOTION = Object.fromEntries(
  Object.entries(STATUS_TO_NOTION).map(([k, v]) => [v, k])
);

const TYPE_TO_NOTION = {
  city_listicle: 'City Listicle',
  product_listicle: 'Product Listicle',
  pillar: 'Pillar Page',
  cluster: 'Cluster',
  leaf: 'Leaf',
  how_to: 'How-To Guide',
};

const TYPE_FROM_NOTION = Object.fromEntries(
  Object.entries(TYPE_TO_NOTION).map(([k, v]) => [v, k])
);

const TIER_TO_NOTION = {
  cornerstone: 'Cornerstone',
  cluster: 'Cluster',
  leaf: 'Leaf',
};

const TIER_FROM_NOTION = Object.fromEntries(
  Object.entries(TIER_TO_NOTION).map(([k, v]) => [v, k])
);

// ---------------------------------------------------------------------------
// Notion API helpers
// ---------------------------------------------------------------------------

function notionHeaders() {
  const key = process.env.NOTION_API_KEY;
  if (!key) throw new Error('NOTION_API_KEY not set');
  return {
    'Authorization': `Bearer ${key}`,
    'Notion-Version': NOTION_VERSION,
    'Content-Type': 'application/json',
  };
}

async function notionFetch(urlPath, options = {}) {
  const url = urlPath.startsWith('http') ? urlPath : `${NOTION_BASE}${urlPath}`;
  for (let attempt = 0; attempt <= 3; attempt++) {
    const res = await fetch(url, {
      ...options,
      headers: { ...notionHeaders(), ...(options.headers || {}) },
    });
    if (res.status === 429) {
      const wait = Math.max(parseInt(res.headers.get('retry-after') || '2', 10), 1) * 1000;
      await new Promise(r => setTimeout(r, wait));
      continue;
    }
    const body = await res.json();
    if (!res.ok) {
      throw new Error(`Notion ${res.status}: ${body.message || JSON.stringify(body)}`);
    }
    return body;
  }
  throw new Error('Notion rate limit exceeded after retries');
}

function getDatabaseId() {
  if (!fs.existsSync(DB_META_PATH)) {
    throw new Error('blog-notion-db.json not found — run blog-notion-sync.js first');
  }
  return JSON.parse(fs.readFileSync(DB_META_PATH, 'utf-8')).database_id;
}

// ---------------------------------------------------------------------------
// Notion ↔ Internal format converters
// ---------------------------------------------------------------------------

function richText(val) {
  if (!val) return '';
  if (Array.isArray(val)) return val.map(t => t.plain_text || '').join('');
  return String(val);
}

function notionPageToPost(page) {
  const p = page.properties;

  const status = STATUS_FROM_NOTION[p.Status?.select?.name] || 'proposed';
  const postType = TYPE_FROM_NOTION[p['Post Type']?.select?.name] || p['Post Type']?.select?.name || 'cluster';
  const tier = TIER_FROM_NOTION[p.Tier?.select?.name] || p.Tier?.select?.name || 'cluster';

  return {
    _notion_page_id: page.id,
    id: richText(p.Slug?.rich_text) || page.id,
    slug: richText(p.Slug?.rich_text) || '',
    title: richText(p.Title?.title) || '',
    focus_keyword: richText(p['Focus Keyword']?.rich_text) || '',
    post_type: postType,
    tier,
    market: p.Market?.select?.name || '',
    pillar_slug: richText(p['Pillar Slug']?.rich_text) || null,
    category: p.Category?.multi_select?.map(o => o.name).join(', ') || null,
    status,
    author: p.Author?.select?.name || 'Ryan Spence',
    word_count_target: p['Word Count Target']?.number || null,
    word_count_actual: p['Word Count Actual']?.number || null,
    wp_post_id: p['WP Post ID']?.number || null,
    url: p.URL?.url || null,
    meta_description: richText(p['Meta Description']?.rich_text) || null,
    country_code: richText(p['Country Code']?.rich_text) || null,
    is_ymyl: p['Is YMYL']?.checkbox || false,
    priority_score: p['Priority Score']?.number || null,
    business_value: p['Business Value']?.select?.name ? Number(p['Business Value'].select.name) : null,
    search_volume: p['Search Volume']?.number || null,
    kd: p.KD?.number || null,
    cpc: p.CPC?.number || null,
    dates: {
      proposed: null,
      approved: null,
      started: null,
      research_done: null,
      outline_done: null,
      draft_done: null,
      qc_passed: null,
      published: p['Date Published']?.date?.start || null,
    },
    date_modified: p['Date Modified']?.date?.start || null,
    tags: p.Tags?.multi_select?.map(o => o.name) || [],
    // Operational fields (not in Notion — stored in pipeline-ledger)
    paths: { research_report: null, outline: null, draft: null, fact_check_log: null, commissioner_log: null },
    qc_attempts: 0,
    qc_last_result: null,
    notes: '',
  };
}

function postToNotionProps(post) {
  const props = {};

  if (post.title != null) props.Title = { title: [{ text: { content: String(post.title).slice(0, 2000) } }] };
  if (post.slug != null) props.Slug = { rich_text: [{ text: { content: String(post.slug) } }] };
  if (post.status != null) props.Status = { select: { name: STATUS_TO_NOTION[post.status] || 'Proposed' } };
  if (post.post_type != null) props['Post Type'] = { select: { name: TYPE_TO_NOTION[post.post_type] || post.post_type } };
  if (post.market != null) props.Market = { select: { name: post.market.toUpperCase() } };
  if (post.tier != null) props.Tier = { select: { name: TIER_TO_NOTION[post.tier] || post.tier } };
  if (post.author != null) props.Author = { select: { name: post.author === 'Ryan' ? 'Ryan Spence' : post.author } };
  if (post.focus_keyword != null) props['Focus Keyword'] = { rich_text: [{ text: { content: String(post.focus_keyword).slice(0, 2000) } }] };
  if (post.pillar_slug != null) props['Pillar Slug'] = { rich_text: [{ text: { content: String(post.pillar_slug) } }] };
  if (post.country_code != null) props['Country Code'] = { rich_text: [{ text: { content: String(post.country_code) } }] };
  if (post.meta_description != null) props['Meta Description'] = { rich_text: [{ text: { content: String(post.meta_description).slice(0, 2000) } }] };
  if (post.wp_post_id != null) props['WP Post ID'] = { number: post.wp_post_id };
  if (post.url != null) props.URL = { url: post.url };
  if (post.word_count_target != null) props['Word Count Target'] = { number: Array.isArray(post.word_count_target) ? post.word_count_target[0] : post.word_count_target };
  if (post.word_count_actual != null) props['Word Count Actual'] = { number: post.word_count_actual };
  if (post.is_ymyl != null) props['Is YMYL'] = { checkbox: !!post.is_ymyl };
  if (post.priority_score != null) props['Priority Score'] = { number: post.priority_score };
  if (post.business_value != null) props['Business Value'] = { select: { name: String(post.business_value) } };
  if (post.search_volume != null) props['Search Volume'] = { number: post.search_volume };
  if (post.kd != null) props.KD = { number: post.kd };
  if (post.cpc != null) props.CPC = { number: post.cpc };
  if (post.category != null) props.Category = { select: { name: post.category } };

  // Dates
  if (post.dates?.published) props['Date Published'] = { date: { start: post.dates.published } };
  if (post.date_modified) props['Date Modified'] = { date: { start: post.date_modified } };

  return props;
}

// ---------------------------------------------------------------------------
// Local cache helpers
// ---------------------------------------------------------------------------

function ensureDirs() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(BACKUPS_DIR)) fs.mkdirSync(BACKUPS_DIR, { recursive: true });
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

function daysBetween(dateA, dateB) {
  if (!dateA || !dateB) return null;
  return Math.round((new Date(dateB) - new Date(dateA)) / (1000 * 60 * 60 * 24));
}

function writeLocalCache(posts) {
  ensureDirs();
  const counts = { proposed: 0, approved: 0, in_production: 0, draft: 0, published: 0, archived: 0 };
  for (const p of posts) {
    if (counts[p.status] !== undefined) counts[p.status]++;
  }
  const tracker = {
    meta: { created: today(), updated: today(), total_posts: posts.length, by_status: counts, source: 'notion' },
    posts,
  };
  const tmp = TRACKER_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(tracker, null, 2), 'utf-8');
  fs.renameSync(tmp, TRACKER_PATH);
}

function readLocalCache() {
  if (!fs.existsSync(TRACKER_PATH)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(TRACKER_PATH, 'utf-8'));
    if (data.meta && Array.isArray(data.posts)) return data;
  } catch { /* corrupt cache */ }
  return null;
}

function backupTracker() {
  ensureDirs();
  if (!fs.existsSync(TRACKER_PATH)) return null;
  const dest = path.join(BACKUPS_DIR, `blog-tracker-${timestamp()}.json`);
  fs.copyFileSync(TRACKER_PATH, dest);
  return dest;
}

// ---------------------------------------------------------------------------
// Core: Notion queries
// ---------------------------------------------------------------------------

/**
 * Fetch ALL pages from the Notion blog DB. Handles pagination.
 * Writes to local cache as backup.
 * @returns {object[]} Array of post objects in internal format
 */
async function fetchAllPosts() {
  const dbId = getDatabaseId();
  let allPages = [];
  let cursor = undefined;

  do {
    const body = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;

    const res = await notionFetch(`/databases/${dbId}/query`, {
      method: 'POST',
      body: JSON.stringify(body),
    });

    allPages = allPages.concat(res.results || []);
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);

  const posts = allPages.map(notionPageToPost);
  writeLocalCache(posts);
  return posts;
}

/**
 * Find a Notion page by slug.
 * @param {string} slug
 * @returns {object|null} Page from Notion API (raw) or null
 */
async function findPageBySlug(slug) {
  const dbId = getDatabaseId();
  const res = await notionFetch(`/databases/${dbId}/query`, {
    method: 'POST',
    body: JSON.stringify({
      filter: { property: 'Slug', rich_text: { equals: slug } },
      page_size: 1,
    }),
  });
  return res.results?.[0] || null;
}

/**
 * Find a Notion page by WP Post ID.
 */
async function findPageByWpId(wpPostId) {
  const dbId = getDatabaseId();
  const res = await notionFetch(`/databases/${dbId}/query`, {
    method: 'POST',
    body: JSON.stringify({
      filter: { property: 'WP Post ID', number: { equals: wpPostId } },
      page_size: 1,
    }),
  });
  return res.results?.[0] || null;
}

// ---------------------------------------------------------------------------
// Load / Save (compatible API surface)
// ---------------------------------------------------------------------------

/**
 * Load the blog tracker from Notion. Returns the same shape as the old
 * JSON tracker: { meta: {...}, posts: [...] }.
 * Falls back to local cache if Notion is unreachable.
 * @returns {Promise<object>}
 */
async function loadTracker() {
  try {
    const posts = await fetchAllPosts();
    const counts = { proposed: 0, approved: 0, in_production: 0, draft: 0, published: 0, archived: 0 };
    for (const p of posts) {
      if (counts[p.status] !== undefined) counts[p.status]++;
    }
    return {
      meta: { created: today(), updated: today(), total_posts: posts.length, by_status: counts, source: 'notion' },
      posts,
    };
  } catch (err) {
    console.log(`  [blog-tracker] Notion unavailable (${err.message}) — falling back to local cache`);
    const cache = readLocalCache();
    if (cache) return cache;
    return { meta: { created: today(), updated: today(), total_posts: 0, by_status: { proposed: 0, approved: 0, in_production: 0, draft: 0, published: 0, archived: 0 }, source: 'cache' }, posts: [] };
  }
}

/**
 * Save tracker (writes local cache). For backward compat.
 * In the Notion-backed world, individual functions write to Notion directly.
 * This only updates the local backup.
 */
async function saveTracker(tracker) {
  writeLocalCache(tracker.posts);
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

/**
 * Add a new post to Notion.
 * @param {object} postData  Must include: slug, title, focus_keyword, post_type, tier, market
 * @returns {Promise<object>} The created post in internal format
 */
async function addPost(postData) {
  for (const field of REQUIRED_ADD_FIELDS) {
    if (!postData[field]) throw new Error(`Missing required field: ${field}`);
  }

  const validTypes = Object.values(POST_TYPES);
  if (!validTypes.includes(postData.post_type)) {
    throw new Error(`Invalid post_type "${postData.post_type}". Valid: ${validTypes.join(', ')}`);
  }

  // Check duplicate
  const existing = await findPageBySlug(postData.slug);
  if (existing) throw new Error(`Post with slug "${postData.slug}" already exists in Notion`);

  const status = postData.status && VALID_STATUSES.has(postData.status) ? postData.status : 'proposed';
  const wordTarget = postData.word_count_target || WORD_COUNT_TARGETS[postData.post_type]?.[0] || 1000;

  const post = {
    ...postData,
    status,
    author: postData.author || 'Ryan Spence',
    word_count_target: Array.isArray(wordTarget) ? wordTarget[0] : wordTarget,
    dates: { proposed: today(), ...(postData.dates || {}), published: null },
  };

  const props = postToNotionProps(post);
  const dbId = getDatabaseId();

  const page = await notionFetch('/pages', {
    method: 'POST',
    body: JSON.stringify({ parent: { database_id: dbId }, properties: props }),
  });

  return notionPageToPost(page);
}

/**
 * Update a post's status with transition validation.
 * @param {string} slug
 * @param {string} newStatus
 * @param {object} [meta]  Optional extra fields (e.g. { wp_post_id, notes })
 * @returns {Promise<object>} Updated post
 */
async function updateStatus(slug, newStatus, meta) {
  if (!VALID_STATUSES.has(newStatus)) {
    throw new Error(`Invalid status "${newStatus}". Valid: ${STATUSES.join(', ')}`);
  }

  const page = await findPageBySlug(slug);
  if (!page) throw new Error(`Post "${slug}" not found in Notion`);

  const post = notionPageToPost(page);

  const allowed = TRANSITIONS[post.status];
  if (!allowed || !allowed.has(newStatus)) {
    throw new Error(`Cannot transition from "${post.status}" to "${newStatus}". Allowed: ${[...(allowed || [])].join(', ') || '(none)'}`);
  }

  if (newStatus === 'published' && !post.wp_post_id && !(meta && meta.wp_post_id)) {
    throw new Error('Cannot publish without wp_post_id — pass it in meta');
  }

  const updates = { status: newStatus };

  if (newStatus === 'published') {
    updates.dates = { published: today() };
  }

  if (meta) {
    if (meta.wp_post_id !== undefined) updates.wp_post_id = meta.wp_post_id;
    if (meta.word_count_actual !== undefined) updates.word_count_actual = meta.word_count_actual;
    if (meta.url !== undefined) updates.url = meta.url;
  }

  const props = postToNotionProps(updates);
  updates.date_modified = today();
  props['Date Modified'] = { date: { start: today() } };

  await notionFetch(`/pages/${page.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ properties: props }),
  });

  return { ...post, ...updates };
}

/**
 * Update file paths on a post.
 * Paths are operational metadata — stored only in pipeline-ledger, not Notion.
 * This function is kept for API compat but is a no-op for Notion.
 */
async function updatePaths(slug, paths) {
  // Paths (research_report, outline, draft, etc.) are pipeline-operational
  // metadata stored in the pipeline-ledger files, not in Notion.
  // This is intentionally a no-op for the Notion-backed tracker.
  return null;
}

/**
 * Update QC result on a post. Updates Date Modified in Notion.
 * QC details stay in pipeline-ledger.
 * @param {string} slug
 * @param {object} result  The QC result object
 */
async function updateQC(slug, result) {
  const page = await findPageBySlug(slug);
  if (!page) return null;

  const props = { 'Date Modified': { date: { start: today() } } };
  await notionFetch(`/pages/${page.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ properties: props }),
  });

  return notionPageToPost(page);
}

/**
 * Mark a post as published with all required fields.
 * @param {string} slug
 * @param {number|string} wpPostId
 * @param {number} wordCount
 */
async function setPublished(slug, wpPostId, wordCount) {
  const page = await findPageBySlug(slug);
  if (!page) throw new Error(`Post "${slug}" not found in Notion`);

  const props = {
    Status: { select: { name: 'Published' } },
    'WP Post ID': { number: Number(wpPostId) },
    'Word Count Actual': { number: wordCount },
    'Date Published': { date: { start: today() } },
    'Date Modified': { date: { start: today() } },
  };

  await notionFetch(`/pages/${page.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ properties: props }),
  });
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/**
 * Get all posts with a given status.
 */
async function getByStatus(status) {
  const dbId = getDatabaseId();
  const notionStatus = STATUS_TO_NOTION[status] || status;
  let allPages = [];
  let cursor = undefined;

  do {
    const body = {
      page_size: 100,
      filter: { property: 'Status', select: { equals: notionStatus } },
    };
    if (cursor) body.start_cursor = cursor;
    const res = await notionFetch(`/databases/${dbId}/query`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    allPages = allPages.concat(res.results || []);
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);

  return allPages.map(notionPageToPost);
}

/**
 * Get all posts for a given market.
 */
async function getByMarket(market) {
  const dbId = getDatabaseId();
  const res = await notionFetch(`/databases/${dbId}/query`, {
    method: 'POST',
    body: JSON.stringify({
      filter: { property: 'Market', select: { equals: market.toUpperCase() } },
      page_size: 100,
    }),
  });
  return (res.results || []).map(notionPageToPost);
}

/**
 * Get all posts for a given tier.
 */
async function getByTier(tier) {
  const dbId = getDatabaseId();
  const notionTier = TIER_TO_NOTION[tier.toLowerCase()] || tier;
  const res = await notionFetch(`/databases/${dbId}/query`, {
    method: 'POST',
    body: JSON.stringify({
      filter: { property: 'Tier', select: { equals: notionTier } },
      page_size: 100,
    }),
  });
  return (res.results || []).map(notionPageToPost);
}

/**
 * Get all posts under a pillar slug.
 */
async function getByPillar(pillarSlug) {
  const dbId = getDatabaseId();
  const res = await notionFetch(`/databases/${dbId}/query`, {
    method: 'POST',
    body: JSON.stringify({
      filter: { property: 'Pillar Slug', rich_text: { equals: pillarSlug } },
      page_size: 100,
    }),
  });
  return (res.results || []).map(notionPageToPost);
}

/**
 * Get a single post by slug.
 */
async function getPost(slug) {
  const page = await findPageBySlug(slug);
  if (!page) return null;
  return notionPageToPost(page);
}

/**
 * Get a summary of the tracker.
 */
async function getSummary() {
  const posts = await fetchAllPosts();
  const by_status = { proposed: 0, approved: 0, in_production: 0, draft: 0, published: 0, archived: 0 };
  const by_market = {};
  const by_tier = {};
  const by_type = {};
  const recent_published = [];
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const stale = [];

  for (const post of posts) {
    if (by_status[post.status] !== undefined) by_status[post.status]++;
    const market = post.market || '(unknown)';
    by_market[market] = (by_market[market] || 0) + 1;
    const tier = post.tier || '(unknown)';
    by_tier[tier] = (by_tier[tier] || 0) + 1;
    const type = post.post_type || '(unknown)';
    by_type[type] = (by_type[type] || 0) + 1;

    if (post.status === 'published' && post.dates.published && post.dates.published >= sevenDaysAgo) {
      recent_published.push({ slug: post.slug, title: post.title, published: post.dates.published });
    }

    if (post.status === 'in_production' && post.date_modified) {
      const days = daysBetween(post.date_modified, today());
      if (days !== null && days > 7) {
        stale.push({ slug: post.slug, title: post.title, days_in_production: days });
      }
    }
  }

  return {
    total: posts.length,
    by_status,
    by_market,
    by_tier,
    by_type,
    recent_published,
    stale_in_production: stale,
  };
}

/**
 * Get the next approved post (oldest first — by page creation date since Notion sorts this way).
 */
async function getNextApproved() {
  const approved = await getByStatus('approved');
  if (approved.length === 0) return null;
  return approved[0]; // Notion returns oldest first by default
}

// ---------------------------------------------------------------------------
// Import / Export
// ---------------------------------------------------------------------------

/**
 * Import posts from a CSV file into Notion. Dedupes by slug.
 */
async function importFromCSV(csvPath) {
  const raw = fs.readFileSync(csvPath, 'utf-8');
  const lines = raw.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) throw new Error('CSV has no data rows');

  const headers = parseCSVLine(lines[0]).map(h => h.toLowerCase().replace(/\s+/g, '_'));

  const colMap = {
    title: ['title'], slug: ['slug'],
    focus_keyword: ['focus_keyword', 'focus keyword', 'keyword'],
    post_type: ['post_type', 'post type', 'type'],
    tier: ['tier'], market: ['market'], status: ['status'],
    wp_post_id: ['post_id', 'wp_post_id', 'post id', 'wordpress_id'],
    word_count: ['word_count', 'word count', 'words'],
    category: ['category'],
    pillar_slug: ['pillar_slug', 'pillar slug', 'pillar'],
    country_code: ['country_code', 'country code', 'country'],
  };

  function findCol(name) {
    const candidates = colMap[name] || [name];
    for (const c of candidates) {
      const idx = headers.indexOf(c.toLowerCase().replace(/\s+/g, '_'));
      if (idx !== -1) return idx;
    }
    return -1;
  }

  let imported = 0;
  let skipped = 0;

  for (let i = 1; i < lines.length; i++) {
    const vals = parseCSVLine(lines[i]);
    const get = (name) => {
      const idx = findCol(name);
      return idx >= 0 && idx < vals.length ? vals[idx] : '';
    };

    const slug = get('slug');
    if (!slug) continue;

    try {
      const existing = await findPageBySlug(slug);
      if (existing) { skipped++; continue; }

      const postType = get('post_type') || 'cluster';
      const validTypes = Object.values(POST_TYPES);
      const finalType = validTypes.includes(postType) ? postType : 'cluster';

      await addPost({
        slug,
        title: get('title') || slug,
        focus_keyword: get('focus_keyword') || slug.replace(/-/g, ' '),
        post_type: finalType,
        tier: get('tier') || 'cluster',
        market: get('market') || 'UK',
        status: get('status') || 'proposed',
        wp_post_id: get('wp_post_id') ? Number(get('wp_post_id')) : null,
        word_count_actual: get('word_count') ? Number(get('word_count')) : null,
        category: get('category') || null,
        pillar_slug: get('pillar_slug') || null,
        country_code: get('country_code') || null,
      });
      imported++;
    } catch {
      skipped++;
    }
  }

  const total = imported + skipped;
  return { imported, skipped, total };
}

/**
 * Export the tracker to a CSV file.
 */
async function exportToCSV(outputPath) {
  const posts = await fetchAllPosts();
  const csvHeaders = [
    'Slug', 'Title', 'Focus Keyword', 'Post Type', 'Tier', 'Market',
    'Status', 'Author', 'Category', 'Pillar Slug', 'Country Code',
    'Word Count Target', 'Word Count Actual', 'WP Post ID',
    'Is YMYL', 'Priority Score', 'Business Value',
    'Search Volume', 'KD', 'CPC',
    'Date Published', 'Date Modified', 'URL',
  ];

  const rows = [csvHeaders.map(escapeCSV).join(',')];

  for (const p of posts) {
    const row = [
      p.slug, p.title, p.focus_keyword, p.post_type, p.tier, p.market,
      p.status, p.author, p.category, p.pillar_slug, p.country_code,
      p.word_count_target, p.word_count_actual, p.wp_post_id,
      p.is_ymyl ? 'YES' : 'NO', p.priority_score, p.business_value,
      p.search_volume, p.kd, p.cpc,
      p.dates.published, p.date_modified, p.url,
    ];
    rows.push(row.map(escapeCSV).join(','));
  }

  fs.writeFileSync(outputPath, rows.join('\n'), 'utf-8');
  return posts.length;
}

// ---------------------------------------------------------------------------
// Analytics
// ---------------------------------------------------------------------------

/**
 * Find posts stuck in_production for more than N days.
 */
async function findStale(daysThreshold) {
  const posts = await getByStatus('in_production');
  const results = [];

  for (const post of posts) {
    const refDate = post.date_modified || today();
    const days = daysBetween(refDate, today());
    if (days !== null && days > daysThreshold) {
      results.push({ ...post, days_in_production: days });
    }
  }

  return results.sort((a, b) => b.days_in_production - a.days_in_production);
}

/**
 * Get production performance stats.
 */
async function getProductionStats() {
  const posts = await fetchAllPosts();
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  let recentPublished = 0;
  let publishedCount = 0;

  for (const post of posts) {
    if (post.status === 'published') publishedCount++;
    if (post.status === 'published' && post.dates.published && post.dates.published >= thirtyDaysAgo) {
      recentPublished++;
    }
  }

  const weeks = 30 / 7;
  const posts_per_week = Math.round((recentPublished / weeks) * 10) / 10;

  return {
    total_published: publishedCount,
    avg_days_to_publish: null, // needs date tracking not yet in Notion
    posts_per_week,
    qc_pass_rate: null, // QC data in pipeline-ledger, not Notion
  };
}

// ---------------------------------------------------------------------------
// CSV helpers
// ---------------------------------------------------------------------------

function parseCSVLine(line) {
  const fields = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') { current += '"'; i++; }
        else inQuotes = false;
      } else current += ch;
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ',') { fields.push(current.trim()); current = ''; }
      else current += ch;
    }
  }
  fields.push(current.trim());
  return fields;
}

function escapeCSV(val) {
  const s = String(val == null ? '' : val);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function cli() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command) {
    console.log('Usage:');
    console.log('  node blog-tracker.js summary');
    console.log('  node blog-tracker.js status <status>');
    console.log('  node blog-tracker.js add <slug> <title> <post_type> <tier> <market>');
    console.log('  node blog-tracker.js next');
    console.log('  node blog-tracker.js stale <days>');
    console.log('  node blog-tracker.js stats');
    console.log('  node blog-tracker.js export <output.csv>');
    console.log('  node blog-tracker.js sync');
    process.exit(1);
  }

  switch (command) {
    case 'summary': {
      const s = await getSummary();
      console.log(`\n=== Blog Tracker Summary (Notion) ===\n`);
      console.log(`Total posts: ${s.total}\n`);
      console.log('By Status:');
      for (const [status, count] of Object.entries(s.by_status)) {
        console.log(`  ${status.padEnd(16)} ${count}`);
      }
      console.log('\nBy Market:');
      for (const [market, count] of Object.entries(s.by_market).sort((a, b) => b[1] - a[1])) {
        console.log(`  ${market.padEnd(16)} ${count}`);
      }
      console.log('\nBy Tier:');
      for (const [tier, count] of Object.entries(s.by_tier).sort((a, b) => b[1] - a[1])) {
        console.log(`  ${tier.padEnd(16)} ${count}`);
      }
      console.log('\nBy Type:');
      for (const [type, count] of Object.entries(s.by_type).sort((a, b) => b[1] - a[1])) {
        console.log(`  ${type.padEnd(20)} ${count}`);
      }
      if (s.recent_published.length > 0) {
        console.log('\nRecently Published (7 days):');
        for (const p of s.recent_published) console.log(`  ${p.published}  ${p.title}`);
      }
      if (s.stale_in_production.length > 0) {
        console.log('\nStale (in_production > 7 days):');
        for (const p of s.stale_in_production) console.log(`  ${p.days_in_production}d  ${p.title}`);
      }
      break;
    }

    case 'status': {
      const status = args[1];
      if (!status) { console.log(`Valid statuses: ${STATUSES.join(', ')}`); process.exit(1); }
      if (!VALID_STATUSES.has(status)) { console.error(`Invalid status "${status}"`); process.exit(1); }
      const posts = await getByStatus(status);
      console.log(`\n=== Posts with status "${status}" (${posts.length}) ===\n`);
      for (const p of posts) {
        const wpId = p.wp_post_id ? ` [WP#${p.wp_post_id}]` : '';
        console.log(`  ${p.slug}  — ${p.title}${wpId}`);
      }
      if (posts.length === 0) console.log('  (none)');
      break;
    }

    case 'add': {
      const [, slug, title, postType, tier, market] = args;
      if (!slug || !title || !postType || !tier || !market) {
        console.log('Usage: node blog-tracker.js add <slug> <title> <post_type> <tier> <market>');
        process.exit(1);
      }
      try {
        const post = await addPost({
          slug, title, focus_keyword: slug.replace(/-/g, ' '),
          post_type: postType, tier, market,
        });
        console.log(`Added "${slug}" to Notion Blog Tracker`);
      } catch (err) {
        console.error(`Error: ${err.message}`);
        process.exit(1);
      }
      break;
    }

    case 'next': {
      const next = await getNextApproved();
      if (next) {
        console.log(`\nNext approved post:`);
        console.log(`  Slug:    ${next.slug}`);
        console.log(`  Title:   ${next.title}`);
        console.log(`  Type:    ${next.post_type}`);
        console.log(`  Tier:    ${next.tier}`);
        console.log(`  Market:  ${next.market}`);
      } else {
        console.log('No approved posts in queue.');
      }
      break;
    }

    case 'stale': {
      const days = parseInt(args[1], 10) || 7;
      const stale = await findStale(days);
      console.log(`\n=== Posts in_production > ${days} days (${stale.length}) ===\n`);
      for (const p of stale) console.log(`  ${p.days_in_production}d  ${p.slug}  — ${p.title}`);
      if (stale.length === 0) console.log('  (none)');
      break;
    }

    case 'stats': {
      const stats = await getProductionStats();
      console.log('\n=== Production Stats (Notion) ===\n');
      console.log(`  Total published:      ${stats.total_published}`);
      console.log(`  Posts/week (30d):     ${stats.posts_per_week}`);
      console.log(`  QC first-pass rate:   ${stats.qc_pass_rate !== null ? stats.qc_pass_rate + '%' : 'N/A (pipeline-ledger)'}`);
      break;
    }

    case 'export': {
      const outputPath = args[1];
      if (!outputPath) { console.log('Usage: node blog-tracker.js export <output.csv>'); process.exit(1); }
      const absPath = path.isAbsolute(outputPath) ? outputPath : path.join(process.cwd(), outputPath);
      const count = await exportToCSV(absPath);
      console.log(`Exported ${count} posts to ${absPath}`);
      break;
    }

    case 'sync': {
      console.log('Syncing from Notion...');
      backupTracker();
      const posts = await fetchAllPosts();
      console.log(`Synced ${posts.length} posts from Notion → local cache`);
      break;
    }

    default:
      console.error(`Unknown command: ${command}`);
      console.log('Commands: summary, status, add, next, stale, stats, export, sync');
      process.exit(1);
  }
}

if (require.main === module) {
  cli().catch(err => { console.error(err); process.exit(1); });
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  loadTracker,
  saveTracker,
  backupTracker,
  addPost,
  updateStatus,
  updatePaths,
  updateQC,
  setPublished,
  getByStatus,
  getByMarket,
  getByTier,
  getByPillar,
  getPost,
  getSummary,
  getNextApproved,
  importFromCSV,
  exportToCSV,
  findStale,
  getProductionStats,
  // New Notion-specific exports
  fetchAllPosts,
  findPageBySlug,
};
