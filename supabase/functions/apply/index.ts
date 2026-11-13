import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

// Public job application endpoint for knoxview.com/apply.
// No login: every action is validated here and runs with the service role.
//   opening    -> job title + video questions
//   submit     -> creates the candidate, returns a signed upload URL for the resume and the interview token
//   resume_done-> confirms the resume upload
//   interview  -> interview state for a token (questions + which are recorded)
//   video_url  -> signed upload URL for one answer
//   video_done -> confirms one answer; when all are in, marks the interview complete
const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
const CLIENT_ID = (Deno.env.get('GOOGLE_CLIENT_ID') ?? '').trim();
const CLIENT_SECRET = (Deno.env.get('GOOGLE_CLIENT_SECRET') ?? '').trim();
const SITE = 'https://knoxview.com';
const BUCKET = 'hiring';
const ORIGINS = ['https://knoxview.com', 'https://www.knoxview.com', 'https://hq.knoxview.com'];
const okOrigin = (o: string) => ORIGINS.includes(o) || /^https:\/\/[a-z0-9-]+--knoxview[a-z0-9-]*\.netlify\.app$/.test(o) || /^https:\/\/knoxview[a-z0-9-]*\.netlify\.app$/.test(o);

function cors(req: Request) {
  const o = req.headers.get('origin') ?? '';
  return {
    'Access-Control-Allow-Origin': okOrigin(o) ? o : ORIGINS[0],
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  };
}
const json = (req: Request, body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors(req), 'Content-Type': 'application/json' } });
class Bad extends Error {}

const clean = (v: unknown, max = 200) => String(v ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, max);
const EMAIL_RE = /^[^\s@<>",;]+@[^\s@<>",;]+\.[a-z]{2,}$/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RESUME_TYPES: Record<string, string> = {
  'application/pdf': 'pdf', 'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/heic': 'heic', 'image/webp': 'webp',
};
const VIDEO_TYPES: Record<string, string> = { 'video/webm': 'webm', 'video/mp4': 'mp4', 'video/quicktime': 'mov' };

async function sha(s: string) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d)).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}
async function objectExists(path: string) {
  const i = path.lastIndexOf('/');
  const { data } = await admin.storage.from(BUCKET).list(path.slice(0, i), { search: path.slice(i + 1), limit: 5 });
  return (data || []).some(f => f.name === path.slice(i + 1));
}
async function candidateByToken(token: unknown) {
  const t = String(token || '');
  if (!UUID_RE.test(t)) throw new Bad('That interview link is not valid.');
  const { data } = await admin.from('candidates').select('id, first_name, last_name, email, videos, video_started_at, video_completed_at, opening_id, job_openings(title, video_questions)').eq('video_token', t).maybeSingle();
  if (!data) throw new Bad('That interview link is not valid.');
  return data as any;
}

/* ---------- notify everyone who can see Hiring (owner always) ---------- */
async function notifyHiring(kind: string, title: string, body: string | null, candidateId: string) {
  const { data: team } = await admin.from('team_members').select('id, role, permissions').eq('active', true);
  const { data: ra } = await admin.from('role_access').select('role, perms');
  const def = Object.fromEntries((ra || []).map((r: any) => [r.role, r.perms || {}]));
  const ids = (team || []).filter((t: any) => t.role === 'owner' || (t.permissions && 'hiring' in t.permissions ? !!t.permissions.hiring : !!def[t.role]?.hiring)).map((t: any) => t.id);
  if (ids.length) await admin.from('notifications').insert(ids.map(id => ({ member_id: id, kind, title, body, candidate_id: candidateId })));
}

/* ---------- confirmation email from the owner's Gmail (best effort) ---------- */
function b64(str: string) {
  const bytes = new TextEncoder().encode(str); let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
const wrap76 = (s: string) => s.replace(/.{1,76}/g, '$&\r\n');
const escHtml = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
async function ownerGmailToken() {
  if (!CLIENT_ID || !CLIENT_SECRET) return null;
  const { data: owner } = await admin.from('team_members').select('id').eq('role', 'owner').eq('active', true).order('created_at').limit(1).maybeSingle();
  if (!owner) return null;
  const { data: acct } = await admin.from('google_accounts').select('*').eq('member_id', owner.id).maybeSingle();
  if (!acct || !String(acct.scope || '').includes('gmail')) return null;
  if (acct.access_token && acct.access_expires_at && new Date(acct.access_expires_at).getTime() > Date.now() + 60_000) return acct.access_token as string;
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, grant_type: 'refresh_token', refresh_token: acct.refresh_token }),
  });
  const t = await r.json();
  if (!r.ok) return null;
  await admin.from('google_accounts').update({ access_token: t.access_token, access_expires_at: new Date(Date.now() + (t.expires_in ?? 3600) * 1000).toISOString(), updated_at: new Date().toISOString() }).eq('member_id', owner.id);
  return t.access_token as string;
}
async function sendInterviewEmail(to: string, first: string, title: string, link: string) {
  try {
    const token = await ownerGmailToken();
    if (!token) return false;
    const plain = `Hi ${first},\n\nThanks for applying to be a ${title} with Knox View Media! We read every application.\n\nLast step: a quick one-minute video so we can meet you. Record it right from your phone or computer, whenever it works for you.\n\nRecord your video: ${link}\n\nIf you already recorded it, you're all set. We'll reach out if it looks like a fit.\n\nChris\nKnox View Media`;
    const html = `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.55;color:#1f3c66">
<p>Hi ${escHtml(first)},</p>
<p>Thanks for applying to be a <b>${escHtml(title)}</b> with Knox View Media! We read every application.</p>
<p><b>Last step: a quick one-minute video</b> so we can meet you. Record it right from your phone or computer, whenever it works for you.</p>
<p><a href="${link}" style="display:inline-block;background:#1f3c66;color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:bold">Record my one-minute video</a></p>
<p style="font-size:13px;color:#5f7389">Or paste this link into your browser: ${link}</p>
<p>If you already recorded it, you're all set. We'll reach out if it looks like a fit.</p>
<p>Chris<br>Knox View Media</p></div>`;
    const boundary = 'kvapply_' + crypto.randomUUID().replace(/-/g, '');
    const subj = 'Last step: your one-minute Knox View video';
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
    return r.ok;
  } catch (_) { return false; }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors(req) });
  if (req.method !== 'POST') return json(req, { error: 'Method not allowed' }, 405);
  let b: Record<string, any>;
  try { b = await req.json(); } catch { return json(req, { error: 'Bad request' }, 400); }
  try {
    switch (b.action) {
      case 'opening': {
        const { data } = await admin.from('job_openings').select('id, slug, title, status, location, pay_range, hours, video_questions, interview_url').eq('slug', clean(b.slug || 'creative-media-specialist', 80)).maybeSingle();
        if (!data) throw new Bad('Opening not found.');
        return json(req, { title: data.title, open: data.status === 'open', location: data.location, pay: data.pay_range, hours: data.hours, questions: (data.video_questions || []).length, interview_url: data.interview_url || null });
      }

      case 'submit': {
        if (clean(b.company)) return json(req, { ok: true, token: crypto.randomUUID() }); // honeypot: pretend it worked
        const { data: op } = await admin.from('job_openings').select('id, title, status, interview_url').eq('slug', clean(b.slug || 'creative-media-specialist', 80)).maybeSingle();
        if (!op || op.status !== 'open') throw new Bad('This position is not accepting applications right now.');
        const f = {
          first_name: clean(b.first_name, 60), last_name: clean(b.last_name, 60),
          email: clean(b.email, 160).toLowerCase(), phone: clean(b.phone, 40), city: clean(b.city, 80),
          website_url: clean(b.website, 300),
        };
        const answers = { why: clean(b.why, 4000), availability: clean(b.availability, 2000), friends: clean(b.friends, 2000) };
        if (!f.first_name || !f.last_name) throw new Bad('Please enter your first and last name.');
        if (!EMAIL_RE.test(f.email)) throw new Bad('Please enter a valid email address.');
        if (f.phone.replace(/\D/g, '').length < 10) throw new Bad('Please enter a valid phone number.');
        if (!f.city) throw new Bad('Please tell us what city you live in.');
        if (answers.why.length < 20) throw new Bad('Please tell us a little more about why you\'d be great at this role.');
        if (!answers.availability) throw new Bad('Please share your availability.');
        if (!answers.friends) throw new Bad('Please answer what your friends or coworkers would say.');
        if (f.website_url && !/^https?:\/\//i.test(f.website_url)) f.website_url = 'https://' + f.website_url;
        let resume: { type: string; name: string; ext: string } | null = null;
        if (b.resume) {
          const type = clean(b.resume.type, 120).toLowerCase(), size = Number(b.resume.size) || 0;
          if (!RESUME_TYPES[type]) throw new Bad('Resume must be a PDF, Word document or photo.');
          if (size > 4 * 1024 * 1024) throw new Bad('Resume must be 4 MB or smaller.');
          resume = { type, name: clean(b.resume.name, 140) || 'resume', ext: RESUME_TYPES[type] };
        }
        const ip = (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || req.headers.get('cf-connecting-ip') || '';
        const ipHash = ip ? await sha('kv-apply:' + ip) : null;
        if (ipHash) {
          const { count } = await admin.from('candidates').select('id', { count: 'exact', head: true }).eq('ip_hash', ipHash).gte('created_at', new Date(Date.now() - 3600_000).toISOString());
          if ((count ?? 0) >= 5) throw new Bad('Too many applications from this connection. Please try again later.');
        }
        // Same person applying again to the same opening: update instead of duplicating
        const { data: prev } = await admin.from('candidates').select('id, video_token, stage').eq('opening_id', op.id).ilike('email', f.email).order('created_at', { ascending: false }).limit(1).maybeSingle();
        let id: string, token: string;
        if (prev) {
          const { error } = await admin.from('candidates').update({ ...f, answers, applied_at: new Date().toISOString(), user_agent: clean(req.headers.get('user-agent'), 300), ip_hash: ipHash }).eq('id', prev.id);
          if (error) throw error;
          id = prev.id; token = prev.video_token;
          await admin.from('candidate_activity').insert({ candidate_id: id, action: 'reapplied', note: 'Submitted the application form again' });
        } else {
          const { data, error } = await admin.from('candidates').insert({ ...f, answers, opening_id: op.id, source: 'website', user_agent: clean(req.headers.get('user-agent'), 300), ip_hash: ipHash }).select('id, video_token').single();
          if (error) throw error;
          id = data.id; token = data.video_token;
          await admin.from('candidate_activity').insert({ candidate_id: id, action: 'applied', note: 'Applied on knoxview.com/apply' });
          await notifyHiring('application', `New applicant: ${f.first_name} ${f.last_name}`, `${op.title} · ${f.city}`, id);
        }
        let upload = null;
        if (resume) {
          const path = `resumes/${id}/resume-${Date.now()}.${resume.ext}`;
          const { data: su, error } = await admin.storage.from(BUCKET).createSignedUploadUrl(path);
          if (error) throw error;
          upload = { url: su.signedUrl, path, name: resume.name };
        }
        // External interview tool (e.g. HireVire) when set on the opening; otherwise the built-in recorder
        const ext = /^https:\/\//i.test(op.interview_url || '') ? op.interview_url : null;
        const link = ext || `${SITE}/apply?i=${token}`;
        const emailed = await sendInterviewEmail(f.email, f.first_name, op.title, link);
        return json(req, { ok: true, token, upload, emailed, interview_url: ext });
      }

      case 'resume_done': {
        const c = await candidateByToken(b.token);
        const path = clean(b.path, 300);
        if (!path.startsWith(`resumes/${c.id}/`) || !(await objectExists(path))) throw new Bad('Resume upload not found.');
        await admin.from('candidates').update({ resume_path: path, resume_name: clean(b.name, 140) || null }).eq('id', c.id);
        return json(req, { ok: true });
      }

      case 'interview': {
        const c = await candidateByToken(b.token);
        const qs = c.job_openings?.video_questions || [];
        return json(req, {
          first_name: c.first_name, title: c.job_openings?.title,
          questions: qs.map((q: any, i: number) => ({ i, q: q.q, seconds: q.seconds || 60, done: (c.videos || []).some((v: any) => v.i === i) })),
          completed: !!c.video_completed_at,
        });
      }

      case 'video_url': {
        const c = await candidateByToken(b.token);
        const qs = c.job_openings?.video_questions || [];
        const i = Number(b.i);
        if (!Number.isInteger(i) || i < 0 || i >= qs.length) throw new Bad('Unknown question.');
        const mime = clean(b.mime, 80).toLowerCase().split(';')[0];
        if (!VIDEO_TYPES[mime]) throw new Bad('That video format is not supported.');
        if ((Number(b.size) || 0) > 50 * 1024 * 1024) throw new Bad('That video is too large (50 MB max). Try a shorter take.');
        const path = `videos/${c.id}/q${i + 1}-${Date.now()}.${VIDEO_TYPES[mime]}`;
        const { data: su, error } = await admin.storage.from(BUCKET).createSignedUploadUrl(path);
        if (error) throw error;
        if (!c.video_started_at) await admin.from('candidates').update({ video_started_at: new Date().toISOString() }).eq('id', c.id);
        return json(req, { url: su.signedUrl, path });
      }

      case 'video_done': {
        const c = await candidateByToken(b.token);
        const qs = c.job_openings?.video_questions || [];
        const i = Number(b.i), path = clean(b.path, 300);
        if (!Number.isInteger(i) || i < 0 || i >= qs.length) throw new Bad('Unknown question.');
        if (!path.startsWith(`videos/${c.id}/q${i + 1}-`) || !(await objectExists(path))) throw new Bad('Video upload not found. Please try again.');
        const old = (c.videos || []).filter((v: any) => v.i === i).map((v: any) => v.path);
        const videos = [...(c.videos || []).filter((v: any) => v.i !== i),
          { i, q: qs[i].q, path, seconds: Math.max(0, Math.min(600, Math.round(Number(b.seconds) || 0))), mime: clean(b.mime, 80).split(';')[0], uploaded_at: new Date().toISOString() }]
          .sort((a: any, z: any) => a.i - z.i);
        const complete = qs.every((_: unknown, k: number) => videos.some((v: any) => v.i === k));
        const upd: Record<string, unknown> = { videos };
        if (complete && !c.video_completed_at) upd.video_completed_at = new Date().toISOString();
        await admin.from('candidates').update(upd).eq('id', c.id);
        if (old.length) await admin.storage.from(BUCKET).remove(old);
        if (complete && !c.video_completed_at) {
          await admin.from('candidate_activity').insert({ candidate_id: c.id, action: 'video_done', note: 'Finished the video interview' });
          await notifyHiring('application', `Video interview done: ${c.first_name} ${c.last_name}`, c.job_openings?.title || null, c.id);
        }
        return json(req, { ok: true, complete });
      }

      default: throw new Bad('Unknown action.');
    }
  } catch (e) {
    if (e instanceof Bad) return json(req, { error: e.message }, 400);
    console.error(e);
    return json(req, { error: 'Something went wrong on our end. Please try again.' }, 500);
  }
});
