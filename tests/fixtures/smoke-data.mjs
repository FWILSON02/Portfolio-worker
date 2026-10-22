// Made-up data for the render smoke test (tests/smoke.test.mjs): a transactions CSV for Investments and a full app
// backup for Estate, Cash Flow and Pay, dated around `today` so every chart and alert has something to draw.
// None of it is real; the repo is public.

const iso = d => d.toISOString().slice(0, 10);
const dmy = d => [d.getUTCDate(), d.getUTCMonth() + 1, d.getUTCFullYear()].map(n => String(n).padStart(2, '0')).join('/');
const addDays = (d, n) => new Date(d.getTime() + n * 864e5);
const addMonths = (d, n) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, Math.min(d.getUTCDate(), 28)));

// Weekday closes for two years: a gentle drift with a wobble, deterministic.
function series(today, start, drift, wobble) {
    const out = [];
    for (let i = 730, k = 0; i >= 1; i--) {
        const d = addDays(today, -i);
        if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue;
        k++;
        out.push({ date: iso(d), close: +(start * (1 + drift * k / 500) * (1 + wobble * Math.sin(k / 9))).toFixed(4) });
    }
    return out;
}

export function transactionsCsv(today) {
    const t0 = addDays(today, -700), t1 = addDays(today, -690), t2 = addDays(today, -400), t3 = addDays(today, -200);
    return [
        'Trade Date,Settle Date,Reference,Description,Unit Cost,Quantity,Value,Yahoo Ticker,Currency,Account',
        `${dmy(t0)},${dmy(t0)},FPC,ISA receipt,,,20000,n/a,GBP,ISA`,
        `${dmy(t1)},${dmy(addDays(t1, 2))},B100001,Vanguard FTSE All-World UCITS ETF,9500,150,-14250,VWRL.L,GBX,ISA`,
        `${dmy(t2)},${dmy(addDays(t2, 2))},B100002,Acme Corp,60,50,-2400,ACME,USD,ISA`,
        `${dmy(t3)},${dmy(addDays(t3, 2))},S100003,Vanguard FTSE All-World UCITS ETF,10400,20,2080,VWRL.L,GBX,ISA`,
    ].join('\n') + '\n';
}

export function backupJson(today) {
    const ago = m => iso(addMonths(today, -m));
    const months = Array.from({ length: 25 }, (_, i) => 24 - i);   // 24 months ago … this month
    const balances = {
        v: 1,
        accounts: [
            { id: 'bank', name: 'Everyday Bank', group: 'current' },
            { id: 'card', name: 'Rewards Card', group: 'cards', debt: true },
            { id: 'saver', name: 'Easy Saver', group: 'savings' },
            { id: 'fixed', name: 'Fixed Saver', group: 'savings',
              term: { start: ago(10), end: iso(addDays(today, 40)), rate: 4.5, amount: 10000 } },
            { id: 'isa', name: 'Stocks ISA', group: 'investments', appLinks: ['acct:ISA'] },
            { id: 'pension', name: 'Workplace Pension', group: 'pensions' },
            { id: 'house', name: 'House', group: 'property', share: 0.5,
              asset: { bought: ago(30), price: 400000, rate: 3, valuations: [{ date: ago(6), value: 430000 }] } },
            { id: 'mortgage', name: 'Mortgage', group: 'property', debt: true, share: 0.5,
              loan: { drawn: ago(30), amount: 320000, payDay: 1,
                      deals: [{ start: ago(30), end: iso(addDays(today, 60)), rate: 4.2, payment: 1700 }],
                      balances: [{ date: ago(12), value: 305000 }] } },
        ],
        snapshots: months.map((m, i) => ({ date: ago(m), values: {
            bank: 2500 + 150 * Math.sin(i), card: -600 - 40 * i % 300, saver: 8000 + 250 * i,
            isa: 15000 + 300 * i, pension: 40000 + 900 * i,
        } })),
        lastExportAt: null, updatedAt: null,
    };
    const lifeAdmin = { bills: [
        { id: 'b1', name: 'Mortgage', estate: 'mortgage' },
        { id: 'b2', name: 'Energy', provider: 'Brightwell', amount: 140, every: 'month', end: iso(addDays(today, 30)) },
        { id: 'b3', name: 'Council Tax', amount: 2100, every: 'year' },
        { id: 'b4', name: 'Water', amount: 45, every: 'month' },
        { id: 'b5', name: 'Streaming', amount: 11, every: 'month' },
        { id: 'b6', name: 'Contents Insurance', provider: 'Harbour', amount: 120, every: 'year', end: iso(addDays(today, 20)) },
    ] };
    const y = today.getUTCFullYear();
    const pay = { v: 2, years: [
        { year: y - 3, title: 'Analyst', base: 55000, bonus: 6000 },
        { year: y - 2, title: 'Associate', base: 62000, bonus: 9000, cash: 6000, shares: 40, price: 50, stockName: 'Acme' },
        { year: y - 1, title: 'Associate', base: 68000, bonus: 11000, cash: 9000, shares: 50, price: 55, stockName: 'Acme' },
        { year: y, title: 'Vice President', base: 80000 },
    ] };
    const prices = {
        'VWRL.L': series(today, 9400, 0.12, 0.03),
        'ACME': series(today, 58, 0.15, 0.05),
        '^GSPC': series(today, 4800, 0.2, 0.03),
        '^SP500TR': series(today, 7000, 0.2, 0.03),   // the S&P benchmark (SPXT) is the total-return index
        'GBPUSD=X': series(today, 1.26, 0.02, 0.01),
    };
    return JSON.stringify({
        format: 'portfolio-system-snapshot', format_version: 4,
        exportTimestamp: today.toISOString(), pnlSessionDate: iso(addDays(today, -1)), datasetHash: 'SYNC_FAST_DELIVERY',
        summary: {},
        payload: {
            transactions: [], prices, livePrices: {}, livePrevClose: {}, liveDailyCloses: {}, liveQuoteSessionDates: {},
            todayPnlSnapshot: null, compConfigs: [], externalHoldings: [], loadSource: {},
            metadata_schema: { currencies: { 'VWRL.L': 'GBX', ACME: 'USD' }, stooq_aliases: {}, display_names: {} },
            giltPriceHistory: { v: 1, snaps: {} },
            balances, lifeAdmin, pay, marketOverview: null,
        },
    });
}
