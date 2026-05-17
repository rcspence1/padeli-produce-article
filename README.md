# Padeli Produce Article

Full BPA-quality blog post production pipeline for [padeli.com](https://padeli.com).
10-stage research-to-publish flow: strategy → research → outline → draft → linking
→ images → schema → QC → fact-check → WordPress publish.

## The 10 Stages

| # | Stage | What happens |
|--:|---|---|
| 1 | Strategy | Topic selection, target keyword, length, intent |
| 2 | Research | Deep multi-source research with citations |
| 3 | Outline | Heading structure, section briefs |
| 4 | Draft | Full article body in BPA voice |
| 5 | Linking | Apply internal + external links via the link graph |
| 6 | Images | Source images (Google Places, Unsplash, generation) |
| 7 | Schema | Build JSON-LD (Article, FAQ, BreadcrumbList) |
| 8 | QC | 54-point quality validator (voice, structure, links, images, YMYL) |
| 9 | Fact-check | Verify claims against sources, log to fact-check ledger |
| 10 | Publish | Push to WordPress as draft, return WP post ID |

Each stage writes to a resumable ledger — if any stage fails, the pipeline
restarts from that point without redoing earlier work.

## Quick Start

```bash
git clone https://github.com/rcspence1/padeli-produce-article.git
cd padeli-produce-article

# Required env in ~/.zshrc
export PADELI_WP_USER="..."
export PADELI_WP_APP_PASSWORD="..."
export GOOGLE_PLACES_API_KEY="..."   # for the image-sourcer stage
export NOTION_API_KEY="..."          # for blog-tracker

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
