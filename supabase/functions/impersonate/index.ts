import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

// "View as" for the owner: returns a one-time sign-in token for an active team member,
// so the owner's browser tab can open HQ fully signed in as that person.
// Only the owner can call it; owners can't be impersonated; every start is logged.
const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors(req) });
  try {
    const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    const { data: u, error: ue } = await admin.auth.getUser(jwt);
    if (ue || !u?.user) return json(req, { error: 'Not signed in' }, 401);
    const { data: me } = await admin.from('team_members').select('id, role, active').eq('id', u.user.id).maybeSingle();
    if (!me?.active || me.role !== 'owner') return json(req, { error: 'Only the owner can view HQ as someone else' }, 403);

    const body = await req.json().catch(() => ({}));
    const target = String(body.member || '');
    const { data: t } = await admin.from('team_members').select('id, role, active, full_name').eq('id', target).maybeSingle();
    if (!t) return json(req, { error: 'Team member not found' }, 404);
    if (!t.active) return json(req, { error: `${t.full_name} has been removed from the team` }, 400);
    if (t.role === 'owner') return json(req, { error: 'Owners can’t be viewed as' }, 400);

    const { data: au, error: ae } = await admin.auth.admin.getUserById(t.id);
    if (ae || !au?.user?.email) return json(req, { error: 'That account has no sign-in email' }, 400);
    const { data: link, error: le } = await admin.auth.admin.generateLink({ type: 'magiclink', email: au.user.email });
    if (le || !link?.properties?.hashed_token) return json(req, { error: le?.message || 'Could not start the session' }, 500);

    await admin.from('impersonation_log').insert({ owner_id: me.id, target_id: t.id, user_agent: (req.headers.get('user-agent') || '').slice(0, 300) });
    return json(req, { token_hash: link.properties.hashed_token, name: t.full_name });
  } catch (e) {
    console.error('impersonate error:', String((e as Error)?.message || e));
    return json(req, { error: String((e as Error)?.message || e) }, 500);
  }
});
