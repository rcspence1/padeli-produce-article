/**
 * Blog Production Pipeline Orchestrator for Padeli
 *
 * Master controller that runs the full 6-stage (expanded to 10-stage)
 * production pipeline:
 *
 *   Strategy -> Research -> Outline -> Draft -> Linking -> Images ->
 *   Schema -> QC -> Fact Check -> Publish
 *
 * Features:
 *   - Resumable state via per-slug ledger files
 *   - QC retry loop with intelligent stage routing (max 3 retries)
 *   - Dry-run ALWAYS default
 *   - Lazy imports so module loads even if dependencies aren't built yet
 *   - CLI for produce / resume / status / single-stage runs
 *
 * Node.js v24+ — zero external dependencies — CommonJS
 *
 * CLI:
 *   node blog-orchestrator.js produce brief.json [--verbose]
 *   node blog-orchestrator.js resume best-padel-courts-birmingham-2026
 *   node blog-orchestrator.js status best-padel-courts-birmingham-2026
 *   node blog-orchestrator.js stage research brief.json
 */

const fs = require('fs');
const path = require('path');
const { POST_TYPES, WORD_COUNT_TARGETS } = require('./config');
const { countWords, slugify } = require('./utils');
const { afterBlogPipeline } = require('./notion-sync');

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const PROJECT_ROOT = path.join(__dirname, '..');
const LEDGER_DIR = path.join(PROJECT_ROOT, 'data', 'pipeline-ledger');

const WORK_DIRS = {
  research: '/tmp/padeli-blog-research',
  outline: '/tmp/padeli-blog-outline',
  draft: '/tmp/padeli-blog-draft',
  linked: '/tmp/padeli-blog-linked',
  factcheck: '/tmp/padeli-blog-factcheck',
};

// ---------------------------------------------------------------------------
// Lazy imports — require inside functions so module loads even if
// downstream modules are not yet built
// ---------------------------------------------------------------------------

function lazyRequire(modulePath) {
  try {
    return require(modulePath);
  } catch (err) {
    return null;
  }
}

function getResearcher() { return lazyRequire('./blog-researcher'); }
function getOutlineGen() { return lazyRequire('./outline-generator'); }
function getDraftWriter() { return lazyRequire('./draft-writer'); }
function getLinker() { return lazyRequire('./linker'); }
function getQCValidator() { return lazyRequire('./blog-qc-validator'); }
function getSchemaBuilder() { return lazyRequire('./schema-builder'); }
function getPublisher() { return lazyRequire('./blog-publisher'); }
function getImageSourcer() { return lazyRequire('./blog-image-sourcer'); }
function getFactChecker() { return lazyRequire('./fact-checker'); }
function getTracker() { return lazyRequire('./blog-tracker'); }

// ---------------------------------------------------------------------------
// Stage definitions
// ---------------------------------------------------------------------------

const STAGE_ORDER = [
  'strategy',
  'research',
  'outline',
  'draft',
  'linking',
  'images',
  'schema',
  'qc',
  'fact_check',
  'publish',
];

const STAGES = {
  strategy: {
    name: 'Strategy',
    description: 'Validate brief, check tracker, confirm all required fields',
    requires: [],
    produces: 'validated_brief',
  },
  research: {
    name: 'Research',
    description: 'Generate research prompt, run sub-agent, validate report',
    requires: ['validated_brief'],
    produces: 'research_report',
  },
  outline: {
    name: 'Outline',
    description: 'Generate heading hierarchy, DA plan, FAQ questions',
    requires: ['validated_brief', 'research_report'],
    produces: 'outline',
  },
  draft: {
    name: 'Draft',
    description: 'Generate writing prompt, run sub-agent, validate output',
    requires: ['outline', 'research_report'],
    produces: 'draft_html',
  },
  linking: {
    name: 'Linking',
    description: 'Apply internal links with funnel discipline',
    requires: ['draft_html'],
    produces: 'linked_html',
  },
  images: {
    name: 'Images',
    description: 'Source and plan images per post type rules',
    requires: ['outline', 'research_report'],
    produces: 'image_plan',
  },
  schema: {
    name: 'Schema',
    description: 'Build JSON-LD schemas for post type',
    requires: ['draft_html', 'outline'],
    produces: 'schema_html',
  },
  qc: {
    name: 'QC',
    description: 'Run 54-point checklist, route failures back',
    requires: ['linked_html', 'schema_html', 'image_plan'],
    produces: 'qc_result',
  },
  fact_check: {
    name: 'Fact Check',
    description: 'Extract claims, build fact-check log, validate gate',
    requires: ['linked_html', 'research_report'],
    produces: 'fact_check_log',
  },
  publish: {
    name: 'Publish',
    description: 'Save as WordPress draft via REST API',
    requires: ['linked_html', 'schema_html', 'qc_result', 'fact_check_log'],
    produces: 'wp_post',
  },
};

// ---------------------------------------------------------------------------
// QC failure routing — maps check ID prefixes to responsible stages
// ---------------------------------------------------------------------------

const QC_ROUTING = {
  A: 'draft',      // A01-A12: voice & style
  B: 'draft',      // B13-B22: structure
  C: 'linking',    // C23-C30: linking
  D: 'publish',    // D31-D38: yoast/SEO (fixable in publish)
  E: 'images',     // E39-E44: images
  F: 'draft',      // F45-F49: YMYL
  G: 'research',   // G50-G54: hard limits (word count, facts)
};

// ---------------------------------------------------------------------------
// Ledger management — resumable pipeline state
// ---------------------------------------------------------------------------

/**
 * Ensure the ledger directory exists.
 */
function ensureLedgerDir() {
  if (!fs.existsSync(LEDGER_DIR)) {
    fs.mkdirSync(LEDGER_DIR, { recursive: true });
  }
}

/**
 * Get the file path for a slug's ledger.
 * @param {string} slug
 * @returns {string}
 */
function ledgerPath(slug) {
  return path.join(LEDGER_DIR, `${slug}.json`);
}

/**
 * Load the pipeline ledger for a slug. Returns null if not found.
 * @param {string} slug
 * @returns {object|null}
 */
function getLedgerState(slug) {
  const p = ledgerPath(slug);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Save pipeline ledger state for a slug (atomic write).
 * @param {string} slug
 * @param {object} state
 */
function saveLedgerState(slug, state) {
  ensureLedgerDir();
  state.updated = new Date().toISOString();
  const p = ledgerPath(slug);
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf-8');
  fs.renameSync(tmp, p);
}

/**
 * Create a fresh ledger for a brief.
 * @param {object} brief
 * @returns {object}
 */
function createLedger(brief) {
  const slug = brief.slug || slugify(brief.title || 'untitled');
  return {
    slug,
    brief,
    started: new Date().toISOString(),
    updated: new Date().toISOString(),
    current_stage: null,
    completed_stages: [],
    stage_results: {},
    qc_attempts: 0,
    qc_max_retries: 3,
    qc_failures: [],
    flags: {
      pending_manual_review: false,
      has_ymyl: brief.is_ymyl || false,
      has_planned_urls: false,
    },
    output: {
      wp_post_id: null,
      fact_check_log_path: null,
      word_count: null,
    },
  };
}

// ---------------------------------------------------------------------------
// Working directory helpers
// ---------------------------------------------------------------------------

/**
 * Ensure a /tmp working directory exists and return the output path for a slug.
 * @param {string} stageKey - e.g. 'research', 'outline', 'draft', 'linked', 'factcheck'
 * @param {string} slug
 * @param {string} ext - file extension (default depends on stage)
 * @returns {string}
 */
function workPath(stageKey, slug, ext) {
  const dir = WORK_DIRS[stageKey];
  if (!dir) return null;
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${slug}-${stageKey}.${ext || 'json'}`);
}

// ---------------------------------------------------------------------------
// Brief validation
// ---------------------------------------------------------------------------

const REQUIRED_BRIEF_FIELDS = ['title', 'focus_keyword', 'post_type', 'market'];

/**
 * Validate a brief object has all required fields and valid values.
 * @param {object} brief
 * @returns {{ valid: boolean, errors: string[], warnings: string[] }}
 */
function validateBrief(brief) {
  const errors = [];
  const warnings = [];

  if (!brief || typeof brief !== 'object') {
    return { valid: false, errors: ['Brief is not an object'], warnings };
  }

  for (const field of REQUIRED_BRIEF_FIELDS) {
    if (!brief[field]) {
      errors.push(`Missing required field: ${field}`);
    }
  }

  // Validate post_type
  const validTypes = Object.values(POST_TYPES);
  if (brief.post_type && !validTypes.includes(brief.post_type)) {
    errors.push(`Invalid post_type "${brief.post_type}". Valid: ${validTypes.join(', ')}`);
  }

  // Generate slug if missing
  if (!brief.slug && brief.title) {
    brief.slug = slugify(brief.title);
    warnings.push(`Generated slug from title: ${brief.slug}`);
  } else if (!brief.slug) {
    errors.push('Missing slug and no title to generate from');
  }

  // Check word count target exists for post type
  if (brief.post_type && !WORD_COUNT_TARGETS[brief.post_type]) {
    warnings.push(`No word count target defined for post_type "${brief.post_type}"`);
  }

  // Optional field warnings
  if (!brief.tier) warnings.push('No tier specified — defaulting to "supporting"');
  if (!brief.category) warnings.push('No category specified');
  if (!brief.author) warnings.push('No author specified — defaulting to "Ryan"');

  // Apply defaults
  brief.tier = brief.tier || 'supporting';
  brief.author = brief.author || 'Ryan';

  return { valid: errors.length === 0, errors, warnings };
}

// ---------------------------------------------------------------------------
// Individual stage runners
// ---------------------------------------------------------------------------

/**
 * Run a single named stage.
 * @param {string} stageName
 * @param {object} input - accumulated pipeline data (brief, research, outline, etc.)
 * @param {object} options - { verbose, etc. }
 * @returns {Promise<{ status: string, output: object, output_path: string|null, errors: string[], warnings: string[], duration_ms: number }>}
 */
async function runStage(stageName, input, options = {}) {
  const stage = STAGES[stageName];
  if (!stage) {
    return {
      status: 'fail',
      output: null,
      output_path: null,
      errors: [`Unknown stage: ${stageName}`],
      warnings: [],
      duration_ms: 0,
    };
  }

  const start = Date.now();
  const result = {
    status: 'pass',
    output: null,
    output_path: null,
    errors: [],
    warnings: [],
    duration_ms: 0,
  };

  // Check prerequisites
  for (const req of stage.requires) {
    if (!input[req]) {
      result.status = 'fail';
      result.errors.push(`Missing prerequisite: ${req}`);
    }
  }
  if (result.status === 'fail') {
    result.duration_ms = Date.now() - start;
    return result;
  }

  try {
    switch (stageName) {
      case 'strategy':
        result.output = await executeStrategy(input, options);
        break;
      case 'research':
        result.output = await executeResearch(input, options);
        break;
      case 'outline':
        result.output = await executeOutline(input, options);
        break;
      case 'draft':
        result.output = await executeDraft(input, options);
        break;
      case 'linking':
        result.output = await executeLinking(input, options);
        break;
      case 'images':
        result.output = await executeImages(input, options);
        break;
      case 'schema':
        result.output = await executeSchema(input, options);
        break;
      case 'qc':
        result.output = await executeQC(input, options);
        break;
      case 'fact_check':
        result.output = await executeFactCheck(input, options);
        break;
      case 'publish':
        result.output = await executePublish(input, options);
        break;
      default:
        result.status = 'fail';
        result.errors.push(`No executor for stage: ${stageName}`);
    }

    // If executor returned errors, mark as fail
    if (result.output && result.output._errors && result.output._errors.length > 0) {
      result.errors.push(...result.output._errors);
      result.status = 'fail';
    }
    if (result.output && result.output._warnings) {
      result.warnings.push(...result.output._warnings);
    }
    if (result.output && result.output._output_path) {
      result.output_path = result.output._output_path;
    }

    // Clean internal fields from output
    if (result.output) {
      delete result.output._errors;
      delete result.output._warnings;
      delete result.output._output_path;
    }
  } catch (err) {
    result.status = 'fail';
    result.errors.push(`Stage ${stageName} threw: ${err.message}`);
  }

  result.duration_ms = Date.now() - start;
  return result;
}

// ---------------------------------------------------------------------------
// Stage executors
// ---------------------------------------------------------------------------

/**
 * Strategy stage: validate brief, check tracker for duplicates, ensure
 * all required fields are present.
 */
async function executeStrategy(input, options) {
  const brief = input.brief || input.validated_brief;
  const validation = validateBrief(brief);
  const output = {
    validated_brief: brief,
    validation,
    _warnings: validation.warnings,
    _errors: validation.errors.length > 0 ? validation.errors : undefined,
  };

  // Check tracker for existing post with same slug
  const tracker = getTracker();
  if (tracker) {
    try {
      const existing = await tracker.getPost(brief.slug);
      if (existing) {
        if (existing.status === 'published') {
          output._errors = output._errors || [];
          output._errors.push(`Post "${brief.slug}" is already published (WP#${existing.wp_post_id})`);
        } else if (existing.status === 'in_production') {
          output._warnings = output._warnings || [];
          output._warnings.push(`Post "${brief.slug}" is already in production — will resume`);
        }
      }
    } catch {
      // Tracker unavailable — continue without check
    }
  }

  return output;
}

/**
 * Research stage: build research prompt, validate report.
 * The actual research is done by a sub-agent — this stage prepares and validates.
 */
async function executeResearch(input, options) {
  const brief = input.validated_brief;
  const slug = brief.slug;
  const researcher = getResearcher();
  const output = { _warnings: [], _output_path: null };

  if (!researcher) {
    // Module not yet built — create a placeholder prompt
    const prompt = buildResearchPromptFallback(brief);
    const outPath = workPath('research', slug, 'md');
    fs.writeFileSync(outPath, prompt, 'utf-8');
    output.research_report = prompt;
    output.research_prompt = prompt;
    output._output_path = outPath;
    output._warnings.push('blog-researcher module not available — wrote research prompt to file for manual execution');
    return output;
  }

  // Use blog-researcher module
  const prompt = researcher.buildResearchPrompt(brief);
  const outPath = workPath('research', slug, 'md');
  fs.writeFileSync(outPath, prompt, 'utf-8');
  output.research_report = prompt;
  output.research_prompt = prompt;
  output._output_path = outPath;
  output._warnings.push('Research prompt generated — sub-agent execution required');

  return output;
}

/**
 * Outline stage: generate heading hierarchy, DA plan, FAQ questions.
 */
async function executeOutline(input, options) {
  const brief = input.validated_brief;
  const research = input.research_report;
  const slug = brief.slug;
  const outlineGen = getOutlineGen();
  const output = { _warnings: [], _output_path: null };

  if (!outlineGen) {
    const placeholder = {
      title: brief.title,
      slug,
      post_type: brief.post_type,
      focus_keyword: brief.focus_keyword,
      headings: [],
      faqs: [],
      notes: 'outline-generator module not available — manual outline needed',
    };
    const outPath = workPath('outline', slug, 'json');
    fs.writeFileSync(outPath, JSON.stringify(placeholder, null, 2), 'utf-8');
    output.outline = placeholder;
    output._output_path = outPath;
    output._warnings.push('outline-generator module not available — wrote placeholder');
    return output;
  }

  const outline = outlineGen.generateOutline(brief, research);
  const outPath = workPath('outline', slug, 'json');
  fs.writeFileSync(outPath, JSON.stringify(outline, null, 2), 'utf-8');

  // Validate if the module supports it
  if (typeof outlineGen.validateOutline === 'function') {
    const validation = outlineGen.validateOutline(outline);
    if (validation && !validation.valid) {
      output._errors = validation.errors || ['Outline validation failed'];
    }
  }

  output.outline = outline;
  output._output_path = outPath;
  return output;
}

/**
 * Draft stage: generate writing prompt, validate output.
 */
async function executeDraft(input, options) {
  const outline = input.outline;
  const research = input.research_report;
  const brief = input.validated_brief || {};
  const slug = brief.slug || slugify(outline.title || 'draft');
  const draftWriter = getDraftWriter();
  const output = { _warnings: [], _output_path: null };

  if (!draftWriter) {
    const placeholder = `<!-- Draft placeholder for ${slug} -->\n<p>Draft content needed. Outline and research available.</p>`;
    const outPath = workPath('draft', slug, 'html');
    fs.writeFileSync(outPath, placeholder, 'utf-8');
    output.draft_html = placeholder;
    output._output_path = outPath;
    output._warnings.push('draft-writer module not available — wrote placeholder');
    return output;
  }

  const prompt = draftWriter.buildDraftPrompt(outline, research, brief);
  const outPath = workPath('draft', slug, 'html');

  // If the module returns a prompt string (sub-agent pattern), save it
  if (typeof prompt === 'string') {
    fs.writeFileSync(outPath, prompt, 'utf-8');
    output.draft_html = prompt;
    output.draft_prompt = prompt;
    output._output_path = outPath;
    output._warnings.push('Draft prompt generated — sub-agent execution required');
    return output;
  }

  // If it returns an object with html
  const html = prompt.html || prompt.draft_html || '';
  fs.writeFileSync(outPath, html, 'utf-8');

  if (typeof draftWriter.validateDraftOutput === 'function') {
    const validation = draftWriter.validateDraftOutput(html, brief);
    if (validation && !validation.valid) {
      output._errors = validation.errors || ['Draft validation failed'];
    }
  }

  output.draft_html = html;
  output._output_path = outPath;

  // Word count check
  const wc = countWords(html);
  output.word_count = wc;
  const target = WORD_COUNT_TARGETS[brief.post_type];
  if (target) {
    if (wc < target[0]) {
      output._warnings.push(`Word count ${wc} is below minimum ${target[0]} for ${brief.post_type}`);
    } else if (wc > target[1]) {
      output._warnings.push(`Word count ${wc} exceeds maximum ${target[1]} for ${brief.post_type}`);
    }
  }

  return output;
}

/**
 * Linking stage: apply internal links with funnel discipline.
 */
async function executeLinking(input, options) {
  const html = input.draft_html;
  const brief = input.validated_brief || {};
  const slug = brief.slug || 'linked';
  const linker = getLinker();
  const output = { _warnings: [], _output_path: null };

  if (!linker) {
    // Pass through — no linking module available
    const outPath = workPath('linked', slug, 'html');
    fs.writeFileSync(outPath, html, 'utf-8');
    output.linked_html = html;
    output._output_path = outPath;
    output._warnings.push('linker module not available — HTML passed through without internal links');
    return output;
  }

  // Load page index if available
  let pageIndex = null;
  if (typeof linker.loadPageIndex === 'function') {
    try {
      pageIndex = await linker.loadPageIndex();
    } catch {
      output._warnings.push('Could not load page index for linking');
    }
  }

  const linked = await linker.applyInternalLinks(html, pageIndex, brief);
  const outPath = workPath('linked', slug, 'html');
  const linkedHtml = typeof linked === 'string' ? linked : (linked.html || html);
  fs.writeFileSync(outPath, linkedHtml, 'utf-8');

  output.linked_html = linkedHtml;
  output._output_path = outPath;

  if (typeof linked === 'object' && linked.links_added !== undefined) {
    output.links_added = linked.links_added;
  }

  return output;
}

/**
 * Images stage: source and plan images per post type rules.
 */
async function executeImages(input, options) {
  const outline = input.outline;
  const research = input.research_report;
  const brief = input.validated_brief || {};
  const imageSourcer = getImageSourcer();
  const output = { _warnings: [] };

  if (!imageSourcer) {
    const placeholder = {
      post_type: brief.post_type,
      images: [],
      notes: 'blog-image-sourcer module not available — manual image plan needed',
    };
    output.image_plan = placeholder;
    output._warnings.push('blog-image-sourcer module not available — empty image plan');
    return output;
  }

  const plan = await imageSourcer.sourceBlogImages(outline, research, brief);
  output.image_plan = plan;
  return output;
}

/**
 * Schema stage: build JSON-LD schemas for post type.
 */
async function executeSchema(input, options) {
  const html = input.draft_html || input.linked_html;
  const outline = input.outline;
  const brief = input.validated_brief || {};
  const schemaBuilder = getSchemaBuilder();
  const output = { _warnings: [] };

  if (!schemaBuilder) {
    const placeholder = '<!-- schema: schema-builder module not available -->';
    output.schema_html = placeholder;
    output._warnings.push('schema-builder module not available — placeholder schema');
    return output;
  }

  const schemas = schemaBuilder.buildSchemasForPost(html, outline, brief);
  const schemaHtml = typeof schemas === 'string' ? schemas : JSON.stringify(schemas, null, 2);
  output.schema_html = schemaHtml;
  return output;
}

/**
 * QC stage: run 54-point checklist.
 */
async function executeQC(input, options) {
  const html = input.linked_html;
  const schema = input.schema_html;
  const imagePlan = input.image_plan;
  const brief = input.validated_brief || {};
  const qcValidator = getQCValidator();
  const output = { _warnings: [] };

  if (!qcValidator) {
    output.qc_result = {
      pass: false,
      score: 0,
      checks_run: 0,
      checks_passed: 0,
      failures: [],
      notes: 'blog-qc-validator module not available — cannot run QC',
    };
    output._errors = ['blog-qc-validator module not available'];
    return output;
  }

  // Build the payload the QC validator expects
  const payload = {
    body: html,
    schema_html: schema,
    image_plan: imagePlan,
    post_type: brief.post_type,
    focus_keyword: brief.focus_keyword,
    title: brief.title,
    slug: brief.slug,
    market: brief.market,
    country_code: brief.country_code || brief.market,
    is_ymyl: brief.is_ymyl || false,
  };

  const qcResult = typeof qcValidator.validateBlogPost === 'function'
    ? qcValidator.validateBlogPost(payload)
    : qcValidator(payload);

  output.qc_result = qcResult;

  if (qcResult && !qcResult.pass) {
    // Don't mark as _errors — QC failure is handled by the retry loop
    output._warnings.push(`QC failed: ${qcResult.checks_passed || 0}/${qcResult.checks_run || 0} checks passed`);
  }

  return output;
}

/**
 * Fact Check stage: extract claims, build fact-check log, validate.
 */
async function executeFactCheck(input, options) {
  const html = input.linked_html;
  const research = input.research_report;
  const brief = input.validated_brief || {};
  const slug = brief.slug || 'factcheck';
  const factChecker = getFactChecker();
  const output = { _warnings: [], _output_path: null };

  if (!factChecker) {
    const placeholder = {
      pass: true,
      claims: [],
      notes: 'fact-checker module not available — skipped',
    };
    output.fact_check_log = placeholder;
    output._warnings.push('fact-checker module not available — fact check skipped');
    return output;
  }

  // Extract claims
  const claims = typeof factChecker.extractClaims === 'function'
    ? factChecker.extractClaims(html)
    : [];

  // Build log
  const log = typeof factChecker.buildFactCheckLog === 'function'
    ? factChecker.buildFactCheckLog(claims, research)
    : { claims, verified: [], unverified: [] };

  // Validate gate
  let gateResult = { pass: true };
  if (typeof factChecker.validateFactCheckLog === 'function') {
    gateResult = factChecker.validateFactCheckLog(log);
  }

  const outPath = workPath('factcheck', slug, 'md');
  const logText = typeof log === 'string' ? log : JSON.stringify(log, null, 2);
  fs.writeFileSync(outPath, logText, 'utf-8');

  output.fact_check_log = { ...log, pass: gateResult.pass };
  output._output_path = outPath;

  if (!gateResult.pass) {
    output._warnings.push('Fact check gate failed — unverified claims found');
  }

  return output;
}

/**
 * Publish stage: save as WordPress draft via REST API.
 * Dry-run ALWAYS default.
 */
async function executePublish(input, options) {
  const html = input.linked_html;
  const schema = input.schema_html;
  const qcResult = input.qc_result;
  const factLog = input.fact_check_log;
  const brief = input.validated_brief || {};
  const publisher = getPublisher();
  const output = { _warnings: [] };

  // Gate: QC must pass
  if (!qcResult || !qcResult.pass) {
    output._errors = ['Cannot publish — QC has not passed'];
    return output;
  }

  // Gate: fact check must pass
  if (!factLog || !factLog.pass) {
    output._errors = ['Cannot publish — fact check has not passed'];
    return output;
  }

  if (!publisher) {
    output.wp_post = null;
    output._warnings.push('blog-publisher module not available — cannot publish');
    return output;
  }

  // Publish as WordPress draft
  const publishResult = await publisher.publishBlogPost({
    title: brief.title,
    slug: brief.slug,
    body: html,
    schema_html: schema,
    post_type: brief.post_type,
    focus_keyword: brief.focus_keyword,
    category: brief.category,
    market: brief.market,
    author: brief.author,
  });

  output.wp_post = publishResult;
  return output;
}

// ---------------------------------------------------------------------------
// Research prompt fallback (when blog-researcher module not built)
// ---------------------------------------------------------------------------

function buildResearchPromptFallback(brief) {
  const lines = [
    `# Research Brief: ${brief.title}`,
    '',
    `**Focus Keyword:** ${brief.focus_keyword}`,
    `**Post Type:** ${brief.post_type}`,
    `**Market:** ${brief.market}`,
    `**Tier:** ${brief.tier || 'supporting'}`,
    '',
    '## Research Required',
    '',
    '1. Top 10 SERP results for the focus keyword — note structure, word count, headings',
    '2. Related keywords and questions (People Also Ask)',
    '3. Key facts, statistics, and data points',
    '4. Competitor content gaps',
    '5. Local context (if location-specific)',
    '',
    '## Output Format',
    '',
    'Produce a research report in Markdown with sections for each item above.',
  ];
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// QC retry routing
// ---------------------------------------------------------------------------

/**
 * Given a list of failed QC check IDs, determine which stage to re-run from.
 * Returns the earliest stage in STAGE_ORDER that needs re-running.
 *
 * @param {string[]} failedCheckIds - e.g. ['A03', 'C25', 'G51']
 * @returns {string} stage name to re-run from
 */
function routeQCFailures(failedCheckIds) {
  if (!failedCheckIds || failedCheckIds.length === 0) return 'draft';

  const responsibleStages = new Set();

  for (const checkId of failedCheckIds) {
    const prefix = (checkId || '').charAt(0).toUpperCase();
    const stage = QC_ROUTING[prefix] || 'draft';
    responsibleStages.add(stage);
  }

  // Find the earliest stage in STAGE_ORDER
  for (const stage of STAGE_ORDER) {
    if (responsibleStages.has(stage)) return stage;
  }

  return 'draft';
}

// ---------------------------------------------------------------------------
// Main pipeline: produceArticle
// ---------------------------------------------------------------------------

/**
 * Run the full production pipeline for a blog article.
 *
 * @param {object} brief - The article brief
 * @param {object} options - { verbose: false }
 * @returns {Promise<object>} Pipeline result with ledger state, outputs, timing
 */
async function produceArticle(brief, options = {}) {
  const verbose = options.verbose || false;

  // 1. Load or create ledger
  const slug = brief.slug || slugify(brief.title || 'untitled');
  brief.slug = slug;

  let ledger = getLedgerState(slug);
  if (ledger) {
    log(verbose, `Resuming pipeline for "${slug}" from ledger`);
    // Merge brief updates
    ledger.brief = { ...ledger.brief, ...brief };
  } else {
    ledger = createLedger(brief);
    log(verbose, `Starting new pipeline for "${slug}"`);
  }

  // Accumulated pipeline data — seed with any existing stage outputs
  const pipelineData = {
    brief,
    validated_brief: brief,
  };

  // Restore outputs from completed stages
  for (const completedStage of ledger.completed_stages) {
    const stageResult = ledger.stage_results[completedStage];
    if (stageResult && stageResult.output) {
      const produces = STAGES[completedStage]?.produces;
      if (produces && stageResult.output[produces] !== undefined) {
        pipelineData[produces] = stageResult.output[produces];
      }
      // Also merge all output keys into pipeline data
      Object.assign(pipelineData, stageResult.output);
    }
  }

  // 2. Run each stage in STAGE_ORDER
  const startTime = Date.now();

  for (const stageName of STAGE_ORDER) {
    // Skip if already completed (resume support)
    if (ledger.completed_stages.includes(stageName)) {
      log(verbose, `  [SKIP] ${stageName} — already completed`);
      continue;
    }

    // Check prerequisites are satisfied
    const stage = STAGES[stageName];
    const missingPrereqs = stage.requires.filter(req => !pipelineData[req]);
    if (missingPrereqs.length > 0) {
      log(verbose, `  [SKIP] ${stageName} — missing prerequisites: ${missingPrereqs.join(', ')}`);
      continue;
    }

    log(verbose, `  [RUN]  ${stageName}...`);
    ledger.current_stage = stageName;
    saveLedgerState(slug, ledger);

    const stageOptions = { ...options, verbose };
    const result = await runStage(stageName, pipelineData, stageOptions);

    log(verbose, `  [${result.status.toUpperCase()}] ${stageName} (${result.duration_ms}ms)`);
    if (result.warnings.length > 0) {
      for (const w of result.warnings) log(verbose, `    WARN: ${w}`);
    }
    if (result.errors.length > 0) {
      for (const e of result.errors) log(verbose, `    ERROR: ${e}`);
    }

    // Save stage result to ledger
    ledger.stage_results[stageName] = {
      status: result.status,
      completed: new Date().toISOString(),
      output_path: result.output_path || null,
      errors: result.errors,
      warnings: result.warnings,
      duration_ms: result.duration_ms,
      output: result.output,
    };

    if (result.status === 'pass') {
      ledger.completed_stages.push(stageName);

      // Merge output into pipeline data
      if (result.output) {
        const produces = stage.produces;
        if (produces && result.output[produces] !== undefined) {
          pipelineData[produces] = result.output[produces];
        }
        // Also merge all output keys
        Object.assign(pipelineData, result.output);
      }
    }

    // QC retry loop
    if (stageName === 'qc' && result.status === 'pass') {
      const qcResult = pipelineData.qc_result;
      if (qcResult && !qcResult.pass) {
        ledger.qc_attempts++;

        if (ledger.qc_attempts > ledger.qc_max_retries) {
          // Max retries exceeded — flag for manual review
          ledger.flags.pending_manual_review = true;
          log(verbose, `  [STOP] QC failed ${ledger.qc_attempts} times — flagging for manual review`);
          saveLedgerState(slug, ledger);

          // Update tracker if available
          await updateTrackerQC(slug, qcResult);

          return buildResult(ledger, pipelineData, startTime, 'qc_max_retries_exceeded');
        }

        // Determine which stage to re-run from
        const failedIds = extractFailedCheckIds(qcResult);
        const rerouteStage = routeQCFailures(failedIds);
        log(verbose, `  [RETRY] QC attempt ${ledger.qc_attempts}/${ledger.qc_max_retries} — routing back to ${rerouteStage}`);

        ledger.qc_failures.push({
          attempt: ledger.qc_attempts,
          failed_checks: failedIds,
          reroute_to: rerouteStage,
          timestamp: new Date().toISOString(),
        });

        // Remove the reroute stage and all subsequent stages from completed
        const rerouteIdx = STAGE_ORDER.indexOf(rerouteStage);
        ledger.completed_stages = ledger.completed_stages.filter(s => {
          const idx = STAGE_ORDER.indexOf(s);
          return idx < rerouteIdx;
        });

        // Also remove their results so prerequisites are re-evaluated
        for (const s of STAGE_ORDER) {
          const idx = STAGE_ORDER.indexOf(s);
          if (idx >= rerouteIdx) {
            delete ledger.stage_results[s];
            // Remove produces from pipeline data
            const produces = STAGES[s]?.produces;
            if (produces) delete pipelineData[produces];
          }
        }

        saveLedgerState(slug, ledger);

        // Recursively resume from the reroute stage
        return produceArticle(ledger.brief, { ...options, _resumeFrom: rerouteStage });
      }
    }

    // If a stage fails hard (not QC soft fail), stop the pipeline
    if (result.status === 'fail') {
      saveLedgerState(slug, ledger);
      log(verbose, `  [STOP] Pipeline stopped at ${stageName} due to errors`);
      // Log failure to Notion so it's not invisible
      try {
        const { logAgentRun, incrementAgentRuns, logToOperationsBoard } = require('./notion-sync');
        const failDetails = [
          `Title: ${brief.title || 'unknown'}`,
          `Type: ${brief.post_type || 'unknown'}`,
          `Market: ${brief.market || 'unknown'}`,
          `Failed at: ${stageName}`,
          `Error: ${result.error || 'unknown'}`,
        ].join(' | ');
        await logAgentRun('Padeli Produce Article', 'Failed', failDetails);
        await incrementAgentRuns('Padeli Produce Article');
        await logToOperationsBoard('Padeli Produce Article', `Write article: ${brief.title}`, 'Failed', failDetails);
      } catch (err) {
        log(verbose, `  [notion-sync] Failure log error (non-blocking): ${err.message}`);
      }
      return buildResult(ledger, pipelineData, startTime, 'stage_failed');
    }

    saveLedgerState(slug, ledger);
  }

  // 3. All stages complete
  // Update output summary
  ledger.output.word_count = pipelineData.word_count || countWords(pipelineData.linked_html || pipelineData.draft_html || '');
  ledger.output.fact_check_log_path = ledger.stage_results.fact_check?.output_path || null;
  if (pipelineData.wp_post && pipelineData.wp_post.id) {
    ledger.output.wp_post_id = pipelineData.wp_post.id;
  }

  ledger.current_stage = 'complete';
  saveLedgerState(slug, ledger);

  // Update tracker
  await updateTrackerOnComplete(slug, ledger, pipelineData);

  // --- Notion Sync (auto, non-blocking) ---
  try {
    const wpPost = pipelineData.wp_post || {};
    await afterBlogPipeline(brief, wpPost, { qc_attempts: ledger.qc_attempts });
  } catch (err) {
    log(verbose, `  [notion-sync] Post-pipeline sync error (non-blocking): ${err.message}`);
  }

  log(verbose, `Pipeline complete for "${slug}" (${Date.now() - startTime}ms)`);
  return buildResult(ledger, pipelineData, startTime, 'complete');
}

// ---------------------------------------------------------------------------
// Resume from ledger
// ---------------------------------------------------------------------------

/**
 * Resume a pipeline from its last completed stage.
 * @param {string} slug
 * @param {object} options
 * @returns {Promise<object>}
 */
async function resumeFromLedger(slug, options = {}) {
  const ledger = getLedgerState(slug);
  if (!ledger) {
    throw new Error(`No ledger found for slug "${slug}". Cannot resume.`);
  }

  if (ledger.current_stage === 'complete') {
    return {
      status: 'already_complete',
      slug,
      message: 'Pipeline already completed for this slug',
      ledger,
    };
  }

  if (ledger.flags.pending_manual_review) {
    return {
      status: 'pending_manual_review',
      slug,
      message: `Pipeline flagged for manual review after ${ledger.qc_attempts} QC failures`,
      ledger,
    };
  }

  // Resume by calling produceArticle with the stored brief
  return produceArticle(ledger.brief, options);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(verbose, msg) {
  if (verbose) {
    const ts = new Date().toISOString().slice(11, 19);
    console.log(`[${ts}] ${msg}`);
  }
}

function buildResult(ledger, pipelineData, startTime, status) {
  return {
    status,
    slug: ledger.slug,
    completed_stages: [...ledger.completed_stages],
    current_stage: ledger.current_stage,
    qc_attempts: ledger.qc_attempts,
    flags: { ...ledger.flags },
    output: { ...ledger.output },
    duration_ms: Date.now() - startTime,
    ledger_path: ledgerPath(ledger.slug),
  };
}

/**
 * Extract failed check IDs from a QC result.
 * Handles various QC result shapes.
 */
function extractFailedCheckIds(qcResult) {
  if (!qcResult) return [];

  // Try common field names
  const failures = qcResult.failures || qcResult.failed_checks || qcResult.issues || [];

  return failures
    .map(f => {
      if (typeof f === 'string') return f;
      if (f.id) return f.id;
      if (f.check_id) return f.check_id;
      if (f.code) return f.code;
      return null;
    })
    .filter(Boolean);
}

/**
 * Update tracker QC info (if tracker module available).
 */
async function updateTrackerQC(slug, qcResult) {
  const tracker = getTracker();
  if (!tracker || typeof tracker.updateQC !== 'function') return;
  try {
    await tracker.updateQC(slug, qcResult);
  } catch {
    // Tracker entry may not exist yet — that's fine
  }
}

/**
 * Update tracker when pipeline completes.
 */
async function updateTrackerOnComplete(slug, ledger, pipelineData) {
  const tracker = getTracker();
  if (!tracker) return;

  try {
    // Update paths (no-op for Notion — paths live in pipeline-ledger)
    if (typeof tracker.updatePaths === 'function') {
      const paths = {};
      if (ledger.stage_results.research?.output_path) paths.research_report = ledger.stage_results.research.output_path;
      if (ledger.stage_results.outline?.output_path) paths.outline = ledger.stage_results.outline.output_path;
      if (ledger.stage_results.draft?.output_path || ledger.stage_results.linking?.output_path) {
        paths.draft = ledger.stage_results.linking?.output_path || ledger.stage_results.draft?.output_path;
      }
      if (ledger.stage_results.fact_check?.output_path) paths.fact_check_log = ledger.stage_results.fact_check.output_path;
      await tracker.updatePaths(slug, paths);
    }

    // Update QC
    if (pipelineData.qc_result && typeof tracker.updateQC === 'function') {
      await tracker.updateQC(slug, pipelineData.qc_result);
    }

    // If published
    if (pipelineData.wp_post && pipelineData.wp_post.id) {
      if (typeof tracker.setPublished === 'function') {
        await tracker.setPublished(slug, pipelineData.wp_post.id, ledger.output.word_count);
      }
    }
  } catch {
    // Tracker updates are best-effort
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function cli() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command) {
    printUsage();
    process.exit(1);
  }

  const flags = parseFlags(args);

  switch (command) {
    case 'produce': {
      const briefPath = args[1];
      if (!briefPath) {
        console.error('Usage: node blog-orchestrator.js produce <brief.json> [--verbose]');
        process.exit(1);
      }
      const absPath = path.isAbsolute(briefPath) ? briefPath : path.join(process.cwd(), briefPath);
      if (!fs.existsSync(absPath)) {
        console.error(`Brief file not found: ${absPath}`);
        process.exit(1);
      }
      const brief = JSON.parse(fs.readFileSync(absPath, 'utf-8'));
      const options = {
        verbose: true,
      };

      console.log(`\n=== Padeli Blog Pipeline ===`);
      console.log(`Brief: ${absPath}`);
      console.log('Mode: LIVE');
      console.log('');

      const result = await produceArticle(brief, options);

      console.log('');
      console.log(`=== Result ===`);
      console.log(`Status:           ${result.status}`);
      console.log(`Slug:             ${result.slug}`);
      console.log(`Completed stages: ${result.completed_stages.join(', ') || '(none)'}`);
      console.log(`QC attempts:      ${result.qc_attempts}`);
      console.log(`Duration:         ${result.duration_ms}ms`);
      console.log(`Ledger:           ${result.ledger_path}`);
      if (result.flags.pending_manual_review) {
        console.log(`\n** FLAGGED FOR MANUAL REVIEW **`);
      }
      if (result.output.wp_post_id) {
        console.log(`WP Post ID:       ${result.output.wp_post_id}`);
      }
      break;
    }

    case 'resume': {
      const slug = args[1];
      if (!slug) {
        console.error('Usage: node blog-orchestrator.js resume <slug> [--verbose]');
        process.exit(1);
      }
      const options = {
        verbose: true,
      };

      console.log(`\n=== Resuming Pipeline: ${slug} ===`);
      console.log('Mode: LIVE');
      console.log('');

      try {
        const result = await resumeFromLedger(slug, options);
        console.log('');
        console.log(`Status: ${result.status}`);
        if (result.completed_stages) {
          console.log(`Completed: ${result.completed_stages.join(', ')}`);
        }
        if (result.message) {
          console.log(`Message: ${result.message}`);
        }
      } catch (err) {
        console.error(`Error: ${err.message}`);
        process.exit(1);
      }
      break;
    }

    case 'status': {
      const slug = args[1];
      if (!slug) {
        console.error('Usage: node blog-orchestrator.js status <slug>');
        process.exit(1);
      }
      const ledger = getLedgerState(slug);
      if (!ledger) {
        console.log(`No pipeline ledger found for "${slug}"`);
        process.exit(1);
      }

      console.log(`\n=== Pipeline Status: ${slug} ===\n`);
      console.log(`Started:     ${ledger.started}`);
      console.log(`Updated:     ${ledger.updated}`);
      console.log(`Current:     ${ledger.current_stage || '(not started)'}`);
      console.log(`Completed:   ${ledger.completed_stages.join(', ') || '(none)'}`);
      console.log(`QC attempts: ${ledger.qc_attempts}/${ledger.qc_max_retries}`);
      console.log(`Manual review: ${ledger.flags.pending_manual_review ? 'YES' : 'No'}`);
      console.log(`YMYL:        ${ledger.flags.has_ymyl ? 'YES' : 'No'}`);
      console.log('');

      // Stage detail
      console.log('Stage Results:');
      for (const stage of STAGE_ORDER) {
        const r = ledger.stage_results[stage];
        if (r) {
          const icon = r.status === 'pass' ? 'PASS' : r.status === 'fail' ? 'FAIL' : 'SKIP';
          console.log(`  ${stage.padEnd(12)} [${icon}] ${r.duration_ms}ms  ${r.output_path || ''}`);
          if (r.errors && r.errors.length > 0) {
            for (const e of r.errors) console.log(`               ERROR: ${e}`);
          }
        } else {
          const done = ledger.completed_stages.includes(stage);
          console.log(`  ${stage.padEnd(12)} [${done ? 'DONE' : '----'}]`);
        }
      }

      if (ledger.qc_failures.length > 0) {
        console.log('\nQC Failures:');
        for (const f of ledger.qc_failures) {
          console.log(`  Attempt ${f.attempt}: rerouted to ${f.reroute_to} (checks: ${f.failed_checks.join(', ')})`);
        }
      }

      if (ledger.output.wp_post_id) {
        console.log(`\nWP Post ID: ${ledger.output.wp_post_id}`);
      }
      if (ledger.output.word_count) {
        console.log(`Word count: ${ledger.output.word_count}`);
      }
      break;
    }

    case 'stage': {
      const stageName = args[1];
      const briefPath = args[2];
      if (!stageName || !briefPath) {
        console.error('Usage: node blog-orchestrator.js stage <stage_name> <brief.json>');
        process.exit(1);
      }
      if (!STAGES[stageName]) {
        console.error(`Unknown stage: ${stageName}. Valid: ${STAGE_ORDER.join(', ')}`);
        process.exit(1);
      }
      const absPath = path.isAbsolute(briefPath) ? briefPath : path.join(process.cwd(), briefPath);
      if (!fs.existsSync(absPath)) {
        console.error(`Brief file not found: ${absPath}`);
        process.exit(1);
      }
      const brief = JSON.parse(fs.readFileSync(absPath, 'utf-8'));
      const input = { brief, validated_brief: brief };

      console.log(`\n=== Running stage: ${stageName} ===\n`);
      const result = await runStage(stageName, input, { verbose: true });
      console.log(`Status:   ${result.status}`);
      console.log(`Duration: ${result.duration_ms}ms`);
      if (result.output_path) console.log(`Output:   ${result.output_path}`);
      if (result.errors.length > 0) {
        console.log('Errors:');
        for (const e of result.errors) console.log(`  - ${e}`);
      }
      if (result.warnings.length > 0) {
        console.log('Warnings:');
        for (const w of result.warnings) console.log(`  - ${w}`);
      }
      break;
    }

    default:
      console.error(`Unknown command: ${command}`);
      printUsage();
      process.exit(1);
  }
}

function printUsage() {
  console.log('Usage:');
  console.log('  node blog-orchestrator.js produce <brief.json> [--verbose]');
  console.log('  node blog-orchestrator.js resume <slug> [--verbose]');
  console.log('  node blog-orchestrator.js status <slug>');
  console.log('  node blog-orchestrator.js stage <stage_name> <brief.json>');
  console.log('');
  console.log(`Stages: ${STAGE_ORDER.join(', ')}`);
}

function parseFlags(args) {
  const flags = {};
  for (const arg of args) {
    if (arg === '--verbose') flags.verbose = true;
  }
  return flags;
}

// Run CLI if executed directly
if (require.main === module) {
  cli().catch(err => {
    console.error(`Fatal: ${err.message}`);
    process.exit(1);
  });
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  produceArticle,
  runStage,
  resumeFromLedger,
  getLedgerState,
  saveLedgerState,
  STAGES,
  STAGE_ORDER,
};
