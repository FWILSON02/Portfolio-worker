// Life Admin (docs/lifeadmin.js): bills pasted from a spreadsheet, their costs, the Estate mortgage, renewal alerts.
// Every bill here is made up: the repo is public.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./load.cjs');

const { lifeAdmin: L, app } = loadApp();
const plain = x => JSON.parse(JSON.stringify(x));

// The shape of a Bills sheet copied out of Excel: the header has no names over the first two columns, and copying it
// can drop those blank cells, so it is two cells shorter than the rows.
const SHEET = [
    'Account Number\tUser Name\tContract End Date\tAnnual Cost\tMonthly Cost',
    'Mortgage\tNorthbank\t1111222233\t4.1%\t31 December 2030\t£24,000\t£2,000',
    'Energy\tBrightwell\tBW001\temail\t16 August 2027\t£1,800\t',
    'Council Tax\tRiverside\t555\t\t\t£2,400\t',
    'Cleaner \t\t\t\t\t£1,300\t£50',
    'Water\tRiverside Water\t777\temail\t\t£600\t£50',
    'Contents Insurance\tHarbour\tHB-1/2\t\t12 October 2026\t£120\t',
    '\t\t\t\tTotal\t£30,220\t£2,518',
    '\t\t\t\t1\t87%\t£2,000',
].join('\n');
const ESTATE = { accounts: [
    { id: 'mort', name: 'Northbank Mortgage', debt: true, closed: false, link: 'https://bank.example', loan: { payment: 2100, end: '2030-12-31', rate: 4.1, start: '2025-01-01' } },
    { id: 'old', name: 'Old Mortgage', debt: true, closed: true, loan: { payment: 900, end: '2020-01-01' } },
] };

test('parsePaste reads a Bills sheet: header lined up on the right, totals skipped', () => {
    const r = L.parsePaste(SHEET, ESTATE);
    assert.equal(r.rows.length, 6);
    assert.equal(r.skipped, 2);
    const by = Object.fromEntries(r.rows.map(x => [x.bill.name, x.bill]));
    assert.equal(by.Energy.provider, 'Brightwell');
    assert.equal(by.Energy.account, 'BW001');
    assert.equal(by.Energy.username, 'email');
    assert.equal(by.Energy.end, '2027-08-16');
    assert.deepEqual([by.Energy.amount, by.Energy.every], [1800, 'year']);
    assert.equal(by.Energy.category, 'utilities');
    // Annual and monthly agree: monthly. £50 against £1,300 a year: every 2 weeks.
    assert.deepEqual([by.Water.amount, by.Water.every], [50, 'month']);
    assert.deepEqual([by.Cleaner.amount, by.Cleaner.every], [50, '2weeks']);
    assert.equal(by.Cleaner.category, 'services');
    assert.equal(by['Contents Insurance'].category, 'insurance');
    assert.equal(by['Council Tax'].category, 'home');
    // The mortgage follows the open Estate mortgage, and the rate in the user name column is dropped.
    assert.equal(by.Mortgage.estate, 'mort');
    assert.equal(by.Mortgage.username, '');
});

test('parsePaste without a header uses the sheet\'s column order', () => {
    const r = L.parsePaste('Internet\tFibrelink\t123\temail\t26 Dec 2026\t£300\t£25', null);
    assert.equal(r.rows.length, 1);
    assert.deepEqual(plain(r.rows[0].bill), Object.assign(plain(r.rows[0].bill), { name: 'Internet', provider: 'Fibrelink', account: '123', end: '2026-12-26', amount: 25, every: 'month' }));
});

test('parsePaste keeps a pasted hint apart from the bill', () => {
    const r = L.parsePaste('Bill\tProvider\tWebsite\tPassword hint\tAnnual\nPet Insurance\tPaws\tpaws.example\tdog name\t200', null);
    assert.equal(r.rows[0].bill.link, 'https://paws.example');
    assert.equal(JSON.stringify(r.rows[0].bill).includes('dog name'), false);
    assert.deepEqual(plain(r.rows[0].hint), { key: 'paws', hint: 'dog name' });
});

test('parseDate reads UK dates only when real', () => {
    assert.equal(L.parseDate('31 December 2029'), '2029-12-31');
    assert.equal(L.parseDate('2 April 2027'), '2027-04-02');
    assert.equal(L.parseDate('02/04/2027'), '2027-04-02');
    assert.equal(L.parseDate('2027-04-02'), '2027-04-02');
    assert.equal(L.parseDate('31/02/2027'), null);
    assert.equal(L.parseDate('email'), null);
});

test('validLink keeps websites and app addresses, never scripts or plain http', () => {
    assert.equal(L.validLink('example.co.uk'), 'https://example.co.uk');
    assert.equal(L.validLink('https://example.com/login'), 'https://example.com/login');
    assert.equal(L.validLink('shortcuts://run-shortcut?name=X'), 'shortcuts://run-shortcut?name=X');
    assert.equal(L.validLink('javascript://alert(1)'), null);
    assert.equal(L.validLink('http://example.com'), null);
});

test('resolveBill: a bill on the Estate mortgage takes its payment and deal end', () => {
    const b = L.validBill({ name: 'Mortgage', amount: 1, every: 'year', end: '2026-01-01', estate: 'mort' });
    const r = L.resolveBill(b, ESTATE);
    assert.equal(r.amount, 2100);
    assert.equal(r.monthly, 2100);
    assert.equal(r.annual, 25200);
    assert.equal(r.end, '2030-12-31');
    assert.equal(r.provider, 'Northbank Mortgage');
    assert.equal(r.link, 'https://bank.example');
    // Gone from Estate (or closed): its own figures, flagged.
    const gone = L.resolveBill(L.validBill({ name: 'Mortgage', amount: 1200, every: 'month', estate: 'old' }), ESTATE);
    assert.equal(gone.missing, true);
    assert.equal(gone.monthly, 1200);
});

test('totals: per month, per year and per category', () => {
    const bills = L.resolveAll(L.validateState({ bills: [
        { name: 'Energy', amount: 1200, every: 'year' },
        { name: 'Cleaner', amount: 50, every: '2weeks' },
        { name: 'Water', amount: 50, every: 'month' },
        { name: 'Thing' },
    ] }), null);
    const t = L.totals(bills);
    assert.equal(t.count, 4);
    assert.equal(t.annual, 1200 + 1300 + 600);
    assert.ok(Math.abs(t.monthly - 3100 / 12) < 1e-9);
    assert.deepEqual(plain(t.categories.map(c => c.id)), ['utilities', 'services']);
});

test('mergeBills updates a bill with the same name and provider, keeping what the paste left blank', () => {
    const old = [L.validBill({ id: 'a', name: 'Energy', provider: 'Brightwell', account: 'BW001', username: 'me', amount: 100, every: 'month' })];
    const res = L.mergeBills(old, [L.validBill({ name: 'energy', provider: 'BRIGHTWELL', amount: 1500, every: 'year' }), L.validBill({ name: 'Water' })]);
    assert.equal(res.added, 1);
    assert.equal(res.updated, 1);
    assert.equal(res.bills[0].id, 'a');
    assert.equal(res.bills[0].username, 'me');
    assert.deepEqual([res.bills[0].amount, res.bills[0].every], [1500, 'year']);
});

test('validateState drops bills with no name and repairs duplicate ids', () => {
    const s = L.validateState({ bills: [{ id: 'x', name: 'A' }, { id: 'x', name: 'B' }, { name: '' }, null] });
    assert.equal(s.bills.length, 2);
    assert.notEqual(s.bills[0].id, s.bills[1].id);
    assert.equal(L.validateState({ accounts: [] }), null);
});

test('renewalAlerts: a contract end inside the window, not the Estate mortgage', () => {
    const bills = L.resolveAll({ bills: [
        { id: 'c', name: 'Contents Insurance', provider: 'Harbour', amount: 120, every: 'year', end: '2026-11-09' },
        { id: 'f', name: 'Energy', amount: 100, every: 'month', end: '2027-08-16' },
        { id: 'm', name: 'Mortgage', estate: 'mort' },
    ] }, ESTATE);
    const a = plain(L.renewalAlerts(bills, '2026-10-19'));
    assert.equal(a.length, 1);
    assert.equal(a[0].kind, 'renewal');
    assert.equal(a[0].title, 'Contents Insurance contract ends in 21 days');
    assert.equal(a[0].stage, 'amber');
    assert.equal(plain(L.renewalAlerts(bills, '2026-11-05'))[0].stage, 'red');
});

test('cloud backup counts bills, so losing them holds the backup back', () => {
    const before = app.cloudBackupCounts({ lifeAdmin: { bills: [{}, {}] } });
    const now = app.cloudBackupCounts({});
    assert.equal(before.bills, 2);
    assert.match(app.cloudBackupShrink(before, now), /0 Life Admin bills \(the last backup had 2\)/);
});
