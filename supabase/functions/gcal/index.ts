import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

// Google bridge for Knox View HQ (Calendar + Gmail inbox: read, mark read/unread).
// Holds each team member's Google refresh token server-side and proxies Google API calls.
const CLIENT_ID = (Deno.env.get('GOOGLE_CLIENT_ID') ?? '').trim();
const CLIENT_SECRET = (Deno.env.get('GOOGLE_CLIENT_SECRET') ?? '').trim();
const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
const SCOPES = 'openid email https://www.googleapis.com/auth/calendar.events';
// gmail.modify = read + mark read/unread. HQ never sends, deletes or moves mail in stage 1.
const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.modify';
const MAIL_SCOPES = `${SCOPES} ${GMAIL_SCOPE}`;
const CAL = 'https://www.googleapis.com/calendar/v3';
const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const ALLOWED_ORIGINS = ['https://hq.knoxview.com', 'https://knoxview-hq.netlify.app'];

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

async function tokenRequest(params: Record<string, string>) {
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, ...params }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error_description || data.error || 'Google token error');
  return data;
}

async function accessTokenFor(memberId: string) {
  const { data: acct } = await admin.from('google_accounts').select('*').eq('member_id', memberId).maybeSingle();
  if (!acct) return null;
  if (acct.access_token && acct.access_expires_at && new Date(acct.access_expires_at).getTime() > Date.now() + 60_000) return acct.access_token as string;
  try {
    const t = await tokenRequest({ grant_type: 'refresh_token', refresh_token: acct.refresh_token });
    const exp = new Date(Date.now() + (t.expires_in ?? 3600) * 1000).toISOString();
    await admin.from('google_accounts').update({ access_token: t.access_token, access_expires_at: exp, updated_at: new Date().toISOString() }).eq('member_id', memberId);
    return t.access_token as string;
  } catch (e) {
    if (String(e).includes('invalid_grant')) await admin.from('google_accounts').delete().eq('member_id', memberId);
    throw e;
  }
}

async function gfetch(token: string, path: string, init: RequestInit = {}, base = CAL) {
  const r = await fetch(base + path, { ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers || {}) } });
  if (r.status === 204) return { ok: true };
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = data?.error?.message || `Google error ${r.status}`;
    if (base === GMAIL && /has not been used|is disabled/i.test(msg)) {
      const proj = (msg.match(/project (\d+)/) || [])[1];
      throw new Error(`The Gmail API is not turned on in Google Cloud yet${proj ? ` (Google project number ${proj})` : ''}.`);
    }
    throw new Error(msg);
  }
  return data;
}

const EVENT_FIELDS = ['summary', 'description', 'location', 'start', 'end', 'colorId', 'transparency', 'extendedProperties', 'reminders', 'visibility'];
const pickEvent = (e: Record<string, unknown>) => Object.fromEntries(Object.entries(e || {}).filter(([k]) => EVENT_FIELDS.includes(k)));

/* ---------- Gmail helpers ---------- */
type Part = { mimeType?: string; filename?: string; body?: { data?: string; size?: number; attachmentId?: string }; parts?: Part[]; headers?: { name: string; value: string }[] };
const hdr = (headers: { name: string; value: string }[] = [], name: string) => headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';
function b64url(s = '') {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}
function walk(p: Part, out: { text: string; html: string; files: { name: string; size: number; type: string }[]; inline: Record<string, string> }) {
  const type = (p.mimeType || '').toLowerCase();
  const cid = hdr(p.headers, 'Content-ID').replace(/[<>]/g, '');
  if (p.filename && (p.body?.attachmentId || p.body?.data)) {
    // small inline images (logos in signatures) can be shown; everything else is listed
    if (cid && type.startsWith('image/') && p.body?.data && (p.body.size ?? 0) < 200_000) out.inline[cid] = `data:${type};base64,${p.body.data.replace(/-/g, '+').replace(/_/g, '/')}`;
    else out.files.push({ name: p.filename, size: p.body?.size ?? 0, type });
    return;
  }
  if (type === 'text/plain' && p.body?.data && !out.text) out.text = b64url(p.body.data);
  else if (type === 'text/html' && p.body?.data && !out.html) out.html = b64url(p.body.data);
  for (const c of p.parts || []) walk(c, out);
}
function msgSummary(m: Record<string, any>) {
  const h = m.payload?.headers || [];
  return { id: m.id, from: hdr(h, 'From'), to: hdr(h, 'To'), subject: hdr(h, 'Subject'), date: Number(m.internalDate) || Date.parse(hdr(h, 'Date')) || null, labels: m.labelIds || [] };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors(req) });
  try {
    const body = await req.json().catch(() => ({}));
    const action = body.action as string;
    const configured = !!(CLIENT_ID && CLIENT_SECRET);
    // Setup check (reveals nothing secret): are both values present and shaped right?
    if (action === 'ping') return json(req, { configured, clientIdLooksRight: CLIENT_ID.endsWith('.apps.googleusercontent.com'), secretLooksRight: CLIENT_SECRET.startsWith('GOCSPX-') });

    const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    const { data: u, error: ue } = await admin.auth.getUser(jwt);
    if (ue || !u?.user) return json(req, { error: 'Not signed in' }, 401);
    const uid = u.user.id;
    const { data: me } = await admin.from('team_members').select('id, active').eq('id', uid).maybeSingle();
    if (!me?.active) return json(req, { error: 'Not an active team member' }, 403);

    if (action === 'status') {
      const { data: acct } = await admin.from('google_accounts').select('email, connected_at, scope').eq('member_id', uid).maybeSingle();
      return json(req, { configured, clientId: CLIENT_ID || null, scopes: SCOPES, mailScopes: MAIL_SCOPES, connected: !!acct, email: acct?.email ?? null, gmail: String(acct?.scope || '').includes(GMAIL_SCOPE) });
    }
    if (!configured) return json(req, { error: 'Google Calendar is not set up yet' }, 400);

    if (action === 'connect') {
      const t = await tokenRequest({ grant_type: 'authorization_code', code: String(body.code || ''), redirect_uri: 'postmessage' });
      if (!String(t.scope || '').includes('calendar.events')) return json(req, { error: 'Calendar access was not granted. Please connect again and allow calendar access.' }, 400);
      let email: string | null = null;
      try { const p = JSON.parse(atob(String(t.id_token).split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))); email = p.email ?? null; } catch (_) { /* ignore */ }
      const { data: existing } = await admin.from('google_accounts').select('refresh_token').eq('member_id', uid).maybeSingle();
      const refresh = t.refresh_token || existing?.refresh_token;
      if (!refresh) return json(req, { error: 'Google did not return offline access. Remove Knox View HQ at myaccount.google.com/permissions, then connect again.' }, 400);
      await admin.from('google_accounts').upsert({ member_id: uid, email, refresh_token: refresh, access_token: t.access_token, access_expires_at: new Date(Date.now() + (t.expires_in ?? 3600) * 1000).toISOString(), scope: t.scope, updated_at: new Date().toISOString() });
      return json(req, { connected: true, email, gmail: String(t.scope || '').includes(GMAIL_SCOPE) });
    }

    if (action === 'disconnect') {
      const { data: acct } = await admin.from('google_accounts').select('refresh_token').eq('member_id', uid).maybeSingle();
      if (acct?.refresh_token) await fetch('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(acct.refresh_token), { method: 'POST' }).catch(() => {});
      await admin.from('google_accounts').delete().eq('member_id', uid);
      return json(req, { connected: false });
    }

    const token = await accessTokenFor(uid);
    if (!token) return json(req, { error: 'Google is not connected', notConnected: true }, 400);

    /* ---------- Mail (read + mark read/unread only) ---------- */
    if (action.startsWith('mail_')) {
      const { data: acct } = await admin.from('google_accounts').select('scope').eq('member_id', uid).maybeSingle();
      if (!String(acct?.scope || '').includes(GMAIL_SCOPE)) return json(req, { error: 'Gmail is not connected', needsGmail: true }, 400);

      if (action === 'mail_list') {
        const box = String(body.box || 'primary');
        const base = box === 'all' ? 'in:inbox' : box === 'unread' ? 'in:inbox category:primary is:unread' : 'in:inbox category:primary';
        const search = String(body.q || '').slice(0, 200).trim();
        const q = new URLSearchParams({ q: search ? `${search} -in:spam -in:trash` : base, maxResults: String(Math.min(Number(body.max) || 30, 50)), ...(body.pageToken ? { pageToken: String(body.pageToken) } : {}) });
        const list = await gfetch(token, `/threads?${q}`, {}, GMAIL);
        const ids: string[] = (list.threads || []).map((t: { id: string }) => t.id);
        const meta = new URLSearchParams([['format', 'metadata'], ['metadataHeaders', 'From'], ['metadataHeaders', 'To'], ['metadataHeaders', 'Subject'], ['metadataHeaders', 'Date']]);
        const threads = await Promise.all(ids.map(async id => {
          try {
            const t = await gfetch(token, `/threads/${id}?${meta}`, {}, GMAIL);
            const msgs = (t.messages || []).map(msgSummary);
            const last = msgs[msgs.length - 1] || {};
            const first = msgs[0] || {};
            const people = [...new Set(msgs.map((m: { from: string }) => m.from))];
            return { id, subject: first.subject || '(no subject)', from: last.from, people, date: last.date, count: msgs.length,
              unread: msgs.some((m: { labels: string[] }) => m.labels.includes('UNREAD')),
              starred: msgs.some((m: { labels: string[] }) => m.labels.includes('STARRED')),
              important: msgs.some((m: { labels: string[] }) => m.labels.includes('IMPORTANT')),
              lastFromMe: (last.labels || []).includes('SENT'),
              hasFiles: false, snippet: (t.messages?.[t.messages.length - 1]?.snippet) || '' };
          } catch (_) { return null; }
        }));
        return json(req, { threads: threads.filter(Boolean), nextPageToken: list.nextPageToken || null, estimate: list.resultSizeEstimate ?? null });
      }

      if (action === 'mail_thread') {
        const id = String(body.id || '').replace(/[^0-9a-f]/gi, '');
        if (!id) return json(req, { error: 'Missing thread' }, 400);
        const t = await gfetch(token, `/threads/${id}?format=full`, {}, GMAIL);
        const messages = (t.messages || []).map((m: Record<string, any>) => {
          const out = { text: '', html: '', files: [] as { name: string; size: number; type: string }[], inline: {} as Record<string, string> };
          walk(m.payload || {}, out);
          if (!out.text && !out.html && m.payload?.body?.data) out.text = b64url(m.payload.body.data);
          let html = out.html;
          for (const [cid, src] of Object.entries(out.inline)) html = html.split(`cid:${cid}`).join(src);
          const h = m.payload?.headers || [];
          return { ...msgSummary(m), cc: hdr(h, 'Cc'), replyTo: hdr(h, 'Reply-To'), snippet: m.snippet || '', text: out.text.slice(0, 200_000), html: html.slice(0, 600_000), files: out.files };
        });
        return json(req, { id, messages });
      }

      if (action === 'mail_mark') {
        const id = String(body.id || '').replace(/[^0-9a-f]/gi, '');
        if (!id) return json(req, { error: 'Missing thread' }, 400);
        const read = body.read !== false;
        await gfetch(token, `/threads/${id}/modify`, { method: 'POST', body: JSON.stringify(read ? { removeLabelIds: ['UNREAD'] } : { addLabelIds: ['UNREAD'] }) }, GMAIL);
        return json(req, { ok: true, read });
      }
      return json(req, { error: 'Unknown action' }, 400);
    }

    const cal = encodeURIComponent(String(body.calendarId || 'primary'));

    if (action === 'list') {
      const items: unknown[] = []; let pageToken = '';
      for (let i = 0; i < 5; i++) {
        const q = new URLSearchParams({ timeMin: String(body.timeMin), timeMax: String(body.timeMax), singleEvents: 'true', orderBy: 'startTime', maxResults: '250', ...(pageToken ? { pageToken } : {}) });
        const d = await gfetch(token, `/calendars/${cal}/events?${q}`);
        items.push(...(d.items || []));
        if (!d.nextPageToken) break; pageToken = d.nextPageToken;
      }
      return json(req, { items });
    }
    if (action === 'create') return json(req, await gfetch(token, `/calendars/${cal}/events`, { method: 'POST', body: JSON.stringify(pickEvent(body.event)) }));
    if (action === 'update') return json(req, await gfetch(token, `/calendars/${cal}/events/${encodeURIComponent(String(body.id))}`, { method: 'PATCH', body: JSON.stringify(pickEvent(body.event)) }));
    if (action === 'delete') return json(req, await gfetch(token, `/calendars/${cal}/events/${encodeURIComponent(String(body.id))}`, { method: 'DELETE' }));
    return json(req, { error: 'Unknown action' }, 400);
  } catch (e) {
    console.error('gcal error:', String((e as Error)?.message || e));
    return json(req, { error: String((e as Error)?.message || e) }, 500);
  }
});
