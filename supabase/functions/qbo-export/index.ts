import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

// One-time, read-only QuickBooks export for the P&L category cleanup.
// Runs only with a single-use token whose SHA-256 hash sits in qbo_export_jobs (server-only table)
// and hasn't expired. Reads the chart of accounts (active + inactive), items, and expense/deposit/
// journal transactions since a date, and stores a compact copy on that job row. Never writes to QuickBooks.
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
