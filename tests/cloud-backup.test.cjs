// Cloud backup (docs/index.html): what leaves the phone is encrypted, and only the right passphrase opens it.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./load.cjs');

const { app } = loadApp();
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
