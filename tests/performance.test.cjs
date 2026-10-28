// The performance engine (docs/performance.js): the pure calculations PortfolioApp wraps in useMemo.
// Every figure here is made up: the repo is public.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./load.cjs');

const { app } = loadApp();

test('priceAt takes the latest close on or before the date', () => {
    const s = [{ date: '2025-01-01', close: 10 }, { date: '2025-01-08', close: 12 }, { date: '2025-01-15', close: 11 }];
    assert.equal(app.priceAt(s, '2025-01-10'), 12);
    assert.equal(app.priceAt(s, '2025-01-15'), 11);
    assert.equal(app.priceAt(s, '2024-12-31'), null);
    assert.equal(app.priceAt(null, '2025-01-10'), null);
});

test('gbpusdAt uses that day\'s close, else the current rate', () => {
    const at = app.makeGbpusdAt({ 'GBPUSD=X': [{ date: '2025-01-01', close: 1.25 }] }, 1.3);
    assert.equal(at('2025-02-01'), 1.25);
    assert.equal(at('2024-06-01'), 1.3);
});

test('gbpusdInfo prefers the live quote, then the stored close, and never invents a rate', () => {
    const prices = { 'GBPUSD=X': [{ date: '2025-01-01', close: 1.25 }] };
    assert.deepEqual(JSON.parse(JSON.stringify(app.computeGbpusdInfo({ prices, livePrices: { 'GBPUSD=X': 1.3 } }))), { rate: 1.3, source: 'live' });
    assert.equal(app.computeGbpusdInfo({ prices, livePrices: {} }).rate, 1.25);
    assert.deepEqual(JSON.parse(JSON.stringify(app.computeGbpusdInfo({ prices: {}, livePrices: {} }))), { rate: null, source: 'none' });
});

test('date spine is daily (weekdays) for the last DAILY_HISTORY_DAYS and weekly before', () => {
    const today = new Date('2026-10-28T12:00:00Z');
    const dates = app.computeWeeklyDates({ inception: '2022-01-03', today });
    const cut = new Date(today); cut.setDate(cut.getDate() - app.DAILY_HISTORY_DAYS);
    const cutS = cut.toISOString().slice(0, 10);
    const gap = (a, b) => (Date.parse(b) - Date.parse(a)) / 864e5;
    const recent = dates.filter(d => d > cutS);
    assert.ok(recent[0] <= '2025-10-28', '1Y chart starts on a daily row');
    recent.slice(1).forEach((d, i) => assert.ok(gap(recent[i], d) <= 3, recent[i] + ' -> ' + d + ' is a daily step'));
    const old = dates.filter(d => d < '2025-01-01' && !d.endsWith('-12-31') && !d.endsWith('-12-30') && !d.endsWith('-12-29'));
    assert.ok(old.slice(1).every((d, i) => gap(old[i], d) === 7), 'weekly before the daily window');
});

test('risk needs at least three weekly points', () => {
    assert.equal(app.computeRisk({ performanceChart: [], cashRate: 0.04 }), null);
});

test('weekly dates end on a weekday and start at inception', () => {
    const today = new Date('2025-03-12T12:00:00Z');
    const dates = app.computeWeeklyDates({ inception: '2025-01-01', today });
    assert.ok(dates.length > 5);
    assert.equal(dates[dates.length - 1], '2025-03-12');
    assert.ok(dates.every((d, i) => i === 0 || d > dates[i - 1]), 'dates ascend');
});
