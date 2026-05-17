/**
 * Padeli Blog Image Sourcer
 *
 * Per-post-type image sourcing for the blog pipeline.
 * Reuses the 3-tier waterfall concept from photo-pipeline.js
 * (Google Places -> Bing Image Search -> Placeholder) but adds
 * blog-specific targeting, alt text rules, and caption generation.
 *
 * Node.js v24+ -- zero external dependencies -- CommonJS
 *
 * Env vars:
 *   GOOGLE_PLACES_API_KEY  -- for Tier 1
 *   PADELI_WP_USER         -- WP username
 *   PADELI_WP_APP_PASSWORD -- WP app password
 */

const fs = require('fs');
const path = require('path');
const { SITE_URL, wpGet, wpPost } = require('./wp-client');
const { POST_TYPES, IMAGE_COUNT_TARGETS, BANNED_PHRASES } = require('./config');
const { slugify, delay } = require('./utils');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DATA_DIR = path.join(__dirname, '..', 'data');
const BLOG_IMAGES_DIR = path.join(DATA_DIR, 'blog-images');
const GAPS_LOG = path.join(DATA_DIR, 'blog-image-gaps.json');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const IMAGE_FILTERS = {
  excluded_url_words: ['tennis', 'squash', 'pickleball', 'gym', 'basketball', 'football', 'cricket'],
  excluded_filenames: ['logo', 'icon', 'banner', 'ad-', 'sponsor', 'schedule', 'price-list', 'menu'],
  min_width: 800,
  preferred_format: ['webp', 'jpg', 'jpeg', 'png'],
  max_file_size_mb: 5,
};

/**
 * Combined reject patterns for URL/filename filtering.
 * Merges IMAGE_FILTERS with photo-pipeline's REJECT_FILENAME_PATTERNS.
 */
const REJECT_PATTERNS = [
  ...IMAGE_FILTERS.excluded_url_words,
  ...IMAGE_FILTERS.excluded_filenames,
  'logo', 'lgd', 'wordmark', 'placeholder', 'dummy', 'default',
  'sample', 'app-store', 'screenshot', 'badge', 'qr-code', 'qrcode',
  'leaflet', 'brochure', 'render', 'mockup', 'headshot', 'staff',
  'owner', 'founder', 'favicon', 'emoji', 'sprite', 'spinner',
  'avatar', 'site-icon', 'share-image', 'fb-og', 'opengraph',
  'stockphoto', 'stock-photo', 'shutterstock', 'getty-image',
  'istock', 'adobe-stock', 'freepik', 'pexels', 'unsplash',
  'dreamstime', 'alamy', 'depositphotos', '123rf', 'vecteezy',
];

// Product image retailer domains for product listicle sourcing
const PRODUCT_RETAILER_DOMAINS = [
  'padelnuestro.com',
  'decathlon.co.uk',
  'decathlon.com',
  'pdhsports.com',
  'padelmania.com',
  'amazon.com',
  'amazon.co.uk',
];

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

function getGoogleKey() {
  const key = process.env.GOOGLE_PLACES_API_KEY;
  if (!key) throw new Error('Missing GOOGLE_PLACES_API_KEY env var');
  return key.replace(/^['"]|['"]$/g, '');
}

function getWPAuth() {
  const user = process.env.PADELI_WP_USER;
  const pass = process.env.PADELI_WP_APP_PASSWORD;
  if (!user || !pass) throw new Error('Missing PADELI_WP_USER or PADELI_WP_APP_PASSWORD');
  return Buffer.from(`${user}:${pass}`).toString('base64');
}

// ---------------------------------------------------------------------------
// Tier 1: Google Places Photos API
// ---------------------------------------------------------------------------

/**
 * Fetch a photo URL from Google Places for a given place_id.
 *
 * @param {string} placeId - Google Places place_id
 * @param {number} [maxWidth=1920] - Maximum image width
 * @returns {Promise<string|null>} Photo URL or null
 */
async function fetchGooglePlacesPhoto(placeId, maxWidth = 1920) {
  if (!placeId) return null;

  const key = getGoogleKey();

  try {
    // Fetch place details including photos
    const detailsUrl = `https://places.googleapis.com/v1/places/${placeId}`;
    const res = await fetch(detailsUrl, {
      method: 'GET',
      headers: {
        'X-Goog-Api-Key': key,
        'X-Goog-FieldMask': 'photos',
        'Referer': 'https://padeli.com/',
      },
    });

    if (!res.ok) return null;

    const data = await res.json();
    const photoRefs = data.photos || [];
    if (!photoRefs.length) return null;

    // Return the first photo URL
    const photoName = photoRefs[0].name;
    return `https://places.googleapis.com/v1/${photoName}/media?maxWidthPx=${maxWidth}&key=${key}`;
  } catch {
    return null;
  }
}

/**
 * Search Google Places by venue name and return photo URL.
 *
 * @param {string} venueName - Name of the venue
 * @param {string} [location] - City/address hint
 * @param {number} [maxWidth=1920] - Maximum image width
 * @returns {Promise<{url: string|null, placeId: string|null}>}
 */
async function searchGooglePlacesPhoto(venueName, location = '', maxWidth = 1920) {
  const key = getGoogleKey();
  const query = location ? `${venueName} ${location}` : venueName;

  try {
    const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': key,
        'X-Goog-FieldMask': 'places.id,places.displayName,places.photos',
        'Referer': 'https://padeli.com/',
        'Origin': 'https://padeli.com',
      },
      body: JSON.stringify({ textQuery: query, pageSize: 3 }),
    });

    if (!res.ok) return { url: null, placeId: null };

    const data = await res.json();
    const places = data.places || [];
    if (!places.length) return { url: null, placeId: null };

    const place = places[0];
    const placeId = place.id;
    const photoRefs = place.photos || [];
    if (!photoRefs.length) return { url: null, placeId };

    const photoName = photoRefs[0].name;
    const url = `https://places.googleapis.com/v1/${photoName}/media?maxWidthPx=${maxWidth}&key=${key}`;
    return { url, placeId };
  } catch {
    return { url: null, placeId: null };
  }
}

// ---------------------------------------------------------------------------
// Tier 2: Bing Image Search
// ---------------------------------------------------------------------------

/**
 * Search Bing Images and return the best matching URL.
 *
 * @param {string} query - Search query
 * @param {object} [filters] - Additional filtering options
 * @param {string[]} [filters.domainWhitelist] - Prefer URLs from these domains
 * @param {string[]} [filters.excludeWords] - Reject URLs containing these words
 * @returns {Promise<string|null>} Best image URL or null
 */
async function fetchBingImage(query, filters = {}) {
  const { domainWhitelist = [], excludeWords = [] } = filters;
  const allExclusions = [...REJECT_PATTERNS, ...excludeWords];

  const searchUrl = `https://www.bing.com/images/search?q=${encodeURIComponent(query)}&form=HDRSC2&first=1`;

  let html;
  try {
    const res = await fetch(searchUrl, {
      headers: {
        'User-Agent': UA,
        'Accept-Language': 'en-GB,en;q=0.9',
      },
    });
    if (!res.ok) return null;
    html = await res.text();
  } catch {
    return null;
  }

  // Extract image URLs from Bing's murl field
  const murlMatches = html.match(/"murl":"(https?:\/\/[^"]+)"/g) || [];
  const candidates = [];
  const seen = new Set();

  for (const m of murlMatches) {
    const match = m.match(/"murl":"(https?:\/\/[^"]+)"/);
    if (!match) continue;
    const url = match[1].replace(/\\u0026/g, '&').replace(/\\\//g, '/');
    if (seen.has(url)) continue;
    seen.add(url);

    const lower = url.toLowerCase();

    // Reject filtered patterns
    if (allExclusions.some(p => lower.includes(p))) continue;

    // Check extension
    const extMatch = lower.split('?')[0].split('#')[0].match(/\.(\w+)$/);
    const ext = extMatch ? extMatch[1] : '';
    if (!IMAGE_FILTERS.preferred_format.includes(ext)) continue;

    // Score: domain whitelist match gets priority
    const domainMatch = domainWhitelist.length
      ? domainWhitelist.some(d => lower.includes(d))
      : false;

    candidates.push({ url, domainMatch });
    if (candidates.length >= 20) break;
  }

  if (!candidates.length) return null;

  // Prefer whitelisted domain matches
  const preferred = candidates.find(c => c.domainMatch);
  const best = preferred || candidates[0];

  // Validate the image is fetchable and meets size requirements
  try {
    const res = await fetch(best.url, {
      method: 'HEAD',
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      // Try next candidate
      for (const c of candidates) {
        if (c.url === best.url) continue;
        try {
          const r = await fetch(c.url, {
            method: 'HEAD',
            headers: { 'User-Agent': UA },
            signal: AbortSignal.timeout(5000),
          });
          if (r.ok) return c.url;
        } catch { /* skip */ }
      }
      return null;
    }
    return best.url;
  } catch {
    return candidates.length > 1 ? candidates[1].url : null;
  }
}

// ---------------------------------------------------------------------------
// Tier 3: Placeholder
// ---------------------------------------------------------------------------

/**
 * Generate a placeholder reference for images that could not be sourced.
 *
 * @param {string} context - Description of what the image should show
 * @returns {object} Placeholder result
 */
function generatePlaceholder(context) {
  return {
    url: null,
    source_tier: 3,
    placeholder: true,
    message: `Padeli placeholder: ${context || 'photo coming soon'}`,
    filename: null,
  };
}

// ---------------------------------------------------------------------------
// 3-Tier Waterfall: Venue Image
// ---------------------------------------------------------------------------

/**
 * Source an image for a venue using the 3-tier waterfall.
 *
 * @param {string} venueName - Name of the venue
 * @param {string} [placeId] - Google Places ID (skips search if provided)
 * @param {object} [options]
 * @param {string} [options.city] - City name for search context
 * @param {string} [options.website] - Venue website domain for Bing filtering
 * @returns {Promise<{url: string|null, source_tier: number, filename: string|null, placeholder?: boolean}>}
 */
async function sourceVenueImage(venueName, placeId, options = {}) {
  const { city = '', website = '' } = options;

  // Tier 1: Google Places
  let url = null;

  if (placeId) {
    url = await fetchGooglePlacesPhoto(placeId);
  }
  if (!url) {
    const result = await searchGooglePlacesPhoto(venueName, city);
    url = result.url;
  }

  if (url) {
    const slug = slugify(venueName);
    return {
      url,
      source_tier: 1,
      filename: `${slug}-padel-courts.jpg`,
    };
  }

  // Tier 2: Bing Image Search
  const bingQueries = [
    website ? `"${venueName}" padel court site:${website}` : null,
    `"${venueName}" padel courts ${city}`,
    `"${venueName}" padel`,
  ].filter(Boolean);

  for (const query of bingQueries) {
    url = await fetchBingImage(query, {
      domainWhitelist: website ? [website] : [],
    });
    if (url) {
      const slug = slugify(venueName);
      const ext = extractExtension(url);
      return {
        url,
        source_tier: 2,
        filename: `${slug}-padel-courts.${ext}`,
      };
    }
  }

  // Tier 3: Placeholder
  return {
    ...generatePlaceholder(`${venueName} venue photo coming soon`),
    filename: `${slugify(venueName)}-placeholder.jpg`,
  };
}

// ---------------------------------------------------------------------------
// 3-Tier Waterfall: Product Image
// ---------------------------------------------------------------------------

/**
 * Source an image for a product using a modified waterfall.
 * Tier 1: Manufacturer website / official brand image (via Bing)
 * Tier 2: Retailer image (Padel Nuestro, Decathlon, PDH Sports)
 * Tier 3: Placeholder
 *
 * @param {string} productName - Full product name
 * @param {string} [brand] - Brand name for search targeting
 * @param {object} [options]
 * @param {string} [options.manufacturerDomain] - Manufacturer website domain
 * @returns {Promise<{url: string|null, source_tier: number, filename: string|null, placeholder?: boolean}>}
 */
async function sourceProductImage(productName, brand, options = {}) {
  const { manufacturerDomain = '' } = options;
  let url = null;

  // Tier 1: Manufacturer / official brand image
  if (manufacturerDomain) {
    url = await fetchBingImage(`"${productName}" site:${manufacturerDomain}`, {
      domainWhitelist: [manufacturerDomain],
      excludeWords: IMAGE_FILTERS.excluded_filenames,
    });
  }
  if (!url && brand) {
    url = await fetchBingImage(`"${productName}" ${brand} official product`, {
      excludeWords: IMAGE_FILTERS.excluded_filenames,
    });
  }

  if (url) {
    const slug = slugify(productName);
    const ext = extractExtension(url);
    return {
      url,
      source_tier: 1,
      filename: `${slug}.${ext}`,
    };
  }

  // Tier 2: Retailer image
  for (const retailer of PRODUCT_RETAILER_DOMAINS) {
    url = await fetchBingImage(`"${productName}" site:${retailer}`, {
      domainWhitelist: [retailer],
    });
    if (url) {
      const slug = slugify(productName);
      const ext = extractExtension(url);
      return {
        url,
        source_tier: 2,
        filename: `${slug}.${ext}`,
      };
    }
  }

  // Tier 3: Placeholder
  return {
    ...generatePlaceholder(`${productName} product photo coming soon`),
    filename: `${slugify(productName)}-placeholder.jpg`,
  };
}

// ---------------------------------------------------------------------------
// Alt Text Generation
// ---------------------------------------------------------------------------

/**
 * Generate SEO-compliant alt text for a blog image.
 *
 * Rules:
 * - Format: "[Visual description] - [post-relevant claim]"
 * - 60-160 chars
 * - No banned words
 * - No post title repetition
 * - No generic descriptions
 * - No location mismatch
 * - No wrong sport in filename
 *
 * @param {object} imageContext - { venue_name, product_name, description }
 * @param {object} postContext - { title, city, country, focus_keyword }
 * @returns {string} Generated alt text
 */
function generateAltText(imageContext, postContext) {
  const { venue_name, product_name, description } = imageContext || {};
  const { title, city, country, focus_keyword } = postContext || {};

  let visual = '';
  let claim = '';

  if (venue_name) {
    visual = description || `Indoor padel courts at ${venue_name}`;
    claim = city
      ? `one of the top padel venues in ${city}`
      : `a leading padel venue`;
  } else if (product_name) {
    visual = description || `${product_name} padel equipment`;
    claim = 'reviewed and compared for performance';
  } else {
    visual = description || 'Padel court in action';
    claim = focus_keyword
      ? `supporting ${focus_keyword}`
      : 'padel facilities and courts';
  }

  let alt = `${visual} - ${claim}`;

  // Validate and adjust
  alt = validateAltText(alt, postContext);

  return alt;
}

/**
 * Validate and sanitise alt text against the rules.
 *
 * @param {string} alt - Draft alt text
 * @param {object} postContext - { title, city, country }
 * @returns {string} Validated alt text (trimmed/adjusted if needed)
 */
function validateAltText(alt, postContext) {
  const { title, city, country } = postContext || {};

  // Strip banned phrases
  let result = alt;
  for (const phrase of BANNED_PHRASES) {
    const regex = new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    result = result.replace(regex, '').replace(/ {2,}/g, ' ').trim();
  }

  // No exact title repetition
  if (title && result.toLowerCase() === title.toLowerCase()) {
    result = result + ` in ${city || country || 'this location'}`;
  }

  // Reject generic descriptions
  const genericPatterns = ['padel court', 'padel match', 'padel game'];
  if (genericPatterns.some(g => result.toLowerCase().trim() === g)) {
    result = result + ` - ${city || country || 'venue'} facilities`;
  }

  // Enforce length: 60-160 chars
  if (result.length < 60) {
    // Pad with context
    const padding = city ? ` located in ${city}` : country ? ` in ${country}` : ' featuring modern facilities';
    result = result + padding;
  }
  if (result.length > 160) {
    // Truncate at last word boundary before 160
    result = result.substring(0, 157).replace(/\s+\S*$/, '') + '...';
  }

  // Final length guard
  if (result.length < 60) {
    result = result.padEnd(60, ' ').trimEnd();
  }

  return result.trim();
}

// ---------------------------------------------------------------------------
// Caption Generation
// ---------------------------------------------------------------------------

/**
 * Generate a caption for a blog image.
 *
 * Rules:
 * - Ties to post's central claim
 * - Contains one specific data point
 * - Reinforces DA paragraph point
 *
 * @param {object} imageContext - { venue_name, product_name, description, data_point }
 * @param {object} postContext - { title, city, country, focus_keyword, central_claim }
 * @returns {string} Caption string
 */
function generateCaption(imageContext, postContext) {
  const { venue_name, product_name, data_point } = imageContext || {};
  const { city, country, central_claim, focus_keyword } = postContext || {};

  const dataStr = data_point || '';

  if (venue_name) {
    const location = city || country || '';
    if (dataStr) {
      return `${venue_name}${location ? ` in ${location}` : ''} - ${dataStr}.`;
    }
    return `${venue_name}${location ? `, ${location}` : ''} - a top-rated padel venue.`;
  }

  if (product_name) {
    if (dataStr) {
      return `${product_name} - ${dataStr}.`;
    }
    return `${product_name} - ${focus_keyword ? `reviewed for ${focus_keyword}` : 'product comparison'}.`;
  }

  // Generic fallback
  if (dataStr) {
    return `${dataStr}.`;
  }
  return central_claim || `Padel ${focus_keyword || 'facilities'} overview.`;
}

// ---------------------------------------------------------------------------
// Filename Validation
// ---------------------------------------------------------------------------

/**
 * Validate an image filename against blog rules.
 *
 * @param {string} filename - Image filename to validate
 * @param {object} postContext - { title, city, country, post_type }
 * @returns {{ valid: boolean, issues: string[] }}
 */
function validateImageFilename(filename, postContext) {
  const issues = [];
  const lower = (filename || '').toLowerCase();
  const { city, country } = postContext || {};

  // Check for wrong sport in filename
  const wrongSports = ['tennis', 'squash', 'pickleball', 'badminton', 'cricket'];
  for (const sport of wrongSports) {
    if (lower.includes(sport)) {
      issues.push(`Filename contains wrong sport: "${sport}"`);
    }
  }

  // Check for rejected patterns
  for (const pattern of IMAGE_FILTERS.excluded_filenames) {
    if (lower.includes(pattern)) {
      issues.push(`Filename contains rejected pattern: "${pattern}"`);
    }
  }

  // Check for location mismatch (if city provided, filename mentions different city)
  // This is a basic heuristic -- only flags obvious mismatches
  if (city) {
    const commonCities = [
      'london', 'manchester', 'birmingham', 'leeds', 'glasgow', 'edinburgh',
      'dublin', 'paris', 'madrid', 'barcelona', 'berlin', 'amsterdam',
      'dubai', 'bali', 'singapore', 'sydney', 'melbourne', 'new-york',
    ];
    const citySlug = slugify(city);
    for (const c of commonCities) {
      if (c !== citySlug && lower.includes(c)) {
        issues.push(`Filename mentions "${c}" but post is for "${city}"`);
      }
    }
  }

  // Check extension
  const extMatch = lower.match(/\.(\w+)$/);
  const ext = extMatch ? extMatch[1] : '';
  if (ext && !IMAGE_FILTERS.preferred_format.includes(ext)) {
    issues.push(`Unsupported format: ".${ext}" (prefer ${IMAGE_FILTERS.preferred_format.join(', ')})`);
  }

  return { valid: issues.length === 0, issues };
}

// ---------------------------------------------------------------------------
// Image Count Targets
// ---------------------------------------------------------------------------

/**
 * Get the [min, max] image count target for a post type.
 *
 * @param {string} postType - One of POST_TYPES values
 * @returns {[number, number]} [min, max]
 */
function getImageCountTarget(postType) {
  return IMAGE_COUNT_TARGETS[postType] || [2, 3];
}

// ---------------------------------------------------------------------------
// Image Plan Builder
// ---------------------------------------------------------------------------

/**
 * Build a per-section image plan from an outline and research report.
 *
 * @param {object[]} outline - Array of sections: { heading, type, venue_name?, place_id?, product_name?, brand? }
 * @param {object} researchReport - Research data: { venues?, products?, regions? }
 * @param {string} postType - One of POST_TYPES values
 * @returns {object[]} Per-section image targets
 */
function buildImagePlan(outline, researchReport, postType) {
  const [minImages, maxImages] = getImageCountTarget(postType);
  const sections = outline || [];
  const plan = [];

  if (postType === POST_TYPES.CITY_LISTICLE) {
    // Featured: real photo of #1 ranked venue
    // In-body: 1 per ranked venue (aim for all), minimum 1 per top-3
    let venueIndex = 0;
    for (const section of sections) {
      if (section.venue_name) {
        venueIndex++;
        const isTop3 = venueIndex <= 3;
        plan.push({
          section: section.heading,
          source_hint: 'venue photo',
          image_type: venueIndex === 1 ? 'featured' : 'venue_exterior',
          venue_name: section.venue_name,
          place_id: section.place_id || null,
          priority: isTop3 ? 'required' : 'recommended',
          featured: venueIndex === 1,
        });
      } else if (section.heading && /honourable|mention|runner/i.test(section.heading)) {
        plan.push({
          section: section.heading,
          source_hint: 'summary/generic',
          image_type: 'court_action',
          venue_name: null,
          place_id: null,
          priority: 'optional',
          featured: false,
        });
      }
    }
  } else if (postType === POST_TYPES.PRODUCT_LISTICLE) {
    // 1 per ranked product
    let productIndex = 0;
    for (const section of sections) {
      if (section.product_name) {
        productIndex++;
        plan.push({
          section: section.heading,
          source_hint: 'product photo',
          image_type: productIndex === 1 ? 'featured' : 'comparison',
          product_name: section.product_name,
          brand: section.brand || null,
          priority: 'required',
          featured: productIndex === 1,
        });
      }
    }
  } else if (postType === POST_TYPES.PILLAR) {
    // Featured: best venue, in-body: 1 per major region/section
    let isFirst = true;
    for (const section of sections) {
      if (section.venue_name || section.region) {
        plan.push({
          section: section.heading,
          source_hint: section.venue_name ? 'venue photo' : 'region representative',
          image_type: isFirst ? 'featured' : (section.venue_name ? 'venue_exterior' : 'court_action'),
          venue_name: section.venue_name || null,
          place_id: section.place_id || null,
          region: section.region || null,
          priority: isFirst ? 'required' : 'recommended',
          featured: isFirst,
        });
        isFirst = false;
      }
    }
    // Ensure we have at least minImages entries
    if (plan.length < minImages) {
      for (const section of sections) {
        if (plan.length >= minImages) break;
        if (!plan.some(p => p.section === section.heading)) {
          plan.push({
            section: section.heading,
            source_hint: 'supporting visual',
            image_type: 'court_action',
            venue_name: null,
            place_id: null,
            priority: 'optional',
            featured: false,
          });
        }
      }
    }
  } else if (postType === POST_TYPES.CLUSTER) {
    // Featured + 4-7 supporting
    let count = 0;
    for (const section of sections) {
      if (count >= maxImages) break;
      plan.push({
        section: section.heading,
        source_hint: section.venue_name ? 'venue photo' : 'action shot',
        image_type: section.venue_name ? 'venue_exterior' : (count === 0 ? 'featured' : 'court_action'),
        venue_name: section.venue_name || null,
        place_id: section.place_id || null,
        priority: count === 0 ? 'required' : 'recommended',
        featured: count === 0,
      });
      count++;
    }
    // Ensure we meet minImages even if sections are sparse
    if (plan.length < minImages) {
      for (const section of sections) {
        if (plan.length >= minImages) break;
        if (!plan.some(p => p.section === section.heading)) {
          plan.push({
            section: section.heading,
            source_hint: 'supporting visual',
            image_type: 'court_action',
            venue_name: null,
            place_id: null,
            priority: 'optional',
            featured: false,
          });
        }
      }
    }
  } else {
    // Leaf: featured + 2-3
    let count = 0;
    for (const section of sections) {
      if (count >= maxImages) break;
      plan.push({
        section: section.heading,
        source_hint: section.venue_name ? 'venue photo' : 'topic visual',
        image_type: count === 0 ? 'featured' : (section.venue_name ? 'venue_exterior' : 'court_action'),
        venue_name: section.venue_name || null,
        place_id: section.place_id || null,
        priority: count === 0 ? 'required' : 'optional',
        featured: count === 0,
      });
      count++;
    }
  }

  // Venue-per-image rule: if the outline mentions multiple venues,
  // ensure at least 1 image per venue + 1 featured image
  const venuesInOutline = sections.filter(s => s.venue_name).map(s => s.venue_name);
  const uniqueVenues = [...new Set(venuesInOutline)];
  if (uniqueVenues.length >= 2) {
    const venueTarget = uniqueVenues.length + 1; // 1 per venue + 1 featured
    // Add missing venue images if plan is below target
    for (const venue of uniqueVenues) {
      if (plan.length >= venueTarget) break;
      if (!plan.some(p => p.venue_name === venue)) {
        const section = sections.find(s => s.venue_name === venue);
        plan.push({
          section: section ? section.heading : venue,
          source_hint: 'venue photo',
          image_type: 'venue_exterior',
          venue_name: venue,
          place_id: (section && section.place_id) || null,
          priority: 'recommended',
          featured: false,
        });
      }
    }
  }

  // For pricing/cost posts, add pricing_table image type if not present
  const isPricingPost = sections.some(s =>
    /price|cost|fee|how much/i.test(s.heading || '')
  );
  if (isPricingPost && !plan.some(p => p.image_type === 'pricing_table')) {
    const pricingSection = sections.find(s => /price|cost|fee|comparison|at a glance/i.test(s.heading || ''));
    if (pricingSection && plan.length < maxImages) {
      plan.push({
        section: pricingSection.heading,
        source_hint: 'pricing graphic',
        image_type: 'pricing_table',
        venue_name: null,
        place_id: null,
        priority: 'recommended',
        featured: false,
      });
    }
  }

  // Cap at maxImages (but allow venue-per-image rule to push above old max)
  const effectiveMax = Math.max(maxImages, uniqueVenues.length + 1);
  return plan.slice(0, effectiveMax);
}

// ---------------------------------------------------------------------------
// Image Gap Checker
// ---------------------------------------------------------------------------

/**
 * Check a post for image coverage gaps.
 *
 * @param {object} postData - { post_type, sections, images }
 * @returns {{ gaps: object[], coverage: number }}
 */
function checkImageGaps(postData) {
  const { post_type, sections = [], images = [] } = postData || {};
  const [minImages] = getImageCountTarget(post_type);

  const gaps = [];
  const imagedSections = new Set(images.map(img => img.section).filter(Boolean));

  // Check each section for image coverage
  for (const section of sections) {
    if (section.venue_name || section.product_name) {
      if (!imagedSections.has(section.heading)) {
        gaps.push({
          section: section.heading,
          type: section.venue_name ? 'venue' : 'product',
          name: section.venue_name || section.product_name,
          severity: 'missing',
        });
      }
    }
  }

  // Check total count
  if (images.length < minImages) {
    gaps.push({
      section: '_total',
      type: 'count',
      severity: 'below_minimum',
      have: images.length,
      need: minImages,
    });
  }

  // Check for placeholder-only featured
  const featured = images.find(img => img.featured);
  if (featured && featured.placeholder) {
    gaps.push({
      section: '_featured',
      type: 'placeholder_featured',
      severity: 'critical',
      message: 'Featured image is a placeholder',
    });
  }

  const totalSectionsNeedingImages = sections.filter(
    s => s.venue_name || s.product_name
  ).length;
  const coverage = totalSectionsNeedingImages > 0
    ? Math.round((imagedSections.size / totalSectionsNeedingImages) * 100)
    : images.length > 0 ? 100 : 0;

  return { gaps, coverage };
}

// ---------------------------------------------------------------------------
// WP Media Upload
// ---------------------------------------------------------------------------

/**
 * Upload a blog image to WordPress media library.
 *
 * @param {string} imageUrl - Source URL of the image
 * @param {string} filename - Target filename for WP
 * @param {string} altText - Alt text
 * @param {string} caption - Caption text
 * @param {object} [options]
 * @returns {Promise<{mediaId: number|null, wpUrl: string|null}>}
 */
async function uploadBlogImage(imageUrl, filename, altText, caption) {
  if (!imageUrl) {
    return { mediaId: null, wpUrl: null, error: 'no_source_url' };
  }

  // Fetch image data
  let buffer;
  let contentType = 'image/jpeg';
  try {
    const res = await fetch(imageUrl, {
      headers: {
        'User-Agent': UA,
        'Referer': imageUrl.includes('googleapis.com') ? `${SITE_URL}/` : new URL(imageUrl).origin + '/',
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
    buffer = Buffer.from(await res.arrayBuffer());
    contentType = res.headers.get('content-type') || contentType;
  } catch (err) {
    return { mediaId: null, wpUrl: null, error: `fetch_failed: ${err.message}` };
  }

  // Check file size
  const sizeMb = buffer.length / (1024 * 1024);
  if (sizeMb > IMAGE_FILTERS.max_file_size_mb) {
    return { mediaId: null, wpUrl: null, error: `file_too_large: ${sizeMb.toFixed(1)}MB` };
  }

  // Upload to WP
  const auth = getWPAuth();

  try {
    const uploadRes = await fetch(`${SITE_URL}/wp-json/wp/v2/media`, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': contentType,
        'Content-Disposition': `attachment; filename="${filename}"`,
        'User-Agent': 'Mozilla/5.0 (PadeliBlogImageSourcer)',
      },
      body: buffer,
    });

    if (!uploadRes.ok) {
      const errText = await uploadRes.text();
      throw new Error(`Upload failed ${uploadRes.status}: ${errText.substring(0, 200)}`);
    }

    const mediaData = await uploadRes.json();
    const mediaId = mediaData.id;

    // Set alt text and caption on the media item
    await fetch(`${SITE_URL}/wp-json/wp/v2/media/${mediaId}`, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (PadeliBlogImageSourcer)',
      },
      body: JSON.stringify({
        alt_text: altText,
        caption: { raw: caption },
        title: { raw: altText },
      }),
    });

    console.log(`  Uploaded: ${filename} -> media ID ${mediaId}`);
    return { mediaId, wpUrl: mediaData.source_url || '' };
  } catch (err) {
    return { mediaId: null, wpUrl: null, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Set Featured Image
// ---------------------------------------------------------------------------

/**
 * Set a post's featured image (thumbnail).
 *
 * @param {number} postId - WP post ID
 * @param {number} mediaId - Media attachment ID
 * @returns {Promise<boolean>} Success
 */
async function setFeaturedImage(postId, mediaId) {
  if (!postId || !mediaId) return false;

  try {
    await wpPost(`/wp-json/wp/v2/posts/${postId}`, {
      featured_media: mediaId,
    });
    console.log(`  Set featured image: post ${postId} -> media ${mediaId}`);
    return true;
  } catch (err) {
    console.error(`  Failed to set featured image: ${err.message}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Main Orchestrator: sourceBlogImages
// ---------------------------------------------------------------------------

/**
 * Source all images for a blog post based on its type and outline.
 *
 * @param {object} postData
 * @param {string} postData.post_type - One of POST_TYPES values
 * @param {string} postData.title - Post title
 * @param {string} [postData.city] - City name
 * @param {string} [postData.country] - Country name
 * @param {string} [postData.focus_keyword] - Focus keyword
 * @param {string} [postData.central_claim] - Central claim of the post
 * @param {object[]} postData.outline - Sections with venue_name/product_name/heading
 * @param {object} [postData.research] - Research report data
 * @param {number} [postData.postId] - WP post ID (for setting featured image)
 * @param {object} [options]
 * @param {number} [options.delayMs=1000] - Delay between API calls
 * @returns {Promise<{images: object[], featured: object|null, gaps: object[], report: object}>}
 */
async function sourceBlogImages(postData, options = {}) {
  const { delayMs = 1000 } = options;
  const {
    post_type,
    title,
    city,
    country,
    focus_keyword,
    central_claim,
    outline = [],
    research = {},
    postId,
  } = postData;

  const postContext = { title, city, country, focus_keyword, central_claim };

  console.log(`\nBlog Image Sourcer: ${title}`);
  console.log(`  Post type: ${post_type}`);
  console.log('  Mode: LIVE');

  // 1. Build image plan
  const plan = buildImagePlan(outline, research, post_type);
  console.log(`  Image plan: ${plan.length} targets`);

  // 2. Source each image via the waterfall
  const images = [];
  let featuredResult = null;

  for (let i = 0; i < plan.length; i++) {
    const target = plan[i];
    console.log(`  [${i + 1}/${plan.length}] ${target.section}`);

    let imageResult;

    if (target.product_name) {
      // Product image sourcing
      imageResult = await sourceProductImage(
        target.product_name,
        target.brand,
        { manufacturerDomain: '' }
      );
    } else if (target.venue_name) {
      // Venue image sourcing
      imageResult = await sourceVenueImage(
        target.venue_name,
        target.place_id,
        { city, website: '' }
      );
    } else {
      // Generic / action shot -- try Bing with post context
      const query = `padel ${target.source_hint} ${city || country || ''}`.trim();
      const url = await fetchBingImage(query);
      if (url) {
        const slug = slugify(target.section || 'padel');
        const ext = extractExtension(url);
        imageResult = { url, source_tier: 2, filename: `${slug}.${ext}` };
      } else {
        imageResult = generatePlaceholder(target.source_hint);
      }
    }

    // Generate alt text and caption
    const imageContext = {
      venue_name: target.venue_name || null,
      product_name: target.product_name || null,
      description: null,
      data_point: null,
    };

    const altText = generateAltText(imageContext, postContext);
    const caption = generateCaption(imageContext, postContext);

    // Validate filename
    const filenameCheck = validateImageFilename(imageResult.filename, postContext);
    if (!filenameCheck.valid) {
      console.log(`    Filename issues: ${filenameCheck.issues.join('; ')}`);
      // Auto-fix: regenerate filename from context
      const safeName = target.venue_name || target.product_name || target.section || 'padel-image';
      const ext = extractExtension(imageResult.url || '') || 'jpg';
      imageResult.filename = `${slugify(safeName)}-${slugify(city || '')}-padel.${ext}`.replace(/--+/g, '-');
    }

    // Upload
    const uploadResult = await uploadBlogImage(
      imageResult.url,
      imageResult.filename,
      altText,
      caption
    );

    const imageEntry = {
      section: target.section,
      url: imageResult.url,
      source_tier: imageResult.source_tier,
      filename: imageResult.filename,
      alt_text: altText,
      caption,
      placeholder: imageResult.placeholder || false,
      featured: target.featured || false,
      mediaId: uploadResult.mediaId,
      wpUrl: uploadResult.wpUrl,
      priority: target.priority,
    };

    images.push(imageEntry);

    if (target.featured) {
      featuredResult = imageEntry;
    }

    // Rate limiting between API calls
    if (i < plan.length - 1) {
      await delay(delayMs);
    }
  }

  // 3. Set featured image on the WP post
  if (postId && featuredResult && featuredResult.mediaId) {
    await setFeaturedImage(postId, featuredResult.mediaId);
  }

  // 4. Check gaps
  const gapCheck = checkImageGaps({
    post_type,
    sections: outline,
    images,
  });

  // 5. Log gaps
  if (gapCheck.gaps.length) {
    logGaps(title, gapCheck.gaps);
  }

  // 6. Build report
  const report = {
    title,
    post_type,
    total_images: images.length,
    tier_breakdown: {
      tier_1: images.filter(i => i.source_tier === 1).length,
      tier_2: images.filter(i => i.source_tier === 2).length,
      tier_3: images.filter(i => i.source_tier === 3 || i.placeholder).length,
    },
    coverage: gapCheck.coverage,
    gaps_count: gapCheck.gaps.length,
    featured_set: !!featuredResult && !featuredResult.placeholder,
  };

  console.log(`  Result: ${report.total_images} images (T1:${report.tier_breakdown.tier_1} T2:${report.tier_breakdown.tier_2} T3:${report.tier_breakdown.tier_3})`);
  console.log(`  Coverage: ${report.coverage}% | Gaps: ${report.gaps_count}`);

  return { images, featured: featuredResult, gaps: gapCheck.gaps, report };
}

// ---------------------------------------------------------------------------
// Utility Helpers
// ---------------------------------------------------------------------------

/**
 * Extract file extension from a URL.
 *
 * @param {string} url
 * @returns {string} Extension without dot (default: 'jpg')
 */
function extractExtension(url) {
  if (!url) return 'jpg';
  const clean = url.split('?')[0].split('#')[0];
  const match = clean.match(/\.(\w+)$/);
  const ext = match ? match[1].toLowerCase() : 'jpg';
  return IMAGE_FILTERS.preferred_format.includes(ext) ? ext : 'jpg';
}

/**
 * Append image gaps to the audit carry-over log.
 *
 * @param {string} postTitle
 * @param {object[]} gaps
 */
function logGaps(postTitle, gaps) {
  let existing = [];
  try {
    if (fs.existsSync(GAPS_LOG)) {
      existing = JSON.parse(fs.readFileSync(GAPS_LOG, 'utf8'));
    }
  } catch { /* start fresh */ }

  existing.push({
    post: postTitle,
    timestamp: new Date().toISOString(),
    gaps,
  });

  fs.mkdirSync(path.dirname(GAPS_LOG), { recursive: true });
  fs.writeFileSync(GAPS_LOG, JSON.stringify(existing, null, 2));
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

if (require.main === module) {
  const [,, command, ...args] = process.argv;

  const commands = {
    async venue() {
      const name = args[0];
      const placeId = args[1] || null;
      const city = args[2] || '';
      if (!name) { console.log('Usage: node blog-image-sourcer.js venue "Venue Name" [placeId] [city]'); process.exit(1); }
      const result = await sourceVenueImage(name, placeId, { city });
      console.log(JSON.stringify(result, null, 2));
    },

    async product() {
      const name = args[0];
      const brand = args[1] || '';
      if (!name) { console.log('Usage: node blog-image-sourcer.js product "Product Name" [brand]'); process.exit(1); }
      const result = await sourceProductImage(name, brand);
      console.log(JSON.stringify(result, null, 2));
    },

    async bing() {
      const query = args[0];
      if (!query) { console.log('Usage: node blog-image-sourcer.js bing "search query"'); process.exit(1); }
      const url = await fetchBingImage(query);
      console.log(url ? `Found: ${url}` : 'No image found');
    },

    async plan() {
      const postType = args[0] || POST_TYPES.CITY_LISTICLE;
      // Demo plan with sample outline
      const sampleOutline = [
        { heading: '1. Sample Venue', venue_name: 'Sample Venue', place_id: null },
        { heading: '2. Another Venue', venue_name: 'Another Venue', place_id: null },
        { heading: '3. Third Venue', venue_name: 'Third Venue', place_id: null },
      ];
      const plan = buildImagePlan(sampleOutline, {}, postType);
      console.log(JSON.stringify(plan, null, 2));
    },
  };

  if (!command || !commands[command]) {
    console.log('Usage: node blog-image-sourcer.js <venue|product|bing|plan> [args]');
    console.log('  venue    "Name" [placeId] [city]  -- Source venue image (3-tier)');
    console.log('  product  "Name" [brand]           -- Source product image');
    console.log('  bing     "query"                  -- Bing image search');
    console.log('  plan     [post_type]              -- Build sample image plan');
    process.exit(1);
  }

  commands[command]().catch(err => {
    console.error('Error:', err.message);
    process.exit(1);
  });
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  sourceBlogImages,
  sourceVenueImage,
  sourceProductImage,
  fetchGooglePlacesPhoto,
  fetchBingImage,
  generateAltText,
  generateCaption,
  validateImageFilename,
  uploadBlogImage,
  setFeaturedImage,
  getImageCountTarget,
  checkImageGaps,
  buildImagePlan,
  IMAGE_FILTERS,
};
