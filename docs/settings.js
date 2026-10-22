// Settings: Reload app, error boundaries, Settings sections and the More tab (MoreTab).
// Loaded by index.html after app.js; shares its globals (no module system, no build step).

// Settings → App: pulls the newest index.html, core.js, providers.js, sync.js, widgets.js, components.js, performance.js, holdings.js, app.js, settings.js, markets.js, balances.js, lifeadmin.js and pay.js past the browser's cache, then reloads. A Home Screen web app
// on iOS keeps serving cached files for a while after a deploy, and closing it from the app switcher doesn't clear that.
// The reload comes back to Settings on the same tab (RELOAD_RETURN_KEY) so the new PR number shows (Fergus asked). When the
// server still has this PR and the same files, nothing reloads: the merge just hasn't finished deploying yet.
const RELOAD_RETURN_KEY = 'reload-return';
let reloadReturnTab = 'investments'; // the app's open tab, kept current by PortfolioApp
function readReloadReturn() {
    try { return JSON.parse(sessionStorage.getItem(RELOAD_RETURN_KEY) || 'null'); } catch (e) { return null; }
}
function useReloadLatest() {
    const [msg, setMsg] = React.useState(() => {
        const back = readReloadReturn();
        if (!back) return null;
        try { sessionStorage.removeItem(RELOAD_RETURN_KEY); } catch (e) {}
        return back.from && back.from !== APP_BUILD ? 'Updated from PR #' + back.from + ' to PR #' + APP_BUILD
                                                    : 'Reloaded · running PR #' + APP_BUILD;
    });
    const go = async () => {
        setMsg('Checking for a newer version…');
        try {
            const base = location.href.split('#')[0].split('?')[0];
            const res = await fetch(base, { cache: 'reload' });
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const html = await res.text();
            const next = (html.match(/const APP_BUILD = (\d+);/) || [])[1];
            // The same PR number with other files (a changed ?v=) is still newer: the PR number alone once hid PR #85.
            const files = h => [...h.matchAll(/src="((?:app|settings|markets|core|providers|sync|widgets|components|performance|holdings|balances|lifeadmin|pay)\.js[^"]*)"/g)].map(m => m[1]).join(' ');
            const running = Array.from(document.querySelectorAll('script[src]')).map(el => el.getAttribute('src'))
                .filter(src => /^(app|settings|markets|core|providers|sync|widgets|components|performance|holdings|balances|lifeadmin|pay)\.js/.test(src)).join(' ');
            if (next && +next === APP_BUILD && files(html) === running) {
                setMsg('Already on PR #' + APP_BUILD + '. If you just merged, the new version isn\u2019t live yet; try again in a minute.');
                return;
            }
            for (const m of html.matchAll(/src="((?:app|settings|markets|core|providers|sync|widgets|components|performance|holdings|balances|lifeadmin|pay)\.js[^"]*)"/g)) {
                const r2 = await fetch(new URL(m[1], base).href, { cache: 'reload' }); if (!r2.ok) throw new Error('HTTP ' + r2.status);
            }
            setMsg(next ? 'Updating to PR #' + next + '…' : 'Reloading…');
            try { sessionStorage.setItem(RELOAD_RETURN_KEY, JSON.stringify({ from: APP_BUILD, tab: reloadReturnTab })); } catch (e) {}
            location.reload();
        } catch (e) { setMsg('Couldn\u2019t reach the server (' + (e && e.message || e) + '). Check your connection and try again.'); }
    };
    return [msg, go];
}

// Settings: the three things used most, always in view: privacy, live prices, and Reload Latest Version (fetches the
// newest files and restarts). The reload's message (not live yet, updated from PR #X) shows under the tiles.
function QuickTiles({ privacyMode, togglePrivacy, fetchLivePrices, liveStatus, liveAt, canRefresh }) {
    const [msg, go] = useReloadLatest();
    const tile = (key, onClick, disabled, children) => React.createElement('button', { key, onClick, disabled,
        style: { flex: 1, minWidth: 0, background: '#11161f', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 14, padding: '11px 10px',
                 display: 'flex', flexDirection: 'column', gap: 5, textAlign: 'left', cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.45 : 1,
                 WebkitTapHighlightColor: 'transparent' } }, children);
    const t = (text, color) => React.createElement('div', { style: { fontFamily: sys, fontSize: 13, fontWeight: 600, color: color || C.text, whiteSpace: 'nowrap' } }, text);
    const sub = text => React.createElement('div', { style: { fontFamily: sys, fontSize: 11, color: C.zinc500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, text);
    const fetching = liveStatus === 'fetching';
    return React.createElement('div', { style: { marginBottom: 14 } },
        React.createElement('div', { style: { display: 'flex', gap: 8 } },
            tile('privacy', togglePrivacy, false, [
                React.createElement('div', { key: 'h', style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 } },
                    t('Privacy'),
                    React.createElement('div', { style: { width: 36, height: 22, borderRadius: 11, background: privacyMode ? '#fbbf24' : '#3f3f46', position: 'relative', flexShrink: 0, transition: 'background 200ms ease' } },
                        React.createElement('div', { style: { position: 'absolute', top: 2, left: privacyMode ? 16 : 2, width: 18, height: 18, borderRadius: '50%', background: '#fff', transition: 'left 200ms ease' } }))),
                React.createElement(React.Fragment, { key: 's' }, sub(privacyMode ? 'Values hidden' : 'Values visible'))]),
            tile('live', fetchLivePrices, fetching || !canRefresh, [
                React.createElement(React.Fragment, { key: 't' }, t(fetching ? 'Refreshing\u2026' : 'Refresh prices', C.blue)),
                React.createElement(React.Fragment, { key: 's' }, sub(liveStatus === 'ok' && liveAt ? 'Live ' + liveAt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : 'Intraday, Yahoo'))]),
            tile('reload', go, false, [
                React.createElement(React.Fragment, { key: 't' }, t('Reload app', C.blue)),
                React.createElement(React.Fragment, { key: 's' }, sub('Running PR #' + APP_BUILD))])),
        msg && React.createElement('div', { style: { fontFamily: sys, fontSize: 12, color: C.zinc400, lineHeight: 1.45, padding: '8px 4px 0' } }, msg));
}

// ── Error boundaries: one broken screen never takes the app down ─────────────────────────────────────────────
// Each tab, the Settings sheet, each Settings section and the holdings overlays sit in their own TabBoundary. A render
// error shows a card in that place only; the tab bar, the other tabs, backup, restore and Reload app keep working.
// resetKey: when it changes (another tab opened, a section reopened) the screen is tried again.
// The card carries data-tab-error, which the render smoke test (tests/smoke.test.mjs) fails on.
class TabBoundary extends React.Component {
    constructor(props) { super(props); this.state = { error: null }; }
    static getDerivedStateFromError(error) { return { error }; }
    componentDidCatch(error, info) { console.error('[TabBoundary] ' + this.props.name + ' crashed:', error, info && info.componentStack); }
    componentDidUpdate(prev) { if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null }); }
    render() {
        if (!this.state.error) return this.props.children;
        return React.createElement(TabErrorCard, { name: this.props.name, error: this.state.error, screen: this.props.screen,
            onClose: this.props.onClose, extra: this.props.extra, pad: this.props.pad, onRetry: () => this.setState({ error: null }) });
    }
}
// screen: a tab id, for the tabs that open as a fixed screen under the tab bar (swiping still works from it).
// onClose: for an overlay (holdings sheet, ticker detail), which shows the card at the bottom with a Close button.
// pad: padding round the card, where the boundary replaces a screen that brought its own (the Settings sheet).
function TabErrorCard({ name, error, screen, onClose, extra, pad, onRetry }) {
    const btn = (label, onClick) => React.createElement('button', { onClick,
        style: { flex: 1, minHeight: 44, borderRadius: 12, background: 'rgba(59,130,246,0.15)', border: '1px solid rgba(59,130,246,0.3)',
                 color: C.blue, fontFamily: sys, fontSize: 14, WebkitTapHighlightColor: 'transparent' } }, label);
    const card = React.createElement('div', { 'data-tab-error': name,
        style: { background: '#11161f', border: '1px solid rgba(248,113,113,0.3)', borderRadius: 14, padding: '14px 16px', marginBottom: 12 } },
        React.createElement('div', { style: { fontFamily: sys, fontSize: 15, fontWeight: 600, color: C.rose } }, name + ' hit an error'),
        React.createElement('div', { style: { fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 11, color: C.zinc400, lineHeight: 1.45,
                                              marginTop: 6, wordBreak: 'break-word' } }, String(error && error.message || error)),
        React.createElement('div', { style: { display: 'flex', gap: 8, marginTop: 12 } },
            btn('Try again', onRetry), onClose && btn('Close', onClose)));
    const body = extra || pad ? React.createElement('div', { style: { padding: pad || 0 } }, card, extra) : card;
    if (screen) return React.createElement('div', { 'data-swipe-tabs': '', 'data-tab-screen': screen,
        style: { position: 'fixed', top: 'var(--topbar-h, 0px)', left: 0, right: 0, bottom: 0, zIndex: 9995, background: C.bg,
                 overflowY: 'auto', padding: '12px 16px 32px' } }, body);
    if (onClose) return React.createElement('div', {
        style: { position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: 10000, padding: '0 12px max(env(safe-area-inset-bottom), 12px)' } }, body);
    return body;
}
// Settings when the sheet itself crashed: Reload app (the fix is usually a newer version) and the cloud backup, so a
// backup or a restore is still one tap away. The restore summary lives outside the sheet, so it still opens.
function SettingsRecovery({ backupNow, restore }) {
    const [msg, go] = useReloadLatest();
    return React.createElement('div', null,
        React.createElement('div', { style: { marginBottom: 14 } },
            React.createElement('button', { onClick: go,
                style: { width: '100%', minHeight: 44, borderRadius: 12, background: '#11161f', border: '1px solid rgba(255,255,255,0.06)',
                         color: C.blue, fontFamily: sys, fontSize: 14, fontWeight: 600 } }, 'Reload app · running PR #' + APP_BUILD),
            msg && React.createElement('div', { style: { fontFamily: sys, fontSize: 12, color: C.zinc400, lineHeight: 1.45, padding: '8px 4px 0' } }, msg)),
        backupNow && React.createElement(TabBoundary, { name: 'Cloud Backup' }, React.createElement(CloudBackupGroup, { backupNow, restore })));
}
// The whole-app crash screen (ErrorBoundary, at the end of this file) offers Reload app too.
function ReloadLatestButton() {
    const [msg, go] = useReloadLatest();
    return React.createElement('div', null,
        React.createElement('button', { onClick: go,
            style: { marginTop: 24, padding: '12px 24px', background: 'rgba(59,130,246,0.15)', color: '#60a5fa', border: '1px solid rgba(59,130,246,0.4)',
                     borderRadius: 8, cursor: 'pointer' } }, 'Reload latest version (running PR #' + APP_BUILD + ')'),
        msg && React.createElement('div', { style: { marginTop: 10, color: '#a1a1aa' } }, msg));
}

// Settings → Backup → Estate only: the balances' import and exports (Fergus wanted every backup in one place).
// Re-renders when the Estate data changes, so "last backed up" stays current.
function EstateFilesGroup({ onImport }) {
    const store = window.BalancesStore;
    const [, tick] = React.useState(0);
    const [msg, setMsg] = React.useState(null);
    React.useEffect(() => store ? store.subscribe(() => tick(n => n + 1)) : undefined, [store]);
    if (!store || !store.exportFile) return null;
    const st = store.get();
    const has = st.accounts.length > 0;
    const stale = has && (!st.lastExportAt || (Date.now() - st.lastExportAt) > 35 * 86400000);
    const exp = kind => store.exportFile(kind).then(name => setMsg('Exported ' + name))
        .catch(e => { if (!e || e.name !== 'AbortError') setMsg('Export failed: ' + (e && e.message)); });
    return React.createElement(Group, { title: 'Estate only' },
        React.createElement(Row, { icon: Upload, iconColor: '#a78bfa', label: 'Import Balances', sub: 'Spreadsheet or Estate JSON backup', onClick: onImport }),
        React.createElement(Row, { icon: Download, iconColor: '#a78bfa', label: 'Export Estate JSON', disabled: !has, onClick: () => exp('json'),
            sub: React.createElement('span', { style: { color: stale ? C.amber : undefined } }, st.lastExportAt ? 'Last backed up ' + store.relTime(st.lastExportAt) : 'Not backed up yet') }),
        React.createElement(Row, { icon: Download, iconColor: '#a78bfa', label: 'Export Estate CSV for Excel', disabled: !has, onClick: () => exp('csv') }),
        React.createElement('div', { style: { padding: '10px 16px', fontFamily: sys, fontSize: 12, color: C.zinc500, lineHeight: 1.45 } },
            msg ? React.createElement('div', { style: { color: C.text, marginBottom: 4 } }, msg) : null,
            'Just the balances: every account, closed ones included, and every update. The cloud backup and the full JSON backup already include them.')
    );
}

// Settings → Estate: wipes every balance on this phone (tap twice). Import and export are in Settings → Backup.
function EstateDeleteGroup() {
    const store = window.BalancesStore;
    const [, tick] = React.useState(0);
    const [del, setDel] = React.useState(false);
    React.useEffect(() => store ? store.subscribe(() => tick(n => n + 1)) : undefined, [store]);
    if (!store || !store.deleteAll) return null;
    const has = store.get().accounts.length > 0;
    return React.createElement(Group, { title: 'Balances' },
        React.createElement(Row, { icon: Trash2, iconColor: '#ef4444', label: del ? 'Tap again to delete all balances' : 'Delete All Balances', disabled: !has, last: true, right: null,
            onClick: () => {
                if (!del) { setDel(true); setTimeout(() => setDel(false), 4000); return; }
                store.deleteAll().catch(() => {}); setDel(false);
            } })
    );
}

// Settings → Cash Flow's line: '3 years of pay · 24 bills'.
function cashFlowSummary(bills, payYears) {
    const parts = [];
    if (payYears) parts.push(payYears + (payYears === 1 ? ' year of pay' : ' years of pay'));
    if (bills) parts.push(bills + (bills === 1 ? ' bill' : ' bills'));
    return parts.length ? parts.join(' · ') : 'No pay or bills yet';
}

// Settings → Cash Flow: wipes every bill on this phone (tap twice). Password hints stay: they belong to the secrets file.
function LifeAdminDeleteGroup() {
    const store = window.LifeAdminStore;
    const [, tick] = React.useState(0);
    const [del, setDel] = React.useState(false);
    React.useEffect(() => store ? store.subscribe(() => tick(n => n + 1)) : undefined, [store]);
    if (!store || !store.deleteAll) return null;
    const has = store.get().bills.length > 0;
    return React.createElement(Group, { title: 'Bills' },
        React.createElement(Row, { icon: Trash2, iconColor: '#ef4444', label: del ? 'Tap again to delete all bills' : 'Delete All Bills', disabled: !has, last: true, right: null,
            onClick: () => {
                if (!del) { setDel(true); setTimeout(() => setDel(false), 4000); return; }
                store.deleteAll().catch(() => {}); setDel(false);
            } })
    );
}

// Settings → Cash Flow: wipes every year of pay on this phone (tap twice).
function PayDeleteGroup() {
    const store = window.PayStore;
    const [, tick] = React.useState(0);
    const [del, setDel] = React.useState(false);
    React.useEffect(() => store ? store.subscribe(() => tick(n => n + 1)) : undefined, [store]);
    if (!store || !store.deleteAll) return null;
    const has = store.get().years.length > 0;
    return React.createElement(Group, { title: 'Pay' },
        React.createElement(Row, { icon: Trash2, iconColor: '#ef4444', label: del ? 'Tap again to delete all pay' : 'Delete All Pay', disabled: !has, last: true, right: null,
            onClick: () => {
                if (!del) { setDel(true); setTimeout(() => setDel(false), 4000); return; }
                store.deleteAll().catch(() => {}); setDel(false);
            } })
    );
}

// Settings → Cloud Backup: the token and passphrase, when the last backup went, Back up now and Restore (see runCloudBackup).
function CloudBackupGroup({ backupNow, restore }) {
    const [token, setToken] = React.useState(getCloudBackupToken());
    const [pass, setPass] = React.useState(getCloudBackupPass());
    const [st, setSt] = React.useState(loadCloudBackupState());
    const [busy, setBusy] = React.useState(null);   // 'backup' | 'list' | the day being restored
    const [msg, setMsg] = React.useState(null);
    const [days, setDays] = React.useState(null);   // the restore list once loaded: ['latest', 'YYYY-MM-DD', ...]
    const [showAll, setShowAll] = React.useState(false);
    React.useEffect(() => {
        // Also picks up a token or passphrase brought in by the API key import.
        const on = () => { setSt(loadCloudBackupState()); setToken(getCloudBackupToken()); setPass(getCloudBackupPass()); };
        window.addEventListener('cloud-backup', on);
        const iv = setInterval(on, 30000);   // keeps "5m ago" current
        return () => { window.removeEventListener('cloud-backup', on); clearInterval(iv); };
    }, []);
    const ready = !!(token && pass);
    const failed = st.error && (!st.at || st.errorAt > st.at);
    const status = !ready ? 'Not set up: add the backup token and a passphrase below.'
        : st.held ? 'Automatic backup held back: ' + st.held.reason + ' The cloud keeps the last good copy. If this is right, tap Back Up Now; if not, restore below.'
        : failed ? 'Last try failed ' + relTime(st.errorAt) + ': ' + st.error
        : st.at ? 'Backed up ' + relTime(st.at) + ' · ' + Math.max(1, Math.round((st.bytes || 0) / 1024)) + ' KB encrypted'
        : 'Set up. The first backup goes in a moment.';
    const field = (value, onChange, placeholder) => React.createElement('input', {
        type: 'password', value, placeholder, autoComplete: 'off', autoCapitalize: 'off', autoCorrect: 'off', spellCheck: false,
        onChange: e => onChange(e.target.value),
        style: { width: '100%', boxSizing: 'border-box', background: '#0a0e14', border: '1px solid #27272a', borderRadius: 10,
                 padding: '10px 14px', fontFamily: sys, fontSize: 12, color: '#a1a1aa', marginTop: 8 }
    });
    const doBackup = () => {
        setBusy('backup'); setMsg(null);
        backupNow(true).then(r => setMsg(r && r.skipped === 'nothing to back up' ? 'Nothing to back up yet.' : r && r.skipped ? null : 'Backed up.'))
            .catch(e => setMsg('Backup failed: ' + (e && e.message || e))).finally(() => setBusy(null));
    };
    // Restore: first list what the Worker keeps (the latest, and the last copy of each day for 90 days), then the one
    // picked is downloaded, decrypted and shown in the restore summary before anything is replaced.
    const openList = () => {
        if (days) { setDays(null); setShowAll(false); return; }
        setBusy('list'); setMsg(null);
        listCloudBackups().then(d => setDays(['latest'].concat(d)))
            .catch(e => setMsg('Couldn’t list the backups: ' + (e && e.message || e))).finally(() => setBusy(null));
    };
    const pick = day => {
        setBusy(day); setMsg(null);
        restore(day === 'latest' ? null : day).then(() => { setDays(null); setShowAll(false); setMsg('Downloaded and decrypted. Check the summary and confirm to restore.'); })
            .catch(e => setMsg('Restore failed: ' + (e && e.message || e))).finally(() => setBusy(null));
    };
    const dayLabel = d => d === 'latest' ? 'Latest' + (st.at ? ' · ' + relTime(st.at) : '')
        : new Date(d + 'T12:00:00Z').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
    const shown = days ? (showAll ? days : days.slice(0, 8)) : [];
    // A copy to restore: indented under the Restore row, lined up with its label.
    const dayRow = (key, label, onClick, last, disabled) => React.createElement('button', { key, onClick, disabled,
        style: { display: 'flex', alignItems: 'center', width: '100%', textAlign: 'left', background: 'transparent', border: 'none',
                 padding: '11px 16px 11px 64px', borderBottom: last ? 'none' : '1px solid rgba(255,255,255,0.04)',
                 fontFamily: sys, fontSize: 14, color: C.blue, opacity: disabled ? 0.38 : 1, WebkitTapHighlightColor: 'transparent' } }, label);
    return React.createElement(Group, { title: 'Cloud Backup' },
        React.createElement('div', { style: { padding: '13px 16px', borderBottom: '1px solid rgba(255,255,255,0.04)' } },
            React.createElement('div', { style: { fontFamily: sys, fontSize: 12, color: ready && (st.held || failed) ? C.amber : C.text, lineHeight: 1.45 } }, status),
            field(token, v => { setToken(v); setCloudBackupToken(v); }, 'Backup token (the Worker’s BACKUP_TOKEN)'),
            field(pass, v => { setPass(v); setCloudBackupPass(v); }, 'Passphrase'),
            React.createElement('div', { style: { fontFamily: sys, fontSize: 12, color: C.zinc500, lineHeight: 1.45, marginTop: 8 } },
                'Backs up everything, Investments and Estate, whenever it changes. It’s encrypted on this phone with the passphrase, so the Worker only stores scrambled data. Write the passphrase down somewhere safe: without it the backup can’t be opened.'),
            msg && React.createElement('div', { style: { fontFamily: sys, fontSize: 12, color: C.text, marginTop: 8 } }, msg)
        ),
        React.createElement(Row, { icon: Upload, iconColor: '#60a5fa', label: busy === 'backup' ? 'Backing up…' : 'Back Up Now', disabled: !ready || !!busy, onClick: doBackup, right: null }),
        React.createElement(Row, { icon: Download, iconColor: '#60a5fa', label: busy === 'list' ? 'Loading backups…' : 'Restore From Cloud Backup',
            sub: days ? 'Pick a copy. Each day keeps its last backup for 90 days.' : 'Pick the latest or an earlier day, then check what it holds',
            disabled: !ready || (!!busy && busy !== 'list'), onClick: openList, right: null, last: !days }),
        days && shown.map((d, i) => dayRow(d, busy === d ? 'Downloading…' : dayLabel(d), () => pick(d),
            i === shown.length - 1 && (showAll || days.length <= 8), !!busy)),
        days && !showAll && days.length > 8 && dayRow('more', 'Show ' + (days.length - 8) + ' older', () => setShowAll(true), true, !!busy)
    );
}


// Settings → Alerts: how many days before its date each kind of maturity alert starts (amber, red near the date) and
// how many days after it stays if not closed (Fergus asked). Saved with the Estate balances (balances.js), so the
// Estate export and the backups carry them.
function AlertsGroup() {
    const ma = window.MaturityAlerts, store = window.BalancesStore;
    const [, tick] = React.useState(0);
    const [draft, setDraft] = React.useState({});
    React.useEffect(() => store ? store.subscribe(() => tick(n => n + 1)) : undefined, [store]);
    if (!ma || !store || !store.alertWindows) return null;
    const w = store.alertWindows();
    const box = (kind, field) => {
        const key = kind + '.' + field;
        const commit = () => {
            const v = draft[key];
            if (v === undefined) return;
            const n = parseInt(v, 10);
            if (Number.isFinite(n) && n >= 0) store.setAlertWindow(kind, { [field]: Math.min(ma.max, n) });
            setDraft(d => { const o = { ...d }; delete o[key]; return o; });
        };
        return React.createElement('input', {
            type: 'number', inputMode: 'numeric', min: 0, max: ma.max, step: 1, 'aria-label': field + ' days',
            value: draft[key] !== undefined ? draft[key] : w[kind][field],
            onChange: e => { const v = e.target.value; setDraft(d => ({ ...d, [key]: v })); },
            onBlur: commit, onKeyDown: e => { if (e.key === 'Enter') e.target.blur(); },
            style: { width: 58, background: '#0a0e14', border: '1px solid #27272a', borderRadius: 8, padding: '6px 8px', fontFamily: sys, fontSize: 14, color: '#fbbf24', textAlign: 'right' }
        });
    };
    const head = t => React.createElement('div', { style: { width: 58, textAlign: 'center', fontFamily: sys, fontSize: 10, color: C.zinc500, textTransform: 'uppercase', letterSpacing: '0.08em' } }, t);
    return React.createElement(Group, { title: 'Alerts' },
        React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '10px 16px 0' } },
            React.createElement('div', { style: { flex: 1 } }), head('Before'), head('After')),
        ma.kinds.map((k, i) => React.createElement('div', { key: k.id, style: { display: 'flex', alignItems: 'center', gap: 8, padding: '10px 16px', borderBottom: '1px solid rgba(255,255,255,0.04)' } },
            React.createElement('div', { style: { flex: 1, minWidth: 0 } },
                React.createElement('div', { style: { fontFamily: sys, fontSize: 14, color: C.text } }, k.label),
                React.createElement('div', { style: { fontFamily: sys, fontSize: 11, color: C.zinc500, marginTop: 2 } },
                    'Red for the last ' + w[k.id].red + (w[k.id].red === 1 ? ' day' : ' days'))),
            box(k.id, 'before'), box(k.id, 'after'))),
        React.createElement('div', { style: { padding: '10px 16px', fontFamily: sys, fontSize: 12, color: C.zinc500, lineHeight: 1.45 } },
            'Days before the date an alert starts, and days after it that it stays unless you close it.')
    );
}

// Inside a Settings section a Group drops its own card and keeps its title as a small heading.
const SettingsSectionCtx = React.createContext(false);
function Group({ title, children }) {
    if (React.useContext(SettingsSectionCtx)) {
        return React.createElement('div', null,
            title && React.createElement('div', { style: { fontFamily: sys, fontSize: 10, color: '#888894', textTransform: 'uppercase', letterSpacing: '0.12em', padding: '14px 16px 4px' } }, title),
            children);
    }
    return React.createElement('div', { style: { marginBottom: 28 } },
        title && React.createElement('div', { style: { fontFamily: sys, fontSize: 10, color: '#888894', textTransform: 'uppercase', letterSpacing: '0.12em', marginBottom: 8, padding: '0 4px' } }, title),
        React.createElement('div', { style: { background: '#11161f', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 14, overflow: 'hidden' } }, children)
    );
}

// Settings: one collapsible section. The header carries a one-line summary, so most of the time it needn't be opened,
// and an amber dot when something in it needs attention.
function SettingsSection({ id, icon: Icon, color, title, summary, attention, open, onToggle, children }) {
    return React.createElement('div', { style: { background: '#11161f', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 14, overflow: 'hidden', marginBottom: 10 } },
        React.createElement('button', { onClick: () => onToggle(id), 'aria-expanded': open,
            style: { display: 'flex', alignItems: 'center', gap: 12, padding: '13px 14px', width: '100%', background: 'transparent', border: 'none', textAlign: 'left', cursor: 'pointer', WebkitTapHighlightColor: 'transparent' } },
            React.createElement('div', { style: { width: 34, height: 34, borderRadius: 9, background: color + '1a', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 } },
                React.createElement(Icon, { style: { width: 18, height: 18, color }, strokeWidth: 1.75 })),
            React.createElement('div', { style: { flex: 1, minWidth: 0 } },
                React.createElement('div', { style: { fontFamily: sys, fontSize: 15, fontWeight: 600, color: C.text, display: 'flex', alignItems: 'center', gap: 6 } },
                    title, attention && React.createElement('span', { 'aria-label': 'Needs attention', style: { width: 7, height: 7, borderRadius: '50%', background: C.amber, display: 'inline-block' } })),
                summary && React.createElement('div', { style: { fontFamily: sys, fontSize: 12, color: C.zinc500, marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, summary)),
            React.createElement('span', { style: { color: C.zinc600, fontSize: 18, lineHeight: 1, transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 200ms ease' } }, '\u203a')),
        open && React.createElement('div', { style: { borderTop: '1px solid rgba(255,255,255,0.05)' } },
            React.createElement(SettingsSectionCtx.Provider, { value: true },
                React.createElement(TabBoundary, { name: title, resetKey: open }, children))));
}

function MoreTab(props) {
    const {
        transactions, prices, loadStatus, loadSource, fetchDebug,
        cacheMeta, activeHoldings, tickersUsed, livePrices, liveAt, liveStatus,
        loading, inception,
        stats, risk, attribution, rollingReturns, isaYears,
        concentration, sectorBreakdown, performanceChart, availableBenchmarks,
        selectedBenchmarks, setSelectedBenchmarks,
        handleFiles, handlePricesXlsx, fetchAllPrices, fetchLivePrices,
        exportPricesJson, exportPricesXlsx, handlePricesJson,
        clearCache, cashRate, setCashRate,
        privacyMode, togglePrivacy, formatGBP, formatPctRaw, formatPct,
        getWorkerUrl, setWorkerUrl, relTime,
        setUploadError,
        parityDelta, hasParityMismatch,
        startDate, endDate,
        compConfigs, handleCompConfigCSV,
        externalHoldings, handleExternalCustodyCSV,
        allPriceTickers,
        liveDailyCloses, liveQuoteSessionDates, dailyCheckStatus, liveQuoteChecks, pricingWarnings,
        dailyCheckForcing,
        giltMarket, giltFetchState, refreshGiltPrices,
        moneyStats, chartTimeframe,
        purgeAndRebuildPrices,
    } = props;

    const [showMetrics, setShowMetrics] = React.useState(false);
    const [showClearConfirm, setShowClearConfirm] = React.useState(false); // iOS-safe confirm dialog
    const [clearCacheMode, setClearCacheMode] = React.useState('both'); // 'both'|'tx'|'prices'
    const [workerInput, setWorkerInput] = React.useState(getWorkerUrl() || '');
    const [apiKeyMsg, setApiKeyMsg] = React.useState(null);   // { tone, text } — names only, never a key value
    const [tdKeyInput, setTdKeyInput] = React.useState(getTdApiKey() || '');
    const [avKeyInput, setAvKeyInput] = React.useState(getAvApiKey() || '');
    const [msKeyInput, setMsKeyInput] = React.useState(getMsApiKey() || '');
    const [gyKeyInput, setGyKeyInput] = React.useState(getGyApiKey() || '');
    const [gyPortInput, setGyPortInput] = React.useState(getGyPortfolio());
    // Import API keys from a CSV (see parseApiKeyCsv). The fields below are refreshed from storage afterwards so they show
    // the new state at once; a value is only ever written through the same setters the fields use.
    const handleApiKeyCSV = async (file) => {
        if (!file) return;
        let res;
        try {
            if (file.size > 100 * 1024) throw new Error('big');
            // An Excel file (.xlsx) is read as its first sheet, the same layout as the CSV.
            const isXlsx = /\.xlsx$/i.test(file.name || '') && typeof XLSX !== 'undefined';
            const text = isXlsx
                ? (wb => XLSX.utils.sheet_to_csv(wb.Sheets[wb.SheetNames[0]]))(XLSX.read(await file.arrayBuffer(), { type: 'array' }))
                : await (file.text ? file.text() : new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(String(r.result || '')); r.onerror = no; r.readAsText(file); }));
            res = parseApiKeyCsv(text);
            if (!res.error) { const w = applyApiKeyUpdates(res.updates); res.updates = w.saved; res.failed = w.failed; res.loginHints = applyLoginHints(res.hints); }
        } catch (e) {
            res = { updates: [], blank: [], unknown: [], invalid: [], error: (e && e.message === 'big') ? 'That file is too big to be a secrets file.' : 'Could not read that file.' };
        }
        setTdKeyInput(getTdApiKey()); setAvKeyInput(getAvApiKey()); setMsKeyInput(getMsApiKey()); setGyKeyInput(getGyApiKey());
        setGyPortInput(getGyPortfolio()); setWorkerInput(getWorkerUrl() || '');
        setApiKeyMsg(describeApiKeyImport(res));
    };
    // Recomputed whenever dailyCheckStatus changes — i.e. right after any cycle that
    // may have spent Alpha Vantage or Marketstack budget, so these track live usage.
    const avBudgetNow = React.useMemo(() => loadAvBudget(), [dailyCheckStatus]);
    const msBudgetNow = React.useMemo(() => loadMsBudget(), [dailyCheckStatus]);
    // Small "N / cap used" bar for the two providers with a real ceiling worth watching.
    const renderUsageMeter = (used, cap, resetLabel) => {
        const pct = cap > 0 ? Math.min(1, Math.max(0, used / cap)) : 0;
        const color = pct >= 0.9 ? '#f87171' : pct >= 0.7 ? '#fbbf24' : '#34d399';
        return React.createElement('div', { style: { marginTop: 10 } },
            React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', marginBottom: 4 } },
                React.createElement('span', { style: { fontFamily: sys, fontSize: 11, color: '#a1a1aa' } }, used + ' / ' + cap + ' used'),
                React.createElement('span', { style: { fontFamily: sys, fontSize: 10, color: '#6b6b76' } }, resetLabel)
            ),
            React.createElement('div', { style: { height: 5, borderRadius: 3, background: '#1a1a1f', overflow: 'hidden' } },
                React.createElement('div', { style: { height: '100%', width: (pct * 100) + '%', background: color, borderRadius: 3, transition: 'width 0.3s' } })
            )
        );
    };
    // Daily close check — one row per listed holding: which previous close Today uses,
    // whether Yahoo agrees with the routed second source (Twelve Data for US tickers,
    // Alpha Vantage for LSE tickers), and any fetch error.
    const dailyCheckRows = React.useMemo(() => buildDailyCheckRows({
        liveDailyCloses, liveQuoteSessionDates, dailyCheckStatus, liveQuoteChecks, livePrices,
    }), [liveDailyCloses, liveQuoteSessionDates, dailyCheckStatus, liveQuoteChecks, livePrices]);
    // Isolated drag state for metrics sheet — prevents interference with the BottomSheet gesture
    const [metricsDragY, setMetricsDragY] = React.useState(0);
    const metricsDragStart = React.useRef(null);
    // Derive chart window for display in metrics header
    const chartWindowStart = performanceChart && performanceChart.length > 0 ? performanceChart[0].date : null;
    const chartWindowEnd = performanceChart && performanceChart.length > 0 ? performanceChart[performanceChart.length - 1].date : null;
    // Where the history stops being weekly and becomes daily (null if it is all daily).
    const weeklyUntil = (() => {
        const pc = performanceChart || []; let w = null;
        for (let i = 1; i < pc.length; i++) {
            const t1 = Date.parse(pc[i].date + 'T12:00:00Z'), t0 = Date.parse(pc[i - 1].date + 'T12:00:00Z');
            if (Number.isFinite(t1) && Number.isFinite(t0) && (t1 - t0) >= 5 * 86400000) w = pc[i].date;
        }
        return w;
    })();

    const fileCount = transactions.length > 0
        ? (cacheMeta && cacheMeta.fileCount ? cacheMeta.fileCount : (transactions.length > 0 ? '✓' : 0))
        : 0;

    // ── Performance Metrics slide-up sheet ─────────────────────────
    const metricsSheet = showMetrics && React.createElement('div', {
        style: { position: 'fixed', inset: 0, zIndex: 9990, display: 'flex', alignItems: 'flex-end', background: 'rgba(0,0,0,0.75)', cursor: 'pointer' },
        onClick: () => { setShowMetrics(false); setMetricsDragY(0); }
    }, React.createElement('div', {
        className: 'ticker-sheet',
        style: { width: '100%', background: '#080c10', border: '1px solid rgba(255,255,255,0.07)', maxHeight: 'calc(100dvh - max(env(safe-area-inset-top), 44px) - 16px)', marginTop: 'max(env(safe-area-inset-top), 44px)', display: 'flex', flexDirection: 'column', transform: `translateY(${metricsDragY}px)`, transition: metricsDragY === 0 ? 'transform 0.42s cubic-bezier(0.22, 1, 0.36, 1)' : 'none', willChange: 'transform' },
        onClick: e => e.stopPropagation(),
    },
        // Drag handle — touch zone isolated from scroll content
        React.createElement('div', {
            style: { display: 'flex', justifyContent: 'center', padding: '12px 0 0', touchAction: 'none', flexShrink: 0 },
            onTouchStart: e => { metricsDragStart.current = { y: e.touches[0].clientY, time: Date.now() }; },
            onTouchMove: e => { if (!metricsDragStart.current) return; const delta = e.touches[0].clientY - metricsDragStart.current.y; if (delta > 0) setMetricsDragY(delta); },
            onTouchEnd: e => {
                if (!metricsDragStart.current) return;
                const delta = (e.changedTouches[0]?.clientY ?? 0) - metricsDragStart.current.y;
                const velocity = delta / Math.max(1, Date.now() - metricsDragStart.current.time);
                metricsDragStart.current = null;
                // Require meaningful displacement (>100px) OR fast velocity — prevents micro-scroll dismissal
                if (delta > 100 || (velocity > 0.5 && delta > 30)) { setShowMetrics(false); setMetricsDragY(0); }
                else setMetricsDragY(0);
            }
        },
            React.createElement('div', { style: { width: 40, height: 4, borderRadius: 9999, background: '#6b6b76' } })
        ),
        // Header
        React.createElement('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 20px 12px', borderBottom: '1px solid rgba(255,255,255,0.06)', flexShrink: 0 } },
            React.createElement('div', null,
                React.createElement('div', { style: { fontFamily: sys, fontSize: 10, color: '#888894', textTransform: 'uppercase', letterSpacing: '0.12em', marginBottom: 2 } }, 'Analysis'),
                React.createElement('div', { style: { fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", "Helvetica Neue", sans-serif', fontSize: 20, color: '#fff', fontWeight: 500 } }, 'Performance Metrics'),
                chartWindowStart && React.createElement('div', { style: { fontFamily: sys, fontSize: 11, color: '#888894', marginTop: 3 } },
                    `Window: ${chartWindowStart} → ${chartWindowEnd || 'Present'}`)
            ),
            React.createElement('button', {
                onClick: () => { setShowMetrics(false); setMetricsDragY(0); },
                style: { minHeight: 44, minWidth: 44, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#888894', background: 'transparent', border: 'none', borderRadius: 10 }
            }, React.createElement(X, { style: { width: 20, height: 20 }, strokeWidth: 1.75 }))
        ),
        // Scrollable content
        React.createElement('div', { className: 'ios-scroll', style: { flex: 1, padding: '20px 20px', paddingBottom: 'max(env(safe-area-inset-bottom), 32px)' } },

            // ── Money-weighted return (moved here from under the main chart) ─────────────
            moneyStats && (() => {
                const ms = moneyStats;
                const gbpAbs = v => '\u00a3' + Math.abs(Math.round(v)).toLocaleString('en-GB');
                const sgn = v => (v >= 0 ? '+' : '\u2212') + gbpAbs(v);
                const pct = v => (v >= 0 ? '+' : '\u2212') + Math.abs(v * 100).toFixed(1) + '%';
                const col = v => v >= 0 ? '#34d399' : '#f87171';
                const dLbl = d => new Date(d + 'T12:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
                const blur = { filter: privacyMode ? 'blur(6px)' : 'none' };
                const vs = ms.spx ? ms.endValue - ms.spx.value : null;
                const rows = [
                    { label: 'Gain over money in', sub: 'Value change, less cash you added', val: sgn(ms.gain), color: col(ms.gain), blur: true },
                    { label: 'Your return (XIRR, p.a.)', sub: 'Annualised, weighted by when you deposited',
                      val: ms.xirr != null ? pct(ms.xirr) : 'n/a \u00b7 needs 1 yr+', color: ms.xirr != null ? col(ms.xirr) : '#6b6b76', small: ms.xirr == null },
                ];
                if (ms.spx) rows.push({ label: 'Same deposits in ' + spxLabel() + ' (\u00a3)',
                    sub: 'You are ' + gbpAbs(vs) + (vs >= 0 ? ' ahead' : ' behind'), subBlur: true,
                    val: gbpAbs(ms.spx.value), color: '#60a5fa', blur: true });
                return React.createElement('div', { style: { marginBottom: 28 } },
                    React.createElement('div', { style: { fontFamily: sys, fontSize: 10, color: '#888894', textTransform: 'uppercase', letterSpacing: '0.12em', marginBottom: 12 } }, 'Money-Weighted Return'),
                    React.createElement('div', { style: { fontFamily: sys, fontSize: 10, color: '#6b6b76', marginTop: -6, marginBottom: 12 } },
                        'Chart window: ' + (chartTimeframe || '') + ' \u00b7 ' + dLbl(ms.startDate) + ' \u2192 ' + dLbl(ms.endDate)),
                    React.createElement('div', { style: { background: '#11161f', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 14, overflow: 'hidden' } },
                        rows.map((r, i) => React.createElement('div', { key: r.label, style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '12px 16px', borderBottom: '1px solid rgba(255,255,255,0.04)' } },
                            React.createElement('div', { style: { minWidth: 0 } },
                                React.createElement('div', { style: { fontFamily: sys, fontSize: 12, color: '#a1a1aa' } }, r.label),
                                React.createElement('div', { style: Object.assign({ fontFamily: sys, fontSize: 10, color: '#6b6b76', marginTop: 2 }, r.subBlur ? blur : {}) }, r.sub)
                            ),
                            React.createElement('div', { style: Object.assign({ fontFamily: sys, fontSize: r.small ? 12 : 18, fontVariantNumeric: 'tabular-nums', color: r.color, flexShrink: 0 }, r.blur ? blur : {}) }, r.val)
                        )),
                        React.createElement('div', { style: { padding: '10px 16px', background: 'rgba(0,0,0,0.3)', fontFamily: sys, fontSize: 10, color: '#6b6b76', lineHeight: 1.5 } },
                            'Money-weighted: reflects when you deposited. The % line on the main chart is time-weighted (investment performance only).')
                    )
                );
            })(),

            // ── Risk metrics grid ────────────────────────────────
            React.createElement('div', { style: { marginBottom: 28 } },
                React.createElement('div', { style: { fontFamily: sys, fontSize: 10, color: '#888894', textTransform: 'uppercase', letterSpacing: '0.12em', marginBottom: 12 } }, 'Risk & Volatility'),
                risk ? React.createElement('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 } },
                    ...[
                        { label: 'Ann. Return', val: risk.annReturn != null ? `${risk.annReturn >= 0 ? '+' : ''}${(risk.annReturn * 100).toFixed(1)}%` : '—', color: (risk.annReturn || 0) >= 0 ? '#34d399' : '#f87171' },
                        { label: 'Ann. Volatility', val: risk.annVol != null ? `${(risk.annVol * 100).toFixed(1)}%` : '—', color: '#a1a1aa' },
                        { label: 'Downside Vol', val: risk.annDownsideVol != null ? `${(risk.annDownsideVol * 100).toFixed(1)}%` : '—', color: '#a1a1aa' },
                        { label: 'Sharpe Ratio', val: risk.sharpe != null ? risk.sharpe.toFixed(2) : '—', color: (risk.sharpe || 0) >= 1 ? '#34d399' : (risk.sharpe || 0) >= 0 ? '#fbbf24' : '#f87171' },
                        { label: 'Sortino Ratio', val: risk.sortino != null ? risk.sortino.toFixed(2) : '—', color: (risk.sortino || 0) >= 1 ? '#34d399' : '#a1a1aa' },
                        { label: 'Max Drawdown', val: risk.maxDD != null ? `${(risk.maxDD * 100).toFixed(1)}%` : '—', color: '#f87171' },
                        { label: 'Win Rate', val: risk.winRate != null ? `${(risk.winRate * 100).toFixed(0)}%` : '—', color: (risk.winRate || 0) >= 0.5 ? '#34d399' : '#f87171' },
                        { label: 'Beat ' + spxLabel() + ' (\u00a3) Rate', val: risk.beatRate != null ? `${(risk.beatRate * 100).toFixed(0)}%` : '—', color: (risk.beatRate || 0) >= 0.5 ? '#34d399' : '#f87171' },
                    ].map(s => React.createElement('div', { key: s.label, style: { background: '#11161f', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 12, padding: '12px 14px' } },
                        React.createElement('div', { style: { fontFamily: sys, fontSize: 10, color: '#6b6b76', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 4 } }, s.label),
                        React.createElement('div', { style: { fontFamily: sys, fontSize: 18, fontVariantNumeric: 'tabular-nums', color: s.color } }, s.val)
                    ))
                ) : React.createElement('div', { style: { fontFamily: sys, fontSize: 13, color: '#6b6b76', padding: '20px 0' } }, 'Insufficient data — upload prices to enable risk metrics.')
            ),

            // ── Benchmark comparison ─────────────────────────────
            risk && risk.bench && React.createElement('div', { style: { marginBottom: 28 } },
                React.createElement('div', { style: { fontFamily: sys, fontSize: 10, color: '#888894', textTransform: 'uppercase', letterSpacing: '0.12em', marginBottom: 12 } }, 'vs ' + spxLabel()),
                React.createElement('div', { style: { background: '#11161f', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 14, overflow: 'hidden' } },
                    ...[
                        { label: 'SPX Ann. Return', port: risk.annReturn != null ? `${risk.annReturn >= 0 ? '+' : ''}${(risk.annReturn * 100).toFixed(1)}%` : '—', bench: risk.bench.annReturn != null ? `${risk.bench.annReturn >= 0 ? '+' : ''}${(risk.bench.annReturn * 100).toFixed(1)}%` : '—' },
                        { label: 'SPX Ann. Volatility', port: risk.annVol != null ? `${(risk.annVol * 100).toFixed(1)}%` : '—', bench: risk.bench.annVol != null ? `${(risk.bench.annVol * 100).toFixed(1)}%` : '—' },
                        { label: 'SPX Sharpe', port: risk.sharpe != null ? risk.sharpe.toFixed(2) : '—', bench: risk.bench.sharpe != null ? risk.bench.sharpe.toFixed(2) : '—' },
                        { label: 'SPX Max Drawdown', port: risk.maxDD != null ? `${(risk.maxDD * 100).toFixed(1)}%` : '—', bench: risk.bench.maxDD != null ? `${(risk.bench.maxDD * 100).toFixed(1)}%` : '—' },
                    ].map((row, i, arr) => React.createElement('div', { key: row.label, style: { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', padding: '11px 16px', borderBottom: i < arr.length - 1 ? '1px solid rgba(255,255,255,0.04)' : 'none', gap: 8, alignItems: 'center' } },
                        React.createElement('div', { style: { fontFamily: sys, fontSize: 11, color: '#888894' } }, row.label.replace('SPX ', '')),
                        React.createElement('div', { style: { fontFamily: sys, fontSize: 13, fontVariantNumeric: 'tabular-nums', color: '#fbbf24', textAlign: 'center' } }, row.port),
                        React.createElement('div', { style: { fontFamily: sys, fontSize: 13, fontVariantNumeric: 'tabular-nums', color: '#60a5fa', textAlign: 'right' } }, row.bench)
                    )),
                    React.createElement('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', padding: '8px 16px', background: 'rgba(0,0,0,0.3)', borderTop: '1px solid rgba(255,255,255,0.06)', gap: 8 } },
                        React.createElement('div', { style: { fontFamily: sys, fontSize: 10, color: '#6b6b76' } }, 'metric'),
                        React.createElement('div', { style: { fontFamily: sys, fontSize: 10, color: '#fbbf24', textAlign: 'center' } }, 'Portfolio'),
                        React.createElement('div', { style: { fontFamily: sys, fontSize: 10, color: '#60a5fa', textAlign: 'right' } }, spxLabel())
                    )
                )
            ),

            // ── Sector breakdown ─────────────────────────────────
            sectorBreakdown && sectorBreakdown.sectors && sectorBreakdown.sectors.length > 0 && React.createElement('div', { style: { marginBottom: 28 } },
                React.createElement('div', { style: { fontFamily: sys, fontSize: 10, color: '#888894', textTransform: 'uppercase', letterSpacing: '0.12em', marginBottom: 12 } }, 'Sector Exposure'),
                React.createElement('div', { style: { background: '#11161f', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 14, padding: 16 } },
                    // Stacked bar
                    React.createElement('div', { style: { height: 10, borderRadius: 999, overflow: 'hidden', display: 'flex', gap: 1, marginBottom: 16 } },
                        sectorBreakdown.sectors.map((s, i) => {
                            const SECTOR_COLOURS = { 'Technology': '#a78bfa', 'Broad Market': '#60a5fa', 'Financials': '#34d399', 'Energy': '#fb923c', 'Clean Energy': '#4ade80', 'Commodities': '#fbbf24', 'Bonds': '#94a3b8', 'Cash': '#a1a1aa', 'Other': '#888894' };
                            return React.createElement('div', { key: s.sector, title: `${s.sector}: ${(s.weight * 100).toFixed(1)}%`, style: { background: SECTOR_COLOURS[s.sector] || '#888894', width: `${s.weight * 100}%`, minWidth: s.weight > 0.01 ? 2 : 0 } });
                        })
                    ),
                    // Legend rows
                    React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
                        sectorBreakdown.sectors.map(s => {
                            const SECTOR_COLOURS = { 'Technology': '#a78bfa', 'Broad Market': '#60a5fa', 'Financials': '#34d399', 'Energy': '#fb923c', 'Clean Energy': '#4ade80', 'Commodities': '#fbbf24', 'Bonds': '#94a3b8', 'Cash': '#a1a1aa', 'Other': '#888894' };
                            const colour = SECTOR_COLOURS[s.sector] || '#888894';
                            return React.createElement('div', { key: s.sector, style: { display: 'flex', alignItems: 'center', gap: 10 } },
                                React.createElement('div', { style: { width: 10, height: 10, borderRadius: 3, background: colour, flexShrink: 0 } }),
                                React.createElement('div', { style: { flex: 1, fontFamily: sys, fontSize: 13, color: '#a1a1aa' } }, s.sector),
                                React.createElement('div', { style: { fontFamily: sys, fontSize: 13, fontVariantNumeric: 'tabular-nums', color: '#e4e4e7' } }, `${(s.weight * 100).toFixed(1)}%`)
                            );
                        })
                    )
                )
            ),

            // ── Risk & Concentration Diagnostics (HHI quarantine per spec §IV) ──
            // Spec: HHI engine preserved but collapsed to text diagnostics only.
            // No dominant visual bars — grouped quietly with volatility metrics.
            concentration && React.createElement('div', { style: { marginBottom: 28 } },
                React.createElement('div', { style: {
                    fontFamily: sys, fontSize: 10, color: '#888894',
                    textTransform: 'uppercase', letterSpacing: '0.12em', marginBottom: 12
                } }, 'Risk & Concentration Diagnostics'),
                React.createElement('div', { style: {
                    background: '#11161f', border: '1px solid rgba(255,255,255,0.06)',
                    borderRadius: 14, overflow: 'hidden',
                } },
                    // HHI row
                    React.createElement('div', { style: {
                        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                        padding: '12px 16px', borderBottom: '1px solid rgba(255,255,255,0.04)'
                    } },
                        React.createElement('div', null,
                            React.createElement('div', { style: { fontFamily: sys, fontSize: 12, color: '#a1a1aa' } }, 'HHI Score'),
                            React.createElement('div', { style: { fontFamily: sys, fontSize: 10, color: '#6b6b76', marginTop: 2 } },
                                'HHI = Σw² × 10000 · <1500 diversified, 1500–2500 moderate, >2500 concentrated'
                            )
                        ),
                        React.createElement('div', { style: {
                            fontFamily: sys, fontSize: 18, fontVariantNumeric: 'tabular-nums',
                            color: concentration.hhi > 2500 ? '#f87171' : concentration.hhi > 1500 ? '#fbbf24' : '#34d399'
                        } },
                            `${concentration.hhi.toFixed(0)} · ${concentration.hhi > 2500 ? 'Concentrated' : concentration.hhi > 1500 ? 'Moderate' : 'Diversified'}`
                        )
                    ),
                    // Effective N row
                    React.createElement('div', { style: {
                        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                        padding: '12px 16px', borderBottom: '1px solid rgba(255,255,255,0.04)'
                    } },
                        React.createElement('div', { style: { fontFamily: sys, fontSize: 12, color: '#a1a1aa' } }, 'Effective Positions  (1/HHIₙₒᴿᴹ)'),
                        React.createElement('div', { style: { fontFamily: sys, fontSize: 18, fontVariantNumeric: 'tabular-nums', color: '#a1a1aa' } },
                            concentration.effectiveN.toFixed(1)
                        )
                    ),
                    // Per-holding weight table — text only, tabular-nums
                    React.createElement('div', { style: { padding: '10px 16px 12px' } },
                        React.createElement('div', { style: { fontFamily: sys, fontSize: 10, color: '#6b6b76', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 8 } }, 'Weight breakdown'),
                        React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 5 } },
                            concentration.shares.slice(0, 8).map((s, i) =>
                                React.createElement('div', { key: s.ticker, style: {
                                    display: 'flex', justifyContent: 'space-between', alignItems: 'baseline'
                                } },
                                    React.createElement('span', { style: { fontFamily: sys, fontSize: 12, color: '#a1a1aa' } }, s.ticker || s.name),
                                    React.createElement('span', { style: {
                                        fontFamily: sys, fontSize: 12,
                                        fontVariantNumeric: 'tabular-nums', color: '#e4e4e7'
                                    } }, `${(s.weight * 100).toFixed(1)}%`)
                                )
                            )
                        )
                    )
                )
            ),

            // ── Brinson Attribution table ────────────────────────
            React.createElement('div', { style: { marginBottom: 28 } },
                React.createElement('div', { style: { fontFamily: sys, fontSize: 10, color: '#888894', textTransform: 'uppercase', letterSpacing: '0.12em', marginBottom: 12 } }, 'Brinson Attribution'),
                attribution ? React.createElement(React.Fragment, null,
                    // Summary totals
                    React.createElement('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginBottom: 12 } },
                        ...[
                            { label: 'Portfolio TWR', val: `${attribution.compoundPort >= 0 ? '+' : ''}${(attribution.compoundPort * 100).toFixed(1)}%`, color: attribution.compoundPort >= 0 ? '#34d399' : '#f87171' },
                            { label: spxLabel() + ' \u00a3 Ctfl.', val: `${attribution.compoundSPX >= 0 ? '+' : ''}${(attribution.compoundSPX * 100).toFixed(1)}%`, color: '#60a5fa' },
                            { label: 'Total Alpha', val: `${attribution.totalAlpha >= 0 ? '+' : ''}${(attribution.totalAlpha * 100).toFixed(2)}pp`, color: attribution.totalAlpha >= 0 ? '#34d399' : '#f87171' },
                        ].map(s => React.createElement('div', { key: s.label, style: { background: '#11161f', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 10, padding: '10px 12px' } },
                            React.createElement('div', { style: { fontFamily: sys, fontSize: 10, color: '#6b6b76', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4 } }, s.label),
                            React.createElement('div', { style: { fontFamily: sys, fontSize: 14, fontVariantNumeric: 'tabular-nums', color: s.color } }, s.val)
                        ))
                    ),
                    // Attribution table
                    React.createElement('div', { style: { background: '#11161f', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 14, overflow: 'hidden' } },
                        // Header
                        React.createElement('div', { style: { display: 'grid', gridTemplateColumns: '1fr 60px 60px 64px', gap: 8, padding: '9px 16px', background: '#0d1015', borderBottom: '1px solid rgba(255,255,255,0.06)' } },
                            React.createElement('div', { style: { fontFamily: sys, fontSize: 10, color: '#6b6b76', textTransform: 'uppercase', letterSpacing: '0.08em' } }, 'Ticker'),
                            React.createElement('div', { style: { fontFamily: sys, fontSize: 10, color: '#fbbf24', textTransform: 'uppercase', letterSpacing: '0.08em', textAlign: 'right' } }, 'Contrib'),
                            React.createElement('div', { style: { fontFamily: sys, fontSize: 10, color: '#60a5fa', textTransform: 'uppercase', letterSpacing: '0.08em', textAlign: 'right' } }, 'SPX Ctfl'),
                            React.createElement('div', { style: { fontFamily: sys, fontSize: 10, color: '#a1a1aa', textTransform: 'uppercase', letterSpacing: '0.08em', textAlign: 'right' } }, 'Alpha')
                        ),
                        // Rows
                        attribution.rows.map((r, i) => React.createElement('div', { key: r.ticker, style: { display: 'grid', gridTemplateColumns: '1fr 60px 60px 64px', gap: 8, padding: '11px 16px', borderBottom: i < attribution.rows.length - 1 ? '1px solid rgba(255,255,255,0.04)' : 'none', alignItems: 'center' } },
                            React.createElement('div', { style: { minWidth: 0 } },
                                React.createElement('div', { style: { fontFamily: sys, fontSize: 13, color: r.status === 'closed' ? '#888894' : '#fbbf24', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, r.ticker),
                                React.createElement('div', { style: { fontFamily: sys, fontSize: 10, color: '#6b6b76', marginTop: 1 } }, `${(r.avgWeight * 100).toFixed(0)}% avg · ${r.weeksHeld}w`)
                            ),
                            React.createElement('div', { style: { fontFamily: sys, fontSize: 12, fontVariantNumeric: 'tabular-nums', color: r.contribution >= 0 ? '#34d399' : '#f87171', textAlign: 'right' } },
                                `${r.contribution >= 0 ? '+' : ''}${(r.contribution * 100).toFixed(2)}pp`
                            ),
                            React.createElement('div', { style: { fontFamily: sys, fontSize: 12, fontVariantNumeric: 'tabular-nums', color: '#60a5fa', textAlign: 'right' } },
                                `${r.spxCounterfactual >= 0 ? '+' : ''}${(r.spxCounterfactual * 100).toFixed(2)}pp`
                            ),
                            React.createElement('div', { style: { fontFamily: sys, fontSize: 12, fontVariantNumeric: 'tabular-nums', color: r.alpha >= 0 ? '#34d399' : '#f87171', textAlign: 'right', fontWeight: 600 } },
                                `${r.alpha >= 0 ? '+' : ''}${(r.alpha * 100).toFixed(2)}pp`
                            )
                        )),
                        // Totals footer
                        React.createElement('div', { style: { display: 'grid', gridTemplateColumns: '1fr 60px 60px 64px', gap: 8, padding: '11px 16px', background: '#0d1015', borderTop: '1px solid rgba(255,255,255,0.07)' } },
                            React.createElement('div', { style: { fontFamily: sys, fontSize: 12, color: '#888894', textTransform: 'uppercase', letterSpacing: '0.08em' } }, 'Total'),
                            React.createElement('div', { style: { fontFamily: sys, fontSize: 12, fontVariantNumeric: 'tabular-nums', color: attribution.totalContribution >= 0 ? '#34d399' : '#f87171', textAlign: 'right', fontWeight: 600 } },
                                `${attribution.totalContribution >= 0 ? '+' : ''}${(attribution.totalContribution * 100).toFixed(2)}pp`
                            ),
                            React.createElement('div', { style: { fontFamily: sys, fontSize: 12, fontVariantNumeric: 'tabular-nums', color: '#60a5fa', textAlign: 'right', fontWeight: 600 } },
                                `${attribution.totalSpxCounterfactual >= 0 ? '+' : ''}${(attribution.totalSpxCounterfactual * 100).toFixed(2)}pp`
                            ),
                            React.createElement('div', { style: { fontFamily: sys, fontSize: 12, fontVariantNumeric: 'tabular-nums', color: attribution.totalAlpha >= 0 ? '#34d399' : '#f87171', textAlign: 'right', fontWeight: 600 } },
                                `${attribution.totalAlpha >= 0 ? '+' : ''}${(attribution.totalAlpha * 100).toFixed(2)}pp`
                            )
                        )
                    ),
                    React.createElement('div', { style: { fontFamily: sys, fontSize: 10, color: '#27272a', marginTop: 8, textAlign: 'center' } }, 'Carino-linked Brinson · weekly Modified Dietz · Carino smoothing factors applied')
                ) : React.createElement('div', { style: { fontFamily: sys, fontSize: 13, color: '#6b6b76', padding: '20px 0' } }, 'Attribution requires price data for all holdings.')
            ),

            // ── ISA year breakdown ───────────────────────────────
            isaYears && isaYears.length > 0 && React.createElement('div', { style: { marginBottom: 28 } },
                React.createElement('div', { style: { fontFamily: sys, fontSize: 10, color: '#888894', textTransform: 'uppercase', letterSpacing: '0.12em', marginBottom: 12 } }, 'ISA Subscription History'),
                React.createElement('div', { style: { background: '#11161f', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 14, overflow: 'hidden' } },
                    // Header
                    React.createElement('div', { style: { display: 'grid', gridTemplateColumns: '72px 1fr 72px', gap: 8, padding: '9px 16px', background: '#0d1015', borderBottom: '1px solid rgba(255,255,255,0.06)' } },
                        React.createElement('div', { style: { fontFamily: sys, fontSize: 10, color: '#6b6b76', textTransform: 'uppercase', letterSpacing: '0.08em' } }, 'Tax Year'),
                        React.createElement('div', { style: { fontFamily: sys, fontSize: 10, color: '#6b6b76', textTransform: 'uppercase', letterSpacing: '0.08em' } }, '← Allowance used'),
                        React.createElement('div', { style: { fontFamily: sys, fontSize: 10, color: '#6b6b76', textTransform: 'uppercase', letterSpacing: '0.08em', textAlign: 'right' } }, 'Subbed')
                    ),
                    // Rows (most recent first)
                    isaYears.slice().reverse().map((y, i, arr) => React.createElement('div', { key: y.year, style: { padding: '12px 16px', borderBottom: i < arr.length - 1 ? '1px solid rgba(255,255,255,0.04)' : 'none' } },
                        React.createElement('div', { style: { display: 'grid', gridTemplateColumns: '72px 1fr 72px', gap: 8, alignItems: 'center', marginBottom: 6 } },
                            React.createElement('div', { style: { fontFamily: sys, fontSize: 13, color: '#a1a1aa' } }, y.year),
                            React.createElement('div', { style: { height: 6, background: '#1c1c1f', borderRadius: 999, overflow: 'hidden' } },
                                React.createElement('div', { style: { width: `${y.subPct}%`, height: '100%', background: y.subPct >= 95 ? '#34d399' : y.subPct >= 50 ? '#fbbf24' : '#60a5fa', borderRadius: 999 } })
                            ),
                            React.createElement('div', { style: { fontFamily: sys, fontSize: 13, fontVariantNumeric: 'tabular-nums', color: '#e4e4e7', textAlign: 'right' } }, `£${(y.subscriptions / 1000).toFixed(0)}k`)
                        ),
                        y.transfers > 0 && React.createElement('div', { style: { fontFamily: sys, fontSize: 10, color: '#6b6b76', paddingLeft: 0 } }, `+£${(y.transfers / 1000).toFixed(0)}k transfers (not counted against allowance)`)
                    ))
                )
            ),

            // ── Rolling returns table ────────────────────────────
            rollingReturns && rollingReturns.some(r => r.portRet != null) && React.createElement('div', { style: { marginBottom: 28 } },
                React.createElement('div', { style: { fontFamily: sys, fontSize: 10, color: '#888894', textTransform: 'uppercase', letterSpacing: '0.12em', marginBottom: 12 } }, 'Rolling Returns'),
                React.createElement('div', { style: { background: '#11161f', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 14, overflow: 'hidden' } },
                    rollingReturns.filter(r => r.portRet != null).map((r, i, arr) => React.createElement('div', { key: r.label, style: { display: 'grid', gridTemplateColumns: '48px 1fr 1fr 64px', gap: 8, padding: '12px 16px', borderBottom: i < arr.length - 1 ? '1px solid rgba(255,255,255,0.04)' : 'none', alignItems: 'center' } },
                        React.createElement('div', { style: { fontFamily: sys, fontSize: 12, color: '#888894', textTransform: 'uppercase', letterSpacing: '0.1em' } }, r.label),
                        React.createElement('div', { style: { fontFamily: sys, fontSize: 14, fontVariantNumeric: 'tabular-nums', color: r.portRet >= 0 ? '#34d399' : '#f87171' } },
                            `${r.portRet >= 0 ? '+' : ''}${r.portRet.toFixed(1)}%`
                        ),
                        r.benchRet != null ? React.createElement('div', { style: { fontFamily: sys, fontSize: 13, fontVariantNumeric: 'tabular-nums', color: '#60a5fa' } },
                            `${spxLabel()} \u00a3 ${r.benchRet >= 0 ? '+' : ''}${r.benchRet.toFixed(1)}%`
                        ) : React.createElement('div', null),
                        r.benchRet != null ? React.createElement('div', { style: { fontFamily: sys, fontSize: 13, fontVariantNumeric: 'tabular-nums', color: (r.portRet - r.benchRet) >= 0 ? '#34d399' : '#f87171', textAlign: 'right' } },
                            `α ${(r.portRet - r.benchRet) >= 0 ? '+' : ''}${(r.portRet - r.benchRet).toFixed(1)}pp`
                        ) : React.createElement('div', null)
                    ))
                )
            ),

            // ── Chart notes (moved here from under the main chart) ───────────────────────
            React.createElement('div', { style: { marginBottom: 28 } },
                React.createElement('div', { style: { fontFamily: sys, fontSize: 10, color: '#888894', textTransform: 'uppercase', letterSpacing: '0.12em', marginBottom: 12 } }, 'Chart Notes'),
                React.createElement('div', { style: { background: '#11161f', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 14, overflow: 'hidden' } },
                    [
                        (moneyStats && moneyStats.excludedNote) ? 'Performance covers equity and uninvested cash; gilts and cash-like funds are excluded.' : null,
                        'Benchmark: ' + spxLabel() + ', the S&P 500 ' + (spxLabel() === 'SPXT' ? 'total return (dividends reinvested)' : 'price index (total return not loaded yet)') + ' converted to \u00a3.',
                        'Value includes cash added or withdrawn \u2014 use % for performance.',
                        weeklyUntil ? 'Chart line is one point per week before ' + new Date(weeklyUntil + 'T12:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) + ', daily after.' : null,
                    ].filter(Boolean).map((t, i, arr) => React.createElement('div', { key: 'cn' + i, style: { padding: '11px 16px', borderBottom: i < arr.length - 1 ? '1px solid rgba(255,255,255,0.04)' : 'none', fontFamily: sys, fontSize: 11, color: '#a1a1aa', lineHeight: 1.55 } }, t))
                )
            )

        ) // end scrollable content
    )); // end metrics sheet

    // ── Clear-cache confirm sheet (iOS-safe — no window.confirm) ─────────
    const clearConfirmSheet = showClearConfirm && React.createElement('div', {
        className: 'ios-tap-backdrop',
        style: { position: 'fixed', inset: 0, zIndex: 9999, display: 'flex',
                 alignItems: 'flex-end', justifyContent: 'center',
                 background: 'rgba(0,0,0,0.78)' },
        onClick: () => { setShowClearConfirm(false); setClearCacheMode('both'); }
    }, React.createElement('div', {
        style: { width: '100%', maxWidth: 440, margin: '0 16px 16px',
                 borderRadius: 24, border: '1px solid rgba(239,68,68,0.35)',
                 padding: 24, background: '#0d1218', cursor: 'default' },
        onClick: e => e.stopPropagation()
    },
        React.createElement('div', {
            style: { display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }
        },
            React.createElement('div', {
                style: { width: 36, height: 36, borderRadius: 10,
                         background: 'rgba(239,68,68,0.12)', display: 'flex',
                         alignItems: 'center', justifyContent: 'center', flexShrink: 0 }
            }, React.createElement(Trash2, { style: { width: 18, height: 18, color: '#ef4444' }, strokeWidth: 1.75 })),
            React.createElement('span', {
                style: { fontFamily: sys, fontSize: 18, color: '#fff', fontWeight: 500 }
            }, 'Clear Cache')
        ),
        // ── Scope selector ─────────────────────────────────────────
        React.createElement('div', { style: { background: C.surfaceHigh, border: `1px solid ${C.border}`, borderRadius: 14, padding: '12px 14px', marginBottom: 24, display: 'flex', flexDirection: 'column', gap: 10 } },
            React.createElement('label', { style: { display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', fontFamily: sys, fontSize: 13, color: C.text } },
                React.createElement('input', { type: 'radio', name: 'clearCacheMode', value: 'both', checked: clearCacheMode === 'both', onChange: () => setClearCacheMode('both'), style: { accentColor: '#ef4444' } }),
                React.createElement('div', null,
                    React.createElement('div', { style: { fontWeight: 600 } }, 'Clear Entire Cache'),
                    React.createElement('div', { style: { fontSize: 11, color: C.zinc500, marginTop: 1 } }, 'Deletes all transactions and historical tracking lines')
                )
            ),
            React.createElement('label', { style: { display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', fontFamily: sys, fontSize: 13, color: C.text, borderTop: `1px solid ${C.border}`, paddingTop: 10 } },
                React.createElement('input', { type: 'radio', name: 'clearCacheMode', value: 'tx', checked: clearCacheMode === 'tx', onChange: () => setClearCacheMode('tx'), style: { accentColor: '#ef4444' } }),
                React.createElement('div', null,
                    React.createElement('div', { style: { fontWeight: 600 } }, 'Clear Transactions Only'),
                    React.createElement('div', { style: { fontSize: 11, color: C.zinc500, marginTop: 1 } }, 'Drops trade history logs; keeps downloaded market prices')
                )
            ),
            React.createElement('label', { style: { display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', fontFamily: sys, fontSize: 13, color: C.text, borderTop: `1px solid ${C.border}`, paddingTop: 10 } },
                React.createElement('input', { type: 'radio', name: 'clearCacheMode', value: 'prices', checked: clearCacheMode === 'prices', onChange: () => setClearCacheMode('prices'), style: { accentColor: '#ef4444' } }),
                React.createElement('div', null,
                    React.createElement('div', { style: { fontWeight: 600 } }, 'Clear Market Prices Only'),
                    React.createElement('div', { style: { fontSize: 11, color: C.zinc500, marginTop: 1 } }, 'Drops all price graphs; preserves uploaded trade entries')
                )
            )
        ),
        React.createElement('div', { style: { display: 'flex', gap: 10 } },
            React.createElement('button', {
                onClick: () => { clearCache(clearCacheMode); setShowClearConfirm(false); setClearCacheMode('both'); },
                style: { flex: 1, minHeight: 52, borderRadius: 14,
                         background: 'rgba(239,68,68,0.15)',
                         border: '1px solid rgba(239,68,68,0.35)',
                         color: '#ef4444', fontFamily: sys, fontSize: 15,
                         touchAction: 'manipulation' }
            }, clearCacheMode === 'tx' ? 'Delete Transactions' : clearCacheMode === 'prices' ? 'Delete Prices' : 'Delete Everything'),
            React.createElement('button', {
                onClick: () => { setShowClearConfirm(false); setClearCacheMode('both'); },
                style: { flex: 1, minHeight: 52, borderRadius: 14,
                         background: 'rgba(39,39,42,0.7)', color: '#a1a1aa',
                         fontFamily: sys, fontSize: 15,
                         border: '1px solid rgba(255,255,255,0.08)',
                         touchAction: 'manipulation' }
            }, 'Cancel')
        )
    ));

    // Which Settings section is open (one at a time; all closed to start). Kept for the session, so a reload that
    // returns to Settings comes back to the same place.
    const [openSection, setOpenSection] = React.useState(() => { try { return sessionStorage.getItem('settings-open') || null; } catch { return null; } });
    const toggleSection = id => setOpenSection(cur => {
        const next = cur === id ? null : id;
        try { next ? sessionStorage.setItem('settings-open', next) : sessionStorage.removeItem('settings-open'); } catch {}
        return next;
    });
    React.useEffect(() => {
        const on = e => setOpenSection(e.detail);
        window.addEventListener('settings-open-section', on);
        return () => window.removeEventListener('settings-open-section', on);
    }, []);
    // One-line summaries for the section headers, with an amber dot where something needs attention.
    const investmentsSummary = transactions.length
        ? `${transactions.length} trades` + (compConfigs.length ? ` \u00b7 ${compConfigs.length} scheme${compConfigs.length === 1 ? '' : 's'}` : '') + (Object.keys(prices).length ? ` \u00b7 ${Object.keys(prices).length} price series` : '')
        : 'No trades loaded yet';
    const estateSummary = (() => {
        const st = window.BalancesStore && window.BalancesStore.get ? window.BalancesStore.get() : null;
        const open = st ? st.accounts.filter(a => !a.closed).length : 0;
        return { text: open ? `${open} account${open === 1 ? '' : 's'}` : 'No balances yet', attention: false };
    })();
    const backupSummary = (() => {
        const st = loadCloudBackupState(), ready = !!(getCloudBackupToken() && getCloudBackupPass());
        const failed = ready && st.error && (!st.at || st.errorAt > st.at);
        return { text: !ready ? 'Cloud backup not set up' : st.held ? 'Automatic backup held back' : failed ? 'Last cloud backup failed' : st.at ? 'Cloud backup ' + relTime(st.at) : 'Cloud backup set up',
                 attention: !ready || !!failed || !!st.held };
    })();
    const keysSummary = (() => {
        const n = [tdKeyInput, avKeyInput, msKeyInput, gyKeyInput].filter(Boolean).length, worker = !!getWorkerUrl();
        return { text: `${n} of 4 keys set \u00b7 ` + (worker ? 'Worker set' : 'no Worker URL'), attention: !worker };
    })();
    const warnCount = (pricingWarnings || []).length;
    const diagSummary = { text: hasParityMismatch ? 'Totals don\u2019t add up: check here'
                              : warnCount ? `${warnCount} pricing warning${warnCount === 1 ? '' : 's'}` : 'Daily close check, cache, clear data',
                          attention: !!hasParityMismatch || warnCount > 0 };

    // ── Main More tab render ───────────────────────────────────────
    return React.createElement(React.Fragment, null,
        clearConfirmSheet,
        // Portal to document.body so the fixed overlay escapes the ios-scroll
        // -webkit-overflow-scrolling:touch event chain. Without this, iOS Safari
        // intercepts taps on the X button and backdrop through the scroll container,
        // making the sheet impossible to close on iPhone.
        metricsSheet ? ReactDOM.createPortal(metricsSheet, document.body) : null,

        React.createElement('div', { className: 'tab-view tab-fade ios-scroll', style: { paddingTop: 'max(env(safe-area-inset-top), 12px)' } },
            React.createElement('div', { style: { padding: '16px 20px', paddingBottom: 120 } },

                // ── Quick tiles: privacy, live prices, reload the newest version ──
                React.createElement(QuickTiles, { privacyMode, togglePrivacy, fetchLivePrices, liveStatus, liveAt, canRefresh: activeHoldings.length > 0 }),

                // ── Sections: one open at a time (Fergus: the sheet had grown too long to scan) ──
                React.createElement(SettingsSection, { id: 'investments', icon: TrendingUp, color: '#fbbf24', title: 'Investments', summary: investmentsSummary, attention: false, open: openSection === 'investments', onToggle: toggleSection },
                    React.createElement(Group, { title: 'Import' },
                        React.createElement(Row, {
                            icon: Upload, iconColor: '#fbbf24',
                            label: 'Import Trades',
                            sub: transactions.length > 0 ? `${transactions.length} transactions loaded` : 'HL CSV format',
                            isLabel: true,
                            inputProps: { type: 'file', accept: '.csv,text/csv,text/plain', multiple: true, onChange: e => { handleFiles(Array.from(e.target.files)); e.target.value = ''; } },
                        }),
                        React.createElement(Row, {
                            icon: Settings, iconColor: '#a78bfa',
                            label: 'Import Compensation Config',
                            sub: compConfigs.length > 0
                                ? (() => {
                                    const activeCount = compConfigs.filter(p => p.status === 'ACTIVE').length;
                                    const draftCount  = compConfigs.filter(p => p.status === 'DRAFT').length;
                                    let s = `${compConfigs.length} schemes loaded · ${activeCount} active`;
                                    if (draftCount > 0) s += ` · ${draftCount} draft`;
                                    return s;
                                })()
                                : 'RSU / SAYE / SIP config CSV',
                            isLabel: true,
                            inputProps: { type: 'file', accept: '.csv,text/csv,text/plain', onChange: e => { handleCompConfigCSV(e.target.files[0]); e.target.value = ''; } },
                        }),
                        React.createElement(Row, {
                            icon: Database, iconColor: '#34d399',
                            label: 'Import Prices',
                            sub: Object.keys(prices).length > 0 ? `${Object.keys(prices).length} series loaded` : 'XLSX format',
                            isLabel: true,
                            inputProps: { type: 'file', accept: '.xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel', onChange: e => { handlePricesXlsx(e.target.files[0]); e.target.value = ''; } },
                        }),
                        // Stage 4.2: External custody holdings import
                        React.createElement(Row, {
                            icon: HardDrive, iconColor: '#fb923c',
                            label: 'Import External Custody Holdings',
                            sub: externalHoldings.length > 0
                                ? `${externalHoldings.length} position${externalHoldings.length !== 1 ? 's' : ''} loaded`
                                : 'CPWM / Equate real asset sheets',
                            isLabel: true,
                            inputProps: { type: 'file', accept: '.csv,text/csv,text/plain', onChange: e => { handleExternalCustodyCSV(e.target.files[0]); e.target.value = ''; } },
                        })
                    ),
                    React.createElement(Group, { title: 'Prices' },
                        React.createElement(Row, {
                            icon: RefreshCw, iconColor: '#60a5fa',
                            label: loading ? 'Fetching Historical…' : 'Refresh Historical Prices',
                            sub: 'Yahoo · weekly + 90-day daily closes · needs network',
                            onClick: fetchAllPrices,
                            disabled: loading || allPriceTickers.filter(t => t !== 'GBPUSD=X').length === 0,
                            right: loading ? React.createElement('div', { className: 'spinning', style: { width: 16, height: 16, borderRadius: '50%', border: '2px solid #1c1c1f', borderTopColor: '#60a5fa' } }) : React.createElement('span', { style: { color: '#6b6b76', fontSize: 16 } }, '›'),
                        }),
                        // Moved here from the main header: wipes the price cache, then re-pulls every history and the live quotes.
                        React.createElement(Row, {
                            icon: RefreshTrash, iconColor: '#f87171',
                            label: (loading || liveStatus === 'fetching') ? 'Rebuilding Prices…' : 'Purge & Rebuild Prices',
                            sub: 'Clears cache, re-pulls all history + live',
                            onClick: purgeAndRebuildPrices,
                            disabled: loading || liveStatus === 'fetching',
                            right: (loading || liveStatus === 'fetching') ? React.createElement('div', { className: 'spinning', style: { width: 16, height: 16, borderRadius: '50%', border: '2px solid #1c1c1f', borderTopColor: '#f87171' } }) : React.createElement('span', { style: { color: '#6b6b76', fontSize: 16 } }, '›'),
                        })
                    ),
                    React.createElement(Group, { title: 'Analysis' },
                        // Performance Metrics deep-link
                        React.createElement(Row, {
                            icon: TrendingUp, iconColor: '#a78bfa',
                            label: 'Performance Metrics',
                            sub: attribution ? `XIRR · Sharpe · Vol · Brinson · ${attribution.rows.length} tickers` : 'Upload prices to unlock',
                            onClick: () => setShowMetrics(true),
                            disabled: !attribution && !risk,
                        }),
                        // Risk-free rate
                        React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 14, padding: '13px 16px', borderBottom: '1px solid rgba(255,255,255,0.04)' } },
                            React.createElement('div', { style: { width: 34, height: 34, borderRadius: 9, background: 'rgba(167,139,250,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 } },
                                React.createElement(Key, { style: { width: 18, height: 18, color: '#a78bfa' }, strokeWidth: 1.75 })
                            ),
                            React.createElement('div', { style: { flex: 1 } },
                                React.createElement('div', { style: { fontFamily: sys, fontSize: 14, color: '#e4e4e7' } }, 'Risk-Free Rate'),
                                React.createElement('div', { style: { fontFamily: sys, fontSize: 11, color: '#6b6b76', marginTop: 2 } }, 'Sharpe / Sortino denominator')
                            ),
                            React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 4 } },
                                React.createElement('input', {
                                    type: 'number', value: cashRate,
                                    onChange: e => setCashRate(parseFloat(e.target.value) || 0),
                                    step: 0.25, min: 0, max: 20,
                                    style: { width: 52, background: '#0a0e14', border: '1px solid #27272a', borderRadius: 8, padding: '6px 8px', fontFamily: sys, fontSize: 14, color: '#fbbf24', textAlign: 'right' }
                                }),
                                React.createElement('span', { style: { fontFamily: sys, fontSize: 13, color: C.zinc400 } }, '%')
                            )
                        ),
                        // Benchmark toggles
                        availableBenchmarks && availableBenchmarks.length > 1 && React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 14, padding: '13px 16px', borderBottom: '1px solid rgba(255,255,255,0.04)' } },
                            React.createElement('div', { style: { width: 34, height: 34, borderRadius: 9, background: 'rgba(96,165,250,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 } },
                                React.createElement(Activity, { style: { width: 18, height: 18, color: '#60a5fa' }, strokeWidth: 1.75 })
                            ),
                            React.createElement('div', { style: { flex: 1 } },
                                React.createElement('div', { style: { fontFamily: sys, fontSize: 14, color: '#e4e4e7', marginBottom: 6 } }, 'Benchmark Overlays'),
                                React.createElement('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
                                    availableBenchmarks.map(b => {
                                        const active = selectedBenchmarks.includes(b.id);
                                        const isSPX = b.id === '^GSPC';
                                        return React.createElement('button', {
                                            key: b.id,
                                            onClick: () => {
                                                if (isSPX) return;
                                                setSelectedBenchmarks(prev =>
                                                    prev.includes(b.id) ? prev.filter(x => x !== b.id) : [...prev, b.id]
                                                );
                                            },
                                            disabled: isSPX,
                                            style: {
                                                padding: '4px 10px', borderRadius: 8, fontFamily: sys, fontSize: 11,
                                                background: active ? `${b.color}20` : '#0d1015',
                                                border: `1px solid ${active ? b.color + '60' : '#27272a'}`,
                                                color: active ? b.color : '#888894',
                                                display: 'flex', alignItems: 'center', gap: 5
                                            }
                                        },
                                            React.createElement('span', { style: { width: 6, height: 6, borderRadius: '50%', background: active ? b.color : '#27272a', display: 'inline-block' } }),
                                            b.short, isSPX ? ' ✓' : ''
                                        );
                                    })
                                )
                            )
                        )
                    )
                ),
                React.createElement(SettingsSection, { id: 'estate', icon: Wallet, color: '#a78bfa', title: 'Estate', summary: estateSummary.text, attention: estateSummary.attention, open: openSection === 'estate', onToggle: toggleSection },
                    React.createElement(EstateDeleteGroup)
                ),
                window.LifeAdminStore && React.createElement(SettingsSection, { id: 'lifeadmin', icon: window.LifeAdminIcon, color: window.LifeAdminColor, title: 'Cash Flow',
                    summary: cashFlowSummary(window.LifeAdminStore.get().bills.length, window.PayStore ? window.PayStore.get().years.length : 0), attention: false,
                    open: openSection === 'lifeadmin', onToggle: toggleSection },
                    React.createElement(PayDeleteGroup),
                    React.createElement(LifeAdminDeleteGroup)
                ),
                React.createElement(SettingsSection, { id: 'alerts', icon: Bell, color: '#fb923c', title: 'Alerts', summary: 'Days before and after each alert', attention: false, open: openSection === 'alerts', onToggle: toggleSection },
                    React.createElement(AlertsGroup)
                ),
                React.createElement(SettingsSection, { id: 'backup', icon: Cloud, color: '#60a5fa', title: 'Backup', summary: backupSummary.text, attention: backupSummary.attention, open: openSection === 'backup', onToggle: toggleSection },
                    props.cloudBackupNow && React.createElement(CloudBackupGroup, { backupNow: props.cloudBackupNow, restore: props.cloudRestore }),
                    React.createElement(Group, { title: 'Backup file' },
                        React.createElement(Row, {
                            icon: Download, iconColor: '#a78bfa',
                            label: 'Export JSON Backup',
                            sub: 'Everything: trades, prices, plans, Estate and Cash Flow · SHA-256 signed',
                            onClick: exportPricesJson,
                        }),
                        React.createElement(Row, {
                            icon: Upload, iconColor: '#a78bfa',
                            label: 'Restore JSON Backup',
                            sub: 'Shows what the file holds before anything is replaced',
                            isLabel: true,
                            inputProps: { type: 'file', accept: '.json,application/json', onChange: e => { handlePricesJson(e.target.files[0]); e.target.value = ''; } },
                        }),
                        React.createElement(Row, {
                            icon: Download, iconColor: '#34d399',
                            label: 'Export Auditable XLSX',
                            sub: 'Multi-sheet · SHA-256 hash · Excel compatible',
                            onClick: exportPricesXlsx,
                            last: true,
                        })
                    ),
                    props.onEstateImport && React.createElement(EstateFilesGroup, { onImport: props.onEstateImport })
                ),
                React.createElement(SettingsSection, { id: 'keys', icon: Key, color: '#34d399', title: 'Keys & connections', summary: keysSummary.text, attention: keysSummary.attention, open: openSection === 'keys', onToggle: toggleSection },
                    React.createElement(Group, { title: 'Secrets' },
                        // The secrets file (setting,value): API keys, cloud backup token and passphrase, and Estate login hints.
                        React.createElement(Row, {
                            icon: Key, iconColor: '#fbbf24',
                            label: 'Import Secrets File',
                            sub: (() => {
                                let n = 0; try { n = Object.keys(JSON.parse(localStorage.getItem(LOGIN_HINTS_KEY) || '{}') || {}).length; } catch {}
                                return `${[tdKeyInput, avKeyInput, msKeyInput, gyKeyInput].filter(Boolean).length} of 4 keys set` + (n ? ` · ${n} login hint${n === 1 ? '' : 's'}` : '') + ' · CSV or Excel';
                            })(),
                            isLabel: true,
                            inputProps: { type: 'file', accept: '.csv,text/csv,text/plain,.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', onChange: e => { handleApiKeyCSV(e.target.files[0]); e.target.value = ''; } },
                        }),
                        apiKeyMsg && React.createElement('div', {
                            style: { margin: '0 16px 10px', padding: '8px 10px', borderRadius: 8, fontFamily: sys, fontSize: 10, lineHeight: 1.5,
                                     color: apiKeyMsg.tone === 'ok' ? '#34d399' : '#fbbf24',
                                     background: apiKeyMsg.tone === 'ok' ? 'rgba(52,211,153,0.07)' : 'rgba(251,191,36,0.07)',
                                     border: '1px solid ' + (apiKeyMsg.tone === 'ok' ? 'rgba(52,211,153,0.2)' : 'rgba(251,191,36,0.2)') }
                        }, apiKeyMsg.text)
                    ),
                    React.createElement(Group, { title: 'Worker & API keys' },
                        // Worker URL field
                        React.createElement('div', { style: { padding: '13px 16px', borderBottom: '1px solid rgba(255,255,255,0.04)' } },
                            React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 14, marginBottom: 10 } },
                                React.createElement('div', { style: { width: 34, height: 34, borderRadius: 9, background: 'rgba(96,165,250,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 } },
                                    React.createElement(Key, { style: { width: 18, height: 18, color: '#60a5fa' }, strokeWidth: 1.75 })
                                ),
                                React.createElement('div', { style: { flex: 1 } },
                                    React.createElement('div', { style: { fontFamily: sys, fontSize: 14, color: '#e4e4e7' } }, 'Cloudflare Worker URL'),
                                    React.createElement('div', { style: { fontFamily: sys, fontSize: 11, color: '#6b6b76', marginTop: 2 } }, 'Proxies Yahoo Finance and Twelve Data')
                                ),
                                React.createElement('div', { style: { width: 8, height: 8, borderRadius: '50%', background: getWorkerUrl() ? '#34d399' : '#ef4444', flexShrink: 0 } })
                            ),
                            React.createElement('input', {
                                type: 'url',
                                value: workerInput,
                                placeholder: 'https://your-worker.workers.dev',
                                onChange: e => { setWorkerInput(e.target.value); setWorkerUrl(e.target.value); },
                                style: {
                                    width: '100%', boxSizing: 'border-box',
                                    background: '#0a0e14', border: '1px solid #27272a', borderRadius: 10,
                                    padding: '10px 14px', fontFamily: sys, fontSize: 12, color: '#a1a1aa'
                                }
                            }),
                        ),
                        // Twelve Data API key — the primary second source for the daily-close check
                        React.createElement('div', { style: { padding: '13px 16px', borderBottom: '1px solid rgba(255,255,255,0.04)' } },
                            React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 14, marginBottom: 10 } },
                                React.createElement('div', { style: { width: 34, height: 34, borderRadius: 9, background: 'rgba(52,211,153,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 } },
                                    React.createElement(Key, { style: { width: 18, height: 18, color: '#34d399' }, strokeWidth: 1.75 })
                                ),
                                React.createElement('div', { style: { flex: 1 } },
                                    React.createElement('div', { style: { fontFamily: sys, fontSize: 14, color: '#e4e4e7' } }, 'Twelve Data API key'),
                                    React.createElement('div', { style: { fontFamily: sys, fontSize: 11, color: '#6b6b76', marginTop: 2 } }, 'Cross-checks Citi against Yahoo (free tier covers US only)')
                                ),
                                React.createElement('div', { style: { width: 8, height: 8, borderRadius: '50%', background: tdKeyInput ? '#34d399' : '#ef4444', flexShrink: 0 } })
                            ),
                            React.createElement('input', {
                                type: 'password',
                                value: tdKeyInput,
                                placeholder: 'API key from twelvedata.com',
                                autoComplete: 'off', autoCapitalize: 'off', autoCorrect: 'off', spellCheck: false,
                                // New key → forget cached Twelve Data results/errors so the next refresh retries at once
                                onChange: e => { setTdKeyInput(e.target.value); setTdApiKey(e.target.value); saveTdDailyCache({}); },
                                style: {
                                    width: '100%', boxSizing: 'border-box',
                                    background: '#0a0e14', border: '1px solid #27272a', borderRadius: 10,
                                    padding: '10px 14px', fontFamily: sys, fontSize: 12, color: '#a1a1aa'
                                }
                            })
                        ),
                        // Alpha Vantage API key — tiebreaker only, called just for the rare date
                        // where Yahoo and Twelve Data disagree. Its free tier is 25 requests/day
                        // total, so it's worth keeping separate from the main check above.
                        React.createElement('div', { style: { padding: '13px 16px', borderBottom: '1px solid rgba(255,255,255,0.04)' } },
                            React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 14, marginBottom: 10 } },
                                React.createElement('div', { style: { width: 34, height: 34, borderRadius: 9, background: 'rgba(96,165,250,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 } },
                                    React.createElement(Key, { style: { width: 18, height: 18, color: '#60a5fa' }, strokeWidth: 1.75 })
                                ),
                                React.createElement('div', { style: { flex: 1 } },
                                    React.createElement('div', { style: { fontFamily: sys, fontSize: 14, color: '#e4e4e7' } }, 'Alpha Vantage API key'),
                                    React.createElement('div', { style: { fontFamily: sys, fontSize: 11, color: '#6b6b76', marginTop: 2 } }, 'Cross-checks your LSE holdings against Yahoo — 25 free requests/day')
                                ),
                                React.createElement('div', { style: { width: 8, height: 8, borderRadius: '50%', background: avKeyInput ? '#34d399' : '#71717a', flexShrink: 0 } })
                            ),
                            React.createElement('input', {
                                type: 'password',
                                value: avKeyInput,
                                placeholder: 'API key from alphavantage.co (optional)',
                                autoComplete: 'off', autoCapitalize: 'off', autoCorrect: 'off', spellCheck: false,
                                onChange: e => { setAvKeyInput(e.target.value); setAvApiKey(e.target.value); },
                                style: {
                                    width: '100%', boxSizing: 'border-box',
                                    background: '#0a0e14', border: '1px solid #27272a', borderRadius: 10,
                                    padding: '10px 14px', fontFamily: sys, fontSize: 12, color: '#a1a1aa'
                                }
                            }),
                            avKeyInput && renderUsageMeter(avBudgetNow.used, AV_DAILY_BUDGET, '~UTC midnight (AV doesn\u2019t document this)')
                        ),
                        // Marketstack API key — LSE fallback ONLY, used on the rare day Alpha
                        // Vantage's own 25/day cap is already spent. Its free tier is 100
                        // requests/MONTH (one per symbol), so it's kept deliberately idle
                        // otherwise. The exact symbol/exchange combination hasn't been
                        // independently confirmed to work for LSE — check the Daily close
                        // check panel below after adding a key.
                        React.createElement('div', { style: { padding: '13px 16px', borderBottom: '1px solid rgba(255,255,255,0.04)' } },
                            React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 14, marginBottom: 10 } },
                                React.createElement('div', { style: { width: 34, height: 34, borderRadius: 9, background: 'rgba(244,114,182,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 } },
                                    React.createElement(Key, { style: { width: 18, height: 18, color: '#f472b6' }, strokeWidth: 1.75 })
                                ),
                                React.createElement('div', { style: { flex: 1 } },
                                    React.createElement('div', { style: { fontFamily: sys, fontSize: 14, color: '#e4e4e7' } }, 'Marketstack API key'),
                                    React.createElement('div', { style: { fontFamily: sys, fontSize: 11, color: '#6b6b76', marginTop: 2 } }, 'Fallback for the US holding (Citi) when Twelve Data fails — 100 free requests/month')
                                ),
                                React.createElement('div', { style: { width: 8, height: 8, borderRadius: '50%', background: msKeyInput ? '#34d399' : '#71717a', flexShrink: 0 } })
                            ),
                            React.createElement('input', {
                                type: 'password',
                                value: msKeyInput,
                                placeholder: 'API key from marketstack.com (optional)',
                                autoComplete: 'off', autoCapitalize: 'off', autoCorrect: 'off', spellCheck: false,
                                onChange: e => { setMsKeyInput(e.target.value); setMsApiKey(e.target.value); },
                                style: {
                                    width: '100%', boxSizing: 'border-box',
                                    background: '#0a0e14', border: '1px solid #27272a', borderRadius: 10,
                                    padding: '10px 14px', fontFamily: sys, fontSize: 12, color: '#a1a1aa'
                                }
                            }),
                            msKeyInput && renderUsageMeter(msBudgetNow.used, MS_MONTHLY_BUDGET, '1st of month')
                        ),
                        // giltsyield.com: market prices for the gilt ladder
                        React.createElement('div', { style: { padding: '13px 16px', borderBottom: '1px solid rgba(255,255,255,0.04)' } },
                            React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 14, marginBottom: 10 } },
                                React.createElement('div', { style: { width: 34, height: 34, borderRadius: 9, background: 'rgba(251,191,36,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 } },
                                    React.createElement(Key, { style: { width: 18, height: 18, color: '#fbbf24' }, strokeWidth: 1.75 })
                                ),
                                React.createElement('div', { style: { flex: 1 } },
                                    React.createElement('div', { style: { fontFamily: sys, fontSize: 14, color: '#e4e4e7' } }, 'giltsyield.com API key'),
                                    React.createElement('div', { style: { fontFamily: sys, fontSize: 11, color: '#6b6b76', marginTop: 2 } }, 'Market prices for the gilt ladder (free account). Without a verified price a gilt is left unpriced.')
                                ),
                                React.createElement('div', { style: { width: 8, height: 8, borderRadius: '50%', background: gyKeyInput ? ((giltMarket && giltMarket.meta && giltMarket.meta.lastError) ? '#fbbf24' : '#34d399') : '#71717a', flexShrink: 0 } })
                            ),
                            React.createElement('input', {
                                type: 'password', value: gyKeyInput,
                                placeholder: 'API key from giltsyield.com (optional)',
                                autoComplete: 'off', autoCapitalize: 'off', autoCorrect: 'off', spellCheck: false,
                                onChange: e => { setGyKeyInput(e.target.value); setGyApiKey(e.target.value); },
                                style: { width: '100%', boxSizing: 'border-box', background: '#0a0e14', border: '1px solid #27272a', borderRadius: 10, padding: '10px 14px', fontFamily: sys, fontSize: 12, color: '#a1a1aa' }
                            }),
                            React.createElement('input', {
                                type: 'text', value: gyPortInput,
                                placeholder: 'giltsyield portfolio name',
                                autoComplete: 'off', autoCapitalize: 'off', autoCorrect: 'off', spellCheck: false,
                                onChange: e => { setGyPortInput(e.target.value); setGyPortfolio(e.target.value); },
                                style: { width: '100%', boxSizing: 'border-box', marginTop: 8, background: '#0a0e14', border: '1px solid #27272a', borderRadius: 10, padding: '10px 14px', fontFamily: sys, fontSize: 12, color: '#a1a1aa' }
                            }),
                            React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 10, marginTop: 10 } },
                                React.createElement('button', {
                                    onClick: () => { if (refreshGiltPrices) refreshGiltPrices({ manual: true }); },
                                    disabled: !gyKeyInput || (giltFetchState && giltFetchState.status === 'fetching'),
                                    style: { background: 'rgba(251,191,36,0.10)', border: '1px solid rgba(251,191,36,0.28)', borderRadius: 8, padding: '7px 12px', fontFamily: sys, fontSize: 11, color: '#fbbf24', opacity: gyKeyInput ? 1 : 0.4 }
                                }, (giltFetchState && giltFetchState.status === 'fetching') ? 'Fetching\u2026' : 'Fetch gilt prices now'),
                                React.createElement('div', { style: { fontFamily: sys, fontSize: 10, color: (giltMarket && giltMarket.meta && giltMarket.meta.lastError) ? '#fbbf24' : '#6b6b76', lineHeight: 1.5, flex: 1 } },
                                    (() => {
                                        const mt = (giltMarket && giltMarket.meta) || {};
                                        if (!gyKeyInput) return 'No key set';
                                        if (mt.lastError) return 'Last fetch failed: ' + mt.lastError;
                                        if (mt.lastOk) return 'Fetched ' + new Date(mt.lastOk).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) + ' \u00b7 ' + (mt.count || 0) + ' gilt' + ((mt.count || 0) === 1 ? '' : 's');
                                        return 'Not fetched yet';
                                    })()
                                )
                            )
                        )
                    )
                ),
                React.createElement(SettingsSection, { id: 'diagnostics', icon: Wrench, color: '#9da5b4', title: 'Diagnostics', summary: diagSummary.text, attention: diagSummary.attention, open: openSection === 'diagnostics', onToggle: toggleSection },
                    React.createElement(Group, { title: 'Price checks' },
                        // Daily close check — which previous close each Today figure uses
                        (dailyCheckRows.length > 0 || (pricingWarnings && pricingWarnings.length > 0)) && React.createElement('div', { id: 'daily-close-check-panel', style: { padding: '13px 16px', borderBottom: '1px solid rgba(255,255,255,0.04)' } },
                            React.createElement('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 } },
                                React.createElement('span', { style: { fontFamily: sys, fontSize: 13, color: '#e4e4e7' } }, 'Daily close check'),
                                (liveStatus === 'fetching' || (dailyCheckForcing || []).length > 0) && React.createElement('span', {
                                    style: { fontFamily: sys, fontSize: 10, color: '#fbbf24' }
                                }, 'Checking\u2026')
                            ),
                            // Re-check, one source at a time: each button fetches ONLY its own source (the others answer from
                            // cache), so a re-check can never spend another source's quota. The hint under each shows what it
                            // will cost against what is left.
                            (() => {
                                const forcing = dailyCheckForcing || [];
                                const busy = liveStatus === 'fetching' || forcing.length > 0;
                                const need = k => dailyCheckRows.filter(r => r.cells && r.cells[k] && r.cells[k].state !== 'na').length;
                                const avLeft = Math.max(0, AV_DAILY_BUDGET - avBudgetNow.used);
                                const msLeft = Math.max(0, MS_MONTHLY_BUDGET - msBudgetNow.used);
                                const items = [
                                    { k: 'yahoo', label: 'Yahoo',  hint: 'free', warn: false, off: false },
                                    { k: 'td',    label: 'Twelve', off: !tdKeyInput, warn: false, hint: !tdKeyInput ? 'no key' : 'free' },
                                    { k: 'av',    label: 'Alpha V', off: !avKeyInput || avLeft === 0, warn: need('av') > avLeft,
                                      hint: !avKeyInput ? 'no key' : avLeft === 0 ? 'none left' : need('av') > avLeft ? 'only ' + avLeft + ' left' : need('av') + ' of ' + avLeft + ' left' },
                                    { k: 'ms',    label: 'Mktstack', off: !msKeyInput || msLeft === 0, warn: need('ms') > msLeft,
                                      hint: !msKeyInput ? 'no key' : msLeft === 0 ? 'none left' : need('ms') > msLeft ? 'only ' + msLeft + ' left' : need('ms') + ' of ' + msLeft + ' left' },
                                ];
                                return React.createElement('div', { style: { marginBottom: 10 } },
                                    React.createElement('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 6 } },
                                        ...items.map(it => {
                                            const on = forcing.indexOf(it.k) >= 0;
                                            const dead = busy || it.off;
                                            return React.createElement('button', {
                                                key: it.k, disabled: dead,
                                                'aria-label': 'Re-check ' + it.label,
                                                onClick: () => { fetchLivePrices({ forceSources: [it.k] }); },
                                                style: { display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 2,
                                                         minHeight: 44, minWidth: 0, padding: '5px 4px', borderRadius: 8,
                                                         fontFamily: sys, background: on ? 'rgba(96,165,250,0.10)' : 'transparent',
                                                         border: '1px solid ' + (on ? 'rgba(96,165,250,0.35)' : '#27272a'),
                                                         opacity: dead && !on ? 0.45 : 1 }
                                            },
                                                React.createElement('span', { style: { fontSize: 11, color: '#60a5fa', whiteSpace: 'nowrap' } }, on ? 'Checking\u2026' : it.label),
                                                React.createElement('span', { style: { fontSize: 9, color: it.warn ? '#fbbf24' : '#6b6b76', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '100%' } }, it.hint)
                                            );
                                        })
                                    ),
                                    React.createElement('div', { style: { fontFamily: sys, fontSize: 9.5, color: '#52525b', marginTop: 6, lineHeight: 1.5 } },
                                        'Re-check one source at a time. Each button fetches only that source; the others keep their cached closes.')
                                );
                            })(),
                            ...(pricingWarnings || []).map((txt, i) => React.createElement('div', {
                                key: 'pw' + i, style: { fontFamily: sys, fontSize: 10, color: '#fbbf24', marginBottom: 6 }
                            }, txt)),
                            (() => {
                                // Holiday calendars are hard-coded by year; warn when the current year isn't listed.
                                const yr = new Date().getUTCFullYear();
                                const cals = Array.from(new Set(dailyCheckRows.map(r => r.calendar).filter(Boolean)))
                                    .filter(c => !calendarCoversYear(c, yr));
                                return cals.length > 0 ? React.createElement('div', {
                                    style: { fontFamily: sys, fontSize: 10, color: '#fbbf24', marginBottom: 6 }
                                }, 'Holiday calendar (' + cals.join(', ') + ') needs extending for ' + yr +
                                   ' \u2014 until then, the day after a holiday shows \u201c\u2014\u201d.') : null;
                            })(),
                            // ── One card per holding ──
                            // Two clearly separate zones, so no figure has to share a column with another kind:
                            //   1. Header — ticker, the verdict (status pill: icon + words) and the 1D change.
                            //   2. "Closes" strip — each source's close for the SAME previous session.
                            // Colour carries ONE meaning here: verification. It appears only on the status pill
                            // and on the marks in the strip (\u2713 matches Yahoo, \u2260 differs, \u2715 error, \u2205 no close).
                            // The 1D change is neutral (the arrow shows direction), so a green or red number
                            // can never be mistaken for a verdict. Set DC_SIGN_COLOUR to true to colour it by sign.
                            (() => {
                                const DC_SIGN_COLOUR = false;
                                const mono = { fontFamily: sys };
                                const fmtV = v => { const n = Number(v); return n >= 1000 ? n.toFixed(1) : n.toFixed(2); };
                                const RGB = { '#34d399': '52,211,153', '#fbbf24': '251,191,36', '#f87171': '248,113,113', '#71717a': '113,113,122', '#a1a1aa': '161,161,170' };
                                const tint = (hex, a) => 'rgba(' + (RGB[hex] || RGB['#71717a']) + ',' + a + ')';
                                const TIER_ICON = { verified: CheckCircle, degraded: HelpCircle, failed: XCircle };
                                const TIER_WORD = { verified: 'verified', degraded: 'unconfirmed', failed: 'failed' };
                                const TIER_COL  = { verified: '#34d399', degraded: DC_UNCONFIRMED_COLOUR, failed: '#f87171' };
                                // Same shape and icons as the pricing badge on the main screen.
                                const pill = (key, color, Icon, text) => React.createElement('span', {
                                    key, style: { display: 'inline-flex', alignItems: 'center', gap: 4, minWidth: 0, maxWidth: '100%',
                                                  background: tint(color, 0.08), border: '1px solid ' + tint(color, 0.22),
                                                  borderRadius: 6, padding: '2px 7px', color, ...mono, fontSize: 10.5, fontWeight: 600 }
                                },
                                    React.createElement(Icon, { style: { width: 11, height: 11, flexShrink: 0 }, strokeWidth: 2.25 }),
                                    React.createElement('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, text)
                                );
                                const SRC = [['yahoo', 'Yahoo', 'Yahoo'], ['td', 'Twelve', 'Twelve Data'], ['av', 'Alpha V', 'Alpha Vantage'], ['ms', 'Mktstack', 'Marketstack']];
                                const cell = (c, key, short, full) => {
                                    let val, valCol = '#e4e4e7', mark = null;
                                    if (c.state === 'ok') {
                                        val = fmtV(c.value);
                                        if (key === 'yahoo')      mark = { t: 'ref', c: '#52525b', size: 9 };
                                        else if (c.agree === true)  mark = { t: '\u2713', c: '#34d399', size: 11 };
                                        else if (c.agree === false) mark = { t: '\u2260', c: '#f87171', size: 11 };
                                    } else if (c.state === 'pending') { val = '\u2026'; valCol = '#fbbf24'; }
                                    else if (c.state === 'err')       { val = 'error';    valCol = '#a1a1aa'; mark = { t: '\u2715', c: '#f87171', size: 11 }; }
                                    else if (c.state === 'missing')   { val = 'no close'; valCol = '#a1a1aa'; mark = { t: '\u2205', c: '#f87171', size: 11 }; }
                                    else if (c.state === 'na')        { val = 'n/a';      valCol = '#3f3f46'; }
                                    else                              { val = '\u2014';   valCol = '#71717a'; }
                                    return React.createElement('div', { key, title: full, style: { minWidth: 0 } },
                                        React.createElement('div', { style: { ...mono, fontSize: 9, color: c.state === 'na' ? '#3f3f46' : '#6b6b76', letterSpacing: 0.2, marginBottom: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, short),
                                        React.createElement('div', { style: { display: 'flex', alignItems: 'baseline', gap: 4, whiteSpace: 'nowrap', overflow: 'hidden' } },
                                            React.createElement('span', { style: { ...mono, fontSize: 11, color: valCol, fontVariantNumeric: 'tabular-nums' } }, val),
                                            mark && React.createElement('span', { style: { ...mono, fontSize: mark.size, fontWeight: 700, color: mark.c } }, mark.t)
                                        )
                                    );
                                };
                                // Headline counts — the same three tiers as the pricing badge on the main screen.
                                const counts = { verified: 0, degraded: 0, failed: 0 };
                                dailyCheckRows.forEach(r => { if (counts[r.tier] != null) counts[r.tier]++; });
                                const summary = dailyCheckRows.length ? React.createElement('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 } },
                                    ...['verified', 'degraded', 'failed'].filter(t => counts[t] > 0)
                                        .map(t => pill('sum-' + t, TIER_COL[t], TIER_ICON[t], counts[t] + ' ' + TIER_WORD[t]))
                                ) : null;
                                const cards = dailyCheckRows.map(r => {
                                    const pctTxt = r.pct == null ? '\u2014' : ((r.pct > 0 ? '+' : r.pct < 0 ? '\u2212' : '') + Math.abs(r.pct * 100).toFixed(2) + '%');
                                    const arrow  = r.pct == null ? '' : (r.pct > 0 ? '\u25B2 ' : r.pct < 0 ? '\u25BC ' : '\u2013 ');
                                    const pctCol = r.pct == null ? '#71717a' : (DC_SIGN_COLOUR ? signColor(r.pct) : '#e4e4e7');
                                    return React.createElement('div', { key: r.tk, style: { background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 12, padding: '10px 12px', marginBottom: 8 } },
                                        // Zone 1 — who, verdict, 1D change
                                        React.createElement('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 } },
                                            React.createElement('span', { style: { ...mono, fontSize: 13, fontWeight: 600, color: C.text, flexShrink: 0 } }, r.tk.replace(/\.L$/, '')),
                                            pill('st', r.color, TIER_ICON[r.tier] || HelpCircle, r.label)
                                        ),
                                        React.createElement('div', { style: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8, marginTop: 5 } },
                                            React.createElement('span', { style: { ...mono, fontSize: 10, color: '#6b6b76' } }, 'Prev close \u00b7 ' + r.prevLabel),
                                            React.createElement('span', { style: { ...mono, fontSize: 12, color: pctCol, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' } },
                                                React.createElement('span', { style: { fontSize: 9.5, color: '#6b6b76', marginRight: 5 } }, '1D'),
                                                arrow + pctTxt)
                                        ),
                                        // Zone 2 — every source's close for that same session
                                        React.createElement('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 6, background: 'rgba(255,255,255,0.03)', borderRadius: 8, padding: '7px 9px', marginTop: 9 } },
                                            ...SRC.map(([k, short, full]) => cell(r.cells[k], k, short, full))
                                        ),
                                        r.err && React.createElement('div', { style: { ...mono, fontSize: 9.5, color: '#a1a1aa', marginTop: 8, lineHeight: 1.45, borderLeft: '2px solid rgba(255,255,255,0.14)', paddingLeft: 8 } }, r.err)
                                    );
                                });
                                const g = (col, t) => React.createElement('span', { style: { color: col, fontWeight: 700 } }, t);
                                const legend = React.createElement('div', { style: { ...mono, fontSize: 9.5, color: '#52525b', marginTop: 4, lineHeight: 1.6 } },
                                    'Strip = each source\u2019s close for the previous session; Yahoo is the reference. ',
                                    g('#34d399', '\u2713'), ' matches Yahoo \u00b7 ', g('#f87171', '\u2260'), ' differs \u00b7 \u2026 checking \u00b7 ',
                                    g('#f87171', '\u2715'), ' error \u00b7 ', g('#f87171', '\u2205'), ' no close for that day \u00b7 n/a not used for this holding. ',
                                    '1D = live price vs. that close.');
                                return React.createElement('div', null, summary, ...cards, legend);
                            })()
                        ),
                        // Cache metadata rows
                        ...(cacheMeta ? [
                            { label: 'Transactions cached', value: cacheMeta.txCount ?? '—' },
                            { label: 'Price series', value: cacheMeta.seriesCount ?? '—' },
                            { label: 'Cache saved', value: cacheMeta.savedAt ? relTime(cacheMeta.savedAt) : '—' },
                        ] : [{ label: 'Cache status', value: 'Empty' }]).map((row, i, arr) =>
                            React.createElement('div', { key: row.label, style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '13px 16px', borderBottom: i < arr.length - 1 ? '1px solid rgba(255,255,255,0.04)' : 'none' } },
                                React.createElement('span', { style: { fontFamily: sys, fontSize: 13, color: '#a1a1aa' } }, row.label),
                                React.createElement('span', { style: { fontFamily: sys, fontSize: 13, color: C.text } }, String(row.value))
                            )
                        )
                    ),
                    // ── Parity Sentinel Banner (Spec §IV 2.5 item 2) ──────────
                    // Only renders when accountGroups rollup != masterPortfolio.totalValue (> £0.01).
                    // Dashboard is never polluted — this lives exclusively in System Diagnostics.
                    hasParityMismatch && React.createElement('div', {
                        style: {
                            background: 'rgba(239,68,68,0.08)',
                            border: '1px solid rgba(239,68,68,0.35)',
                            borderRadius: 12, padding: '12px 16px',
                            marginBottom: 16, marginTop: 4,
                        }
                    },
                        React.createElement('div', { style: { display: 'flex', alignItems: 'flex-start', gap: 10 } },
                            React.createElement('div', { style: { color: '#f87171', fontSize: 14, flexShrink: 0, lineHeight: 1.4 } }, '⚠'),
                            React.createElement('div', null,
                                React.createElement('div', { style: {
                                    fontFamily: sys, fontSize: 12, fontWeight: 600,
                                    color: '#f87171', marginBottom: 4,
                                } }, 'System Parity Mismatch'),
                                React.createElement('div', { style: {
                                    fontFamily: sys, fontSize: 11,
                                    color: 'rgba(248,113,113,0.75)', lineHeight: 1.6,
                                    fontVariantNumeric: 'tabular-nums',
                                } },
                                    `Sub-tier rollup variance: £${parityDelta.toFixed(2)} detected. ` +
                                    'Account group totals do not sum to master portfolio value. ' +
                                    'Check for rounding in cash or untickered position calculations.'
                                )
                            )
                        )
                    ),
                    // ── Danger Zone, last in Diagnostics ────────────────
                    React.createElement('div', { style: { margin: '14px 12px 12px' } },
                        React.createElement('div', { style: { fontFamily: sys, fontSize: 10, color: 'rgba(239,68,68,0.5)', textTransform: 'uppercase', letterSpacing: '0.12em', marginBottom: 8, padding: '0 4px' } }, 'Danger Zone'),
                        React.createElement('div', { style: { background: 'rgba(220,38,38,0.05)', border: '1px solid rgba(220,38,38,0.2)', borderRadius: 14, overflow: 'hidden' } },
                            React.createElement('button', {
                                onClick: () => setShowClearConfirm(true),
                                style: { display: 'flex', alignItems: 'center', gap: 14, padding: '14px 16px', width: '100%', background: 'transparent', border: 'none', textAlign: 'left' }
                            },
                                React.createElement('div', { style: { width: 34, height: 34, borderRadius: 9, background: 'rgba(239,68,68,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 } },
                                    React.createElement(Trash2, { style: { width: 18, height: 18, color: '#ef4444' }, strokeWidth: 1.75 })
                                ),
                                React.createElement('div', { style: { flex: 1 } },
                                    React.createElement('div', { style: { fontFamily: sys, fontSize: 14, color: '#ef4444' } }, 'Clear Cache'),
                                    React.createElement('div', { style: { fontFamily: sys, fontSize: 11, color: 'rgba(239,68,68,0.45)', marginTop: 2 } }, 'Permanently deletes all transactions & prices from this browser')
                                )
                            )
                        )
                    )
                )

            ) // end padding div
        ) // end ios-scroll
    ); // end Fragment
} // end MoreTab
