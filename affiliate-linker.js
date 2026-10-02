/**
 * Affiliate Linker for Padeli Blog Pipeline
 *
 * Stage 5b (after internal linking, before images): converts raw retailer /
 * affiliate-network links into geo-aware `[geo_link]` shortcodes handled by
 * the Padeli Geo Links WordPress plugin (/go/{slug}/), adds at most one
 * `[geo_box]` per product section, inserts a single affiliate disclosure, and
 * gates everything on whether an approved partner covers the post's market.
 *
 * Config: config/affiliate.json (partners, networks, retailer hosts, brands,
 * geo slugs that exist in the plugin, product slugs, rules).
 *
 * Idempotent: running the stage twice on the same HTML changes nothing.
 *
 * Node.js v24+ — zero external dependencies — CommonJS
 *
 * CLI:
 *   node affiliate-linker.js <post.html> [--market GB] [--out linked.html] [--json]
 */

const fs = require('fs');
const path = require('path');
const { countWords, slugify } = require('./utils');

const DEFAULT_CONFIG_PATH = path.join(__dirname, 'config', 'affiliate.json');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

let _configCache = null;

/**
 * Load config/affiliate.json (cached).
 * @param {string} [configPath]
 * @returns {object}
 */
function loadAffiliateConfig(configPath) {
  if (!configPath && _configCache) return _configCache;
  const p = configPath || DEFAULT_CONFIG_PATH;
  const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
  if (!configPath) _configCache = cfg;
  return cfg;
}

/**
 * Expand a list of country codes / group names into a Set of ISO codes.
 * @param {string[]} list
 * @param {object} groups
 * @returns {Set<string>}
 */
function expandCountries(list, groups) {
  const out = new Set();
  for (const raw of list || []) {
    const code = String(raw).toUpperCase().trim();
    if (groups && groups[code]) {
      for (const c of groups[code]) out.add(c);
    } else if (code) {
      out.add(code);
    }
  }
  return out;
}

/**
 * Normalise a brief market / country_code value to an ISO 3166-1 alpha-2 code.
 * 'UK' -> 'GB', 'Bali' -> 'ID', 'es' -> 'ES'. Unknown -> null.
 *
 * @param {string} market
 * @param {object} config
 * @returns {string|null}
 */
function normaliseMarket(market, config) {
  if (!market) return null;
  const up = String(market).toUpperCase().trim();
  const aliases = config.market_aliases || {};
  if (aliases[up]) return aliases[up];
  if (/^[A-Z]{2}$/.test(up)) return up;
  return null;
}

/**
 * Approved partners whose coverage includes the given country.
 * @param {string} cc - ISO country code
 * @param {object} config
 * @returns {object[]}
 */
function partnersForMarket(cc, config) {
  if (!cc) return [];
  const groups = config.country_groups || {};
  return (config.partners || []).filter((p) => {
    if ((p.status || 'approved') !== 'approved') return false;
    return expandCountries(p.countries, groups).has(cc);
  });
}

// ---------------------------------------------------------------------------
// Link classification
// ---------------------------------------------------------------------------

function _decodeEntities(s) {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&#0*39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function _host(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

function _hostMatches(host, patterns) {
  if (!host) return null;
  for (const pat of patterns || []) {
    const p = String(pat).toLowerCase().replace(/^www\./, '');
    if (host === p || host.endsWith('.' + p)) return p;
  }
  return null;
}

/**
 * Classify an href as a money link.
 *
 * @param {string} href
 * @param {object} config
 * @returns {{ kind: 'network'|'retailer'|null, network: string|null, retailer_host: string|null, destination: string, partner: object|null }}
 */
function classifyHref(href, config) {
  const clean = _decodeEntities(href).trim();
  const result = { kind: null, network: null, retailer_host: null, destination: clean, partner: null };
  if (!/^https?:\/\//i.test(clean)) return result;

  const host = _host(clean);

  // Affiliate network wrapper (awin cread, CJ click URLs)
  for (const net of config.affiliate_networks || []) {
    if (_hostMatches(host, net.hosts)) {
      result.kind = 'network';
      result.network = net.network;
      try {
        const u = new URL(clean);
        const dest = net.destination_param ? u.searchParams.get(net.destination_param) : null;
        if (dest) result.destination = dest;
      } catch { /* keep href */ }
      break;
    }
  }

  const destHost = _host(result.destination);
  const retailer = _hostMatches(destHost, config.retailer_hosts);
  if (retailer) {
    result.retailer_host = retailer;
    if (!result.kind) result.kind = 'retailer';
  }

  // A network link always counts even if the destination host is unknown
  if (result.kind) {
    for (const p of config.partners || []) {
      if (_hostMatches(destHost, p.hosts)) { result.partner = p; break; }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Brands, categories, products
// ---------------------------------------------------------------------------

function _escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Find the first known brand in a string. Case-insensitive, word-bounded.
 * @returns {string|null} canonical brand name
 */
function detectBrand(text, config) {
  if (!text) return null;
  let best = null;
  for (const brand of config.brands || []) {
    const re = new RegExp(`(^|[^\\w])${_escapeRe(brand)}(?![\\w])`, 'i');
    const m = re.exec(text);
    if (m && (best === null || m.index < best.index)) best = { brand, index: m.index };
  }
  return best ? best.brand : null;
}

/**
 * Detect a product category from free text (heading, URL, anchor, keyword).
 * @returns {'racket'|'shoe'|'ball'|'bag'|null}
 */
function detectCategory(text, config) {
  if (!text) return null;
  const lower = String(text).toLowerCase();
  const kws = config.category_keywords || {};
  // Order matters: shoes before rackets so "padel shoes for racket sports" -> shoe
  for (const cat of ['shoe', 'ball', 'bag', 'racket']) {
    for (const kw of kws[cat] || []) {
      const re = new RegExp(`(^|[^a-z])${_escapeRe(kw.toLowerCase())}(?![a-z])`);
      if (re.test(lower)) return cat;
    }
  }
  return null;
}

function _stripYear(s) {
  return String(s).replace(/\b20\d{2}\b/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

/**
 * Suggested geo slug for a product: `<brand>-<model>` kebab, year dropped.
 * @param {string} name - e.g. "NOX AT10 Genius 18K Alum 2026"
 * @param {object} config
 * @returns {string} e.g. "nox-at10-genius-18k-alum"
 */
function suggestProductSlug(name, config) {
  const brand = detectBrand(name, config);
  let model = _stripYear(name);
  if (brand) {
    model = model.replace(new RegExp(`(^|[^\\w])${_escapeRe(brand)}(?![\\w])`, 'i'), '$1');
  }
  model = model.replace(/[(),:;]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  return slugify(`${brand || ''} ${model}`);
}

/**
 * Look up a product slug that already exists in the plugin (config.products).
 * Matches by slug, name or alias (case-insensitive, year-insensitive).
 * @returns {string|null}
 */
function findProductSlug(name, config) {
  const products = config.products || {};
  const target = _stripYear(name).toLowerCase();
  const suggested = suggestProductSlug(name, config);
  for (const [slug, def] of Object.entries(products)) {
    if (slug.startsWith('_')) continue;
    if (slug === suggested) return slug;
    const names = [def && def.name, ...((def && def.aliases) || [])].filter(Boolean);
    for (const n of names) {
      const nn = _stripYear(n).toLowerCase();
      if (nn && (nn === target || target.includes(nn))) return slug;
    }
  }
  return null;
}

/**
 * Resolve the generic category slug for a category + market (+ brand).
 * Returns a slug that exists in config.geo_slugs and covers the market, or null.
 */
function categorySlugFor(category, cc, brand, config) {
  const cat = category || 'other';
  const table = (config.category_slugs || {})[cat] || (config.category_slugs || {}).other || {};
  const groups = config.country_groups || {};
  const covers = (slug) => {
    const def = (config.geo_slugs || {})[slug];
    if (!def) return false;
    if (!cc) return true;
    return expandCountries(def.countries, groups).has(cc);
  };
  const candidates = [];
  if (brand && cc && (config.boutique_brands || []).some((b) => b.toLowerCase() === brand.toLowerCase())) {
    if (table[`boutique_${cc}`]) candidates.push(table[`boutique_${cc}`]);
  }
  if (cc && table[cc]) candidates.push(table[cc]);
  if (table.default) candidates.push(table.default);
  for (const slug of candidates) if (covers(slug)) return slug;
  return null;
}

// ---------------------------------------------------------------------------
// HTML structure helpers
// ---------------------------------------------------------------------------

const HEADING_RE = /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi;

function _stripTags(s) {
  return String(s || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * Character ranges [start, end) occupied by headings.
 */
function headingRanges(html) {
  const ranges = [];
  let m;
  HEADING_RE.lastIndex = 0;
  while ((m = HEADING_RE.exec(html)) !== null) {
    ranges.push([m.index, m.index + m[0].length]);
  }
  return ranges;
}

function _inRanges(pos, ranges) {
  return ranges.some(([s, e]) => pos >= s && pos < e);
}

/**
 * Parse a heading into a product if it names one.
 * "3. Head Coello Vibe 2026: best under £100" -> { name: "Head Coello Vibe 2026", brand: "Head" }
 */
function productFromHeading(headingText, config) {
  const text = _stripTags(_decodeEntities(headingText));
  if (!text) return null;
  let name = text.replace(/^\s*\d+\s*[.)\-–—:]\s*/, '');
  name = name.split(/\s*(?::|\s[-–—]\s|\s\|\s)\s*/)[0].trim();
  const brand = detectBrand(name, config);
  if (!brand) return null;
  // Product headings have the brand first-ish and at least one model token
  const rest = name.replace(new RegExp(`(^|[^\\w])${_escapeRe(brand)}(?![\\w])`, 'i'), '$1').trim();
  if (!rest || rest.split(/\s+/).length > 7) return null;
  return { name, brand };
}

/**
 * Split HTML into sections by H2/H3. Each section owns the body between its
 * heading and the next H2/H3 (or end of document).
 *
 * @returns {Array<{ index, level, heading, headingStart, headingEnd, bodyStart, bodyEnd, product }>}
 */
function splitSections(html, config) {
  const heads = [];
  const re = /<h([23])\b[^>]*>([\s\S]*?)<\/h\1>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    heads.push({ level: Number(m[1]), heading: _stripTags(m[2]), start: m.index, end: m.index + m[0].length });
  }
  const sections = [];
  // Preamble (before first heading)
  sections.push({
    index: 0, level: 0, heading: '', headingStart: 0, headingEnd: 0,
    bodyStart: 0, bodyEnd: heads.length ? heads[0].start : html.length, product: null,
  });
  for (let i = 0; i < heads.length; i++) {
    const h = heads[i];
    const next = heads[i + 1];
    sections.push({
      index: i + 1,
      level: h.level,
      heading: h.heading,
      headingStart: h.start,
      headingEnd: h.end,
      bodyStart: h.end,
      bodyEnd: next ? next.start : html.length,
      product: productFromHeading(h.heading, config),
    });
  }
  return sections;
}

function _sectionAt(pos, sections) {
  for (const s of sections) {
    if (pos >= s.headingStart && pos < s.bodyEnd) return s;
  }
  return sections[0];
}

/**
 * Where to insert content at the END of a section body. For Gutenberg
 * content, back up over the next heading's `<!-- wp:heading -->` opener.
 */
function _sectionInsertPoint(html, section) {
  let at = section.bodyEnd;
  if (at < html.length) {
    const pre = html.slice(Math.max(0, at - 200), at);
    const m = pre.match(/<!-- wp:heading(?: \{[^}]*\})? -->\s*$/);
    if (m) at -= m[0].length;
  }
  return at;
}

function _isGutenberg(html) {
  return /<!-- wp:/.test(html);
}

// ---------------------------------------------------------------------------
// Detection: products and brand mentions
// ---------------------------------------------------------------------------

/**
 * Count brand mentions in visible text (tags + shortcodes stripped).
 * Case-sensitive on the canonical / Capitalised / UPPER forms to avoid
 * matching common words ("head to the court").
 */
function brandMentions(html, config) {
  const text = _stripTags(html.replace(/\[\/?geo_[a-z]+[^\]]*\]/g, ' '));
  const counts = {};
  for (const brand of config.brands || []) {
    const forms = new Set([brand, brand.toUpperCase(), brand[0].toUpperCase() + brand.slice(1)]);
    let n = 0;
    for (const f of forms) {
      const re = new RegExp(`(^|[^\\w])${_escapeRe(f)}(?![\\w])`, 'g');
      n += (text.match(re) || []).length;
    }
    if (n > 0) counts[brand] = n;
  }
  return counts;
}

/**
 * Detect product names in body text as "<Brand> <Model tokens>".
 */
function productsInText(html, config) {
  const text = _stripTags(html.replace(/\[\/?geo_[a-z]+[^\]]*\]/g, ' '));
  const found = new Map();
  for (const brand of config.brands || []) {
    const forms = [brand, brand.toUpperCase(), brand[0].toUpperCase() + brand.slice(1)];
    const alt = [...new Set(forms)].map(_escapeRe).join('|');
    // Model tokens: start with a capital/digit; a dot is only allowed inside a
    // version number (2.6) so sentence ends never bleed into the next sentence.
    const tok = "[A-Z0-9][\\w'-]*(?:\\.\\d[\\w-]*)*";
    const re = new RegExp(`(?:^|[^\\w])(${alt})\\s+(${tok}(?:\\s+${tok}){0,4})`, 'g');
    let m;
    while ((m = re.exec(text)) !== null) {
      let model = _stripYear(m[2]).replace(/[.,;:]+$/, '').trim();
      // Drop trailing generic capitalised words that are not model tokens
      model = model.replace(/\s+(?:The|A|An|And|For|At|In|On|Of|UK|Padel|Racket|Rackets|Shoes?|Best)$/i, '').trim();
      if (!model) continue;
      const name = `${brand} ${model}`;
      const slug = suggestProductSlug(name, config);
      if (!found.has(slug)) found.set(slug, { name, brand, suggested_slug: slug, source: 'body' });
    }
  }
  return [...found.values()];
}

// ---------------------------------------------------------------------------
// Transformations
// ---------------------------------------------------------------------------

const ANCHOR_RE = /<a\b([^>]*)href=(["'])([^"']*)\2([^>]*)>([\s\S]*?)<\/a>/gi;

function _retailerNames(config) {
  const names = new Set();
  for (const p of config.partners || []) {
    names.add(p.name);
    names.add(p.name.replace(/\s+(UK|ES|IT|FR|DE|AU|NZ|IE|BR|US|Ireland|Australia|New Zealand|Spain|Italy|sport)$/i, ''));
  }
  for (const n of ['Decathlon', 'Amazon', 'adidas', 'ASICS', 'Padel Nuestro', 'Padel Market', 'PadelDogs', 'MUNICH']) names.add(n);
  return [...names].filter(Boolean).sort((a, b) => b.length - a.length);
}

/**
 * Rewrite an anchor so it no longer names a specific retailer (the geo link
 * may send the reader to a different one).
 */
function rewriteAnchor(innerHtml, config) {
  const rules = config.rules || {};
  if (!rules.strip_retailer_from_anchor) return innerHtml;
  const text = _stripTags(innerHtml);
  const names = _retailerNames(config).map(_escapeRe).join('|');
  const retailerOnly = new RegExp(`^(?:${names})$`, 'i');
  const suffix = new RegExp(`^(?:(.*?)\\s+)?(?:at|from|on|via)\\s+(?:${names})\\s*$`, 'i');

  if (retailerOnly.test(text)) return rules.retailer_only_anchor || 'Check today\'s price';

  const m = text.match(suffix);
  if (!m) return innerHtml;
  const rest = (m[1] || '').trim();
  if (!rest) return rules.retailer_only_anchor || 'Check today\'s price';
  if (/^(?:[£€$]|AED|AUD|USD|EUR|GBP|IDR|SGD|THB)\s?\d[\d,.]*\s?(?:[A-Z]{3})?$/.test(rest)) {
    return (rules.price_only_anchor || '{price}').replace('{price}', rest);
  }
  return rest;
}

/**
 * Decide the geo slug for a money link / box in a given section.
 * @returns {{ slug: string|null, product: object|null, category: string, reason: string }}
 */
function resolveSlug(ctx, section, hintText) {
  const { config, cc, postCategory } = ctx;
  const product = section && section.product ? ctx.productIndex.get(suggestProductSlug(section.product.name, config)) : null;
  const brand = product ? product.brand : detectBrand(hintText || '', config);
  const category = (product && product.category)
    || detectCategory(hintText, config)
    || detectCategory(section ? section.heading : '', config)
    || postCategory
    || 'other';

  if (product && product.slug) return { slug: product.slug, product, category, reason: 'product' };

  const rules = config.rules || {};
  if (product && rules.fallback_to_category_slug === false) {
    return { slug: product.suggested_slug, product, category, reason: 'suggested' };
  }
  const slug = categorySlugFor(category, cc, brand, config);
  return { slug, product, category, reason: slug ? 'category' : 'none' };
}

/**
 * Convert raw retailer / affiliate-network <a> tags into [geo_link] shortcodes.
 * Links inside headings become plain text.
 */
function convertLinks(html, ctx) {
  const { config } = ctx;
  const ranges = headingRanges(html);
  const sections = splitSections(html, config);
  const conversions = [];
  const headingLinks = [];
  let unresolved = 0;

  const out = html.replace(ANCHOR_RE, (full, pre, q, href, post, inner, offset) => {
    const cls = classifyHref(href, config);
    if (!cls.kind) return full;

    if (_inRanges(offset, ranges)) {
      headingLinks.push({ href: cls.destination, anchor: _stripTags(inner) });
      return inner; // never a money link inside a heading
    }

    const section = _sectionAt(offset, sections);
    const hint = `${cls.destination} ${_stripTags(inner)}`;
    const res = resolveSlug(ctx, section, hint);
    if (!res.slug) {
      unresolved++;
      conversions.push({ status: 'unresolved', from: cls.destination, anchor: _stripTags(inner), section: section.heading });
      return inner; // no slug covers this market: plain text rather than a raw link
    }

    const anchor = rewriteAnchor(inner, config);
    conversions.push({
      status: 'converted',
      network: cls.network,
      retailer_host: cls.retailer_host,
      from: cls.destination,
      anchor_before: _stripTags(inner),
      anchor_after: _stripTags(anchor),
      slug: res.slug,
      slug_reason: res.reason,
      product: res.product ? res.product.name : null,
      category: res.category,
      section: section.heading,
    });
    if (res.product) {
      res.product.destinations.add(cls.destination);
    }
    return `[geo_link slug="${res.slug}"]${anchor}[/geo_link]`;
  });

  return { html: out, conversions, headingLinks, unresolved };
}

/**
 * Market gate failed: turn every money link into plain text and remove
 * boxes + disclosure.
 */
function stripMoneyLinks(html, ctx) {
  const { config } = ctx;
  let stripped = 0;
  let out = html.replace(ANCHOR_RE, (full, pre, q, href, post, inner) => {
    const cls = classifyHref(href, config);
    if (!cls.kind) return full;
    stripped++;
    return inner;
  });
  out = out.replace(/\[geo_link\b[^\]]*\]([\s\S]*?)\[\/geo_link\]/g, (m, inner) => { stripped++; return inner; });
  out = out.replace(/\n?<!-- wp:shortcode -->\s*\[geo_box\b[^\]]*\]\s*<!-- \/wp:shortcode -->\n?/g, () => { stripped++; return '\n'; });
  out = out.replace(/\n?\[geo_box\b[^\]]*\]\n?/g, () => { stripped++; return '\n'; });
  out = out.replace(/\n?<!-- wp:paragraph \{"className":"affiliate-disclosure"\} -->\s*<p\b[^>]*class="[^"]*affiliate-disclosure[^"]*"[^>]*>[\s\S]*?<\/p>\s*<!-- \/wp:paragraph -->\n?/g, '\n');
  out = out.replace(/\n?<p\b[^>]*class="[^"]*affiliate-disclosure[^"]*"[^>]*>[\s\S]*?<\/p>\n?/g, '\n');
  return { html: out, stripped };
}

function _shortcodeAttr(s) {
  return _stripTags(_decodeEntities(s)).replace(/"/g, "'").replace(/[\[\]]/g, '').trim();
}

function _firstSentence(bodyHtml, maxChars) {
  const p = bodyHtml.match(/<p\b[^>]*>([\s\S]*?)<\/p>/i);
  if (!p) return '';
  const text = _stripTags(_decodeEntities(p[1]));
  let sentence = (text.match(/^.*?[.!?](?=\s|$)/) || [text])[0].trim();
  if (sentence.length > maxChars) {
    sentence = sentence.slice(0, maxChars).replace(/\s+\S*$/, '').trim() + '…';
  }
  return sentence;
}

/**
 * Insert at most one [geo_box] per product section, capped at
 * rules.max_boxes_per_1000_words per 1,000 words (existing boxes count).
 */
function insertBoxes(html, ctx) {
  const { config, cc } = ctx;
  const rules = config.rules || {};
  const perK = Number(rules.max_boxes_per_1000_words ?? 2);
  const words = countWords(html.replace(/\[\/?geo_[a-z]+[^\]]*\]/g, ' '));
  const cap = Math.floor((words / 1000) * perK);
  const existing = (html.match(/\[geo_box\b/g) || []).length;
  let budget = Math.max(0, cap - existing);
  const gutenberg = _isGutenberg(html);

  const sections = splitSections(html, config);
  const inserts = [];
  const boxes = [];

  for (const s of sections) {
    if (!s.product) continue;
    const body = html.slice(s.bodyStart, s.bodyEnd);
    if (/\[geo_box\b/.test(body)) continue; // already has one
    if (budget <= 0) { boxes.push({ section: s.heading, status: 'skipped_cap' }); continue; }

    const res = resolveSlug(ctx, s, s.heading);
    if (!res.slug) { boxes.push({ section: s.heading, status: 'skipped_no_slug' }); continue; }
    // Generic slugs must cover the market; product slugs are resolved per
    // country by the plugin (optionally constrained by products[slug].countries).
    const def = res.reason === 'product'
      ? ((config.products || {})[res.slug] || {})
      : ((config.geo_slugs || {})[res.slug] || {});
    const covers = !def.countries || expandCountries(def.countries, config.country_groups).has(cc);
    if (!cc || !covers) {
      boxes.push({ section: s.heading, status: 'skipped_market' });
      continue;
    }

    const title = _shortcodeAttr(s.product.name);
    const text = _shortcodeAttr(_firstSentence(body, Number(rules.box_text_max_chars || 160)));
    const button = rules.box_button ? ` button="${_shortcodeAttr(rules.box_button)}"` : '';
    const shortcode = `[geo_box slug="${res.slug}" title="${title}" text="${text}"${button}]`;
    const block = gutenberg
      ? `\n<!-- wp:shortcode -->\n${shortcode}\n<!-- /wp:shortcode -->\n`
      : `\n${shortcode}\n`;

    inserts.push({ at: _sectionInsertPoint(html, s), block });
    boxes.push({ section: s.heading, status: 'added', slug: res.slug, slug_reason: res.reason, title });
    budget--;
  }

  // Apply from the end so offsets stay valid
  let out = html;
  for (const ins of inserts.sort((a, b) => b.at - a.at)) {
    out = out.slice(0, ins.at) + ins.block + out.slice(ins.at);
  }

  return { html: out, boxes, added: inserts.length, cap, existing, words };
}

/**
 * Add the disclosure once near the top. If an untagged disclosure sentence is
 * already present, tag that paragraph instead of adding a second one.
 */
function insertDisclosure(html, ctx) {
  const { config } = ctx;
  const rules = config.rules || {};
  if (/class="[^"]*affiliate-disclosure[^"]*"/.test(html)) return { html, status: 'present' };

  const pattern = rules.existing_disclosure_pattern ? new RegExp(rules.existing_disclosure_pattern, 'i') : null;
  if (pattern) {
    let tagged = false;
    const out = html.replace(/<p\b([^>]*)>([\s\S]*?)<\/p>/gi, (full, attrs, inner) => {
      if (tagged || !pattern.test(_stripTags(inner))) return full;
      tagged = true;
      const newAttrs = /class="/.test(attrs)
        ? attrs.replace(/class="/, 'class="affiliate-disclosure ')
        : `${attrs} class="affiliate-disclosure"`;
      return `<p${newAttrs}>${inner}</p>`;
    });
    if (tagged) return { html: out, status: 'tagged_existing' };
  }

  const gutenberg = _isGutenberg(html);
  let block = rules.disclosure_html || '<p class="affiliate-disclosure"><em>This page contains affiliate links. Padeli may earn a commission at no extra cost to you.</em></p>';
  if (gutenberg) {
    block = `<!-- wp:paragraph {"className":"affiliate-disclosure"} -->\n${block.replace('class="affiliate-disclosure"', 'class="affiliate-disclosure wp-block-paragraph"')}\n<!-- /wp:paragraph -->`;
  }

  // After the direct-answer paragraph if there is one, else before the first H2, else at top
  let at = -1;
  const da = html.match(/<p\b[^>]*class="[^"]*direct-answer[^"]*"[^>]*>[\s\S]*?<\/p>(?:\s*<!-- \/wp:paragraph -->)?/i);
  if (da) {
    at = da.index + da[0].length;
  } else {
    const h2 = html.search(/<h2\b/i);
    if (h2 !== -1) {
      at = h2;
      const pre = html.slice(Math.max(0, at - 200), at);
      const m = pre.match(/<!-- wp:heading(?: \{[^}]*\})? -->\s*$/);
      if (m) at -= m[0].length;
    }
  }
  const out = at === -1
    ? `${block}\n\n${html}`
    : `${html.slice(0, at)}\n\n${block}\n\n${html.slice(at)}`;
  return { html: out, status: 'added' };
}

// ---------------------------------------------------------------------------
// Core: applyAffiliateLinks
// ---------------------------------------------------------------------------

/**
 * Run the affiliate stage on a post body.
 *
 * @param {string} html - post body HTML (Gutenberg or rendered)
 * @param {object} brief - { market, country_code, focus_keyword, category, slug }
 * @param {object} [options]
 * @param {object} [options.config] - config object (overrides config/affiliate.json)
 * @param {string} [options.configPath]
 * @returns {{ html: string, report: object }}
 */
function applyAffiliateLinks(html, brief = {}, options = {}) {
  const config = options.config || loadAffiliateConfig(options.configPath);
  const cc = normaliseMarket(brief.country_code || brief.market, config);
  const partners = partnersForMarket(cc, config);
  const postCategory = detectCategory(`${brief.focus_keyword || ''} ${brief.title || ''} ${brief.category || ''}`, config);

  const report = {
    market: cc || (brief.market ? String(brief.market) : null),
    partners_for_market: partners.map((p) => p.id),
    skipped_reason: null,
    links_converted: 0,
    links_unresolved: 0,
    links_in_headings_unlinked: 0,
    links_stripped: 0,
    boxes_added: 0,
    boxes_cap: 0,
    disclosure: 'skipped',
    geo_links_total: 0,
    geo_boxes_total: 0,
    conversions: [],
    boxes: [],
    products_detected: [],
    products_without_slug: [],
    brand_mentions: {},
    word_count: 0,
  };

  // ---- Market gate -------------------------------------------------------
  if (!cc) {
    const s = stripMoneyLinks(html, { config });
    report.skipped_reason = 'unknown_market';
    report.links_stripped = s.stripped;
    report.brand_mentions = brandMentions(s.html, config);
    report.word_count = countWords(s.html);
    return { html: s.html, report };
  }
  if (partners.length === 0) {
    const s = stripMoneyLinks(html, { config });
    report.skipped_reason = 'no_partner_for_market';
    report.links_stripped = s.stripped;
    report.brand_mentions = brandMentions(s.html, config);
    report.word_count = countWords(s.html);
    return { html: s.html, report };
  }

  // ---- Product index (headings first, then body mentions) ----------------
  const productIndex = new Map();
  for (const s of splitSections(html, config)) {
    if (!s.product) continue;
    const suggested = suggestProductSlug(s.product.name, config);
    if (productIndex.has(suggested)) continue;
    const known = findProductSlug(s.product.name, config);
    const def = known ? config.products[known] : null;
    productIndex.set(suggested, {
      name: s.product.name,
      brand: s.product.brand,
      category: (def && def.category) || detectCategory(s.heading, config) || postCategory || null,
      suggested_slug: suggested,
      slug: known,
      source: 'heading',
      section: s.heading,
      destinations: new Set(),
    });
  }
  for (const p of productsInText(html, config)) {
    if (productIndex.has(p.suggested_slug)) continue;
    const known = findProductSlug(p.name, config);
    productIndex.set(p.suggested_slug, {
      ...p,
      category: (known && config.products[known].category) || postCategory || null,
      slug: known,
      section: null,
      destinations: new Set(),
    });
  }

  const ctx = { config, cc, postCategory, productIndex };

  // ---- (b) links -> geo_link ------------------------------------------------
  let result = html;
  const conv = convertLinks(result, ctx);
  result = conv.html;
  report.conversions = conv.conversions;
  report.links_converted = conv.conversions.filter((c) => c.status === 'converted').length;
  report.links_unresolved = conv.unresolved;
  report.links_in_headings_unlinked = conv.headingLinks.length;

  // ---- (b) boxes ------------------------------------------------------------
  const boxed = insertBoxes(result, ctx);
  result = boxed.html;
  report.boxes = boxed.boxes;
  report.boxes_added = boxed.added;
  report.boxes_cap = boxed.cap;
  report.word_count = boxed.words;

  // ---- (c) disclosure -----------------------------------------------------
  report.geo_links_total = (result.match(/\[geo_link\b/g) || []).length;
  report.geo_boxes_total = (result.match(/\[geo_box\b/g) || []).length;
  if (report.geo_links_total + report.geo_boxes_total > 0) {
    const d = insertDisclosure(result, ctx);
    result = d.html;
    report.disclosure = d.status;
  }

  // ---- (e) products / brands ---------------------------------------------
  report.brand_mentions = brandMentions(result, config);
  report.products_detected = [...productIndex.values()].map((p) => ({
    name: p.name,
    brand: p.brand,
    category: p.category,
    slug: p.slug,
    suggested_slug: p.suggested_slug,
    source: p.source,
    section: p.section,
    destinations: [...p.destinations],
  }));
  report.products_without_slug = report.products_detected
    .filter((p) => !p.slug)
    .map((p) => ({ name: p.name, brand: p.brand, category: p.category, suggested_slug: p.suggested_slug, destinations: p.destinations }));

  return { html: result, report };
}

/**
 * Compact one-line-per-item summary for logs / ledgers.
 */
function formatAffiliateReport(report) {
  const lines = [];
  lines.push(`Market: ${report.market || '?'} | partners: ${report.partners_for_market.join(', ') || 'none'}`);
  if (report.skipped_reason) {
    lines.push(`SKIPPED (${report.skipped_reason}) — ${report.links_stripped} money link(s) stripped to plain text`);
    return lines.join('\n');
  }
  lines.push(`Links converted to [geo_link]: ${report.links_converted} (unresolved: ${report.links_unresolved}, in headings → text: ${report.links_in_headings_unlinked})`);
  lines.push(`Boxes added: ${report.boxes_added} (cap ${report.boxes_cap} for ${report.word_count} words) | total geo_box: ${report.geo_boxes_total}`);
  lines.push(`Disclosure: ${report.disclosure}`);
  lines.push(`Products detected: ${report.products_detected.length} | without plugin slug: ${report.products_without_slug.length}`);
  for (const p of report.products_without_slug) {
    lines.push(`  - ${p.name} → suggest "${p.suggested_slug}"${p.destinations.length ? ` (${p.destinations[0]})` : ''}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

if (require.main === module) {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--'));
  if (!file) {
    console.error('Usage: node affiliate-linker.js <post.html> [--market GB] [--out out.html] [--json]');
    process.exit(1);
  }
  const flag = (name) => { const i = args.indexOf(name); return i !== -1 ? args[i + 1] : undefined; };
  const html = fs.readFileSync(path.resolve(file), 'utf8');
  const { html: out, report } = applyAffiliateLinks(html, { market: flag('--market') || 'GB', focus_keyword: flag('--keyword') || '' });
  if (flag('--out')) fs.writeFileSync(path.resolve(flag('--out')), out, 'utf8');
  if (args.includes('--json')) console.log(JSON.stringify(report, null, 2));
  else console.log(formatAffiliateReport(report));
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  applyAffiliateLinks,
  loadAffiliateConfig,
  normaliseMarket,
  partnersForMarket,
  expandCountries,
  classifyHref,
  detectBrand,
  detectCategory,
  suggestProductSlug,
  findProductSlug,
  categorySlugFor,
  splitSections,
  productFromHeading,
  brandMentions,
  productsInText,
  rewriteAnchor,
  convertLinks,
  insertBoxes,
  insertDisclosure,
  stripMoneyLinks,
  formatAffiliateReport,
  DEFAULT_CONFIG_PATH,
};
