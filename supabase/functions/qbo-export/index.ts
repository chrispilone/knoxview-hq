import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

// One-time QuickBooks jobs for the P&L category cleanup (Nov 2026).
// Runs only with a single-use token whose SHA-256 hash sits in qbo_export_jobs (server-only table)
// and hasn't expired. mode 'export' (read-only): chart of accounts, items and transactions since a date.
// mode 'subtypes' and 'apply' write to QuickBooks, approved by Chris on Nov 6, 2026: fix the detail type of
// six categories, and move transactions off old categories per the cleanup plan (same rules as HQ's
// Bookkeeping → Category cleanup; "your call" items are left alone).
const CLIENT_ID = (Deno.env.get('QBO_CLIENT_ID') ?? '').trim();
const CLIENT_SECRET = (Deno.env.get('QBO_CLIENT_SECRET') ?? '').trim();
const API = (Deno.env.get('QBO_ENV') ?? '').trim().toLowerCase() === 'sandbox' ? 'https://sandbox-quickbooks.api.intuit.com' : 'https://quickbooks.api.intuit.com';
const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
const num = (v: unknown) => { const n = parseFloat(String(v ?? '').replace(/,/g, '')); return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0; };

async function sha256(s: string) {
  const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function accessToken() {
  const { data: c } = await admin.from('qbo_connection').select('*').eq('id', 1).maybeSingle();
  if (!c) throw new Error('QuickBooks is not connected');
  if (c.access_token && c.access_expires_at && new Date(c.access_expires_at).getTime() > Date.now() + 120_000) return { token: c.access_token as string, realm: c.realm_id as string };
  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { Authorization: 'Basic ' + btoa(`${CLIENT_ID}:${CLIENT_SECRET}`), Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: c.refresh_token }),
  });
  const t = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('QuickBooks sign-in error ' + (t.error || r.status));
  // Intuit rotates refresh tokens: always keep the newest one.
  await admin.from('qbo_connection').update({
    access_token: t.access_token, access_expires_at: new Date(Date.now() + (t.expires_in ?? 3600) * 1000).toISOString(),
    refresh_token: t.refresh_token || c.refresh_token, refresh_expires_at: new Date(Date.now() + (t.x_refresh_token_expires_in ?? 8640000) * 1000).toISOString(),
    updated_at: new Date().toISOString(),
  }).eq('id', 1);
  return { token: t.access_token as string, realm: c.realm_id as string };
}

async function qboGet(tok: { token: string; realm: string }, path: string) {
  const r = await fetch(`${API}/v3/company/${tok.realm}/${path}?minorversion=75`, { headers: { Authorization: `Bearer ${tok.token}`, Accept: 'application/json' } });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`QuickBooks error ${r.status}: ${JSON.stringify(d?.Fault?.Error?.[0] ?? '').slice(0, 300)}`);
  return d;
}
async function qboPost(tok: { token: string; realm: string }, path: string, body: unknown, params: Record<string, string> = {}) {
  const r = await fetch(`${API}/v3/company/${tok.realm}/${path}?${new URLSearchParams({ minorversion: '75', ...params })}`, {
    method: 'POST', headers: { Authorization: `Bearer ${tok.token}`, Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`QuickBooks error ${r.status}: ${JSON.stringify(d?.Fault?.Error?.[0] ?? '').slice(0, 300)}`);
  return d;
}

// The cleanup plan (mirrors COA in HQ's index.html). Target account ids as created on Nov 6, 2026.
const T: Record<string, string> = { media:'1150040004', otherinc:'139', photo:'1150040001', video:'1150040000', floor:'1150040003', spiro:'1150040005',
  merchant:'140', software:'1150040006', team:'1150040008', edu:'83', gear:'1150040007', supplies:'141', marketing:'1150040009', dues:'142',
  travel:'143', vehicle:'1150040010', meals:'144', taxes:'145', bank:'146' };
const MOVES: Record<string, string> = { '26':'media', '28':'media', '5':'otherinc', '108':'software', '84':'software', '1150040002':'team', '110':'supplies', '106':'supplies',
  '51':'travel', '114':'travel', '82':'bank', '43':'bank', '2':'bank', '45':'meals', '101':'meals', '102':'meals', '53':'vehicle', '123':'vehicle', '124':'vehicle',
  '46':'gear', '50':'taxes', '32':'taxes', '30':'dues' };
const RULES: { re: RegExp; to: string | null; dir?: string; from?: string[] }[] = [
  { re:/\birs\b/i, to:null }, { re:/earnnest/i, to:null }, { re:/stripe ?connect/i, to:null }, { re:/link\.com/i, to:null }, { re:/awhittington|anthonywh/i, to:null },
  { re:/autohdr/i, to:'photo', dir:'out' }, { re:/cubicasa/i, to:'floor', dir:'out' }, { re:/spiro/i, to:'spiro', dir:'out' },
  { re:/anthropic|openai|chatgpt|creativefabrica|intuit|qbooks/i, to:'software', dir:'out' },
  { re:/edreams|mytrip|metropolis|hotel/i, to:'travel', dir:'out' },
  { re:/weigel|pilot|\bbp\b|shell|exxon|marathon/i, to:'vehicle', dir:'out', from:['51','114','53','123','124'] },
  { re:/tnsos|tn sos|servicefee tn|tn state revenue/i, to:'taxes', dir:'out' }, { re:/realtor association/i, to:'dues', dir:'out' },
  { re:/thunders/i, to:'video', dir:'out' }, { re:/onlinejobs/i, to:'team', dir:'out' }, { re:/aalto/i, to:'media', dir:'in' },
];
const SUBTYPES: Record<string, string> = { '1150040006':'OfficeGeneralAdministrativeExpenses', '1150040007':'SuppliesMaterials', '1150040008':'CostOfLabor', '83':'OtherBusinessExpenses', '1150040010':'Auto' };

async function query(tok: { token: string; realm: string }, q: string, entity: string) {
  const out: any[] = [];
  for (let start = 1; start < 20000; start += 1000) {
    const url = `${API}/v3/company/${tok.realm}/query?${new URLSearchParams({ minorversion: '75', query: `${q} startposition ${start} maxresults 1000` })}`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${tok.token}`, Accept: 'application/json' } });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`QuickBooks error ${r.status}: ${JSON.stringify(d?.Fault?.Error?.[0] ?? '').slice(0, 300)}`);
    const rows = d?.QueryResponse?.[entity] || [];
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}

Deno.serve(async (req) => {
  try {
    const body = await req.json().catch(() => ({}));
    const token = String(body.token || '');
    if (token.length < 32) return new Response('no', { status: 403 });
    const hash = await sha256(token);
    const { data: job } = await admin.from('qbo_export_jobs').select('*').eq('token_hash', hash).is('used_at', null).gt('expires_at', new Date().toISOString()).maybeSingle();
    if (!job) return new Response('no', { status: 403 });
    await admin.from('qbo_export_jobs').update({ used_at: new Date().toISOString() }).eq('id', job.id);
    try {
      const tok = await accessToken();
      const since = String(job.since);
      if (job.mode === 'subtypes') {
        const done: any[] = [];
        for (const [id, sub] of Object.entries(SUBTYPES)) {
          const cur = (await qboGet(tok, `account/${id}`))?.Account;
          if (!cur) { done.push({ id, error: 'not found' }); continue; }
          if (cur.AccountSubType === sub) { done.push({ id, name: cur.Name, sub, unchanged: true }); continue; }
          const upd: any = { ...cur, AccountSubType: sub }; delete upd.FullyQualifiedName; delete upd.CurrentBalance; delete upd.CurrentBalanceWithSubAccounts;
          try { const a = (await qboPost(tok, 'account', upd))?.Account; done.push({ id, name: a?.Name, from: cur.AccountSubType, sub: a?.AccountSubType }); }
          catch (e) { done.push({ id, name: cur.Name, error: String((e as Error).message) }); }
        }
        await admin.from('qbo_export_jobs').update({ result: { subtypes: done } }).eq('id', job.id);
        return new Response(JSON.stringify({ ok: true, subtypes: done }), { headers: { 'Content-Type': 'application/json' } });
      }
      if (job.mode === 'apply') {
        const started = Date.now();
        const active = new Map((await query(tok, 'select * from Account where Active = true', 'Account')).map((a: any) => [String(a.Id), a]));
        const { data: owner } = await admin.from('team_members').select('id').eq('role', 'owner').eq('active', true).limit(1).maybeSingle();
        const plan: { type: string; t: any; want: Map<string, string> }[] = [];
        let decide = 0;
        for (const ty of ['Purchase', 'Bill', 'Deposit']) {
          for (const t of await query(tok, `select * from ${ty} where TxnDate >= '${since}' orderby TxnDate desc`, ty)) {
            const text = [t.EntityRef?.name, t.VendorRef?.name, t.PrivateNote, ...(t.Line || []).map((l: any) => l.Description)].filter(Boolean).join(' ');
            const want = new Map<string, string>();
            for (const l of t.Line || []) {
              const ref = l.AccountBasedExpenseLineDetail?.AccountRef || l.DepositLineDetail?.AccountRef;
              if (!ref?.value || !(l.DetailType === 'AccountBasedExpenseLineDetail' || l.DetailType === 'DepositLineDetail')) continue;
              const from = String(ref.value), acct: any = active.get(from);
              if (acct ? !['Revenue', 'Expense'].includes(acct.Classification) : !MOVES[from]) continue;
              const dir = acct ? (acct.Classification === 'Revenue' ? 'in' : 'out') : (ty === 'Deposit' || t.Credit ? 'in' : 'out');
              const rule = RULES.find(r => r.re.test(text) && (!r.dir || r.dir === dir) && (!r.from || r.from.includes(from)));
              const key = rule ? rule.to : (MOVES[from] ?? undefined);
              if (key === undefined) continue;
              if (key === null) { decide++; continue; }
              if (T[key] && T[key] !== from) want.set(String(l.Id), T[key]);
            }
            if (want.size) plan.push({ type: ty, t, want });
          }
        }
        let moved = 0; const errors: any[] = [];
        for (const p of plan) {
          if (Date.now() - started > 110_000) break;
          try {
            const cur = (await qboGet(tok, `${p.type.toLowerCase()}/${p.t.Id}`))?.[p.type];
            const Line = (cur.Line || []).map((l: any) => {
              const acc = p.want.get(String(l.Id)); if (!acc) return l;
              if (l.DetailType === 'AccountBasedExpenseLineDetail') return { ...l, AccountBasedExpenseLineDetail: { ...l.AccountBasedExpenseLineDetail, AccountRef: { value: acc } } };
              if (l.DetailType === 'DepositLineDetail') return { ...l, DepositLineDetail: { ...l.DepositLineDetail, AccountRef: { value: acc } } };
              return l;
            });
            // Full update: QuickBooks wants the whole transaction (PaymentType, AccountRef…), not just the lines.
            const full: any = { ...cur, Line }; delete full.sparse;
            const upd = (await qboPost(tok, p.type.toLowerCase(), full, { operation: 'update' }))?.[p.type];
            if (owner?.id && upd) await admin.from('txn_reviews').upsert({ txn_type: p.type, txn_id: String(upd.Id), qbo_updated: upd.MetaData?.LastUpdatedTime || null, confirmed_at: new Date().toISOString(), confirmed_by: owner.id });
            moved++;
          } catch (e) { errors.push({ type: p.type, id: String(p.t.Id), date: p.t.TxnDate, error: String((e as Error).message).slice(0, 200) }); }
        }
        const summary = { planned: plan.length, moved, remaining: plan.length - moved - errors.length, decide, errors };
        await admin.from('qbo_export_jobs').update({ result: summary }).eq('id', job.id);
        return new Response(JSON.stringify({ ok: true, ...summary }), { headers: { 'Content-Type': 'application/json' } });
      }
      const accounts = (await query(tok, 'select * from Account where Active in (true, false)', 'Account')).map((a: any) => ({
        id: String(a.Id), name: a.Name, full: a.FullyQualifiedName || a.Name, type: a.AccountType, sub: a.AccountSubType || null,
        active: !!a.Active, parent: a.ParentRef?.value || null, balance: num(a.CurrentBalance),
      }));
      const items = (await query(tok, 'select * from Item where Active in (true, false)', 'Item')).map((i: any) => ({
        id: String(i.Id), name: i.Name, type: i.Type, active: !!i.Active, income: i.IncomeAccountRef?.name || null, incomeId: i.IncomeAccountRef?.value || null, expense: i.ExpenseAccountRef?.name || null,
      }));
      const lines: any[] = [];
      for (const ty of ['Purchase', 'Bill', 'Deposit', 'JournalEntry', 'SalesReceipt', 'Invoice']) {
        const rows = await query(tok, `select * from ${ty} where TxnDate >= '${since}' orderby TxnDate desc`, ty);
        for (const t of rows) {
          const payee = t.EntityRef?.name || t.VendorRef?.name || t.CustomerRef?.name || '';
          for (const l of t.Line || []) {
            let acct: any = null, item: any = null, amt = num(l.Amount);
            if (l.DetailType === 'AccountBasedExpenseLineDetail') acct = l.AccountBasedExpenseLineDetail?.AccountRef;
            else if (l.DetailType === 'ItemBasedExpenseLineDetail') item = l.ItemBasedExpenseLineDetail?.ItemRef;
            else if (l.DetailType === 'DepositLineDetail') acct = l.DepositLineDetail?.AccountRef;
            else if (l.DetailType === 'SalesItemLineDetail') item = l.SalesItemLineDetail?.ItemRef;
            else if (l.DetailType === 'JournalEntryLineDetail') { acct = l.JournalEntryLineDetail?.AccountRef; if (l.JournalEntryLineDetail?.PostingType === 'Credit') amt = -amt; }
            else continue;
            lines.push({
              d: t.TxnDate, t: ty, id: String(t.Id), p: payee || l.DepositLineDetail?.Entity?.name || '',
              a: amt, acc: acct?.value ? String(acct.value) : null, item: item?.value ? String(item.value) : null,
              desc: String(l.Description || '').slice(0, 140), memo: String(t.PrivateNote || '').slice(0, 140),
              pay: ty === 'Purchase' ? (t.AccountRef?.name || null) : null, credit: ty === 'Purchase' ? !!t.Credit : null,
            });
          }
        }
      }
      await admin.from('qbo_export_jobs').update({ result: { accounts, items, lines, exportedAt: new Date().toISOString() } }).eq('id', job.id);
      return new Response(JSON.stringify({ ok: true, accounts: accounts.length, items: items.length, lines: lines.length }), { headers: { 'Content-Type': 'application/json' } });
    } catch (e) {
      await admin.from('qbo_export_jobs').update({ error: String((e as Error)?.message || e) }).eq('id', job.id);
      return new Response(JSON.stringify({ ok: false, error: String((e as Error)?.message || e) }), { status: 500 });
    }
  } catch (e) {
    return new Response(String((e as Error)?.message || e), { status: 500 });
  }
});
