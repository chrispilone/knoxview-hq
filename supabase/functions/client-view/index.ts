import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

// HQ → "Client's download page" / "View invoice": opens the client portal signed in as the order's client,
// so the owner sees exactly what the client sees. Only HQ owners / super admins can call it.
//   { bookingId } -> { email, session: { access_token, refresh_token } }

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
const anon = () => createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { auth: { persistSession: false, autoRefreshToken: false } });
const okOrigin = (o: string) => ['https://hq.knoxview.com', 'http://localhost:8888', 'http://localhost:5173'].includes(o) || /^https:\/\/([a-z0-9-]+--)?knoxview-hq[a-z0-9-]*\.netlify\.app$/.test(o);
const cors = (req: Request) => {
  const o = req.headers.get('origin') ?? '';
  return { 'Access-Control-Allow-Origin': okOrigin(o) ? o : 'https://hq.knoxview.com', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Vary': 'Origin' };
};
const json = (req: Request, body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors(req), 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors(req) });
  try {
    const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    const { data: u } = jwt.split('.').length === 3 ? await admin.auth.getUser(jwt) : { data: null };
    const uid = u?.user?.id;
    const { data: me } = uid ? await admin.from('team_members').select('id, role, active, permissions').eq('id', uid).maybeSingle() : { data: null };
    if (!me?.active || !(me.role === 'owner' || me.permissions?.super_admin === true)) return json(req, { error: 'Only HQ super admins can open a client\'s portal.' }, 403);

    const b = await req.json().catch(() => ({}));
    const id = String(b.bookingId || '');
    if (!/^[0-9a-f-]{36}$/i.test(id)) return json(req, { error: 'Unknown order' }, 400);
    const { data: bk } = await admin.from('bookings').select('id, agent_id, client_email').eq('id', id).maybeSingle();
    if (!bk) return json(req, { error: 'Order not found' }, 404);
    const { data: agent } = bk.agent_id ? await admin.from('agents').select('email').eq('id', bk.agent_id).maybeSingle() : { data: null };
    const email = String(agent?.email || bk.client_email || '').trim().toLowerCase();
    if (!email) return json(req, { error: 'This order has no client email, so there is no client portal to open.' }, 400);

    let r = await admin.auth.admin.generateLink({ type: 'magiclink', email });
    if (r.error) { // client has never signed in: make their login, then try again
      const c = await admin.auth.admin.createUser({ email, email_confirm: true, user_metadata: { portal: 'client' } });
      if (c.error && !/already/i.test(c.error.message)) throw c.error;
      r = await admin.auth.admin.generateLink({ type: 'magiclink', email });
    }
    if (r.error || !r.data.properties?.hashed_token) throw r.error || new Error('No login link');
    const { data, error } = await anon().auth.verifyOtp({ token_hash: r.data.properties.hashed_token, type: 'magiclink' });
    if (error || !data.session) throw error || new Error('No session');
    console.log('client-view', me.id, 'opened portal for booking', bk.id);
    return json(req, { email, session: { access_token: data.session.access_token, refresh_token: data.session.refresh_token } });
  } catch (e) {
    console.error('client-view error', String((e as Error)?.message || e));
    return json(req, { error: 'Could not open the client portal. Please try again.' }, 500);
  }
});
