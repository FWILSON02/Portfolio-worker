// Maturity alerts (docs/balances.js): which dates alert, when they turn red, and closing them.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./load.cjs');

const { estate: E } = loadApp();
const plain = x => JSON.parse(JSON.stringify(x));
const TODAY = '2026-10-19';

test('alertStage: amber from the lead time, red for the last days and after, nothing once long gone', () => {
    assert.equal(E.alertStage('mortgage', 91), null);
    assert.equal(E.alertStage('mortgage', 90), 'amber');
    assert.equal(E.alertStage('mortgage', 15), 'amber');
    assert.equal(E.alertStage('mortgage', 14), 'red');
    assert.equal(E.alertStage('gilt', 0), 'red');
    assert.equal(E.alertStage('gilt', -1), 'red');      // stays until closed
    assert.equal(E.alertStage('gilt', -90), 'red');
    assert.equal(E.alertStage('gilt', -91), null);     // an old plan row never wakes up
    assert.equal(E.alertStage('vest', 31), null);
    assert.equal(E.alertStage('vest', 30), 'amber');
    assert.equal(E.alertStage('vest', 7), 'red');
    assert.equal(E.alertStage('saver', 30), 'amber');
});

test('estateAlerts: mortgage deal end and fixed-term saver end, soonest first', () => {
    const state = { accounts: [
        { id: 'm', name: 'Mortgage', group: 'property', debt: true, loan: { end: '2027-01-01' } },
        { id: 's', name: 'Fixed Saver', group: 'savings', term: { start: '2025-10-28', end: '2026-10-28', rate: 4.6, amount: 15000 } },
        { id: 'far', name: 'Later Saver', group: 'savings', term: { start: '2026-01-01', end: '2027-06-01', rate: 4, amount: 1000 } },
        { id: 'old', name: 'Old Mortgage', group: 'property', debt: true, closed: true, loan: { end: '2026-11-01' } },
    ], snapshots: [] };
    const a = plain(E.estateAlerts(state, TODAY));
    assert.deepEqual(a.map(x => [x.title, x.stage, x.when]), [
        ['Fixed Saver matures in 9 days', 'red', 'Wed 28 Oct'],
        ['Mortgage deal ends in 74 days', 'amber', 'Fri 1 Jan 2027'],
    ]);
    assert.ok(a[0].parts[1].gbp > 15600 && a[0].parts[1].gbp < 15800);   // grown at 4.6% AER for a year
    assert.equal(a[1].id, 'mortgage:m:2027-01-01');
});

test('investmentAlerts: held gilts, vest tranches on one day grouped, finished plans skipped', () => {
    const gilts = [
        { ticker: 'T26A', name: 'Treasury 0.375% 22/10/2026', nominal: 10000, maturity: '2026-10-22' },
        { ticker: 'TN28', name: 'Treasury 0.125% 31/01/2028', nominal: 5000, maturity: '2028-01-31' },
        { ticker: 'SOLD', name: 'x', nominal: 0, maturity: '2026-10-25' },
    ];
    const plans = [
        { plan_id: 'c1', institution: 'Citi', restricted_category: 'RSU', status: 'ACTIVE', current_units: 100, maturity_vesting_date: '2026-11-13' },
        { plan_id: 'c2', institution: 'Citi', restricted_category: 'RSU', status: 'ACTIVE', current_units: 40, maturity_vesting_date: '2026-11-13' },
        { plan_id: 'c3', institution: 'Citi', restricted_category: 'RSU', status: 'CANCELLED', current_units: 40, maturity_vesting_date: '2026-11-01' },
        { plan_id: 'c4', institution: 'Citi', restricted_category: 'RSU', status: 'ACTIVE', current_units: 50, maturity_vesting_date: '2027-03-01' },
        { plan_id: 'h1', institution: 'HSBC', restricted_category: 'SAYE', status: 'ACTIVE', total_target_units: 900, maturity_vesting_date: '2026-10-24' },
        { plan_id: 's1', institution: 'HSBC', restricted_category: 'SIP', status: 'ACTIVE', current_units: 10 },
    ];
    const values = { c1: { valueGBP: 6000, phase: 'RESTRICTED' }, c2: { valueGBP: 2400, phase: 'RESTRICTED' } };
    const a = plain(E.investmentAlerts(gilts, plans, values, TODAY));
    assert.deepEqual(a.map(x => [x.title, x.stage]), [
        ['Gilt matures in 3 days', 'red'],
        ['HSBC Sharesave matures in 5 days', 'red'],
        ['Citi shares vest in 25 days', 'amber'],
    ]);
    assert.deepEqual(a[2].parts, ['140 shares, about ', { gbp: 8400 }, ' before tax']);
    assert.deepEqual(a[0].parts, [{ gbp: 10000 }, ' back as cash']);
    // A missing value drops the £ figure rather than showing a partial one.
    const b = plain(E.investmentAlerts([], plans, { c1: values.c1 }, TODAY));
    assert.deepEqual(b.find(x => x.kind === 'vest' && /Citi/.test(x.title)).parts, ['140 shares']);
});

test('closing an alert hides it for a week, or for good', () => {
    const id = 'gilt:T26A:2026-10-22';
    E.silenceAlert(id, 'week', TODAY);
    let m = E.readSilence();
    assert.equal(E.silenced(m, id, TODAY), true);
    assert.equal(E.silenced(m, id, '2026-10-25'), true);
    assert.equal(E.silenced(m, id, '2026-10-26'), false);   // a week later it is back
    E.silenceAlert('mortgage:m:2027-01-01', 'never', TODAY);
    m = E.readSilence();
    assert.equal(E.silenced(m, 'mortgage:m:2027-01-01', '2026-12-31'), true);
    assert.equal(E.silenced(m, 'mortgage:m:2027-06-01', '2026-12-31'), false);   // a new deal end alerts again
});

test('after the date: past tense, and cleared once dealt with', () => {
    const state = { accounts: [
        { id: 'm', name: 'Mortgage', group: 'property', debt: true, loan: { end: '2026-10-01' } },
        { id: 's', name: 'Fixed Saver', group: 'savings', term: { start: '2025-10-01', end: '2026-10-10', rate: 4, amount: 1000 } },
        { id: 'd', name: 'Done Saver', group: 'savings', term: { start: '2025-10-01', end: '2026-10-10', rate: 4, amount: 1000 } },
    ], snapshots: [{ date: '2026-09-20', values: { s: 1000, d: 1000 } }, { date: '2026-10-15', partial: true, values: { d: 1041 } }] };
    const a = plain(E.estateAlerts(state, TODAY));
    assert.deepEqual(a.map(x => [x.title, x.stage]), [
        ['Mortgage deal ended 18 days ago', 'red'],
        ['Fixed Saver matured 9 days ago', 'red'],
    ]);   // Done Saver has a balance entered after its end, so it is dealt with
    assert.deepEqual(a[0].parts, ['now on the lender’s variable rate']);
    const v = plain(E.investmentAlerts([{ ticker: 'T', name: 'x', nominal: 100, maturity: '2026-10-18' }], [], null, TODAY));
    assert.equal(v[0].title, 'Gilt matured yesterday');
});

test('Settings → Alerts windows change when an alert starts and how long it stays after', () => {
    const w = { gilt: { before: 30, after: 5 }, vest: { before: 3 } };
    assert.equal(E.alertStage('gilt', 31, w), null);
    assert.equal(E.alertStage('gilt', 30, w), 'amber');
    assert.equal(E.alertStage('gilt', -5, w), 'red');
    assert.equal(E.alertStage('gilt', -6, w), null);
    assert.equal(E.alertStage('vest', 3, w), 'red');            // red never starts before the alert does
    assert.equal(E.alertStage('mortgage', 90, w), 'amber');     // kinds not set keep their defaults
    assert.deepEqual(plain(E.alertWindows(w)).vest, { before: 3, after: 90, red: 3 });
    // Only whole, non-negative days are kept, capped at two years; junk is dropped.
    assert.deepEqual(plain(E.validWindows({ gilt: { before: 12.6, after: -1 }, saver: { before: 5000 }, nope: { before: 1 } })),
        { gilt: { before: 13 }, saver: { before: 730 } });
    assert.equal(E.validWindows({ gilt: { before: 'x' } }), null);
    // Saved with the balances, so the Estate export and backups carry them.
    const st = E.validateState({ accounts: [{ id: 'a', name: 'A', group: 'current' }], snapshots: [], alertWindows: w });
    assert.deepEqual(plain(st.alertWindows), w);
    assert.deepEqual(JSON.parse(E.buildJson(st)).data.alertWindows, w);
    assert.equal('alertWindows' in E.validateState({ accounts: [], snapshots: [] }), false);
    // A state built with them uses them.
    const s2 = Object.assign({}, st, { accounts: [{ id: 'm', name: 'Mortgage', debt: true, loan: { end: '2027-01-01' } }], alertWindows: { mortgage: { before: 30 } } });
    assert.equal(E.estateAlerts(s2, TODAY).length, 0);   // 74 days off, window now 30
});
