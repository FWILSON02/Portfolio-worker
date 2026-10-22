// PortfolioApp: the main component (state, price fetching, imports and exports, the Investments and Estate screens).
// Its helpers live in core.js, providers.js, sync.js, widgets.js and components.js; its calculations in performance.js and holdings.js.
// Loaded by index.html after those; shares their globals (no module system, no build step).

// How old Markets data may be before the app refreshes it in the background on open / return to foreground.
const MARKET_PREFETCH_STALE_MS = 5 * 60 * 1000;
function PortfolioApp() {
    const [transactions, setTransactions] = useState([]);
    const [uploadError, setUploadError] = useState(null);
    const [fileCount, setFileCount] = useState(0);
    const [prices, setPrices] = useState({}); // { ticker: [{date, close}] }
    const pricesRef = React.useRef({}); // mirror of prices — readable in callbacks without dep-array inclusion
    const livePricesRef = React.useRef({}); // mirror of livePrices for shallow-compare guards
    const livePrevCloseRef = React.useRef({}); // mirror of livePrevClose for shallow-compare guards
    const liveRunIdRef = React.useRef(0);             // id of the newest live refresh; older runs never commit
    const liveFetchInFlightRef = React.useRef(false); // a live refresh is running — silent polls skip
    const lastGoodQuoteAtRef = React.useRef({});      // ticker → ms of its last accepted fresh quote
    const isFirstLiveFetch = React.useRef(true); // stamps liveAt on the first successful fetch even if values match cache
    const [, setFxGBPUSD] = useState([]); // [{date, close}]
    const [livePrices, setLivePrices] = useState({}); // { ticker: latestQuote } — intraday
    // Per-ticker quote session date from meta.regularMarketTime — the authoritative
    // market-session timestamp, not the fetch time and not the last daily bar date.
    const [liveQuoteSessionDates, setLiveQuoteSessionDates] = useState({});
    // Frozen Today P&L snapshot written at export time. Used as a chart reconciliation
    // fallback when masterPortfolio.todayAbsChange is null (sandbox / offline / pre-fetch).
    // sessionDate guard prevents a stale snapshot from applying to a different trading day.
    const [todayPnlSnapshot, setTodayPnlSnapshot] = useState(null);
    const [livePrevClose, setLivePrevClose] = useState({}); // { ticker: previousClose } — for today's delta
    // { ticker: [{date:'YYYY-MM-DD', close}] } — full recent daily-close series captured from the
    // live 5-day chart. Gives tickers with NO entry in `prices` (restricted stock: C, HSBA.L) a real
    // recent-close series so previous close can be resolved by actual date, not a stale scalar.
    const [liveDailyCloses, setLiveDailyCloses] = useState({});
    // Per-ticker Yahoo × second-source (Twelve Data / Alpha Vantage) check status for Settings → System diagnostics.
    // { [ticker]: { stooqRows, unitFactor, error, keySet, checkedAt } }
    const [dailyCheckStatus, setDailyCheckStatus] = useState({});
    // Live-quote gate results per ticker (see assessLiveQuote). Not persisted:
    // recomputed on every fetch and on JSON restore.
    const [liveQuoteChecks, setLiveQuoteChecks] = useState({});
    // Yahoo's currency per ticker from its latest accepted quote — "today's
    // currency". Persisted so conversions stay right offline / before a fetch.
    const [quoteCurrencies, setQuoteCurrencies] = useState(() => _dcLoad(QUOTE_CURRENCY_KEY));
    const liveDailyClosesRef = React.useRef({}); // mirror for shallow-compare guards
    // Raw (Yahoo-only) daily rows per ticker from the latest live fetch — the base the
    // background second-source check re-merges onto when its data lands.
    const yahooDailyRawRef = React.useRef({});
    const secondaryRefreshInFlightRef = React.useRef(false);
    const forceQueuedRef = React.useRef(null);                    // sources of a re-check pressed while a check was running
    const [dailyCheckForcing, setDailyCheckForcing] = React.useState([]); // sources of the manual re-check in progress (empty = none)
    // Per-day cache of Stooq/Yahoo-historical daily series for tickers whose live chart
    // returns no usable close array (US restricted equities like C). Avoids re-fetching
    // the same backfill on every poll. Shape: { TICKER: { date:'YYYY-MM-DD', series:[{date,close}] } }
    const restrictedDailyCacheRef = React.useRef({});
    const [liveStatus, setLiveStatus] = useState('idle'); // 'idle'|'fetching'|'ok'|'fail'
    const [liveAt, setLiveAt] = useState(null); // timestamp of last live fetch
    // Time of the last successful spot-price pull, stamped on EVERY success (liveAt only moves when a price changed).
    // Display only: shown on the Daily Insights card.
    const [lastSpotRefreshAt, setLastSpotRefreshAt] = useState(null);
    // Gilt prices from giltsyield.com (see fetchGiltsyieldPrices). `giltMarket` is the persisted snapshot store; the
    // ladder reads it through gyMarketFor, which enforces freshness. Fetching is quiet: never blocks, never throws.
    const [giltMarket, setGiltMarket] = useState(() => loadGyCache());
    const [giltFetchState, setGiltFetchState] = useState({ status: 'idle' });   // 'idle'|'fetching'|'ok'|'fail'|'nokey'
    const giltInFlight = useRef(false);
    const refreshGiltPrices = useCallback(async (opts) => {
        const manual = !!(opts && opts.manual);
        if (giltInFlight.current) return;
        if (!getGyApiKey()) { setGiltFetchState({ status: 'nokey' }); return; }
        if (!getWorkerUrl()) { setGiltFetchState({ status: 'fail', error: 'no Worker URL set' }); return; }
        if (typeof navigator !== 'undefined' && navigator.onLine === false) { if (manual) setGiltFetchState({ status: 'fail', error: 'offline' }); return; }
        const c0 = loadGyCache();
        const now = Date.now();
        if (!manual && c0.meta.lastAttempt && (now - c0.meta.lastAttempt) < GY_MIN_INTERVAL_MS) return;
        giltInFlight.current = true;
        setGiltFetchState({ status: 'fetching' });
        try {
            const res = await fetchGiltsyieldPrices();
            let c = loadGyCache();
            c.meta = Object.assign({}, c.meta, { lastAttempt: now });
            if (res.ok) {
                c = gyRecordSnapshots(c, res.accepted, now);
                c.meta = Object.assign({}, c.meta, { lastOk: now, lastError: null, rejected: res.rejected, count: Object.keys(res.accepted).length });
            } else {
                c.meta = Object.assign({}, c.meta, { lastError: res.error });
            }
            saveGyCache(c);
            setGiltMarket(c);
            setGiltFetchState(res.ok ? { status: 'ok' } : { status: 'fail', error: res.error });
        } catch (e) {
            const msg = paScrub((e && e.message) || 'failed');
            const c = loadGyCache();
            c.meta = Object.assign({}, c.meta, { lastAttempt: now, lastError: msg });
            saveGyCache(c); setGiltMarket(c);
            setGiltFetchState({ status: 'fail', error: msg });
        } finally { giltInFlight.current = false; }
    }, []);
    useEffect(() => {
        const t0 = setTimeout(() => refreshGiltPrices(), 2000);
        const iv = setInterval(() => { if (document.visibilityState === 'visible') refreshGiltPrices(); }, 15 * 60 * 1000);
        const onVis = () => { if (document.visibilityState === 'visible') refreshGiltPrices(); };
        document.addEventListener('visibilitychange', onVis);
        return () => { clearTimeout(t0); clearInterval(iv); document.removeEventListener('visibilitychange', onVis); };
    }, [refreshGiltPrices]);
    const [loading, setLoading] = useState(false);
    const [loadStatus, setLoadStatus] = useState({}); // { ticker: 'ok'|'fail'|'loading' }
    const [loadSource, setLoadSource] = useState({}); // { ticker: 'twelvedata'|'stooq'|'yahoo' }
    const [fetchDebug, setFetchDebug] = useState({}); // { ticker: [{src, result, msg}, ...] }
    const [, setActiveSection] = useState('performance');
    const [selectedTicker, setSelectedTicker] = useState(null); // holdings drill-down modal
    const [startDate] = useState(null);
    const [endDate] = useState(null); // null = today
    const [scrolled, setScrolled] = useState(false); // compact sticky header after scrolling
    const [sheetDragY, setSheetDragY] = useState(0); // live drag offset for settings sheet (px)
    const sheetDragStart = React.useRef(null); // { y, time } at touch start
    const [modalDragY, setModalDragY] = useState(0); // live drag offset for ticker modal (px)
    const modalDragStart = React.useRef(null); // { y, time } at touch start
    const [settingsDragY, setSettingsDragY] = useState(0); // live drag offset for settings sheet (px)
    const settingsDragStart = React.useRef(null); // { y, time } at touch start for settings
    // Settings: API key + storage preference
    const [privacyMode, setPrivacyMode] = useState(() => {
        try { return localStorage.getItem('privacy_mode') === '1'; } catch { return false; }
    });
    const togglePrivacy = () => setPrivacyMode(p => {
        const next = !p;
        try { localStorage.setItem('privacy_mode', next ? '1' : '0'); } catch {}
        return next;
    });
    // Cash rate used as risk-free for the Sharpe-ish ratio. 4% is roughly the
    // Bank of England base rate for the current period; user can edit it in the panel.
    const [cashRate, setCashRate] = useState(4.0);
    // Selected benchmarks. SPX is the canonical one and always present. Others get toggled
    // on/off via chips; only those with a price series uploaded actually render.
    const [selectedBenchmarks, setSelectedBenchmarks] = useState(['^GSPC']);
    // Upload feedback for CSV uploads — transient, auto-dismisses.
    const [uploadFeedback, setUploadFeedback] = useState(null);
    // Export fallback modal — shown when Web Share is unavailable/blocked on iPhone
    const [exportModal, setExportModal] = useState(null); // null | { json, filename }
    // Keep pricesRef in sync so callbacks can read latest prices without dep-array inclusion.
    useEffect(() => { pricesRef.current = prices; }, [prices]);
    // Read by fetchAllPrices without listing loadSource: listing it would re-create the callback after every fetch and
    // re-run the effect that schedules fetches.
    const loadSourceRef = React.useRef(loadSource);
    loadSourceRef.current = loadSource;
    // Keep live refs in sync for shallow-compare guards inside fetchLivePrices.
    useEffect(() => { livePricesRef.current = livePrices; }, [livePrices]);
    useEffect(() => { livePrevCloseRef.current = livePrevClose; }, [livePrevClose]);
    useEffect(() => { liveDailyClosesRef.current = liveDailyCloses; }, [liveDailyCloses]);
    // IndexedDB cache: hydrate on mount, autosave on transaction/prices change.
    // cacheMeta is just a UI-side reflection of what's on disk (savedAt, counts).
    const [cacheMeta, setCacheMeta] = useState(null);
    const [cacheHydrated, setCacheHydrated] = useState(false);
    // Autonomous polling engine state
    const [isPageVisible, setIsPageVisible] = React.useState(true);
    const [isMarketOpen, setIsMarketOpen] = React.useState(false);
    const [isIdle, setIsIdle] = React.useState(false);
    // ── Stage 1.1: Corporate equity compensation configuration ──────────────
    const [compConfigs, setCompConfigs] = useState([]);
    // ── Stage 4.2: External custody holdings (CPWM / Equate) — display only ─
    const [externalHoldings, setExternalHoldings] = useState([]);
    // Hydrate cache on mount: transactions + prices + meta
    useEffect(() => {
        (async () => {
            var _a;
            try {
                const [savedTx, savedPrices, savedMeta] = await Promise.all([
                    idbGet('transactions'),
                    idbGet('prices'),
                    idbGet('meta'),
                ]);
                if (Array.isArray(savedTx) && savedTx.length > 0) {
                    setTransactions(savedTx);
                    if (savedMeta === null || savedMeta === void 0 ? void 0 : savedMeta.fileCount)
                        setFileCount(savedMeta.fileCount);
                }
                if (savedPrices && typeof savedPrices === 'object' && Object.keys(savedPrices).length > 0) {
                    setPrices(savedPrices);
                    if (savedPrices['GBPUSD=X'])
                        setFxGBPUSD(savedPrices['GBPUSD=X']);
                    // Reconstruct loadStatus/loadSource so the chips show 'XL · cached' for each series
                    const status = {};
                    const source = {};
                    for (const tk of Object.keys(savedPrices)) {
                        status[tk] = 'ok';
                        source[tk] = ((_a = savedMeta === null || savedMeta === void 0 ? void 0 : savedMeta.priceSource) === null || _a === void 0 ? void 0 : _a[tk]) || 'xlsx';
                    }
                    setLoadStatus(status);
                    setLoadSource(source);
                }
                if (savedMeta)
                    setCacheMeta(savedMeta);
            }
            catch (e) {
                console.warn('IDB hydrate failed:', e.message);
            }
            setCacheHydrated(true);
        })();
    }, []);
    // ── Stage 1.1: Hydrate compConfigs from IDB on mount ───────────────────
    useEffect(() => {
        (async () => {
            try {
                const savedConfig = await idbGet('corporate_equity_config');
                if (Array.isArray(savedConfig) && savedConfig.length > 0) {
                    // Runtime coercion guard: standardizes legacy string caches imported
                    // before NUMERIC_FIELDS was extended. Prevents typeof gate failures
                    // in the UI (e.g. strikePrice displaying as dash) after app reload.
                    const coercedConfig = savedConfig.map(plan => {
                        const p = Object.assign({}, plan);
                        if (p.option_strike_price  !== undefined) p.option_strike_price  = parseFloat(p.option_strike_price)  || 0;
                        if (p.monthly_contribution !== undefined) p.monthly_contribution = parseFloat(p.monthly_contribution) || 0;
                        if (p.total_contract_months !== undefined) p.total_contract_months = parseInt(p.total_contract_months, 10) || 0;
                        if (p.current_units        !== undefined) p.current_units        = parseFloat(p.current_units)        || 0;
                        if (p.total_target_units   !== undefined) p.total_target_units   = parseFloat(p.total_target_units)   || 0;
                        if (p.estimated_vesting_tax_rate !== undefined) p.estimated_vesting_tax_rate = parseFloat(p.estimated_vesting_tax_rate) || 0;
                        if (p.auto_exercise_days   !== undefined) p.auto_exercise_days   = parseInt(p.auto_exercise_days, 10) || 0;
                        if (p.manual_spot_price    !== undefined) p.manual_spot_price    = parseFloat(p.manual_spot_price)   || 0;
                        if (p.manual_fx_rate       !== undefined) p.manual_fx_rate       = parseFloat(p.manual_fx_rate)      || 0;
                        return p;
                    });
                    setCompConfigs(coercedConfig);
                }
            } catch (e) {
                console.warn('IDB hydrate corporate_equity_config failed:', e.message);
            }
        })();
    }, []);
    // ── Stage 4.2: Hydrate externalHoldings from IDB on mount ──────────────
    // SAFE IMPORT PATH CONSTRAINT: no autosave useEffect — persistence happens
    // exclusively inside handleExternalCustodyCSV to prevent erasure on mount.
    useEffect(() => {
        (async () => {
            try {
                const saved = await idbGet('external_custody_holdings');
                if (Array.isArray(saved) && saved.length > 0) {
                    setExternalHoldings(saved);
                }
            } catch (e) {
                console.warn('IDB hydrate external_custody_holdings failed:', e.message);
            }
        })();
    }, []);
    // Autosave transactions when they change (post-hydration only)
    useEffect(() => {
        if (!cacheHydrated)
            return;
        if (transactions.length === 0)
            return; // don't wipe a real cache by saving an empty state
        (async () => {
            try {
                await idbSet('transactions', transactions);
                const meta = Object.assign(Object.assign({}, (cacheMeta || {})), { savedAt: Date.now(), txCount: transactions.length, fileCount });
                await idbSet('meta', meta);
                setCacheMeta(meta);
            }
            catch (e) {
                console.warn('IDB save tx failed:', e.message);
            }
        })();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [transactions, fileCount, cacheHydrated]);
    // Autosave prices when they change (post-hydration only).
    // IMPORTANT: we re-read meta from IDB inside the effect rather than closing
    // over cacheMeta React state. cacheMeta is a stale snapshot at effect-fire
    // time, so merging loadSource into it would silently overwrite real
    // 'stooq'/'yahoo' values with an older copy. Reading disk state first
    // guarantees the priceSource merge is always additive and never regressive.
    useEffect(() => {
        if (!cacheHydrated)
            return;
        const tickers = Object.keys(prices);
        if (tickers.length === 0)
            return;
        (async () => {
            try {
                await idbSet('prices', prices);
                // Read current on-disk meta so our priceSource merge is always fresh
                const diskMeta = await idbGet('meta');
                const meta = Object.assign(Object.assign({}, (diskMeta || {})), {
                    savedAt: Date.now(),
                    seriesCount: tickers.length,
                    // Merge: disk wins for tickers we haven't touched this session;
                    // loadSource wins for tickers we just fetched (contains real provider name)
                    priceSource: Object.assign(Object.assign({}, ((diskMeta === null || diskMeta === void 0 ? void 0 : diskMeta.priceSource) || {})), loadSource),
                });
                await idbSet('meta', meta);
                setCacheMeta(meta);
            }
            catch (e) {
                console.warn('IDB save prices failed:', e.message);
            }
        })();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [prices, loadSource, cacheHydrated]);
    const clearCache = useCallback(async (mode = 'both') => {
        try {
            if (mode === 'both') {
                await idbClearAll();
                // Core ledger state
                setTransactions([]);
                setPrices({});
                setFxGBPUSD([]);
                setFileCount(0);
                setLoadStatus({});
                setLoadSource({});
                setFetchDebug({});
                setCacheMeta(null);
                // Employer equity and custody state (IDB keys cleared by idbClearAll)
                setCompConfigs([]);
                setExternalHoldings([]);
                // Live price state
                setLivePrices({});
                setLiveQuoteChecks({});
                setLivePrevClose({});
                setLiveDailyCloses({});
                setLiveQuoteSessionDates({});
                setTodayPnlSnapshot(null);
            } else if (mode === 'tx') {
                await idbDelete('transactions');
                setTransactions([]);
                setFileCount(0);
                setCacheMeta(prev => prev ? { ...prev, txCount: 0, fileCount: 0 } : null);
                const diskMeta = await idbGet('meta').catch(() => null);
                if (diskMeta) { diskMeta.txCount = 0; diskMeta.fileCount = 0; await idbSet('meta', diskMeta); }
            } else if (mode === 'prices') {
                await idbDelete('prices');
                setPrices({});
                setFxGBPUSD([]);
                setLoadStatus({});
                setLoadSource({});
                setFetchDebug({});
                // Clear live session quote state — prevents Insights from continuing
                // to show stale daily movers after historical prices are wiped.
                setLivePrices({});
                setLiveQuoteChecks({});
                setLivePrevClose({});
                setLiveDailyCloses({});
                setLiveQuoteSessionDates({});
                setTodayPnlSnapshot(null);
                setLiveStatus('idle');
                setLiveAt(null);
                setCacheMeta(prev => prev ? { ...prev, seriesCount: 0, priceSource: {} } : null);
                const diskMeta = await idbGet('meta').catch(() => null);
                if (diskMeta) { diskMeta.seriesCount = 0; diskMeta.priceSource = {}; await idbSet('meta', diskMeta); }
            }
        }
        catch (e) {
            setUploadError(`Failed to clear cache: ${e.message}`);
        }
    }, []);
    // Track which section is in view for bottom nav active state
        useEffect(() => {
            const sections = ['performance', 'holdings', 'risk', 'attribution', 'contributions', 'transactions'];
            const observers = [];
            sections.forEach(id => {
                const el = document.getElementById(id);
                if (!el)
                    return;
                const obs = new IntersectionObserver(([entry]) => { if (entry.isIntersecting)
                    setActiveSection(id); }, { rootMargin: '-40% 0px -50% 0px', threshold: 0 });
                obs.observe(el);
                observers.push(obs);
            });
            return () => observers.forEach(o => o.disconnect());
        }, [transactions.length]); // re-run when sections mount after data loads
        // Collapse header into compact sticky bar after scrolling ~120px
        useEffect(() => {
            const onScroll = () => setScrolled(window.scrollY > 120);
            window.addEventListener('scroll', onScroll, { passive: true });
            return () => window.removeEventListener('scroll', onScroll);
        }, []);
        const handleFiles = async (files) => {
            setUploadError(null);
            const all = [];
            for (const file of files) {
                try {
                    const text = await file.text();
                    const parsed = parseCSV(text);
                    all.push(...parsed);
                }
                catch (e) {
                    setUploadError(`Failed to read ${file.name}: ${e.message}`);
                    return;
                }
            }
            const keyOf = (t) => `${t.tradeDate}|${t.reference}|${t.value}|${t.description}`;
            const existingKeys = new Set(transactions.map(keyOf));
            const seen = new Set();
            const newOnes = [];
            let intraFileDupes = 0;
            let existingDupes = 0;
            for (const t of all) {
                const k = keyOf(t);
                if (existingKeys.has(k)) {
                    existingDupes++;
                    continue;
                }
                if (seen.has(k)) {
                    intraFileDupes++;
                    continue;
                }
                seen.add(k);
                newOnes.push(t);
            }
            // Date range info: how far does this batch extend history?
            const prevOldest = transactions.length > 0
                ? transactions.reduce((m, t) => parseDate(t.tradeDate) < parseDate(m.tradeDate) ? t : m).tradeDate
                : null;
            const prevNewest = transactions.length > 0
                ? transactions.reduce((m, t) => parseDate(t.tradeDate) > parseDate(m.tradeDate) ? t : m).tradeDate
                : null;
            let extendedOldest = null;
            let extendedNewest = null;
            if (newOnes.length > 0) {
                const newDates = newOnes.map(t => t.tradeDate);
                const oldest = newDates.reduce((m, d) => parseDate(d) < parseDate(m) ? d : m);
                const newest = newDates.reduce((m, d) => parseDate(d) > parseDate(m) ? d : m);
                if (!prevOldest || parseDate(oldest) < parseDate(prevOldest))
                    extendedOldest = oldest;
                if (!prevNewest || parseDate(newest) > parseDate(prevNewest))
                    extendedNewest = newest;
            }
            setTransactions(prev => [...prev, ...newOnes].sort((a, b) => parseDate(b.tradeDate) - parseDate(a.tradeDate)));
            setFileCount(prev => prev + files.length);
            setUploadFeedback({
                added: newOnes.length,
                duplicates: existingDupes + intraFileDupes,
                intraFileDupes,
                existingDupes,
                files: files.length,
                extendedOldest,
                extendedNewest,
                ts: Date.now(),
            });
        };
        // Auto-dismiss CSV upload feedback after 8s
        useEffect(() => {
            if (!uploadFeedback)
                return;
            const t = setTimeout(() => setUploadFeedback(null), 8000);
            return () => clearTimeout(t);
        }, [uploadFeedback]);
        const enriched = useMemo(() => {
            const _enrichedRows = transactions.map(t => {
                const meta = resolveMetadata(t);

                // Construct a safe, unified instrument contract bypassing the null block hole.
                // Instruments with n/a or empty Yahoo tickers get a stable 'UNTICKERED' sentinel
                // so they remain visible in holdings and timeline loops rather than disappearing.
                const instrument = {
                    ticker:      (meta && meta.yahooTicker && meta.yahooTicker.toLowerCase() !== 'n/a') ? meta.yahooTicker : 'UNTICKERED',
                    stooqTicker: (meta && meta.stooqTicker && meta.stooqTicker.toLowerCase() !== 'n/a') ? meta.stooqTicker : 'n/a',
                    name:        (t.assetName || t.description || '').slice(0, 50).trim(),
                    // Prefer the explicit CSV sector column; fall back to keyword classification
                    sector:      (t.sector && t.sector !== 'Other') ? t.sector
                                 : classifySectorByKeyword(t.assetName || t.description, t.yahooTicker),
                    status:      t.status || 'active',
                    currency:    meta ? meta.currency : 'GBP',
                };

                return Object.assign(Object.assign({}, t), {
                    category:   categoriseTransaction(t),
                    instrument,
                    parsedDate: parseDate(t.tradeDate),
                });
            });
            deriveLedgerGilts(_enrichedRows);   // gilts new to the ledger get a registry entry; no code change needed
            return finaliseEnriched(_enrichedRows);
        }, [transactions]);
        // Performance ledger: the ledger with purchases and sales of GILTS, CASH-LIKE FUNDS (money-market, ultra-short income)
        // and BOND FUNDS turned into plain cash movements. Those are outside the measured portfolio (performance, the S&P
        // comparison, XIRR and risk cover equity and uninvested cash), so money going into one counts as money leaving the
        // measured portfolio and proceeds as money re-entering it. Holdings, the gilt ladder and today's totals are
        // untouched; only the performance engines read this list.
        const perfLedger = useMemo(() => {
            const descs = {};
            for (const t of enriched) {
                const tk = t.instrument && t.instrument.ticker;
                if (tk && tk !== 'UNTICKERED') (descs[tk] = descs[tk] || []).push(t.description || '');
            }
            const cls = {}, byClass = { gilt: [], cashlike: [], bond: [] };
            for (const [tk, d] of Object.entries(descs)) {
                const c = performanceExclusionClass(tk, d);
                if (c) { cls[tk] = c; byClass[c].push(tk); }
            }
            let moved = 0;
            const rows = enriched.map(t => {
                const tk = t.instrument && t.instrument.ticker;
                if (tk && cls[tk] && (t.category === 'buy' || t.category === 'sell')) {
                    moved++;
                    return Object.assign({}, t, { category: 'transfer', origCategory: t.category, perfExcluded: cls[tk],
                        instrument: Object.assign({}, t.instrument, { ticker: 'UNTICKERED' }), origTicker: tk });
                }
                return t;
            });
            Object.defineProperty(rows, '__transfers', { value: enriched.__transfers, enumerable: false });
            Object.defineProperty(rows, '__excluded', { value: { tickers: Object.keys(cls), byClass, classOf: cls, rows: moved }, enumerable: false });
            return rows;
        }, [enriched]);
        const inception = useMemo(() => {
            if (enriched.length === 0)
                return null;
            return enriched.reduce((min, t) => t.parsedDate < min ? t.parsedDate : min, enriched[0].parsedDate);
        }, [enriched]);
        // today: tracks the current calendar date. Using [] froze it at mount time — breaking
        // overnight sessions (phone stands) where fetchAllPrices toDate and weeklyDates boundary
        // would silently point to yesterday. A midnight-aware state ensures correctness.
        const [todayDate, setTodayDate] = React.useState(() => new Date());
        React.useEffect(() => {
            const msUntilMidnight = () => {
                const now = new Date();
                const midnight = new Date(now);
                midnight.setHours(24, 0, 0, 0);
                return midnight - now;
            };
            let t = setTimeout(function tick() {
                setTodayDate(new Date());
                t = setTimeout(tick, msUntilMidnight());
            }, msUntilMidnight());
            return () => clearTimeout(t);
        }, []);
        const today = todayDate;
        const tickersUsed = useMemo(() => {
            var _a;
            const set = new Set();
            for (const t of enriched) {
                const tk = (_a = t.instrument) === null || _a === void 0 ? void 0 : _a.ticker;
                // Exclude the UNTICKERED sentinel — it has no exchange listing and no Stooq/Yahoo symbol.
                // Include transfer_in so tickers arriving via spousal gift are fetched even when
                // there is no corresponding buy in this dataset.
                if (tk && tk !== 'UNTICKERED' && (t.category === 'buy' || t.category === 'sell' || t.category === 'transfer_out' || t.category === 'transfer_in')) {
                    set.add(tk);
                }
            }
            return Array.from(set);
        }, [enriched]);
        // Fix 5: Expanded ticker pool — merges HL ledger tickers with employer equity
        // and external custody tickers so that C, HSBA.L, GBPUSD=X etc. are always
        // fetched even when they have no corresponding HL transaction.
        const allPriceTickers = useMemo(() => {
            const compTickers     = compConfigs.map(p => p.yahoo_ticker).filter(Boolean);
            const custodyTickers  = externalHoldings.map(h => h.ticker).filter(Boolean);
            return Array.from(new Set([...tickersUsed, ...compTickers, ...custodyTickers, 'GBPUSD=X']));
        }, [tickersUsed, compConfigs, externalHoldings]);
        // ── Ticker metadata maps (derived from CSV, replaces static TICKER_CURRENCY) ──
        // tickerCurrencyMap: Yahoo ticker → 'GBP' | 'GBX' | 'USD'
        //   Used by pxToGBP() everywhere instead of the old TICKER_CURRENCY constant.
        const fileCurrencyMap = useMemo(() => {
            const map = {};
            for (const t of enriched) {
                if (t.yahooTicker && t.yahooTicker !== 'n/a' && t.currency) {
                    map[t.yahooTicker] = t.currency;
                }
            }
            return map;
        }, [enriched]);
        // configCurrencyMap: currencies stated in the HL CSV, equity-plan configs and
        // custody file. tickerCurrencyMap (effective, used for every conversion):
        // Yahoo's currency from the latest accepted quote wins over the file's.
        const configCurrencyMap = useMemo(
            () => buildExpectedQuoteCurrencyMap(fileCurrencyMap, compConfigs, externalHoldings),
            [fileCurrencyMap, compConfigs, externalHoldings]);
        const baseCurrencyMap = useMemo(
            () => buildEffectiveCurrencyMap(configCurrencyMap, quoteCurrencies),
            [configCurrencyMap, quoteCurrencies]);
        // Price-unit audit (see auditPriceUnits): a pounds-vs-pence disagreement between a stored series and the ledger is
        // corrected here, silently.
        const unitAudit = useMemo(
            () => auditPriceUnits(enriched, prices, baseCurrencyMap, quoteCurrencies),
            [enriched, prices, baseCurrencyMap, quoteCurrencies]);
        const tickerCurrencyMap = useMemo(
            () => Object.assign({}, baseCurrencyMap, unitAudit.corrections),
            [baseCurrencyMap, unitAudit]);
        // Pay values a year's share vests at today's price (PayStore.setPriceFeed): the share plan whose institution is the
        // stock's name on the Pay sheet ('Citi') gives the ticker; the live quote (else the last stored close) is converted
        // to pounds. The feed is set once and reads this ref, so a price tick never touches Pay's store.
        const payFeedRef = React.useRef({});
        payFeedRef.current = { compConfigs, tickerCurrencyMap };
        useEffect(() => {
            if (!window.PayStore || !window.PayStore.setPriceFeed) return;
            const lastClose = (series) => {
                if (!Array.isArray(series)) return null;
                for (let i = series.length - 1; i >= 0; i--) { const c = Number(series[i] && series[i].close); if (Number.isFinite(c) && c > 0) return c; }
                return null;
            };
            const latest = (tk) => {
                const up = String(tk).toUpperCase().trim();
                const pick = (obj) => { const k = Object.keys(obj || {}).find(x => x.toUpperCase().trim() === up); return k ? obj[k] : undefined; };
                const live = Number(pick(livePricesRef.current));
                return Number.isFinite(live) && live > 0 ? live : lastClose(pick(pricesRef.current));
            };
            window.PayStore.setPriceFeed((stockName) => {
                const key = String(stockName || '').toLowerCase().trim();
                if (!key) return null;
                const ctx = payFeedRef.current;
                const plan = (ctx.compConfigs || []).find(p => p && p.yahoo_ticker && String(p.institution || '').toLowerCase().includes(key));
                if (!plan) return null;
                const px = latest(plan.yahoo_ticker);
                if (px == null) return null;
                const ccy = lookupCurrency(ctx.tickerCurrencyMap, String(plan.yahoo_ticker).toUpperCase().trim()) || plan.currency;
                return pxToGBPWithCurrency(px, ccy, latest('GBPUSD=X'));
            });
            return () => window.PayStore.setPriceFeed(null);
        }, []);
        // tickerStooqMap: Yahoo ticker → provider-specific Stooq ticker (e.g. FLRK.L → FLRK.UK)
        //   Used in fetchAllPrices to route each ticker to the correct Stooq symbol.
        //   Benchmarks not in this map fall back to toStooqSym() conversion.
        // Stooq is no longer used for prices; this map is kept only because backups
        // carry it (metadata.stooq_aliases), so older and newer backups stay compatible.
        const tickerStooqMap = useMemo(() => {
            const map = {};
            for (const t of enriched) {
                if (t.yahooTicker && t.yahooTicker !== 'n/a' && t.stooqTicker) {
                    map[t.yahooTicker] = t.stooqTicker;
                }
            }
            return map;
        }, [enriched]);
        // tickerNameMap: Yahoo ticker → display name from the CSV "Asset Name" column.
        // Replaces TICKER_MAP name lookups in attribution and any other views that need
        // a human-readable label keyed by ticker without iterating over enriched directly.
        const tickerNameMap = useMemo(() => {
            const map = {};
            for (const t of enriched) {
                if (t.yahooTicker && t.yahooTicker !== 'n/a' && t.assetName) {
                    map[t.yahooTicker] = t.assetName;
                }
            }
            return map;
        }, [enriched]);
        // A. Monitor Device/Tab Visibility across iOS Chrome wrappers
        React.useEffect(() => {
            // Named references required — removeEventListener won't match inline arrow functions.
            const handleVisibility = () => setIsPageVisible(document.visibilityState === 'visible');
            const handleFocus = () => setIsPageVisible(true);
            const handlePageShow = () => setIsPageVisible(true);
            // Guard: on iPhone, raising the keyboard fires window 'blur' even though the page is
            // still visible. Only mark invisible if visibilityState confirms the page is actually hidden.
            const handleBlur = () => { if (document.visibilityState !== 'visible') setIsPageVisible(false); };
            window.addEventListener('visibilitychange', handleVisibility);
            window.addEventListener('focus', handleFocus);
            window.addEventListener('pageshow', handlePageShow);
            window.addEventListener('blur', handleBlur);
            return () => {
                window.removeEventListener('visibilitychange', handleVisibility);
                window.removeEventListener('focus', handleFocus);
                window.removeEventListener('pageshow', handlePageShow);
                window.removeEventListener('blur', handleBlur);
            };
        }, []);
        // B. Market-hours flag for polling: true while London or New York is trading.
        // isIdle added to dep array: when deep-idle, skip the interval entirely (true zero-compute sleep).
        React.useEffect(() => {
            if (isIdle) return; // App is in deep idle - no point polling market status every 30s.
            const checkLondonMarket = () => {
                try {
                    // London (08:00–16:30) or New York (09:30–16:00 local) trading day
                    // and hours, holidays from EXCHANGE_CALENDARS.
                    setIsMarketOpen(anyTrackedMarketOpen(Date.now()));
                } catch (e) {
                    const utcHour = new Date().getUTCHours();
                    setIsMarketOpen(utcHour >= 8 && utcHour <= 17);
                }
            };
            checkLondonMarket();
            const timeTracker = setInterval(checkLondonMarket, 30000);
            return () => clearInterval(timeTracker);
        }, [isPageVisible, isIdle]);
        // C. Mobile Battery & Serverless Safeguard — 12-min touch-inactivity idle
        React.useEffect(() => {
            // Mount-once: attach listeners for the lifetime of the component.
            // dep array is [] — including isIdle would cause the hook to remount on every idle
            // toggle, re-running resetIdleTimeout() and immediately clearing the idle state (loop).
            let idleTimer;
            const resetIdleTimeout = () => {
                setIsIdle(false); // wake up if idle — safe to call even when already awake
                clearTimeout(idleTimer);
                idleTimer = setTimeout(() => setIsIdle(true), 12 * 60 * 1000);
            };
            window.addEventListener('touchstart', resetIdleTimeout, { passive: true });
            window.addEventListener('scroll', resetIdleTimeout, { passive: true });
            resetIdleTimeout();
            return () => {
                clearTimeout(idleTimer);
                window.removeEventListener('touchstart', resetIdleTimeout);
                window.removeEventListener('scroll', resetIdleTimeout);
            };
        }, []); // [] — intentionally mount-once; isIdle must NOT be a dep here

        // ── Environment Guard (Claude Artifacts & Offline) ─────────────────────
        const isNetworkRestricted = () => {
            if (!navigator.onLine) return true;
            try {
                if (window.origin === 'null') return true;
            } catch (e) {
                return true;
            }
            return false;
        };

        // Determines whether a ticker had an open position at any point in the trailing 90 days.
        // Used to skip daily price fetches and live quotes for long-closed positions.
        // Benchmarks and FX pairs always return true — they're always needed for chart calculations.
        const checkAssetOpenInLast3M = useCallback((ticker) => {
            if (ticker === '^GSPC' || ticker === BENCH_TR_TICKER || ticker === 'GBPUSD=X') return true;
            const ninetyDaysAgo = new Date(today.getTime() - 90 * 86400 * 1000);
            let cumulativeUnits = 0;
            const assetTrades = enriched
                .filter(t => t.instrument?.ticker === ticker)
                .sort((a, b) => a.parsedDate - b.parsedDate);
            for (const t of assetTrades) {
                const qty = parseFloat((t.quantity || '').replace(/,/g, '')) || 0;
                if (t.category === 'buy' || t.category === 'transfer_in') cumulativeUnits += qty;
                else if (t.category === 'sell' || t.category === 'transfer_out') cumulativeUnits -= qty;
                if (t.parsedDate >= ninetyDaysAgo && cumulativeUnits > 0.001) return true;
            }
            return cumulativeUnits > 0.001;
        }, [enriched, today]);

        // onlyTickers: retry just these (today's pending tickers); anything else, e.g. a click event, means all.
        const fetchAllPrices = useCallback(async (onlyTickers) => {
            // Fix 5: use allPriceTickers (HL + comp + custody) so employer-only tickers
            // like C and HSBA.L are fetched even without an HL transaction for them.
            const hasTickers = allPriceTickers.filter(t => t !== 'GBPUSD=X').length > 0;
            if (!inception || !hasTickers) return;
            if (isNetworkRestricted()) { setLiveStatus('offline'); return Promise.resolve(); }

            setLoading(true);
            try {
                const retryOnly  = Array.isArray(onlyTickers) ? new Set(onlyTickers) : null;
                const allTickers = [...allPriceTickers, '^GSPC', BENCH_TR_TICKER].filter(t => !retryOnly || retryOnly.has(t));
                if (allTickers.length === 0) { markHistoryRefreshed(Date.now(), []); return; }
                // Tickers declared as Yahoo symbols in the equity-plan / custody files.
                // These are real listings even without an exchange suffix (e.g. "C").
                const declaredMarketTickers = new Set([
                    ...compConfigs.map(p => p.yahoo_ticker),
                    ...externalHoldings.map(h => h.ticker),
                    // ledger lines the file says are quoted in a foreign currency (e.g. a USD award vest)
                    ...Object.keys(fileCurrencyMap).filter(tk => isListedTicker(tk, fileCurrencyMap)),
                ].filter(Boolean).map(t => String(t).toUpperCase().trim()));
                const seriesOpts = t => ({ yahooIsMarketSymbol: declaredMarketTickers.has(String(t).toUpperCase().trim()) });
                const inceptionFrom = fmtDate(new Date(inception.getTime() - 86400 * 1000 * 14));
                const toDate = fmtDate(today);
                const currentPrices = pricesRef.current;

                // Mark all tickers as loading in a single upfront write
                const loadingStatus = Object.fromEntries(allTickers.map(t => [t, 'loading']));
                if (retryOnly) setLoadStatus(prev => Object.assign({}, prev, loadingStatus));
                else { setLoadStatus(loadingStatus); setFetchDebug({}); }

                // ── Phase 1: fetch every ticker in parallel (pure results, no shared writes) ──
                // Full refresh every time: weekly closes from inception plus a 90-day daily
                // tail, from ONE fetch session, replacing the stored series over that range
                // (mergeHistorySeries). Adjusted closes are restated at each ex-dividend
                // date, so a series must never be stitched from fetches made on different
                // days. If the weekly fetch fails, the stored series is kept untouched.
                const ninetyDaysAgo = fmtDate(new Date(today.getTime() - 90 * 86400 * 1000));
                const tickerResults = await Promise.all(allTickers.map(async ticker => {
                    const existing = currentPrices[ticker];
                    const opts = seriesOpts(ticker);
                    let weekly;
                    try {
                        weekly = await fetchPriceSeries(ticker, inceptionFrom, toDate, 'weekly', opts);
                    } catch (e) {
                        return {
                            ticker, prices: existing || [], refreshed: false,
                            status: existing?.length ? 'ok' : 'fail',
                            source: loadSourceRef.current[ticker] || 'fail',
                            debug:  existing?.length
                                ? [{ src: 'cache', result: 'ok', msg: `refresh failed (${(e.attempts && e.attempts[0] && e.attempts[0].msg) || e.message}) — keeping ${existing.length} stored pts` }]
                                : (e.attempts || [{ src: 'yahoo', result: 'fail', msg: e.message }]),
                        };
                    }
                    if (weekly.source === 'synthetic') {
                        return { ticker, prices: existing || [], status: 'ok', source: 'synthetic', debug: weekly.attempts, refreshed: false };
                    }
                    // Daily tail: open positions, declared market tickers (e.g. Citi), FX and the benchmark.
                    const wantDaily = checkAssetOpenInLast3M(ticker) || opts.yahooIsMarketSymbol
                        || ticker === 'GBPUSD=X' || ticker === '^GSPC' || ticker === BENCH_TR_TICKER;
                    let daily = null, dailyErr = null;
                    if (wantDaily) {
                        try { daily = await fetchPriceSeries(ticker, ninetyDaysAgo, toDate, 'daily', opts); }
                        catch (e) { dailyErr = (e.attempts && e.attempts[0] && e.attempts[0].msg) || e.message; }
                    }
                    // Weekly alone would replace the stored 90-day daily tail with Friday bars, so with a stored series
                    // a failed daily fetch is a failed refresh: keep the series and retry later today.
                    if (dailyErr && existing?.length) {
                        return { ticker, prices: existing, refreshed: false, status: 'ok', source: loadSourceRef.current[ticker] || 'yahoo',
                            debug: [{ src: 'yahoo-daily', result: 'fail', msg: `refresh failed (${dailyErr}) — keeping ${existing.length} stored pts` }] };
                    }
                    const merged = mergeHistorySeries(existing, weekly.data, daily ? daily.data : []);
                    const alt    = cachedSecondSourceRows(ticker);
                    const clean  = cleanHistorySeries(merged, dailyCheckProfileFor(ticker), alt.rows, alt.name);
                    const filled = backfillHistoryGapsFromSecondSource(clean.rows, ticker);
                    const debug  = [{ src: 'yahoo', result: 'ok', msg: `${weekly.data.length} weekly + ${daily ? daily.data.length : 0} daily pts` }];
                    if (dailyErr) debug.push({ src: 'yahoo-daily', result: 'fail', msg: dailyErr + ' — weekly only until the retry' });
                    if (clean.dropped.length) debug.push({ src: 'quality', result: 'fail',
                        msg: 'dropped ' + clean.dropped.map(d => d.date + ' ' + d.reason).join(', ') });
                    if (filled.filled.length) debug.push({ src: alt.name || 'second-source', result: 'ok',
                        msg: 'filled Yahoo gap: ' + filled.filled.join(', ') });
                    return { ticker, prices: filled.rows, status: 'ok', source: 'yahoo', debug, refreshed: !dailyErr };
                }));

                // ── Phase 2: reduce into immutable state maps ──────────────────────
                // Single pass over results; no shared-object mutation. Each reduce call
                // produces a brand-new map that React can diff correctly.
                const finalPrices = tickerResults.reduce((acc, r) => {
                    if (r.prices && r.prices.length > 0) acc[r.ticker] = r.prices;
                    return acc;
                }, Object.assign({}, currentPrices));

                const finalStatus = tickerResults.reduce((acc, r) => { acc[r.ticker] = r.status; return acc; }, {});
                const finalSource = tickerResults.reduce((acc, r) => { acc[r.ticker] = r.source; return acc; }, Object.assign({}, loadSourceRef.current));
                const finalDebug  = tickerResults.reduce((acc, r) => { acc[r.ticker] = r.debug;  return acc; }, {});
                // Every ticker that was meant to refresh and didn't stays pending for a retry later today.
                const pending = tickerResults.filter(r => !r.refreshed && r.source !== 'synthetic').map(r => r.ticker);

                // ── Phase 3: single atomic state commit ───────────────────────────
                // React 18 batches these into one render pass — the UI never sees
                // partially-updated data between setters.
                setPrices(finalPrices);
                setLoadStatus(retryOnly ? prev => Object.assign({}, prev, finalStatus) : finalStatus);
                setLoadSource(finalSource);
                setFetchDebug(retryOnly ? prev => Object.assign({}, prev, finalDebug) : finalDebug);
                if (finalPrices['GBPUSD=X']) setFxGBPUSD(finalPrices['GBPUSD=X']);
                markHistoryRefreshed(Date.now(), pending);
            } finally {
                setLoading(false);
            }
        }, [inception, today, allPriceTickers, checkAssetOpenInLast3M, compConfigs, externalHoldings, fileCurrencyMap]);

        // Price-feed health (feedBanner). State only changes when the strip itself would, so a 15 s poll never re-renders the app.
        const feedHealthRef = React.useRef(null);
        if (feedHealthRef.current == null) feedHealthRef.current = feedHealthLoad();
        const [feedStrip, setFeedStrip] = useState(() => feedBanner(feedHealthRef.current, Date.now()));
        const recordFeed = useCallback((ev) => {
            const now = Date.now();
            feedHealthRef.current = feedHealthNext(feedHealthRef.current, ev, now);
            _dcSave(FEED_HEALTH_KEY, feedHealthRef.current);
            const strip = feedBanner(feedHealthRef.current, now);
            setFeedStrip(prev => (prev ? prev.text : '') === (strip ? strip.text : '') && (prev ? prev.level : '') === (strip ? strip.level : '') ? prev : strip);
        }, []);
        const fetchLivePricesCore = useCallback(async (opts = {}, runId = 0) => {
            const silent = !!opts.silent;
            const forceSources = normaliseForceSources(opts); // manual re-check: which sources may bypass their cache (and spend quota)
            // Fix 5: include comp/custody tickers — these bypass the checkAssetOpenInLast3M
            // gate because they're never in the HL ledger, but still need live quotes.
            const hlActiveTickers = tickersUsed.filter(tk => isListedTicker(tk, configCurrencyMap) && checkAssetOpenInLast3M(tk));
            const compTickers     = compConfigs.map(p => p.yahoo_ticker).filter(Boolean);
            const custodyTickers  = externalHoldings.map(h => h.ticker).filter(Boolean);
            const activeTickers   = Array.from(new Set([...hlActiveTickers, ...compTickers, ...custodyTickers]));
            if (activeTickers.length === 0 || !getWorkerUrl()) return;
            if (isNetworkRestricted()) { if (!silent) setLiveStatus('offline'); return Promise.resolve(); }

            // Silent refreshes do not show the global loading spinner.
            if (!silent) setLiveStatus('fetching');
            // Debug gate: set true to log per-ticker previous-close source selection.
            // Useful when Today P&L looks wrong — reveals which Yahoo field was chosen.
            const DEBUG_LIVE_PREV_CLOSE = false;
            const newLive = {};
            let gatedFresh = null;   // quotes that survived the live gate, before any last-good carry-forward
            const newPrevClose = {};
            // Full recent daily-close series per ticker, captured from the 5-day chart.
            // Stored so the previous-close resolver can pick the correct prior session by
            // ACTUAL date — independent of meta.regularMarketTime, which is ambiguous for
            // US tickers quoted during London pre-market.
            const newDailyCloses = {};
            // Per-ticker quote session dates keyed from meta.regularMarketTime.
            // Populated inside the fetch loop; committed after all tickers resolve.
            const newQuoteSessionDates = {};
            // Yahoo's reported quote currency per ticker (meta.currency, e.g. 'GBp',
            // 'GBP', 'USD') — compared with the CSV/config currency by the live gate.
            const newQuoteCurrency = {};
            await Promise.all(activeTickers.concat(['GBPUSD=X', '^GSPC', BENCH_TR_TICKER]).map(async ticker => {
                try {
                    // range=5d&interval=1d: fetches settled daily closes rather than intraday ticks.
                    // meta.regularMarketPrice always holds the most recent quote regardless of
                    // whether the market is open or closed — fixes stale data outside trading hours.
                    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=5d&interval=1d`;
                    const res = await proxyFetch(url, null);
                    const json = JSON.parse(await res.text());
                    const result = json?.chart?.result?.[0];
                    if (!result) return;
                    paYahooResult(res, result, ticker);
                    const meta   = result.meta;
                    const px     = meta.regularMarketPrice ?? meta.previousClose;
                    const normTk = ticker.toUpperCase().trim();
                    if (px != null && !isNaN(px)) newLive[normTk] = px;

                    // ── Quote session date from regularMarketTime ─────────────────────────
                    // This is the authoritative per-ticker session date — the Unix timestamp of
                    // the market session the returned price belongs to, not the fetch time.
                    // A Saturday fetch for EQGB.L returns regularMarketTime pointing to Friday.
                    // Dated in the exchange's own timezone (not UTC) — see yahooQuoteSessionDate.
                    const quoteSessionDate = yahooQuoteSessionDate(meta);
                    if (quoteSessionDate) newQuoteSessionDates[normTk] = quoteSessionDate;
                    if (meta.currency) newQuoteCurrency[normTk] = meta.currency;

                    // ── Previous-close selection (timestamp-aware) ────────────────────────
                    // getPreviousCompletedCloseFromSeries pairs timestamps with closes, sorts
                    // ascending by timestamp, identifies the current session by its calendar
                    // date, and returns the most recent bar strictly before that date.
                    // This correctly rejects any null/partial current-day bar and never
                    // selects an older bar when a more recent completed session exists.
                    const chartTs        = result.timestamp ?? [];
                    const chartCloses    = result.indicators?.quote?.[0]?.close ?? [];
                    const currentQuoteTs = typeof meta.regularMarketTime === 'number' ? meta.regularMarketTime : null;
                    const chartDerived   = getPreviousCompletedCloseFromSeries(chartTs, chartCloses, currentQuoteTs);

                    // Capture the FULL valid daily-close series ({date, close}) from this chart.
                    // This is the app's real access to recent closing levels for every fetched
                    // ticker — including restricted tickers (C, HSBA.L) absent from `prices`.
                    // getPreviousCloseFromPriceHistory consumes this and selects the latest close
                    // strictly before today's actual date, so a stale week-old scalar can never win.
                    // Bars are dated in the exchange's timezone, one row per date.
                    const dailySeries = yahooDailyRowsFromChart(result);
                    if (dailySeries.length > 0) newDailyCloses[normTk] = dailySeries;

                    // Meta-field fallback chain — only used when chart series yields nothing.
                    // Priority: regularMarketPreviousClose > previousClose > chartPreviousClose.
                    // NOT used: regularMarketOpen, 52-week values, post-market fields.
                    const rmpc  = meta.regularMarketPreviousClose;
                    const legpc = meta.previousClose;
                    const chpc  = meta.chartPreviousClose;
                    let metaPrevClose = null, metaSource = 'none';
                    if (rmpc  != null && !isNaN(rmpc)  && rmpc  > 0) { metaPrevClose = rmpc;  metaSource = 'regularMarketPreviousClose'; }
                    else if (legpc != null && !isNaN(legpc) && legpc > 0) { metaPrevClose = legpc; metaSource = 'previousClose'; }
                    else if (chpc  != null && !isNaN(chpc)  && chpc  > 0) { metaPrevClose = chpc;  metaSource = 'chartPreviousClose'; }

                    // Chart-derived wins over any meta field when the series has data.
                    // If they materially disagree (>2%), log the conflict; chart-derived still wins.
                    let prevClose = null, prevCloseSource = 'none', prevCloseDate = null, metaRejected = false;
                    if (chartDerived) {
                        prevClose = chartDerived.value; prevCloseSource = 'chart-series-by-session-date'; prevCloseDate = chartDerived.date;
                        if (metaPrevClose != null && Math.abs(metaPrevClose / chartDerived.value - 1) > 0.02) metaRejected = true;
                    } else if (metaPrevClose != null) {
                        prevClose = metaPrevClose; prevCloseSource = metaSource;
                    }

                    if (prevClose != null && !isNaN(prevClose)) newPrevClose[normTk] = prevClose;
                    if (DEBUG_LIVE_PREV_CLOSE) console.table([{
                        ticker:                normTk,
                        livePrice:             px             ?? null,
                        currentQuoteTs:        currentQuoteTs ?? null,
                        chartDerivedPrevClose: chartDerived   ? chartDerived.value : null,
                        chartDerivedDate:      chartDerived   ? chartDerived.date  : null,
                        chartCandidates:       chartDerived   ? JSON.stringify(chartDerived.allCandidates) : '[]',
                        rawMeta_rmpc:          rmpc           ?? null,
                        rawMeta_legpc:         legpc          ?? null,
                        rawMeta_chpc:          chpc           ?? null,
                        prevCloseSelected:     prevClose      ?? null,
                        prevCloseDate:         prevCloseDate  ?? null,
                        source:                prevCloseSource,
                        metaRejected:          metaRejected,
                        reason:                prevClose == null ? 'no-series-and-no-valid-meta' : null,
                    }]);
                } catch { /* silent — live is best-effort */ }
            }));

            // ── Daily-close backfill (isolated; never writes `prices`) ─────────────────
            // Some quotes — notably US restricted equities like C — can come back from
            // the range=5d live chart with a price but an empty `close` array. The
            // previous-close resolver has no other source of recent closes (by design:
            // stored history is not session-checked), so for any ticker that got a live
            // price but NO daily series this cycle, fetch ~3 weeks of daily closes from
            // Yahoo's period-based chart. Rows are built by yahooDailyRowsFromChart, so
            // they are dated and valued exactly like the live-chart rows (exchange-local
            // dates, raw closes). Stored ONLY in liveDailyCloses; cached per day.
            const backfillTodayKey = fmtDate(new Date());
            const backfillTickers = activeTickers.filter(tk => {
                const ntk = tk.toUpperCase().trim();
                if (newLive[ntk] == null) return false;                                  // no quote → nothing to compute
                return !(newDailyCloses[ntk] && newDailyCloses[ntk].length > 0);        // live chart already supplied rows
            });
            if (backfillTickers.length > 0) {
                const bfTo   = backfillTodayKey;
                const bfFrom = fmtDate(new Date(Date.now() - 21 * 86400 * 1000)); // ~3 weeks of daily closes
                await Promise.all(backfillTickers.map(async tk => {
                    const ntk = tk.toUpperCase().trim();
                    // Reuse a same-day cached backfill to avoid re-fetching on every poll
                    const cached = restrictedDailyCacheRef.current[ntk];
                    if (cached && cached.date === backfillTodayKey && Array.isArray(cached.series) && cached.series.length > 0) {
                        newDailyCloses[ntk] = cached.series;
                        return;
                    }
                    try {
                        const series = await fetchYahooDailyCloseRows(tk, bfFrom, bfTo, null);
                        if (series.length > 0) {
                            newDailyCloses[ntk] = series;
                            restrictedDailyCacheRef.current[ntk] = { date: backfillTodayKey, series };
                        }
                    } catch { /* best-effort — without rows, Today shows "—" for this ticker */ }
                }));
            }

            // ── Daily-close cross-check (Phase 1: cached second-source data only) ──
            // Never blocks on the network: merges Yahoo with whatever Twelve Data /
            // Alpha Vantage closes are already cached, so live prices commit at once.
            // Phase 2 (after commit, below) fetches anything missing in the background
            // and re-merges when it lands. Runs even without keys (Yahoo-only rows) so
            // the missing-session check still stops a multi-day move showing as Today.
            const verifyTks = Array.from(new Set(activeTickers.map(t => String(t).toUpperCase().trim())))
                .filter(isDailyCheckVerifiableTicker);
            const rawYahooDaily = {};
            verifyTks.forEach(ntk => { if (newDailyCloses[ntk]) rawYahooDaily[ntk] = newDailyCloses[ntk]; });
            yahooDailyRawRef.current = Object.assign({}, yahooDailyRawRef.current, rawYahooDaily);
            const sessionDateFor = ntk => newQuoteSessionDates[ntk] || getCurrentPnlSessionDateStr();
            const newDailyCheckStatus = {};
            {
                const cached = await fetchSecondaryDailyCloses(verifyTks, { allowFetch: { td: false, av: false, ms: false }, sessionDateFor });
                for (const ntk of verifyTks) {
                    const yRows = newDailyCloses[ntk] || [];
                    const sec   = cached[ntk] || null;
                    const m     = mergeYahooWithSecondary(ntk, yRows, sec, newLive[ntk]);
                    if (m.rows.length === 0) continue;
                    newDailyCloses[ntk] = m.rows;
                    newDailyCheckStatus[ntk] = {
                        provider: sec ? sec.provider : null, error: sec ? sec.error : null,
                        pending: !!(sec && sec.pending), altRows: sec ? sec.rows.length : 0,
                        unitFactor: m.factor, unitMismatch: m.unitMismatch,
                        sources: compactDailyCheckSources(sec),
                    };
                }
            }
            const dailyCheckSig = m => Object.keys(m || {}).sort().map(k => {
                const v = m[k] || {};
                return k + ':' + (v.error || '') + ':' + (v.altRows ?? '') + ':' + (v.unitFactor ?? '') + ':' + (v.provider || '') + ':' + (v.pending ? 1 : 0) + ':' + dailyCheckSourcesSig(v.sources);
            }).join('|');
            // Only re-render when the diagnostic content actually changed (polls run every 15 s).
            setDailyCheckStatus(prev => dailyCheckSig(prev) === dailyCheckSig(newDailyCheckStatus) ? prev : newDailyCheckStatus);

            // ── Live-quote gate (see assessLiveQuote) ─────────────────────────────
            // Runs on the graded rows built above, BEFORE anything is committed, so a
            // rejected quote never reaches livePrices — and therefore never reaches
            // portfolio value, charts, restricted schemes or Today. A rejected ticker
            // behaves exactly like a failed fetch for that ticker this cycle.
            // A newer refresh started while this one was in flight: let that one commit.
            if (runId && runId !== liveRunIdRef.current) return;

            {
                const gate = gateLiveQuotes({
                    quotes:             newLive,
                    sessionDates:       newQuoteSessionDates,
                    dailyCloses:        newDailyCloses,
                    prices:             pricesRef.current,
                    quoteCurrencies:    newQuoteCurrency,
                    expectedCurrencies: configCurrencyMap,
                });
                Object.keys(newLive).forEach(k => { if (!(k in gate.accepted)) delete newLive[k]; });
                gatedFresh = Object.keys(newLive).length;
                // Record today's currency for every accepted fresh quote.
                const acceptedCcy = {};
                Object.keys(newLive).forEach(k => { const n = normaliseQuoteCurrency(newQuoteCurrency[k]); if (n) acceptedCcy[k] = n; });
                if (Object.keys(acceptedCcy).length) setQuoteCurrencies(prev => {
                    if (!Object.keys(acceptedCcy).some(k => prev[k] !== acceptedCcy[k])) return prev;
                    const next = Object.assign({}, prev, acceptedCcy);
                    _dcSave(QUOTE_CURRENCY_KEY, next);
                    return next;
                });
                let checks = gate.checks;
                // Last-good-quote carry-forward (see carryForwardLiveQuotes). Skipped when
                // nothing fresh arrived, so a total outage still shows as a failed refresh.
                if (Object.keys(newLive).length > 0) {
                    const requested = activeTickers.concat(['GBPUSD=X', '^GSPC', BENCH_TR_TICKER]).map(t => String(t).toUpperCase().trim());
                    const cf = carryForwardLiveQuotes({
                        requested, fresh: newLive, previous: livePricesRef.current,
                        freshRows: newDailyCloses, previousRows: liveDailyClosesRef.current,
                        checks, lastGoodAt: lastGoodQuoteAtRef.current, now: Date.now(),
                    });
                    Object.assign(newLive, cf.quotes);
                    Object.assign(newDailyCloses, cf.rows);
                    lastGoodQuoteAtRef.current = cf.lastGoodAt;
                    checks = cf.checks;
                }
                setLiveQuoteChecks(prev =>
                    liveQuoteChecksSignature(prev) === liveQuoteChecksSignature(checks) ? prev : checks);
            }

            if (Object.keys(newLive).length > 0) {
                setLastSpotRefreshAt(new Date());
                // Phase 3 state guards: only push updates when data has materially changed,
                // preventing unnecessary re-renders during background polling.
                const pricesChanged    = !shallowNumberMapEqual(newLive, livePricesRef.current);
                const prevCloseChanged = !shallowNumberMapEqual(newPrevClose, livePrevCloseRef.current);
                const isFirst          = isFirstLiveFetch.current;

                if (pricesChanged) setLivePrices(newLive);
                // Replace (do not merge) livePrevClose on every successful fetch.
                // Merging (prev => {...prev, ...newPrevClose}) allows stale values
                // from restored JSON or old fetch cycles to survive indefinitely.
                // With replacement, any ticker that failed to produce a fresh previous
                // close in this cycle has its entry removed — correct per the spec.
                if (prevCloseChanged) setLivePrevClose(newPrevClose);
                // Commit liveDailyCloses whenever the series map materially changed. A
                // dedicated check (not the price flags) is required because the Stooq/Yahoo
                // backfill can land on a later poll when live prices are otherwise stable.
                // Signature compare: also catches a Stooq-filled date or a status change
                // (e.g. yahoo-only → verified) that leaves length/last close unchanged.
                const prevDaily = liveDailyClosesRef.current || {};
                const dailyClosesChanged = dailyClosesSignature(newDailyCloses) !== dailyClosesSignature(prevDaily);
                if (dailyClosesChanged || isFirst) setLiveDailyCloses(newDailyCloses);

                // Commit authoritative per-ticker quote session dates (from regularMarketTime).
                // Merged (not replaced) so tickers absent from this poll retain their prior date.
                if (Object.keys(newQuoteSessionDates).length > 0) {
                    setLiveQuoteSessionDates(prev => Object.assign({}, prev, newQuoteSessionDates));
                }

                // Stamp liveAt on first successful fetch even when values match a restored cache,
                // so isSameCalendarDay(liveAt) correctly unlocks the fresh-session bypass.
                if (pricesChanged || prevCloseChanged || isFirst) setLiveAt(new Date());
                if (isFirst) isFirstLiveFetch.current = false;

                // Always affirm ok status; never reset it on silent refresh.
                setLiveStatus('ok');
                recordFeed({ ok: true, fresh: gatedFresh == null ? Object.keys(newLive).length : gatedFresh,
                             requested: new Set(activeTickers.concat(['GBPUSD=X', '^GSPC', BENCH_TR_TICKER])).size });
            } else {
                // Failed fetch: never wipe existing data; only show failure on non-silent path.
                if (!silent) setLiveStatus('fail');
                recordFeed({ ok: false });
            }

            // ── Daily-close cross-check (Phase 2: fetch missing second-source data) ──
            // Background, not awaited: Alpha Vantage calls are spaced ≥13 s apart, so
            // six LSE holdings take over a minute on the first check of the day. When
            // it lands, re-merge with the latest raw Yahoo rows and commit. Until then
            // a holding whose previous session Yahoo is missing shows "—", never a
            // multi-day move. One run at a time; later polls reuse the cache.
            // A forced Re-check that arrives while a background check is still running
            // is queued and run as soon as that one finishes — never silently dropped.
            const runSecondary = (srcs) => {
                secondaryRefreshInFlightRef.current = true;
                if (srcs.length) setDailyCheckForcing(srcs);
                (async () => {
                    try {
                        const fetched = await fetchSecondaryDailyCloses(verifyTks, { allowFetch: dailyCheckAllowFetch(srcs), sessionDateFor, forceSources: srcs });
                        const updates = {}, statusUpdates = {};
                        for (const ntk of verifyTks) {
                            const yRows = yahooDailyRawRef.current[ntk] || [];
                            const sec   = fetched[ntk] || null;
                            const m     = mergeYahooWithSecondary(ntk, yRows, sec, newLive[ntk] ?? livePricesRef.current[ntk]);
                            if (m.rows.length === 0) continue;
                            updates[ntk] = m.rows;
                            statusUpdates[ntk] = {
                                provider: sec ? sec.provider : null, error: sec ? sec.error : null,
                                pending: !!(sec && sec.pending), altRows: sec ? sec.rows.length : 0,
                                unitFactor: m.factor, unitMismatch: m.unitMismatch,
                                sources: compactDailyCheckSources(sec),
                            };
                        }
                        // Functional update: merge onto whatever state is current at commit
                        // time, so a newer poll's rows for other tickers are never overwritten.
                        setLiveDailyCloses(prev => {
                            const next = Object.assign({}, prev, updates);
                            return dailyClosesSignature(next) === dailyClosesSignature(prev) ? prev : next;
                        });
                        setDailyCheckStatus(prev => {
                            const merged = Object.assign({}, prev, statusUpdates);
                            return dailyCheckSig(prev) === dailyCheckSig(merged) ? prev : merged;
                        });
                    } catch (e) {
                        console.warn('[daily-check] background refresh failed:', e && e.message);
                    } finally {
                        secondaryRefreshInFlightRef.current = false;
                        const queued = forceQueuedRef.current;
                        if (queued && queued.length) { forceQueuedRef.current = null; runSecondary(queued); }   // sets its own forcing state
                        else if (srcs.length) setDailyCheckForcing([]);
                    }
                })();
            };
            if (verifyTks.length > 0) {
                if (!secondaryRefreshInFlightRef.current) runSecondary(forceSources);
                else if (forceSources.length) {
                    forceQueuedRef.current = Array.from(new Set([...(forceQueuedRef.current || []), ...forceSources]));
                    setDailyCheckForcing(forceQueuedRef.current);
                }
            }
        }, [tickersUsed, compConfigs, externalHoldings, checkAssetOpenInLast3M, configCurrencyMap, recordFeed]);

        // Public entry point. Each run gets an id; only the newest run may commit, so a
        // slow request can never overwrite fresher prices. A silent 15-second poll is
        // skipped while a run is still in flight (network timeouts cap a run's length),
        // so polls cannot pile up; a user-initiated refresh always starts a new run.
        const fetchLivePrices = useCallback(async (opts = {}) => {
            if (opts && opts.silent && liveFetchInFlightRef.current) return;
            const runId = ++liveRunIdRef.current;
            liveFetchInFlightRef.current = true;
            try { await fetchLivePricesCore(opts, runId); }
            finally { if (runId === liveRunIdRef.current) liveFetchInFlightRef.current = false; }
        }, [fetchLivePricesCore]);

        // ── Orchestrator Hook: replaces manual fetch triggers ───────────────────

        const historyAttemptAtRef = React.useRef(0); // ms of the last automatic history refresh attempt

        React.useEffect(() => {
            if (transactions.length === 0) return;
            let liveInterval = null;
            const reconcileTimers = [];

            const executeDataPipeline = async () => {
                try {
                    // 1. History: refreshed once per London day, and whenever none is stored
                    //    or the storage format changed, or a held ticker has none. History holds completed sessions only
                    //    (today comes from the live quote), so daily is always enough. A failed
                    //    attempt, or just the tickers that failed in it, is retried on the next
                    //    pipeline run after 30 minutes.
                    const nowMs = Date.now();
                    const noHistory = Object.keys(pricesRef.current).length === 0;
                    // ...or when an open, listed holding has none stored (see tickersMissingHistory). The 30-minute
                    // attempt guard below still applies, so this can never turn into a fetch loop.
                    const newTickerNoHistory = tickersMissingHistory(allPriceTickers, pricesRef.current, checkAssetOpenInLast3M,
                        tk => isListedTicker(tk, configCurrencyMap)).length > 0;
                    const pendingTickers = historyRefreshPending(nowMs);
                    // The total-return benchmark arrives after a deploy that introduced it: fetch it rather than wait for tomorrow.
                    const benchMissing = (pricesRef.current[BENCH_TR_TICKER] || []).length < 2;
                    if (nowMs - historyAttemptAtRef.current > 30 * 60000) {
                        if (noHistory || newTickerNoHistory || benchMissing || historyRefreshDue(nowMs)) {
                            historyAttemptAtRef.current = nowMs;
                            await fetchAllPrices();
                        } else if (pendingTickers.length) {
                            historyAttemptAtRef.current = nowMs;
                            await fetchAllPrices(pendingTickers);
                        }
                    }

                    // 2. Immediate live/EOD quote pass — always runs so the latest close
                    //    is present even when the market is shut (Yahoo returns
                    //    meta.regularMarketPrice ?? meta.previousClose regardless of session).
                    fetchLivePrices();

                    // 3. Conditional polling: only set up the interval during active trading
                    if (isPageVisible && isMarketOpen && !isIdle) {
                        // MODE A: ACTIVE LIVE TRADING — 15-second polling (silent, no loading flash)
                        liveInterval = setInterval(() => {
                            fetchLivePrices({ silent: true });
                        }, 15000);
                    } else {
                        // MODE B: NO TRACKED MARKET OPEN, OR IDLE — the one-shot fetch above is
                        // sufficient. Schedule one reconciliation 30 minutes after each market
                        // close still ahead today (London 17:00, New York 16:30) to pick up the
                        // settled closing prints.
                        if (liveInterval) clearInterval(liveInterval);
                        try {
                            msUntilCloseReconciles(Date.now()).forEach(ms => {
                                reconcileTimers.push(setTimeout(() => fetchLivePrices(), ms));
                            });
                        } catch { /* timezone detection failed — skip delayed reconciliation */ }
                    }
                } catch (err) {
                    console.error('Pipeline synchronization error:', err);
                }
            };
            executeDataPipeline();
            return () => {
                if (liveInterval) clearInterval(liveInterval);
                reconcileTimers.forEach(t => clearTimeout(t));
            };
        }, [transactions.length, isPageVisible, isMarketOpen, isIdle, fetchAllPrices, fetchLivePrices]);
        // Upload an xlsx with one sheet per ticker (columns: date, close).
        // The README sheet is ignored. Date column accepts ISO strings or Excel serial dates.
        const handlePricesXlsx = useCallback(async (file) => {
            if (!file) return;
            setUploadError(null);
            try {
                const buf = await file.arrayBuffer();
                const wb = XLSX.read(buf, { type: 'array', cellDates: true });
                const newPrices = {};
                const newStatus = {};
                const newSource = {};
                const newDebug = {};
                // Helper: parse a raw cell value into a date string
                function parseDate(raw) {
                    if (raw == null) return null;
                    if (raw instanceof Date) return raw.toISOString().slice(0, 10);
                    if (typeof raw === 'string') {
                        if (raw.startsWith('=') || raw === 'Loading...') return 'loading';
                        return raw.slice(0, 10);
                    }
                    if (typeof raw === 'number') {
                        const epoch = new Date(Date.UTC(1899, 11, 30));
                        return new Date(epoch.getTime() + Math.floor(raw) * 86400000).toISOString().slice(0, 10);
                    }
                    return null;
                }
                // ── Format A: flat "prices" sheet (ticker | date | close | currency) ─────
                // This is the format produced by "Export prices XLSX" in this app.
                const hasFlatSheet = wb.SheetNames.some(s => s.toLowerCase() === 'prices');
                if (hasFlatSheet) {
                    const rows = XLSX.utils.sheet_to_json(
                        wb.Sheets[wb.SheetNames.find(s => s.toLowerCase() === 'prices')],
                        { raw: true, defval: null }
                    );
                    const grouped = {};
                    for (const r of rows) {
                        const ticker = (r.ticker || r.Ticker || '').toString().trim();
                        if (!ticker) continue;
                        // Prefer the hidden date_iso text backup (col E) if present,
                        // as it is unambiguous. Fall back to the Excel date serial (col B).
                        const rawDate = r.date_iso || r.date || r.Date;
                        const dateStr = parseDate(rawDate);
                        if (!dateStr || dateStr === 'loading') continue;
                        // Validate date is plausible (2000-01-01 to 2100-01-01)
                        if (dateStr < '2000-01-01' || dateStr > '2100-01-01') continue;
                        const close = typeof r.close === 'number' ? r.close
                            : typeof r.Close === 'number' ? r.Close
                            : parseFloat(r.close ?? r.Close ?? '');
                        if (!isFinite(close) || close <= 0) continue;
                        if (!grouped[ticker]) grouped[ticker] = new Map();
                        grouped[ticker].set(dateStr, close); // Map deduplicates by date
                    }
                    for (const [ticker, dateMap] of Object.entries(grouped)) {
                        const series = [...dateMap.entries()]
                            .sort((a, b) => a[0].localeCompare(b[0]))
                            .map(([date, close]) => ({ date, close }));
                        if (series.length === 0) continue;
                        newPrices[ticker] = series;
                        newStatus[ticker] = 'ok';
                        newSource[ticker] = 'xlsx';
                        newDebug[ticker] = [{ src: 'xlsx', result: 'ok', msg: `${series.length} pts (${series[0].date} → ${series[series.length-1].date})` }];
                    }
                } else {
                    // ── Format B: one sheet per ticker (legacy / Google Sheets format) ────
                    for (const sheetName of wb.SheetNames) {
                        if (['readme', 'cover', 'setup', 'meta'].includes(sheetName.toLowerCase())) continue;
                        const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { raw: true, defval: null });
                        if (!rows.length) continue;
                        const sample = rows[0];
                        const dateKey = Object.keys(sample).find(k => /^date$/i.test(k));
                        const closeKey = Object.keys(sample).find(k => /^(close|price)$/i.test(k));
                        if (!dateKey || !closeKey) {
                            newStatus[sheetName] = 'fail';
                            newDebug[sheetName] = [{ src: 'xlsx', result: 'fail', msg: `missing date/close columns (got: ${Object.keys(sample).join(', ')})` }];
                            continue;
                        }
                        const series = [];
                        let loadingCells = 0;
                        for (const r of rows) {
                            const dateStr = parseDate(r[dateKey]);
                            if (!dateStr) continue;
                            if (dateStr === 'loading') { loadingCells++; continue; }
                            const close = typeof r[closeKey] === 'number' ? r[closeKey] : parseFloat(r[closeKey]);
                            if (!isNaN(close) && close > 0) series.push({ date: dateStr, close });
                        }
                        series.sort((a, b) => a.date.localeCompare(b.date));
                        if (series.length === 0) {
                            const msg = loadingCells > 0
                                ? 'still loading — re-open the Google Sheet, wait for all cells to show numbers, then re-export'
                                : 'no valid rows after parsing';
                            newStatus[sheetName] = 'fail';
                            newDebug[sheetName] = [{ src: 'xlsx', result: 'fail', msg }];
                            continue;
                        }
                        newPrices[sheetName] = series;
                        newStatus[sheetName] = 'ok';
                        newSource[sheetName] = 'xlsx';
                        newDebug[sheetName] = [{ src: 'xlsx', result: 'ok', msg: `${series.length} pts (${series[0].date} → ${series[series.length-1].date})` }];
                    }
                    if (Object.keys(newPrices).length === 0) {
                        const anyLoading = Object.values(newDebug).some(d => d[0]?.msg?.includes('still loading'));
                        setUploadError(anyLoading
                            ? 'Google Sheet exported before GOOGLEFINANCE finished loading. Re-open the sheet, wait ~30 seconds, then re-export.'
                            : 'No usable sheets found. Expected a "prices" sheet or sheets named after tickers with date/close columns.');
                        return;
                    }
                }
                if (Object.keys(newPrices).length === 0) {
                    setUploadError('No price data found in file.');
                    return;
                }
                setPrices(prev => Object.assign({}, prev, newPrices));
                if (newPrices['GBPUSD=X']) setFxGBPUSD(newPrices['GBPUSD=X']);
                setLoadStatus(prev => Object.assign({}, prev, newStatus));
                setLoadSource(prev => Object.assign({}, prev, newSource));
                setFetchDebug(prev => Object.assign({}, prev, newDebug));
            } catch (e) {
                setUploadError(`Failed to parse xlsx: ${e.message}`);
            }
        }, []);
        // ── Stage 1.1: Compensation config CSV parser & validator ──────────────
        const COMP_REQUIRED_KEYS = ['plan_id', 'restricted_category', 'status', 'yahoo_ticker', 'currency'];
        const COMP_VALID_STATUSES = new Set(['ACTIVE', 'DRAFT', 'VESTED_PENDING_CONFIRMATION', 'EXERCISED', 'CANCELLED']);
        const handleCompConfigCSV = useCallback(async (file) => {
            if (!file) return;
            setUploadError('');
            Papa.parse(file, {
                header: true,
                skipEmptyLines: true,
                complete: async (result) => {
                    try {
                        // ── Schema validation: mandatory header keys ───────────────
                        const headers = result.meta.fields || [];
                        const missingKeys = COMP_REQUIRED_KEYS.filter(k => !headers.includes(k));
                        if (missingKeys.length > 0) {
                            setUploadError(`Compensation config CSV is missing required column(s): ${missingKeys.join(', ')}. ` +
                                `Expected: ${COMP_REQUIRED_KEYS.join(', ')}.`);
                            return;
                        }
                        // ── Enum validation: status values ─────────────────────────
                        const invalidRows = result.data
                            .map((row, i) => ({ row, i }))
                            .filter(({ row }) => row.status && !COMP_VALID_STATUSES.has(row.status.trim().toUpperCase()));
                        if (invalidRows.length > 0) {
                            const sample = invalidRows.slice(0, 3).map(({ row, i }) => `row ${i + 2}: "${row.status}"`).join(', ');
                            setUploadError(`Invalid status value(s) in compensation config: ${sample}. ` +
                                `Permitted values: ${[...COMP_VALID_STATUSES].join(', ')}.`);
                            return;
                        }
                        // ── Normalise: numeric fields to float/int, status to uppercase ─
                        const NUMERIC_FIELDS = [
                            'grant_price', 'market_price', 'shares_granted', 'shares_vested',
                            'shares_exercised', 'shares_lapsed', 'exercise_price',
                            'option_count', 'allocation_amount', 'years_to_vest',
                            // OPTION / SAYE fields — must be numeric for toFixed() type gate in UI
                            'option_strike_price', 'monthly_contribution',
                            'total_contract_months', 'guaranteed_bonus',
                            // SIP / RSU additional fields
                            'current_units', 'total_target_units', 'estimated_vesting_tax_rate',
                            'auto_exercise_days', 'manual_spot_price', 'manual_fx_rate',
                        ];
                        const data = result.data.map(row => {
                            const normalised = Object.assign({}, row);
                            // Uppercase & trim status
                            if (normalised.status) normalised.status = normalised.status.trim().toUpperCase();
                            // Coerce numeric fields
                            for (const field of NUMERIC_FIELDS) {
                                if (normalised[field] !== undefined && normalised[field] !== null && normalised[field] !== '') {
                                    const parsed = parseFloat(normalised[field]);
                                    normalised[field] = isFinite(parsed) ? parsed : normalised[field];
                                }
                            }
                            return normalised;
                        });
                        // ── Sequential commit: IDB first, then synchronous state update ─
                        await idbSet('corporate_equity_config', data);
                        setCompConfigs(data);
                        setUploadError('');
                    } catch (e) {
                        setUploadError(`Failed to process compensation config: ${e.message}`);
                    }
                },
                error: (err) => {
                    setUploadError(`CSV parse error: ${err.message}`);
                },
            });
        }, []);
        // ── Stage 4.2: External custody holdings CSV parser ────────────────────
        // Schema: ticker, display_name, custody_platform, shares, spot_price, currency, sector
        // Optional: vest_date (DD/MM/YYYY or YYYY-MM-DD) + vest_price (per share, in `currency`) -> sterling cost at the
        // vest-date GBP/USD rate, giving a Total gain/loss; or cost_basis_gbp (total sterling cost) to state it directly.
        // Persistence: inline success path only — no autosave useEffect (data erasure risk).
        const CUSTODY_REQUIRED_KEYS = ['ticker', 'shares'];
        const CUSTODY_NUMERIC_FIELDS = ['shares', 'spot_price', 'vest_price', 'cost_basis_gbp'];
        const handleExternalCustodyCSV = useCallback(async (file) => {
            if (!file) return;
            setUploadError('');
            Papa.parse(file, {
                header: true,
                skipEmptyLines: true,
                complete: async (result) => {
                    try {
                        // ── Schema validation ──────────────────────────────────
                        const headers = result.meta.fields || [];
                        const missingKeys = CUSTODY_REQUIRED_KEYS.filter(k => !headers.includes(k));
                        if (missingKeys.length > 0) {
                            setUploadError(
                                `External custody CSV missing required column(s): ${missingKeys.join(', ')}. ` +
                                `Required: ${CUSTODY_REQUIRED_KEYS.join(', ')}.`
                            );
                            return;
                        }
                        // ── Normalise numeric fields ───────────────────────────
                        const parsedData = result.data.map(row => {
                            const normalised = Object.assign({}, row);
                            for (const field of CUSTODY_NUMERIC_FIELDS) {
                                if (normalised[field] !== undefined && normalised[field] !== '') {
                                    const v = parseFloat(normalised[field]);
                                    normalised[field] = isFinite(v) ? v : normalised[field];
                                }
                            }
                            // Uppercase currency for consistent pxToGBP routing
                            if (normalised.currency) {
                                normalised.currency = normalised.currency.trim().toUpperCase();
                            }
                            return normalised;
                        });
                        // ── Sequential commit: IDB → state (import path only) ──
                        await idbSet('external_custody_holdings', parsedData);
                        setExternalHoldings(parsedData);
                        setUploadError('');
                    } catch (e) {
                        setUploadError(`Failed to process external custody CSV: ${e.message}`);
                    }
                },
                error: (err) => {
                    setUploadError(`External custody CSV parse error: ${err.message}`);
                },
            });
        }, []);
        // Build weekly date series from inception to today
        const weeklyDates = useMemo(() => computeWeeklyDates({ inception, today }), [inception, today]);
        // GBP/USD: today's live quote (already gated) → latest stored close. No fixed
        // fallback rate: with neither, rate is null and USD lines are not valued
        // (surfaced in pricingWarnings) rather than priced at a made-up rate.
        const gbpusdInfo = useMemo(() => computeGbpusdInfo({ livePrices, prices }), [prices, livePrices]);
        const gbpusdRate = gbpusdInfo.rate;
        const gbpusdAt = makeGbpusdAt(prices, gbpusdRate);
        // Per-ticker quote session dates derived from the last entry in liveDailyCloses.
        // liveQuoteSessionDates is now a React.useState (above, populated from
        // meta.regularMarketTime in fetchLivePrices). No useMemo derivation needed.

        const { resolvedPricesMap, proxyMeta } = useMemo(() => computeResolvedPrices({
                prices,
                enriched,
                tickerCurrencyMap,
                gbpusdAt: makeGbpusdAt(prices, gbpusdRate),
                liveAt,
                livePrices,
                liveQuoteSessionDates,
                liveDailyCloses }), [prices, enriched, livePrices, liveAt, liveDailyCloses, liveQuoteSessionDates, tickerCurrencyMap, gbpusdRate]);
        // Build portfolio value timeline
        const portfolioTimeline = useMemo(() => computePortfolioTimeline({
                weeklyDates,
                resolvedPricesMap,
                perfLedger,
                gbpusdRate,
                tickerCurrencyMap }), [weeklyDates, resolvedPricesMap, perfLedger, gbpusdRate, tickerCurrencyMap]);
        // Which benchmarks have a price series available (sheet uploaded). SPX is canonical;
        // others appear in the chip selector only if their data is present.
        const availableBenchmarks = useMemo(() => {
            return BENCHMARKS.filter(b => {
                const series = resolvedPricesMap[b.id];
                if (!series || series.length === 0)
                    return false;
                if (b.fxTicker && !resolvedPricesMap[b.fxTicker])
                    return false;
                return true;
            });
        }, [resolvedPricesMap]);
        // Auto-prune selectedBenchmarks to only the ones with data; ensures we don't leak a stale
        // selection across data reloads. SPX is always kept selected as the canonical comparator.
        useEffect(() => {
            setSelectedBenchmarks(prev => {
                const availIds = new Set(availableBenchmarks.map(b => b.id));
                const next = prev.filter(id => availIds.has(id));
                if (!next.includes('^GSPC'))
                    next.unshift('^GSPC');
                // Avoid unnecessary state churn if the selection is already correct
                if (next.length === prev.length && next.every((x, i) => x === prev[i]))
                    return prev;
                return next;
            });
        }, [availableBenchmarks]);
        // Benchmark series in GBP, rebased. spxGBP kept as a named field for back-compat with the
        // rest of the pipeline (attribution, risk panel SPX comparison, stats card). Additional
        // benchmarks land in a benchGBP map keyed by benchmark id, used by the chart layer.
        const benchmarkTimeline = useMemo(() => computeBenchmarkTimeline({ portfolioTimeline, resolvedPricesMap }), [portfolioTimeline, resolvedPricesMap]);

        // ── Stage 1.3: Compensation overlay memos ─────────────────────────────────
        // Insert immediately after benchmarkTimeline, before performanceChart.
        // All three blocks are purely additive — they do not touch portfolioValue,
        // TWR, Sharpe, drawdown, or any core performance pipeline variable.

        // 1 of 3 — Build the restricted compensation timeline over the shared date spine
        const restrictedTimeline = useMemo(() => {
            if (compConfigs.length === 0 || weeklyDates.length === 0) return [];
            // ── Per-ticker live price injection for restricted timeline ─────────────────
            // Uses liveQuoteSessionDates (from liveDailyCloses last date) as injection date.
            // Skips tickers whose session date is stale — no global fallback.
            const _rtCandidate = getCurrentPnlSessionDateStr();
            const _rtGlobal    = getEffectivePnlSessionDateStr(liveAt, _rtCandidate);
            const patchedPrices = Object.assign({}, prices);
            for (const [ticker, px] of Object.entries(livePrices)) {
                if (px == null || !Number.isFinite(Number(px))) continue;
                const normTk    = ticker.toUpperCase().trim();
                const rLiveDate = getEffectiveDateForTicker(normTk, liveQuoteSessionDates, _rtCandidate, _rtGlobal);
                if (!rLiveDate) continue;   // skip — stale or no per-ticker metadata
                const existingKey = Object.keys(patchedPrices).find(
                    k => k.toUpperCase().trim() === normTk
                ) || normTk;
                patchedPrices[existingKey] = withLiveTail(patchedPrices[existingKey], normTk, rLiveDate, px, liveDailyCloses);
            }
            return buildRestrictedTimeline(compConfigs, weeklyDates, patchedPrices, tickerCurrencyMap, gbpusdRate);
        }, [compConfigs, weeklyDates, prices, livePrices, liveAt, liveDailyCloses, liveQuoteSessionDates, tickerCurrencyMap, gbpusdRate]);

        // 2 of 3 — Merge ledger timeline with compensation overlay.
        // Source: portfolioTimeline (pure ledger, always carries portfolioValue).
        // benchmarkTimeline requires SPX+FX data so would silently blank the comp
        // overlay for users without benchmark sheets — violates additive insulation.
        const consolidatedTimeline = useMemo(() => computeConsolidatedTimeline({ portfolioTimeline, restrictedTimeline }), [portfolioTimeline, restrictedTimeline]);

        // 3 of 3 — Snapshot of the current (latest) compensation state for UI surfaces
        const currentCompState = useMemo(() => {
            if (consolidatedTimeline.length === 0) {
                return {
                    currentLiquidComp:                 0,
                    currentRestrictedComp:             0,
                    currentRestrictedPerformanceBasis: 0,
                    currentRestrictedPerformancePnL:   null,
                    currentActiveAlerts:               [],
                    currentRestrictedPlans:            [],
                    currentModelledLiquidPlans:        [],
                };
            }
            const lastPoint        = consolidatedTimeline[consolidatedTimeline.length - 1] || {};
            const restrictedComp   = lastPoint.restrictedCompensationValue     ?? 0;
            const performanceBasis = lastPoint.restrictedPerformanceBasisValue ?? 0;
            const isBasisComplete  = lastPoint.restrictedPerformanceBasisValid ?? true;
            return {
                currentLiquidComp:                 lastPoint.liquidCompensationValue ?? 0,
                currentRestrictedComp:             restrictedComp,
                currentRestrictedPerformanceBasis: performanceBasis,
                // Hardened: incomplete basis forces PnL to null → MetricBlock renders "—"
                currentRestrictedPerformancePnL:   (isBasisComplete && performanceBasis > 0)
                    ? (restrictedComp - performanceBasis) : null,
                currentActiveAlerts:               lastPoint.activeAlerts || [],
                currentRestrictedPlans:            Object.values(lastPoint.planDetails || {}).filter(p => p.phase === 'RESTRICTED'),
                currentModelledLiquidPlans:        Object.values(lastPoint.planDetails || {}).filter(p => p.phase === 'MODELLED_LIQUID'),
            };
        }, [consolidatedTimeline]);

        // ── Stage 4.2: External custody current-value processor ───────────────
        // Display-only: strictly insulated from totalValue, P&L, TWR, chart baselines.
        // Prices sourced from resolvedPricesMap (live-injected) with spot_price fallback.
        const processedExternalHoldings = useMemo(() => computeProcessedExternalHoldings({
                externalHoldings,
                liveAt,
                liveStatus,
                tickerCurrencyMap,
                liveQuoteSessionDates,
                gbpusdRate,
                livePrices,
                resolvedPricesMap,
                liveDailyCloses }), [externalHoldings, resolvedPricesMap, gbpusdRate, tickerCurrencyMap, livePrices, liveDailyCloses, liveQuoteSessionDates, liveAt, liveStatus]);

        // Remember each custody ticker's latest LIVE price so the next launch has something (labelled) to show
        // before its first live fetch lands.
        React.useEffect(() => {
            try {
                const live = (processedExternalHoldings.processedHoldings || []).filter(p => p.priceSource === 'live' && p.priceRaw != null);
                if (live.length === 0) return;
                const store = loadCustodyLastPrices(); let changed = false;
                for (const p of live) {
                    const k = String(p.ticker).toUpperCase(), cur = store[k];
                    if (!cur || cur.px !== p.priceRaw || cur.asOf !== p.priceAsOf || cur.ccy !== p.currency) {
                        store[k] = { px: p.priceRaw, ccy: p.currency, asOf: p.priceAsOf, at: new Date().toISOString() }; changed = true;
                    }
                }
                if (changed) saveCustodyLastPrices(store);
            } catch (e) { /* remembered price is a convenience only */ }
        }, [processedExternalHoldings]);

        // ── External custody as ordinary holdings ────────────────────────────────
        // A position held in an external custody account (CPWM etc.) is a holding like any other: it sits in
        // that account's card, in All Holdings, in the insights and in Portfolio Value. It has no transaction
        // ledger, so two things are different and both are kept honest:
        //   • cost basis is unknown unless the CSV gives cost_basis_gbp. Until then its Total P&L shows "—" and it
        //     is left out of every P&L calculation (noCostBasis), rather than counted as pure profit;
        //   • the performance chart and TWR stay ledger-only (masterPortfolio.ledger), since they are built from
        //     transactions and this position has none.
        const custodyHoldings = useMemo(() => (processedExternalHoldings.processedHoldings || [])
            .filter(p => p.shares > 0)
            .map(p => {
                const cost = p.costBasisGBP;
                return {
                    ticker: p.ticker, name: p.displayName, sector: p.sector,
                    account: String(p.custodyPlatform && p.custodyPlatform !== '\u2014' ? p.custodyPlatform : 'EXTERNAL CUSTODY').trim().toUpperCase(),
                    units: p.shares, totalCost: cost || 0, totalProceeds: 0, trades: 0,
                    marketValue: p.valueGBP,
                    unrealisedPL: (cost && p.valueGBP != null) ? p.valueGBP - cost : null,
                    todayAbsChange: p.dayAbs, todayPctChange: p.dayPct, todaySessionDate: p.sessionDay,
                    currentPriceGBP: p.spotGBP, currentPriceCurrency: p.currency, currentPriceRaw: p.priceRaw,
                    quoteBadge: (p.priceSource === 'lastKnown' || p.priceSource === 'csv') ? '!' : null,
                    noCostBasis: !cost, isExternalCustody: true,
                    vestDate: p.vestDate, vestPrice: p.vestPrice, vestCurrency: p.currency, fxAtVest: p.fxAtVest, costNote: p.costNote,
                };
            }), [processedExternalHoldings]);

        // ── Gilt Ladder: market-priced rungs + the gilts left unpriced (see buildGiltLadderState) ──
        const giltLadderState = useMemo(
            () => buildGiltLadderState(enriched, today, giltMarket, Date.now()),
            [enriched, today, giltMarket]);
        // Maturity alerts for the banner above the hero (balances.js): gilts still held, Citi / HSBC vests and Sharesave.
        const maturityAlerts = useMemo(() => {
            if (!window.MaturityAlerts) return null;
            const gl = giltLadderState ? [...giltLadderState.rungs, ...giltLadderState.unpriced] : [];
            const gilts = gl.map(g => ({ ticker: g.ticker, name: g.name, nominal: g.nominal,
                maturity: GILT_LADDER_REGISTRY[g.ticker] ? toISODate(GILT_LADDER_REGISTRY[g.ticker].maturityDate) : null }));
            const last = restrictedTimeline.length ? restrictedTimeline[restrictedTimeline.length - 1] : null;
            const details = last ? last.planDetails : null;
            return windows => window.MaturityAlerts.investmentAlerts(gilts, compConfigs, details, window.MaturityAlerts.today(), windows);
        }, [giltLadderState, compConfigs, restrictedTimeline, today]);
        // The ONE benchmark series (S&P 500 total return in GBP): read by the chart, the cards, the attribution and the
        // "same deposits in the S&P" comparison. Falls back to the price index until the total-return history is stored.
        const spxGbpSeries = useMemo(() => {
            const _find = t => Object.keys(prices).find(k => k.toUpperCase().trim() === t);
            const _tr = _find(BENCH_TR_TICKER);
            const useTr = !!_tr && prices[_tr].length >= 2;
            const _k = useTr ? _tr : _find('^GSPC');
            const tk = useTr ? BENCH_TR_TICKER : '^GSPC';
            spxLabelNow = useTr ? 'SPXT' : 'SPX';
            const built = buildSpxGbpSeries({
                spxRaw: _k ? prices[_k] : [],
                fxRaw: resolvedPricesMap['GBPUSD=X'] || prices['GBPUSD=X'] || [],
                liveSpx: livePrices && livePrices[tk],
                liveSession: liveQuoteSessionDates && liveQuoteSessionDates[tk],
            });
            built.ticker = tk;
            return built;
        }, [prices, resolvedPricesMap, livePrices, liveQuoteSessionDates]);
        const performanceChart = useMemo(() => computePerformanceChart({
                benchmarkTimeline,
                spxGbpSeries,
                startDate,
                perfLedger,
                endDate,
                consolidatedTimeline }), [benchmarkTimeline, perfLedger, startDate, endDate, consolidatedTimeline, prices, livePrices, liveQuoteSessionDates, resolvedPricesMap, spxGbpSeries]);


        const stats = useMemo(() => {
            if (performanceChart.length < 2)
                return null;
            const last = performanceChart[performanceChart.length - 1];
            const first = performanceChart[0];
            const totalContributed = perfLedger
                .filter(t => (t.category === 'subscription' || t.category === 'transfer') && fmtDate(t.parsedDate) >= first.date)
                .reduce((s, t) => s + t.value, 0);
            // Cash drag = total portfolio TWR − invested-only TWR. Tells you how much idle cash cost you.
            // Negative drag means cash actually helped (rare — would require equity drawdown while cash held).
            const investedReturn = last.invested != null ? last.invested - 100 : null;
            const cashDrag = investedReturn != null ? (last.portfolio - 100) - investedReturn : null;
            // Current cash position (raw, in £)
            const currentCash = last.rawValue - last.investedRawValue;
            return {
                portfolioReturn: last.portfolio - 100,
                investedReturn,
                cashDrag,
                currentCash,
                currentInvested: last.investedRawValue,
                benchmarkReturn: last.benchmark != null ? last.benchmark - 100 : null,
                alpha: last.benchmark != null ? (last.portfolio - last.benchmark) : null,
                investedAlpha: investedReturn != null && last.benchmark != null ? investedReturn - (last.benchmark - 100) : null,
                currentValue: last.rawValue,
                totalContributed,
                gain: last.rawValue - (first.rawValue + totalContributed),
            };
        }, [performanceChart, perfLedger]);
        // Risk metrics over the active chart window.
        // Weekly returns are derived from the chart's rebased indices (which already account for cash flows
        // via Modified Dietz). Vol annualised by √52, return annualised by compounding to one year.
        // "Sharpe-ish" because we use a constant nominal cash rate rather than a true risk-free term curve,
        // and the input series is weekly TWR, not excess returns at each step. Good enough for relative comparison.
        const risk = useMemo(() => computeRisk({ performanceChart, cashRate }), [performanceChart, cashRate]);
        // Per-holding attribution vs SPX — Brinson-style decomposition with Carino linking.
        //
        // For each week step (t-1 → t):
        //   - For each ticker i: weight_i = position_value_{t-1} / total_invested_value_{t-1}
        //                        return_i = price_t / price_{t-1} − 1
        //                        contribution_i = weight_i × return_i
        //   - Portfolio invested return that week r_p = sum(contribution_i)
        //
        // To chain across weeks so contributions sum to multi-period return, we use Carino linking:
        //   adjusted_contribution_i_t = k_t × contribution_i_t
        //   where k_t = ln(1+r_p_t) / r_p_t × (R / ln(1+R))    for R = product(1+r_p_t) - 1
        //   (and k_t = R / r_p_t when r_p_t ≈ 0, with l'Hôpital)
        //
        // Sum over all weeks and all tickers of adjusted_contribution = R (the invested-only portfolio TWR).
        //
        // For the SPX counterfactual, same formula but each ticker's weekly return is replaced by SPX's
        // weekly return (in GBP). Sum of SPX counterfactual contributions = SPX TWR × sum(weight_i),
        // which roughly equals SPX TWR since weights sum to 1 each week.
        //
        // Alpha = portfolio contribution − SPX counterfactual.
        const attribution = useMemo(() => computeAttribution({
                performanceChart,
                perfLedger,
                resolvedPricesMap,
                gbpusdAt: makeGbpusdAt(prices, gbpusdRate),
                tickerCurrencyMap,
                tickerNameMap }), [performanceChart, benchmarkTimeline, perfLedger, resolvedPricesMap, prices, gbpusdRate, tickerCurrencyMap, tickerNameMap]);
        // Pressed-day contributors for the performance chart bubble (display-only: reads the plotted series, changes nothing).
        const perfContribSteps = useMemo(() => {
            try { return buildContribSteps(performanceChart, benchmarkTimeline, perfLedger); }
            catch (e) { return null; }
        }, [performanceChart, benchmarkTimeline, perfLedger]);
        const contribForRange = useMemo(() => makeContribRange(perfContribSteps, 5), [perfContribSteps]);
        // Console check (like __debugChartIntegrity): window.__debugContribIntegrity() -> how well the rows reconcile.
        window.__debugContribIntegrity = function () {
            if (!perfContribSteps || !contribForRange) return null;
            const pc = performanceChart, last = pc.length - 1;
            const res = contribForRange(pc[0].date, pc[last].date);
            if (!res) return null;
            const plotted = pc[last].investedAll / pc[0].investedAll - 1;
            const sum = res.rows.reduce((t, r) => t + r.c, 0) + res.other;
            let bigOther = 0;
            for (let i = 1; i <= last; i++) if (Math.abs(perfContribSteps.steps[i].o) > 0.002) bigOther++;
            return { windowReturn: res.total, plottedReturn: plotted, rowsPlusOther: sum, errorPP: (sum - plotted) * 100,
                     other: res.other, stepsWithOtherOver20bp: bigOther, rows: res.rows.map(r => r.tk) };
        };
        // Current holdings — respects endDate so historical snapshots work correctly
        const holdingsDate = endDate || fmtDate(today); // price/unit cutoff
        const holdings = useMemo(() => computeHoldings({
                enriched,
                holdingsDate,
                resolvedPricesMap,
                endDate,
                gbpusdRate,
                tickerCurrencyMap }), [enriched, resolvedPricesMap, holdingsDate, gbpusdRate, endDate, tickerCurrencyMap]); // prices omitted: resolvedPricesMap already incorporates it
        const activeHoldings = holdings.filter(h => Math.abs(h.units) > 0.001);
        // Pricing conditions the user should know about, shown in Settings → Daily
        // close check and written to the diagnostics export.
        const pricingWarnings = useMemo(() => computePricingWarnings({
                gbpusdInfo,
                activeHoldings,
                tickerCurrencyMap,
                enriched,
                externalHoldings }), [gbpusdInfo, activeHoldings, tickerCurrencyMap, enriched, externalHoldings]);

        // ── Today's delta per holding ─────────────────────────────────────────
        // todayAbsChange = units × (currentGBP − prevCloseGBP)
        // prevClose comes from resolveVerifiedDailyPrevClose on liveDailyCloses;
        // currentGBP from livePrices, which only holds quotes that passed the live gate.
        const ledgerHoldingsWithDelta = useMemo(() => computeLedgerHoldingsWithDelta({
                giltLadderState,
                liveAt,
                liveStatus,
                livePrices,
                activeHoldings,
                prices,
                gbpusdRate,
                tickerCurrencyMap,
                liveQuoteChecks,
                liveQuoteSessionDates,
                liveDailyCloses }), [activeHoldings, livePrices, liveDailyCloses, liveQuoteChecks, gbpusdRate, tickerCurrencyMap, prices, liveStatus, liveAt, liveQuoteSessionDates, giltLadderState]);

        // The latest trading session any holding (ledger or custody) has reached. A holding on an earlier session has its
        // Today held back (withLatestSessionToday) so figures from different sessions are never blended. See latestTodaySession.
        const latestSession = useMemo(
            () => latestTodaySession(ledgerHoldingsWithDelta.concat(custodyHoldings)),
            [ledgerHoldingsWithDelta, custodyHoldings]);

        // The excluded sleeve (gilts, cash-like and bond funds) as the hero values it: taken out of the chart's last point and 1D view
        // so they agree with the performance engines, which leave these out.
        // Its Today goes through the same latest-session rule as the hero, or the chart would subtract a move the hero never counted.
        const excludedSleeve = useMemo(() => {
            const tks = new Set((perfLedger.__excluded && perfLedger.__excluded.tickers) || []);
            let value = 0, abs = 0; const held = [];
            for (const h0 of ledgerHoldingsWithDelta || []) {
                if (!tks.has(h0.ticker)) continue;
                const h = withLatestSessionToday(h0, latestSession);
                const mv = Number(h.marketValue);
                if (Number.isFinite(mv) && mv > 0) { value += mv; held.push(h.ticker); }
                const d = Number(h.todayAbsChange);
                if (Number.isFinite(d)) abs += d;
            }
            return { value, abs, tickers: held };
        }, [ledgerHoldingsWithDelta, perfLedger, latestSession]);



        // Ledger holdings plus external-custody holdings: ONE list, so every account card, the All Holdings sheet,
        // the insights and the Markets holdings see a custody position like any other.
        // Every holding's Today passes through withLatestSessionToday here, the single choke point: a holding whose market has
        // not yet reached the latest session (Citi on a London morning) shows "—", so the hero total, account cards, All Holdings
        // rows and Insights all agree and none blends a previous session's move with today's.
        const activeHoldingsWithDelta = useMemo(() => {
            let merged = ledgerHoldingsWithDelta;
            if (custodyHoldings.length) {
                // A custody row whose ticker + account is already held through the ledger is skipped: counting both
                // would double the position. (pricingWarnings tells the user to remove the custody row.)
                const inLedger = new Set(ledgerHoldingsWithDelta.map(h => String(h.ticker || '').toUpperCase() + '||' + String(h.account || '').toUpperCase()));
                const extra = custodyHoldings.filter(c => !inLedger.has(String(c.ticker || '').toUpperCase() + '||' + String(c.account || '').toUpperCase()));
                if (extra.length) merged = ledgerHoldingsWithDelta.concat(extra);
            }
            return merged.map(h => withLatestSessionToday(h, latestSession));
        }, [ledgerHoldingsWithDelta, custodyHoldings, latestSession]);

        // ── Per-account cash flows (subscriptions + fees flow into account) ──
        const accountCashMap = useMemo(() => {
            const map = {};
            const sorted = [...enriched].sort((a, b) => a.parsedDate - b.parsedDate);
            for (const t of sorted) {
                if (fmtDate(t.parsedDate) > holdingsDate) break;
                const acct = (t.account || 'UNASSIGNED ACCOUNT').trim().toUpperCase();
                if (!map[acct]) map[acct] = 0;
                if (t.category === 'subscription' || t.category === 'transfer') map[acct] += t.value;
                else if (t.category === 'fee' || t.category === 'interest') map[acct] += t.value;
                else if (t.category === 'buy') map[acct] += t.value; // negative
                else if (t.category === 'sell') map[acct] += t.value; // positive
                // transfer_out: no cash impact
            }
            return map;
        }, [enriched, holdingsDate]);

        // ── Account groups ────────────────────────────────────────────────────
        // Groups active holdings by account. Computes per-account totals for the
        // Hero allocation bar and Account Stack cards.
        //
        // FIX (Bug report §1): account names are now normalised in parseCSV
        // (.trim().toUpperCase()) so all fragments of the same wrapper collapse
        // into a single key here. No secondary normalisation needed.
        //
        // FIX (Bug report §2): Math.max(0, cash) clamp removed. Allowing cash
        // to run negative lets the invested asset and its corresponding cash
        // obligation net against each other BEFORE rolling up to masterPortfolio.
        // Clamping hid the debit side, causing the master total to double-count
        // every position that crossed an account-name boundary.
        //
        // FIX (Bug report §3): cash-only accounts (subscription rows with no
        // active holdings) are now surfaced explicitly rather than orphaned.
        const accountGroups = useMemo(() => computeAccountGroups({ activeHoldingsWithDelta, accountCashMap }), [activeHoldingsWithDelta, accountCashMap]);

        // ── Master portfolio aggregates ───────────────────────────────────────
        const masterPortfolio = useMemo(() => {
            const totalValue = accountGroups.reduce((s, a) => s + a.totalValue, 0);
            const totalInvested = accountGroups.reduce((s, a) => s + a.investedValue, 0);
            // Today: summed over holdings that have one. A holding behind the latest session already has its Today nulled
            // upstream (withLatestSessionToday), so it adds nothing here. The custody split is taken from the same set,
            // so the ledger-only figures below stay consistent with the total.
            let todayAbsChange = 0, todayKnown = 0, custodyTodayAbs = 0, custodyTodayKnown = 0;
            for (const h of activeHoldingsWithDelta) {
                if (h.todayAbsChange == null) continue;
                todayAbsChange += h.todayAbsChange;
                todayKnown += 1;
                if (h.isExternalCustody) { custodyTodayAbs += h.todayAbsChange; custodyTodayKnown += 1; }
            }
            const hasTodayData = todayKnown > 0;
            const netCost = accountGroups.reduce((s, a) => s + a.netCost, 0);
            const noBasis = accountGroups.reduce((s, a) => s + (a.noBasisValue || 0), 0);
            const unrealisedPL = (totalInvested - noBasis) - netCost;
            const totalPctChange = netCost > 0 ? unrealisedPL / netCost : null;
            const prevDayTotal = totalValue - todayAbsChange;
            const todayPctChange = hasTodayData && prevDayTotal > 0 ? todayAbsChange / prevDayTotal : null;
            // The same figures for the LEDGER alone (custody holdings taken out). The performance chart and TWR are
            // built from transactions, so they are reconciled against these, never against the totals above.
            const custodyValue    = accountGroups.reduce((s, a) => s + (a.custodyValue || 0), 0);
            const custodyToday    = custodyTodayAbs;
            const ledgerTodayKnown = todayKnown - custodyTodayKnown;
            const ledgerTotal     = totalValue - custodyValue;
            const ledgerTodayAbs  = ledgerTodayKnown > 0 ? todayAbsChange - custodyToday : null;
            const ledgerPrev      = ledgerTotal - (ledgerTodayAbs || 0);
            const ledger = { totalValue: ledgerTotal, todayAbsChange: ledgerTodayAbs,
                             todayPctChange: (ledgerTodayAbs != null && ledgerPrev > 0) ? ledgerTodayAbs / ledgerPrev : null };
            return { totalValue, totalInvested, todayAbsChange: hasTodayData ? todayAbsChange : null, todayPctChange, unrealisedPL, totalPctChange, netCost, ledger, custodyValue };
        }, [accountGroups, activeHoldingsWithDelta]);

        // ── Track B Parity Sentinel (Spec §IV 2.5 item 2) ──────────────────────────
        // Validates that masterPortfolio.totalValue === Σ accountGroups.totalValue.
        // A delta > £0.01 indicates a rounding/grouping bug in the accounting engine.
        // The flag is surfaced ONLY inside MoreTab's System Diagnostics — never on the dashboard.
        const parityDelta = React.useMemo(() => {
            const rollup = accountGroups.reduce((sum, a) => sum + a.totalValue, 0);
            return Math.abs(masterPortfolio.totalValue - rollup);
        }, [masterPortfolio.totalValue, accountGroups]);
        const hasParityMismatch = parityDelta > 0.01;

        // ── Restricted positions: HSBC (R) / Citi (R) ─────────────────────────────
        // One row per share the restricted schemes are on, with today's move. Feeds the hero's Today and Daily Insights.
        const restrictedPositions = React.useMemo(() => computeRestrictedPositions({
            currentCompState, livePrices, tickerCurrencyMap, gbpusdRate,
            liveAt, liveDailyCloses, liveQuoteSessionDates, latestSession,
        }), [currentCompState, livePrices, tickerCurrencyMap, gbpusdRate, liveAt, liveDailyCloses, liveQuoteSessionDates, latestSession]);

        // ── Phase 3: Insights data ───────────────────────────────────────────────
        // Spec §IV Phase 3: Core Weight Concentration, ΔP×U Cash Contributors, Velocity Margins.
        // All three derived entirely from already-computed activeHoldingsWithDelta + masterPortfolio.
        const insightsData = React.useMemo(() => computeInsightsData({
                activeHoldingsWithDelta,
                masterPortfolio,
                restrictedPositions,
                resolvedPricesMap,
                gbpusdAt: makeGbpusdAt(prices, gbpusdRate),
                tickerCurrencyMap }), [activeHoldingsWithDelta, masterPortfolio, resolvedPricesMap, tickerCurrencyMap, restrictedPositions, prices, gbpusdRate]);

        // ── Per-ticker drill-down detail ─────────────────────────────────────────
        // Builds full trade history + a price line with buy/sell markers for the selected ticker.
        // Respects holdingsDate (endDate) so historical snapshots match the rest of the app.
        const tickerDetail = useMemo(() => computeTickerDetail({
                selectedTicker,
                enriched,
                holdingsDate,
                resolvedPricesMap,
                endDate,
                gbpusdRate,
                tickerCurrencyMap }), [selectedTicker, enriched, resolvedPricesMap, holdingsDate, endDate, gbpusdRate, tickerCurrencyMap]); // prices omitted: resolvedPricesMap already incorporates it
        // ── Concentration (HHI) ─────────────────────────────────────────────────
        // Herfindahl-Hirschman Index on current market values of active holdings.
        // HHI = Σ(weight_i²) × 10000. Ranges: <1500 diversified, 1500–2500 moderate, >2500 concentrated.
        // We also compute effective N = 1/HHI_normalised (inverse Simpson) for a plain-English label.
        const concentration = useMemo(() => {
            const valued = activeHoldings.filter(h => h.marketValue != null && h.marketValue > 0);
            if (valued.length === 0)
                return null;
            const total = valued.reduce((s, h) => s + h.marketValue, 0);
            if (total <= 0)
                return null;
            const weights = valued.map(h => h.marketValue / total);
            const hhi = weights.reduce((s, w) => s + w * w, 0) * 10000;
            const effectiveN = 1 / weights.reduce((s, w) => s + w * w, 0);
            const shares = valued
                .map(h => ({ ticker: h.ticker || h.name, weight: h.marketValue / total, value: h.marketValue }))
                .sort((a, b) => b.weight - a.weight);
            return { hhi, effectiveN, shares, total };
        }, [activeHoldings]);
        // ── Sector breakdown ─────────────────────────────────────────────────────
        // Aggregate active holdings by sector tag (read from the CSV "Sector" column).
        // Holdings without a recognised ticker fall into 'Other'.
        const sectorBreakdown = useMemo(() => {
            var _a;
            const valued = activeHoldings.filter(h => h.marketValue != null && h.marketValue > 0);
            if (valued.length === 0)
                return null;
            const total = valued.reduce((s, h) => s + h.marketValue, 0);
            if (total <= 0)
                return null;
            const bySecMap = {};
            for (const h of valued) {
                // h.sector is populated directly from the CSV "Sector" column via parseCSV →
                // enriched → instrument — no TICKER_MAP lookup required.
                const sector = h.sector || 'Other';
                bySecMap[sector] = (bySecMap[sector] || 0) + h.marketValue;
            }
            const sectors = Object.entries(bySecMap)
                .map(([sector, value]) => ({ sector, value, weight: value / total }))
                .sort((a, b) => b.weight - a.weight);
            return { sectors, total };
        }, [activeHoldings]);
        // ── Rolling returns (1M / 3M / 6M / 1Y trailing TWR from performanceChart) ──
        const rollingReturns = useMemo(() => {
            if (performanceChart.length < 2)
                return null;
            const last = performanceChart[performanceChart.length - 1];
            const lastDate = new Date(last.date);
            const now = new Date(last.date);
            const ytdStart = fmtDate(new Date(Date.UTC(now.getUTCFullYear(), 0, 1)));
            // Same rule as the YTD chart: from the last row on/before 31 Dec of the previous year (else the first row of the year).
            const ytdPrevEnd = (now.getUTCFullYear() - 1) + '-12-31';
            let ytdAnchor = null;
            for (let i = 0; i < performanceChart.length; i++) { if (performanceChart[i].date <= ytdPrevEnd) ytdAnchor = performanceChart[i]; else break; }
            if (!ytdAnchor) ytdAnchor = performanceChart.find(p => p.date >= ytdStart);
            const ytdRet = ytdAnchor && ytdAnchor.date !== last.date && ytdAnchor.portfolio > 0
                ? (last.portfolio / ytdAnchor.portfolio - 1) * 100 : null;
            const ytdBench = ytdAnchor && ytdAnchor.benchmark != null && last.benchmark != null && ytdAnchor.benchmark > 0
                ? (last.benchmark / ytdAnchor.benchmark - 1) * 100 : null;
            const windows = [
                { label: '1M', days: 30 },
                { label: 'YTD', days: null },
                { label: '1Y', days: 365 },
            ];
            return windows.map(({ label, days }) => {
                if (label === 'YTD') return { label, portRet: ytdRet, benchRet: ytdBench };
                const cutoff = new Date(lastDate.getTime() - days * 86400 * 1000);
                const cutoffStr = fmtDate(cutoff);
                const anchor = performanceChart.find(p => p.date >= cutoffStr);
                if (!anchor || anchor.date === last.date)
                    return { label, portRet: null, benchRet: null };
                const portRet = anchor.portfolio > 0 ? (last.portfolio / anchor.portfolio - 1) * 100 : null;
                const benchRet = (anchor.benchmark != null && last.benchmark != null && anchor.benchmark > 0)
                    ? (last.benchmark / anchor.benchmark - 1) * 100 : null;
                return { label, portRet, benchRet };
            });
        }, [performanceChart]);
        // ── ISA year breakdown ───────────────────────────────────────────────────
        // UK tax year: 6 April → 5 April. Annual ISA allowance £20,000.
        // Subscriptions count against the allowance; transfers between ISAs do not.
        const isaYears = useMemo(() => computeIsaYears({ enriched }), [enriched]);
        // ── Export cached prices as XLSX ─────────────────────────────────────────
        // iOS Safari does not support the `download` attribute on anchor tags or
        // the File System Access API — XLSX.writeFile silently fails.
        // The correct iOS approach: generate a Blob, open it with window.open(),
        // which triggers Safari's share sheet where the user taps "Save to Files"
        // and picks their location (iCloud Drive, On My iPhone, etc.).
        // ── SHA-256 fingerprint (browser-native, async) ──────────────────────────
        // Deterministic key-sorted serialisation — prevents cross-platform SHA-256
        // divergence caused by JS engine differences in object key enumeration order.
        // Used for all payload hashing so a file exported on iOS and verified on
        // desktop produces an identical byte string before digesting.
        function sortObjectKeys(obj) {
            if (typeof obj !== 'object' || obj === null) return obj;
            if (Array.isArray(obj)) return obj.map(sortObjectKeys);
            return Object.keys(obj).sort().reduce(function(acc, key) {
                acc[key] = sortObjectKeys(obj[key]);
                return acc;
            }, {});
        }
        const sha256Hex = function(str) {
            var encoded = new TextEncoder().encode(str);
            return crypto.subtle.digest('SHA-256', encoded).then(function(hashBuf) {
                return Array.from(new Uint8Array(hashBuf)).map(function(b) { return b.toString(16).padStart(2, '0'); }).join('');
            });
        };
        // ── iOS detection ─────────────────────────────────────────────────────────
        const isIOSLike = function() {
            return /iPad|iPhone|iPod/.test(navigator.userAgent)
                || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
        };
        // ── iPhone-first JSON delivery ────────────────────────────────────────────
        // Delivery order:
        //   1. Web Share with application/json  (iOS native save sheet)
        //   2. Web Share with text/plain        (wider iOS share sheet compatibility)
        //   3. In-app export modal              (full JSON textarea + copy button)
        //   4. Anchor download                  (desktop fallback only)
        // Never silently fails; always shows the outcome via setUploadFeedback or modal.
        const deliverJsonBackup = function(jsonString, filename) {
            var tryAnchor = function() {
                var blob = new Blob([jsonString], { type: 'application/json;charset=utf-8' });
                var url  = URL.createObjectURL(blob);
                var a    = document.createElement('a');
                a.href = url; a.download = filename; a.rel = 'noopener';
                document.body.appendChild(a); a.click(); document.body.removeChild(a);
                setTimeout(function() { URL.revokeObjectURL(url); }, 15000);
                setUploadFeedback({
                    added: 0, duplicates: 0, intraFileDupes: 0, existingDupes: 0,
                    files: 1, extendedOldest: false, extendedNewest: false, ts: Date.now(),
                    _exportMsg: 'Backup downloaded: ' + filename,
                });
            };
            var openModal = function() {
                setExportModal({ json: jsonString, filename: filename });
                setUploadFeedback({
                    added: 0, duplicates: 0, intraFileDupes: 0, existingDupes: 0,
                    files: 1, extendedOldest: false, extendedNewest: false, ts: Date.now(),
                    _exportMsg: 'Manual export required — copy JSON from the panel below',
                });
            };
            var tryShare = function(fileType) {
                var shareFile = new File([jsonString], filename, { type: fileType });
                if (!navigator.share || !navigator.canShare || !navigator.canShare({ files: [shareFile] }))
                    return Promise.reject(new Error('share_unavailable'));
                // Files only: no title/text/url. On iOS a title is handed to the share sheet as its own text item,
                // and "Save to Files" then writes it out as a second, useless .txt file next to the backup.
                return navigator.share({ files: [shareFile] })
                    .then(function() {
                        setUploadFeedback({
                            added: 0, duplicates: 0, intraFileDupes: 0, existingDupes: 0,
                            files: 1, extendedOldest: false, extendedNewest: false, ts: Date.now(),
                            _exportMsg: 'Backup shared: ' + filename,
                        });
                    });
            };
            return tryShare('application/json')
                .catch(function(err) {
                    if (err.name === 'AbortError') return;   // user cancelled — do nothing
                    return tryShare('text/plain');
                })
                .catch(function(err) {
                    if (err && err.name === 'AbortError') return;
                    if (isIOSLike()) {
                        openModal();
                    } else {
                        tryAnchor();
                    }
                });
        };
        // ── Shared delivery: Web Share API (iOS native sheet) + anchor fallback ──
        const deliverFile = function(buffer, filename, mimeType) {
            var file = new File([buffer], filename, { type: mimeType });
            if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
                return navigator.share({ files: [file], title: filename }).catch(function(err) {
                    if (err.name === 'AbortError') return;
                    console.warn('Web Share failed, falling back:', err);
                    deliverViaAnchor(buffer, filename, mimeType);
                });
            }
            deliverViaAnchor(buffer, filename, mimeType);
            return Promise.resolve();
        };
        const deliverViaAnchor = function(buffer, filename, mimeType) {
            var blob = new Blob([buffer], { type: mimeType });
            var url = URL.createObjectURL(blob);
            var a = document.createElement('a');
            a.href = url;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            setTimeout(function() { URL.revokeObjectURL(url); }, 5000);
        };
        const exportPricesXlsx = useCallback(function() {
            // ── 1. Validate ───────────────────────────────────────────────────────
            if (typeof XLSX === 'undefined') {
                setUploadError('XLSX library not loaded — try reloading the page.');
                return;
            }
            var rawTickers = Object.keys(prices);
            var tickers = rawTickers.filter(function(t) {
                var s = prices[t];
                return Array.isArray(s) && s.length > 0;
            });
            if (tickers.length === 0) {
                setUploadError('No price data to export — fetch prices first.');
                return;
            }
            // ── 2. Sort tickers: equities A-Z, then indices (^), then FX (=) ─────
            var sortedTickers = tickers.slice().sort(function(a, b) {
                var rank = function(t) { return t.includes('=') ? 2 : t.startsWith('^') ? 1 : 0; };
                return rank(a) !== rank(b) ? rank(a) - rank(b) : a.localeCompare(b);
            });
            // ── 3. Build rows: deduplication, validation, per-point provenance ────
            // Source label is determined opportunistically per point:
            //   today + ticker in livePrices  => 'live-quote'
            //   ticker loadSource 'tx-derived' => 'tx-derived'
            //   otherwise                      => loadSource[ticker] || 'historical'
            // Archival data is never mislabelled as a live API source.
            var todayStr = getEffectivePnlSessionDateStr(liveAt, getCurrentPnlSessionDateStr())
                || getCurrentPnlSessionDateStr();
            var dataRows = [];
            var skippedCount = 0;
            for (var ti = 0; ti < sortedTickers.length; ti++) {
                var ticker = sortedTickers[ti];
                var ccy = resolveQuoteCurrency(ticker, tickerCurrencyMap) || 'GBX';
                var tickerSrc = loadSource[ticker] || 'historical';
                var isTxDerived = tickerSrc === 'tx-derived';
                var byDate = new Map();
                var series = prices[ticker];
                for (var pi = 0; pi < series.length; pi++) {
                    var p = series[pi];
                    if (p == null || typeof p !== 'object') { skippedCount++; continue; }
                    if (typeof p.date !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(p.date)) { skippedCount++; continue; }
                    var close = Number(p.close);
                    if (!isFinite(close) || close === 0) { skippedCount++; continue; }
                    var dateKey = p.date.slice(0, 10);
                    // A point tagged with its own source (e.g. a single-day gap filled
                    // from Alpha Vantage / Twelve Data) keeps that label; it is real
                    // provenance, not the ticker's general history source.
                    var pointSrc = p.source ? p.source
                                 : (dateKey === todayStr && livePrices[(ticker||'').toUpperCase().trim()] != null) ? 'live-quote'
                                 : isTxDerived ? 'tx-derived'
                                 : tickerSrc;
                    byDate.set(dateKey, { close: close, source: pointSrc });
                }
                if (byDate.size === 0) continue;
                var sorted = Array.from(byDate.entries()).sort(function(a, b) { return a[0] < b[0] ? -1 : 1; });
                for (var si = 0; si < sorted.length; si++) {
                    dataRows.push([ticker, sorted[si][0], sorted[si][1].close, ccy, sorted[si][1].source]);
                }
            }
            if (dataRows.length === 0) {
                setUploadError('No valid price points found after validation — nothing exported.');
                return;
            }
            // ── 4. Build prices worksheet (ticker | date | close | currency | source)
            var ws = XLSX.utils.aoa_to_sheet([['ticker', 'date', 'close', 'currency', 'source']].concat(dataRows));
            ws['!cols'] = [{ wch: 14 }, { wch: 12 }, { wch: 12 }, { wch: 8 }, { wch: 14 }];
            ws['!views'] = [{ state: 'frozen', xSplit: 0, ySplit: 1 }];
            // ── 5. Build live_quotes worksheet ────────────────────────────────────
            var liveEntries = Object.entries(livePrices).filter(function(e) {
                var px = Number(e[1]); return isFinite(px) && px !== 0;
            });
            var liveRows = liveEntries.map(function(e) { return [e[0], Number(e[1]), todayStr, 'live-quote']; });
            var wsLive = XLSX.utils.aoa_to_sheet([['ticker', 'price', 'date', 'source']].concat(liveRows));
            wsLive['!cols'] = [{ wch: 14 }, { wch: 12 }, { wch: 12 }, { wch: 14 }];
            // ── 6. SHA-256 integrity checksum then assemble & deliver ─────────────
            var exportedAt = new Date().toISOString();
            var checksumInput = dataRows.map(function(r) { return r.join('|'); }).join('\n');
            var tsLabel = exportedAt.slice(0, 10) + '-' + exportedAt.slice(11, 13) + exportedAt.slice(14, 16);
            var filename = 'portfolio-price-export-' + tsLabel + '.xlsx';
            sha256Hex(checksumInput).then(function(datasetHash) {
                var wsMeta = XLSX.utils.aoa_to_sheet([
                    ['key', 'value'],
                    ['exported_at', exportedAt],
                    ['format_version', '5'],
                    ['ticker_count', sortedTickers.length],
                    ['row_count', dataRows.length],
                    ['live_quote_count', liveRows.length],
                    ['skipped_points', skippedCount],
                    ['sha256_prices', datasetHash],
                    ['tickers', sortedTickers.join(', ')],
                    ['note', 'Import via the Prices button in portfolio-app.html'],
                ]);
                wsMeta['!cols'] = [{ wch: 24 }, { wch: 70 }];
                var wb = XLSX.utils.book_new();
                XLSX.utils.book_append_sheet(wb, ws, 'prices');
                if (liveRows.length > 0) XLSX.utils.book_append_sheet(wb, wsLive, 'live_quotes');
                XLSX.utils.book_append_sheet(wb, wsMeta, 'meta');
                var buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
                var liveNote = liveRows.length > 0 ? ' + ' + liveRows.length + ' live quotes' : '';
                var skipNote = skippedCount > 0 ? ' (' + skippedCount + ' invalid skipped)' : '';
                // Write-then-verify integrity check
                try {
                    var wbCheck = XLSX.read(buf, { type: 'array' });
                    var wsCheck = wbCheck.Sheets['prices'];
                    var rowsCheck = wsCheck ? XLSX.utils.sheet_to_json(wsCheck).length : 0;
                    if (rowsCheck !== dataRows.length) {
                        setUploadError('XLSX integrity check failed: wrote ' + dataRows.length + ' rows but verified ' + rowsCheck + '. Please retry.');
                        return Promise.resolve();
                    }
                } catch (verifyErr) { /* non-fatal */ }
                return deliverFile(buf, filename, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').then(function() {
                    setUploadError(null);
                    setUploadFeedback({
                        added: dataRows.length, duplicates: 0, intraFileDupes: 0,
                        existingDupes: 0, files: 1, extendedOldest: false, extendedNewest: false,
                        ts: Date.now(),
                        _exportMsg: 'Exported ' + dataRows.length + ' pts for ' + tickers.length + ' tickers' + liveNote + skipNote + ' · verified ✓',
                    });
                });
            }).catch(function(err) {
                console.error('Export failed:', err);
                setUploadError('Export failed: ' + err.message);
            });
        }, [prices, livePrices, loadSource, liveAt, tickerCurrencyMap, setUploadError, setUploadFeedback]);
        // ── JSON backup export (v4 unified system snapshot) ──────────────────────
        // v4 improvements:
        //   • pnlSessionDate in envelope — deterministic freshness anchor (session date,
        //     not wall-clock timestamp, so Saturday backup is valid through Monday)
        //   • prices pre-injected with live closes at their session date — chart renders
        //     correctly from backup alone without requiring a live fetch (sandbox-safe)
        //   • todayPnlSnapshot — frozen P&L used as chartData fallback when offline
        //   • compConfigs + externalHoldings — full workspace portability
        //   • liveDailyCloses + liveQuoteSessionDates — complete session-date state
        //   • summary block — human-readable envelope metadata
        // ── 100% Synchronous — preserves iOS gesture token for share sheet ──────────
        // Market Overview state — declared here (before export hooks) so exportPricesJson
        // and confirmJsonImport can safely reference marketRows/marketStatus/etc.
        const [marketRows,   setMarketRows]   = React.useState(null);
        const [marketStatus, setMarketStatus] = React.useState('idle');
        const [marketAt,     setMarketAt]     = React.useState(null);
        const [marketError,  setMarketError]  = React.useState(null);
        // True once a live fetch in this session has produced usable Markets rows. Drives the
        // green icon on the main-screen Markets button; deliberately NOT set by a restored backup.
        const [marketReady,  setMarketReady]  = React.useState(false);
        const marketCacheRef = React.useRef({ rows: null, at: 0, _fetching: false });
        const marketAbortRef = React.useRef(null);
        // Dynamic instrument list: base + holdings. Ref keeps refreshMarketOverview stable.
        const marketOverviewInstrumentsRef = React.useRef(BASE_MARKET_OVERVIEW_INSTRUMENTS);

        // With a function as `target` (the cloud backup), the JSON text goes to it instead of being saved as a file,
        // and that call's result is returned; nothing to back up returns null. From a button, target is the click event.
        const exportPricesJson = useCallback(function(target) {
            var toFn = typeof target === 'function';
            try {
                var rawTickers = Object.keys(prices);
                var hasMarketOverviewRows = Array.isArray(marketRows) && marketRows.length > 0;
                if (rawTickers.length === 0 && transactions.length === 0
                    && compConfigs.length === 0 && externalHoldings.length === 0
                    && !hasMarketOverviewRows) {
                    // The cloud backup still goes when Estate holds balances: they live in the same backup.
                    var hasBalances = !!(window.BalancesStore && window.BalancesStore.get && window.BalancesStore.get().accounts.length)
                        || !!(window.LifeAdminStore && window.LifeAdminStore.get().bills.length)
                        || !!(window.PayStore && window.PayStore.get().years.length);
                    if (toFn && !hasBalances) return null;
                    if (!toFn) {
                        setUploadError('No workspace data to export — upload transactions or prices first.');
                        return;
                    }
                }

                // ── Effective P&L session date ───────────────────────────────────────
                // This is the market-session date the live prices represent, not the
                // wall-clock timestamp. On Saturday it resolves to Friday.
                var pnlSessionDate = getEffectivePnlSessionDateStr(liveAt, getCurrentPnlSessionDateStr())
                    || getCurrentPnlSessionDateStr();

                // ── Pre-inject live prices into the historical series ────────────────
                // Merging at export time means the historical series already ends at
                // Friday's close. resolvedPricesMap builds correctly from prices alone
                // on restore — no live fetch or injection step required (sandbox-safe).
                var pricesForExport = {};
                Object.keys(prices).forEach(function(tk) {
                    pricesForExport[tk] = prices[tk].slice();
                });
                Object.entries(livePrices).forEach(function(entry) {
                    var ticker = entry[0].toUpperCase().trim();
                    var px = Number(entry[1]);
                    if (!Number.isFinite(px) || px <= 0) return;
                    // Use per-ticker regularMarketTime date when available; fall back to session date.
                    var sessionDate = (liveQuoteSessionDates && liveQuoteSessionDates[ticker])
                        || pnlSessionDate;
                    if (!sessionDate) return;
                    // withLiveTail also bridges completed sessions the stored history is missing, and does not inject
                    // when sessionDate < last.date (would create a retrograde entry).
                    pricesForExport[ticker] = withLiveTail(pricesForExport[ticker], ticker, sessionDate, px, liveDailyCloses);
                });

                // ── Frozen Today P&L snapshot ────────────────────────────────────────
                // Stored so chartData can reconcile the final chart point when offline.
                // The sessionDate guard in chartData prevents a stale snapshot from
                // applying to a different trading day.
                var frozenPnl = (masterPortfolio.todayAbsChange != null
                    && Number.isFinite(masterPortfolio.todayAbsChange)
                    && masterPortfolio.totalValue != null)
                    ? {
                        totalValue:     masterPortfolio.totalValue,
                        todayAbsChange: masterPortfolio.todayAbsChange,
                        todayPctChange: masterPortfolio.todayPctChange,
                        // ledger-only twins, so a restored snapshot can still reconcile the chart correctly
                        ledgerTotalValue:     masterPortfolio.ledger ? masterPortfolio.ledger.totalValue : undefined,
                        ledgerTodayAbsChange: masterPortfolio.ledger ? masterPortfolio.ledger.todayAbsChange : undefined,
                        ledgerTodayPctChange: masterPortfolio.ledger ? masterPortfolio.ledger.todayPctChange : undefined,
                        sessionDate:    pnlSessionDate,
                    }
                    : null;

                // ── Payload ──────────────────────────────────────────────────────────
                var exportTimestamp = new Date().toISOString();
                var sanitizedMktRows = sanitizeMarketOverviewRows(marketRows);
                var payload = {
                    transactions:         transactions,
                    prices:               pricesForExport,
                    livePrices:           livePrices,
                    livePrevClose:        livePrevClose,
                    liveDailyCloses:      liveDailyCloses,
                    liveQuoteSessionDates: liveQuoteSessionDates,
                    todayPnlSnapshot:     frozenPnl,
                    compConfigs:          compConfigs,
                    externalHoldings:     externalHoldings,
                    loadSource:           loadSource,
                    metadata_schema: {
                        currencies:    tickerCurrencyMap,
                        stooq_aliases: tickerStooqMap,
                        display_names: tickerNameMap,
                    },
                    // Stored gilt closes (read straight from storage, synchronously, so the iOS share gesture survives).
                    giltPriceHistory: { v: 1, snaps: loadGyCache().snaps },
                    // Balances screen data (balances.js); null when it holds nothing or the file did not load.
                    balances: window.BalancesStore ? window.BalancesStore.backupSnapshot() : null,
                    // Cash Flow bills (lifeadmin.js); null when there are none. Password hints are never in here.
                    lifeAdmin: window.LifeAdminStore ? window.LifeAdminStore.backupSnapshot() : null,
                    // Pay (pay.js): salary, bonus and stock awards by year; null when there are none.
                    pay: window.PayStore ? window.PayStore.backupSnapshot() : null,
                    marketOverview: sanitizedMktRows.length > 0 ? {
                        schemaVersion: 2,
                        exportedAt:    exportTimestamp,
                        updatedAt:     marketAt || null,
                        status:        marketStatus || 'idle',
                        error:         marketError  || null,
                        rows:          sanitizedMktRows,
                    } : null,
                };
                var pricedTickers   = Object.keys(pricesForExport).filter(function(t) {
                    return Array.isArray(pricesForExport[t]) && pricesForExport[t].length > 0;
                });
                var envelope = {
                    format:          'portfolio-system-snapshot',
                    format_version:  4,
                    exportTimestamp: exportTimestamp,
                    pnlSessionDate:  pnlSessionDate,
                    datasetHash:     'SYNC_FAST_DELIVERY',
                    summary: {
                        portfolioValue:    masterPortfolio.totalValue   || null,
                        todayPnl:          masterPortfolio.todayAbsChange || null,
                        sessionDate:       pnlSessionDate,
                        transactionCount:  transactions.length,
                        tickerCount:       pricedTickers.length,
                        equityPlanCount:   compConfigs.length,
                        custodyPositions:  externalHoldings.length,
                        liveQuoteCount:    Object.keys(livePrices).length,
                        marketRowCount:    sanitizedMktRows.length,
                        hasMarketOverview: sanitizedMktRows.length > 0,
                        giltTickerCount:   Object.keys(payload.giltPriceHistory.snaps).length,
                        balanceSnapshots:  payload.balances ? payload.balances.snapshots.length : 0,
                    },
                    payload: payload,
                };
                // Troubleshooting snapshot — outside payload, ignored on import, no API keys.
                try {
                    envelope.diagnostics = buildDailyCheckDiagnostics({
                        liveDailyCloses:       liveDailyCloses,
                        liveQuoteSessionDates: liveQuoteSessionDates,
                        livePrices:            livePrices,
                        dailyCheckStatus:      dailyCheckStatus,
                        liveQuoteChecks:       liveQuoteChecks,
                        pricingWarnings:       pricingWarnings,
                        gbpusd:                gbpusdInfo,
                        holdings:              activeHoldingsWithDelta,
                        marketRows:            sanitizedMktRows,
                    });
                } catch (diagErr) {
                    envelope.diagnostics = { error: 'diagnostics failed: ' + (diagErr && diagErr.message) };
                }

                var jsonString = JSON.stringify(envelope, null, 2);
                var tsLabel    = exportTimestamp.slice(0, 10) + '-' + exportTimestamp.slice(11, 13) + exportTimestamp.slice(14, 16);
                var filename   = 'portfolio-backup-v4-' + tsLabel + '.json';
                if (toFn) return target(jsonString, filename);

                setUploadError(null);
                deliverJsonBackup(jsonString, filename).catch(function(err) {
                    if (err && err.name !== 'AbortError') setUploadError('JSON delivery failed: ' + err.message);
                });

            } catch(err) {
                if (toFn) throw err;
                setUploadError('JSON export failed: ' + err.message);
            }
        }, [prices, livePrices, livePrevClose, liveDailyCloses, liveQuoteSessionDates,
            loadSource, tickerCurrencyMap, tickerStooqMap, tickerNameMap,
            transactions, compConfigs, externalHoldings,
            masterPortfolio, liveAt,
            marketRows, marketAt, marketStatus, marketError,
            dailyCheckStatus, liveQuoteChecks, pricingWarnings, gbpusdInfo, activeHoldingsWithDelta,
            setUploadError, setUploadFeedback, setExportModal]);
        // ── JSON restore (import) ─────────────────────────────────────────────────
        // Three-phase pipeline: validate → confirm → atomic swap + IDB persist.
        // Uses sessionStorage rollback so the user can undo if they picked the wrong file.
        const [jsonImportPending, setJsonImportPending] = React.useState(null); // { parsed, summary } | null
        const [jsonImportMode, setJsonImportMode] = React.useState('both'); // 'both'|'tx'|'prices'
        const handlePricesJsonRef = React.useRef(null);
        const handlePricesJson = useCallback(function(file) {
            if (!file) return;
            setUploadError(null);
            file.text().then(async function(text) {
                var parsed;
                try { parsed = JSON.parse(text); } catch(e) { throw new Error('Not valid JSON: ' + e.message); }
                // ── Schema check ──────────────────────────────────────────────────
                if (parsed && parsed.format === 'estate-balances')
                    throw new Error('this is an Estate-only file. Use Import Balances under Estate only, just below.');
                var ver = parsed.format_version;
                var data;
                var txList = null; // only populated for v3
                if ((ver === 4 || ver === 3) && parsed.payload && typeof parsed.payload.prices === 'object') {
                    // v3/v4 unified snapshot: verify payload hash when present.
                    // SYNC_FAST_DELIVERY bypasses WebCrypto to protect the iOS gesture token.
                    if (parsed.datasetHash !== 'SYNC_FAST_DELIVERY') {
                        var computedHash = await sha256Hex(JSON.stringify(sortObjectKeys(parsed.payload)));
                        if (computedHash !== parsed.datasetHash)
                            throw new Error('Cryptographic checksum mismatch. This backup file is altered or corrupted.');
                    }
                    data = {
                        prices:               parsed.payload.prices,
                        livePrices:           parsed.payload.livePrices           || {},
                        livePrevClose:        parsed.payload.livePrevClose        || {},
                        liveDailyCloses:      parsed.payload.liveDailyCloses      || {},
                        liveQuoteSessionDates: parsed.payload.liveQuoteSessionDates || {},
                        todayPnlSnapshot:     parsed.payload.todayPnlSnapshot     || null,
                        compConfigs:          Array.isArray(parsed.payload.compConfigs)      ? parsed.payload.compConfigs      : [],
                        externalHoldings:     Array.isArray(parsed.payload.externalHoldings) ? parsed.payload.externalHoldings : [],
                        loadSource:           parsed.payload.loadSource           || {},
                        marketOverview:       validateMarketOverviewSnapshot(parsed.payload.marketOverview),
                        giltPriceHistory:     validateGiltSnapshots(parsed.payload.giltPriceHistory),
                    };
                    txList = Array.isArray(parsed.payload.transactions) ? parsed.payload.transactions : [];
                } else if (ver === 2 && parsed.data && typeof parsed.data.prices === 'object') {
                    // v2 format: data lives inside parsed.data
                    data = parsed.data;
                } else if (ver === 1 && typeof parsed.prices === 'object') {
                    // Legacy v1: migrate flat structure to current envelope
                    data = { prices: parsed.prices, livePrices: parsed.livePrices || {}, loadSource: parsed.loadSource || {} };
                } else if (ver === undefined || ver === null) {
                    throw new Error('Missing format_version field — this does not appear to be a portfolio backup file.');
                } else {
                    throw new Error('Unsupported format_version: ' + JSON.stringify(ver) + '. Expected 1–4. You may need a newer version of the app.');
                }
                // ── Integrity check (v2 only — v1 has no hash, v3 already checked above) ──
                var hashPromise = (ver === 2 && parsed.datasetHash)
                    ? sha256Hex(JSON.stringify(data, Object.keys(data).sort())).then(function(computed) {
                        if (computed !== parsed.datasetHash)
                            throw new Error('Checksum mismatch — file may be corrupted. Aborting.');
                      })
                    : Promise.resolve();
                return hashPromise.then(function() {
                    // ── Structural validation of prices ───────────────────────────
                    var pricesObj = data.prices || {};
                    var invalidTickers = [];
                    Object.keys(pricesObj).forEach(function(t) {
                        var s = pricesObj[t];
                        if (!Array.isArray(s)) { invalidTickers.push(t + ' (not array)'); return; }
                        if (s.length > 0) {
                            var p = s[0];
                            if (typeof p !== 'object' || p === null || typeof p.date !== 'string' || typeof p.close !== 'number') {
                                invalidTickers.push(t + ' (malformed coordinate structure)');
                            }
                        }
                    });
                    if (invalidTickers.length > 0) {
                        throw new Error('Structural layout corruption detected within: ' + invalidTickers.slice(0, 3).join(', ') +
                            (invalidTickers.length > 3 ? ' and ' + (invalidTickers.length - 3) + ' more' : '') +
                            '. File may be corrupted.');
                    }
                    // ── Build summary for confirmation dialog ─────────────────────
                    var incomingTickers = Object.keys(pricesObj).filter(function(t) {
                        return Array.isArray(pricesObj[t]) && pricesObj[t].length > 0;
                    });
                    var incomingLive = Object.keys(data.livePrices || {}).length;
                    var tsRaw = parsed.exportTimestamp || parsed.exported_at || null;
                    var exportedAt = tsRaw ? new Date(tsRaw).toLocaleString('en-GB') : 'unknown date';
                    var ageStr = '';
                    if (tsRaw) {
                        var ageMins = Math.round((Date.now() - new Date(tsRaw).getTime()) / 60000);
                        if (ageMins < 2) ageStr = 'just now';
                        else if (ageMins < 60) ageStr = ageMins + ' mins ago';
                        else if (ageMins < 1440) ageStr = Math.round(ageMins / 60) + 'h ago';
                        else { var ageDays = Math.round(ageMins / 1440); ageStr = ageDays + (ageDays === 1 ? ' day ago' : ' days ago'); }
                    }
                    var incomingPlans    = (data.compConfigs     || []).length;
                    var incomingCustody  = (data.externalHoldings || []).length;
                    var importPnlDate    = ver === 4 ? (parsed.pnlSessionDate || null) : null;
                    // Estate rides in the same backup (payload.balances) and comes back only with Import Everything.
                    var bal = parsed.payload && parsed.payload.balances;
                    var estate = bal && Array.isArray(bal.accounts) && bal.accounts.length ? {
                        accounts: bal.accounts.filter(function(a) { return a && !a.closed; }).length,
                        entries:  Array.isArray(bal.snapshots) ? bal.snapshots.length : 0,
                        latest:   (Array.isArray(bal.snapshots) ? bal.snapshots : []).reduce(function(m, x) { return x && x.date > m ? x.date : m; }, ''),
                    } : null;
                    var la = parsed.payload && parsed.payload.lifeAdmin;
                    var lifeAdmin = la && Array.isArray(la.bills) && la.bills.length ? { bills: la.bills.length } : null;
                    var py = parsed.payload && parsed.payload.pay;
                    var pay = py && Array.isArray(py.years) && py.years.length ? { years: py.years.length } : null;
                    setJsonImportPending({ parsed: parsed, data: data, txList: txList,
                        pnlSessionDate: importPnlDate,
                        summary: {
                        tickers:         incomingTickers.length,
                        liveQuotes:      incomingLive,
                        txCount:         txList !== null ? txList.length : null,
                        equityPlans:     incomingPlans,
                        custodyPositions: incomingCustody,
                        hasPnlSnapshot:  !!(data.todayPnlSnapshot),
                        estate:          estate,
                        lifeAdmin:       lifeAdmin,
                        pay:             pay,
                        marketRows:      (data.marketOverview && data.marketOverview.rows) ? data.marketOverview.rows.length : 0,
                        hasMarketOverview: !!(data.marketOverview && data.marketOverview.rows && data.marketOverview.rows.length > 0),
                        giltTickers:     data.giltPriceHistory ? data.giltPriceHistory.tickers : 0,
                        giltSessions:    data.giltPriceHistory ? data.giltPriceHistory.sessions : 0,
                        giltRejected:    data.giltPriceHistory ? data.giltPriceHistory.rejected : 0,
                        exportedAt:      exportedAt,
                        ageStr:          ageStr,
                        ver:             ver,
                        hasHash:         !!(parsed.datasetHash),
                        isFullSnapshot:  ver === 3 || ver === 4,
                    }});
                });
            }).catch(function(err) {
                setUploadError('JSON restore failed: ' + err.message);
            });
        }, [setUploadError]);
        handlePricesJsonRef.current = handlePricesJson;
        const confirmJsonImport = useCallback(async function() {
            if (!jsonImportPending) return;
            var data         = jsonImportPending.data;
            var parsed       = jsonImportPending.parsed;
            var txList       = jsonImportPending.txList;
            var pnlSessDate  = jsonImportPending.pnlSessionDate || null;  // v4 only
            var ver          = Number(parsed.format_version) || 0;
            var isFullSnapshot = !!(txList !== null && txList !== undefined);
            var shouldRestorePrices = (jsonImportMode === 'both' || jsonImportMode === 'prices');
            var shouldRestoreTx    = (jsonImportMode === 'both' || jsonImportMode === 'tx') && isFullSnapshot;
            // ── Rollback snapshot ─────────────────────────────────────────────────
            var snapTs = Date.now();
            try {
                var currentTx = shouldRestoreTx ? (await idbGet('transactions') || []) : [];
                var snap = JSON.stringify({
                    prices: prices, loadSource: loadSource, transactions: currentTx,
                    compConfigs: compConfigs, externalHoldings: externalHoldings,
                    snapTs: snapTs,
                    giltCache: loadGyCache(),
                    marketOverview: {
                        rows: marketRows, at: marketAt, status: marketStatus, error: marketError,
                    },
                });
                sessionStorage.setItem('json_import_rollback', snap);
            } catch(e) { snapTs = null; }
            // ── Atomic state swap ─────────────────────────────────────────────────
            var idbWrites = [];
            var newMeta = null;
            // Balances (balances.js): only a full restore of a backup that carries them, so restoring an older
            // backup never wipes balances entered since.
            if (jsonImportMode === 'both' && parsed.payload && parsed.payload.balances && window.BalancesStore) {
                window.BalancesStore.restore(parsed.payload.balances);
            }
            if (jsonImportMode === 'both' && parsed.payload && parsed.payload.lifeAdmin && window.LifeAdminStore) {
                window.LifeAdminStore.restore(parsed.payload.lifeAdmin);
            }
            if (jsonImportMode === 'both' && parsed.payload && parsed.payload.pay && window.PayStore) {
                window.PayStore.restore(parsed.payload.pay);
            }
            if (shouldRestorePrices) {
                var restoredPrices = data.prices   || {};
                var restoredSource = data.loadSource || {};
                setPrices(restoredPrices);
                // ── Live-state freshness check ────────────────────────────────────────
                // v4: use pnlSessionDate (market-session anchor) for deterministic freshness —
                //     a Saturday backup with Friday prices is valid through Monday morning.
                // v3 and earlier: fall back to isSameCalendarDay(exportTimestamp) as before.
                var liveTs = parsed.exportTimestamp || parsed.exported_at || null;
                var restoreLiveState;
                if (pnlSessDate) {
                    // v4: compare session date against current P&L session
                    restoreLiveState = getEffectivePnlSessionDateStr(
                        new Date(pnlSessDate + 'T12:00:00Z'),
                        getCurrentPnlSessionDateStr()
                    ) != null;
                } else {
                    // v1/v2/v3 fallback: unchanged behaviour
                    restoreLiveState = isSameCalendarDay(liveTs);
                }

                // liveAt anchor: use pnlSessionDate (v4) for deterministic session date;
                // fall back to exportTimestamp for v3 and earlier.
                var liveAtAnchor = pnlSessDate
                    ? new Date(pnlSessDate + 'T12:00:00Z')
                    : (liveTs ? new Date(liveTs) : null);

                if (restoreLiveState && data.livePrices && Object.keys(data.livePrices).length > 0) {
                    var normLive = {};
                    Object.entries(data.livePrices).forEach(function(entry) {
                        normLive[entry[0].toUpperCase().trim()] = entry[1];
                    });
                    // Same live-quote gate as the fetch commit: a restored backup must
                    // not re-introduce a quote the gate would reject today. (Quote
                    // currencies are not in backups, so only the price checks run.)
                    var restoreQSD = {};
                    Object.entries(data.liveQuoteSessionDates || {}).forEach(function(e) {
                        if (e[1]) restoreQSD[e[0].toUpperCase().trim()] = e[1];
                    });
                    var restoreGate = gateLiveQuotes({
                        quotes: normLive, sessionDates: restoreQSD,
                        dailyCloses: data.liveDailyCloses || {}, prices: data.prices || {},
                        quoteCurrencies: null, expectedCurrencies: null,
                    });
                    normLive = restoreGate.accepted;
                    setLiveQuoteChecks(restoreGate.checks);
                    setLivePrices(normLive);
                    if (liveAtAnchor) setLiveAt(liveAtAnchor);
                    setLiveStatus('ok');

                    // liveDailyCloses: restore from v4 payload; fall back to empty (forces fresh fetch).
                    if (data.liveDailyCloses && Object.keys(data.liveDailyCloses).length > 0) {
                        setLiveDailyCloses(data.liveDailyCloses);
                    } else {
                        setLiveDailyCloses({});
                    }

                    // liveQuoteSessionDates: restore from v4 payload, normalising keys to
                    // UPPER.TRIM for consistency with fetchLivePrices commit path.
                    if (data.liveQuoteSessionDates && Object.keys(data.liveQuoteSessionDates).length > 0) {
                        var normQSD = {};
                        Object.entries(data.liveQuoteSessionDates).forEach(function(e) {
                            if (e[1]) normQSD[e[0].toUpperCase().trim()] = e[1];
                        });
                        setLiveQuoteSessionDates(normQSD);
                    } else {
                        setLiveQuoteSessionDates({});
                    }

                    // livePrevClose: restore from export. Nothing reads it for a Today figure any more (they all use
                    // resolveVerifiedDailyPrevClose on the restored liveDailyCloses); it is restored only so old exports stay whole.
                    if (data.livePrevClose && Object.keys(data.livePrevClose).length > 0) {
                        var normPrev = {};
                        Object.entries(data.livePrevClose).forEach(function(entry) {
                            normPrev[entry[0].toUpperCase().trim()] = entry[1];
                        });
                        setLivePrevClose(normPrev);
                    } else {
                        // Fallback: derive previous close from tail of historical series
                        var pnlCandStr = getCurrentPnlSessionDateStr();
                        var derivedPrev = {};
                        Object.keys(normLive).forEach(function(tk) {
                            var series = (data.prices || {})[tk] ||
                                Object.entries(data.prices || {}).reduce(function(found, e) {
                                    return !found && e[0].toUpperCase() === tk ? e[1] : found;
                                }, null);
                            if (Array.isArray(series) && series.length > 0) {
                                var prev = series.filter(function(p) { return p.date < pnlCandStr; });
                                if (prev.length > 0) derivedPrev[tk] = prev[prev.length - 1].close;
                            }
                        });
                        if (Object.keys(derivedPrev).length > 0) setLivePrevClose(derivedPrev);
                    }
                } else {
                    // Stale export or no live data — clear live state, require fresh fetch.
                    setLiveQuoteChecks({});
                    setLivePrices({});
                    setLivePrevClose({});
                    setLiveDailyCloses({});
                    setLiveQuoteSessionDates({});
                    setLiveStatus('idle');
                    setLiveAt(null);
                }

                // todayPnlSnapshot: always restore (sessionDate guard in chartData prevents
                // a stale snapshot from applying to the wrong trading day).
                if (data.todayPnlSnapshot && data.todayPnlSnapshot.sessionDate) {
                    setTodayPnlSnapshot(data.todayPnlSnapshot);
                } else {
                    setTodayPnlSnapshot(null);
                }
                setLoadSource(restoredSource);
                var restoredStatus = {};
                Object.keys(restoredPrices).forEach(function(t) { restoredStatus[t] = 'ok'; });
                setLoadStatus(restoredStatus);
                // Restore employer equity plans and external custody positions.
                // v4: always restore (even if empty array) — the backup explicitly
                //     captured the workspace state so empty means "user had none".
                // v3 and earlier: only restore if the backup contained data, to avoid
                //     silently wiping plans that weren't part of the older format.
                if (ver >= 4) {
                    var safeComp = Array.isArray(data.compConfigs) ? data.compConfigs : [];
                    setCompConfigs(safeComp);
                    idbWrites.push(idbSet('corporate_equity_config', safeComp));
                    var safeExt = Array.isArray(data.externalHoldings) ? data.externalHoldings : [];
                    setExternalHoldings(safeExt);
                    idbWrites.push(idbSet('external_custody_holdings', safeExt));
                } else {
                    if (Array.isArray(data.compConfigs) && data.compConfigs.length > 0) {
                        setCompConfigs(data.compConfigs);
                        idbWrites.push(idbSet('corporate_equity_config', data.compConfigs));
                    }
                    if (Array.isArray(data.externalHoldings) && data.externalHoldings.length > 0) {
                        setExternalHoldings(data.externalHoldings);
                        idbWrites.push(idbSet('external_custody_holdings', data.externalHoldings));
                    }
                }
                if (restoredPrices['GBPUSD=X']) setFxGBPUSD(restoredPrices['GBPUSD=X']);
                var tsRaw = parsed.exportTimestamp || parsed.exported_at || null;
                newMeta = {
                    savedAt: snapTs || Date.now(),
                    seriesCount: Object.keys(restoredPrices).length,
                    priceSource: restoredSource,
                    restoredFrom: tsRaw,
                };
                idbWrites.push(idbSet('prices', restoredPrices));
                idbWrites.push(idbSet('meta', newMeta));
                // Gilt closes: merged into what is already stored, never replacing a newer close. An old backup
                // without them leaves the stored ones as they are.
                if (data.giltPriceHistory && data.giltPriceHistory.tickers > 0) {
                    var giltMerged = mergeGiltSnapshots(loadGyCache(), data.giltPriceHistory.snaps);
                    saveGyCache(giltMerged);
                    setGiltMarket(giltMerged);
                }
            }
            if (shouldRestoreTx) {
                idbWrites.push(idbSet('transactions', txList));
            }
            try {
                await Promise.all(idbWrites);
                if (newMeta) setCacheMeta(newMeta);
                if (shouldRestoreTx) {
                    setTransactions(txList.slice().sort(function(a, b) {
                        return parseDate(b.tradeDate) - parseDate(a.tradeDate);
                    }));
                }
            } catch(e) {
                console.warn('IDB persist after JSON restore failed:', e.message);
            }
            setJsonImportPending(null);
            setJsonImportMode('both');
            setUploadError(null);
            // ── Restore Market Overview rows if present ───────────────────────────
            // ── Restore Market Overview rows ──────────────────────────────────────
            // Rule 1: if the snapshot contains valid v2+ rows, restore them.
            // Rule 2: schemaVersion < 2 (pre-index refactor) → discard stale futures rows,
            //         clear history cache, force a fresh fetch.
            // Rule 3: full/both import with no marketOverview → reset to idle.
            // Rule 4: prices-only or tx-only import → leave Market Overview untouched.
            var importedMO = data.marketOverview;
            var moVersion  = importedMO ? (Number(importedMO.schemaVersion) || 0) : 0;
            var hasMORows  = importedMO && Array.isArray(importedMO.rows) &&
                             importedMO.rows.length > 0 && moVersion >= 2;
            var isFullMode = (jsonImportMode === 'both');
            if (hasMORows) {
                var restoredMktRows  = sanitizeMarketOverviewRows(importedMO.rows);
                var restoredMktAt    = Number(importedMO.updatedAt) || Date.now();
                var restoredMktStatus = importedMO.status;
                if (restoredMktStatus !== 'ok' && restoredMktStatus !== 'partial' &&
                    restoredMktStatus !== 'offline' && restoredMktStatus !== 'fail') {
                    restoredMktStatus = restoredMktRows.length > 0 ? 'partial' : 'idle';
                }
                setMarketRows(restoredMktRows);
                setMarketAt(restoredMktAt);
                setMarketError(importedMO.error || null);
                setMarketStatus(restoredMktStatus);
                marketCacheRef.current = { rows: restoredMktRows, at: restoredMktAt, _fetching: false };
            } else if (isFullMode) {
                // Full restore of an old backup without marketOverview → reset to idle.
                setMarketRows(null); setMarketAt(null); setMarketError(null); setMarketStatus('idle');
                marketCacheRef.current = { rows: null, at: 0, _fetching: false };
            } else if (importedMO && moVersion < 2) {
                // Pre-v2 snapshot with futures-based rows — discard to avoid stale data.
                MARKET_HISTORY_CACHE = {};
                setMarketRows(null); setMarketAt(null); setMarketError(null); setMarketStatus('idle');
                marketCacheRef.current = { rows: null, at: 0, _fetching: false };
            }
            // else: partial import with no marketOverview — leave existing Market Overview untouched.
            var txNote = shouldRestoreTx ? ' · ' + txList.length + ' trades restored' : '';
            var priceNote = shouldRestorePrices ? Object.keys(data.prices || {}).length + ' tickers' : 'prices untouched';
            if (shouldRestorePrices && data.giltPriceHistory && data.giltPriceHistory.tickers > 0) {
                priceNote += ' · ' + data.giltPriceHistory.tickers + ' gilts (' + data.giltPriceHistory.sessions + ' closes)';
            }
            setUploadFeedback({
                added: shouldRestorePrices ? Object.keys(data.prices || {}).length : 0,
                duplicates: 0, intraFileDupes: 0, existingDupes: 0, files: 1,
                extendedOldest: false, extendedNewest: false, ts: Date.now(),
                _exportMsg: 'Restore complete · ' + priceNote + txNote,
                _showUndo: snapTs !== null,
            });
        }, [jsonImportPending, jsonImportMode, prices, loadSource, compConfigs, externalHoldings,
            marketRows, marketAt, marketStatus, marketError,
            setGiltMarket, setUploadFeedback, setUploadError]);
        // formatGBP, C, sys, mono, serif, fmtV, fmtA, fmtP, signColor are now global (above PortfolioApp).

        // ─── Phase 1: Bottom-Sheet Dashboard ────────────────────────────────────
        // State
        const [sheetContext, setSheetContext] = React.useState(null); // null|'all'|accountName
        const [sheetSearch, setSheetSearch] = React.useState('');
        const [sheetSort, setSheetSort] = React.useState('value'); // 'value'|'today'|'total'
        // After Settings → Reload Latest Version, come back on Settings and the same tab (see useReloadLatest).
        const [showSettings, setShowSettings] = React.useState(() => !!readReloadReturn());
        // Top tab bar: 'markets' | 'investments' | 'estate' | 'lifeadmin'. Markets is read-only and does not feed portfolio
        // valuation; Estate (balances.js) tracks account balances month by month, separate from the portfolio valuation;
        // Cash Flow (lifeadmin.js, id 'lifeadmin' from when it was Life Admin) has Pay (pay.js) and the monthly bills.
        const [activeTab, setActiveTab] = React.useState(() => {
            const t = (readReloadReturn() || {}).tab;
            // 'pay': a reload started on the old Pay tab, now the Pay line on Cash Flow.
            return t === 'markets' || t === 'estate' || t === 'lifeadmin' ? t : t === 'pay' ? 'lifeadmin' : 'investments';
        });
        React.useEffect(() => { reloadReturnTab = activeTab; }, [activeTab]);
        // Swipe left or right to move between the tabs (Fergus asked). See swipeAllowed for where a swipe may start.
        const tabOrderRef = React.useRef([]);
        tabOrderRef.current = ['markets', 'investments'].concat(typeof window.BalancesScreen === 'function' ? ['estate'] : [],
                                                                typeof window.LifeAdminScreen === 'function' ? ['lifeadmin'] : []);
        // A swiped- or tapped-to screen slides in from the side it came from (Fergus: an instant switch felt too abrupt).
        const swipeDirRef = React.useRef(0);
        // Tapping a tab: another tab slides in like a swipe; the tab already open scrolls smoothly back to its top.
        const tapTab = id => {
            if (id === activeTab) {
                const screen = document.querySelector('[data-tab-screen="' + id + '"]');
                const scrollers = screen ? [screen].concat(Array.from(screen.querySelectorAll('.ios-scroll'))) : [];
                for (let n = screen && screen.parentElement; n && n !== document.body; n = n.parentElement) scrollers.push(n);
                scrollers.forEach(el => { if (el.scrollTop > 0) el.scrollTo({ top: 0, behavior: 'smooth' }); });
                return;
            }
            const order = tabOrderRef.current;
            swipeDirRef.current = order.indexOf(id) > order.indexOf(activeTab) ? 1 : -1;
            setActiveTab(id);
        };
        React.useLayoutEffect(() => {
            const dir = swipeDirRef.current;
            swipeDirRef.current = 0;
            const el = dir && document.querySelector('[data-tab-screen="' + activeTab + '"]');
            if (el && el.animate) el.animate([{ transform: 'translateX(' + (dir * 28) + '%)', opacity: 0.3 }, { transform: 'none', opacity: 1 }],
                                              { duration: 320, easing: 'cubic-bezier(0.22, 0.8, 0.3, 1)' });
        }, [activeTab]);
        React.useEffect(() => {
            let start = null;
            const onStart = e => {
                start = null;
                if (e.touches.length !== 1 || !swipeAllowed(e.target)) return;
                start = { x: e.touches[0].clientX, y: e.touches[0].clientY, t: Date.now() };
            };
            const onEnd = e => {
                if (!start) return;
                const t = e.changedTouches[0], dx = t.clientX - start.x, dy = t.clientY - start.y;
                const quick = Date.now() - start.t < 700;
                start = null;
                if (!quick || Math.abs(dx) < 60 || Math.abs(dx) < 2 * Math.abs(dy)) return;
                setActiveTab(cur => {
                    const order = tabOrderRef.current, i = order.indexOf(cur);
                    const next = order[i + (dx < 0 ? 1 : -1)];
                    if (next) swipeDirRef.current = dx < 0 ? 1 : -1;
                    return next || cur;
                });
            };
            document.addEventListener('touchstart', onStart, { passive: true });
            document.addEventListener('touchend', onEnd, { passive: true });
            return () => { document.removeEventListener('touchstart', onStart); document.removeEventListener('touchend', onEnd); };
        }, []);
        const hasBalances = typeof window.BalancesScreen === 'function';
        const showMarketOverview = activeTab === 'markets';
        const showBalances = activeTab === 'estate' && hasBalances;
        const hasLifeAdmin = typeof window.LifeAdminScreen === 'function';
        const showLifeAdmin = activeTab === 'lifeadmin' && hasLifeAdmin;
        // The tab list scrolls sideways; fades mark an edge with more tabs past it, and the open tab is kept in view.
        const tabListRef = React.useRef(null);
        const [tabFade, setTabFade] = React.useState({ l: false, r: false });
        const updateTabFade = React.useCallback(() => {
            const el = tabListRef.current;
            if (!el) return;
            const l = el.scrollLeft > 2, r = el.scrollLeft + el.clientWidth < el.scrollWidth - 2;
            setTabFade(f => (f.l === l && f.r === r ? f : { l, r }));
        }, []);
        const tabFadeMask = tabFade.l || tabFade.r
            ? 'linear-gradient(to right, ' + (tabFade.l ? 'transparent 0, #000 22px' : '#000 0') + ', ' + (tabFade.r ? '#000 calc(100% - 22px), transparent 100%' : '#000 100%') + ')'
            : 'none';
        React.useLayoutEffect(() => {
            const el = tabListRef.current;
            const tab = el && el.querySelector('[data-tab-id="' + activeTab + '"]');
            if (tab) {
                const pad = 24, left = tab.offsetLeft, right = left + tab.offsetWidth;
                const to = left - pad < el.scrollLeft ? left - pad : right + pad > el.scrollLeft + el.clientWidth ? right + pad - el.clientWidth : null;
                if (to != null) el.scrollTo({ left: Math.max(0, to), behavior: 'smooth' });
            }
            updateTabFade();
        }, [activeTab, updateTabFade]);
        React.useEffect(() => {
            window.addEventListener('resize', updateTabFade);
            return () => window.removeEventListener('resize', updateTabFade);
        }, [updateTabFade]);
        // The tab bar's height, published as --topbar-h so the Markets and Estate screens open below it.
        const topBarRef = React.useRef(null);
        React.useLayoutEffect(() => {
            const el = topBarRef.current;
            if (!el) return;
            const publish = () => document.documentElement.style.setProperty('--topbar-h', el.offsetHeight + 'px');
            publish();
            const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(publish) : null;
            if (ro) ro.observe(el);
            return () => { if (ro) ro.disconnect(); };
        }, []);

        // ── Pricing badge (main header) ──────────────────────────────────────
        // Same classification the Settings "Daily close check" grid uses (see
        // buildDailyCheckRows) — one judgement, shown in two places, never
        // disagreeing. Hidden entirely until there's at least one holding to
        // judge, so a cold start never flashes a wrong colour.
        const dailyCheckRowsSummary = React.useMemo(() => buildDailyCheckRows({
            liveDailyCloses, liveQuoteSessionDates, dailyCheckStatus, liveQuoteChecks, livePrices,
        }), [liveDailyCloses, liveQuoteSessionDates, dailyCheckStatus, liveQuoteChecks, livePrices]);
        const pricingBadge = React.useMemo(() => {
            // Cold start (no holdings judged yet) is its own neutral state — grey, a
            // dash, no claim either way — rather than hidden or defaulting to green.
            if (dailyCheckRowsSummary.length === 0) return { tier: 'unknown', label: 'Fetching Prices', icon: RefreshCw, iconSpin: true, color: '#a1a1aa', bg: 'rgba(161,161,170,0.08)', border: 'rgba(161,161,170,0.22)' };
            const failedCount   = dailyCheckRowsSummary.filter(r => r.tier === 'failed').length;
            const degradedCount = dailyCheckRowsSummary.filter(r => r.tier === 'degraded').length;
            if (failedCount > 0)   return { tier: 'failed',   label: 'Pricing Failed (' + failedCount + ')',      icon: XCircle,   color: '#f87171', bg: 'rgba(248,113,113,0.08)', border: 'rgba(248,113,113,0.22)' };
            // HelpCircle rather than AlertCircle: a single-source price isn't wrong,
            // just unconfirmed — it shouldn't borrow the same "!" alarm glyph as red.
            // Grey, not amber: the concern is missing data (no second source), not a mismatch — a mismatch is red (failed).
            if (degradedCount > 0)  return { tier: 'degraded', label: 'Pricing Unconfirmed (' + degradedCount + ')', icon: HelpCircle, color: DC_UNCONFIRMED_COLOUR, bg: 'rgba(161,161,170,0.08)', border: 'rgba(161,161,170,0.22)' };
            return { tier: 'verified', label: 'Pricing Verified', icon: CheckCircle, color: '#34d399', bg: 'rgba(52,211,153,0.08)', border: 'rgba(52,211,153,0.22)' };
        }, [dailyCheckRowsSummary]);
        // Tapping the pricing status opens Settings and scrolls to the Daily close check grid.
        const openDailyCheck = React.useCallback(() => {
            // The grid lives in the Diagnostics section: open it (read on mount, or picked up by an open sheet).
            try { sessionStorage.setItem('settings-open', 'diagnostics'); } catch {}
            window.dispatchEvent(new CustomEvent('settings-open-section', { detail: 'diagnostics' }));
            setShowSettings(true);
            // The panel only exists once the sheet has mounted — give its slide-up transition (0.42s) time to settle first.
            setTimeout(() => {
                document.getElementById('daily-close-check-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }, 380);
        }, []);

        // Purge & rebuild — the all-in-one pipeline behind Settings → Data → "Purge & Rebuild Prices":
        //   1. clearCache('prices'): wipes the IDB price store, FX series, and live quote/session state
        //      (same as Settings → Clear Cache → "prices" mode).
        //   2. pricesRef.current = {} — deterministic reset. The ref is normally synced by a useEffect AFTER re-render,
        //      so without this, fetchAllPrices (which seeds its merge from pricesRef.current and short-circuits tickers
        //      with a recent lastPoint) could silently merge the just-purged stale series straight back in.
        //   3. fetchAllPrices(): full historical re-pull from inception for every ticker (HL + comp + custody + FX
        //      + ^GSPC benchmark).
        //   4. fetchLivePrices(): fresh intraday quotes on top.
        const purgeAndRebuildPrices = async () => {
            await clearCache('prices');
            pricesRef.current = {};
            await fetchAllPrices();
            fetchLivePrices();
        };

        // Build dynamic Holdings instruments from active portfolio + restricted plans.
        // Kept separate from refreshMarketOverview so it updates when holdings change.
        const holdingMarketInstruments = React.useMemo(function() {
            return buildHoldingMarketInstruments(activeHoldingsWithDelta, compConfigs);
        }, [activeHoldingsWithDelta, compConfigs]);

        const marketOverviewInstruments = React.useMemo(function() {
            return BASE_MARKET_OVERVIEW_INSTRUMENTS.concat(holdingMarketInstruments);
        }, [holdingMarketInstruments]);

        // Keep the ref current so refreshMarketOverview (stable [] deps) can read latest instruments.
        React.useEffect(function() {
            marketOverviewInstrumentsRef.current = marketOverviewInstruments;
        }, [marketOverviewInstruments]);

        // Refresh market overview data — safe to call multiple times; guards against overlap.
        // opts.silent = true  → keep current status text while fetching (background refresh).
        // opts.silent = false → show 'fetching' status immediately (first load / manual).
        // opts.forceHistory   → bypass MARKET_HISTORY_CACHE (manual Refresh only).
        // All deps are refs or module-scope functions so the callback is stable (deps = []).
        const refreshMarketOverview = React.useCallback(async function(opts) {
            opts = opts || {};
            var silent       = !!opts.silent;
            var forceHistory = !!opts.forceHistory;
            if (marketCacheRef.current._fetching) return;
            marketCacheRef.current._fetching = true;
            // Show spinner only on explicit (non-silent) refresh, or on first load (no rows yet).
            if (!silent || !marketCacheRef.current.rows) {
                setMarketStatus('fetching');
            }
            // Abort any previous in-flight fetch
            if (marketAbortRef.current) {
                try { marketAbortRef.current.abort(); } catch(e) {}
            }
            var ac = (typeof AbortController !== 'undefined') ? new AbortController() : null;
            marketAbortRef.current = ac;
            try {
                var result = await fetchMarketOverviewData({
                    signal: ac ? ac.signal : null,
                    forceHistory: forceHistory,
                    instruments: marketOverviewInstrumentsRef.current,
                });
                if (ac && ac.signal.aborted) { marketCacheRef.current._fetching = false; return; }
                // ── Annotate rows with observed-update detection ──────────────────
                // Compare newly fetched now-prices against the previous cycle's rows.
                // If a row's spot price changed, it gets observedUpdating=true which
                // overrides a Yahoo "delayed" feed label and forces chip = O.
                if (result.rows) {
                    var prevRowMap = {};
                    var prevRows = marketCacheRef.current.rows;
                    if (prevRows) {
                        prevRows.forEach(function(r) { prevRowMap[r.id] = r; });
                    }
                    var nowMs = Date.now();
                    result.rows = result.rows.map(function(row) {
                        var prev = prevRowMap[row.id];
                        var obsNow = mktDidNowUpdate(prev, row);
                        var prevLastObs = prev && prev.lastObservedUpdateAt;
                        // Carry forward recent observed-update for up to 5 minutes
                        var recentObs = !obsNow && prevLastObs && (nowMs - prevLastObs) < 5 * 60000;
                        var observedUpdating = obsNow || !!recentObs;
                        var lastObservedUpdateAt = obsNow ? nowMs : (prevLastObs || null);
                        // Re-derive status with observedUpdating resolved
                        var liveFetchFailed = !!row.liveError;
                        var cachedRowUsable = liveFetchFailed && !!(row.m1 != null || row.ytd != null || row.y1 != null);
                        var quoteTs = row.quoteTsRaw ||
                            (row.quoteAgeMs != null ? (nowMs - row.quoteAgeMs) / 1000 : null);
                        var qs = mktDeriveQuoteStatus(
                            row.marketState, quoteTs, nowMs,
                            { id: row.id, type: row.type || '' },
                            observedUpdating, liveFetchFailed, cachedRowUsable
                        );
                        return Object.assign({}, row, {
                            observedUpdating:    observedUpdating,
                            lastObservedUpdateAt: lastObservedUpdateAt,
                            quoteStatusLabel:    qs.label,
                            quoteStatusKind:     qs.kind,
                            quoteStatusCompact:  qs.compact,
                            feedLabel:           qs.feed,
                            quoteAgeMs:          qs.quoteAgeMs != null ? qs.quoteAgeMs : row.quoteAgeMs,
                        });
                    });
                }
                marketCacheRef.current = { rows: result.rows, at: result.updatedAt, _fetching: false };
                setMarketRows(result.rows);
                setMarketAt(result.updatedAt);
                if (result.offline) {
                    setMarketStatus('offline'); setMarketError('Offline');
                } else if (!result.rows || result.okCount === 0) {
                    setMarketStatus('fail'); setMarketError((result.errors || []).slice(0, 2).join('; '));
                } else if (result.failCount > 0 || result.errorCount > 0) {
                    setMarketStatus('partial'); setMarketError(result.errorCount + ' market data issue(s)');
                } else {
                    setMarketStatus('ok'); setMarketError(null);
                }
                setMarketReady(!result.offline && !!result.rows && result.okCount > 0);
            } catch(e) {
                if (e && e.name === 'AbortError') { marketCacheRef.current._fetching = false; return; }
                marketCacheRef.current._fetching = false;
                setMarketStatus('fail');
                setMarketReady(false);
                setMarketError(e.message || 'fetch failed');
            }
        }, []); // stable — all deps are refs or module-scope

        // Auto-fetch when Markets screen opens; 15-second silent live-only refresh while open and on screen.
        React.useEffect(function() {
            if (!showMarketOverview) return;
            var STALE_MS = 15000;
            var now      = Date.now();
            var hasRows  = !!marketCacheRef.current.rows;
            var isStale  = (now - (marketCacheRef.current.at || 0)) > STALE_MS;
            if (!hasRows) {
                // First open — visible loading state, fetch history too.
                refreshMarketOverview({ silent: false, forceHistory: false });
            } else if (isStale) {
                // Stale live rows — silent refresh; history cache will be reused unless expired.
                refreshMarketOverview({ silent: true, forceHistory: false });
            }
            // 15-second interval: live data only (history served from cache). Skipped while the page is hidden,
            // and refreshMarketOverview's _fetching guard skips a tick while the previous refresh is still running.
            var timer = setInterval(function() {
                if (!document.hidden) refreshMarketOverview({ silent: true, forceHistory: false });
            }, STALE_MS);
            return function() { clearInterval(timer); };
        }, [showMarketOverview, refreshMarketOverview]);

        // ── Background prefetch ──────────────────────────────────────────────
        // Refresh Markets as the app opens (and when it returns to the foreground), whether
        // or not the screen is ever visited, so it is ready when tapped and the button's icon
        // can say so. It waits for the portfolio's own live-price pass to settle first, so the
        // two don't compete for the Worker and the Twelve Data credits; if that pass never
        // settles, a fallback timer starts the fetch anyway. refreshMarketOverview guards
        // against overlap, so opening Markets mid-fetch just shows its loading state.
        React.useEffect(function() {
            if (transactions.length === 0 || !isPageVisible) return;
            if (liveStatus === 'idle' || liveStatus === 'fetching') {
                var fb = setTimeout(function() {
                    var c = marketCacheRef.current;
                    if (!c.rows && !c._fetching) refreshMarketOverview({ silent: false, forceHistory: false });
                }, 45000);
                return function() { clearTimeout(fb); };
            }
            var cache = marketCacheRef.current;
            if (cache._fetching) return;
            if (cache.rows && (Date.now() - (cache.at || 0)) < MARKET_PREFETCH_STALE_MS) return;
            refreshMarketOverview({ silent: !!cache.rows, forceHistory: false });
        }, [transactions.length, isPageVisible, liveStatus, refreshMarketOverview]);

        // ─── Phase 2: Chart state ────────────────────────────────────────────────
        const [chartTimeframe, setChartTimeframe] = React.useState('3M');
        const [chartMode, setChartMode] = React.useState('twr'); // default to TWR %

        // ── Phase 2: Timeframe-sliced chart dataset ──────────────────────────────
        // Produces a filtered + rebased view of performanceChart for the selected window.
        // '1D' is special: constructed from live price deltas rather than the weekly series.
        // Hero Today P&L — uses todayPnlSnapshot as offline/sandbox fallback so the
        // hero card shows the correct session move even when liveStatus is 'fail'.
        // The sessionDate guard prevents a stale snapshot from being shown.
        const heroTodayPnl = React.useMemo(() => {
            if (masterPortfolio.todayAbsChange != null && Number.isFinite(masterPortfolio.todayAbsChange)) {
                return { abs: masterPortfolio.todayAbsChange, pct: masterPortfolio.todayPctChange };
            }
            if (!todayPnlSnapshot || !todayPnlSnapshot.sessionDate) return { abs: null, pct: null };
            const effDate = getEffectivePnlSessionDateStr(liveAt, getCurrentPnlSessionDateStr())
                || getCurrentPnlSessionDateStr();
            if (todayPnlSnapshot.sessionDate !== effDate) return { abs: null, pct: null };
            return { abs: todayPnlSnapshot.todayAbsChange, pct: todayPnlSnapshot.todayPctChange };
        }, [masterPortfolio, todayPnlSnapshot, liveAt]);

        // Today's move for the CHART: the ledger alone. The performance chart and TWR come from transactions, so a
        // custody holding (no transactions) must not move them; the hero above still shows the whole portfolio.
        const chartTodayPnl = React.useMemo(() => {
            const L = masterPortfolio.ledger;
            // The chart leaves gilts out (see perfLedger), so take the gilt sleeve out of today's figures too.
            if (L && L.todayAbsChange != null && Number.isFinite(L.todayAbsChange) && L.totalValue != null)
                return excludeGiltsFromToday({ abs: L.todayAbsChange, pct: L.todayPctChange, totalValue: L.totalValue }, excludedSleeve);
            const none = { abs: null, pct: null, totalValue: null };
            if (!todayPnlSnapshot || !todayPnlSnapshot.sessionDate) return none;
            const effDate = getEffectivePnlSessionDateStr(liveAt, getCurrentPnlSessionDateStr()) || getCurrentPnlSessionDateStr();
            if (todayPnlSnapshot.sessionDate !== effDate) return none;
            const sn = todayPnlSnapshot;   // snapshots from before custody joined the portfolio carry ledger-only figures already
            return excludeGiltsFromToday({ abs: sn.ledgerTodayAbsChange != null ? sn.ledgerTodayAbsChange : sn.todayAbsChange,
                     pct: sn.ledgerTodayPctChange !== undefined ? sn.ledgerTodayPctChange : sn.todayPctChange,
                     totalValue: sn.ledgerTotalValue != null ? sn.ledgerTotalValue : sn.totalValue }, excludedSleeve);
        }, [masterPortfolio, todayPnlSnapshot, liveAt, excludedSleeve]);

        // Latest raw SPX index level for the chart legend.
        // Read from resolvedPricesMap['^GSPC'] directly (last finite entry) rather than
        // from benchmarkTimeline, which uses priceAt() forward-filling and would return
        // a stale Thursday close for every weekend/holiday date.
        // ^GSPC is now included in fetchLivePrices so Friday's close arrives via Yahoo Finance.
        const latestSPXNative = React.useMemo(() => {
            const series = resolvedPricesMap[spxGbpSeries.ticker] || resolvedPricesMap['^GSPC'];
            if (!Array.isArray(series) || series.length === 0) return null;
            for (let i = series.length - 1; i >= 0; i--) {
                const c = Number(series[i]?.close);
                if (Number.isFinite(c) && c > 0) return c;
            }
            return null;
        }, [resolvedPricesMap, spxGbpSeries]);

        const chartData = React.useMemo(() => computeChartData({
                today,
                chartTimeframe,
                chartTodayPnl,
                performanceChart,
                liveAt,
                liveQuoteSessionDates }), [performanceChart, chartTimeframe, masterPortfolio, today, liveAt, livePrices, liveDailyCloses, liveQuoteSessionDates, todayPnlSnapshot, chartTodayPnl]);

        // Money-weighted view of the chart window: gain in pounds, XIRR (only for windows of a year or more), and what the
        // same start value and deposits would be worth in the S&P 500 (in GBP).
        const moneyStats = React.useMemo(() => {
            if (!chartData || chartData.length < 2) return null;
            const first = chartData[0], last = chartData[chartData.length - 1];
            const sv = Number(first.rawValue), ev = Number(last.rawValue);
            if (!(sv >= 0) || !(ev >= 0)) return null;
            const flows = externalFlowsFromLedger(perfLedger).filter(f => f.date > first.date && f.date <= last.date);
            const moneyIn = flows.reduce((a, f) => a + f.amount, 0);
            const days = (Date.parse(last.date) - Date.parse(first.date)) / 86400000;
            const T = d => Date.parse(d + 'T12:00:00Z');
            const xirr = days >= 365 ? xirrAnnual([{ t: T(first.date), amount: -sv }, ...flows.map(f => ({ t: T(f.date), amount: -f.amount })), { t: T(last.date), amount: ev }]) : null;
            const spx = spxGbpSeries && spxGbpSeries.rows.length ? sameDepositsInSpx(first.date, sv, last.date, flows, spxGbpSeries.rows) : null;
            return { startDate: first.date, endDate: last.date, days, startValue: sv, endValue: ev, moneyIn, gain: ev - sv - moneyIn, xirr, spx: spx ? { value: spx.value } : null,
                     excludedNote: !!(perfLedger.__excluded && perfLedger.__excluded.rows > 0) };
        }, [chartData, perfLedger, spxGbpSeries]);


        // Sheet holdings — filtered and sorted contextual list
        const sheetHoldings = React.useMemo(() => computeSheetHoldings({
                activeHoldingsWithDelta,
                sheetContext,
                sheetSearch,
                sheetSort,
                masterPortfolio,
                tickerCurrencyMap }), [activeHoldingsWithDelta, sheetContext, sheetSearch, sheetSort, masterPortfolio, tickerCurrencyMap]);

        // ── Restricted display rows for All Holdings sheet (display-only) ──────
        // Groups RSU/SIP by institution, keeps OPTIONs separate.
        // GUARDRAIL: these rows are NEVER fed into masterPortfolio, TWR, or attribution.
        const restrictedDisplayRows = React.useMemo(() => {
            // Delegate to the CANONICAL helper shared (formula-for-formula) with
            // RestrictedSchemesWidget, so the All Holdings sheet always shows the
            // exact same market value, daily P&L, and total P&L as the hero.
            return computeRestrictedDisplayRows({
                currentCompState, livePrices, tickerCurrencyMap,
                gbpusdRate, prices, liveStatus, liveAt, liveDailyCloses,
                liveQuoteSessionDates, latestSession,
            });
        }, [currentCompState, livePrices, liveDailyCloses, liveQuoteSessionDates, tickerCurrencyMap, gbpusdRate, prices, liveStatus, liveAt, latestSession]);

        // ── Hero: one total, restricted capital included ────────────────────────
        // Value = portfolio + restricted capital + modelled vested comp (the old "Total Wealth" line).
        // Today = the portfolio's Today + the HSBC (R) / Citi (R) moves, % against the previous total (the same
        //         convention as the portfolio's own Today: value minus today's move).
        // Total = the portfolio's gain + the restricted card's Total (value less grant / purchase basis), % against the
        //         portfolio's net cost + that basis. When the restricted Total is unknown ("—" on the card) it is left out.
        const heroCombined = React.useMemo(() => {
            const cs = currentCompState || {};
            const value = (masterPortfolio.totalValue || 0) + (cs.currentLiquidComp || 0) + (cs.currentRestrictedComp || 0);
            let rAbs = 0, rKnown = 0;
            for (const p of restrictedPositions) if (p.todayAbsChange != null) { rAbs += p.todayAbsChange; rKnown++; }
            const todayAbs = (heroTodayPnl.abs == null && rKnown === 0) ? null : (heroTodayPnl.abs || 0) + rAbs;
            const prevTotal = todayAbs != null ? value - todayAbs : null;
            const todayPct = todayAbs != null && prevTotal > 0 ? todayAbs / prevTotal : null;
            let totalAbs = masterPortfolio.unrealisedPL, basis = masterPortfolio.netCost || 0;
            const rPnl = cs.currentRestrictedPerformancePnL;
            if (rPnl != null && Number.isFinite(rPnl) && cs.currentRestrictedPerformanceBasis > 0) {
                totalAbs = (totalAbs || 0) + rPnl;
                basis += cs.currentRestrictedPerformanceBasis;
            }
            const totalPct = totalAbs != null && basis > 0 ? totalAbs / basis : null;
            return { value, todayAbs, todayPct, totalAbs, totalPct };
        }, [masterPortfolio, currentCompState, restrictedPositions, heroTodayPnl]);

        // Live values the Balances update form can prefill from: each account card, then each restricted scheme.
        const balancesAppValues = React.useMemo(() => {
            const out = [];
            // ready: every holding has a price, so the total is safe for Estate to save as a live balance.
            accountGroups.forEach(a => { if (Number.isFinite(a.totalValue)) out.push({ key: 'acct:' + a.name, label: a.name, value: a.totalValue,
                                                                                      ready: (a.holdings || []).every(h => h.marketValue != null) }); });
            (restrictedDisplayRows || []).forEach(r => {
                const v = r.marketValue != null ? r.marketValue : r.value;
                // Keyed by employer and scheme: two employers can each have an "Unvested" row. legacyKey keeps older links.
                if (r.name && Number.isFinite(v)) out.push({ key: 'restricted:' + (r.ticker || '') + ':' + r.name, legacyKey: 'restricted:' + r.name,
                                                             label: (r.ticker ? r.ticker + ' ' : '') + r.name, value: v });
            });
            return out;
        }, [accountGroups, restrictedDisplayRows]);
        // Estate accounts linked to an account here follow its value: each change is written into this month's entry.
        React.useEffect(() => {
            if (window.BalancesStore && window.BalancesStore.syncLinked) window.BalancesStore.syncLinked(balancesAppValues);
        }, [balancesAppValues]);

        // Cloud backup (see runCloudBackup): shortly after the app opens or comes back to the screen, after the ledger or
        // Estate changes, and every 30 minutes while open. Each run sends only when the data changed (or daily), and at
        // most every 10 minutes; a change held back is sent when the gap is up.
        const exportJsonRef = React.useRef(exportPricesJson);
        exportJsonRef.current = exportPricesJson;
        const cloudBackupNow = React.useCallback(function (force) {
            if (!cloudBackupReady()) return Promise.resolve({ skipped: 'not set up' });
            return Promise.resolve(exportJsonRef.current(function (json) { return runCloudBackup(json, force); }))
                .then(r => r || { skipped: 'nothing to back up' });
        }, []);
        const cloudScheduleRef = React.useRef(() => {});
        React.useEffect(() => {
            let timer = null, busy = false;
            const run = () => {
                if (busy || document.visibilityState !== 'visible') return;
                busy = true;
                cloudBackupNow(false).then(r => { if (r && r.retryIn) schedule(r.retryIn + 1000); })
                    .catch(e => console.warn('Cloud backup failed:', e)).finally(() => { busy = false; });
            };
            const schedule = ms => { clearTimeout(timer); timer = setTimeout(run, ms); };
            cloudScheduleRef.current = schedule;
            schedule(20000);   // give the first price refresh a moment
            const onVis = () => { if (document.visibilityState === 'visible') schedule(20000); };
            document.addEventListener('visibilitychange', onVis);
            // Only when the Estate accounts or balances change: the backup itself saves lastExportAt, and reacting to that
            // ran a backup every few seconds while the app was open.
            let seen = window.BalancesStore && window.BalancesStore.get ? window.BalancesStore.get() : null;
            const unsub = window.BalancesStore && window.BalancesStore.subscribe ? window.BalancesStore.subscribe(() => {
                const now = window.BalancesStore.get();
                if (seen && now.accounts === seen.accounts && now.snapshots === seen.snapshots) return;
                seen = now;
                schedule(5000);
            }) : null;
            // And when a bill is added, changed or deleted on the Cash Flow tab.
            const unsubBills = window.LifeAdminStore ? window.LifeAdminStore.subscribe(() => schedule(5000)) : null;
            // And when a year of pay is added, changed or deleted (Cash Flow → Pay).
            const unsubPay = window.PayStore ? window.PayStore.subscribe(() => schedule(5000)) : null;
            const iv = setInterval(() => schedule(1000), 30 * 60 * 1000);
            return () => { clearTimeout(timer); clearInterval(iv); document.removeEventListener('visibilitychange', onVis); if (unsub) unsub(); if (unsubBills) unsubBills(); if (unsubPay) unsubPay(); };
        }, [cloudBackupNow]);
        React.useEffect(() => { cloudScheduleRef.current(5000); }, [transactions, compConfigs, externalHoldings]);
        // Settings → Cloud Backup → Restore: the decrypted backup goes through the same check and confirm as a file restore.
        const cloudRestore = React.useCallback(function (day) {
            return fetchCloudBackup(day).then(text => { handlePricesJsonRef.current({ name: 'cloud backup', text: () => Promise.resolve(text) }); });
        }, []);

        // ─── RENDER ───────────────────────────────────────────────────────────
        // Spec §II.2: native iOS typography engine for all financial data and labels.
        // All display constants (C, sys, mono, serif, fmtV, fmtA, fmtP, signColor) are now global.
        const sans = sys;


        // ─── Metric hierarchy block (used in Hero, Account cards, Holdings rows) ──
        // Shows: value | today £ | today % | total £ | total %
        // Spec §II.2: all financial numbers rendered with native system font + tabular-nums.

        // ─── Account Allocation Bar ────────────────────────────────────────────

        // ─── Hero Card ────────────────────────────────────────────────────────

        // ─── Account Card ─────────────────────────────────────────────────────

        // ─── Holdings Bottom Sheet ────────────────────────────────────────────
        // HoldingRow and BottomSheet are defined at global scope above PortfolioApp
        // so React sees a stable component identity across parent re-renders.
        // Passing state as explicit props keeps the API clear.

        // ─── Ticker Detail Modal (existing, unchanged) ───────────────────────

        // ─── Upload / Onboarding section ─────────────────────────────────────

        // ─── Phase 2: PortfolioChart ────────────────────────────────────────────
        // Spec §IV Phase 2: visual line chart canvas beneath the Hero banner card
        // with 1D/1W/1M/3M/YTD/1Y/ALL timeframe selectors and £/TWR% mode toggle.
        // Touch scrubbing shows a crosshair + value bubble at the nearest data point.

        // ─── Phase 3: InsightsPanel ─────────────────────────────────────────────
        // Spec §IV Phase 3: Insights Block — Core Weight, ΔP×U Cash Drivers, Velocity Margins.
        // Sits directly below the Account Stack. No navigation required — pure dashboard signal.

        // ─── Main Dashboard Render ────────────────────────────────────────────
        return React.createElement('div', {
            'data-swipe-tabs': '',
            style: {
                position: 'fixed', inset: 0, background: C.bg, overflow: 'hidden',
                WebkitTapHighlightColor: 'transparent', WebkitTouchCallout: 'none', userSelect: 'none',
                fontFamily: sans,
            }
        },

        // Global styles
        React.createElement('style', null, `
            /* Google Fonts removed — native -apple-system stack enforced per spec §II.2 */
            .font-mono { font-family: 'JetBrains Mono', monospace; }
            @keyframes pulse-dot { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
            .pulse-dot { animation: pulse-dot 2s ease-in-out infinite; }
            @keyframes spin { to { transform: rotate(360deg); } }
            .spinning { animation: spin 1s linear infinite; }
            @keyframes sheet-up { from { transform: translateY(100%); } to { transform: translateY(0); } }
            .sheet-up { animation: sheet-up 420ms cubic-bezier(0.22, 1, 0.36, 1); }
            .ios-scroll { overflow-y: auto; -webkit-overflow-scrolling: touch; scroll-behavior: smooth; overscroll-behavior-y: contain; }
            .safe-top { padding-top: max(env(safe-area-inset-top), 12px); }
            .safe-bottom { padding-bottom: max(env(safe-area-inset-bottom), 8px); }
            .ticker-sheet { border-radius: 20px 20px 0 0; animation: sheet-up 420ms cubic-bezier(0.22, 1, 0.36, 1); }
            .settings-sheet { border-radius: 20px 20px 0 0; animation: sheet-up 420ms cubic-bezier(0.22, 1, 0.36, 1); }
            .privacy-blur { filter: blur(6px); user-select: none; pointer-events: none; }
            button { cursor: pointer; }
            button:active { opacity: 0.82; transform: scale(0.97); transition: transform 80ms ease; }
            input:focus { outline: none; }
            .ios-tap-backdrop { cursor: pointer; }
        `),

        // ── Error overlay
        uploadError && React.createElement('div', {
            style: { position: 'fixed', top: 0, left: 0, right: 0, zIndex: 9999, paddingTop: 'max(env(safe-area-inset-top), 12px)', display: 'flex', justifyContent: 'center' }
        }, React.createElement('div', {
            style: { margin: '0 16px', maxWidth: 360, width: '100%', background: '#1a0a0a', border: '1px solid rgba(248,113,113,0.3)', borderRadius: 16, padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 12 }
        },
            React.createElement(AlertCircle, { style: { width: 16, height: 16, color: C.rose, flexShrink: 0 }, strokeWidth: 1.5 }),
            React.createElement('span', { style: { flex: 1, fontFamily: sys, fontSize: 12, color: '#fca5a5' } }, uploadError),
            React.createElement('button', { onClick: () => setUploadError(null), style: { color: '#e11d48', minHeight: 44, minWidth: 44, display: 'flex', alignItems: 'center', justifyContent: 'center' } },
                React.createElement(X, { style: { width: 14, height: 14 }, strokeWidth: 1.5 })
            )
        )),

        // ── Export fallback modal ──────────────────────────────────────────────────
        // Shown when the native share sheet is unavailable or blocked on iPhone.
        // Provides a full readonly textarea so the user can copy the JSON manually.
        exportModal && React.createElement('div', {
            style: {
                position: 'fixed', inset: 0, zIndex: 10000,
                background: 'rgba(0,0,0,0.82)',
                display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
                paddingBottom: 'max(env(safe-area-inset-bottom), 0px)',
            },
            onClick: function(e) { if (e.target === e.currentTarget) setExportModal(null); },
        },
            React.createElement('div', {
                style: {
                    background: C.surface, borderRadius: '20px 20px 0 0',
                    width: '100%', maxWidth: 500,
                    padding: '20px 20px 8px',
                    display: 'flex', flexDirection: 'column', gap: 12,
                    maxHeight: '85vh',
                }
            },
                // Header
                React.createElement('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' } },
                    React.createElement('span', { style: { fontFamily: sys, fontSize: 15, fontWeight: 700, color: C.text } },
                        'Save JSON Backup'),
                    React.createElement('button', {
                        onClick: function() { setExportModal(null); },
                        style: { color: C.zinc500, minHeight: 44, minWidth: 44, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'none', border: 'none' }
                    }, React.createElement(X, { style: { width: 18, height: 18 }, strokeWidth: 1.5 }))
                ),
                // Instructions
                React.createElement('p', {
                    style: { fontFamily: sys, fontSize: 13, color: C.zinc400, margin: 0, lineHeight: 1.5 }
                },
                    'iPhone blocked file saving. Copy the JSON below, paste it into Files or Notes, and save it as:'),
                React.createElement('code', {
                    style: { fontFamily: 'JetBrains Mono, monospace', fontSize: 11, color: C.amber, background: C.surfaceHigh, padding: '6px 10px', borderRadius: 8, wordBreak: 'break-all' }
                }, exportModal.filename),
                // JSON textarea
                React.createElement('textarea', {
                    readOnly: true,
                    value: exportModal.json,
                    style: {
                        flex: 1, minHeight: 180, fontFamily: 'JetBrains Mono, monospace', fontSize: 11,
                        color: C.zinc400, background: C.surfaceHigh, border: '1px solid ' + C.border,
                        borderRadius: 10, padding: 12, resize: 'none', overflowY: 'auto',
                        WebkitUserSelect: 'text', userSelect: 'text',
                    },
                    onFocus: function(e) { e.target.select(); },
                }),
                // Buttons
                React.createElement('div', { style: { display: 'flex', gap: 10, paddingBottom: 12 } },
                    React.createElement('button', {
                        onClick: function() {
                            if (navigator.clipboard && navigator.clipboard.writeText) {
                                navigator.clipboard.writeText(exportModal.json).then(function() {
                                    setUploadFeedback({
                                        added: 0, duplicates: 0, intraFileDupes: 0, existingDupes: 0,
                                        files: 1, extendedOldest: false, extendedNewest: false, ts: Date.now(),
                                        _exportMsg: 'Backup copied to clipboard — save manually as ' + exportModal.filename,
                                    });
                                    setExportModal(null);
                                }).catch(function() {
                                    setUploadError('Clipboard write failed — please select all text and copy manually.');
                                });
                            }
                        },
                        style: {
                            flex: 1, padding: '13px 0', borderRadius: 12, border: 'none',
                            background: C.amber, color: '#000', fontFamily: sys, fontSize: 14, fontWeight: 700,
                        }
                    }, 'Copy JSON'),
                    React.createElement('button', {
                        onClick: function() { setExportModal(null); },
                        style: {
                            flex: 1, padding: '13px 0', borderRadius: 12, border: '1px solid ' + C.border,
                            background: 'none', color: C.zinc400, fontFamily: sys, fontSize: 14, fontWeight: 600,
                        }
                    }, 'Close')
                )
            )
        ),

        // ── Upload feedback toast
        uploadFeedback && React.createElement('div', {
            style: { position: 'fixed', top: 0, left: 0, right: 0, zIndex: 9999, paddingTop: 'max(env(safe-area-inset-top), 12px)', display: 'flex', justifyContent: 'center' }
        }, React.createElement('div', {
            style: { margin: '0 16px', maxWidth: 360, width: '100%', background: C.surface, border: `1px solid ${uploadFeedback._exportMsg ? 'rgba(96,165,250,0.3)' : 'rgba(52,211,153,0.3)'}`, borderRadius: 16, padding: '12px 16px', display: 'flex', alignItems: 'flex-start', gap: 12 }
        },
            React.createElement('div', { style: { width: 8, height: 8, borderRadius: '50%', marginTop: 4, flexShrink: 0, background: uploadFeedback._exportMsg ? C.blue : uploadFeedback.added > 0 ? C.emerald : C.zinc500 } }),
            React.createElement('div', { style: { flex: 1, fontFamily: sys, fontSize: 12, color: C.text } },
                uploadFeedback._exportMsg || `${uploadFeedback.files} file · +${uploadFeedback.added} transactions`
            ),
            React.createElement('button', { onClick: () => setUploadFeedback(null), style: { color: C.zinc600, minHeight: 44, minWidth: 44, display: 'flex', alignItems: 'center', justifyContent: 'center' } },
                React.createElement(X, { style: { width: 14, height: 14 }, strokeWidth: 1.5 })
            )
        )),

        // ── JSON import confirm dialog
        jsonImportPending && React.createElement('div', {
            style: { position: 'fixed', inset: 0, zIndex: 9998, display: 'flex', alignItems: 'flex-end', justifyContent: 'center', background: 'rgba(0,0,0,0.7)' }
        }, React.createElement('div', {
            style: { width: '100%', maxWidth: 440, margin: '0 16px 16px', borderRadius: 24, border: '1px solid rgba(96,165,250,0.3)', padding: 24, background: C.surface }
        },
            React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 } },
                React.createElement('div', { style: { width: 8, height: 8, borderRadius: '50%', background: jsonImportPending.summary.isFullSnapshot ? C.amber : C.blue } }),
                React.createElement('span', { style: { fontFamily: serif, fontSize: 18, color: C.white, fontWeight: 500 } }, jsonImportPending.summary.isFullSnapshot ? 'Confirm Full System Restore' : 'Restore from JSON backup')
            ),
            React.createElement('div', { style: { fontFamily: sys, fontSize: 13, color: C.zinc400, marginBottom: 16, lineHeight: 1.8 } },
                jsonImportPending.summary.txCount !== null && React.createElement('div', null,
                    React.createElement('span', { style: { color: C.zinc500 } }, 'Trades: '),
                    React.createElement('span', { style: { color: C.amber } }, `${jsonImportPending.summary.txCount} transactions`)),
                React.createElement('div', null,
                    React.createElement('span', { style: { color: C.zinc500 } }, 'Prices: '),
                    React.createElement('span', { style: { color: C.emerald } }, `${jsonImportPending.summary.tickers} tickers`)),
                jsonImportPending.summary.giltTickers > 0 && React.createElement('div', null,
                    React.createElement('span', { style: { color: C.zinc500 } }, 'Gilt closes: '),
                    React.createElement('span', { style: { color: C.emerald } }, `${jsonImportPending.summary.giltTickers} gilts \u00b7 ${jsonImportPending.summary.giltSessions} closes${jsonImportPending.summary.giltRejected > 0 ? ' (' + jsonImportPending.summary.giltRejected + ' invalid skipped)' : ''}`)),
                jsonImportPending.summary.equityPlans > 0 && React.createElement('div', null,
                    React.createElement('span', { style: { color: C.zinc500 } }, 'Equity plans: '),
                    React.createElement('span', { style: { color: C.violet } }, `${jsonImportPending.summary.equityPlans} plans`)),
                jsonImportPending.summary.estate && React.createElement('div', null,
                    React.createElement('span', { style: { color: C.zinc500 } }, 'Estate: '),
                    React.createElement('span', { style: { color: C.violet } }, `${jsonImportPending.summary.estate.accounts} accounts \u00b7 ${jsonImportPending.summary.estate.entries} entries` +
                        (jsonImportPending.summary.estate.latest ? ` \u00b7 latest ${new Date(jsonImportPending.summary.estate.latest + 'T12:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}` : ''))),
                jsonImportPending.summary.lifeAdmin && React.createElement('div', null,
                    React.createElement('span', { style: { color: C.zinc500 } }, 'Cash Flow: '),
                    React.createElement('span', { style: { color: C.violet } }, `${jsonImportPending.summary.lifeAdmin.bills} bills`)),
                jsonImportPending.summary.pay && React.createElement('div', null,
                    React.createElement('span', { style: { color: C.zinc500 } }, 'Pay: '),
                    React.createElement('span', { style: { color: C.violet } }, `${jsonImportPending.summary.pay.years} years`)),
                jsonImportPending.summary.custodyPositions > 0 && React.createElement('div', null,
                    React.createElement('span', { style: { color: C.zinc500 } }, 'Custody: '),
                    React.createElement('span', { style: { color: C.blue } }, `${jsonImportPending.summary.custodyPositions} positions`)),
                jsonImportPending.summary.hasPnlSnapshot && React.createElement('div', null,
                    React.createElement('span', { style: { color: C.zinc500 } }, 'P&L snapshot: '),
                    React.createElement('span', { style: { color: C.emerald } }, "✓ today's session frozen")),
                jsonImportPending.pnlSessionDate && React.createElement('div', null,
                    React.createElement('span', { style: { color: C.zinc500 } }, 'Session date: '),
                    React.createElement('span', { style: { color: C.zinc300 } }, jsonImportPending.pnlSessionDate)),
                React.createElement('div', null,
                    React.createElement('span', { style: { color: C.zinc500 } }, 'Exported: '),
                    React.createElement('span', { style: { color: C.zinc300 } }, `${jsonImportPending.summary.exportedAt}${jsonImportPending.summary.ageStr ? ' (' + jsonImportPending.summary.ageStr + ')' : ''}`)),
                React.createElement('div', null,
                    React.createElement('span', { style: { color: C.zinc500 } }, 'Integrity: '),
                    React.createElement('span', { style: { color: jsonImportPending.summary.hasHash ? C.emerald : C.amber } },
                        jsonImportPending.summary.hasHash ? 'SHA-256 verified ✓' : 'v1 backup (no hash)'))
            ),
            // ── Import scope selector ──────────────────────────────────
            React.createElement('div', { style: { background: C.surfaceHigh, border: `1px solid ${C.border}`, borderRadius: 14, padding: '12px 14px', marginBottom: 20, display: 'flex', flexDirection: 'column', gap: 10 } },
                React.createElement('label', { style: { display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', fontFamily: sys, fontSize: 13, color: C.text } },
                    React.createElement('input', { type: 'radio', name: 'jsonImportMode', value: 'both', checked: jsonImportMode === 'both', onChange: () => setJsonImportMode('both'), style: { accentColor: C.amber } }),
                    React.createElement('div', null,
                        React.createElement('div', { style: { fontWeight: 600 } }, 'Import Everything'),
                        React.createElement('div', { style: { fontSize: 11, color: C.zinc500, marginTop: 1 } }, (() => {
                            var parts = ['trades', 'prices'];
                            if (jsonImportPending.summary.giltTickers > 0) parts.push('gilt closes');
                            if (jsonImportPending.summary.equityPlans > 0) parts.push('equity plans');
                            if (jsonImportPending.summary.custodyPositions > 0) parts.push('custody positions');
                            if (jsonImportPending.summary.estate) parts.push('Estate');
                            if (jsonImportPending.summary.lifeAdmin) parts.push('bills');
                            if (jsonImportPending.summary.pay) parts.push('pay');
                            return 'Full restore: ' + parts.join(', ');
                        })())
                    )
                ),
                jsonImportPending.summary.txCount !== null && React.createElement('label', { style: { display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', fontFamily: sys, fontSize: 13, color: C.text, borderTop: `1px solid ${C.border}`, paddingTop: 10 } },
                    React.createElement('input', { type: 'radio', name: 'jsonImportMode', value: 'tx', checked: jsonImportMode === 'tx', onChange: () => setJsonImportMode('tx'), style: { accentColor: C.amber } }),
                    React.createElement('div', null,
                        React.createElement('div', { style: { fontWeight: 600 } }, 'Transactions Only'),
                        React.createElement('div', { style: { fontSize: 11, color: C.zinc500, marginTop: 1 } }, `Restore just the ledger (${jsonImportPending.summary.txCount} trades)` + (jsonImportPending.summary.estate ? '. Estate stays as it is' : ''))
                    )
                ),
                React.createElement('label', { style: { display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', fontFamily: sys, fontSize: 13, color: C.text, borderTop: `1px solid ${C.border}`, paddingTop: 10 } },
                    React.createElement('input', { type: 'radio', name: 'jsonImportMode', value: 'prices', checked: jsonImportMode === 'prices', onChange: () => setJsonImportMode('prices'), style: { accentColor: C.amber } }),
                    React.createElement('div', null,
                        React.createElement('div', { style: { fontWeight: 600 } }, 'Historical Prices Only'),
                        React.createElement('div', { style: { fontSize: 11, color: C.zinc500, marginTop: 1 } }, (() => {
                            var desc = `Price curves (${jsonImportPending.summary.tickers} tickers)`;
                            if (jsonImportPending.summary.equityPlans > 0 || jsonImportPending.summary.custodyPositions > 0) {
                                var extras = [];
                                if (jsonImportPending.summary.equityPlans > 0) extras.push(`${jsonImportPending.summary.equityPlans} equity plans`);
                                if (jsonImportPending.summary.custodyPositions > 0) extras.push(`${jsonImportPending.summary.custodyPositions} custody positions`);
                                desc += ' + ' + extras.join(', ');
                            }
                            if (jsonImportPending.summary.estate) desc += '. Estate stays as it is';
                            return desc;
                        })())
                    )
                )
            ),
            React.createElement('div', { style: { display: 'flex', gap: 8 } },
                React.createElement('button', { onClick: confirmJsonImport, style: { flex: 1, minHeight: 44, borderRadius: 12, background: 'rgba(59,130,246,0.15)', border: '1px solid rgba(59,130,246,0.3)', color: C.blue, fontFamily: sys, fontSize: 14 } },
                    jsonImportMode === 'tx' ? 'Restore Trades' : jsonImportMode === 'prices' ? 'Restore Prices' : (jsonImportPending.summary.isFullSnapshot ? 'Confirm & Overwrite' : 'Restore')
                ),
                React.createElement('button', { onClick: () => { setJsonImportPending(null); setJsonImportMode('both'); }, style: { flex: 1, minHeight: 44, borderRadius: 12, background: 'rgba(39,39,42,0.6)', color: C.zinc400, fontFamily: sys, fontSize: 14, border: '1px solid transparent' } }, 'Cancel')
            )
        )),

        // ── Ticker detail modal
        React.createElement(TabBoundary, { name: 'Ticker detail', resetKey: selectedTicker, onClose: () => setSelectedTicker(null) },
            React.createElement(TickerModal, { selectedTicker, tickerDetail, privacyMode, setSelectedTicker, modalDragY, setModalDragY, modalDragStart })),

        // ── Holdings bottom sheet
        sheetContext && React.createElement(TabBoundary, { name: 'Holdings', resetKey: sheetContext, onClose: () => { setSheetContext(null); setSheetDragY(0); setSheetSearch(''); } },
            React.createElement(BottomSheet, {
            context: sheetContext,
            onDismiss: () => { setSheetContext(null); setSheetDragY(0); setSheetSearch(''); },
            sheetDragY, setSheetDragY, sheetDragStart,
            sheetHoldings, sheetSort, setSheetSort,
            sheetSearch, setSheetSearch,
            privacyMode, setSelectedTicker,
            totalValue: masterPortfolio.totalValue,
            restrictedDisplayRows,
        })),

        // ── Market Overview screen (read-only, does not feed portfolio valuation)
        showMarketOverview && React.createElement(TabBoundary, { name: 'Markets', screen: 'markets', resetKey: activeTab },
            React.createElement(MarketOverviewScreen, {
                rows:      marketRows,
                status:    marketStatus,
                updatedAt: marketAt,
                error:     marketError,
                onRefresh: function() { refreshMarketOverview({ silent: false, forceHistory: true }); },
            })),

        // ── Estate screen (balances.js). appValues lets investment and pension accounts prefill from the app.
        showBalances && React.createElement(TabBoundary, { name: 'Estate', screen: 'estate', resetKey: activeTab },
            React.createElement(window.BalancesScreen, {
                onClose:     () => setActiveTab('investments'),
                privacyMode,
                appValues:   balancesAppValues,
                ui:          { C, sys, rounded },
            })),

        // ── Cash Flow screen (lifeadmin.js): Pay (pay.js) and the bills.
        showLifeAdmin && React.createElement(TabBoundary, { name: 'Cash Flow', screen: 'lifeadmin', resetKey: activeTab },
            React.createElement(window.LifeAdminScreen, {
                onClose:     () => setActiveTab('investments'),
                privacyMode,
                ui:          { C, sys, rounded },
            })),

        // ── Settings sheet (MoreTab)
        showSettings && React.createElement('div', {
            // Above the Markets / Estate screens (9995) so it opens from the tab bar on any tab.
            style: { position: 'fixed', inset: 0, zIndex: 9996, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'flex-end' },
            className: 'ios-tap-backdrop',
            onClick: () => { setShowSettings(false); setSettingsDragY(0); },
        },
            React.createElement('div', {
                className: 'settings-sheet',
                style: { width: '100%', maxHeight: '92vh', background: C.surface, border: `1px solid ${C.borderMid}`, display: 'flex', flexDirection: 'column', transform: `translateY(${settingsDragY}px)`, transition: settingsDragY === 0 ? 'transform 0.42s cubic-bezier(0.22, 1, 0.36, 1)' : 'none', willChange: 'transform' },
                onClick: e => e.stopPropagation(),
            },
                // Drag handle — touch-active zone for swipe-to-dismiss
                React.createElement('div', {
                    style: { display: 'flex', justifyContent: 'center', padding: '12px 0 6px', touchAction: 'none', flexShrink: 0 },
                    onTouchStart: e => { settingsDragStart.current = { y: e.touches[0].clientY, time: Date.now() }; },
                    onTouchMove: e => { if (!settingsDragStart.current) return; const d = e.touches[0].clientY - settingsDragStart.current.y; if (d > 0) setSettingsDragY(d); },
                    onTouchEnd: e => {
                        if (!settingsDragStart.current) return;
                        const delta = (e.changedTouches[0]?.clientY ?? 0) - settingsDragStart.current.y;
                        const vel = delta / Math.max(1, Date.now() - settingsDragStart.current.time);
                        settingsDragStart.current = null;
                        if (delta > 80 || vel > 0.45) { setShowSettings(false); setSettingsDragY(0); } else setSettingsDragY(0);
                    },
                },
                    React.createElement('div', { style: { width: 40, height: 4, borderRadius: 9999, background: C.zinc700 } })
                ),
                // Header row with title + explicit close button
                React.createElement('div', {
                    style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingTop: 'calc(env(safe-area-inset-top) + 14px)', paddingBottom: '14px', paddingLeft: '16px', paddingRight: '16px', flexShrink: 0, borderBottom: `1px solid ${C.border}` }
                },
                    React.createElement('div', { style: { fontFamily: sys, fontSize: 17, fontWeight: 600, color: C.white } }, 'More'),
                    React.createElement('button', {
                        onClick: () => { setShowSettings(false); setSettingsDragY(0); },
                        style: { minHeight: 44, minWidth: 44, display: 'flex', alignItems: 'center', justifyContent: 'center', color: C.zinc500, background: C.surfaceHigh, border: `1px solid ${C.border}`, borderRadius: 10 }
                    }, React.createElement(X, { style: { width: 16, height: 16 }, strokeWidth: 2 }))
                ),
                React.createElement('div', { className: 'ios-scroll', style: { flex: 1, paddingBottom: 'max(env(safe-area-inset-bottom), 20px)' } },
                    React.createElement(TabBoundary, { name: 'Settings', resetKey: showSettings, pad: '16px 20px',
                        extra: React.createElement(SettingsRecovery, { backupNow: cloudBackupNow, restore: cloudRestore }) },
                    React.createElement(MoreTab, {
                        transactions, prices, loadStatus, loadSource, fetchDebug,
                        cacheMeta, activeHoldings: activeHoldingsWithDelta, tickersUsed, livePrices, liveAt, liveStatus,
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
                        // Settings → Estate → Import: close the sheet and open the Import view on the Estate tab.
                        cloudBackupNow, cloudRestore,
                        onEstateImport: hasBalances ? () => { setShowSettings(false); setSettingsDragY(0); setActiveTab('estate'); window.BalancesStore.openView('import'); } : null,
                    }))
                )
            )
        ),

        // ── Main scroll view
        React.createElement('div', {
            className: 'ios-scroll',
            style: { position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column' }
        },
            // ── Tab bar — stays at the top on every tab, like browser tabs: Markets / Investments / Estate, then
            // privacy and settings. Sticky over the Investments scroll; the Markets and Estate screens open below it.
            React.createElement('div', {
                ref: topBarRef,
                className: 'safe-top',
                style: { position: 'sticky', top: 0, zIndex: 60, background: C.surface, borderBottom: '1px solid ' + C.border,
                         paddingLeft: 12, paddingRight: 14, display: 'flex', alignItems: 'flex-end', gap: 6, flexShrink: 0 }
            },
                // The tabs scroll sideways when they don't all fit (Fergus asked, when Pay made five); the edge that hides
                // more tabs fades out. The bar sits 1px over the border below so the open tab joins its screen.
                React.createElement('div', { role: 'tablist', ref: tabListRef, className: 'tab-scroll', onScroll: updateTabFade,
                    style: { position: 'relative', display: 'flex', alignItems: 'flex-end', gap: 2, minWidth: 0, flex: '1 1 auto', marginBottom: -1,
                             overflowX: 'auto', overflowY: 'hidden', overscrollBehaviorX: 'contain', WebkitOverflowScrolling: 'touch',
                             WebkitMaskImage: tabFadeMask, maskImage: tabFadeMask } },
                    [
                        { id: 'markets', label: 'Markets', color: C.blue,
                          icon: React.createElement(Activity, {
                              // The icon turns green (with a settled glow) once Markets data is ready to view.
                              className: marketReady ? 'mkt-ready-icon' : '',
                              style: { width: 13, height: 13, flexShrink: 0, color: marketReady ? C.emerald : 'currentColor',
                                       filter: marketReady ? 'drop-shadow(0 0 2px rgba(52,211,153,0.9)) drop-shadow(0 0 6px rgba(52,211,153,0.5))' : 'none',
                                       transition: 'color 0.5s ease, filter 0.5s ease' },
                              strokeWidth: 2 }) },
                        { id: 'investments', label: 'Investments', color: C.amber,
                          icon: React.createElement(TrendingUp, { style: { width: 13, height: 13, flexShrink: 0 }, strokeWidth: 2 }) },
                        hasBalances && { id: 'estate', label: 'Estate', color: C.violet,
                          icon: window.BalancesIcon ? React.createElement(window.BalancesIcon, { style: { width: 13, height: 13, flexShrink: 0 }, strokeWidth: 2 }) : null },
                        hasLifeAdmin && { id: 'lifeadmin', label: 'Cash Flow', color: window.LifeAdminColor || C.emerald,
                          icon: window.LifeAdminIcon ? React.createElement(window.LifeAdminIcon, { style: { width: 13, height: 13, flexShrink: 0 }, strokeWidth: 2 }) : null },
                    ].filter(Boolean).map(t => {
                        const on = activeTab === t.id;
                        return React.createElement('button', {
                            key: t.id, role: 'tab', 'aria-selected': on, 'aria-label': t.label, 'data-tab-id': t.id,
                            onClick: () => tapTab(t.id),
                            style: {
                                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5, flex: '0 0 auto',
                                height: 36, padding: '0 9px',
                                // The active tab takes the page colour and drops its bottom edge, so it joins the screen below.
                                background: on ? C.bg : 'transparent',
                                border: '1px solid ' + (on ? C.border : 'transparent'), borderBottomColor: on ? C.bg : 'transparent',
                                borderRadius: '10px 10px 0 0',
                                color: on ? t.color : C.zinc600, fontFamily: sys, fontSize: 12.5, fontWeight: on ? 650 : 500,
                                letterSpacing: '0.01em', whiteSpace: 'nowrap', overflow: 'hidden',
                            }
                        }, t.icon, React.createElement('span', null, t.label));
                    })
                ),
                React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 0, flexShrink: 0, marginRight: -7, height: 36 } },
                    // (The live-price refresh and the purge-and-rebuild buttons live in Settings → Data.)
                    // Privacy toggle
                    React.createElement('button', {
                        onClick: togglePrivacy, 'aria-label': 'Privacy',
                        style: { color: privacyMode ? C.amber : C.zinc600, background: 'transparent', border: 'none', width: 32, height: 34, padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }
                    }, React.createElement(privacyMode ? EyeOff : Eye, { style: { width: 18, height: 18 }, strokeWidth: 1.5 })),
                    // Settings
                    React.createElement('button', {
                        onClick: () => setShowSettings(true), 'aria-label': 'Settings',
                        style: { color: C.zinc600, background: 'transparent', border: 'none', width: 32, height: 34, padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }
                    }, React.createElement(Settings, { style: { width: 18, height: 18 }, strokeWidth: 1.5 }))
                )
            ),

            // Scrollable content
            React.createElement('div', {
                className: 'ios-scroll', 'data-tab-screen': 'investments',
                style: { flex: 1, padding: '12px 16px 32px' }
            },
              React.createElement(TabBoundary, { name: 'Investments', resetKey: activeTab },
                // Price feed health: first, above every other alert (Fergus: alerts go at the very top)
                React.createElement(FeedBanner, { strip: feedStrip }),
                // Stale data: the cloud backup, and the trades CSV the holdings come from
                React.createElement(FeedBanner, { kind: 'backup', strip: backupBanner(loadCloudBackupState(), !!(getCloudBackupToken() && getCloudBackupPass()), Date.now()) }),
                React.createElement(FeedBanner, { kind: 'trades', strip: tradesBanner(enriched, Date.now()) }),
                // Maturity alerts (amber, then red near the date)
                maturityAlerts && React.createElement(window.MaturityAlerts.Banner, { source: maturityAlerts, privacy: privacyMode }),
                // Hero Card
                React.createElement('div', { style: { marginBottom: 12 } },
                    React.createElement(HeroCard, {
                        onTap: () => { if (transactions.length > 0) { setSheetContext('all'); setSheetSearch(''); } },
                        transactions, masterPortfolio, sheetContext, liveStatus, privacyMode,
                        heroValue: heroCombined.value,
                        heroTodayAbs: heroCombined.todayAbs,
                        heroTodayPct: heroCombined.todayPct,
                        heroTotalAbs: heroCombined.totalAbs,
                        heroTotalPct: heroCombined.totalPct,
                        pricingBadge, onPricingTap: openDailyCheck,
                    })
                ),

                // ── Stage 1.4: Alert banner — above chart, prominent position ──
                React.createElement(ActionAlertBanner, { currentCompState }),

                // ── Phase 2: Performance Chart ───────────────────────────────
                transactions.length > 0 && React.createElement('div', {
                    style: {
                        background: `linear-gradient(180deg, ${C.surfaceHigh} 0%, ${C.surface} 100%)`,
                        border: `1px solid ${C.border}`, borderRadius: 20,
                        padding: '16px 18px 12px', marginBottom: 12,
                    }
                },
                    React.createElement(PortfolioChart, {
                        data: chartData, privacyMode,
                        timeframe: chartTimeframe,
                        setTimeframe: setChartTimeframe,
                        mode: chartMode,
                        setMode: setChartMode,
                        spxLatestPrice: latestSPXNative,
                        spxSessionDate: liveQuoteSessionDates && liveQuoteSessionDates['^GSPC'],
                        contribFn: contribForRange,
                    })
                ),

                // ── Phase 3: Insights Panel (before accounts) ───────────────
                transactions.length > 0 && insightsData && React.createElement(InsightsPanel, { data: insightsData, privacyMode, lastSpotRefreshAt }),

                // ── Phase 4: Account Cards Stack ────────────────────────────
                transactions.length > 0 && accountGroups.length > 0 && React.createElement('div', {
                    style: { display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12, marginBottom: 16 }
                },
                    accountGroups.map(acct =>
                        React.createElement(AccountCard, {
                            key: acct.name,
                            acct,
                            privacyMode,
                            isActive: sheetContext === acct.name,
                            onTap: () => { setSheetContext(acct.name); setSheetSearch(''); }
                        })
                    )
                ),

                // ── Stage 1.4: Restricted Schemes card — below account grid ─
                React.createElement(RestrictedSchemesWidget, {
                    currentCompState,
                    privacyMode,
                    livePrices,
                    tickerCurrencyMap,
                    gbpusdRate,
                    prices,
                    liveStatus,
                    liveAt,
                    liveDailyCloses,
                    liveQuoteSessionDates,
                    liveQuoteChecks,
                    latestSession,
                }),

                // Upload / data management — hidden once data is loaded
                transactions.length === 0 && React.createElement('div', { style: { marginBottom: 16 } },
                    React.createElement(UploadSection, { transactions, cacheMeta, tickersUsed, loading, handleFiles, fetchAllPrices, fetchLivePrices, liveStatus, clearCache })
                ),

                // Diagnostics strip (if loading errors)
                Object.values(loadStatus).some(s => s === 'fail') && React.createElement('div', {
                    style: { background: 'rgba(248,113,133,0.08)', border: '1px solid rgba(248,113,133,0.2)', borderRadius: 12, padding: '10px 14px', marginBottom: 16 }
                },
                    React.createElement('div', { style: { fontFamily: sys, fontSize: 11, color: C.rose } },
                        `⚠ ${Object.values(loadStatus).filter(s => s === 'fail').length} price source(s) failed — open Settings to retry`
                    )
                )
              )
            )
        )
        ); // end main return


    // MoreTab component — Stage 2 full implementation
    // All analytics read from props; no engine code inside.
    // ─────────────────────────────────────────────────────────────────────

}
