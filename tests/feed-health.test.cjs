// Price-feed health (docs/app.js feedBanner): the strip at the top of Investments when Yahoo prices stop arriving.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./load.cjs');

const { app } = loadApp();
const MIN = 60000, HOUR = 60 * MIN;
const NOW = Date.UTC(2026, 9, 22, 12, 0, 0);
const plain = x => JSON.parse(JSON.stringify(x));
const step = (h, ev, at) => plain(app.feedHealthNext(h, ev, at));

test('feed health: nothing to say while prices arrive, or before any ever did', () => {
    assert.equal(app.feedBanner(null, NOW), null);
    assert.equal(app.feedBanner({ okAt: null, failAt: NOW - HOUR, fresh: 0, requested: 0 }, NOW), null);      // a fresh install that has never had prices
    let h = step(null, { ok: true, fresh: 12, requested: 12 }, NOW - 5 * MIN);
    assert.equal(app.feedBanner(h, NOW), null);
    h = step(h, { ok: false }, NOW - MIN);                                                                  // one failed poll just now is not an outage
    assert.equal(app.feedBanner(h, NOW), null);
});

test('feed health: amber once the last success is 30 minutes old and a later attempt failed, red after a day', () => {
    let h = step(null, { ok: true, fresh: 12, requested: 12 }, NOW - 40 * MIN);
    h = step(h, { ok: false }, NOW - 10 * MIN);
    const amber = app.feedBanner(h, NOW);
    assert.equal(amber.level, 'amber');
    assert.match(amber.text, /haven.t updated since \d\d:\d\d\./);
    const old = step(step(null, { ok: true, fresh: 12, requested: 12 }, NOW - 30 * HOUR), { ok: false }, NOW - MIN);
    assert.equal(app.feedBanner(old, NOW).level, 'red');
    assert.match(app.feedBanner(old, NOW).text, /since \w{3} \d{1,2} \w{3} \d\d:\d\d\./);
});

test('feed health: a success clears the strip, and a refresh that came back with gaps gets its own', () => {
    let h = step(null, { ok: true, fresh: 12, requested: 12 }, NOW - 3 * HOUR);
    h = step(h, { ok: false }, NOW - 2 * HOUR);
    assert.ok(app.feedBanner(h, NOW));
    h = step(h, { ok: true, fresh: 12, requested: 12 }, NOW - MIN);
    assert.equal(app.feedBanner(h, NOW), null);
    const gaps = step(h, { ok: true, fresh: 3, requested: 12 }, NOW);
    assert.equal(app.feedBanner(gaps, NOW).text, 'Yahoo sent prices for only 3 of 12 holdings; the rest are the last prices.');
    assert.equal(app.feedBanner(step(h, { ok: true, fresh: 6, requested: 12 }, NOW), NOW), null);          // half is fine
    assert.equal(app.feedBanner(step(h, { ok: true, fresh: 1, requested: 3 }, NOW), NOW), null);           // too few holdings to judge
});
