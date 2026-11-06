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
async function recategorize(type: string, id: string, changes: { lineId: string; accountId: string }[], uid: string) {
  if (!EDITABLE.has(type) || !/^\d+$/.test(id)) throw new Error('This kind of transaction can’t be recategorized here');
  if (!changes.length || changes.some(c => !/^\d+$/.test(String(c.lineId)) || !/^\d+$/.test(String(c.accountId)))) throw new Error('Nothing to change');
  const accounts = await chartOfAccounts();
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
  const upd = (await qbo(type.toLowerCase(), { operation: 'update' }, { Id: cur.Id, SyncToken: cur.SyncToken, sparse: true, Line }))?.[type];
  if (!upd) throw new Error('QuickBooks didn’t confirm the change');
  const accts = new Map<string, any>(accounts.map((a: any) => [a.id, a]));
  const x = normalizeTxn(type, upd, accts);
  await markReviewed([{ type, id: x.id, updated: x.updated }], uid);
  return { ...x, reviewed: true, confirmedAt: new Date().toISOString(), changedSinceReview: false };
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

    const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    const { data: u, error: ue } = await admin.auth.getUser(jwt);
    if (ue || !u?.user) return json(req, { error: 'Not signed in' }, 401);
    const uid = u.user.id;
    const { data: me } = await admin.from('team_members').select('id, active, role').eq('id', uid).maybeSingle();
    if (!me?.active || me.role !== 'owner') return json(req, { error: 'Finance is only available to the owner' }, 403);

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

    return json(req, { error: 'Unknown action' }, 400);
  } catch (e) {
    if (e instanceof NotConnected) return json(req, { error: e.message, notConnected: true }, 400);
    return json(req, { error: String((e as Error)?.message || e) }, 500);
  }
});
