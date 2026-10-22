// Settings → App shows APP_BUILD as the PR the phone is running, and Reload app compares it with the server's.
// A PR that forgets to bump it leaves the phone saying the old number (PR #85 did), so CI checks it on every PR.
// APP_BUILD and the app.js ?v= both live in docs/index.html; the app itself is docs/app.js.
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

// The app's own files are cached by the phone like the others; their ?v= moves with APP_BUILD so a new index.html never runs an old one.
for (const f of ['performance', 'app', 'settings', 'markets']) {
    test(f + '.js is loaded with ?v= set to APP_BUILD', () => {
        const m = html.match(new RegExp('<script src="' + f + '\\.js\\?v=(\\d+)"></script>'));
        assert.equal(+(m || [])[1], build, 'set <script src="' + f + '.js?v=' + build + '"> in docs/index.html');
    });
}
