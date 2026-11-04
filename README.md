# Knox View HQ

Internal headquarters for Knox View Real Estate Media. It starts with the project tracker for photo and video jobs; training resources, SOPs and other team tools will be added as new sections.

- **App:** a single static page, `index.html` (no build step)
- **Backend:** Supabase project `knoxview-dashboard` (auth, database, row level security)
- **Hosting:** Netlify site `knoxview-hq`, deployed automatically from the `main` branch
- **Address:** https://hq.knoxview.com

Only active team members can sign in and see data. Access is enforced in Supabase, not in this page.
