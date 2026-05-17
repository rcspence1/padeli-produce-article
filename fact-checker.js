/**
 * Fact-Checker Module for Padeli Blog Pipeline
 *
 * Implements the 3-pass fact verification workflow:
 *   Pass 1 — Claim extraction (every hard claim from post body)
 *   Pass 2 — Source hierarchy classification (primary → banned)
 *   Pass 3 — Cross-reference verification & hedging
 *
 * Node.js v24+ — zero external dependencies — CommonJS
 */

const fs = require('fs');
const path = require('path');
const { BANNED_SOURCES } = require('./config');
const { stripHtml, countWords } = require('./utils');

// ---------------------------------------------------------------------------
// Source Tier Domains
// ---------------------------------------------------------------------------

const SOURCE_TIERS = {
  primary: [
    'padelfip.com', 'lta.org.uk', 'playtomic.io', 'matchi.se',
    'nox-padel.com', 'bullpadel.com', 'head.com', 'babolat.com',
    'wilsonpadel.com', 'joma-sport.com', 'gov.uk', 'nhs.uk',
    'nih.gov', 'pbbi.or.id',
    // Venue websites matched dynamically in classifySource()
  ],
  secondary: [
    'padelful.com', 'thepadelpaper.com', 'padelnews.com',
    'bbc.co.uk', 'telegraph.co.uk', 'pubmed.ncbi.nlm.nih.gov',
    'physiopedia.com',
  ],
  tertiary: [
    'reddit.com', 'google.com/maps', 'tripadvisor.com',
    'instagram.com',
  ],
  banned: [
    'hidubai.com', 'timeoutdubai.com', 'whatson.ae', 'provenexpert.com',
    'wikipedia.org',
    // Also merge any extras from config.BANNED_SOURCES
    ...BANNED_SOURCES.filter(
      (d) =>
        !['hidubai.com', 'timeoutdubai.com', 'whatson.ae', 'provenexpert.com'].includes(d),
    ),
  ],
};

// ---------------------------------------------------------------------------
// Claim Extraction Patterns
// ---------------------------------------------------------------------------

const CLAIM_PATTERNS = {
  numeric:
    /\b(\d[\d,]*\.?\d*)\s*(courts?|venues?|players?|%|percent|hours?|minutes?|km|miles?|calories?|metres?|meters?)\b/gi,
  currency:
    /[£$€]\s*[\d,]+\.?\d*|[\d,]+\.?\d*\s*(GBP|USD|EUR|IDR|AED|SEK|DKK|NOK)/gi,
  rating:
    /(\d\.?\d?)\s*\/\s*5|(\d\.?\d?)\s*out of\s*5|(\d\.?\d?)\s*stars?/gi,
  year: /\b(20[2-3]\d)\b/g,
  named_entity: /(?:^|\s)([A-Z][a-z]+(?:\s[A-Z][a-z]+)+)/g,
  rule_assertion:
    /\b(must|always|never|required|mandatory|official|regulation|rule|law)\b/gi,
  comparative:
    /\b(largest|smallest|best|worst|most|least|first|only|biggest|highest|lowest)\b/gi,
};

// ---------------------------------------------------------------------------
// Time-sensitive keywords
// ---------------------------------------------------------------------------

const TIME_SENSITIVE_KEYWORDS = {
  court_count: /\b\d+\s*courts?\b/i,
  price: /[£$€]\s*[\d,]+|[\d,]+\.?\d*\s*(GBP|USD|EUR|IDR|AED|SEK|DKK|NOK)/i,
  tournament: /\b(tournament|championship|competition|calendar|schedule|season)\b/i,
  new_venue: /\b(opening|set to open|will open|new venue|launching|planned)\b/i,
};

// ---------------------------------------------------------------------------
// YMYL keywords
// ---------------------------------------------------------------------------

const YMYL_KEYWORDS = {
  health_injury: /\b(injury|injuries|pain|rehabilitation|rehab|recovery|surgery|condition|diagnosis|diagnosed)\b/i,
  fitness_claim: /\b(burn|calories|heart rate|cardiovascular|aerobic|weight loss|fat loss|muscle)\b/i,
  diagnostic: /\b(treats?|cure|heal|fix|prevent|reduce risk|lower risk|improve symptoms)\b/i,
  dose_frequency: /\b(\d+\s*(times?|sessions?|hours?|minutes?|reps?|sets?)\s*(per|a|each)\s*(day|week|month))\b/i,
  financial: /\b(invest|investment|profit|revenue|income|earn|salary|financial advice)\b/i,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Split text into sentences. Handles common abbreviations to avoid false splits.
 *
 * @param {string} text - Plain text
 * @returns {string[]} Array of sentence strings
 */
function splitSentences(text) {
  // Protect common abbreviations
  let safe = text
    .replace(/\bDr\./g, 'Dr\u0000')
    .replace(/\bMr\./g, 'Mr\u0000')
    .replace(/\bMrs\./g, 'Mrs\u0000')
    .replace(/\bMs\./g, 'Ms\u0000')
    .replace(/\bSt\./g, 'St\u0000')
    .replace(/\be\.g\./g, 'e\u0000g\u0000')
    .replace(/\bi\.e\./g, 'i\u0000e\u0000')
    .replace(/\bvs\./g, 'vs\u0000')
    .replace(/\betc\./g, 'etc\u0000')
    .replace(/\bNo\./g, 'No\u0000')
    .replace(/\bFig\./g, 'Fig\u0000');

  // Split on sentence-ending punctuation followed by space + uppercase or end
  const raw = safe.split(/(?<=[.!?])\s+(?=[A-Z"])/);

  return raw
    .map((s) => s.replace(/\u0000/g, '.').trim())
    .filter((s) => s.length > 0);
}

/**
 * Extract the domain (hostname) from a URL string.
 *
 * @param {string} url - URL string
 * @returns {string} Domain in lowercase, e.g. 'padelful.com'
 */
function extractDomain(url) {
  try {
    const u = new URL(url.startsWith('http') ? url : `https://${url}`);
    return u.hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    // Fallback: strip protocol and path manually
    return (url || '')
      .replace(/^https?:\/\//, '')
      .replace(/^www\./, '')
      .split('/')[0]
      .toLowerCase();
  }
}

/**
 * Split HTML body into paragraphs (by <p> tags) and return plain-text blocks.
 *
 * @param {string} html
 * @returns {string[]} Array of plain-text paragraph strings
 */
function htmlToParagraphs(html) {
  const pRegex = /<p[^>]*>([\s\S]*?)<\/p>/gi;
  const paragraphs = [];
  let match;
  while ((match = pRegex.exec(html)) !== null) {
    const text = stripHtml(match[1]).trim();
    if (text.length > 0) {
      paragraphs.push(text);
    }
  }
  // If no <p> tags found, treat the whole thing as one block
  if (paragraphs.length === 0) {
    const plain = stripHtml(html).trim();
    if (plain.length > 0) paragraphs.push(plain);
  }
  return paragraphs;
}

// ---------------------------------------------------------------------------
// Pass 1 — extractClaims
// ---------------------------------------------------------------------------

/**
 * Extract every "hard claim" from HTML post body.
 *
 * @param {string} html - The post body HTML
 * @returns {Array<Object>} Array of claim objects
 */
function extractClaims(html) {
  const paragraphs = htmlToParagraphs(html);
  const claims = [];

  for (let pIdx = 0; pIdx < paragraphs.length; pIdx++) {
    const sentences = splitSentences(paragraphs[pIdx]);

    for (let sIdx = 0; sIdx < sentences.length; sIdx++) {
      const sentence = sentences[sIdx];

      // Test each pattern against this sentence
      for (const [type, pattern] of Object.entries(CLAIM_PATTERNS)) {
        // Reset lastIndex for global patterns
        const regex = new RegExp(pattern.source, pattern.flags);
        let m;
        while ((m = regex.exec(sentence)) !== null) {
          // Avoid duplicate claims for the same sentence + type + value
          const value = m[0].trim();
          const alreadyExists = claims.some(
            (c) =>
              c.paragraph_index === pIdx &&
              c.sentence_index === sIdx &&
              c.type === type &&
              c.value === value,
          );
          if (!alreadyExists) {
            claims.push({
              text: sentence,
              type,
              value,
              paragraph_index: pIdx,
              sentence_index: sIdx,
              needs_verification: true,
              sources: [],
              source_count: 0,
              verification_status: 'pending',
            });
          }
        }
      }
    }
  }

  return claims;
}

// ---------------------------------------------------------------------------
// Cross-reference requirements by claim type
// ---------------------------------------------------------------------------

const CROSS_REF_REQUIREMENTS = {
  currency: {
    min_sources: 2,
    required_source_type: null, // any 2+ sources
    description: 'Pricing claims require 2+ independent sources',
  },
  numeric: {
    min_sources: 2,
    required_source_type: null,
    description: 'Numeric claims require 2+ independent sources',
  },
  named_entity: {
    min_sources: 1,
    required_source_type: 'venue_website',
    description: 'Staff/coach names require the venue\'s own website as one source',
  },
  rating: {
    min_sources: 1,
    required_source_type: 'original_platform',
    description: 'Ratings require the original platform (Google, Playtomic) as a source',
  },
  rule_assertion: {
    min_sources: 1,
    required_source_type: null,
    description: '1 authoritative source is sufficient',
  },
  comparative: {
    min_sources: 1,
    required_source_type: null,
    description: '1 authoritative source is sufficient',
  },
  year: {
    min_sources: 1,
    required_source_type: null,
    description: '1 source is sufficient for year references',
  },
};

// ---------------------------------------------------------------------------
// Recency thresholds (in months)
// ---------------------------------------------------------------------------

const RECENCY_THRESHOLDS = {
  currency: 6,
  numeric: 6,
  named_entity: 3,
  rating: 6,
  rule_assertion: 12,
  comparative: 12,
  year: 12,
};

// ---------------------------------------------------------------------------
// flagSingleSourceClaims
// ---------------------------------------------------------------------------

/**
 * Flag claims verified by only 1 source and assign confidence levels.
 * Also checks cross-reference requirements per claim type and source recency.
 *
 * @param {Array<Object>} claims - Array of claim objects (with sources array populated)
 * @param {Object} [options] - Optional settings
 * @param {string} [options.venue_domain] - The venue's own website domain (e.g. 'thepadelclub.com')
 * @returns {Array<Object>} Claims enriched with single_source, confidence, and warnings
 */
function flagSingleSourceClaims(claims, options = {}) {
  const venueDomain = options.venue_domain || null;
  const ratingPlatforms = ['google.com', 'playtomic.io', 'matchi.se', 'tripadvisor.com', 'trustpilot.com'];

  return claims.map((claim) => {
    const sourceList = claim.sources || [];
    const sourceCount = sourceList.length;
    const warnings = [];

    // --- Confidence based on source count ---
    const confidence = sourceCount >= 3 ? 'high'
      : sourceCount === 2 ? 'medium'
      : 'low';

    const singleSource = sourceCount <= 1;

    // --- Cross-reference checks per claim type ---
    const requirements = CROSS_REF_REQUIREMENTS[claim.type];
    if (requirements) {
      // Check minimum source count
      if (sourceCount < requirements.min_sources) {
        warnings.push(
          `${requirements.description} — only ${sourceCount} source(s) found`,
        );
      }

      // Check required source type: venue website
      if (requirements.required_source_type === 'venue_website' && venueDomain) {
        const hasVenueSource = sourceList.some((s) => {
          const d = extractDomain(s);
          return d === venueDomain || d.endsWith('.' + venueDomain);
        });
        if (!hasVenueSource) {
          warnings.push(
            `Claim type "${claim.type}" should include the venue website (${venueDomain}) as a source`,
          );
        }
      }

      // Check required source type: original rating platform
      if (requirements.required_source_type === 'original_platform') {
        const hasPlatformSource = sourceList.some((s) => {
          const d = extractDomain(s);
          return ratingPlatforms.some((p) => d === p || d.endsWith('.' + p));
        });
        if (!hasPlatformSource) {
          warnings.push(
            `Rating claims should include the original platform (e.g. Google, Playtomic) as a source`,
          );
        }
      }
    }

    // --- Recency check ---
    const recencyMonths = RECENCY_THRESHOLDS[claim.type] || 12;
    if (claim.source_dates) {
      for (const dateStr of claim.source_dates) {
        const sourceDate = new Date(dateStr);
        if (!isNaN(sourceDate.getTime())) {
          const monthsAgo = (Date.now() - sourceDate.getTime()) / (1000 * 60 * 60 * 24 * 30);
          if (monthsAgo > recencyMonths) {
            const staleness = (claim.type === 'currency' || claim.type === 'numeric')
              ? 'STALE'
              : 'POTENTIALLY_STALE';
            warnings.push(
              `Source dated ${dateStr} is ${staleness} — older than ${recencyMonths} month threshold for "${claim.type}" claims`,
            );
          }
        }
      }
    }

    return {
      ...claim,
      source_count: sourceCount,
      single_source: singleSource,
      confidence,
      warnings,
    };
  });
}

// ---------------------------------------------------------------------------
// Pass 2 — classifySource
// ---------------------------------------------------------------------------

/**
 * Classify a URL into a source tier.
 *
 * @param {string} url - Source URL
 * @returns {'primary'|'secondary'|'tertiary'|'banned'} Tier string
 */
function classifySource(url) {
  const domain = extractDomain(url);

  // Check banned first (highest priority — block these)
  for (const banned of SOURCE_TIERS.banned) {
    if (domain === banned || domain.endsWith('.' + banned)) {
      return 'banned';
    }
  }

  // Check primary
  for (const primary of SOURCE_TIERS.primary) {
    if (domain === primary || domain.endsWith('.' + primary)) {
      return 'primary';
    }
  }

  // Check secondary
  for (const secondary of SOURCE_TIERS.secondary) {
    if (domain === secondary || domain.endsWith('.' + secondary)) {
      return 'secondary';
    }
  }

  // Check tertiary
  for (const tertiary of SOURCE_TIERS.tertiary) {
    if (domain === tertiary || domain.endsWith('.' + tertiary)) {
      return 'tertiary';
    }
  }

  // Government and official health sites not explicitly listed
  if (domain.endsWith('.gov') || domain.endsWith('.gov.uk') || domain.endsWith('.nhs.uk')) {
    return 'primary';
  }

  // Federation / official sport body heuristic
  if (
    domain.includes('padel') &&
    (domain.endsWith('.org') || domain.endsWith('.org.uk') || domain.includes('federation'))
  ) {
    return 'primary';
  }

  // Default: treat unknown sources as tertiary (must be corroborated)
  return 'tertiary';
}

// ---------------------------------------------------------------------------
// Pass 3 — buildFactCheckLog
// ---------------------------------------------------------------------------

/**
 * Generate a fact-check log in markdown format.
 *
 * @param {string} slug - The post slug
 * @param {Array<Object>} claims - Array of claim objects from extractClaims
 * @param {Array<Object>} verifications - Array of verification results, each:
 *   { claim_index, sources: [url, ...], status: 'verified'|'hedged'|'dropped', notes }
 * @returns {string} Markdown fact-check log
 */
function buildFactCheckLog(slug, claims, verifications) {
  const today = new Date().toISOString().slice(0, 10);

  // Build a map of verifications by claim index
  const vMap = new Map();
  for (const v of verifications) {
    vMap.set(v.claim_index, v);
  }

  // Count categories
  let corrections = 0;
  let softenings = 0;
  let removals = 0;
  const openClaims = [];
  const allSources = new Set();

  for (const v of verifications) {
    if (v.status === 'dropped') removals++;
    else if (v.status === 'hedged') softenings++;
    else if (v.status === 'corrected') corrections++;
    for (const s of v.sources || []) allSources.add(s);
  }

  // Identify unverified claims
  for (let i = 0; i < claims.length; i++) {
    if (!vMap.has(i)) {
      openClaims.push(claims[i]);
    }
  }

  const reviewed = verifications.length;
  const needsFix = corrections + softenings + removals > 0 || openClaims.length > 0;
  const status = needsFix ? 'NEEDS-FIX' : 'PASS';

  // Build per-claim sections
  const claimSections = [];
  for (let i = 0; i < claims.length; i++) {
    const claim = claims[i];
    const v = vMap.get(i);
    const idx = i + 1;

    if (v) {
      const sourceList = (v.sources || []).join(', ') || 'None';
      const vStatus = v.status === 'verified' ? 'PASS'
        : v.status === 'hedged' ? 'SOFTENED'
        : v.status === 'dropped' ? 'FAIL'
        : v.status === 'corrected' ? 'FAIL'
        : v.status.toUpperCase();

      claimSections.push(
        `### Claim ${idx}: ${claim.value}\n\n` +
        `- **Source(s):** ${sourceList}\n` +
        `- **Verification:** ${vStatus}\n` +
        `- **Notes:** ${v.notes || 'No additional notes'}`,
      );
    } else {
      claimSections.push(
        `### Claim ${idx}: ${claim.value}\n\n` +
        `- **Source(s):** None\n` +
        `- **Verification:** PENDING\n` +
        `- **Notes:** Not yet verified`,
      );
    }
  }

  // Build corrections section
  const correctionLines = verifications
    .filter((v) => v.status === 'corrected' || v.status === 'hedged')
    .map((v) => {
      const claim = claims[v.claim_index];
      return `- **${claim ? claim.value : 'Unknown'}:** ${v.notes || 'Corrected'}`;
    });

  // Build open claims section
  const openLines = openClaims.map(
    (c) => `- ${c.value} (paragraph ${c.paragraph_index + 1}, sentence ${c.sentence_index + 1})`,
  );

  // Build sources section
  const sourceLines = [...allSources].map((s) => `- ${s} (${classifySource(s)})`);

  const articleUrl = slug ? `https://padeli.com/${slug}/` : 'draft';

  const md = `# Fact-Check Report: ${slug || 'untitled'}

**Article URL:** ${articleUrl}
**Checked by:** Claude
**Checked on:** ${today}
**Status:** ${status}

## Summary

- Claims found: ${claims.length}
- Claims reviewed: ${reviewed}
- Claims requiring correction: ${corrections}
- Claims requiring softening: ${softenings}
- Claims requiring removal: ${removals}

## Per-claim verification

${claimSections.join('\n\n')}

## Corrections applied

${correctionLines.length > 0 ? correctionLines.join('\n') : 'None'}

## Open / unverifiable claims

${openLines.length > 0 ? openLines.join('\n') : 'None'}

## Sources used

${sourceLines.length > 0 ? sourceLines.join('\n') : 'None'}
`;

  return md;
}

// ---------------------------------------------------------------------------
// validateFactCheckLog
// ---------------------------------------------------------------------------

/**
 * Validate that a fact-check log file meets minimum requirements.
 *
 * @param {string} logPath - Absolute path to the fact-check log .md file
 * @returns {{ pass: boolean, errors: string[] }}
 */
function validateFactCheckLog(logPath) {
  const errors = [];

  // 1. File exists
  if (!fs.existsSync(logPath)) {
    return { pass: false, errors: ['Fact-check log file not found: ' + logPath], warnings: [] };
  }

  const content = fs.readFileSync(logPath, 'utf-8');

  // 2. Has required header
  if (!content.includes('# Fact-Check Report:')) {
    errors.push('Missing required header: # Fact-Check Report:');
  }

  // 3. Has claims-found and claims-reviewed counts
  if (!/Claims found:\s*\d+/i.test(content)) {
    errors.push('Missing "Claims found" count in Summary');
  }
  if (!/Claims reviewed:\s*\d+/i.test(content)) {
    errors.push('Missing "Claims reviewed" count in Summary');
  }

  // 4. Has at least 1 per-claim section (not a stub)
  const claimSections = content.match(/### Claim \d+:/g);
  if (!claimSections || claimSections.length === 0) {
    errors.push('No per-claim sections found (### Claim N:)');
  }

  // 5. Status is PASS
  const statusMatch = content.match(/\*\*Status:\*\*\s*(PASS|NEEDS-FIX)/i);
  if (!statusMatch) {
    errors.push('Missing **Status:** field');
  } else if (statusMatch[1].toUpperCase() !== 'PASS') {
    errors.push(`Fact-check status is ${statusMatch[1]}, expected PASS`);
  }

  // 6. Single-source ratio check
  const warnings = [];
  const parsed = parseFactCheckLog(content);
  if (parsed.claims.length > 0) {
    const singleSourceClaims = parsed.claims.filter(
      (c) => c.sources.length <= 1,
    );
    const singleSourceRatio = singleSourceClaims.length / parsed.claims.length;

    if (singleSourceRatio > 0.2) {
      warnings.push(
        `${Math.round(singleSourceRatio * 100)}% of claims are single-source (threshold: 20%). ` +
        `${singleSourceClaims.length} of ${parsed.claims.length} claims need additional sources.`,
      );
    }

    // 7. Pricing claims must be checked against venue website or booking platform
    const pricingClaims = parsed.claims.filter((c) => {
      const val = (c.value || '').toLowerCase();
      return /[£$€]|gbp|usd|eur|idr|aed/i.test(val);
    });
    const singleSourcePricing = pricingClaims.filter(
      (c) => c.sources.length <= 1,
    );
    if (singleSourcePricing.length > 0) {
      warnings.push(
        `WARNING: ${singleSourcePricing.length} pricing claim(s) have only 1 source. ` +
        `Pricing should be cross-referenced with the venue website or booking platform.`,
      );
    }
  }

  return { pass: errors.length === 0, errors, warnings };
}

// ---------------------------------------------------------------------------
// parseFactCheckLog
// ---------------------------------------------------------------------------

/**
 * Parse a fact-check log markdown file into a structured object.
 *
 * @param {string} logContent - The markdown content of the log
 * @returns {Object} Structured representation of the log
 */
function parseFactCheckLog(logContent) {
  const result = {
    slug: null,
    article_url: null,
    checked_by: null,
    checked_on: null,
    status: null,
    summary: {
      claims_found: 0,
      claims_reviewed: 0,
      corrections: 0,
      softenings: 0,
      removals: 0,
    },
    claims: [],
    corrections: [],
    open_claims: [],
    sources: [],
  };

  // Header
  const slugMatch = logContent.match(/# Fact-Check Report:\s*(.+)/);
  if (slugMatch) result.slug = slugMatch[1].trim();

  const urlMatch = logContent.match(/\*\*Article URL:\*\*\s*(.+)/);
  if (urlMatch) result.article_url = urlMatch[1].trim();

  const byMatch = logContent.match(/\*\*Checked by:\*\*\s*(.+)/);
  if (byMatch) result.checked_by = byMatch[1].trim();

  const onMatch = logContent.match(/\*\*Checked on:\*\*\s*(.+)/);
  if (onMatch) result.checked_on = onMatch[1].trim();

  const statusMatch = logContent.match(/\*\*Status:\*\*\s*(.+)/);
  if (statusMatch) result.status = statusMatch[1].trim();

  // Summary counts
  const foundMatch = logContent.match(/Claims found:\s*(\d+)/i);
  if (foundMatch) result.summary.claims_found = parseInt(foundMatch[1], 10);

  const reviewedMatch = logContent.match(/Claims reviewed:\s*(\d+)/i);
  if (reviewedMatch) result.summary.claims_reviewed = parseInt(reviewedMatch[1], 10);

  const corrMatch = logContent.match(/Claims requiring correction:\s*(\d+)/i);
  if (corrMatch) result.summary.corrections = parseInt(corrMatch[1], 10);

  const softMatch = logContent.match(/Claims requiring softening:\s*(\d+)/i);
  if (softMatch) result.summary.softenings = parseInt(softMatch[1], 10);

  const remMatch = logContent.match(/Claims requiring removal:\s*(\d+)/i);
  if (remMatch) result.summary.removals = parseInt(remMatch[1], 10);

  // Per-claim sections
  const claimRegex = /### Claim (\d+):\s*(.+?)(?:\n\n|\n)[\s\S]*?- \*\*Source\(s\):\*\*\s*(.+)\n- \*\*Verification:\*\*\s*(.+)\n- \*\*Notes:\*\*\s*(.+)/g;
  let cm;
  while ((cm = claimRegex.exec(logContent)) !== null) {
    result.claims.push({
      index: parseInt(cm[1], 10),
      value: cm[2].trim(),
      sources: cm[3].trim() === 'None' ? [] : cm[3].split(',').map((s) => s.trim()),
      verification: cm[4].trim(),
      notes: cm[5].trim(),
    });
  }

  // Corrections section
  const corrSection = logContent.match(/## Corrections applied\n\n([\s\S]*?)(?=\n## |$)/);
  if (corrSection && corrSection[1].trim() !== 'None') {
    const lines = corrSection[1].trim().split('\n').filter((l) => l.startsWith('- '));
    result.corrections = lines.map((l) => l.replace(/^- /, '').trim());
  }

  // Open claims section
  const openSection = logContent.match(/## Open \/ unverifiable claims\n\n([\s\S]*?)(?=\n## |$)/);
  if (openSection && openSection[1].trim() !== 'None') {
    const lines = openSection[1].trim().split('\n').filter((l) => l.startsWith('- '));
    result.open_claims = lines.map((l) => l.replace(/^- /, '').trim());
  }

  // Sources section
  const srcSection = logContent.match(/## Sources used\n\n([\s\S]*?)$/);
  if (srcSection && srcSection[1].trim() !== 'None') {
    const lines = srcSection[1].trim().split('\n').filter((l) => l.startsWith('- '));
    result.sources = lines.map((l) => l.replace(/^- /, '').trim());
  }

  return result;
}

// ---------------------------------------------------------------------------
// generateVerifyFlags
// ---------------------------------------------------------------------------

/**
 * Scan HTML and return an array of locations where [VERIFY] flags should be inserted.
 * Each item contains the claim text, its type, and the paragraph/sentence index.
 *
 * @param {string} html - Post body HTML
 * @returns {Array<{text: string, type: string, value: string, paragraph_index: number, sentence_index: number, flag: string}>}
 */
function generateVerifyFlags(html) {
  const claims = extractClaims(html);
  return claims.map((c) => ({
    text: c.text,
    type: c.type,
    value: c.value,
    paragraph_index: c.paragraph_index,
    sentence_index: c.sentence_index,
    flag: `[VERIFY: ${c.type} — "${c.value}"]`,
  }));
}

// ---------------------------------------------------------------------------
// resolveVerifyFlags
// ---------------------------------------------------------------------------

/**
 * Replace [VERIFY] flags in HTML with resolved text.
 *
 * @param {string} html - HTML containing [VERIFY: ...] flags
 * @param {Array<{flag: string, resolution: string}>} resolutions - Array of flag/resolution pairs
 *   resolution can be: the corrected text, 'KEEP' (no change needed), or 'DROP' (remove sentence)
 * @returns {string} HTML with flags resolved
 */
function resolveVerifyFlags(html, resolutions) {
  let result = html;

  for (const { flag, resolution } of resolutions) {
    if (resolution === 'KEEP') {
      // Remove the flag marker, keep surrounding text
      result = result.replace(flag, '');
    } else if (resolution === 'DROP') {
      // Remove the flag marker — the caller is responsible for removing the sentence
      result = result.replace(flag, '');
    } else {
      // Replace flag with resolved text
      result = result.replace(flag, resolution);
    }
  }

  // Clean up any double spaces left behind
  result = result.replace(/ {2,}/g, ' ');

  return result;
}

// ---------------------------------------------------------------------------
// checkTimeSensitive
// ---------------------------------------------------------------------------

/**
 * Check if a claim is time-sensitive and needs date hedging.
 * Also checks source recency and flags stale data.
 *
 * @param {Object} claim - A claim object from extractClaims
 * @returns {{ is_time_sensitive: boolean, hedge_needed: boolean, suggestion: string, staleness: string|null }}
 */
function checkTimeSensitive(claim) {
  const text = claim.text || '';
  let staleness = null;

  // --- Source recency check ---
  if (claim.source_dates && claim.source_dates.length > 0) {
    const recencyMonths = RECENCY_THRESHOLDS[claim.type] || 12;
    for (const dateStr of claim.source_dates) {
      const sourceDate = new Date(dateStr);
      if (!isNaN(sourceDate.getTime())) {
        const monthsAgo = (Date.now() - sourceDate.getTime()) / (1000 * 60 * 60 * 24 * 30);
        if (monthsAgo > recencyMonths) {
          if (claim.type === 'currency' || claim.type === 'numeric') {
            staleness = 'STALE';
          } else if (claim.type === 'named_entity') {
            staleness = 'POTENTIALLY_STALE';
          } else {
            staleness = 'POTENTIALLY_STALE';
          }
        }
      }
    }
  }

  // Court counts
  if (TIME_SENSITIVE_KEYWORDS.court_count.test(text)) {
    const year = new Date().getFullYear();
    return {
      is_time_sensitive: true,
      hedge_needed: true,
      suggestion: `Add "as of ${year}" or "at the time of writing" near the court count`,
      staleness,
    };
  }

  // Prices
  if (TIME_SENSITIVE_KEYWORDS.price.test(text)) {
    return {
      is_time_sensitive: true,
      hedge_needed: true,
      suggestion: 'Add a snapshot date or "prices correct as of {month} {year}"',
      staleness,
    };
  }

  // Tournament / calendar
  if (TIME_SENSITIVE_KEYWORDS.tournament.test(text)) {
    const year = new Date().getFullYear();
    return {
      is_time_sensitive: true,
      hedge_needed: true,
      suggestion: `Add "(${year} schedule)" or "for the ${year} season"`,
      staleness,
    };
  }

  // New venue / opening
  if (TIME_SENSITIVE_KEYWORDS.new_venue.test(text)) {
    return {
      is_time_sensitive: true,
      hedge_needed: true,
      suggestion: 'Confirm current status — use "set to open" vs "now open" as appropriate',
      staleness,
    };
  }

  return {
    is_time_sensitive: false,
    hedge_needed: false,
    suggestion: '',
    staleness,
  };
}

// ---------------------------------------------------------------------------
// checkYMYLClaim
// ---------------------------------------------------------------------------

/**
 * Check if a claim falls under YMYL (Your Money or Your Life) and needs
 * extra strictness.
 *
 * @param {Object} claim - A claim object from extractClaims
 * @returns {{ is_ymyl: boolean, extra_strictness: string[] }}
 */
function checkYMYLClaim(claim) {
  const text = claim.text || '';
  const strictness = [];

  if (YMYL_KEYWORDS.health_injury.test(text)) {
    strictness.push('Requires NHS/NIH citation or peer-reviewed source');
    strictness.push('Add hedging: "may", "some evidence suggests", "consult a professional"');
  }

  if (YMYL_KEYWORDS.fitness_claim.test(text)) {
    strictness.push('Cite peer-reviewed source or official health body');
    strictness.push('Hedge with "approximately" or "research suggests"');
  }

  if (YMYL_KEYWORDS.diagnostic.test(text)) {
    strictness.push('Replace "treats" / "cures" with "may help with" or "has been associated with"');
    strictness.push('Never make diagnostic claims without medical citation');
  }

  if (YMYL_KEYWORDS.dose_frequency.test(text)) {
    strictness.push('Dose/frequency claims must be cited with a specific source');
    strictness.push('Add "general guidance suggests" or cite the recommending body');
  }

  if (YMYL_KEYWORDS.financial.test(text)) {
    strictness.push('Add professional-advice disclaimer');
    strictness.push('Do not present as personalised financial advice');
  }

  return {
    is_ymyl: strictness.length > 0,
    extra_strictness: strictness,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

if (require.main === module) {
  const [, , command, ...args] = process.argv;

  if (!command) {
    console.log('Usage:');
    console.log('  node fact-checker.js extract /path/to/draft.html');
    console.log('  node fact-checker.js validate /path/to/factcheck.md');
    console.log('  node fact-checker.js build <slug> /path/to/claims.json');
    process.exit(0);
  }

  if (command === 'extract') {
    const filePath = args[0];
    if (!filePath) {
      console.error('Error: provide path to HTML file');
      process.exit(1);
    }
    const html = fs.readFileSync(path.resolve(filePath), 'utf-8');
    const claims = extractClaims(html);

    // Enrich with time-sensitive and YMYL checks
    const enriched = claims.map((c) => ({
      ...c,
      time_sensitive: checkTimeSensitive(c),
      ymyl: checkYMYLClaim(c),
    }));

    console.log(JSON.stringify(enriched, null, 2));
    console.log(`\n--- ${enriched.length} claim(s) extracted ---`);
  } else if (command === 'validate') {
    const filePath = args[0];
    if (!filePath) {
      console.error('Error: provide path to fact-check log');
      process.exit(1);
    }
    const result = validateFactCheckLog(path.resolve(filePath));
    if (result.pass) {
      console.log('PASS — fact-check log is valid');
    } else {
      console.log('FAIL — issues found:');
      for (const err of result.errors) {
        console.log('  - ' + err);
      }
    }
    process.exit(result.pass ? 0 : 1);
  } else if (command === 'build') {
    const slug = args[0];
    const claimsPath = args[1];
    if (!slug || !claimsPath) {
      console.error('Error: provide slug and path to claims JSON');
      process.exit(1);
    }
    const data = JSON.parse(fs.readFileSync(path.resolve(claimsPath), 'utf-8'));
    const claims = data.claims || data;
    const verifications = data.verifications || [];
    const log = buildFactCheckLog(slug, claims, verifications);
    console.log(log);
  } else {
    console.error(`Unknown command: ${command}`);
    console.log('Valid commands: extract, validate, build');
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  extractClaims,
  classifySource,
  buildFactCheckLog,
  validateFactCheckLog,
  parseFactCheckLog,
  generateVerifyFlags,
  resolveVerifyFlags,
  checkTimeSensitive,
  checkYMYLClaim,
  flagSingleSourceClaims,
  SOURCE_TIERS,
  CLAIM_PATTERNS,
  CROSS_REF_REQUIREMENTS,
  RECENCY_THRESHOLDS,
};
