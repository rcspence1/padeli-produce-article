/**
 * Unit tests for cluster targeting in linker.js (UP / ACROSS / DOWN).
 * The WP REST fetch is injected so no network is needed.
 *
 * Run: node --test test/
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { applyClusterLinks, fetchRegionClubs, buildClusterTargets } = require('../linker');

const SITE = 'https://padeli.com';

const REGION = [{ id: 203, slug: 'manchester', name: 'Manchester', parent: 285 }];
const LISTINGS = [
  { id: 1, slug: 'pure-padel-manchester', link: `${SITE}/clubs/gb/manchester/pure-padel-manchester/`, title: { rendered: 'Pure Padel Manchester' }, date: '2026-05-01T20:09:46', meta: { _google_review_count: '229', _listing_type: 'clubs' } },
  { id: 2, slug: 'david-lloyd-manchester-trafford', link: `${SITE}/clubs/gb/manchester/david-lloyd-manchester-trafford/`, title: { rendered: 'David Lloyd Manchester Trafford' }, date: '2026-05-01T20:13:18', meta: { _google_review_count: '904', _listing_type: 'clubs' } },
  { id: 3, slug: 'dan-white', link: `${SITE}/coaching/gb/manchester/dan-white/`, title: { rendered: 'Dan White' }, date: '2026-05-27T09:48:49', meta: { _google_review_count: '74', _listing_type: 'coaching' } },
  { id: 4, slug: 'game4padel-thg-smash-manchester', link: `${SITE}/clubs/gb/manchester/game4padel-thg-smash-manchester/`, title: { rendered: 'Game4Padel THG Smash Manchester' }, date: '2026-05-01T20:10:36', meta: { _google_review_count: '', _listing_type: 'clubs' } },
  { id: 5, slug: 'deuce-padel-centre', link: `${SITE}/clubs/gb/manchester/deuce-padel-centre/`, title: { rendered: 'Deuce Padel Centre' }, date: '2026-05-14T10:50:55', meta: { _google_review_count: '142', _listing_type: 'clubs' } },
  { id: 6, slug: 'just-padel-bolton', link: `${SITE}/clubs/gb/manchester/just-padel-bolton/`, title: { rendered: 'Just Padel Bolton' }, date: '2026-05-14T10:50:54', meta: { _google_review_count: '144', _listing_type: 'clubs' } },
  { id: 7, slug: 'the-padel-club-traffordcity', link: `${SITE}/clubs/gb/manchester/the-padel-club-traffordcity/`, title: { rendered: 'The Padel Club TraffordCity' }, date: '2026-05-01T20:10:35', meta: { _google_review_count: '87', _listing_type: 'clubs' } },
];

const calls = [];
async function fakeFetch(url) {
  calls.push(url);
  if (/\/wp\/v2\/region\?slug=manchester/.test(url)) return REGION;
  if (/\/wp\/v2\/listing\?region=203&status=publish/.test(url)) return LISTINGS;
  throw new Error(`unexpected GET ${url}`);
}

const BRIEF = {
  slug: 'best-padel-rackets-manchester-2026',
  market: 'UK',
  post_type: 'cluster',
  tier: 'cluster',
  cluster: { city: 'Manchester', region_slug: 'manchester', cornerstone: '/best-padel-rackets-uk-2026/' },
};

const DRAFT = [
  '<p>Buying a padel racket in Manchester is easier than it was two years ago, with more clubs stocking demo rackets and more shops opening up around the city.</p>',
  '<p>If you want the national picture, our best padel rackets uk guide covers every level and budget in detail, and this page narrows it to what you can try locally.</p>',
  '<h2>Where to try before you buy</h2>',
  '<p>Pure Padel Manchester runs demo sessions on Saturdays, and the pro shop at David Lloyd Manchester Trafford lets members borrow a racket for a full match before deciding.</p>',
  '<p>Most padel clubs in Manchester now keep a small rack of demo rackets behind the desk, so ask when you book, and see [PLANNED:/padel-racket-shapes-explained/] for the basics.</p>',
  '<h2>Related Reading</h2>',
  '<ul><li><a href="https://padeli.com/best-padel-shoes-2026/">Best padel shoes 2026</a></li></ul>',
].join('\n');

test('fetchRegionClubs: clubs only, ordered by review count then date', async () => {
  const { region, clubs } = await fetchRegionClubs('manchester', { fetchJson: fakeFetch });
  assert.equal(region.id, 203);
  // 904, 229, 144, 142, 87, then the one with no review count
  assert.deepEqual(clubs.map(c => c.slug), [
    'david-lloyd-manchester-trafford', 'pure-padel-manchester', 'just-padel-bolton',
    'deuce-padel-centre', 'the-padel-club-traffordcity', 'game4padel-thg-smash-manchester',
  ]);
  assert.ok(!clubs.some(c => /coaching/.test(c.url)));
});

test('buildClusterTargets: cornerstone + region hub URLs', () => {
  const t = buildClusterTargets(BRIEF.cluster, BRIEF);
  assert.equal(t.up.url, `${SITE}/best-padel-rackets-uk-2026/`);
  assert.equal(t.up.focus_keyword, 'best padel rackets uk 2026');
  assert.equal(t.hub.url, `${SITE}/clubs/gb/manchester/`);
  assert.equal(t.hub.city, 'Manchester');
});

test('applyClusterLinks: UP early, ACROSS hub + top clubs, DOWN markers reported, idempotent', async () => {
  const { html, linksApplied, report, clubs } = await applyClusterLinks(DRAFT, BRIEF.cluster, BRIEF, { fetchJson: fakeFetch });

  // UP: one link to the cornerstone, in an early paragraph, exact keyword (no year) with UK casing
  const up = [...html.matchAll(/<a href="https:\/\/padeli\.com\/best-padel-rackets-uk-2026\/">([^<]+)<\/a>/g)];
  assert.equal(up.length, 1);
  assert.equal(up[0][1], 'best padel rackets UK');
  assert.ok(html.indexOf('best-padel-rackets-uk-2026') < html.indexOf('<h2>'), 'cornerstone link appears before the first H2');

  // ACROSS: exactly one hub link, wrapping the natural mention
  const hub = [...html.matchAll(/<a href="https:\/\/padeli\.com\/clubs\/gb\/manchester\/">([^<]+)<\/a>/g)];
  assert.equal(hub.length, 1);
  assert.equal(hub[0][1], 'padel clubs in Manchester');

  // ACROSS: top 5 clubs; 2 wrapped in-text, 3 in the "Where to play" list before Related Reading
  assert.equal(clubs.length, 5);
  assert.ok(html.includes('<a href="https://padeli.com/clubs/gb/manchester/pure-padel-manchester/">Pure Padel Manchester</a>'));
  assert.ok(html.includes('<a href="https://padeli.com/clubs/gb/manchester/david-lloyd-manchester-trafford/">David Lloyd Manchester Trafford</a>'));
  const listIdx = html.indexOf('<h3>Where to play in Manchester</h3>');
  assert.ok(listIdx !== -1 && listIdx < html.indexOf('<h2>Related Reading</h2>'));
  for (const slug of ['just-padel-bolton', 'deuce-padel-centre', 'the-padel-club-traffordcity']) {
    assert.ok(html.includes(`/clubs/gb/manchester/${slug}/`), slug);
  }
  assert.ok(!html.includes('game4padel'), 'sixth club not linked');
  assert.ok(!html.includes('/coaching/'), 'coaching listings never linked');
  assert.equal(linksApplied, 7);

  // no link inside headings, max 1 link per paragraph
  for (const m of html.matchAll(/<h[23]>([\s\S]*?)<\/h[23]>/g)) assert.ok(!/<a /.test(m[1]));
  for (const m of html.matchAll(/<p>([\s\S]*?)<\/p>/g)) assert.ok((m[1].match(/<a /g) || []).length <= 1, m[1]);

  // DOWN: planned marker left for applyInternalLinks
  assert.ok(report.some(r => /DOWN: 1 \[PLANNED/.test(r)));
  assert.ok(html.includes('[PLANNED:/padel-racket-shapes-explained/]'));

  // idempotent
  const again = await applyClusterLinks(html, BRIEF.cluster, BRIEF, { fetchJson: fakeFetch });
  assert.equal(again.html, html);
  assert.equal(again.linksApplied, 0);
});

test('applyClusterLinks: no cluster or fetch failure is non-fatal', async () => {
  const none = await applyClusterLinks(DRAFT, null, BRIEF);
  assert.equal(none.html, DRAFT);
  const failing = async () => { throw new Error('boom'); };
  const r = await applyClusterLinks(DRAFT, { region_slug: 'nowhere', city: 'Nowhere' }, BRIEF, { fetchJson: failing });
  assert.ok(r.report.some(l => /could not fetch clubs/.test(l)));
  assert.equal(r.clubs.length, 0);
});
