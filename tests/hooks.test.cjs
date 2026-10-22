// Hook inputs (docs/app.js): every useMemo and useCallback in PortfolioApp must list the state and calculated values it
// reads. A missing one leaves a figure stale until something else changes (three were found when the calculations moved
// out in PR 108). Setters, refs and plain helper functions are stable or harmless, so they may be left out. Effects are
// not checked: several run once on purpose.
// Needs acorn and acorn-walk: see the Tests workflow. Without them it is skipped locally, and fails in CI.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
let acorn = null, walk = null;
try { acorn = require('acorn'); walk = require('acorn-walk'); }
catch (e) { if (process.env.SMOKE_REQUIRED) throw e; }

// Names a pattern declares.
function names(p, out) {
    if (!p) return out;
    if (p.type === 'Identifier') out.push(p.name);
    else if (p.type === 'ObjectPattern') p.properties.forEach(x => names(x.value || x.argument, out));
    else if (p.type === 'ArrayPattern') p.elements.forEach(x => names(x, out));
    else if (p.type === 'RestElement') names(p.argument, out);
    else if (p.type === 'AssignmentPattern') names(p.left, out);
    return out;
}
const isHook = (src, call, re) => call && call.type === 'CallExpression' && re.test(src.slice(call.callee.start, call.callee.end));

// Identifiers a function reads from outside itself (simple scope walk: params, var/let/const/function/catch bindings).
function freeVars(fn) {
    const free = new Set();
    const declare = (node, set) => {
        walk.simple(node, {
            VariableDeclaration(d) { d.declarations.forEach(x => names(x.id, []).forEach(n => set.add(n))); },
            FunctionDeclaration(f) { set.add(f.id.name); },
            CatchClause(c) { names(c.param, []).forEach(n => set.add(n)); },
        });
    };
    const visit = (node, scope) => {
        if (!node || typeof node.type !== 'string') return;
        if (/Function/.test(node.type)) {
            const s = new Set(scope);
            node.params.forEach(p => names(p, []).forEach(n => s.add(n)));
            if (node.id) s.add(node.id.name);
            declare(node.body, s);
            node.params.forEach(p => visit(p.type === 'AssignmentPattern' ? p.right : null, s));
            return visit(node.body, s);
        }
        if (node.type === 'Identifier') { if (!scope.has(node.name)) free.add(node.name); return; }
        if (node.type === 'MemberExpression') { visit(node.object, scope); if (node.computed) visit(node.property, scope); return; }
        if (node.type === 'Property') { if (node.computed) visit(node.key, scope); visit(node.value, scope); return; }
        if (node.type === 'VariableDeclarator') { visit(node.init, scope); return; }
        if (node.type === 'LabeledStatement') return visit(node.body, scope);
        if (node.type === 'BreakStatement' || node.type === 'ContinueStatement') return;
        for (const k of Object.keys(node)) {
            if (k === 'type' || k === 'start' || k === 'end' || k === 'loc') continue;
            const v = node[k];
            if (Array.isArray(v)) v.forEach(x => x && visit(x, scope));
            else if (v && typeof v.type === 'string') visit(v, scope);
        }
    };
    visit(fn, new Set());
    return free;
}

test('PortfolioApp\'s memos and callbacks list the values they read', { skip: !acorn && 'acorn not installed' }, () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'docs', 'app.js'), 'utf8');
    const ast = acorn.parse(src, { ecmaVersion: 2022, locations: true });
    const app = ast.body.find(n => n.type === 'FunctionDeclaration' && n.id.name === 'PortfolioApp');
    // The values that change between renders: state, and what useMemo / useCallback return.
    const changing = new Set();
    walk.simple(app.body, {
        VariableDeclarator(d) {
            if (isHook(src, d.init, /^(React\.)?useState$/) && d.id.type === 'ArrayPattern' && d.id.elements[0]) changing.add(d.id.elements[0].name);
            else if (isHook(src, d.init, /^(React\.)?use(Memo|Callback)$/)) names(d.id, []).forEach(n => changing.add(n));
        },
    });
    const missing = [];
    walk.simple(app.body, {
        CallExpression(call) {
            if (!isHook(src, call, /^(React\.)?use(Memo|Callback)$/)) return;
            const [fn, deps] = call.arguments;
            if (!fn || !deps || deps.type !== 'ArrayExpression') return;
            // A listed member (masterPortfolio.totalValue) counts for its object.
            const listed = new Set(deps.elements.map(e => src.slice(e.start, e.end).split('.')[0]));
            const lacks = [...freeVars(fn)].filter(n => changing.has(n) && !listed.has(n));
            if (lacks.length) missing.push('line ' + call.loc.start.line + ': ' + lacks.join(', '));
        },
    });
    assert.deepEqual(missing, [], 'add these to the hook\'s dependency list');
});
