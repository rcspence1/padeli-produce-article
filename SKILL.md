---
name: padeli:produce-article
description: "Produce a BPA-quality blog post on padeli.com. Full 10-stage pipeline: strategy, research, outline, draft, linking, images, schema, QC (54-point), fact-check, publish as WordPress draft. Use when Ryan says 'write an article', 'produce a post', 'blog about [topic]', or '/padeli:produce-article'."
user-invocable: true
---

# Padeli Produce Article

End-to-end pipeline for producing BPA-quality blog posts on padeli.com.

**Pipeline:** brief → strategy → research → outline → draft → linking → images → schema → QC (54-point) → fact-check → publish (draft)

---

## Input

Minimum: focus keyword + post type + market.

```
/padeli:produce-article best padel courts in birmingham 2026, city_listicle, UK
/padeli:produce-article best padel rackets uk 2026, product_listicle, UK
/padeli:produce-article padel in bali 2026, pillar, ID
```

Optional fields the user may provide:
- `tier` — cornerstone / cluster / leaf (inferred from post_type if not given)
- `pillar_slug` — parent pillar post slug (for cluster/leaf posts)
- `category` — Where to Play, Equipment, Events, Juniors, Getting Started, Coaching & Training, Padel Holidays
- `boundary` — geographic scope (e.g. "Greater Birmingham inside the M42")
- `is_ymyl` — true for health/injury/fitness content
- `slug` — URL slug (auto-generated from focus keyword if not given)
- `title` — working title (auto-generated if not given)

---

## The 5 Post Types

| Type | Tier | Word Count | Images | FAQ Qs | Example |
|------|------|-----------|--------|--------|---------|
| City Listicle | Cornerstone | 2,500-4,500 | 6-12 | 8 | /best-padel-courts-nusa-dua-2026/ |
| Product Listicle | Cornerstone | 2,500-4,500 | 7-10 | 10 | /best-padel-rackets-uk-2026/ |
| Pillar Page | Cornerstone | 2,500-4,500 | 4-6 | 8 | /padel-in-bali-2026/ |
| Cluster | Cluster | 1,200-2,000 | 3-5 | 5-6 | /padel-coaching-canggu-2026/ |
| Leaf | Leaf | 800-1,500 | 2-3 | 5 | /padel-serve-technique/ |

---

## AI Search Non-Negotiables

Every article produced by this skill MUST pass these rules. They come from
[Google's AI Optimization Guide](https://developers.google.com/search/docs/fundamentals/ai-optimization-guide)
and are what makes content eligible to appear in AI Overviews / AI Mode answers.

### Content quality (write-time rules)

1. **Distinctive perspective** — every article must contain at least one section with
   first-hand experience, original data, or unique viewpoint not derivable from
   summarising existing sources. Mark these with explicit language like
   "in our experience", "we tested", "I visited", "our data shows", etc.
2. **No commodity templates** — do not produce generic "7 Tips for X" /
   "10 Best Y" listicles without unique analysis. If the post type is a listicle,
   each entry must include something the reader cannot get from a competitor's
   page on the same topic (a specific data point, a personal observation, a
   contrarian take, a comparison).
3. **Write for humans first** — natural sentences, no keyword stuffing, no
   AI-only writing patterns (avoid the banned phrase list in `config.js`).
4. **Author byline + bio** — every published article must include a visible
   author byline (defaulting to the Padeli editorial team if no named author)
   and a 1-paragraph bio with credentials. Include `Author` schema (Person type)
   in the Article JSON-LD.
5. **No artificial chunking** — break content by reader need, not by what looks
   neat for an AI to extract. No forced "Quick answer" boxes if the question
   doesn't warrant a one-line answer.
6. **Multimedia richness** — at least 1 image every 400 words. Pillar pages
   should include at least 1 embedded video (YouTube embed counts).

### Technical non-negotiables (publish-time rules)

7. **Indexability** — no `noindex`, no `nosnippet`, no `max-snippet:0`.
   The page must be crawlable AND eligible for rich snippets.
8. **Structured data** — every article publishes with full Article schema
   (headline, datePublished, dateModified, author, publisher, image, mainEntity).
   Pillar pages add FAQPage + BreadcrumbList. Leaf pages add HowTo where
   appropriate.
9. **Entity clarity** — the topic/entity (venue name, technique name, product
   name) appears verbatim in H1, meta title, Article schema `about`, and at
   least one heading.
10. **Date signals** — both `datePublished` and `dateModified` present in
    schema; visible "Updated [date]" in the body if older than 90 days.
11. **No llms.txt** — the site does not publish an llms.txt file. Per Google,
    this is not required and may signal manipulation.

### Citation & authority

12. **External authority links** — minimum 2-3 outbound links to authoritative
    sources (federation sites, news outlets, manufacturer docs). No shortener
    links. No links to other low-authority blogs.
13. **Cite original data** — any statistic or factual claim must link to its
    source. The fact-check stage (Step 10) verifies every numeric claim.

### Banned patterns (auto-fail)

- Generic intro "In today's fast-paced world..."
- "Whether you're a beginner or pro..."
- Any phrase in `BANNED_PHRASES` in `config.js`
- "AI-summary" style writing: bullet-heavy with no narrative voice
- Listicle items that are interchangeable with any other site's listicle on
  the same topic

---

## Execution Steps

### Step 1: Parse Brief

Extract focus keyword, post type, market, and optional fields. Build the brief object:

```bash
node -e "
const brief = {
  focus_keyword: '{FOCUS_KEYWORD}',
  post_type: '{POST_TYPE}',
  tier: '{TIER}',
  market: '{MARKET}',
  country_code: '{CC}',
  pillar_slug: '{PILLAR_SLUG}',
  category: '{CATEGORY}',
  slug: '{SLUG}',
  title: '{TITLE}',
  boundary: '{BOUNDARY}',
  is_ymyl: false,
};
console.log(JSON.stringify(brief, null, 2));
"
```

Map post types to tiers: city_listicle/product_listicle/pillar → cornerstone, cluster → cluster, leaf → leaf.

### Step 2: Strategy Validation

Check the brief has all required fields. Check the blog tracker for duplicates:

```bash
node -e "
const { getPost, addPost, updateStatus } = require('./blog-tracker');
const existing = getPost('{SLUG}');
if (existing) {
  console.log('Post exists:', existing.status);
} else {
  console.log('New post - ready to produce');
}
"
```

If the post doesn't exist in the tracker, add it. Set status to `in_production`.

### Step 3: Research (Sub-Agent)

Generate the research prompt and spawn a background agent:

```bash
node -e "
const { buildResearchPrompt } = require('./blog-researcher');
const brief = JSON.parse(process.argv[1]);
console.log(buildResearchPrompt(brief));
" '{BRIEF_JSON}'
```

Pass the prompt to the Agent tool with `subagent_type: "general-purpose"`. The agent MUST use `WebSearch` and `WebFetch` extensively.

**For city listicles:** The research agent runs the full 8-phase workflow:
1. Define scope (boundary, intent)
2. Build venue inventory (Padelful, Playtomic, MATCHi, Google Maps, federation)
3. Verify court counts and facts
4. Research pricing (off-peak/peak, currency)
5. Aggregate reviews (Google, Playtomic, Reddit - NOT HiDubai/TimeOut/ProvenExpert)
6. Document coaching and services
7. Capture local context (climate, transport, tournaments, news)
8. Write verification report

**For product listicles:** 5-step product research (inventory, specs, reviews, stockists, report).

The research agent must return a structured markdown report. Validate with:

```bash
node -e "
const { parseResearchReport, validateResearchReport } = require('./blog-researcher');
const report = parseResearchReport(researchMarkdown);
const result = validateResearchReport(report, '{POST_TYPE}');
console.log(JSON.stringify(result, null, 2));
"
```

### Step 4: Outline Generation

```bash
node -e "
const { generateOutline, validateOutline, formatOutline } = require('./outline-generator');
const brief = JSON.parse(process.argv[1]);
const research = JSON.parse(process.argv[2]);
const outline = generateOutline(brief, research);
const validation = validateOutline(outline, brief.post_type);
console.log(formatOutline(outline));
console.log('\nValidation:', JSON.stringify(validation));
" '{BRIEF_JSON}' '{RESEARCH_JSON}'
```

Review the outline for correct structure before proceeding.

### Step 5: Draft (Sub-Agent)

Generate the writing prompt:

```bash
node -e "
const { buildDraftPrompt } = require('./draft-writer');
const outline = JSON.parse(process.argv[1]);
const research = JSON.parse(process.argv[2]);
const brief = JSON.parse(process.argv[3]);
console.log(buildDraftPrompt(outline, research, brief));
" '{OUTLINE_JSON}' '{RESEARCH_JSON}' '{BRIEF_JSON}'
```

Pass to a sub-agent. The agent returns JSON matching `DRAFT_OUTPUT_SCHEMA`:
- `body_html` — full Gutenberg block HTML
- `da_paragraph` — 50-80 word direct answer
- `faqs` — 5-8 Q&A pairs
- `yoast_title` — 50-65 chars
- `yoast_meta` — 120-156 chars
- `related_reading` — 6-12 internal link suggestions

**AEO / Agentic AI Requirements (applied during drafting):**
- DA block must appear within the first 200 words — AI agents weight top-of-page content for extraction
- First paragraph should include a definition sentence ("What is X" or "X is a...") for AI knowledge panel eligibility
- Use the exact focus keyword entity name consistently across title, meta desc, DA block, H1, and body — inconsistent naming breaks AI entity resolution
- How-to content must use ordered lists (`<ol>`) not just prose — AI workflow agents extract structured steps
- Include specific data points (prices, ratings, court counts, percentages) — AI cites content with original data over generic advice
- Ensure `datePublished` and `dateModified` are in schema AND a visible "Last updated" line exists in content

Validate the draft:

```bash
node -e "
const { validateDraftOutput } = require('./draft-writer');
const result = validateDraftOutput(draftHtml, '{POST_TYPE}');
console.log(JSON.stringify(result, null, 2));
"
```

### Step 6: Internal Linking

```bash
node -e "
const { applyInternalLinks, loadPageIndex } = require('./linker');
const pageIndex = loadPageIndex();
const postMeta = { slug: '{SLUG}', post_type: '{POST_TYPE}', tier: '{TIER}', pillar_slug: '{PILLAR}', focus_keyword: '{KW}' };
const result = applyInternalLinks(draftHtml, pageIndex, postMeta);
console.log('Links applied:', result.linksApplied);
console.log(result.report);
"
```

Applies funnel-aware links (TOFU/MOFU/BOFU) with 30/50/20 anchor variation.

### Step 7: Images

```bash
node -e "
const { sourceBlogImages, buildImagePlan } = require('./blog-image-sourcer');
const plan = buildImagePlan(outline, research, '{POST_TYPE}');
console.log(JSON.stringify(plan, null, 2));
// Then: sourceBlogImages(postData, { dryRun: true })
"
```

### Step 8: Schema

```bash
node -e "
const { buildSchemasForPost } = require('./schema-builder');
const schemaHtml = buildSchemasForPost(postData, '{POST_TYPE}');
console.log(schemaHtml);
"
```

Builds FAQPage + ItemList + Article + BreadcrumbList (varies by post type).

### Step 9: QC Validation (54-Point)

```bash
node -e "
const { validateBlogPost } = require('./blog-qc-validator');
const result = validateBlogPost(postData, '{POST_TYPE}');
console.log(JSON.stringify(result, null, 2));
"
```

54 checks across 7 domains: Voice/Style (12), Structure (10), Linking (8), Yoast (8), Images (6), YMYL (5), Hard Limits (5).

**If QC fails:** Fix errors and re-validate. Max 3 retry attempts. Route failures to responsible stage:
- A01-A12 (voice/style) → re-draft
- B13-B22 (structure) → re-draft
- C23-C30 (linking) → re-link
- E39-E44 (images) → re-source images
- G50-G54 (hard limits) → fix manually

**If QC passes:** Move to fact-check.

### Step 10: Fact-Check

```bash
node -e "
const { extractClaims, buildFactCheckLog, validateFactCheckLog } = require('./fact-checker');
const claims = extractClaims(linkedHtml);
console.log('Claims found:', claims.length);
// Build log, validate gate
"
```

The fact-check log MUST exist and pass validation before publishing. No override.

### Step 11: Publish (as WP Draft)

```bash
node -e "
const { publishBlogPost } = require('./blog-publisher');
publishBlogPost(postData).then(r => console.log(JSON.stringify(r, null, 2)));
"
```

Always pushes as WordPress draft (status: 'draft'). Ryan reviews and publishes manually from WP admin.

### Step 12: Post-Publish (within 24h)

Run retrofit-links to find older posts that should now link to the new post:

```bash
node -e "
const { retrofitLinks } = require('./retrofit-linker');
retrofitLinks('{SLUG}', { dryRun: true }).then(r => console.log(r.report));
"
```

Always dry-run first. Ryan reviews proposals before applying.

---

## Using the Orchestrator (Automated)

For the full automated pipeline with QC retry loop:

```bash
node blog-orchestrator.js produce /path/to/brief.json [--live]
```

Or resume a stopped pipeline:

```bash
node blog-orchestrator.js resume best-padel-courts-birmingham-2026
```

The orchestrator handles all stages, saves state to `data/pipeline-ledger/{slug}.json`, and retries up to 3 times on QC failure.

---

## Output Format

After pipeline completes, present results to Ryan:

```
PADELI BLOG POST: {Title}
Mode: DRY RUN / LIVE
Type: {post_type} ({tier})
Market: {market}

Research: complete ({N} venues / {N} products verified)
Outline: {N} H2 sections, {N} H3 subsections
Draft: {word_count} words ({target range})
Linking: {N} internal links applied ({funnel position})
Images: {N} sourced ({N} gaps)
Schema: {schema types applied}
QC: PASSED / FAILED ({N} errors, {N} warnings) — attempt {N}/3
Fact-check: {N} claims verified, log at {path}
Publish: pushed as WP draft (ID: {N})

DA paragraph: "{the DA paragraph}"

Warnings:
- {any QC warnings}
```

---

## Batch Mode

For multiple posts:

```
/padeli:produce-article batch:
- best padel courts in birmingham 2026, city_listicle, UK
- best padel courts in sheffield 2026, city_listicle, UK
- padel coaching in london 2026, cluster, UK
```

Run each as a separate background agent. Collect results and present a summary table.

---

## Standalone Operations

Individual pipeline stages can be run independently:

```bash
# Research only
node -e "const { buildResearchPrompt } = require('./blog-researcher'); ..."

# Outline only
node -e "const { generateOutline } = require('./outline-generator'); ..."

# QC only
node -e "const { validateBlogPost } = require('./blog-qc-validator'); ..."

# Fact-check only
node lib/fact-checker.js extract /path/to/draft.html
node lib/fact-checker.js validate /path/to/factcheck.md

# Retrofit links
node -e "const { retrofitLinks } = require('./retrofit-linker'); ..."

# Tracker
node blog-tracker.js summary
node blog-tracker.js next
node blog-tracker.js stats

# Orchestrator
node blog-orchestrator.js produce brief.json
node blog-orchestrator.js resume slug
node blog-orchestrator.js status slug
```

---

## Safety Rules

- **Dry-run is ALWAYS the default.** Never push live without explicit confirmation.
- **No banned phrases.** 30-phrase list enforced by QC.
- **No banned sources.** HiDubai, TimeOut, What's On, ProvenExpert never cited.
- **British English for UK/EU/Bali/UAE.** US English for US/Canada only.
- **Every paragraph under 60 words.** Target 30-50.
- **No personal-visit claims.** "Reviewers describe" not "we played at".
- **Fact-check log is mandatory.** No log, no publish. No override.
- **QC max 3 retries.** After 3 failures, stop and flag for manual review.
- **Retrofit-links: review proposals before applying.** Dry-run first for retrofits only (modifying existing live posts).

---

## Dependencies

- Node.js v24+ (native fetch, no npm packages)
- Modules at `repo root, all bundled `:

| Module | Exports | What it does |
|--------|---------|-------------|
| `wp-client.js` | 6 | Shared WP REST client |
| `config.js` | 12 | Constants, banned phrases, post types, targets |
| `utils.js` | 9 | String similarity, word count, HTML strip, slugify |
| `blog-researcher.js` | 11 | 8-phase research prompt builder + report parser |
| `outline-generator.js` | 11 | 5 blueprint types + FAQ/DA generation |
| `draft-writer.js` | 14 | Writing prompt builder + output validator |
| `linker.js` | 15 | Funnel-aware linking + 30/50/20 anchor variation |
| `blog-publisher.js` | 15 | WP REST push + Gutenberg block builders |
| `blog-image-sourcer.js` | 14 | 3-tier waterfall + per-type image rules |
| `fact-checker.js` | 11 | 3-pass verification + log builder/validator |
| `schema-builder.js` | 11 | FAQPage, ItemList, Article, HowTo, Breadcrumb JSON-LD |
| `blog-tracker.js` | 19 | JSON production tracker (replaces Excel) |
| `retrofit-linker.js` | 10 | Post-publish corpus link scan |
| `blog-orchestrator.js` | 7 | Master controller + QC retry loop + resumable ledger |
| `blog-qc-validator.js` | 9 | 54-point QC across 7 domains |

- Env vars:
  - `PADELI_WP_USER` — WP username
  - `PADELI_WP_APP_PASSWORD` — WP app password
  - `GOOGLE_PLACES_API_KEY` — for image sourcing
  - Posts always created as WP drafts — Ryan publishes manually from admin

---

## SOP Reference

Full SOPs at: `04_Ventures/padeli/bundles/blog-seo-sop/raw/`

### Production Pipeline (how to write)

| File | Contents |
|------|---------|
| 00-START-HERE.md | Quick start |
| 01-SYSTEM-OVERVIEW.md | Architecture overview |
| 03-CITY-RESEARCH-WORKFLOW.md | 8-phase research runbook |
| 04-PRODUCTION-PIPELINE.md | 6-stage pipeline runbook |
| 05-SKILLS-REFERENCE.md | All skills and sub-agents |
| 06-IMAGE-SOURCING.md | Per-type image rules |
| 07-FACT-CHECKING.md | 3-pass verification protocol |
| 08-PUBLISHING-CHECKLIST.md | 54-point QC checklist |
| 09-POST-PUBLISH-OPTIMISATION.md | Retrofit + maintenance |
| 10-TROUBLESHOOTING.md | Common issues + fixes |

### Content Domination Plan (what to write + strategy)

| File | Contents |
|------|---------|
| 00_Padeli_Content_Domination_Strategy.md | Master strategy — 5 markets, 270 posts, revenue flywheel, attack order |
| 01_Content_Audit_April_2026.xlsx | Quality state of 133 live posts |
| 02_Competitor_SERP_GEO_Analysis.md | Competitor SERP positions + 8 LLM citation patterns |
| 03_Keyword_Universe.xlsx | 116 priority keywords — market, pillar, tier, wave, intent, volume |
| 04_Pillar_Architecture_SEO_GEO_Strategy.md | 5-hub pillar model, 3-tier graph, linking rules, schema, taxonomy |
| 05_Master_Blog_Plan_90_Day.xlsx | 270 posts with row-by-row briefs and target dates |
| 06_Agent_Assessment_And_Gap_Analysis.md | Agent inventory + 5 new components needed |
| 07_Agent_Spec_Pack.md | Full SKILL.md specs for all 18 components |
| 08_Resumable_Engine_Design.md | Tick-based engine, state ledger, priority table |
| 09_Critical_Review_And_Gap_Analysis.md | 8 critical gaps identified + recommended fixes |

### Using the Strategy Layer

When selecting a topic for a new post:
1. Check `03_Keyword_Universe.xlsx` for approved keywords (Status = Approved)
2. Check `05_Master_Blog_Plan_90_Day.xlsx` for the next scheduled post
3. Consult `04_Pillar_Architecture_SEO_GEO_Strategy.md` for pillar placement + linking rules
4. Check `02_Competitor_SERP_GEO_Analysis.md` for current competitor positions on the target keyword

### The 5 Pillars (from Pillar Architecture)

| Pillar | Type | Query Archetype |
|--------|------|----------------|
| Gear | Revenue (affiliate) | "best padel racket under £X" |
| Location | Revenue (directory) | "best padel clubs in [city]" |
| Coaching | Revenue (directory) | "best padel coaches in [city]" |
| Technique | Authority (LLM citation) | "how to hit a bandeja" |
| Lifestyle | Authority (domain authority) | "padel vs pickleball" |

### The 3-Tier Content Graph

| Tier | Count Target | Word Count | Internal Links In |
|------|-------------|-----------|------------------|
| Cornerstone | ~60 site-wide | 2,500-4,500 | 15-25 |
| Cluster | 100-250 | 1,200-2,000 | 8-15 |
| Leaf | unlimited | 800-1,500 | 5-10 |
