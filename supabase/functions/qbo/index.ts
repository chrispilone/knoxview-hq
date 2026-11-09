import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

// QuickBooks Online bridge for Knox View HQ (owner only).
// Holds the company's QuickBooks refresh token server-side, pulls the Profit & Loss and
// Balance Sheet reports, and turns them into the Finance tab's numbers.
// Secrets: QBO_CLIENT_ID, QBO_CLIENT_SECRET, optional QBO_ENV ('production' default, or 'sandbox').
const CLIENT_ID = (Deno.env.get('QBO_CLIENT_ID') ?? '').trim();
const CLIENT_SECRET = (Deno.env.get('QBO_CLIENT_SECRET') ?? '').trim();
const ENV = (Deno.env.get('QBO_ENV') ?? 'production').trim().toLowerCase() === 'sandbox' ? 'sandbox' : 'production';
const API = ENV === 'sandbox' ? 'https://sandbox-quickbooks.api.intuit.com' : 'https://quickbooks.api.intuit.com';
const AUTH_URL = 'https://appcenter.intuit.com/connect/oauth2';
const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const REVOKE_URL = 'https://developer.api.intuit.com/v2/oauth2/tokens/revoke';
const SCOPE = 'com.intuit.quickbooks.accounting';
const TZ = 'America/New_York';
const ALLOWED_ORIGINS = ['https://hq.knoxview.com', 'https://knoxview-hq.netlify.app'];
const REDIRECTS = ALLOWED_ORIGINS.map(o => o + '/');
const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });

function cors(req: Request) {
  const o = req.headers.get('origin') ?? '';
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(o) ? o : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  };
}
const json = (req: Request, body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors(req), 'Content-Type': 'application/json' } });

class NotConnected extends Error {}

/* ---------- OAuth ---------- */
async function tokenRequest(params: Record<string, string>) {
  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { Authorization: 'Basic ' + btoa(`${CLIENT_ID}:${CLIENT_SECRET}`), Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) {
    const tid = r.headers.get('intuit_tid') || '';
    console.error('QuickBooks sign-in error', JSON.stringify({ grant: params.grant_type, status: r.status, error: d.error ?? null, intuit_tid: tid }));
    const e = new Error((d.error_description || d.error || `QuickBooks sign-in error ${r.status}`) + (tid ? ` (Intuit ref ${tid})` : '')); (e as any).code = d.error; throw e;
  }
  return d;
}
const expiry = (secs: number | undefined, fallback: number) => new Date(Date.now() + (secs ?? fallback) * 1000).toISOString();

async function accessToken(force = false) {
  const { data: c } = await admin.from('qbo_connection').select('*').eq('id', 1).maybeSingle();
  if (!c) throw new NotConnected('QuickBooks is not connected');
  if (!force && c.access_token && c.access_expires_at && new Date(c.access_expires_at).getTime() > Date.now() + 60_000) return { token: c.access_token as string, realm: c.realm_id as string };
  try {
    const t = await tokenRequest({ grant_type: 'refresh_token', refresh_token: c.refresh_token });
    // Intuit rotates refresh tokens: always keep the newest one.
    await admin.from('qbo_connection').update({
      access_token: t.access_token, access_expires_at: expiry(t.expires_in, 3600),
      refresh_token: t.refresh_token || c.refresh_token, refresh_expires_at: expiry(t.x_refresh_token_expires_in, 8640000),
      updated_at: new Date().toISOString(),
    }).eq('id', 1);
    return { token: t.access_token as string, realm: c.realm_id as string };
  } catch (e) {
    if ((e as any).code === 'invalid_grant') { await admin.from('qbo_connection').delete().eq('id', 1); throw new NotConnected('QuickBooks sign-in expired. Please connect again.'); }
    throw e;
  }
}

async function qbo(path: string, params: Record<string, string> = {}, body?: unknown) {
  let { token, realm } = await accessToken();
  const url = `${API}/v3/company/${realm}/${path}?${new URLSearchParams({ minorversion: '75', ...params })}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await fetch(url, body === undefined
      ? { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } }
      : { method: 'POST', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (r.status === 401 && attempt === 0) { ({ token } = await accessToken(true)); continue; }
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      // intuit_tid identifies the request for Intuit support; keep it in the logs and the error text.
      const tid = r.headers.get('intuit_tid') || '';
      const f = d?.Fault?.Error?.[0] || d?.fault?.error?.[0];
      const msg = f ? `${f.Message || f.message}${f.Detail || f.detail ? ': ' + (f.Detail || f.detail) : ''}` : `QuickBooks error ${r.status}`;
      console.error('QuickBooks API error', JSON.stringify({ path, status: r.status, intuit_tid: tid, fault: f ?? null }));
      throw new Error(tid ? `${msg} (Intuit ref ${tid})` : msg);
    }
    return d;
  }
  throw new Error('QuickBooks rejected the sign-in');
}

/* ---------- Dates (Eastern time) ---------- */
function todayET() {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date()).map(x => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, iso: `${p.year}-${p.month}-${p.day}` };
}
const pad = (n: number) => String(n).padStart(2, '0');
const lastDayOf = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/* ---------- Report parsing ---------- */
const num = (v: unknown) => { const n = parseFloat(String(v ?? '').replace(/,/g, '')); return Number.isFinite(n) ? n : 0; };
const round2 = (n: number) => Math.round(n * 100) / 100;
type Row = any;

// Month columns of a "summarize by Month" report → [{ index, month: 'YYYY-MM' }]
function monthColumns(rep: any) {
  const cols = rep?.Columns?.Column || [];
  const out: { index: number; month: string }[] = [];
  cols.forEach((c: any, i: number) => {
    if (i === 0) return;
    const md = Object.fromEntries((c.MetaData || []).map((m: any) => [m.Name, m.Value]));
    if (String(md.ColKey || '').toLowerCase() === 'total' || /^total$/i.test(c.ColTitle || '')) return;
    if (md.StartDate) { out.push({ index: i, month: String(md.StartDate).slice(0, 7) }); return; }
    const t = Date.parse('1 ' + (c.ColTitle || ''));
    if (!Number.isNaN(t)) { const d = new Date(t); out.push({ index: i, month: `${d.getFullYear()}-${pad(d.getMonth() + 1)}` }); }
  });
  return out;
}
const topSections = (rep: any): Row[] => rep?.Rows?.Row || [];
const findGroup = (rows: Row[], group: string): Row | undefined => rows.find(r => r.group === group);
function findGroupDeep(rows: Row[], group: string): Row | undefined {
  for (const r of rows || []) {
    if (r.group === group) return r;
    const f = findGroupDeep(r.Rows?.Row || [], group); if (f) return f;
  }
}
const sectionVals = (sec: Row | undefined) => (sec?.Summary?.ColData || []).map((c: any) => num(c.value));
// Leaf account lines of a section: parent accounts are opened up so the real accounts show
// (a parent's own postings come through as a Data row inside its section).
function childLines(sec: Row | undefined): { name: string; vals: number[] }[] {
  const out: { name: string; vals: number[] }[] = [];
  for (const r of sec?.Rows?.Row || []) {
    if (r.type === 'Data' || r.ColData) out.push({ name: r.ColData?.[0]?.value || 'Other', vals: (r.ColData || []).map((c: any) => num(c.value)) });
    else if (r.Rows?.Row?.length) out.push(...childLines(r));
    else out.push({ name: r.Header?.ColData?.[0]?.value || 'Other', vals: sectionVals(r) });
  }
  return out;
}

function plByMonth(rep: any) {
  const months = monthColumns(rep);
  const rows = topSections(rep);
  const g = (name: string) => sectionVals(findGroup(rows, name));
  const income = g('Income'), cogs = g('COGS'), exp = g('Expenses'), oi = g('OtherIncome'), oe = g('OtherExpenses'), net = g('NetIncome');
  const series = months.map(({ index, month }) => {
    const revenue = income[index] || 0, c = cogs[index] || 0, e = exp[index] || 0, o = oe[index] || 0, other = oi[index] || 0;
    const n = net.length ? (net[index] || 0) : revenue + other - c - e - o;
    return { month, revenue: round2(revenue), otherIncome: round2(other), cogs: round2(c), operating: round2(e), otherExpenses: round2(o), expenses: round2(c + e + o), net: round2(n) };
  });
  return { months, series, rows, basis: rep?.Header?.ReportBasis || null };
}
const sumSeries = (s: any[]) => s.reduce((a, x) => ({ revenue: a.revenue + x.revenue, expenses: a.expenses + x.expenses, net: a.net + x.net }), { revenue: 0, expenses: 0, net: 0 });
const rounded = (t: { revenue: number; expenses: number; net: number }) => ({ revenue: round2(t.revenue), expenses: round2(t.expenses), net: round2(t.net) });

async function buildSnapshot() {
  const t = todayET();
  const ly = t.y - 1;
  const lyDay = Math.min(t.d, lastDayOf(ly, t.m));
  // Refresh the access token once before the parallel calls, so they don't race to rotate the refresh token.
  const { realm } = await accessToken();
  const [plNow, plLastYearToDate, bs, info] = await Promise.all([
    // Jan 1 last year → today, by month: trend, YTD, MTD, last month, expense categories
    qbo('reports/ProfitAndLoss', { start_date: `${ly}-01-01`, end_date: t.iso, summarize_column_by: 'Month' }),
    // Jan 1 last year → same day last year: for "vs last year" on YTD and MTD
    qbo('reports/ProfitAndLoss', { start_date: `${ly}-01-01`, end_date: `${ly}-${pad(t.m)}-${pad(lyDay)}`, summarize_column_by: 'Month' }),
    qbo('reports/BalanceSheet', { start_date: `${t.y}-01-01`, end_date: t.iso }),
    qbo('companyinfo/' + realm).catch(() => null),
  ]);

  const now = plByMonth(plNow);
  const prev = plByMonth(plLastYearToDate);
  const curKey = `${t.y}-${pad(t.m)}`;
  const lmY = t.m === 1 ? t.y - 1 : t.y, lmM = t.m === 1 ? 12 : t.m - 1;
  const lastKey = `${lmY}-${pad(lmM)}`;
  const thisYear = now.series.filter(s => s.month.startsWith(`${t.y}-`));
  const zero = { revenue: 0, expenses: 0, net: 0 };
  const pick = (s: any[], k: string) => { const x = s.find(v => v.month === k); return x ? { revenue: x.revenue, expenses: x.expenses, net: x.net } : zero; };

  // Expense categories, year to date (COGS + operating + other expenses)
  const yIdx = now.months.filter(m => m.month.startsWith(`${t.y}-`)).map(m => m.index);
  const mIdx = now.months.filter(m => m.month === curKey).map(m => m.index);
  const cats = new Map<string, { ytd: number; mtd: number }>();
  for (const grp of ['COGS', 'Expenses', 'OtherExpenses']) {
    for (const line of childLines(findGroup(now.rows, grp))) {
      const ytd = yIdx.reduce((a, i) => a + (line.vals[i] || 0), 0), mtd = mIdx.reduce((a, i) => a + (line.vals[i] || 0), 0);
      const c = cats.get(line.name) || { ytd: 0, mtd: 0 }; c.ytd += ytd; c.mtd += mtd; cats.set(line.name, c);
    }
  }
  const categories = [...cats.entries()].map(([name, v]) => ({ name, ytd: round2(v.ytd), mtd: round2(v.mtd) })).filter(c => c.ytd || c.mtd).sort((a, b) => b.ytd - a.ytd);

  // Revenue lines, year to date (which income accounts the money comes from)
  const incomeLines = childLines(findGroup(now.rows, 'Income')).map(l => ({ name: l.name, ytd: round2(yIdx.reduce((a, i) => a + (l.vals[i] || 0), 0)) })).filter(l => l.ytd).sort((a, b) => b.ytd - a.ytd);

  // Balance sheet: cash in bank, money owed to you, credit card balances
  const bsRows = topSections(bs);
  const lastVal = (sec: Row | undefined) => { const v = sectionVals(sec); return v.length ? round2(v[v.length - 1]) : null; };

  const company = info?.CompanyInfo?.CompanyName || null;
  if (company) await admin.from('qbo_connection').update({ company_name: company }).eq('id', 1);

  return {
    asOf: t.iso,
    company,
    basis: now.basis,
    env: ENV,
    mtd: pick(now.series, curKey),
    mtdLastYear: pick(prev.series, `${ly}-${pad(t.m)}`),
    lastMonth: { month: lastKey, ...pick(now.series, lastKey) },
    ytd: rounded(sumSeries(thisYear)),
    ytdLastYear: rounded(sumSeries(prev.series)),
    lastYearFull: rounded(sumSeries(now.series.filter(s => s.month.startsWith(`${ly}-`)))),
    months: now.series, // Jan last year → this month
    categories,
    incomeLines,
    balances: {
      cash: lastVal(findGroupDeep(bsRows, 'BankAccounts')),
      receivables: lastVal(findGroupDeep(bsRows, 'AR')),
      creditCards: lastVal(findGroupDeep(bsRows, 'CreditCards')),
    },
  };
}

/* ---------- Profit & Loss statement (any period, optional comparison, drill-down) ---------- */
// Statement rows as a tree: sections (Income, COGS, Expenses, …), accounts and sub-accounts,
// plus the computed lines (Gross Profit, Net Operating Income, Net Income).
type PlNode = { key: string; name: string; id: string | null; group: string | null; kind: 'section' | 'account' | 'total'; values: number[]; children: PlNode[] };
function plTree(rows: Row[], path = ''): PlNode[] {
  const out: PlNode[] = [];
  for (const r of rows || []) {
    if (r.type === 'Data' || (r.ColData && !r.Summary)) {
      const c0 = r.ColData?.[0] || {};
      const name = c0.value || '';
      out.push({ key: c0.id ? `a${c0.id}` : `${path}/${name}`, name, id: c0.id ? String(c0.id) : null, group: null, kind: 'account', values: (r.ColData || []).slice(1).map((c: any) => num(c.value)), children: [] });
      continue;
    }
    const h = r.Header?.ColData?.[0] || {};
    const name = h.value || String(r.Summary?.ColData?.[0]?.value || r.group || '').replace(/^Total\s+/i, '');
    const values = (r.Summary?.ColData || []).slice(1).map((c: any) => num(c.value));
    const children = plTree(r.Rows?.Row || [], `${path}/${name}`);
    const isTop = !path;
    out.push({
      key: h.id ? `a${h.id}` : (r.group ? `g${r.group}` : `${path}/${name}`), name, id: h.id ? String(h.id) : null,
      group: r.group || null, kind: children.length ? (isTop ? 'section' : 'account') : (isTop ? 'total' : 'account'), values, children,
    });
  }
  return out;
}
function plColumns(rep: any) {
  return (rep?.Columns?.Column || []).slice(1).map((c: any) => {
    const md = Object.fromEntries((c.MetaData || []).map((m: any) => [m.Name, m.Value]));
    return { title: c.ColTitle || (String(md.ColKey).toLowerCase() === 'total' ? 'Total' : ''), start: md.StartDate || null, end: md.EndDate || null, total: String(md.ColKey || '').toLowerCase() === 'total' || /^total$/i.test(c.ColTitle || '') };
  });
}
function flattenTotals(nodes: PlNode[], out = new Map<string, number>()) {
  for (const n of nodes) { out.set(n.key, n.values[n.values.length - 1] || 0); flattenTotals(n.children, out); }
  return out;
}
async function plStatement(start: string, end: string, byMonth: boolean, cStart: string | null, cEnd: string | null) {
  await accessToken();
  const [rep, cmp] = await Promise.all([
    qbo('reports/ProfitAndLoss', { start_date: start, end_date: end, ...(byMonth ? { summarize_column_by: 'Month' } : {}) }),
    cStart && cEnd ? qbo('reports/ProfitAndLoss', { start_date: cStart, end_date: cEnd }) : Promise.resolve(null),
  ]);
  const columns = plColumns(rep);
  const rows = plTree(rep?.Rows?.Row || []);
  const cmpRows = cmp ? plTree(cmp?.Rows?.Row || []) : [];
  // Accounts used only in the comparison period still get a (zero) row, so the comparison adds up.
  const addMissing = (into: PlNode[], from: PlNode[]) => {
    for (const c of from) {
      const n = into.find(x => x.key === c.key);
      if (n) { addMissing(n.children, c.children); continue; }
      const zero = (x: PlNode): PlNode => ({ ...x, values: columns.map(() => 0), children: x.children.map(zero) });
      const at = c.kind === 'total' ? into.length : into.findIndex(x => x.kind === 'total');
      into.splice(at < 0 ? into.length : at, 0, zero(c));
    }
  };
  if (cmp) addMissing(rows, cmpRows);
  return {
    start, end, byMonth, basis: rep?.Header?.ReportBasis || null, columns, rows,
    compare: cmp ? { start: cStart, end: cEnd, totals: Object.fromEntries(flattenTotals(cmpRows)) } : null,
  };
}
// Transactions behind one account for a period (ProfitAndLossDetail filtered to that account).
async function plDetail(accountId: string, start: string, end: string, limit = 500) {
  const rep = await qbo('reports/ProfitAndLossDetail', { start_date: start, end_date: end, account: accountId, columns: 'tx_date,txn_type,doc_num,name,memo,split_acc,subt_nat_amount' });
  const keys = (rep?.Columns?.Column || []).map((c: any) => (c.MetaData || []).find((m: any) => m.Name === 'ColKey')?.Value || c.ColTitle);
  const at = (k: string) => keys.indexOf(k);
  const out: any[] = [];
  const walk = (rows: Row[]) => {
    for (const r of rows || []) {
      if (r.Rows?.Row) walk(r.Rows.Row);
      if (r.type !== 'Data' && !(r.ColData && !r.Summary)) continue;
      const cd = r.ColData || [];
      const get = (k: string) => (at(k) >= 0 ? cd[at(k)] : null) || {};
      const date = get('tx_date').value;
      if (!isoDate(date)) continue; // skips "Beginning balance" style rows
      out.push({ date, type: get('txn_type').value || '', txnId: get('txn_type').id || null, doc: get('doc_num').value || '', name: get('name').value || '',
        memo: get('memo').value || '', split: get('split_acc').value || '', amount: num(get('subt_nat_amount').value) });
    }
  };
  walk(rep?.Rows?.Row || []);
  out.sort((a, b) => b.date.localeCompare(a.date));
  return { accountId, start, end, items: out.slice(0, limit), total: round2(out.reduce((a, x) => a + x.amount, 0)), count: out.length };
}

/* ---------- Bookkeeping: review every transaction, recategorize ---------- */
// Types HQ lists for review. Purchase (checks, card charges, expenses), Bill and Deposit lines can be
// recategorized; the rest are confirm-only (their money moves through other accounts/links).
const REVIEW_TYPES = ['Purchase', 'Deposit', 'Bill', 'Transfer', 'Payment', 'SalesReceipt', 'BillPayment', 'JournalEntry'] as const;
const EDITABLE = new Set(['Purchase', 'Bill', 'Deposit']);
const UNCAT = /uncategori[sz]ed|ask my accountant/i;
const isoDate = (s: unknown) => /^\d{4}-\d{2}-\d{2}$/.test(String(s)) ? String(s) : null;

// Bank-feed transactions often have no payee, only the bank's description
// ("Electronic Withdrawal Wise Us Inc", "Web Authorized Pmt Spiro.media"). Turn that into a readable
// name plus a short key, so suggestions can group "Wise Us Inc" and "Wise Ltd" together.
const BANK_NOISE = new Set('electronic withdrawal deposit web authorized auth pmt payment purchase recurring card debit credit pos ach online mobile banking transfer on ppd ccd id ref checkcard visa mastercard bill pay paid sq tst des indn co'.split(' '));
const NAME_SUFFIX = new Set('inc ltd llc us co corp company the www com net'.split(' '));
function bankName(desc: string) {
  const raw = String(desc || '').replace(/\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b/g, ' ').replace(/[#*]/g, ' ').split(/\s+/).filter(Boolean);
  const root = (w: string) => w.toLowerCase().replace(/^www\./, '').replace(/\.(com|net|io|media|co|us)\.?$/, '').replace(/[^a-z0-9&]/g, '');
  const words: string[] = [];
  for (const w of raw) {
    if (/\d/.test(w) || !/[a-z]/i.test(w)) continue;                 // card refs, phone numbers, store numbers, dashes
    if (words.some(x => root(x) === root(w))) continue;               // "Cubicasa Www.cubicasa." / "Dropbox Dropbox.com"
    words.push(w);
  }
  if (words.length > 1 && /^[A-Z]{2}$/.test(words[words.length - 1])) words.pop(); // trailing state code
  if (!words.length) return { label: '', key: '' };
  const kept = words.filter(w => !BANK_NOISE.has(root(w)));
  const label = (kept.length ? kept : words).join(' ').replace(/[.,;:]+$/, '');
  const keyWords = [...new Set(label.split(/\s+/).map(root).filter(w => w.length > 2 && !NAME_SUFFIX.has(w)))];
  return { label, key: keyWords.slice(0, 2).join(' ') || label.toLowerCase() };
}

async function queryAll(entity: string, where: string) {
  const out: any[] = [];
  for (let start = 1; start < 20000; start += 1000) {
    const d = await qbo('query', { query: `select * from ${entity} where ${where} orderby TxnDate desc startposition ${start} maxresults 1000` });
    const rows = d?.QueryResponse?.[entity] || [];
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}

async function chartOfAccounts() {
  const d = await qbo('query', { query: 'select * from Account where Active = true maxresults 1000' });
  return (d?.QueryResponse?.Account || []).map((a: any) => ({
    id: String(a.Id), name: a.Name, full: a.FullyQualifiedName || a.Name, type: a.AccountType, sub: a.AccountSubType || null,
    classification: a.Classification, parent: a.ParentRef?.value || null,
  })).sort((a: any, b: any) => a.full.localeCompare(b.full));
}

// One transaction → a flat shape the review screen can show.
function normalizeTxn(type: string, t: any, accts: Map<string, any>) {
  const ref = (r: any) => r ? { id: String(r.value), name: accts.get(String(r.value))?.full || r.name || '' } : null;
  const lines: any[] = [];
  let payee = t.EntityRef?.name || t.VendorRef?.name || t.CustomerRef?.name || '';
  let account: any = null, direction = 'out', amount = num(t.TotalAmt ?? t.Amount);
  for (const l of t.Line || []) {
    if (l.DetailType === 'AccountBasedExpenseLineDetail') lines.push({ id: String(l.Id), amount: num(l.Amount), desc: l.Description || '', account: ref(l.AccountBasedExpenseLineDetail?.AccountRef), editable: true });
    else if (l.DetailType === 'ItemBasedExpenseLineDetail') lines.push({ id: String(l.Id), amount: num(l.Amount), desc: l.Description || l.ItemBasedExpenseLineDetail?.ItemRef?.name || 'Item', account: null, editable: false, note: 'Item line' });
    else if (l.DetailType === 'DepositLineDetail') {
      const dd = l.DepositLineDetail || {};
      if (!payee && dd.Entity?.name) payee = dd.Entity.name;
      lines.push({ id: String(l.Id), amount: num(l.Amount), desc: l.Description || '', account: ref(dd.AccountRef), editable: true });
    } else if (l.LinkedTxn?.length && type === 'Deposit') lines.push({ id: String(l.Id ?? ''), amount: num(l.Amount), desc: 'Payment from ' + (l.LinkedTxn.map((x: any) => x.TxnType).join(', ')), account: null, editable: false, note: 'Linked payment' });
    else if (l.DetailType === 'JournalEntryLineDetail') {
      const jd = l.JournalEntryLineDetail || {};
      lines.push({ id: String(l.Id), amount: num(l.Amount) * (jd.PostingType === 'Credit' ? -1 : 1), desc: l.Description || '', account: ref(jd.AccountRef), editable: false });
    }
  }
  if (type === 'Purchase') { account = ref(t.AccountRef); direction = t.Credit ? 'in' : 'out'; }
  else if (type === 'Bill') { account = ref(t.APAccountRef) || { id: '', name: 'Accounts Payable' }; }
  else if (type === 'Deposit') { account = ref(t.DepositToAccountRef); direction = 'in'; }
  else if (type === 'Transfer') { account = ref(t.FromAccountRef); direction = 'transfer'; payee = `To ${t.ToAccountRef?.name || 'account'}`; }
  else if (type === 'Payment') { account = ref(t.DepositToAccountRef) || { id: '', name: 'Undeposited Funds' }; direction = 'in'; }
  else if (type === 'SalesReceipt') { account = ref(t.DepositToAccountRef); direction = 'in'; }
  else if (type === 'BillPayment') { account = ref(t.CheckPayment?.BankAccountRef || t.CreditCardPayment?.CCAccountRef); }
  else if (type === 'JournalEntry') { direction = 'journal'; amount = (t.Line || []).filter((l: any) => l.JournalEntryLineDetail?.PostingType === 'Debit').reduce((a: number, l: any) => a + num(l.Amount), 0); }
  const uncategorized = lines.some(l => l.editable && (!l.account || UNCAT.test(l.account.name)));
  let payeeKey = payee.trim().toLowerCase(), payeeFromBank = false;
  if (!payee) {
    const b = bankName(t.PrivateNote || lines[0]?.desc || '');
    if (b.label) { payee = b.label; payeeKey = b.key; payeeFromBank = true; }
  }
  return {
    payeeKey, payeeFromBank,
    type, id: String(t.Id), sync: String(t.SyncToken ?? ''), date: t.TxnDate, amount: round2(amount), direction, payee,
    account, memo: t.PrivateNote || '', doc: t.DocNumber || '', updated: t.MetaData?.LastUpdatedTime || null,
    created: t.MetaData?.CreateTime || null, lines, editable: EDITABLE.has(type) && lines.some(l => l.editable), uncategorized,
  };
}

async function booksReview(since: string) {
  const t = todayET();
  const yearAgo = `${t.y - 1}-${pad(t.m)}-${pad(Math.min(t.d, lastDayOf(t.y - 1, t.m)))}`;
  const from = since < yearAgo ? since : yearAgo; // a year of history feeds the payee suggestions
  await accessToken();
  const accounts = await chartOfAccounts();
  const accts = new Map<string, any>(accounts.map((a: any) => [a.id, a]));
  const lists = await Promise.all(REVIEW_TYPES.map(ty =>
    queryAll(ty, `TxnDate >= '${['Purchase', 'Bill', 'Deposit'].includes(ty) ? from : since}'`).then(rows => rows.map(r => normalizeTxn(ty, r, accts)))));
  const all = lists.flat();

  // Payee suggestions: the account each payee is most often categorized to (ignoring uncategorized).
  const tally = new Map<string, Map<string, number>>();
  for (const x of all) {
    if (!x.editable || !x.payeeKey) continue;
    const key = x.payeeKey;
    for (const l of x.lines) {
      if (!l.editable || !l.account || UNCAT.test(l.account.name)) continue;
      const m = tally.get(key) || new Map(); m.set(l.account.id, (m.get(l.account.id) || 0) + 1); tally.set(key, m);
    }
  }
  const suggestFor = (key: string) => {
    const m = tally.get(key); if (!m) return null;
    const [id, count] = [...m.entries()].sort((a, b) => b[1] - a[1])[0];
    const total = [...m.values()].reduce((a, b) => a + b, 0);
    const a = accts.get(id); return a ? { id, name: a.full, count, total } : null;
  };

  const inWindow = all.filter(x => x.date >= since);
  const { data: revs } = await admin.from('txn_reviews').select('txn_type, txn_id, qbo_updated, confirmed_at');
  const rev = new Map((revs || []).map((r: any) => [`${r.txn_type}:${r.txn_id}`, r]));
  const items = inWindow.map(x => {
    const r: any = rev.get(`${x.type}:${x.id}`);
    const reviewed = !!r && (!x.updated || !r.qbo_updated || new Date(x.updated).getTime() <= new Date(r.qbo_updated).getTime() + 1000);
    return { ...x, reviewed, confirmedAt: r?.confirmed_at || null, changedSinceReview: !!r && !reviewed, suggestion: x.editable && x.payeeKey ? suggestFor(x.payeeKey) : null };
  }).sort((a, b) => (b.date || '').localeCompare(a.date || '') || b.id.localeCompare(a.id));
  return {
    since, accounts, items,
    counts: { total: items.length, toReview: items.filter(i => !i.reviewed).length, uncategorized: items.filter(i => i.uncategorized).length },
  };
}

async function markReviewed(list: { type: string; id: string; updated: string | null }[], uid: string) {
  const rows = list.filter(x => REVIEW_TYPES.includes(x.type as any) && /^\d+$/.test(x.id))
    .map(x => ({ txn_type: x.type, txn_id: x.id, qbo_updated: x.updated || null, confirmed_at: new Date().toISOString(), confirmed_by: uid }));
  if (rows.length) { const { error } = await admin.from('txn_reviews').upsert(rows); if (error) throw new Error(error.message); }
  return rows.length;
}

// Change the account on one or more lines of a Purchase, Bill or Deposit, write it to QuickBooks,
// and mark it confirmed.
async function recategorize(type: string, id: string, changes: { lineId: string; accountId: string }[], uid: string, preloaded?: any[]) {
  if (!EDITABLE.has(type) || !/^\d+$/.test(id)) throw new Error('This kind of transaction can’t be recategorized here');
  if (!changes.length || changes.some(c => !/^\d+$/.test(String(c.lineId)) || !/^\d+$/.test(String(c.accountId)))) throw new Error('Nothing to change');
  const accounts = preloaded || await chartOfAccounts();
  if (changes.some(c => !accounts.find((a: any) => a.id === String(c.accountId)))) throw new Error('That category isn’t an active account in QuickBooks');
  const cur = (await qbo(`${type.toLowerCase()}/${id}`))?.[type];
  if (!cur) throw new Error('Transaction not found in QuickBooks');
  const want = new Map(changes.map(c => [String(c.lineId), String(c.accountId)]));
  let changed = 0;
  const Line = (cur.Line || []).map((l: any) => {
    const acc = want.get(String(l.Id)); if (!acc) return l;
    if (l.DetailType === 'AccountBasedExpenseLineDetail') { changed++; return { ...l, AccountBasedExpenseLineDetail: { ...l.AccountBasedExpenseLineDetail, AccountRef: { value: acc } } }; }
    if (l.DetailType === 'DepositLineDetail') { changed++; return { ...l, DepositLineDetail: { ...l.DepositLineDetail, AccountRef: { value: acc } } }; }
    return l;
  });
  if (!changed) throw new Error('Those lines can’t be recategorized');
  // Full update: QuickBooks wants the whole transaction (PaymentType, AccountRef…), not just the lines.
  const full: any = { ...cur, Line }; delete full.sparse;
  const upd = (await qbo(type.toLowerCase(), { operation: 'update' }, full))?.[type];
  if (!upd) throw new Error('QuickBooks didn’t confirm the change');
  const accts = new Map<string, any>(accounts.map((a: any) => [a.id, a]));
  const x = normalizeTxn(type, upd, accts);
  await markReviewed([{ type, id: x.id, updated: x.updated }], uid);
  return { ...x, reviewed: true, confirmedAt: new Date().toISOString(), changedSinceReview: false };
}

/* ---------- Chart of accounts: list all, create, rename / move, make inactive ---------- */
async function allAccounts() {
  const d = await qbo('query', { query: 'select * from Account where Active in (true, false) maxresults 1000' });
  return (d?.QueryResponse?.Account || []).map((a: any) => ({
    id: String(a.Id), name: a.Name, full: a.FullyQualifiedName || a.Name, type: a.AccountType, sub: a.AccountSubType || null,
    classification: a.Classification, parent: a.ParentRef?.value || null, active: !!a.Active,
  })).sort((a: any, b: any) => a.full.localeCompare(b.full));
}
const ACCOUNT_TYPES = new Set(['Income', 'Other Income', 'Expense', 'Other Expense', 'Cost of Goods Sold']);
async function saveAccount(body: any) {
  const name = String(body.name || '').trim();
  if (!name || name.length > 100 || /[:"]/.test(name)) throw new Error('Category names can’t be empty or contain : or "');
  const parentId = body.parentId ? String(body.parentId) : null;
  if (parentId && !/^\d+$/.test(parentId)) throw new Error('Bad parent category');
  if (body.id) {
    const id = String(body.id); if (!/^\d+$/.test(id)) throw new Error('Bad category');
    const cur = (await qbo(`account/${id}`))?.Account;
    if (!cur) throw new Error('Category not found in QuickBooks');
    if (!ACCOUNT_TYPES.has(cur.AccountType)) throw new Error('Only Profit & Loss categories can be changed here');
    const upd: any = { ...cur, Name: name };
    // Optional type change (e.g. Cost of Goods Sold → Expense); history moves with the account.
    if (body.type) {
      if (!ACCOUNT_TYPES.has(String(body.type))) throw new Error('Pick a category type');
      upd.AccountType = String(body.type);
      if (body.subType) upd.AccountSubType = String(body.subType);
    }
    if ('parentId' in body) { if (parentId) { upd.SubAccount = true; upd.ParentRef = { value: parentId }; } else { upd.SubAccount = false; delete upd.ParentRef; } }
    delete upd.FullyQualifiedName; delete upd.CurrentBalance; delete upd.CurrentBalanceWithSubAccounts;
    return (await qbo('account', {}, upd))?.Account;
  }
  const type = String(body.type || '');
  if (!ACCOUNT_TYPES.has(type)) throw new Error('Pick a category type');
  const acc: any = { Name: name, AccountType: type };
  if (body.subType) acc.AccountSubType = String(body.subType);
  if (parentId) { acc.SubAccount = true; acc.ParentRef = { value: parentId }; }
  return (await qbo('account', {}, acc))?.Account;
}
async function setAccountActive(id: string, active: boolean) {
  if (!/^\d+$/.test(id)) throw new Error('Bad category');
  const cur = (await qbo(`account/${id}`))?.Account;
  if (!cur) throw new Error('Category not found in QuickBooks');
  if (!ACCOUNT_TYPES.has(cur.AccountType)) throw new Error('Only Profit & Loss categories can be changed here');
  const upd: any = { ...cur, Active: active };
  delete upd.FullyQualifiedName; delete upd.CurrentBalance; delete upd.CurrentBalanceWithSubAccounts;
  return (await qbo('account', {}, upd))?.Account;
}
// Move several transactions at once (one chart-of-accounts load); each saves and confirms on its own.
async function recategorizeBatch(list: { type: string; id: string; changes: { lineId: string; accountId: string }[] }[], uid: string) {
  await accessToken();
  const accounts = await chartOfAccounts();
  const items: any[] = [], errors: any[] = [];
  for (const x of list) {
    try { items.push(await recategorize(x.type, x.id, x.changes, uid, accounts)); }
    catch (e) { errors.push({ type: x.type, id: x.id, error: String((e as Error)?.message || e) }); }
  }
  return { items, errors };
}

/* ---------- Every posting to an account, and moving lines of any transaction type ---------- */
// The P&L detail report names a transaction type in words; the API needs the entity name.
const TXN_ENTITY: Record<string, string> = {
  'Expense': 'Purchase', 'Check': 'Purchase', 'Credit Card Credit': 'Purchase', 'Cash Expense': 'Purchase', 'Credit Card Expense': 'Purchase',
  'Bill': 'Bill', 'Vendor Credit': 'VendorCredit', 'Deposit': 'Deposit', 'Journal Entry': 'JournalEntry',
  'Sales Receipt': 'SalesReceipt', 'Refund': 'RefundReceipt', 'Credit Memo': 'CreditMemo',
};
async function acctTxns(accountId: string, start: string, end: string) {
  const d = await plDetail(accountId, start, end, 5000);
  return { ...d, items: d.items.map((x: any) => ({ ...x, entity: TXN_ENTITY[x.type] || null })) };
}
// Point every line of one transaction that uses account `from` at account `to` (full update).
async function moveLines(entity: string, id: string, from: string, to: string) {
  if (!/^\d+$/.test(id) || !/^\d+$/.test(from) || !/^\d+$/.test(to)) throw new Error('Bad ids');
  if (!Object.values(TXN_ENTITY).includes(entity)) throw new Error(`Can’t edit ${entity} transactions`);
  const path = entity.toLowerCase();
  const cur = (await qbo(`${path}/${id}`))?.[entity];
  if (!cur) throw new Error(`${entity} ${id} not found`);
  let moved = 0, stuck = 0;
  const Line = (cur.Line || []).map((l: any) => {
    for (const k of ['AccountBasedExpenseLineDetail', 'DepositLineDetail', 'JournalEntryLineDetail']) {
      if (l[k]?.AccountRef) {
        if (String(l[k].AccountRef.value) !== from) return l;
        moved++; return { ...l, [k]: { ...l[k], AccountRef: { value: to } } };
      }
    }
    if (l.ItemBasedExpenseLineDetail || l.SalesItemLineDetail) stuck++;
    return l;
  });
  if (!moved) return { entity, id, moved: 0, stuck, skipped: true };
  const full: any = { ...cur, Line }; delete full.sparse;
  const upd = (await qbo(path, { operation: 'update' }, full))?.[entity];
  if (!upd) throw new Error('QuickBooks didn’t confirm the change');
  return { entity, id, moved, stuck };
}

// Turn a card charge that was really a return into a card credit (refund). Guarded: must be a credit-card
// Purchase that isn't a credit yet, with the expected amount. If QuickBooks won't flip the flag in place,
// a matching credit is created and the wrong charge is deleted.
async function cardChargeToCredit(id: string, expectAmount: number) {
  if (!/^\d+$/.test(id)) throw new Error('Bad id');
  const cur = (await qbo(`purchase/${id}`))?.Purchase;
  if (!cur) throw new Error('Transaction not found');
  if (cur.PaymentType !== 'CreditCard') throw new Error('Not a credit card transaction');
  if (cur.Credit) throw new Error('Already a credit');
  if (Math.abs(num(cur.TotalAmt) - expectAmount) > 0.005) throw new Error(`Amount is ${cur.TotalAmt}, expected ${expectAmount}`);
  try {
    const full: any = { ...cur, Credit: true }; delete full.sparse;
    const upd = (await qbo('purchase', { operation: 'update' }, full))?.Purchase;
    if (upd?.Credit) return { id: String(upd.Id), how: 'updated', credit: true, amount: num(upd.TotalAmt) };
  } catch (_) { /* fall through to recreate */ }
  const copy: any = { ...cur, Credit: true };
  for (const k of ['Id', 'SyncToken', 'MetaData', 'sparse', 'domain', 'status']) delete copy[k];
  copy.Line = (cur.Line || []).map((l: any) => { const x = { ...l }; delete x.Id; return x; });
  copy.PrivateNote = `${cur.PrivateNote || ''} (return; re-entered by Knox View HQ, replaced charge #${cur.Id})`.trim().slice(0, 4000);
  const made = (await qbo('purchase', {}, copy))?.Purchase;
  if (!made?.Id || !made.Credit) throw new Error('QuickBooks didn’t create the credit');
  await qbo('purchase', { operation: 'delete' }, { Id: cur.Id, SyncToken: cur.SyncToken });
  return { id: String(made.Id), replaced: String(cur.Id), how: 'recreated', credit: true, amount: num(made.TotalAmt) };
}

/* ---------- Bank and card balances (QuickBooks' own balances), read-only lookups ---------- */
async function accountBalances() {
  const d = await qbo('query', { query: "select * from Account where AccountType in ('Bank', 'Credit Card') and Active = true maxresults 100" });
  return (d?.QueryResponse?.Account || []).map((a: any) => ({
    id: String(a.Id), name: a.Name, type: a.AccountType, sub: a.AccountSubType || null, balance: round2(num(a.CurrentBalance)),
  })).sort((a: any, b: any) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
}
// Read-only query against a fixed list of entities (no writes are possible through this).
const LOOKUP_ENTITIES = /^select \* from (Purchase|Deposit|Transfer|JournalEntry|Payment|SalesReceipt|BillPayment|Bill|Account|CreditCardPayment|VendorCredit|RefundReceipt|CreditMemo|Invoice)\b/i;
async function lookup(query: string) {
  const q = String(query || '').trim();
  if (!LOOKUP_ENTITIES.test(q) || q.length > 600 || /[;]/.test(q)) throw new Error('Not an allowed lookup');
  return (await qbo('query', { query: q }))?.QueryResponse || {};
}
const LOOKUP_REPORTS = new Set(['TransactionList', 'GeneralLedger', 'AccountList', 'BalanceSheet', 'ProfitAndLoss', 'ProfitAndLossDetail', 'TrialBalance']);
async function report(name: string, params: Record<string, unknown>) {
  if (!LOOKUP_REPORTS.has(name)) throw new Error('Not an allowed report');
  const p: Record<string, string> = {};
  for (const [k, v] of Object.entries(params || {})) if (/^[a-z_]{2,40}$/.test(k) && v !== null && v !== undefined) p[k] = String(v).slice(0, 300);
  return await qbo(`reports/${name}`, p);
}

/* ---------- Personal cards: business purchases paid with a personal card ---------- */
// Each one becomes a journal entry: debit the expense category (with the vendor on the line), credit the
// "Owner's Contribution" equity account. The expense lands on the P&L without touching business bank or
// card balances, and the equity line records that the owner put that money into the business.
// A refund (negative amount) is the same entry reversed.
const qq = (s: string) => s.replace(/'/g, "\\'");
async function ownerContributionAccount() {
  const d = await qbo('query', { query: "select * from Account where AccountType = 'Equity' maxresults 200" });
  const list = d?.QueryResponse?.Account || [];
  const hit = list.find((a: any) => a.Active && /owner'?s?\s*(contribution|investment)/i.test(a.Name))
    || list.find((a: any) => a.Active && /^(owner|member)'?s?\s*(capital|equity)$/i.test(a.Name));
  if (hit) return { id: String(hit.Id), name: hit.Name };
  const a = (await qbo('account', {}, { Name: "Owner's Contribution", AccountType: 'Equity', AccountSubType: 'OwnersEquity',
    Description: 'Business expenses paid with personal money (created by Knox View HQ)' }))?.Account;
  return { id: String(a.Id), name: a.Name };
}
async function vendorFor(name: string, cache: Map<string, string | null>) {
  const n = name.trim().slice(0, 100).replace(/[:"]/g, '');
  if (!n) return null;
  if (cache.has(n.toLowerCase())) return cache.get(n.toLowerCase())!;
  let id: string | null = null;
  try {
    const d = await qbo('query', { query: `select Id from Vendor where DisplayName = '${qq(n)}'` });
    id = d?.QueryResponse?.Vendor?.[0]?.Id ? String(d.QueryResponse.Vendor[0].Id) : null;
    if (!id) id = String((await qbo('vendor', {}, { DisplayName: n }))?.Vendor?.Id || '') || null;
  } catch (_) { id = null; } // a customer with the same name, etc.: post without a vendor
  cache.set(n.toLowerCase(), id);
  return id;
}
const shiftDay = (iso: string, n: number) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
// Anything already in QuickBooks within 4 days with the same amount: an expense, a bill or a journal entry.
async function possibleDuplicates(date: string, amount: number) {
  const where = `TxnDate >= '${shiftDay(date, -4)}' and TxnDate <= '${shiftDay(date, 4)}'`;
  const [p, b, j] = await Promise.all([
    qbo('query', { query: `select * from Purchase where ${where} maxresults 500` }),
    qbo('query', { query: `select * from Bill where ${where} maxresults 500` }),
    qbo('query', { query: `select * from JournalEntry where ${where} maxresults 500` }),
  ]);
  const abs = Math.abs(amount), out: any[] = [];
  for (const t of p?.QueryResponse?.Purchase || []) if (Math.abs(num(t.TotalAmt) - abs) < 0.005) out.push({ type: 'Purchase', id: String(t.Id), date: t.TxnDate, amount: num(t.TotalAmt), payee: t.EntityRef?.name || t.PrivateNote || '', account: t.AccountRef?.name || '' });
  for (const t of b?.QueryResponse?.Bill || []) if (Math.abs(num(t.TotalAmt) - abs) < 0.005) out.push({ type: 'Bill', id: String(t.Id), date: t.TxnDate, amount: num(t.TotalAmt), payee: t.VendorRef?.name || '', account: 'Bill' });
  for (const t of j?.QueryResponse?.JournalEntry || []) {
    const debit = (t.Line || []).filter((l: any) => l.JournalEntryLineDetail?.PostingType === 'Debit').reduce((a: number, l: any) => a + num(l.Amount), 0);
    if (Math.abs(debit - abs) < 0.005) out.push({ type: 'JournalEntry', id: String(t.Id), date: t.TxnDate, amount: debit, payee: t.PrivateNote || '', account: 'Journal entry' });
  }
  return out;
}
async function postPersonal(ids: string[], force: boolean, uid: string) {
  const { data: rows, error } = await admin.from('personal_card_txns').select('*').in('id', ids);
  if (error) throw new Error(error.message);
  await accessToken();
  const accounts = await chartOfAccounts();
  const accts = new Map<string, any>(accounts.map((a: any) => [a.id, a]));
  const equity = await ownerContributionAccount();
  const vendors = new Map<string, string | null>();
  const results: any[] = [];
  for (const r of rows || []) {
    const res: any = { id: r.id };
    try {
      if (r.qbo_txn_id) { res.posted = true; res.qboId = r.qbo_txn_id; results.push(res); continue; }
      if (r.decision !== 'business') throw new Error('Mark it as business first');
      const acct = accts.get(String(r.account_id || ''));
      if (!acct || !['Expense', 'Other Expense', 'Cost of Goods Sold'].includes(acct.type)) throw new Error('Pick an expense category');
      const amount = num(r.amount), date = String(r.txn_date);
      if (!amount) throw new Error('Amount is zero');
      if (!force) {
        const dups = await possibleDuplicates(date, amount);
        if (dups.length) { res.duplicates = dups; results.push(res); continue; }
      }
      const vendorName = String(r.note || '').trim() || cleanMerchant(r.name);
      const vendorId = await vendorFor(vendorName, vendors);
      const out = amount > 0, abs = Math.round(Math.abs(amount) * 100) / 100;
      const desc = `${out ? '' : 'Refund: '}${r.name} (paid with personal card ••${r.card})`.slice(0, 4000);
      const je = {
        TxnDate: date,
        PrivateNote: `Personal card ••${r.card}: ${r.name}. Added by Knox View HQ.`.slice(0, 4000),
        Line: [
          { DetailType: 'JournalEntryLineDetail', Amount: abs, Description: desc,
            JournalEntryLineDetail: { PostingType: out ? 'Debit' : 'Credit', AccountRef: { value: acct.id }, ...(vendorId ? { Entity: { Type: 'Vendor', EntityRef: { value: vendorId } } } : {}) } },
          { DetailType: 'JournalEntryLineDetail', Amount: abs, Description: desc,
            JournalEntryLineDetail: { PostingType: out ? 'Credit' : 'Debit', AccountRef: { value: equity.id } } },
        ],
      };
      const made = (await qbo('journalentry', {}, je))?.JournalEntry;
      if (!made?.Id) throw new Error('QuickBooks didn’t confirm the entry');
      const now = new Date().toISOString();
      await admin.from('personal_card_txns').update({ qbo_txn_id: String(made.Id), posted_at: now, posted_by: uid, account_name: acct.full }).eq('id', r.id);
      // Mark it confirmed in the Bookkeeping review too: it was just reviewed.
      await markReviewed([{ type: 'JournalEntry', id: String(made.Id), updated: made.MetaData?.LastUpdatedTime || null }], uid);
      Object.assign(res, { posted: true, qboId: String(made.Id), postedAt: now, account: acct.full, equity: equity.name, vendor: vendorId ? vendorName : null });
    } catch (e) { res.error = String((e as Error)?.message || e); }
    results.push(res);
  }
  return { results, equity };
}
async function unpostPersonal(id: string) {
  const { data: r } = await admin.from('personal_card_txns').select('*').eq('id', id).maybeSingle();
  if (!r?.qbo_txn_id) throw new Error('That one isn’t in QuickBooks');
  const cur = (await qbo(`journalentry/${r.qbo_txn_id}`).catch(() => null))?.JournalEntry;
  if (cur) await qbo('journalentry', { operation: 'delete' }, { Id: cur.Id, SyncToken: cur.SyncToken });
  await admin.from('txn_reviews').delete().eq('txn_type', 'JournalEntry').eq('txn_id', String(r.qbo_txn_id));
  await admin.from('personal_card_txns').update({ qbo_txn_id: null, posted_at: null, posted_by: null }).eq('id', id);
  return { ok: true };
}
// Card statement name → a vendor name ("SP TOOLSONS  BUCURESTI RO" → "Toolsons"). Same idea as the app's.
function cleanMerchant(name: string) {
  let s = String(name || '').split(/\s{2,}/)[0].trim();
  if (/amazon|amzn/i.test(s)) return 'Amazon';
  if (/apple\.com/i.test(s)) return 'Apple';
  if (/google.*(workspace|gsuite)/i.test(s)) return 'Google Workspace';
  s = s.replace(/^(SQ|TST|SP|FSP|GLF|CTLP|PAR|DK)\s*\*\s*/i, '').replace(/^SP\s+/i, '').replace(/^www\./i, '').replace(/\.com\b.*$/i, '');
  s = s.replace(/[#*].*$/, '').replace(/\s\d.*$/, '').trim();
  return s.toLowerCase().replace(/\b[a-z]/g, c => c.toUpperCase()).replace(/\bDji\b/, 'DJI') || String(name).slice(0, 40);
}
async function sha256(s: string) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
}

async function saveSnapshot(data: unknown, uid: string) {
  const refreshed_at = new Date().toISOString();
  await admin.from('finance_snapshots').upsert({ id: 1, data, refreshed_at, refreshed_by: uid });
  return { data, refreshedAt: refreshed_at };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors(req) });
  try {
    const body = await req.json().catch(() => ({}));
    const action = String(body.action || '');
    const configured = !!(CLIENT_ID && CLIENT_SECRET);
    // Setup check (reveals nothing secret)
    if (action === 'ping') return json(req, { configured, env: ENV, clientIdLength: CLIENT_ID.length, secretLength: CLIENT_SECRET.length });

    let uid: string;
    const job = req.headers.get('x-hq-job') || '';
    if (job) {
      // Server-side job (started from the database with a one-time token). Limited to a few actions.
      if (!['accounts', 'pc_post', 'pl', 'acct_txns', 'account_save', 'account_active', 'move_many', 'card_credit', 'balances', 'lookup', 'report'].includes(action)) return json(req, { error: 'Not allowed' }, 403);
      const { data: tok } = await admin.from('qbo_job_tokens').select('expires_at').eq('token_hash', await sha256(job)).maybeSingle();
      if (!tok || new Date(tok.expires_at).getTime() < Date.now()) return json(req, { error: 'Not signed in' }, 401);
      const { data: owner } = await admin.from('team_members').select('id').eq('role', 'owner').eq('active', true).limit(1).maybeSingle();
      if (!owner) return json(req, { error: 'No owner' }, 403);
      uid = owner.id;
    } else {
      // The function checks the signed-in user itself (verify_jwt is off so database jobs can reach it).
      const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
      const { data: u, error: ue } = await admin.auth.getUser(jwt);
      if (ue || !u?.user) return json(req, { error: 'Not signed in' }, 401);
      uid = u.user.id;
      const { data: me } = await admin.from('team_members').select('id, active, role').eq('id', uid).maybeSingle();
      if (!me?.active || me.role !== 'owner') return json(req, { error: 'Finance is only available to the owner' }, 403);
    }

    if (action === 'status') {
      const [{ data: c }, { data: snap }] = await Promise.all([
        admin.from('qbo_connection').select('realm_id, company_name, connected_at, refresh_expires_at').eq('id', 1).maybeSingle(),
        admin.from('finance_snapshots').select('data, refreshed_at').eq('id', 1).maybeSingle(),
      ]);
      return json(req, { configured, env: ENV, connected: !!c, company: c?.company_name ?? null, connectedAt: c?.connected_at ?? null,
        snapshot: c && snap ? { data: snap.data, refreshedAt: snap.refreshed_at } : null });
    }
    if (!configured) return json(req, { error: 'QuickBooks is not set up yet' }, 400);

    if (action === 'auth_url') {
      const redirect = String(body.redirect_uri || '');
      if (!REDIRECTS.includes(redirect)) return json(req, { error: 'That page address is not allowed for QuickBooks sign-in' }, 400);
      const state = String(body.state || '');
      if (!/^[A-Za-z0-9_-]{16,128}$/.test(state)) return json(req, { error: 'Bad sign-in state' }, 400);
      const url = `${AUTH_URL}?${new URLSearchParams({ client_id: CLIENT_ID, response_type: 'code', scope: SCOPE, redirect_uri: redirect, state })}`;
      return json(req, { url });
    }

    if (action === 'connect') {
      const redirect = String(body.redirect_uri || '');
      if (!REDIRECTS.includes(redirect)) return json(req, { error: 'That page address is not allowed for QuickBooks sign-in' }, 400);
      const realm = String(body.realmId || '');
      if (!/^\d{1,30}$/.test(realm)) return json(req, { error: 'QuickBooks did not say which company was picked' }, 400);
      const t = await tokenRequest({ grant_type: 'authorization_code', code: String(body.code || ''), redirect_uri: redirect });
      await admin.from('qbo_connection').upsert({
        id: 1, realm_id: realm, refresh_token: t.refresh_token, refresh_expires_at: expiry(t.x_refresh_token_expires_in, 8640000),
        access_token: t.access_token, access_expires_at: expiry(t.expires_in, 3600), connected_by: uid,
        connected_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      });
      await admin.from('finance_snapshots').delete().eq('id', 1); // a different company may have been picked
      let snapshot = null, warning = null;
      try { snapshot = await saveSnapshot(await buildSnapshot(), uid); } catch (e) { warning = String((e as Error).message || e); }
      const { data: c } = await admin.from('qbo_connection').select('company_name').eq('id', 1).maybeSingle();
      return json(req, { connected: true, company: c?.company_name ?? null, snapshot, warning });
    }

    if (action === 'disconnect') {
      const { data: c } = await admin.from('qbo_connection').select('refresh_token').eq('id', 1).maybeSingle();
      if (c?.refresh_token) await fetch(REVOKE_URL, { method: 'POST', headers: { Authorization: 'Basic ' + btoa(`${CLIENT_ID}:${CLIENT_SECRET}`), Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify({ token: c.refresh_token }) }).catch(() => {});
      await admin.from('qbo_connection').delete().eq('id', 1);
      await admin.from('finance_snapshots').delete().eq('id', 1);
      return json(req, { connected: false });
    }

    if (action === 'refresh') return json(req, await saveSnapshot(await buildSnapshot(), uid));

    if (action === 'pl') {
      const start = isoDate(body.start), end = isoDate(body.end);
      if (!start || !end || start > end) return json(req, { error: 'Pick a valid date range' }, 400);
      const cStart = isoDate(body.compareStart), cEnd = isoDate(body.compareEnd);
      return json(req, await plStatement(start, end, !!body.byMonth, cStart && cEnd && cStart <= cEnd ? cStart : null, cStart && cEnd && cStart <= cEnd ? cEnd : null));
    }
    if (action === 'pldetail') {
      const start = isoDate(body.start), end = isoDate(body.end), acct = String(body.accountId || '');
      if (!start || !end || !/^\d+$/.test(acct)) return json(req, { error: 'Pick an account and dates' }, 400);
      return json(req, await plDetail(acct, start, end));
    }

    if (action === 'books') {
      const since = isoDate(body.since);
      if (!since) return json(req, { error: 'Pick a start date' }, 400);
      return json(req, await booksReview(since));
    }
    if (action === 'confirm') {
      const list = Array.isArray(body.items) ? body.items.slice(0, 500).map((x: any) => ({ type: String(x.type), id: String(x.id), updated: x.updated ? String(x.updated) : null })) : [];
      return json(req, { confirmed: await markReviewed(list, uid) });
    }
    if (action === 'unconfirm') {
      await admin.from('txn_reviews').delete().eq('txn_type', String(body.type)).eq('txn_id', String(body.id));
      return json(req, { ok: true });
    }
    if (action === 'categorize') {
      const changes = Array.isArray(body.changes) ? body.changes.slice(0, 100).map((c: any) => ({ lineId: String(c.lineId), accountId: String(c.accountId) })) : [];
      return json(req, { item: await recategorize(String(body.type), String(body.id), changes, uid) });
    }

    if (action === 'categorize_batch') {
      const list = Array.isArray(body.items) ? body.items.slice(0, 25).map((x: any) => ({ type: String(x.type), id: String(x.id),
        changes: (Array.isArray(x.changes) ? x.changes : []).slice(0, 100).map((c: any) => ({ lineId: String(c.lineId), accountId: String(c.accountId) })) })) : [];
      return json(req, await recategorizeBatch(list, uid));
    }
    if (action === 'accounts') return json(req, { accounts: await allAccounts() });
    if (action === 'account_save') {
      const a = await saveAccount(body);
      return json(req, { account: a ? { id: String(a.Id), name: a.Name, full: a.FullyQualifiedName || a.Name, active: !!a.Active } : null });
    }
    if (action === 'account_active') {
      const a = await setAccountActive(String(body.id || ''), !!body.active);
      return json(req, { account: a ? { id: String(a.Id), name: a.Name, active: !!a.Active } : null });
    }

    if (action === 'acct_txns') {
      const start = isoDate(body.start) || '2015-01-01', end = isoDate(body.end) || todayET().iso, acct = String(body.accountId || '');
      if (!/^\d+$/.test(acct)) return json(req, { error: 'Pick an account' }, 400);
      return json(req, await acctTxns(acct, start, end));
    }
    if (action === 'move_lines') return json(req, await moveLines(String(body.entity), String(body.id), String(body.from), String(body.to)));
    if (action === 'move_many') {
      // Up to 60 line moves per call: [{ entity, id, from, to }]. Each one stands alone; errors are reported, not thrown.
      await accessToken();
      const list = Array.isArray(body.moves) ? body.moves.slice(0, 60) : [];
      const done: any[] = [], errors: any[] = [];
      for (const m of list) {
        try { done.push(await moveLines(String(m.entity), String(m.id), String(m.from), String(m.to))); }
        catch (e) { errors.push({ ...m, error: String((e as Error)?.message || e) }); }
      }
      return json(req, { done, errors });
    }

    if (action === 'balances') return json(req, { accounts: await accountBalances(), asOf: new Date().toISOString() });
    if (action === 'lookup') return json(req, await lookup(String(body.query || '')));
    if (action === 'report') return json(req, await report(String(body.name || ''), body.params || {}));

    if (action === 'card_credit') return json(req, await cardChargeToCredit(String(body.id || ''), num(body.expectAmount)));

    if (action === 'pc_post') {
      const ids = Array.isArray(body.ids) ? body.ids.slice(0, 25).map(String).filter((s: string) => /^[0-9a-f-]{36}$/i.test(s)) : [];
      if (!ids.length) return json(req, { error: 'Nothing to post' }, 400);
      return json(req, await postPersonal(ids, !!body.force, uid));
    }
    if (action === 'pc_unpost') return json(req, await unpostPersonal(String(body.id || '')));

    return json(req, { error: 'Unknown action' }, 400);
  } catch (e) {
    if (e instanceof NotConnected) return json(req, { error: e.message, notConnected: true }, 400);
    return json(req, { error: String((e as Error)?.message || e) }, 500);
  }
});
