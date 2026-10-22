// Cloud backup (docs/sync.js): what leaves the phone is encrypted, and only the right passphrase opens it.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./load.cjs');

const { app } = loadApp();
const plainList = x => JSON.parse(JSON.stringify(x));
const BACKUP = JSON.stringify({ format: 'portfolio-system-snapshot', format_version: 4, payload: { transactions: [{ value: 1234.56 }] } });

test('round trip: encrypt, then decrypt with the same passphrase', async () => {
    const enc = await app.encryptBackup(BACKUP, 'correct horse battery staple');
    assert.equal(enc.format, 'portfolio-cloud-backup');
    assert.equal(enc.kdf.iterations, 600000);
    assert.ok(!JSON.stringify(enc).includes('1234.56'), 'figures must not appear in the stored copy');
    assert.equal(await app.decryptBackup(JSON.parse(JSON.stringify(enc)), 'correct horse battery staple'), BACKUP);
});

test('a wrong passphrase or a changed byte is refused', async () => {
    const enc = await app.encryptBackup(BACKUP, 'right');
    await assert.rejects(app.decryptBackup(enc, 'wrong'), /wrong passphrase/);
    const bytes = Buffer.from(enc.data, 'base64'); bytes[0] ^= 1;
    await assert.rejects(app.decryptBackup(Object.assign({}, enc, { data: bytes.toString('base64') }), 'right'), /wrong passphrase/);
});

test('each backup uses a fresh salt and IV', async () => {
    const a = await app.encryptBackup(BACKUP, 'p'), b = await app.encryptBackup(BACKUP, 'p');
    assert.notEqual(a.kdf.salt, b.kdf.salt);
    assert.notEqual(a.cipher.iv, b.cipher.iv);
});

test('the API key file can carry the backup token and passphrase', () => {
    const res = app.parseApiKeyCsv('setting,value\ncloud_backup_token,abcdef123456\ncloud_backup_passphrase,copper lantern tidal biscuit\n');
    assert.deepEqual(plainList(res.updates.map(u => [u.id, u.value])), [['cbt', 'abcdef123456'], ['cbp', 'copper lantern tidal biscuit']]);
    const short = app.parseApiKeyCsv('setting,value\ncloud_backup_passphrase,short\n');
    assert.equal(short.updates.length, 0);
    assert.match(short.invalid[0].reason, /8 to 200/);
});

test('the API key file can carry login hints by Estate account name', () => {
    const res = app.parseApiKeyCsv('setting,value\nhint: HSBC Premier,email + usual\nLogin hint - Aviva Pension,\ntwelve_data_api_key,abcdef123456\n');
    assert.deepEqual(plainList(res.hints.map(h => [h.account, h.hint])), [['HSBC Premier', 'email + usual'], ['Aviva Pension', '']]);
    assert.equal(res.updates.length, 1);
    assert.equal(res.unknown.length, 0);
});

// What each automatic run sends: the Worker writes KV twice per upload, and the free tier allows 1,000 writes a day.
function backupRuns() {
    const { app } = loadApp();
    app.localStorage.setItem('cloud_backup_token', 'tok');
    app.localStorage.setItem('cloud_backup_passphrase', 'correct horse battery staple');
    const puts = [];
    // A stand-in Worker: PUT keeps the body as the latest, GET /backup gives it back (404 before the first), /backup/list.
    const worker = { latest: null, gets: 0 };
    app.fetch = async (url, init) => {
        const path = new URL(url, 'https://w.example').pathname;
        if (init.method === 'PUT') { puts.push('PUT'); worker.latest = init.body; return { ok: true, json: async () => ({ ok: true }) }; }
        if (path === '/backup/list') return { ok: true, json: async () => ({ days: ['2026-10-19', '2026-10-18', 'junk'] }) };
        worker.gets++;
        if (worker.latest == null) return { ok: false, status: 404, json: async () => ({ error: 'no backup' }) };
        return { ok: true, json: async () => JSON.parse(worker.latest) };
    };
    const json = (balances, tx) => JSON.stringify({ payload: { transactions: tx || [{ value: 1 }], balances } });
    return { app, puts, json, worker };
}
const later = (app) => {   // moves the last backup back past the minimum gap
    const st = JSON.parse(app.localStorage.getItem('cloud_backup_state'));
    app.localStorage.setItem('cloud_backup_state', JSON.stringify(Object.assign(st, { at: st.at - app.CLOUD_BACKUP_MIN_GAP })));
};

test('marking the Estate data as exported does not count as a change', async () => {
    const { app, puts, json } = backupRuns();
    const bal = { v: 1, accounts: [{ id: 'a' }], snapshots: [], lastExportAt: 1, updatedAt: 1 };
    await app.runCloudBackup(json(bal));
    const r = await app.runCloudBackup(json(Object.assign({}, bal, { lastExportAt: 2, updatedAt: 2 })));
    assert.equal(r.skipped, 'unchanged');
    assert.equal(puts.length, 1);
});

test('a real change waits for the minimum gap, then goes; Back up now never waits', async () => {
    const { app, puts, json } = backupRuns();
    await app.runCloudBackup(json(null, [{ value: 1 }]));
    const r = await app.runCloudBackup(json(null, [{ value: 2 }]));
    assert.equal(r.skipped, 'too soon');
    assert.ok(r.retryIn > 0 && r.retryIn <= app.CLOUD_BACKUP_MIN_GAP);
    assert.equal(puts.length, 1);
    await app.runCloudBackup(json(null, [{ value: 2 }]), true);
    assert.equal(puts.length, 2);
    const st = JSON.parse(app.localStorage.getItem('cloud_backup_state'));
    app.localStorage.setItem('cloud_backup_state', JSON.stringify(Object.assign(st, { at: st.at - app.CLOUD_BACKUP_MIN_GAP })));
    await app.runCloudBackup(json(null, [{ value: 3 }]));
    assert.equal(puts.length, 3);
});

test('a backup with fewer trades or Estate entries than the last one is held back; Back up now still sends it', async () => {
    const { app, puts, json } = backupRuns();
    const bal = n => ({ v: 1, accounts: [{ id: 'a' }], snapshots: Array.from({ length: n }, (_, i) => ({ date: '2026-0' + (i + 1) + '-20', values: {} })) });
    await app.runCloudBackup(json(bal(3), [{ value: 1 }, { value: 2 }]));
    later(app);
    const r = await app.runCloudBackup(json(bal(1), [{ value: 1 }, { value: 2 }]));
    assert.equal(r.skipped, 'held');
    assert.match(r.held.reason, /1 Estate entries \(the last backup had 3\)/);
    assert.equal(puts.length, 1);
    assert.ok(JSON.parse(app.localStorage.getItem('cloud_backup_state')).held);
    const t = await app.runCloudBackup(json(bal(3), [{ value: 1 }]));
    assert.match(t.held.reason, /1 trades \(the last backup had 2\)/);
    await app.runCloudBackup(json(bal(1), [{ value: 1 }]), true);
    assert.equal(puts.length, 2);
    assert.equal(JSON.parse(app.localStorage.getItem('cloud_backup_state')).held, null);
});

test('going back to the backed-up data clears a hold', async () => {
    const { app, json } = backupRuns();
    await app.runCloudBackup(json(null, [{ value: 1 }, { value: 2 }]));
    later(app);
    await app.runCloudBackup(json(null, [{ value: 1 }]));
    const r = await app.runCloudBackup(json(null, [{ value: 1 }, { value: 2 }]));
    assert.equal(r.skipped, 'unchanged');
    assert.equal(JSON.parse(app.localStorage.getItem('cloud_backup_state')).held, null);
});

test('a phone that has never backed up checks the cloud copy first', async () => {
    const first = backupRuns();
    await first.app.runCloudBackup(first.json(null, [{ value: 1 }, { value: 2 }, { value: 3 }]));
    // A fresh phone with the same token and passphrase, but only part of the data so far.
    const { app, puts, json, worker } = backupRuns();
    worker.latest = first.worker.latest;
    const r = await app.runCloudBackup(json(null, [{ value: 1 }]));
    assert.equal(r.skipped, 'held');
    assert.equal(puts.length, 0);
    // Once it holds as much as the cloud copy, it backs up.
    await app.runCloudBackup(json(null, [{ value: 1 }, { value: 2 }, { value: 3 }, { value: 4 }]));
    assert.equal(puts.length, 1);
});

test('a passphrase that does not open the cloud copy holds the first backup back', async () => {
    const first = backupRuns();
    await first.app.runCloudBackup(first.json(null));
    const { app, puts, json, worker } = backupRuns();
    app.localStorage.setItem('cloud_backup_passphrase', 'a different passphrase');
    worker.latest = first.worker.latest;
    const r = await app.runCloudBackup(json(null, [{ value: 1 }, { value: 2 }]));
    assert.equal(r.skipped, 'held');
    assert.match(r.held.reason, /passphrase/);
    assert.equal(puts.length, 0);
});

test('the restore list keeps only real days', async () => {
    const { app } = backupRuns();
    assert.deepEqual(plainList(await app.listCloudBackups()), ['2026-10-19', '2026-10-18']);
});
