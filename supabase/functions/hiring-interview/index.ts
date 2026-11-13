import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

// HQ → Hiring: schedule / reschedule / cancel a Google Meet interview with an applicant.
// Creates the event on the owner's Google Calendar (with a fresh Meet link), adds the applicant
// as a guest, and emails them a branded invite from the owner's Gmail.
//   schedule   { candidate_id, start (ISO), minutes? }   (also used to reschedule)
//   cancel     { candidate_id, notify? }
const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
const CLIENT_ID = (Deno.env.get('GOOGLE_CLIENT_ID') ?? '').trim();
const CLIENT_SECRET = (Deno.env.get('GOOGLE_CLIENT_SECRET') ?? '').trim();
const CAL = 'https://www.googleapis.com/calendar/v3';
const SITE = 'https://knoxview.com';
const TZ = 'America/New_York';
const ORIGINS = ['https://hq.knoxview.com', 'https://knoxview-hq.netlify.app'];

function cors(req: Request) {
  const o = req.headers.get('origin') ?? '';
  return {
    'Access-Control-Allow-Origin': ORIGINS.includes(o) ? o : ORIGINS[0],
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  };
}
const json = (req: Request, body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors(req), 'Content-Type': 'application/json' } });
class Bad extends Error {}

async function ownerToken() {
  const { data: owner } = await admin.from('team_members').select('id').eq('role', 'owner').eq('active', true).order('created_at').limit(1).maybeSingle();
  if (!owner) throw new Bad('No owner account found.');
  const { data: acct } = await admin.from('google_accounts').select('*').eq('member_id', owner.id).maybeSingle();
  if (!acct) throw new Bad('Connect Google on the Calendar page first.');
  if (acct.access_token && acct.access_expires_at && new Date(acct.access_expires_at).getTime() > Date.now() + 60_000) return { token: acct.access_token as string, gmail: String(acct.scope || '').includes('gmail'), email: acct.email as string };
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, grant_type: 'refresh_token', refresh_token: acct.refresh_token }),
  });
  const t = await r.json();
  if (!r.ok) throw new Bad('Google connection expired. Reconnect Google on the Calendar page.');
  await admin.from('google_accounts').update({ access_token: t.access_token, access_expires_at: new Date(Date.now() + (t.expires_in ?? 3600) * 1000).toISOString(), updated_at: new Date().toISOString() }).eq('member_id', owner.id);
  return { token: t.access_token as string, gmail: String(acct.scope || '').includes('gmail'), email: acct.email as string };
}
async function gcal(token: string, path: string, init: RequestInit = {}) {
  const r = await fetch(CAL + path, { ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers || {}) } });
  if (r.status === 204 || r.status === 410) return {};
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Bad(d?.error?.message || `Google Calendar error ${r.status}`);
  return d;
}

/* ---------- email ---------- */
function b64(str: string) {
  const bytes = new TextEncoder().encode(str); let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
const wrap76 = (s: string) => s.replace(/.{1,76}/g, '$&\r\n');
const escHtml = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
type Btn = { label: string; url: string; primary?: boolean };
function emailHtml(first: string, paras: string[], buttons: Btn[], after: string[] = []) {
  const p = (t: string) => `<p style="margin:0 0 16px">${t}</p>`;
  const btn = (b: Btn) => b.primary
    ? `<a href="${b.url}" style="display:inline-block;background:#1f3c66;color:#ffffff;text-decoration:none;padding:13px 24px;border-radius:999px;font-weight:bold;font-size:15px">${escHtml(b.label)}</a>`
    : `<a href="${b.url}" style="display:inline-block;color:#1f3c66;text-decoration:none;padding:12px 22px;border-radius:999px;font-weight:bold;font-size:15px;border:1.5px solid #1f3c66">${escHtml(b.label)}</a>`;
  return `<!doctype html><html><body style="margin:0;padding:0;background:#eef2f7">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef2f7;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:14px;overflow:hidden">
<tr><td bgcolor="#0d1726" style="background:#0d1726;padding:0;line-height:0;font-size:0"><img src="${SITE}/img/email-header.jpg" width="560" alt="Knox View Real Estate Media · Careers" style="display:block;width:100%;max-width:560px;height:auto;border:0;color:#e7edf6;font-family:Georgia,serif;font-size:20px;line-height:1.4"></td></tr>
<tr><td style="padding:28px;font-family:Arial,sans-serif;font-size:15px;line-height:1.6;color:#1f3c66">
${p(`Hi ${escHtml(first)},`)}${paras.map(p).join('')}
${buttons.map(b => `<div style="margin:0 0 12px">${btn(b)}</div>`).join('')}
${after.map(t => `<p style="margin:16px 0 0">${t}</p>`).join('')}
<p style="margin:24px 0 0">Chris<br>Knox View Media</p>
</td></tr>
<tr><td style="padding:16px 28px;background:#f6f8fb;font-family:Arial,sans-serif;font-size:12px;color:#6b7c93">Knox View Real Estate Media · Knoxville, TN</td></tr>
</table></td></tr></table></body></html>`;
}
async function sendEmail(token: string, to: string, subject: string, plain: string, html: string) {
  const boundary = 'kvint_' + crypto.randomUUID().replace(/-/g, '');
  const subj = /^[\x20-\x7e]*$/.test(subject) ? subject : `=?UTF-8?B?${b64(subject)}?=`;
  const raw = [
    `To: ${to}`, `Subject: ${subj}`, 'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`, '',
    `--${boundary}`, 'Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '', wrap76(b64(plain)),
    `--${boundary}`, 'Content-Type: text/html; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '', wrap76(b64(html)),
    `--${boundary}--`, '',
  ].join('\r\n');
  const r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw: b64(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') }),
  });
  if (!r.ok) console.error('gmail send failed', r.status, await r.text());
  return r.ok;
}
const whenText = (d: Date) => new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(d);
const gcalStamp = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors(req) });
  try {
    const body = await req.json().catch(() => ({}));
    const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    const { data: u } = await admin.auth.getUser(jwt);
    if (!u?.user) return json(req, { error: 'Not signed in' }, 401);
    const uid = u.user.id;
    const { data: allowed } = await admin.rpc('member_can', { member: uid, k: 'hiring' });
    if (!allowed) return json(req, { error: "You don't have access to Hiring in HQ" }, 403);

    const { data: c } = await admin.from('candidates').select('id, first_name, last_name, email, stage, interview_at, interview_event_id, interview_status, opening_id, job_openings(title)').eq('id', String(body.candidate_id || '')).maybeSingle();
    if (!c) throw new Bad('Applicant not found.');
    if (!c.email) throw new Bad('This applicant has no email on file.');
    const name = [c.first_name, c.last_name].filter(Boolean).join(' ') || 'Applicant';
    const first = c.first_name || 'there';
    const title = (c as any).job_openings?.title || 'open';
    const g = await ownerToken();

    if (body.action === 'schedule') {
      const start = new Date(String(body.start || ''));
      if (isNaN(start.getTime())) throw new Bad('Pick a date and time.');
      if (start.getTime() < Date.now() - 5 * 60_000) throw new Bad('That time is in the past.');
      const minutes = Math.min(180, Math.max(10, Number(body.minutes) || 30));
      const end = new Date(start.getTime() + minutes * 60_000);
      const resched = !!(c.interview_event_id && c.interview_status === 'scheduled');
      const event: Record<string, unknown> = {
        summary: `Interview: ${name} (Knox View Media)`,
        description: `${minutes}-minute interview for the ${title} role.\nApplicant: ${name} · ${c.email}\nScheduled from Knox View HQ.`,
        start: { dateTime: start.toISOString(), timeZone: TZ },
        end: { dateTime: end.toISOString(), timeZone: TZ },
        attendees: [{ email: c.email, displayName: name }],
        reminders: { useDefault: true },
        guestsCanModify: false, guestsCanInviteOthers: false,
      };
      let ev: any;
      if (resched) {
        ev = await gcal(g.token, `/calendars/primary/events/${encodeURIComponent(c.interview_event_id!)}?conferenceDataVersion=1&sendUpdates=none`, { method: 'PATCH', body: JSON.stringify(event) });
      } else {
        event.conferenceData = { createRequest: { requestId: crypto.randomUUID(), conferenceSolutionKey: { type: 'hangoutsMeet' } } };
        ev = await gcal(g.token, `/calendars/primary/events?conferenceDataVersion=1&sendUpdates=none`, { method: 'POST', body: JSON.stringify(event) });
      }
      // Meet link is usually ready immediately; poll briefly if it's still being created
      let meet = ev.hangoutLink || (ev.conferenceData?.entryPoints || []).find((e: any) => e.entryPointType === 'video')?.uri || null;
      for (let k = 0; !meet && k < 4; k++) {
        await new Promise(r => setTimeout(r, 800));
        const e2: any = await gcal(g.token, `/calendars/primary/events/${encodeURIComponent(ev.id)}`);
        meet = e2.hangoutLink || (e2.conferenceData?.entryPoints || []).find((e: any) => e.entryPointType === 'video')?.uri || null;
      }
      if (!meet) throw new Bad('Google didn\'t create a Meet link. Check that Google Meet is turned on for your Google Workspace.');

      const upd: Record<string, unknown> = { interview_at: start.toISOString(), interview_minutes: minutes, interview_meet_url: meet, interview_event_id: ev.id, interview_status: 'scheduled' };
      if (['new', 'screened', 'video_review'].includes(c.stage)) upd.stage = 'interview';
      await admin.from('candidates').update(upd).eq('id', c.id);
      await admin.from('candidate_activity').insert({ candidate_id: c.id, actor_id: uid, action: resched ? 'interview_rescheduled' : 'interview_scheduled', note: `${resched ? 'Rescheduled' : 'Scheduled'} Google Meet interview for ${whenText(start)}` });

      const when = whenText(start);
      const addCal = `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent('Interview with Knox View Media')}&dates=${gcalStamp(start)}/${gcalStamp(end)}&details=${encodeURIComponent(`Join with Google Meet: ${meet}`)}&location=${encodeURIComponent(meet)}`;
      const lead = resched
        ? `Your interview for the <b>${escHtml(title)}</b> role at Knox View Media has been <b>moved to a new time</b>.`
        : `Great news! We'd love to meet you. You're invited to a ${minutes}-minute video interview for the <b>${escHtml(title)}</b> role at Knox View Media.`;
      const box = `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;background:#f1f5fa;border-radius:12px"><tr><td style="padding:16px 18px;font-size:15px;line-height:1.6;color:#1f3c66">`
        + `<div style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#6b7c93;font-weight:bold">When</div><div style="font-weight:bold;margin-bottom:10px">${escHtml(when)} · ${minutes} min</div>`
        + `<div style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#6b7c93;font-weight:bold">Where</div><div>Google Meet (video call): <a href="${meet}" style="color:#1f3c66">${escHtml(meet.replace(/^https?:\/\//, ''))}</a></div></td></tr></table>`;
      const html = emailHtml(first, [lead, box, `Join from your phone or computer. On a phone, the free Google Meet app works best. Find a quiet spot with good light, and join a minute or two early.`],
        [{ label: 'Join Google Meet', url: meet, primary: true }, { label: 'Add to my calendar', url: addCal }],
        [`Need a different time? Just reply to this email.`]);
      const plain = `Hi ${first},\n\n${resched ? `Your interview for the ${title} role at Knox View Media has been moved to a new time.` : `Great news! We'd love to meet you. You're invited to a ${minutes}-minute video interview for the ${title} role at Knox View Media.`}\n\nWhen: ${when} (${minutes} min)\nWhere: Google Meet - ${meet}\n\nJoin from your phone or computer. On a phone, the free Google Meet app works best.\n\nAdd to your calendar: ${addCal}\n\nNeed a different time? Just reply to this email.\n\nChris\nKnox View Media`;
      const emailed = g.gmail ? await sendEmail(g.token, c.email, resched ? 'Your interview has a new time' : 'Your interview with Knox View Media', plain, html) : false;
      return json(req, { ok: true, interview_at: start.toISOString(), interview_minutes: minutes, interview_meet_url: meet, interview_event_id: ev.id, emailed, stage: upd.stage || c.stage });
    }

    if (body.action === 'cancel') {
      if (c.interview_event_id) await gcal(g.token, `/calendars/primary/events/${encodeURIComponent(c.interview_event_id)}?sendUpdates=none`, { method: 'DELETE' }).catch(() => ({}));
      const was = c.interview_at ? whenText(new Date(c.interview_at)) : null;
      await admin.from('candidates').update({ interview_status: 'canceled', interview_event_id: null, interview_meet_url: null }).eq('id', c.id);
      await admin.from('candidate_activity').insert({ candidate_id: c.id, actor_id: uid, action: 'interview_canceled', note: `Canceled interview${was ? ` (${was})` : ''}` });
      let emailed = false;
      if (body.notify !== false && g.gmail) {
        const html = emailHtml(first, [`We need to cancel your interview${was ? ` scheduled for <b>${escHtml(was)}</b>` : ''} for the <b>${escHtml(title)}</b> role. Sorry for the change!`, `We'll be in touch if we're able to find a new time.`], []);
        const plain = `Hi ${first},\n\nWe need to cancel your interview${was ? ` scheduled for ${was}` : ''} for the ${title} role. Sorry for the change!\n\nWe'll be in touch if we're able to find a new time.\n\nChris\nKnox View Media`;
        emailed = await sendEmail(g.token, c.email, 'Your interview has been canceled', plain, html);
      }
      return json(req, { ok: true, emailed });
    }

    if (body.action === 'done') {
      await admin.from('candidates').update({ interview_status: 'done' }).eq('id', c.id);
      await admin.from('candidate_activity').insert({ candidate_id: c.id, actor_id: uid, action: 'interview_done', note: 'Marked the interview as done' });
      return json(req, { ok: true });
    }
    throw new Bad('Unknown action.');
  } catch (e) {
    if (e instanceof Bad) return json(req, { error: e.message }, 400);
    console.error(e);
    return json(req, { error: 'Something went wrong. Please try again.' }, 500);
  }
});
