/**
 * Unit tests for affiliate-linker.js
 *
 * Fixture: test/fixtures/best-padel-rackets-uk-2026.html — the rendered body
 * of https://padeli.com/best-padel-rackets-uk-2026/ fetched via the public
 * REST API (GET /wp-json/wp/v2/posts?slug=best-padel-rackets-uk-2026&_fields=content).
 *
 * Run: node --test test/
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  applyAffiliateLinks,
  loadAffiliateConfig,
  classifyHref,
  normaliseMarket,
  partnersForMarket,
  suggestProductSlug,
  productFromHeading,
  rewriteAnchor,
} = require('../affiliate-linker');

const FIXTURE = path.join(__dirname, 'fixtures', 'best-padel-rackets-uk-2026.html');
const fixtureHtml = fs.readFileSync(FIXTURE, 'utf8');
const BRIEF_GB = { market: 'UK', focus_keyword: 'best padel rackets uk 2026', post_type: 'product_listicle', tier: 'cornerstone' };

const MONEY_HOST_RE = /href="[^"]*(?:awin1\.com|dpbolvw\.net|padelnuestro\.com|padelmarket\.com|decathlon\.|amazon\.)/i;

function countRaw(html) {
  return (html.match(/<a\s[^>]*href="[^"]*(?:awin1\.com|dpbolvw\.net|padelnuestro\.com|padelmarket\.com|decathlon\.|amazon\.)[^"]*"/gi) || []).length;
}

test('fixture: raw retailer/affiliate links become [geo_link], boxes + disclosure added', () => {
  const before = countRaw(fixtureHtml);
  assert.equal(before, 16, 'fixture has 16 money links');

  const { html, report } = applyAffiliateLinks(fixtureHtml, BRIEF_GB);

  assert.equal(report.skipped_reason, null);
  assert.equal(report.market, 'GB');
  assert.ok(report.partners_for_market.includes('padel-nuestro'));
  assert.equal(report.links_converted, 16);
  assert.equal(countRaw(html), 0, 'no raw money links remain');
  assert.ok(!MONEY_HOST_RE.test(html));
  assert.equal((html.match(/\[geo_link slug="/g) || []).length, 16);

  // boxes: 7 product sections, cap = floor(words/1000 * 2)
  assert.equal(report.boxes_cap, Math.floor((report.word_count / 1000) * 2));
  assert.equal(report.boxes_added, Math.min(7, report.boxes_cap));
  assert.equal((html.match(/\[geo_box /g) || []).length, report.boxes_added);

  // disclosure exactly once (the fixture already had an untagged one)
  assert.equal((html.match(/affiliate-disclosure/g) || []).length, 1);
  assert.equal(report.disclosure, 'tagged_existing');

  // never inside headings
  for (const m of html.matchAll(/<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/gi)) {
    assert.ok(!/\[geo_/.test(m[1]), `shortcode inside heading: ${m[1]}`);
  }

  // every product in the fixture lacks a plugin slug today
  const names = report.products_without_slug.map(p => p.suggested_slug);
  for (const s of ['nox-at10-genius-18k-alum', 'wilson-optix-v1', 'head-coello-vibe', 'bullpadel-vertex-05', 'bullpadel-elite-w']) {
    assert.ok(names.includes(s), `expected ${s} in products_without_slug`);
  }
  // body-text detection must not bleed across sentence ends
  assert.ok(!names.some(s => /-advanced$|-how$/.test(s)), names.join(','));
  assert.ok(report.brand_mentions.Bullpadel > 0);
});

test('idempotent: second run changes nothing', () => {
  const first = applyAffiliateLinks(fixtureHtml, BRIEF_GB);
  const second = applyAffiliateLinks(first.html, BRIEF_GB);
  assert.equal(second.html, first.html);
  assert.equal(second.report.links_converted, 0);
  assert.equal(second.report.boxes_added, 0);
  assert.equal(second.report.disclosure, 'present');
});

test('market gate: no partner for ID strips every money link and box', () => {
  const monetised = applyAffiliateLinks(fixtureHtml, BRIEF_GB).html;
  for (const input of [fixtureHtml, monetised]) {
    const { html, report } = applyAffiliateLinks(input, { market: 'Bali', focus_keyword: 'best padel rackets bali' });
    assert.equal(report.skipped_reason, 'no_partner_for_market');
    assert.ok(report.links_stripped >= 16);
    assert.equal(countRaw(html), 0);
    assert.ok(!/\[geo_(?:link|box)/.test(html));
    assert.ok(!/affiliate-disclosure/.test(html));
    // anchor text survives as plain text
    assert.ok(/£205\.99/.test(html));
  }
  assert.equal(applyAffiliateLinks(fixtureHtml, {}).report.skipped_reason, 'unknown_market');
});

test('known product slug from config is used for links and box in that section', () => {
  const cfg = JSON.parse(JSON.stringify(loadAffiliateConfig()));
  cfg.products['nox-at10-genius-18k-alum'] = { name: 'NOX AT10 Genius 18K Alum', brand: 'Nox', category: 'racket' };
  const { html, report } = applyAffiliateLinks(fixtureHtml, BRIEF_GB, { config: cfg });
  const nox = report.conversions.find(c => /NOX AT10/.test(c.section));
  assert.equal(nox.slug, 'nox-at10-genius-18k-alum');
  assert.equal(nox.slug_reason, 'product');
  assert.ok(html.includes('[geo_box slug="nox-at10-genius-18k-alum"'));
  assert.ok(!report.products_without_slug.some(p => p.suggested_slug === 'nox-at10-genius-18k-alum'));
  // other sections still fall back to the category slug
  const wilson = report.conversions.find(c => /Wilson/.test(c.section));
  assert.equal(wilson.slug, 'padel-rackets-shop');
  assert.equal(wilson.slug_reason, 'category');
});

test('links inside headings become plain text; boxes respect the per-1000-word cap', () => {
  const para = '<p>' + 'word '.repeat(240) + '</p>';
  const html = [
    '<h2>1. Bullpadel Vertex 05: <a href="https://www.padelnuestro.com/uk/x">buy</a></h2>',
    para,
    '<h2>2. Siux Diablo 12</h2>',
    para,
    '<p><a href="https://www.decathlon.co.uk/p/kuikma-pr-990">£59.99 at Decathlon</a></p>',
    '<h2>3. Head Coello Pro</h2>',
    para,
  ].join('\n');
  const { html: out, report } = applyAffiliateLinks(html, { market: 'GB', focus_keyword: 'best padel rackets' });
  assert.equal(report.links_in_headings_unlinked, 1);
  assert.ok(/<h2>1\. Bullpadel Vertex 05: buy<\/h2>/.test(out));
  assert.equal(report.links_converted, 1);
  // ~725 words -> cap floor(0.725*2) = 1, three product sections -> 1 box
  assert.equal(report.boxes_cap, 1);
  assert.equal(report.boxes_added, 1);
  // Siux is a boutique brand in GB -> boutique-rackets-uk for its box is only used when it has the box; first section wins the cap
  assert.ok(out.includes('[geo_box slug="padel-rackets-shop" title="Bullpadel Vertex 05"'));
  assert.equal(report.disclosure, 'added');
  assert.equal((out.match(/affiliate-disclosure/g) || []).length, 1);
});

test('Gutenberg: box is wrapped in a wp:shortcode block and sits before the next wp:heading', () => {
  const html = [
    '<!-- wp:heading -->', '<h2 class="wp-block-heading">1. Wilson Optix V1: best for beginners</h2>', '<!-- /wp:heading -->',
    '<!-- wp:paragraph -->', '<p>' + 'Great racket. ' + 'word '.repeat(600) + '</p>', '<!-- /wp:paragraph -->',
    '<!-- wp:heading -->', '<h2 class="wp-block-heading">Verdict</h2>', '<!-- /wp:heading -->',
    '<!-- wp:paragraph -->', '<p>Buy it <a href="https://www.padelmarket.com/en-gb/products/wilson-optix-v1">from Padel Market</a>.</p>', '<!-- /wp:paragraph -->',
  ].join('\n');
  const { html: out, report } = applyAffiliateLinks(html, { market: 'GB', focus_keyword: 'padel rackets' });
  assert.equal(report.boxes_added, 1);
  assert.match(out, /<!-- \/wp:paragraph -->\n\n<!-- wp:shortcode -->\n\[geo_box slug="padel-rackets-shop" title="Wilson Optix V1" text="Great racket\." button="Check price at"\]\n<!-- \/wp:shortcode -->\n<!-- wp:heading -->\n<h2 class="wp-block-heading">Verdict/);
  assert.ok(out.includes('[geo_link slug="padel-rackets-shop"]Check today\'s price[/geo_link]'));
  assert.ok(out.includes('<!-- wp:paragraph {"className":"affiliate-disclosure"} -->'));
});

test('helpers: classifyHref, normaliseMarket, partnersForMarket, slugs, anchors', () => {
  const cfg = loadAffiliateConfig();
  const awin = classifyHref('https://www.awin1.com/cread.php?awinmid=24562&amp;awinaffid=2861339&amp;ued=https%3A%2F%2Fpadelmarket.com%2Fen-gb%2Fproducts%2Fx', cfg);
  assert.equal(awin.kind, 'network');
  assert.equal(awin.network, 'Awin');
  assert.equal(awin.retailer_host, 'padelmarket.com');
  assert.equal(awin.partner.id, 'padel-market');
  const cj = classifyHref('https://www.dpbolvw.net/click-1-2?url=https%3A%2F%2Fwww.padelnuestro.com%2Fuk%2Fy', cfg);
  assert.equal(cj.network, 'CJ');
  assert.equal(cj.destination, 'https://www.padelnuestro.com/uk/y');
  assert.equal(classifyHref('https://www.amazon.co.uk/dp/B0', cfg).kind, 'retailer');
  assert.equal(classifyHref('https://padeli.com/brands/nox/', cfg).kind, null);
  assert.equal(classifyHref('https://www.lta.org.uk/padel', cfg).kind, null);

  assert.equal(normaliseMarket('UK', cfg), 'GB');
  assert.equal(normaliseMarket('bali', cfg), 'ID');
  assert.equal(normaliseMarket('es', cfg), 'ES');
  assert.equal(normaliseMarket('', cfg), null);

  const ids = (cc) => partnersForMarket(cc, cfg).map(p => p.id);
  assert.ok(ids('GB').includes('padeldogs'));
  assert.ok(!ids('GB').includes('decathlon-uk'), 'pending partners do not count');
  assert.deepEqual(ids('AU'), ['adidas-au']);
  assert.deepEqual(ids('AE'), []);
  assert.deepEqual(ids('SG'), []);
  assert.ok(ids('US').includes('padel-market'));
  assert.ok(ids('SE').includes('munich-sport'));

  assert.equal(suggestProductSlug('NOX AT10 Genius 18K Alum 2026', cfg), 'nox-at10-genius-18k-alum');
  assert.equal(suggestProductSlug('adidas Metalbone 3.4', cfg), 'adidas-metalbone-3-4');
  assert.deepEqual(productFromHeading('3. Head Coello Vibe 2026: best under £100', cfg), { name: 'Head Coello Vibe 2026', brand: 'Head' });
  assert.equal(productFromHeading('How to choose the right racket', cfg), null);
  assert.equal(productFromHeading('Where to buy padel rackets in the UK', cfg), null);

  assert.equal(rewriteAnchor('£205.99 at Padel Market', cfg), "Check today's price (£205.99 when we checked)");
  assert.equal(rewriteAnchor('Padel Nuestro', cfg), "Check today's price");
  assert.equal(rewriteAnchor('2025 Elite W', cfg), '2025 Elite W');
  assert.equal(rewriteAnchor('See the full range at Decathlon', cfg), 'See the full range');
});
