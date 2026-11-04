# Knox View Projects Dashboard

Internal project tracker for Knox View Real Estate Media photo and video projects.

- **App:** a single static page, `index.html` (no build step)
- **Backend:** Supabase project `knoxview-dashboard` (auth, database, row level security)
- **Hosting:** Netlify, deployed automatically from the `main` branch

Only active team members can sign in and see data. Access is enforced in Supabase, not in this page.
