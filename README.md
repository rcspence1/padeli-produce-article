# Padeli Produce Article

Full BPA-quality blog post production pipeline for [padeli.com](https://padeli.com).
11-stage research-to-publish flow: strategy → research → outline → draft → linking
→ affiliate → images → schema → QC → fact-check → WordPress publish.

## The 11 Stages

| # | Stage | What happens |
|--:|---|---|
| 1 | Strategy | Topic selection, target keyword, length, intent |
| 2 | Research | Deep multi-source research with citations |
| 3 | Outline | Heading structure, section briefs |
| 4 | Draft | Full article body in BPA voice |
| 5 | Linking | Internal links via the link graph + cluster targeting (UP / ACROSS / DOWN) |
| 6 | Affiliate | Retailer links → `[geo_link]`, one `[geo_box]` per product section, disclosure, market gate |
| 7 | Images | Source images (Google Places, Unsplash, generation) |
| 8 | Schema | Build JSON-LD (Article, FAQ, BreadcrumbList) |
| 9 | QC | 54-point quality validator (voice, structure, links, images, YMYL) |
| 10 | Fact-check | Verify claims against sources, log to fact-check ledger |
| 11 | Publish | Push to WordPress as draft, return WP post ID |

Each stage writes to a resumable ledger — if any stage fails, the pipeline
restarts from that point without redoing earlier work.

## Cadence

Start at **10–15 posts per week** across all markets, buyer-intent equipment
posts first (see `04_Ventures/padeli/affiliate-machine/raw/2026-10-01-affiliate-plan-oct-2026.md`
section 3 for the priority order). Increase only once the QC pass rate on first
attempt is above 80% and the post-publish crawler shows no regressions.

## Data directory

All persisted state (pipeline ledger, tracker cache + backups, image gaps log,
`page_index.json`, Notion DB caches) lives under one directory:

```
$PADELI_BLOG_DATA_DIR        # if set
<repo>/data                  # otherwise (git-ignored)
```

It is created on first use. Set the env var when you want several checkouts to
share one ledger. `config.js` exports `DATA_DIR`, `ensureDataDir()`, `dataPath()`.

## Affiliate stage

Config: [`config/affiliate.json`](./config/affiliate.json) — partners (network,
countries, commission, status), affiliate-network hosts (Awin `ued=`, CJ `url=`),
retailer hosts, brands, the geo slugs that exist in the Padeli Geo Links plugin
(`padel-rackets-shop`, `boutique-rackets-uk`, `padel-shoes-shop`,
`court-shoes-oceania`), product slugs (`<brand>-<model>` kebab), and rules.

Behaviour (`affiliate-linker.js`, idempotent):

1. **Market gate** — the post's market (`brief.country_code || brief.market`)
   must be covered by at least one *approved* partner. If not, every money link
   is turned into plain text, boxes and disclosure are removed, and the ledger
   records `affiliate.skipped_reason = "no_partner_for_market"`.
2. Raw retailer / Awin / CJ links → `[geo_link slug="…"]anchor[/geo_link]`.
   Anchors that name a retailer ("£205.99 at Padel Market") are rewritten so
   the geo redirect can send readers elsewhere. Links inside headings become
   plain text.
3. At most one `[geo_box slug title text]` per product section (H2/H3 whose
   heading names a brand + model), never more than
   `rules.max_boxes_per_1000_words` (default 2) per 1,000 words.
4. One `<p class="affiliate-disclosure">` after the direct-answer paragraph
   (an existing untagged disclosure is tagged instead of duplicated).
5. Slug choice: product slug from `config.products` if it exists in the plugin,
   else the category slug for the market. Products with no plugin slug are
   listed in `ledger.affiliate.products_without_slug` with a suggested slug and
   the original retailer deep links, so they can be added under
   *Settings → Geo Links* on padeli.com.

```bash
node affiliate-linker.js post.html --market UK --out monetised.html   # summary
node affiliate-linker.js post.html --market UK --json                 # full report
```

## Cluster targeting

Add `cluster` to a brief to link a cluster post UP, ACROSS and DOWN:

```json
"cluster": {
  "city": "Manchester",
  "region_slug": "manchester",
  "cornerstone": "/best-padel-rackets-uk-2026/",
  "max_clubs": 5
}
```

- UP: one early link to the cornerstone.
- ACROSS: one link to `https://padeli.com/clubs/<cc>/<region_slug>/` and links
  to the top 3–5 published club listings in that region (read-only
  `GET /wp-json/wp/v2/listing?region=<term id>&status=publish`, ordered by
  `_google_review_count` desc, then date). Clubs not mentioned in the body are
  listed in a "Where to play in {city}" block before Related Reading.
- DOWN: leaves via existing `[PLANNED:/slug/]` markers.

## Tests

```bash
node --test test/*.test.js
```

`test/fixtures/best-padel-rackets-uk-2026.html` is the rendered body of the live
post (public REST GET), used to prove the affiliate stage is idempotent.

## Quick Start

```bash
git clone https://github.com/rcspence1/padeli-produce-article.git
cd padeli-produce-article

# Required env in ~/.zshrc
export PADELI_WP_USER="..."
export PADELI_WP_APP_PASSWORD="..."
export GOOGLE_PLACES_API_KEY="..."   # for the image-sourcer stage
export NOTION_API_KEY="..."          # for blog-tracker
export PADELI_BLOG_DATA_DIR="..."    # optional — defaults to <repo>/data

# Run the full pipeline for one topic
node blog-orchestrator.js produce "Best Padel Rackets UK 2026"

# Resume a failed pipeline run
node blog-orchestrator.js resume <ledger-id>
```

Full skill spec: [`SKILL.md`](./SKILL.md).

## Requirements

- Node.js v24+ (native `fetch`, zero external deps)
- WordPress REST API credentials for padeli.com
- Google Places API key (for image sourcing)
- Notion API key (for blog tracker)
