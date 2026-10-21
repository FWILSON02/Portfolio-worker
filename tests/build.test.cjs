// Settings → App shows APP_BUILD as the PR the phone is running, and Reload app compares it with the server's.
// A PR that forgets to bump it leaves the phone saying the old number (PR #85 did), so CI checks it on every PR.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'docs', 'index.html'), 'utf8');
const build = +(html.match(/const APP_BUILD = (\d+);/) || [])[1];

test('APP_BUILD is set', () => assert.ok(build > 0));

// GitHub Actions runs pull requests on refs/pull/<number>/merge; pushes to main have no number to check.
const pr = (process.env.GITHUB_REF || '').match(/^refs\/pull\/(\d+)\//);
test('APP_BUILD is this pull request\'s number', { skip: !pr && 'not a pull request run' }, () => {
    assert.equal(build, +pr[1], 'bump APP_BUILD in docs/index.html to ' + (pr && pr[1]));
});
