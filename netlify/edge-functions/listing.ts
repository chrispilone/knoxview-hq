// Single property websites: https://listing.knoxview.com/<slug> (branded) and /<slug>/mls (unbranded, MLS-safe).
// Lives on the HQ Netlify site (listing.knoxview.com is a domain alias there). Also reachable on any host of this site at
// /l/<slug>[/mls] (testing and deploy previews).
// Data comes from the Supabase `listing` function; this draws the page in the order's design (TEMPLATES below).
// The Cooper (`cooper`) is the default design. New designs: add a render function and list it in TEMPLATES (and in the
// listing function's TEMPLATES so clients can pick it).
// Photos go through Netlify Image CDN (/.netlify/images), resized per screen and cached.
import type { Config, Context } from '@netlify/edge-functions';

const API = 'https://sqlkswwwpkzadrrbhqip.supabase.co/functions/v1/listing';
const HOSTS = ['listing.knoxview.com'];

export default async (req: Request, _ctx: Context) => {
  const url = new URL(req.url);
  let path = url.pathname;
  const onListingHost = HOSTS.includes(url.hostname);
  if (!onListingHost) {
    if (!path.startsWith('/l/')) return; // the booking portal: carry on
    path = path.slice(2);
  }
  const parts = path.split('/').filter(Boolean).map(p => decodeURIComponent(p).toLowerCase());
  if (!parts.length) return Response.redirect('https://knoxview.com', 302);
  if (parts[0] === 'robots.txt') return new Response('User-agent: *\nDisallow: /*/mls\n', { headers: { 'content-type': 'text/plain' } });
  if (parts[0] === 'favicon.ico') return Response.redirect('https://book.knoxview.com/icon-192.png', 302);
  const slug = parts[0].replace(/[^a-z0-9-]/g, '');
  const mls = parts[1] === 'mls';
  if (parts.length > 2 || (parts[1] && !mls)) return Response.redirect(`${url.origin}${onListingHost ? '' : '/l'}/${slug}${url.search}`, 302);
  const preview = url.searchParams.get('preview') || undefined;
  const base = onListingHost ? '' : '/l';

  let data: any = null, status = 200;
  try {
    const r = await fetch(API, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'page', slug, mls, preview }) });
    status = r.status; data = await r.json();
  } catch (_) { status = 502; }
  const noStore = !!preview;
  const headers = {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': noStore ? 'private, no-store' : 'public, max-age=0, must-revalidate',
    'netlify-cdn-cache-control': noStore ? 'no-store' : 'public, s-maxage=120, stale-while-revalidate=600',
    'x-robots-tag': mls || data?.preview ? 'noindex' : 'all',
    'netlify-vary': 'query=preview', // preview links never share a cached copy with the public page
  };
  if (status === 404 || data?.missing) return new Response(offPage('Listing not found', "We couldn't find this property website."), { status: 404, headers });
  if (!data || data.error || status >= 500) return new Response(offPage('Something went wrong', 'Please try again in a minute.'), { status: 502, headers: { ...headers, 'netlify-cdn-cache-control': 'no-store' } });
  if (data.off) return new Response(offPage(data.title || 'Property website', 'This property website is not available right now.'), { status: 200, headers });
  const draw = TEMPLATES[data.template] || TEMPLATES.cooper;
  return new Response(draw(data, { origin: url.origin, base, preview }), { status: 200, headers });
};

export const config: Config = {
  path: '/*',
  excludedPath: ['/.netlify/*', '/*.js', '/*.css', '/*.png', '/*.jpg', '/*.svg', '/*.webmanifest', '/*.html'],
  cache: 'manual',
};

/* ------------------------------------------------------------------ */
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const img = (u: string, w: number, h?: number) => `/.netlify/images?url=${encodeURIComponent(u)}&w=${w}${h ? `&h=${h}&fit=cover` : ''}&q=${w > 1600 ? 80 : 72}`;
const srcset = (u: string, ws = [640, 1080, 1600, 2048]) => ws.map(w => `${img(u, w)} ${w}w`).join(', ');
const tel = (p: string) => String(p || '').replace(/[^\d+]/g, '').replace(/^(\d{10})$/, '+1$1');

const ICON: Record<string, string> = {
  price: '<path d="M12 3v18M16.5 7.5c0-1.7-2-3-4.5-3s-4.5 1.3-4.5 3 1.6 2.7 4.5 3.3 4.5 1.6 4.5 3.4-2 3.3-4.5 3.3-4.5-1.4-4.5-3.2"/>',
  bed: '<path d="M3 18v-7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v7M3 14h18M3 18v2M21 18v2M6 9V6.5A1.5 1.5 0 0 1 7.5 5h3A1.5 1.5 0 0 1 12 6.5V9M12 9V6.5A1.5 1.5 0 0 1 13.5 5h3A1.5 1.5 0 0 1 18 6.5V9"/>',
  bath: '<path d="M4 12h16v2a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5v-2ZM6 12V5.5A2.5 2.5 0 0 1 8.5 3c1 0 1.8.6 2.2 1.4M7 19l-1 2M17 19l1 2"/>',
  size: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5M4 4l6 6M20 4l-6 6M4 20l6-6M20 20l-6-6"/>',
  lot: '<path d="M12 21v-6M12 15c3.9 0 6-2.6 6-6.2C18 5.6 15.3 3 12 3S6 5.6 6 8.8C6 12.4 8.1 15 12 15ZM5 21h14"/>',
  year: '<rect x="3.5" y="5" width="17" height="15.5" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
  garage: '<path d="M3 21V9l9-6 9 6v12M7 21v-8h10v8M7 16h10"/>',
  home: '<path d="M3 11.5 12 4l9 7.5M5.5 9.5V20h13V9.5M10 20v-5.5h4V20"/>',
  pool: '<path d="M2 18c2 0 2-1.5 4-1.5s2 1.5 4 1.5 2-1.5 4-1.5 2 1.5 4 1.5 2-1.5 4-1.5M8 15V5.5a2 2 0 0 1 4 0M16 15V5.5a2 2 0 0 0-4 0M8 9h8M8 12.5h8"/>',
  view: '<path d="M3 19 9.5 9l4 6 2.5-3.5L21 19H3ZM16.5 7.5a1.5 1.5 0 1 0 0-.01"/>',
  star: '<path d="m12 3.5 2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.3-4.1 5.9-.9L12 3.5Z"/>',
  phone: '<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2"/>',
  chat: '<path d="M21 12a8 8 0 0 1-11.8 7L4 20l1.1-4.6A8 8 0 1 1 21 12Z"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3.5 6.5 8.5 6.5 8.5-6.5"/>',
  share: '<path d="M12 15V3M8 7l4-4 4 4M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/>',
  play: '<path d="M8 5.5v13l11-6.5L8 5.5Z" fill="currentColor"/>',
  cube: '<path d="M12 3 20 7.5v9L12 21l-8-4.5v-9L12 3ZM12 12l8-4.5M12 12v9M12 12 4 7.5"/>',
  grid: '<rect x="3.5" y="3.5" width="7" height="7" rx="1"/><rect x="13.5" y="3.5" width="7" height="7" rx="1"/><rect x="3.5" y="13.5" width="7" height="7" rx="1"/><rect x="13.5" y="13.5" width="7" height="7" rx="1"/>',
  pin: '<path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21Z"/><circle cx="12" cy="9.5" r="2.5"/>',
  plan: '<path d="M3.5 3.5h17v17h-17zM3.5 12h7M14 3.5V9M14 13v7.5M10.5 12V7"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9S14.5 18.4 12 21c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3Z"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>', left: '<path d="M15 5l-7 7 7 7"/>', right: '<path d="M9 5l7 7-7 7"/>',
  expand: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>', arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>', check: '<path d="M5 12.5 10 17l9-10"/>',
};
const ICON_EYE = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>';
const ic = (k: string, s = 20) => `<svg class="i" width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[k] || ICON.star}</svg>`;

/* ===== The Cooper (default design) ===== */
function renderCooper(d: any, o: { origin: string; base: string; preview?: string }) {
  const photos: { u: string }[] = d.photos || [];
  const hero = photos[0]?.u;
  const a = d.agent, mls = !!d.mls;
  const price = (d.facts || []).find((f: any) => f.icon === 'price');
  const stats = (d.facts || []).filter((f: any) => f !== price);
  const pageUrl = `${o.origin}${o.base}/${d.slug}${mls ? '/mls' : ''}`;
  const desc = String(d.description || '').trim();
  const metaDesc = (desc || [price?.value, ...stats.map((f: any) => `${f.value} ${/bed|bath/i.test(f.label) ? f.label.toLowerCase() : ''}`.trim()), d.address.full].filter(Boolean).join(' · ')).replace(/\s+/g, ' ').slice(0, 180);
  const title = `${d.title}${price ? ' · ' + price.value : ''}`;
  const nav = [
    desc || stats.length ? ['overview', 'Overview'] : null,
    photos.length > 1 ? ['photos', 'Photos'] : null,
    d.videos?.length ? ['film', d.videos.length > 1 ? 'Videos' : 'Video'] : null,
    d.tour ? ['tour', '3D Tour'] : null,
    d.floorplans?.length ? ['plans', 'Floor Plans'] : null,
    ['location', 'Location'],
    a ? ['contact', 'Contact'] : null,
  ].filter(Boolean) as string[][];
  const paras = desc ? desc.split(/\n{2,}|\r\n\r\n/).map(p => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('') : '';
  const longDesc = desc.length > 700;
  const mapQ = encodeURIComponent(d.address.full);
  const lb = JSON.stringify({
    photos: photos.map(p => ({ s: img(p.u, 2048), m: img(p.u, 1280) })),
    plans: (d.floorplans || []).filter((f: any) => !f.pdf).map((f: any) => ({ s: img(f.u, 2400), m: img(f.u, 1280) })),
  }).replace(/</g, '\\u003c');
  const shown = photos.slice(1, 9);

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)}</title>
<meta name="description" content="${esc(metaDesc)}">
${mls || d.preview ? '<meta name="robots" content="noindex">' : `<link rel="canonical" href="${esc(pageUrl)}">`}
<meta property="og:type" content="website"><meta property="og:url" content="${esc(pageUrl)}">
<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(metaDesc)}">
${hero ? `<meta property="og:image" content="${esc(o.origin + img(hero, 1200, 630))}"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta name="twitter:card" content="summary_large_image">` : ''}
<meta name="theme-color" content="#14130f">
${hero ? `<link rel="preload" as="image" imagesrcset="${esc(srcset(hero))}" imagesizes="100vw">` : ''}
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,300;9..144,400;9..144,500&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<style>${CSS}</style>
</head>
<body class="tpl-cooper ${mls ? 'mls' : 'branded'}">
${d.preview ? '<div class="pv">Preview · only you can see this until the website is live</div>' : ''}
<header class="top" id="top">
  <div class="brand">${!mls && a && !a.logo ? `<span class="brand-t">${esc(a.team || a.brokerage || a.name)}</span>` : ''}</div>
  <nav class="links">${nav.map(([k, l]) => `<a href="#${k}">${l}</a>`).join('')}</nav>
  <div class="acts"><button class="ghost" data-share>${ic('share', 18)}<span>Share</span></button>${a ? `<a class="solid" href="#contact">Contact${a.name ? ' ' + esc(a.name.split(' ')[0]) : ''}</a>` : ''}${!mls && a?.logo ? `<span class="logo"><img data-logo src="${esc(img(a.logo, 360))}" alt="${esc(a.brokerage || a.team || a.name || '')}"></span>` : ''}</div>
</header>

<section class="hero" aria-label="${esc(d.title)}">
  ${hero ? `<img class="hero-img" src="${esc(img(hero, 1600))}" srcset="${esc(srcset(hero))}" sizes="100vw" alt="${esc(d.title)}" fetchpriority="high">` : '<div class="hero-img empty"></div>'}
  <div class="hero-shade"></div>
  <div class="hero-in">
    <div class="eyebrow">${ic('pin', 15)}<span>${esc(d.subtitle || [d.address.city, d.address.state].filter(Boolean).join(', '))}</span></div>
    <h1>${esc(d.title)}</h1>
    ${price ? `<div class="price">${esc(price.value)}</div>` : ''}
    ${stats.length ? `<ul class="stats">${stats.map((f: any) => `<li>${ic(f.icon, 22)}<b>${esc(f.value)}</b><span>${esc(f.label)}</span></li>`).join('')}</ul>` : ''}
    <div class="hero-cta">
      ${photos.length > 1 ? `<button class="pill" data-open="0">${ic('grid', 18)} View ${photos.length} photos</button>` : ''}
      ${d.videos?.length ? `<a class="pill" href="#film">${ic('play', 16)} Watch film</a>` : ''}
      ${d.tour ? `<a class="pill" href="#tour">${ic('cube', 18)} 3D tour</a>` : ''}
    </div>
  </div>
  <a class="scroll" href="#${nav[0]?.[0] || 'location'}" aria-label="Scroll down"><span></span></a>
</section>

<nav class="sub" id="sub"><div class="sub-in">
  <div class="sub-t"><b>${esc(d.address.line)}</b>${price ? `<span>${esc(price.value)}</span>` : ''}</div>
  <div class="sub-l">${nav.map(([k, l]) => `<a href="#${k}" data-k="${k}">${l}</a>`).join('')}</div>
</div></nav>

<main>
${desc || stats.length ? `<section class="sec overview" id="overview"><div class="wrap two">
  <div class="ov-h"><span class="kicker">The Residence</span><h2>${esc(d.title)}</h2><p class="muted">${esc(d.address.full)}</p>
    ${stats.length || price ? `<dl class="facts">${(price ? [price] : []).concat(stats).map((f: any) => `<div>${ic(f.icon, 22)}<dt>${esc(f.label)}</dt><dd>${esc(f.value)}</dd></div>`).join('')}</dl>` : ''}</div>
  ${desc ? `<div class="ov-b ${longDesc ? 'clamp' : ''}" id="desc">${paras}${longDesc ? '<button class="more" data-more>Read more</button>' : ''}</div>` : ''}
</div></section>` : ''}

${photos.length > 1 ? `<section class="sec photos" id="photos"><div class="wrap">
  <div class="sec-h"><span class="kicker">Gallery</span><h2>Photos</h2><button class="link" data-open="0">View all ${photos.length} ${ic('arrow', 16)}</button></div>
  <div class="mosaic">${shown.map((p, i) => `<button class="tile t${i}" data-open="${i + 1}" aria-label="Open photo ${i + 2}"><img loading="lazy" decoding="async" src="${esc(img(p.u, 1080))}" srcset="${esc(srcset(p.u, [480, 800, 1200, 1600]))}" sizes="(max-width: 760px) 90vw, ${i === 0 ? '60vw' : '30vw'}" alt="">${i === shown.length - 1 && photos.length > shown.length + 1 ? `<span class="plus">+${photos.length - shown.length - 1}</span>` : ''}</button>`).join('')}</div>
</div></section>` : ''}

${d.videos?.length ? `<section class="sec dark film" id="film"><div class="wrap">
  <div class="sec-h"><span class="kicker">Cinema</span><h2>${d.videos.length > 1 ? 'Films' : 'The Film'}</h2></div>
  <div class="films ${d.videos.length > 1 ? 'many' : ''}">${d.videos.map((v: any) => `<figure class="vid ${v.portrait ? 'tall' : ''}" data-embed="${esc(v.embed + '&autoplay=1')}">
    ${v.poster ? `<img loading="lazy" src="${esc(v.poster)}" alt="">` : hero ? `<img loading="lazy" src="${esc(img(hero, 1600))}" alt="">` : ''}
    <button class="play" aria-label="Play ${esc(v.title)}">${ic('play', 30)}</button><figcaption>${esc(v.title)}</figcaption></figure>`).join('')}</div>
</div></section>` : ''}

${d.tour ? `<section class="sec tour" id="tour"><div class="wrap">
  <div class="sec-h"><span class="kicker">Walk through</span><h2>3D Tour</h2><a class="link" href="${esc(d.tour)}" target="_blank" rel="noopener">Open full screen ${ic('expand', 16)}</a></div>
  <div class="tourbox" data-src="${esc(d.tour)}">${hero ? `<img loading="lazy" src="${esc(img(photos[Math.min(2, photos.length - 1)]?.u || hero, 1600))}" alt="">` : ''}<button class="launch">${ic('cube', 22)}<span>Launch 3D tour</span></button></div>
</div></section>` : ''}

${d.floorplans?.length ? `<section class="sec plans" id="plans"><div class="wrap">
  <div class="sec-h"><span class="kicker">Layout</span><h2>Floor Plans</h2></div>
  <div class="plangrid">${(() => { let k = 0; return d.floorplans.map((f: any) => f.pdf
    ? `<a class="plan pdf" href="${esc(f.u)}" target="_blank" rel="noopener">${ic('plan', 34)}<span>Floor Plan</span><small>PDF</small></a>`
    : `<button class="plan" data-plan="${k++}"><img loading="lazy" src="${esc(img(f.u, 1200))}" alt="Floor plan ${k}"></button>`).join(''); })()}</div>
</div></section>` : ''}

<section class="sec location" id="location"><div class="wrap two">
  <div><span class="kicker">Location</span><h2>${esc(d.address.city || 'The Neighborhood')}</h2><p class="addr">${esc(d.address.line)}<br>${esc([d.address.city, [d.address.state, d.address.zip].filter(Boolean).join(' ')].filter(Boolean).join(', '))}</p>
    <a class="btn line" href="https://www.google.com/maps/dir/?api=1&destination=${mapQ}" target="_blank" rel="noopener">${ic('pin', 18)} Get directions</a></div>
  <div class="map"><iframe title="Map" loading="lazy" referrerpolicy="no-referrer-when-downgrade" src="https://maps.google.com/maps?q=${mapQ}&z=14&output=embed"></iframe></div>
</div></section>

${a ? `<section class="sec dark contact" id="contact"><div class="wrap two">
  <div class="agent">
    ${a.photo ? `<img class="ag-photo" loading="lazy" src="${esc(img(a.photo, 480, 480))}" alt="${esc(a.name)}">` : `<div class="ag-photo ph">${esc((a.name || '?').split(' ').map((w: string) => w[0]).join('').slice(0, 2))}</div>`}
    <span class="kicker">Listed by</span><h2>${esc(a.name)}</h2>
    <p class="muted">${esc([a.team, a.brokerage].filter(Boolean).join(' · '))}</p>
    ${a.logo ? `<img class="ag-logo" loading="lazy" src="${esc(img(a.logo, 480))}" alt="">` : ''}
    <div class="ag-btns">
      ${a.phone ? `<a class="btn solid" href="tel:${esc(tel(a.phone))}">${ic('phone', 18)} Call</a><a class="btn line" href="sms:${esc(tel(a.phone))}">${ic('chat', 18)} Text</a>` : ''}
      ${a.email ? `<a class="btn line" href="mailto:${esc(a.email)}?subject=${encodeURIComponent(d.address.line)}">${ic('mail', 18)} Email</a>` : ''}
      ${a.website ? `<a class="btn line" href="${esc(a.website)}" target="_blank" rel="noopener">${ic('globe', 18)} Website</a>` : ''}
    </div>
  </div>
  <form class="cform" id="cform" novalidate>
    <h3>Request information</h3><p class="muted">Ask a question or set up a private showing.</p>
    <div class="row"><label>Name<input name="name" autocomplete="name" required></label></div>
    <div class="row two"><label>Email<input name="email" type="email" autocomplete="email" required></label><label>Phone<input name="phone" type="tel" autocomplete="tel"></label></div>
    <label class="hp" aria-hidden="true">Company<input name="company" tabindex="-1" autocomplete="off"></label>
    <div class="row"><label>Message<textarea name="message" rows="4" required>I'm interested in ${esc(d.address.line)}. Please send me more information.</textarea></label></div>
    <button class="btn solid wide" type="submit">Send message ${ic('arrow', 18)}</button>
    <p class="form-msg" id="fmsg" role="status"></p>
  </form>
</div></section>` : ''}
</main>

<footer class="foot"><div class="wrap">
  <span>${esc(d.address.full)}</span>
  <span class="views" id="views" ${d.views ? '' : 'hidden'}>${ICON_EYE}<b id="vc">${Number(d.views || 0).toLocaleString('en-US')}</b> views</span>
  ${mls ? '' : `<a class="powered" href="https://knoxview.com" target="_blank" rel="noopener">Powered by<img src="https://knoxview-booking.netlify.app/img/logo-navy.png" alt="Knox View Media" width="88" height="22"></a>`}
</div></footer>

${a && (a.phone || a.email) ? `<div class="dock">${a.phone ? `<a href="tel:${esc(tel(a.phone))}">${ic('phone', 20)}<span>Call</span></a><a href="sms:${esc(tel(a.phone))}">${ic('chat', 20)}<span>Text</span></a>` : ''}<a href="#contact" class="hl">${ic('mail', 20)}<span>Message</span></a></div>` : ''}

<div class="lb" id="lb" hidden aria-modal="true" role="dialog">
  <div class="lb-top"><span id="lbn"></span><button data-x aria-label="Close">${ic('close', 26)}</button></div>
  <button class="lb-nav prev" data-p aria-label="Previous">${ic('left', 30)}</button>
  <div class="lb-stage" id="lbs"></div>
  <button class="lb-nav next" data-n aria-label="Next">${ic('right', 30)}</button>
</div>
<div class="toast" id="toast"></div>
<script>window.__L=${lb};window.__S=${JSON.stringify({ slug: d.slug, api: API, title: d.title, mls, preview: !!o.preview }).replace(/</g, '\\u003c')};</script>
<script>${JS}</script>
</body></html>`;
}

const TEMPLATES: Record<string, (d: any, o: { origin: string; base: string; preview?: string }) => string> = { cooper: renderCooper };

function offPage(title: string, msg: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,300;9..144,400&family=Inter:wght@400;500&display=swap" rel="stylesheet">
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#14130f;color:#f3efe6;font:16px/1.6 Inter,system-ui,sans-serif;text-align:center;padding:24px}h1{font:300 clamp(30px,5vw,48px)/1.1 Fraunces,Georgia,serif;margin:0 0 12px}p{color:#b9b2a3;margin:0}</style></head>
<body><div><h1>${esc(title)}</h1><p>${esc(msg)}</p></div></body></html>`;
}

const CSS = `
:root{--ink:#14130f;--ink2:#1d1b16;--paper:#f6f3ec;--card:#fffdf8;--text:#1c1a15;--muted:#6f685b;--line:#e4ddcf;--gold:#b08d57;--gold2:#d8bd8a;--on-gold:#14130f;--r:18px;--pad:clamp(20px,5vw,72px)}
*{box-sizing:border-box}html{scroll-behavior:smooth;scroll-padding-top:76px;-webkit-text-size-adjust:100%}
body{margin:0;background:var(--paper);color:var(--text);font:16px/1.65 Inter,system-ui,-apple-system,sans-serif;-webkit-font-smoothing:antialiased}
img{display:block;max-width:100%}button{font:inherit;color:inherit;cursor:pointer;background:none;border:0;padding:0}a{color:inherit}
.i{flex:none}
.wrap{max-width:1280px;margin:0 auto;padding:0 var(--pad)}
.two{display:grid;grid-template-columns:minmax(0,5fr) minmax(0,7fr);gap:clamp(28px,6vw,96px);align-items:start}
h1,h2,h3{font-family:Fraunces,Georgia,serif;font-weight:300;letter-spacing:-.01em;margin:0}
h2{font-size:clamp(32px,4.4vw,56px);line-height:1.04}
.kicker{display:inline-block;font-size:12px;letter-spacing:.22em;text-transform:uppercase;color:var(--gold);font-weight:600;margin-bottom:14px}
.muted{color:var(--muted)}
.pv{position:fixed;z-index:60;left:50%;transform:translateX(-50%);top:10px;background:#ffd36b;color:#1c1a15;font-size:13px;font-weight:600;padding:6px 14px;border-radius:999px;box-shadow:0 6px 20px rgba(0,0,0,.25)}
/* header over hero */
.top{position:absolute;z-index:20;top:0;left:0;right:0;display:flex;align-items:center;gap:24px;padding:22px var(--pad);color:#fff}
.brand{flex:1;min-width:0}
.logo{display:inline-flex;align-items:center;height:56px;padding:8px 14px;background:#fff;border-radius:10px;box-shadow:0 6px 20px rgba(0,0,0,.18)}.logo img{max-height:40px;max-width:180px;width:auto;object-fit:contain}
.brand-t{font-family:Fraunces,serif;font-size:20px;letter-spacing:.02em}
.links{display:flex;gap:26px;font-size:14px;letter-spacing:.04em}.links a{text-decoration:none;opacity:.88}.links a:hover{opacity:1}
.acts{display:flex;gap:10px;flex:1;justify-content:flex-end}
.ghost,.solid{display:inline-flex;align-items:center;gap:8px;height:42px;padding:0 18px;border-radius:999px;font-size:14px;font-weight:500;text-decoration:none;white-space:nowrap}
.ghost{background:rgba(255,255,255,.14);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);border:1px solid rgba(255,255,255,.28)}
.solid{background:#fff;color:var(--ink)}
/* hero */
.hero{position:relative;height:100svh;min-height:600px;overflow:hidden;background:var(--ink);color:#fff}
.hero-img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;animation:kb 22s ease-out both}
.hero-img.empty{background:linear-gradient(135deg,#2a261e,#14130f)}
@keyframes kb{from{transform:scale(1.08)}to{transform:scale(1)}}
.hero-shade{position:absolute;inset:0;background:linear-gradient(180deg,rgba(10,9,7,.55) 0%,rgba(10,9,7,0) 22%,rgba(10,9,7,0) 42%,rgba(10,9,7,.78) 100%)}
.hero-in{position:absolute;left:0;right:0;bottom:0;padding:0 var(--pad) clamp(40px,8vh,90px);max-width:1280px;margin:0 auto;animation:up 1.1s .15s cubic-bezier(.2,.7,.2,1) both}
@keyframes up{from{opacity:0;transform:translateY(24px)}to{opacity:1;transform:none}}
.eyebrow{display:flex;align-items:center;gap:8px;font-size:13px;letter-spacing:.2em;text-transform:uppercase;opacity:.9}
.hero h1{font-size:clamp(42px,8vw,112px);line-height:.96;margin:14px 0 10px;max-width:14ch;text-shadow:0 2px 30px rgba(0,0,0,.25)}
.price{font-family:Fraunces,serif;font-size:clamp(26px,3.4vw,40px);font-weight:400;color:var(--gold2)}
.stats{list-style:none;margin:26px 0 0;padding:0;display:flex;flex-wrap:wrap;gap:0;border-top:1px solid rgba(255,255,255,.25);max-width:860px}
.stats li{display:grid;grid-template-columns:auto 1fr;grid-template-rows:auto auto;column-gap:12px;align-items:center;padding:18px 32px 0 0;margin-right:32px}
.stats li .i{grid-row:span 2;opacity:.8}.stats b{font-weight:500;font-size:19px;line-height:1.2}.stats span{font-size:12px;letter-spacing:.14em;text-transform:uppercase;opacity:.72}
.hero-cta{display:flex;flex-wrap:wrap;gap:10px;margin-top:30px}
.pill{display:inline-flex;align-items:center;gap:9px;height:46px;padding:0 20px;border-radius:999px;background:rgba(255,255,255,.14);border:1px solid rgba(255,255,255,.3);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);color:#fff;text-decoration:none;font-size:14px;font-weight:500;transition:background .2s}
.pill:hover{background:rgba(255,255,255,.26)}
.scroll{position:absolute;right:var(--pad);bottom:clamp(40px,8vh,90px);width:28px;height:46px;border:1.5px solid rgba(255,255,255,.6);border-radius:16px}
.scroll span{position:absolute;left:50%;top:9px;width:3px;height:8px;margin-left:-1.5px;border-radius:2px;background:#fff;animation:sc 1.8s infinite}
@keyframes sc{0%{opacity:0;transform:translateY(0)}30%{opacity:1}100%{opacity:0;transform:translateY(14px)}}
/* sticky sub nav */
.sub{position:fixed;z-index:30;top:0;left:0;right:0;background:rgba(246,243,236,.86);backdrop-filter:saturate(1.4) blur(16px);-webkit-backdrop-filter:saturate(1.4) blur(16px);border-bottom:1px solid var(--line);transform:translateY(-110%);transition:transform .35s cubic-bezier(.2,.7,.2,1)}
.sub.on{transform:none}
.sub-in{max-width:1280px;margin:0 auto;padding:0 var(--pad);height:64px;display:flex;align-items:center;gap:20px}
.sub-t{display:flex;align-items:baseline;gap:12px;min-width:0;flex:none}.sub-t b{font-family:Fraunces,serif;font-weight:400;font-size:19px;white-space:nowrap}.sub-t span{color:var(--gold);font-weight:600;font-size:14px}
.sub-l{display:flex;gap:4px;margin-left:auto;overflow-x:auto;scrollbar-width:none}.sub-l::-webkit-scrollbar{display:none}
.sub-l a{padding:8px 14px;border-radius:999px;font-size:14px;text-decoration:none;color:var(--muted);white-space:nowrap}.sub-l a.on,.sub-l a:hover{color:var(--text);background:rgba(28,26,21,.06)}
/* sections */
.sec{padding:clamp(72px,11vw,150px) 0}
.sec-h{display:flex;align-items:flex-end;gap:20px;margin-bottom:clamp(28px,4vw,48px);flex-wrap:wrap}.sec-h .kicker{width:100%;margin-bottom:0}.sec-h h2{flex:1}
.link{display:inline-flex;align-items:center;gap:8px;font-size:15px;font-weight:500;text-decoration:none;border-bottom:1px solid currentColor;padding-bottom:3px}
.dark{background:var(--ink);color:#f3efe6}.dark .muted{color:#a9a191}
.overview h2{font-size:clamp(30px,3.4vw,44px)}.overview .muted{margin:12px 0 0}
.facts{display:flex;flex-wrap:wrap;gap:10px;margin:34px 0 0}
.facts div{flex:1 1 140px;max-width:240px;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px 18px 16px;display:grid;gap:2px}.facts .i{color:var(--gold);margin-bottom:8px}
.facts dt{font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:var(--muted)}.facts dd{margin:0;font-size:18px;font-weight:500}
.ov-b{font-size:clamp(17px,1.3vw,19px);line-height:1.8;color:#38342b}.ov-b p{margin:0 0 1.1em}.ov-b p:first-child::first-letter{font-family:Fraunces,serif;float:left;font-size:4.2em;line-height:.82;padding:6px 10px 0 0;color:var(--gold)}
.ov-b.clamp{max-height:30em;overflow:hidden;position:relative}.ov-b.clamp::after{content:"";position:absolute;left:0;right:0;bottom:0;height:9em;background:linear-gradient(transparent,var(--paper))}
.ov-b.clamp .more{position:absolute;z-index:2;bottom:0;left:0}.more{font-weight:600;border-bottom:1px solid;padding-bottom:2px}.ov-b.open{max-height:none}.ov-b.open::after{display:none}.ov-b.open .more{display:none}
/* mosaic */
.mosaic{display:grid;grid-auto-flow:dense;grid-template-columns:repeat(4,1fr);grid-auto-rows:clamp(150px,17vw,250px);gap:clamp(8px,1vw,14px)}
.tile{position:relative;overflow:hidden;border-radius:12px;background:#ddd5c5}.tile img{width:100%;height:100%;object-fit:cover;transition:transform 1.2s cubic-bezier(.2,.7,.2,1)}.tile:hover img{transform:scale(1.045)}
.t0{grid-column:span 2;grid-row:span 2}.t5{grid-column:span 2}
.plus{position:absolute;inset:0;display:grid;place-items:center;background:rgba(20,19,15,.55);color:#fff;font-family:Fraunces,serif;font-size:clamp(28px,3vw,44px)}
/* film */
.films{display:grid;gap:clamp(16px,2vw,28px)}.films.many{grid-template-columns:repeat(auto-fit,minmax(min(100%,420px),1fr))}
.vid{position:relative;margin:0;aspect-ratio:16/9;border-radius:var(--r);overflow:hidden;background:#000;cursor:pointer}.vid.tall{aspect-ratio:9/16;max-height:80vh;justify-self:center;width:auto;height:min(80vh,780px)}
.vid img{width:100%;height:100%;object-fit:cover;opacity:.82;transition:opacity .4s,transform 1.2s}.vid:hover img{opacity:1;transform:scale(1.02)}
.vid iframe{position:absolute;inset:0;width:100%;height:100%;border:0}
.play{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:88px;height:88px;border-radius:50%;display:grid;place-items:center;background:rgba(255,255,255,.16);border:1px solid rgba(255,255,255,.5);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);color:#fff;transition:transform .3s}.play .i{margin-left:5px}.vid:hover .play{transform:translate(-50%,-50%) scale(1.08)}
.vid figcaption{position:absolute;left:20px;bottom:16px;font-size:13px;letter-spacing:.16em;text-transform:uppercase;color:#fff;text-shadow:0 1px 10px rgba(0,0,0,.5)}
/* tour */
.tourbox{position:relative;aspect-ratio:16/9;border-radius:var(--r);overflow:hidden;background:var(--ink)}.tourbox img{width:100%;height:100%;object-fit:cover;filter:brightness(.6) saturate(.9)}
.tourbox iframe{position:absolute;inset:0;width:100%;height:100%;border:0}
.launch{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);display:inline-flex;align-items:center;gap:12px;height:60px;padding:0 30px;border-radius:999px;background:#fff;color:var(--ink);font-weight:600;font-size:16px;box-shadow:0 18px 40px rgba(0,0,0,.35);transition:transform .25s}.launch:hover{transform:translate(-50%,-50%) scale(1.04)}
/* plans */
.plangrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,320px),1fr));gap:18px}
.plan{display:flex;flex-direction:column;gap:12px;background:var(--card);border:1px solid var(--line);border-radius:var(--r);padding:16px;text-align:left;text-decoration:none;transition:box-shadow .3s,transform .3s}
.plan:hover{box-shadow:0 18px 40px rgba(40,32,15,.1);transform:translateY(-2px)}.plan img{width:100%;aspect-ratio:4/3;object-fit:contain;background:#fff;border-radius:10px}
.plan span{font-weight:500}.plan.pdf{align-items:flex-start;justify-content:center;min-height:180px;color:var(--text)}.plan.pdf .i{color:var(--gold)}.plan small{color:var(--muted);letter-spacing:.14em}
/* location */
.addr{font-size:20px;line-height:1.5;margin:18px 0 28px}
.map{border-radius:var(--r);overflow:hidden;aspect-ratio:4/3;background:#e7e1d4;border:1px solid var(--line)}.map iframe{width:100%;height:100%;border:0;filter:grayscale(.35) contrast(1.05)}
/* buttons */
.btn{display:inline-flex;align-items:center;justify-content:center;gap:10px;height:52px;padding:0 24px;border-radius:999px;font-weight:500;font-size:15px;text-decoration:none;transition:transform .2s,background .2s}
.btn.line{border:1px solid currentColor}.btn.solid{background:var(--gold);color:var(--on-gold)}.btn.solid:hover{filter:brightness(1.08)}.btn.wide{width:100%}
.dark .btn.line{border-color:rgba(255,255,255,.35)}
/* contact */
.agent{display:flex;flex-direction:column;align-items:flex-start}.ag-photo{width:132px;height:132px;border-radius:50%;object-fit:cover;margin-bottom:28px;border:1px solid rgba(255,255,255,.2)}
.ag-photo.ph{display:grid;place-items:center;background:#2a261e;font-family:Fraunces,serif;font-size:44px;color:var(--gold2)}
.agent h2{font-size:clamp(34px,4vw,52px)}.agent .muted{margin:8px 0 0}.ag-logo{max-width:200px;max-height:72px;object-fit:contain;margin:26px 0 0;filter:brightness(0) invert(1);opacity:.9}
.ag-btns{display:flex;flex-wrap:wrap;gap:10px;margin-top:32px}
.cform{background:#1f1d17;border:1px solid #2f2b22;border-radius:calc(var(--r) + 6px);padding:clamp(24px,3.4vw,44px)}
.cform h3{font-size:30px}.cform .muted{margin:6px 0 22px}
.cform label{display:block;font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:#a9a191;margin-bottom:14px}
.cform input,.cform textarea{display:block;width:100%;margin-top:7px;background:#14130f;border:1px solid #38332a;border-radius:12px;color:#f3efe6;font:16px/1.5 Inter,sans-serif;padding:13px 14px;letter-spacing:0;text-transform:none;transition:border-color .2s}
.cform input:focus,.cform textarea:focus{outline:0;border-color:var(--gold)}.cform textarea{resize:vertical}
.row.two{display:grid;grid-template-columns:1fr 1fr;gap:12px}.hp{position:absolute!important;left:-9999px}
.form-msg{margin:14px 0 0;font-size:14px;min-height:1em}.form-msg.ok{color:#9fd8a7}.form-msg.err{color:#ffb4a1}
/* footer */
.foot{padding:34px 0 40px;font-size:13px;color:var(--muted);border-top:1px solid var(--line)}.foot .wrap{display:flex;flex-wrap:wrap;gap:12px;justify-content:space-between}.credit a{color:var(--text)}
.dark+.foot,.contact+.foot{border:0}
.foot .wrap{align-items:center}.views{display:inline-flex;align-items:center;gap:6px;font-size:12px}.views b{font-weight:600;color:var(--text)}
.powered{display:inline-flex;align-items:center;gap:8px;font-size:11px;letter-spacing:.06em;color:var(--muted);text-decoration:none;opacity:.9;transition:opacity .2s}.powered:hover{opacity:1}.powered img{height:22px;width:auto}
/* phone dock */
.dock{display:none}
/* lightbox */
.lb{position:fixed;inset:0;z-index:100;background:rgba(12,11,9,.97);color:#fff;display:flex;align-items:center;justify-content:center;touch-action:pan-y}
.lb[hidden]{display:none}
.lb-top{position:absolute;top:0;left:0;right:0;display:flex;justify-content:space-between;align-items:center;padding:16px 20px;font-size:14px;letter-spacing:.12em;z-index:2}
.lb-stage{width:100%;height:100%;display:flex;align-items:center;justify-content:center;padding:64px 80px}
.lb-stage img{max-width:100%;max-height:100%;object-fit:contain;border-radius:4px;user-select:none;-webkit-user-drag:none;transition:opacity .25s}
.lb-nav{position:absolute;top:50%;transform:translateY(-50%);width:56px;height:56px;border-radius:50%;display:grid;place-items:center;background:rgba(255,255,255,.08)}.lb-nav:hover{background:rgba(255,255,255,.18)}.prev{left:18px}.next{right:18px}
.toast{position:fixed;z-index:120;left:50%;bottom:28px;transform:translate(-50%,30px);opacity:0;background:#fff;color:var(--ink);padding:12px 18px;border-radius:999px;font-size:14px;font-weight:500;box-shadow:0 12px 30px rgba(0,0,0,.25);transition:.3s;pointer-events:none}.toast.on{opacity:1;transform:translate(-50%,0)}
/* reveal */
.rv{opacity:0;transform:translateY(28px);transition:opacity .9s cubic-bezier(.2,.7,.2,1),transform .9s cubic-bezier(.2,.7,.2,1)}.rv.in{opacity:1;transform:none}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}.rv{opacity:1;transform:none}}
/* tablet + phone */
@media (max-width:1020px){.links{display:none}.two{grid-template-columns:1fr}.mosaic{grid-template-columns:repeat(2,1fr);grid-auto-rows:clamp(140px,30vw,260px)}}
@media (max-width:760px){
  html{scroll-padding-top:64px}
  .top{padding:16px 18px}.logo{height:46px;padding:6px 10px}.logo img{max-height:34px;max-width:130px}.ghost span{display:none}.ghost{width:42px;padding:0;justify-content:center}.acts .solid{display:none}
  .hero{min-height:560px}.hero-in{padding:0 20px 34px}.hero h1{font-size:clamp(38px,11vw,56px)}
  .stats{display:grid;grid-template-columns:1fr 1fr;margin-top:20px}.stats li{padding:14px 10px 0 0;margin:0}.stats b{font-size:17px}
  .hero-cta{margin-top:22px}.pill{height:42px;padding:0 16px;font-size:13px}.scroll{display:none}
  .sub-in{height:56px;padding:0 6px 0 16px}.sub-t{display:none}.sub-l{margin:0}
  .sec{padding:64px 0}.wrap{padding:0 20px}
  .mosaic{display:flex;overflow-x:auto;scroll-snap-type:x mandatory;gap:10px;margin:0 -20px;padding:0 20px;scrollbar-width:none;grid-auto-rows:auto}.mosaic::-webkit-scrollbar{display:none}
  .tile{flex:0 0 84%;height:62vw;max-height:340px;scroll-snap-align:center}
  .vid.tall{height:auto;width:100%;max-height:none}
  .play{width:70px;height:70px}
  .row.two{grid-template-columns:1fr}
  .lb-stage{padding:56px 0}.lb-nav{display:none}.lb-stage img{border-radius:0}
  body.branded .dock{display:flex;position:fixed;z-index:40;left:12px;right:12px;bottom:calc(12px + env(safe-area-inset-bottom));background:rgba(20,19,15,.92);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);border-radius:20px;padding:6px;box-shadow:0 14px 40px rgba(0,0,0,.35);transform:translateY(140%);transition:transform .35s}
  body.branded .dock.on{transform:none}
  .dock a{flex:1;display:flex;flex-direction:column;align-items:center;gap:3px;padding:9px 0 7px;border-radius:14px;color:#f3efe6;text-decoration:none;font-size:11px;letter-spacing:.06em}.dock a.hl{background:var(--gold);color:var(--on-gold)}
  body.branded .foot{padding-bottom:110px}
}
`;

const JS = `(function(){
var L=window.__L,S=window.__S,$=function(s,r){return(r||document).querySelector(s)},$$=function(s,r){return[].slice.call((r||document).querySelectorAll(s))};
/* brand color: the site's accent follows the agent's logo (its main color, skipping white/transparent), remembered per logo */
(function(){var lg=$('[data-logo]');if(!lg)return;var key='kv_ac:'+lg.getAttribute('src');
  function lum(c){return [c[0],c[1],c[2]].map(function(v){v/=255;return v<=.03928?v/12.92:Math.pow((v+.055)/1.055,2.4)}).reduce(function(s,v,i){return s+v*[.2126,.7152,.0722][i]},0)}
  function mix(c,t,a){return c.map(function(v,i){return Math.round(v+(t[i]-v)*a)})}
  function hex(c){return '#'+c.map(function(v){return ('0'+v.toString(16)).slice(-2)}).join('')}
  function apply(c){var r=document.documentElement.style,on=c.slice(),k=0;
    while(lum(on)>.3&&k++<12)on=mix(on,[0,0,0],.12); /* readable as text on the light pages */
    var lt=c.slice();k=0;while(lum(lt)<.32&&k++<12)lt=mix(lt,[255,255,255],.14); /* readable on the dark hero / contact */
    r.setProperty('--gold',hex(on));r.setProperty('--gold2',hex(lt));r.setProperty('--on-gold',lum(on)>.4?'#14130f':'#ffffff');
    var m=document.querySelector('meta[name=theme-color]');if(m)m.content=hex(on)}
  try{var c=JSON.parse(localStorage.getItem(key)||'null');if(c){apply(c);return}}catch(e){}
  function read(){try{var w=64,h=Math.max(1,Math.round(w*lg.naturalHeight/lg.naturalWidth)),cv=document.createElement('canvas');cv.width=w;cv.height=h;
    var x=cv.getContext('2d');x.drawImage(lg,0,0,w,h);var p=x.getImageData(0,0,w,h).data,B={},best=null;
    for(var i=0;i<p.length;i+=4){if(p[i+3]<200)continue;var r=p[i],g=p[i+1],b=p[i+2],mx=Math.max(r,g,b),mn=Math.min(r,g,b),l=(mx+mn)/510,s=mx===mn?0:(mx-mn)/(255-Math.abs(mx+mn-255));
      if(l>.9)continue;var wt=s>.25&&l>.1&&l<.88?1+3*s:.15,k=(r>>4)+','+(g>>4)+','+(b>>4),o=B[k]||(B[k]={w:0,r:0,g:0,b:0,n:0});o.w+=wt;o.r+=r;o.g+=g;o.b+=b;o.n++;if(!best||o.w>best.w)best=o}
    if(!best)return;var c=[Math.round(best.r/best.n),Math.round(best.g/best.n),Math.round(best.b/best.n)];apply(c);try{localStorage.setItem(key,JSON.stringify(c))}catch(e){}}catch(e){}}
  if(lg.complete&&lg.naturalWidth)read();else lg.addEventListener('load',read)})();
function toast(m){var t=$('#toast');t.textContent=m;t.classList.add('on');clearTimeout(t._t);t._t=setTimeout(function(){t.classList.remove('on')},2400)}
/* stats: a view on every load, plus what people do (preview visits don't count) */
var vid;try{vid=localStorage.getItem('kv_v')||(Math.random().toString(36).slice(2)+Date.now().toString(36));localStorage.setItem('kv_v',vid)}catch(e){vid=''}
var dev=/iPad|Tablet/i.test(navigator.userAgent)?'tablet':/Mobi|Android|iPhone/i.test(navigator.userAgent)?'phone':'desktop';
function track(ev,cb){if(S.preview)return;try{fetch(S.api,{method:'POST',keepalive:true,headers:{'content-type':'application/json'},body:JSON.stringify({action:'track',slug:S.slug,mls:S.mls,event:ev,v:vid,device:dev,ref:ev==='view'?document.referrer:''})}).then(function(r){return r.json()}).then(function(r){cb&&cb(r)}).catch(function(){})}catch(e){}}
track('view',function(r){if(r&&r.views){$('#vc').textContent=Number(r.views).toLocaleString('en-US');$('#views').hidden=false}});
document.addEventListener('click',function(e){var a=e.target.closest('a,button');if(!a)return;var h=a.getAttribute('href')||'';
  if(h.indexOf('tel:')===0)track('call');else if(h.indexOf('sms:')===0)track('text');else if(h.indexOf('mailto:')===0)track('email');
  else if(h.indexOf('google.com/maps/dir')>-1)track('directions');else if(a.closest('.ag-btns')&&/^https?:/.test(h))track('website');
  else if(a.hasAttribute('data-share'))track('share');else if(a.hasAttribute('data-open'))track('photo_open');else if(a.hasAttribute('data-plan'))track('plan_open')},true);
/* sticky nav + dock after the hero */
var sub=$('#sub'),dock=$('.dock'),hero=$('.hero');
function onScroll(){var past=window.scrollY>hero.offsetHeight-80;sub.classList.toggle('on',past);if(dock)dock.classList.toggle('on',past)}
addEventListener('scroll',onScroll,{passive:true});onScroll();
/* active section in the nav */
if('IntersectionObserver'in window){
  var links=$$('.sub-l a');var io=new IntersectionObserver(function(es){es.forEach(function(e){if(e.isIntersecting){links.forEach(function(a){a.classList.toggle('on',a.dataset.k===e.target.id)})}})},{rootMargin:'-45% 0px -50% 0px'});
  links.forEach(function(a){var s=document.getElementById(a.dataset.k);if(s)io.observe(s)});
  var rv=new IntersectionObserver(function(es){es.forEach(function(e){if(e.isIntersecting){e.target.classList.add('in');rv.unobserve(e.target)}})},{rootMargin:'0px 0px -8% 0px'});
  $$('.sec .wrap > *').forEach(function(el){el.classList.add('rv');rv.observe(el)});
}
/* read more */
var more=$('[data-more]');if(more)more.onclick=function(){$('#desc').classList.add('open')};
/* share */
$$('[data-share]').forEach(function(b){b.onclick=function(){var u=location.href.split('#')[0].split('?')[0];if(navigator.share){navigator.share({title:S.title,url:u}).catch(function(){})}else{navigator.clipboard.writeText(u).then(function(){toast('Link copied')})}}});
/* video + tour: load the player only when asked */
$$('.vid').forEach(function(f){f.onclick=function(){if(f.querySelector('iframe'))return;track('video_play');var i=document.createElement('iframe');i.src=f.dataset.embed;i.allow='autoplay; fullscreen; picture-in-picture';i.allowFullscreen=true;f.appendChild(i)}});
$$('.tourbox').forEach(function(t){t.onclick=function(){if(t.querySelector('iframe'))return;track('tour_open');var i=document.createElement('iframe');i.src=t.dataset.src;i.allow='fullscreen; xr-spatial-tracking; gyroscope; accelerometer';i.allowFullscreen=true;t.appendChild(i);var l=t.querySelector('.launch');if(l)l.remove()}});
/* lightbox */
var lb=$('#lb'),st=$('#lbs'),cnt=$('#lbn'),set=[],at=0,sx=0,sy=0;
function show(){var it=set[at];st.innerHTML='<img alt="" src="'+(innerWidth<900?it.m:it.s)+'">';cnt.textContent=(at+1)+' / '+set.length;
  [at+1,at-1].forEach(function(k){var n=set[(k+set.length)%set.length];if(n){var im=new Image();im.src=innerWidth<900?n.m:n.s}})}
function open(list,i){set=list;at=i;lb.hidden=false;document.documentElement.style.overflow='hidden';show()}
function close(){lb.hidden=true;st.innerHTML='';document.documentElement.style.overflow=''}
function go(d){at=(at+d+set.length)%set.length;show()}
$$('[data-open]').forEach(function(b){b.onclick=function(){open(L.photos,+b.dataset.open)}});
$$('[data-plan]').forEach(function(b){b.onclick=function(){open(L.plans,+b.dataset.plan)}});
$('[data-x]',lb).onclick=close;$('[data-p]',lb).onclick=function(){go(-1)};$('[data-n]',lb).onclick=function(){go(1)};
st.onclick=function(e){if(e.target===st)close()};
addEventListener('keydown',function(e){if(lb.hidden)return;if(e.key==='Escape')close();if(e.key==='ArrowRight')go(1);if(e.key==='ArrowLeft')go(-1)});
lb.addEventListener('touchstart',function(e){sx=e.touches[0].clientX;sy=e.touches[0].clientY},{passive:true});
lb.addEventListener('touchend',function(e){var dx=e.changedTouches[0].clientX-sx,dy=e.changedTouches[0].clientY-sy;if(Math.abs(dx)>50&&Math.abs(dx)>Math.abs(dy))go(dx<0?1:-1);else if(dy>90)close()},{passive:true});
/* contact form */
var f=$('#cform');if(f)f.onsubmit=function(e){e.preventDefault();var m=$('#fmsg'),b=f.querySelector('button[type=submit]');var d={action:'contact',slug:S.slug,v:vid};
  ['name','email','phone','message','company'].forEach(function(k){d[k]=f.elements[k].value});
  if(!d.name.trim()||!/^\\S+@\\S+\\.\\S+$/.test(d.email)||!d.message.trim()){m.className='form-msg err';m.textContent='Add your name, email and a message.';return}
  b.disabled=true;m.className='form-msg';m.textContent='Sending…';
  fetch(S.api,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(d)}).then(function(r){return r.json()}).then(function(r){
    if(r.error)throw new Error(r.error);m.className='form-msg ok';m.textContent='Thank you. Your message is on its way.';f.reset()}).catch(function(err){m.className='form-msg err';m.textContent=err.message||'Could not send. Please call or text instead.'}).finally(function(){b.disabled=false})};
})();`;
