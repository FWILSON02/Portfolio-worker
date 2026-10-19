// Cloud backup (docs/index.html): what leaves the phone is encrypted, and only the right passphrase opens it.
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
    app.fetch = async (url, init) => { puts.push(init.method); return { ok: true, json: async () => ({ ok: true }) }; };
    const json = (balances, tx) => JSON.stringify({ payload: { transactions: tx || [{ value: 1 }], balances } });
    return { app, puts, json };
}

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
