import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

// Google bridge for Knox View HQ (Calendar + Gmail: read, mark read/unread, reply).
// Holds each team member's Google refresh token server-side and proxies Google API calls.
const CLIENT_ID = (Deno.env.get('GOOGLE_CLIENT_ID') ?? '').trim();
const CLIENT_SECRET = (Deno.env.get('GOOGLE_CLIENT_SECRET') ?? '').trim();
const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
const SCOPES = 'openid email https://www.googleapis.com/auth/calendar.events';
// gmail.modify = read, mark read/unread and send replies. HQ never deletes, archives or moves mail.
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


/* ---------- Sending (replies) ---------- */
function b64(str: string) {
  const bytes = new TextEncoder().encode(str); let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
const wrap76 = (s: string) => s.replace(/.{1,76}/g, '$&\r\n');
const oneLine = (s: string) => String(s || '').replace(/[\r\n]+/g, ' ').trim();
const encWord = (s: string) => /[^\x20-\x7e]/.test(s) ? `=?UTF-8?B?${b64(s)}?=` : s;
const EMAIL_RE = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/;
function fmtAddr(v: string) {
  const s = oneLine(v); const m = s.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  const email = (m ? m[2] : s).trim(); const name = (m ? m[1] : '').trim();
  if (!EMAIL_RE.test(email)) throw new Error(`“${s}” isn't a valid email address`);
  if (!name) return email;
  return /[^\x20-\x7e]/.test(name) ? `${encWord(name)} <${email}>` : `"${name.replace(/["\\]/g, '')}" <${email}>`;
}
const escHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const textToHtml = (s: string) => escHtml(s).replace(/\bhttps?:\/\/[^\s<]+/g, u => `<a href="${u}">${u}</a>`).replace(/\r?\n/g, '<br>');
const htmlToText = (h: string) => h.replace(/<(style|script)[\s\S]*?<\/\1>/gi, '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|tr|li|h\d)>/gi, '\n')
  .replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\n{3,}/g, '\n\n').trim();

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
    // Per-person access set on the Team page (Mail / Calendar sections)
    const section = (action || '').startsWith('mail_') ? 'mail' : ['list', 'create', 'update', 'delete'].includes(action) ? 'calendar' : null;
    if (section) {
      const { data: allowed } = await admin.rpc('member_can', { member: uid, k: section });
      if (!allowed) return json(req, { error: `You don't have access to ${section === 'mail' ? 'Mail' : 'Calendar'} in HQ`, noAccess: true }, 403);
    }

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

    /* ---------- Mail (read, mark read/unread, reply) ---------- */
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


      if (action === 'mail_signature') {
        try {
          const d = await gfetch(token, '/settings/sendAs', {}, GMAIL);
          const sa = (d.sendAs || []).find((x: { isPrimary?: boolean }) => x.isPrimary) || (d.sendAs || [])[0] || {};
          return json(req, { signature: sa.signature || '', email: sa.sendAsEmail || null, name: sa.displayName || null });
        } catch (_) { return json(req, { signature: '' }); }
      }

      if (action === 'mail_send') {
        const threadId = String(body.threadId || '').replace(/[^0-9a-f]/gi, '');
        const replyId = String(body.replyToId || '').replace(/[^0-9a-f]/gi, '');
        const text = String(body.body || '').replace(/\r\n/g, '\n').trim();
        if (!threadId || !replyId) return json(req, { error: 'Missing email to reply to' }, 400);
        if (!text) return json(req, { error: 'Write a message first' }, 400);
        if (text.length > 50_000) return json(req, { error: 'That message is too long' }, 400);
        const to = (Array.isArray(body.to) ? body.to : []).map(String).filter((x: string) => x.trim()).map(fmtAddr);
        const cc = (Array.isArray(body.cc) ? body.cc : []).map(String).filter((x: string) => x.trim()).map(fmtAddr);
        if (!to.length) return json(req, { error: 'Add at least one recipient' }, 400);
        if (to.length + cc.length > 25) return json(req, { error: 'Too many recipients' }, 400);

        // The message being replied to: threading headers + quoted text
        const orig = await gfetch(token, `/messages/${replyId}?format=full`, {}, GMAIL);
        if (orig.threadId !== threadId) return json(req, { error: 'That email is not part of this conversation' }, 400);
        const oh = orig.payload?.headers || [];
        const msgId = hdr(oh, 'Message-ID') || hdr(oh, 'Message-Id');
        const refs = [hdr(oh, 'References'), msgId].filter(Boolean).join(' ').trim();
        const osubj = hdr(oh, 'Subject');
        const subject = /^\s*re:/i.test(osubj) ? osubj : `Re: ${osubj}`.trim();
        const parts = { text: '', html: '', files: [] as { name: string; size: number; type: string }[], inline: {} as Record<string, string> };
        walk(orig.payload || {}, parts);
        const odate = new Date(Number(orig.internalDate) || Date.now()).toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
        const ofrom = hdr(oh, 'From');
        const attr = `On ${odate}, ${ofrom} wrote:`;

        let sig = '';
        if (body.signature !== false) {
          try {
            const d = await gfetch(token, '/settings/sendAs', {}, GMAIL);
            const sa = (d.sendAs || []).find((x: { isPrimary?: boolean }) => x.isPrimary) || (d.sendAs || [])[0];
            sig = sa?.signature || '';
          } catch (_) { /* no signature */ }
        }
        const quoteHtml = parts.html || textToHtml(parts.text || '');
        const html = `<div dir="ltr">${textToHtml(text)}</div>${sig ? `<br><div dir="ltr" class="gmail_signature">${sig}</div>` : ''}`
          + `<br><div class="gmail_quote"><div dir="ltr" class="gmail_attr">${escHtml(attr)}<br></div>`
          + `<blockquote class="gmail_quote" style="margin:0px 0px 0px 0.8ex;border-left:1px solid rgb(204,204,204);padding-left:1ex">${quoteHtml}</blockquote></div>`;
        const otext = (parts.text || htmlToText(parts.html || '')).split('\n').map(l => '> ' + l).join('\n');
        const plain = `${text}${sig ? `\n\n${htmlToText(sig)}` : ''}\n\n${attr}\n${otext}`;
        const boundary = 'kvhq_' + crypto.randomUUID().replace(/-/g, '');
        const raw = [
          `To: ${to.join(', ')}`,
          ...(cc.length ? [`Cc: ${cc.join(', ')}`] : []),
          `Subject: ${encWord(oneLine(subject))}`,
          ...(msgId ? [`In-Reply-To: ${oneLine(msgId)}`, `References: ${oneLine(refs)}`] : []),
          'MIME-Version: 1.0',
          `Content-Type: multipart/alternative; boundary="${boundary}"`,
          '',
          `--${boundary}`,
          'Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '', wrap76(b64(plain)),
          `--${boundary}`,
          'Content-Type: text/html; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '', wrap76(b64(html)),
          `--${boundary}--`, '',
        ].join('\r\n');
        const rawUrl = b64(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        const sent = await gfetch(token, '/messages/send', { method: 'POST', body: JSON.stringify({ raw: rawUrl, threadId }) }, GMAIL);
        return json(req, { ok: true, id: sent.id, threadId: sent.threadId });
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
