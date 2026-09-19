# Worker Assignment App

A small full-stack app for managing a pool of workers and auto-assigning
scraped job postings to the best-fit worker - including adding the
assignment to the worker's Google Calendar.

- **Backend:** Node.js + Express + MongoDB (Mongoose)
- **Frontend:** React (Vite) + React Router
- Scraping uses Node's built-in `fetch` plus a dedicated parser for the
  real job-source JSON format this was built against (see below), with a
  generic HTML/JSON fallback for other sources - no scraping service or
  headless browser needed.
- Location matching uses real distance, geocoded automatically from plain
  addresses via the free OpenStreetMap Nominatim API - no API key, and no
  need to type in coordinates by hand.
- Google Calendar integration is optional - the app works fully without
  it, and turns on the moment you add three env vars.

> **Note on how this was built:** the sandbox this was written in blocks
> npm registry access (and most other outbound network access), so the
> code was hand-written and syntax-checked but never `npm install`-ed or
> run live end-to-end. Each network-dependent piece (scraper, geocoder,
> assignment engine) was verified with a stubbed/mocked version of the
> real request-response shape instead. Everything follows very standard
> Express/Mongoose/React/Vite patterns, but budget a few minutes the first
> time you run it in case something needs a small tweak.

## 1. Project layout

```
worker-assignment-app/
  server/   Express + Mongoose API
  client/   React + Vite frontend
```

## 2. Prerequisites

- Node.js 18+ (needs built-in `fetch`)
- A MongoDB database - either:
  - a local MongoDB installed on your machine, or
  - a free [MongoDB Atlas](https://www.mongodb.com/atlas) cluster (easiest
    if you don't want to install anything)
- Outbound internet access from wherever the server runs (it calls the job
  link you paste in, the Nominatim geocoding API, and optionally Google
  Calendar).
- ~300MB free disk space for the Chromium browser Playwright downloads
  (section 3) - only needed for pasting Beehiive login links; everything
  else works without it. On Linux, if `npx playwright install chromium`
  reports missing system libraries, follow up with `npx playwright
  install-deps chromium` (not needed on Windows/macOS).

## 3. Backend setup

```bash
cd server
npm install
npx playwright install chromium   # one-time download (~300MB) - see note below
cp .env.example .env
# edit .env: set MONGO_URI to your database connection string
npm run dev
```

The API starts on `http://localhost:5000` (change with `PORT` in `.env`).
Visit `http://localhost:5000/api/health` - you should see `{"ok":true}`.

> **Why `npx playwright install chromium`?** Beehiive login links
> (`auth.beehiive.com/login?token=...`) redeem their token via client-side
> JavaScript rather than a normal server redirect, so scraping one requires
> actually running a real (headless) browser - see **Auth for protected job
> links** in section 8 for the full story. That one-time command downloads
> the Chromium build Playwright drives; everything else in the app works
> without it, but pasting a Beehiive login link will fail with a clear
> "playwright isn't set up" error until it's run.

### Environment variables (`server/.env`)

| Variable                | Meaning                                                                 |
|--------------------------|--------------------------------------------------------------------------|
| `MONGO_URI`              | MongoDB connection string                                                |
| `PORT`                   | API port (default 5000)                                                  |
| `CLIENT_ORIGIN`          | Frontend origin, for CORS (default `http://localhost:5173`)              |
| `MAX_CONCURRENT_JOBS`    | How many active jobs a worker can hold before they're "at capacity" (default 2) |
| `AUTH_SECRET`            | **Required.** Signs login sessions - see section 5                       |
| `ADMIN_EMAIL`            | Email for the auto-created first login (optional - see section 5)        |
| `ADMIN_PASSWORD`         | Password for the auto-created first login (optional - see section 5)     |
| `TZ`                     | Server timezone - see **Timezones** below                                |
| `GEOCODE_CONTACT`        | Contact info sent to Nominatim's geocoding API (optional, but polite)    |
| `LOCATIONIQ_API_KEY`     | Fallback geocoder used if Nominatim fails/blocks (optional - see **Geocoding**) |
| `GOOGLE_CLIENT_ID`       | Google OAuth client ID (optional - enables Calendar invites)             |
| `GOOGLE_CLIENT_SECRET`   | Google OAuth client secret (optional)                                    |
| `GOOGLE_REFRESH_TOKEN`   | Obtained via `npm run get-google-token` (optional)                       |
| `GOOGLE_CALENDAR_ID`     | Which calendar to create events on (default `primary`)                   |
| `GOOGLE_AVAILABILITY_SHEET_ID` | Linked "Form Responses" Sheet ID for the availability sync (optional - see section 18) |
| `GOOGLE_AVAILABILITY_SHEET_RANGE` | Which tab to read (default `Form Responses 1`)                    |

## 4. Frontend setup

In a second terminal:

```bash
cd client
npm install
npm run dev
```

Open `http://localhost:5173`. Vite is configured to proxy `/api/*` requests
to the backend on port 5000 (see `client/vite.config.js`), so you don't need
to configure CORS URLs by hand for local dev.

## 5. Login, user accounts & light/dark theme

The whole app now sits behind a login - every page redirects to `/login`
until someone signs in, and every API route (except `/api/auth/login`
itself) requires it too.

There's no public sign-up page on purpose - the only way to create an
account is from inside the app, by someone who's already logged in. So the
first time you start the server with an empty database, it automatically
creates one login for you and prints it to the terminal:

```
[auth] No user accounts existed yet - created a default one so you can log in:
[auth]   email:    admin@example.com
[auth]   password: <a random generated password>
```

Copy that password from the terminal to log in the first time (or set
`ADMIN_EMAIL`/`ADMIN_PASSWORD` in `server/.env` beforehand to choose your
own instead of getting a generated one - see `.env.example`). This only
ever runs when there are zero user accounts, so it never re-triggers or
overwrites anything once you have at least one login.

This also means `AUTH_SECRET` in `server/.env` is **required** - it's the
key used to sign login sessions - and the server refuses to start without
it. Generate one with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

and paste the result in as `AUTH_SECRET=...`. Don't reuse the placeholder
in `.env.example`, and use a different value per real deployment. Changing
it later logs everyone out (invalidates every existing session) - that's
expected, not a bug. Sessions last 7 days either way, after which logging
in again is needed regardless.

No new npm packages were needed for any of this - passwords are hashed
with Node's built-in `crypto` module (`scrypt`, with a random salt per
password) and login sessions are a signed token in the same vein as a JWT,
verified with an HMAC signature - both entirely hand-rolled from `crypto`
rather than pulling in bcrypt/jsonwebtoken, so there's nothing extra to
`npm install` for auth to work.

**Adding more users:** once logged in, go to **Settings** (in the navbar)
to add accounts for everyone else who needs to use the app - name, email,
password (8+ characters). Anyone with a login can see and do everything in
the app (there are no separate permission levels), and can also add or
remove other users from the same Settings page - except you can't delete
the account you're currently logged in as, so there's no way to
accidentally lock everyone out through the UI.

**Light/dark theme:** also on the Settings page, a Light/Dark toggle
switches the whole app's color scheme instantly. It's remembered per
browser (via `localStorage`), defaults to your system's own light/dark
setting the first time, and needs no server round-trip to change.

**Forgot password:** the login page has a "Forgot password?" link
(`/forgot-password`) - enter your account's email and, if it matches an
account, a reset link is emailed to it via the same Gmail API integration
used for the fortnight rollout emails (see `GOOGLE_CLIENT_ID`/
`GOOGLE_CLIENT_SECRET`/`GOOGLE_REFRESH_TOKEN` in `.env.example`, which
needs the `gmail.send` scope - `npm run get-google-token` already requests
it). The email always says the same generic thing whether or not that
address actually has an account, so this can't be used to check who has a
login. The link (`/reset-password?...`) is single-use and expires after 1
hour; following it lets you set a new password (8+ characters) without
being logged in. If Gmail sending isn't configured, this silently doesn't
send anything - either add proper Gmail credentials first, or have
whoever's already logged in remove your account and re-add it with a
password you choose (Settings has no separate "change password" for an
existing account yet, so that's the only other way to reset one).

## 6. Try it with mock data first

Before wiring up a real job link, you can seed the database with a handful
of mock workers and one mock job, and watch the whole pipeline run -
ranking, assignment, and (if configured) the calendar invite:

```bash
cd server
npm run seed
```

This **wipes** the `workers` and `jobs` collections first, so only run it
against a throwaway/dev database. It prints the ranked candidates as a
table so you can see exactly why the winner won, e.g.:

```
[seed] ranked candidates:
┌─────────┬───────────────────┬───────┬───────┬──────────┬──────┬───────────────┐
│ (index) │ worker            │ total │ skill │ location │ load │ priorityBonus │
├─────────┼───────────────────┼───────┼───────┼──────────┼──────┼───────────────┤
│    0    │ 'Priya Nair'      │  49   │  20   │    20    │  8   │       1       │
│    1    │ 'Jess Whitfield'  │  29   │  20   │    0     │  8   │       1       │
│    2    │ 'Sam Lee'         │   7   │  -10  │    20    │  -4  │       1       │
│    3    │ 'Tom Baxter'      │   1   │  -30  │    20    │  8   │       3       │
└─────────┴───────────────────┴───────┴───────┴──────────┴──────┴───────────────┘
```

The mock roster is deliberately varied so all four assignment rules show
up at once: one worker is unavailable (excluded outright), one is local
but underqualified (heavily penalised), two have identical top-tier skill
but only one is local (location breaks the tie), and one is local and
qualified but already has an active job nearby (a small "already busy"
penalty). See the comments in `server/src/seed.js` for the exact setup.

The mock job itself is built from a stand-in copy of the real job-source
payload format described below (run through the actual scraper code, with
`fetch` stubbed out, so it also smoke-tests the scraper).

## 7. Using the app for real

### Workers page (`/workers`)

Add, edit, and delete workers. Fields: name, email, location, work area
(Adelaide/Perth/Brisbane/NSW/Auckland - purely organisational, see section
11 for how this differs from a *job's* work area), gender, phone, skill
level (1-5), and priority (Low/Medium/High). There is no plain on/off
"Available" toggle anymore - see the Availability column below and section
18. Latitude/longitude are filled in automatically from the location text
(see **Geocoding** below) - you only need to touch them to override the
automatic lookup.

The **Availability** column shows how many days of the current fortnight
each worker has answered on the team's Google Form - click it (tap on
mobile) for a popup with each day's actual answer - click **Sync fortnight
availability** above the table to pull in the latest responses. Unlike the
old toggle, this DOES feed the assignment engine: a worker is excluded
from a job if the job's scheduled time falls outside what they answered
for that day. See section 18 for how the sync and the exclusion logic
work.

### Home page (`/`)

1. Paste a job posting link and click **Fetch job details**. The backend
   fetches that exact URL - if the link already carries an access token as
   a query parameter, it's sent through untouched.
2. The scraper returns a best-guess draft: title, description, location,
   work area, difficulty (Easy/Medium/Difficult), priority, scheduled
   date/time, duration, and customer details where available. **Always
   review it** - even the dedicated parser is working from messy free text
   in places. Edit any field, then **Save job**.
3. The job appears in the jobs list below, status `Unassigned`.
4. Click **Preview candidates** to see every available worker ranked with a
   score breakdown, or **Auto-assign** to fill the job's whole team with
   the top-ranked pick(s) immediately - a job doesn't always need just one
   worker, see section 13. You can also manually add any ranked worker to
   the team from the preview table, one at a time, on top of anyone
   already assigned.
5. Once a job has a team, each worker gets their own **payout** field on
   the job card - type an amount and click away (or press Enter) to save
   it; see section 11 for what that feeds into. Once every assigned
   worker's payout is entered (and only then - see section 10 > "No invite
   until payout is set"), Google Calendar event(s) are created and a link
   to each appears on the job card. Use **Remove** next to a
   worker to take just them off the job, or **Unassign all** to clear the
   whole team and put the job back in the pool (both keep the calendar
   invite in sync - refreshed if anyone's left on the team, cancelled if
   not). Click **Mark complete** once the job is done.

## 8. The job scraper

`server/src/services/scraper.js` handles four shapes of response:

1. **The InstallEzi/Beehiive assembly-job JSON format** this was originally
   built against -
   `{ success, job: { jobId, location: { address }, description: [...],
   products: [...], customer: {...}, charges: [...] } }`. The interesting
   fields (scheduled date, allocated minutes, job size) are buried inside
   free-text `description` entries rather than their own fields, so
   `draftFromBeehiiveJob()` pulls them out with targeted regexes: an
   "Expected date 7:00am to 5:00pm Mon 24th Aug 2026 (ACST)" string becomes
   a real `scheduledStart`, "106 mins (1.77 hrs) allocated" becomes
   `durationMinutes`, and difficulty is derived from that duration (bumped
   up if the products list includes "SecureIT" items or has 6+ lines). Used
   for `npm run seed`'s mock data.
2. **The real Beehiive job page** (plain rendered HTML, reached via a
   login link or a direct `jobs.beehiive.com` URL) - see **Auth for
   protected job links** below for the full detail on `draftFromBeehiiveHtml()`.
3. **Other JSON APIs** - a generic field-name guesser (`title`,
   `location`, `description`, etc. under a few common names).
4. **Other plain HTML job postings** - `<title>`, meta description, and a
   regex-based text strip, then the same difficulty/location/priority
   keyword heuristics as the JSON fallback.

Whichever path it takes, every field is meant to be reviewed/edited in the
UI before saving - none of this is guaranteed to be perfect, especially on
a source it wasn't built against.

### Auth for protected job links

Two kinds of link are supported:

- A token embedded directly in the URL (fetched exactly as pasted, no extra
  setup).
- **Beehiive login links specifically** (`https://auth.beehiive.com/login?token=...`).
  These aren't the job page itself - they're a one-time-ish login link that
  redeems the token and lands you on the real job page (e.g.
  `https://jobs.beehiive.com/jobs/123/accept`). The first version of this
  handled that with a hand-written redirect-follower under the assumption
  it was a normal server-side redirect (a 301/302 with a `Set-Cookie`
  header) - but checking the actual request in DevTools showed it comes
  back as a plain **HTTP 200**, not a redirect at all. The page loads
  normally and its own **JavaScript** redeems the token and navigates
  onward - there is no server-side redirect to follow, so no amount of
  fetch/header/cookie handling can ever see that navigation happen, since
  a plain `fetch()` has no JavaScript engine.

  Because of that, `scraper.js` detects a URL on `auth.beehiive.com` and
  runs it through a real (headless) Chromium browser via
  [Playwright](https://playwright.dev/) instead - see `fetchViaBrowser()`.
  It loads the login link, lets the page's JavaScript execute and redeem
  the token, waits for the browser to actually navigate to
  `jobs.beehiive.com`, then reads the final, fully-rendered page. If the
  token is invalid/expired, the page simply never navigates away; that wait
  times out harmlessly and the (still login-looking) page it's stuck on is
  what gets checked next, producing a clear "still looks like a login
  screen" error rather than a confusing garbage draft. This needs the
  one-time `npx playwright install chromium` setup step from section 3,
  and is noticeably slower than every other link this app fetches (a few
  seconds, since it's driving a real browser, not just making an HTTP
  request) - that's expected and only affects this one link shape.
- **That browser step only has to happen once per login, not once per
  job.** Exactly like following a login link in a real browser tab keeps
  you logged in for direct links afterwards, `fetchViaBrowser()` saves the
  session cookies it ends up with (once login actually succeeded) to
  `server/.beehiive-session.json` (`services/beehiiveSession.js` - a plain
  local file, not committed to git, not stored in MongoDB, since it's
  disposable server-local session state). The next time a **direct**
  `jobs.beehiive.com/jobs/...` link is pasted (no login token needed for
  those), the plain `fetch()` path reuses that saved cookie automatically -
  no browser, no delay, just a normal fast HTTP request. If that saved
  session has since expired (or none was ever saved), the direct link
  fails with a clear "paste a fresh Beehiive login link" error instead of a
  confusing blank/garbled draft, and the stale session is cleared so the
  next attempt fails the same clear way immediately rather than retrying a
  cookie already known to be dead. In short: use a login link once when a
  session expires, then every direct job link works on its own until it
  expires again.
- The Beehiive job page itself turned out to be plain server-rendered HTML
  (not a separate JSON API call). Once a real (redacted) copy of that page
  was available, a dedicated parser - `draftFromBeehiiveHtml()` - was built
  specifically for its actual structure: the customer block right after the
  map-marker icon (name, `tel:` link, address across two lines), the
  "Expected date" heading + paragraph pair (reuses the same
  `parseExpectedDate()` regex as the JSON format, since the shape matches
  once the tags are stripped), the "N mins (X hrs) allocated" line (reuses
  `parseAllocatedMinutes()`), the product `<li>` items, the order number,
  and the "Overdue" labels (mapped straight to High priority - an overdue
  job is a real urgency signal). This runs automatically for any
  `jobs.beehiive.com` page, whether reached via the login-link flow above
  or a direct link. `draftFromBeehiiveJob()` (the JSON-based parser) is
  still used for the JSON payload shape the app was originally built
  against, including `npm run seed`'s mock data.
- For any other site whose login also turns out to be JavaScript-driven
  rather than a real redirect, the same `fetchViaBrowser()` helper can be
  reused - it's written generically (any URL, an optional `waitForUrlPattern`
  to wait for), not tied to Beehiive specifically.

## 9. Geocoding (real distance from plain addresses)

`server/src/services/geocode.js` converts a worker's or job's location
text into latitude/longitude using the free OpenStreetMap Nominatim API,
automatically, whenever you save one without coordinates already set by
hand. No API key, no extra dependency (uses `fetch`).

- If geocoding succeeds, the assignment engine (below) uses real
  great-circle distance between worker and job.
- If it fails for any reason - address not found, no network, rate
  limited - the worker/job is just saved without coordinates, and the
  assignment engine automatically falls back to comparing location text
  instead. Nothing breaks either way.
- Nominatim's usage policy caps requests at roughly 1/second and asks
  requests identify the app; both are handled in `geocode.js` (a small
  built-in throttle, and the `GEOCODE_CONTACT` env var in the
  `User-Agent`). For real production volume, swap in a paid geocoder
  (Google, Mapbox, etc.) behind the same `geocodeAddress()` signature.
- Every successful lookup is cached permanently in a `GeocodeCache`
  MongoDB collection, keyed by the normalized address text. Once an
  address has been resolved once, it is never sent to Nominatim or
  LocationIQ again - a new worker at the same address, an edit that puts
  an address back to what it was, and `npm run seed` recreating the same
  mock workers from scratch every run, all get served straight from this
  cache with zero external requests. This is separate from the
  per-worker/per-job `lat`/`lng` fields (which is what the assignment
  engine actually reads) - it exists purely so the same address is never
  looked up twice.

### If geocoding fails with "403 Forbidden"

This isn't a bug - it's Nominatim itself refusing the request. Nominatim
enforces its 1 request/second policy at the IP level: if your IP (or
anyone sharing it - office wifi, a VPN, an ISP's shared NAT) has made too
many requests recently, Nominatim blocks *all* further requests from that
IP with an immediate 403, regardless of how well-throttled the app's own
requests are. These blocks are outside the app's control and typically
clear on their own within ~20-24 hours. You can confirm it's IP-level by
opening `https://nominatim.openstreetmap.org/search?format=json&q=test`
directly in a browser - if that 403s too, it's the IP, not this code.

Either wait for it to clear, or set `LOCATIONIQ_API_KEY` in `server/.env`
(free tier at https://locationiq.com, no credit card, ~5,000 requests/day).
When that key is set, `geocode.js` automatically retries any address that
Nominatim fails on through LocationIQ instead - no other config needed. If
neither succeeds, the app still runs fine; it just falls back to
text-based location matching for that worker/job.

### Timezones

Every job's scheduled time is now handled in **that job's own work area's
real timezone**, not a single timezone for the whole app - so a 7:00am
Adelaide job and a 7:00am Auckland job are two different real moments in
time, tracked correctly, and each displays back out as "7:00am" in its own
area regardless of where you happen to be viewing the app from. This uses
`server/src/utils/timezone.js` (and its client-side mirror,
`client/src/utils/timezone.js`), which converts wall-clock time to/from a
specific IANA timezone using nothing but JavaScript's own built-in
`Intl.DateTimeFormat` - no timezone-data package (moment-timezone,
date-fns-tz, luxon, ...) needed, since Node and every browser already ship
the full IANA database, DST rules included.

- `server/src/utils/workAreas.js`'s `WORK_AREA_TIMEZONE` maps each of the
  five work areas to its real zone: Adelaide → `Australia/Adelaide`, Perth →
  `Australia/Perth`, Brisbane → `Australia/Brisbane`, NSW →
  `Australia/Sydney`, Auckland → `Pacific/Auckland`. Perth and Brisbane
  don't observe daylight saving, Adelaide/NSW/Auckland do (each on their own
  schedule, and Adelaide's is the odd 30-minute-offset one) - all of that is
  handled automatically by the IANA zone itself.
- When scraping a job, the work area is guessed from its address **before**
  its "Expected date 7:00am ... (ACST)" text is parsed, so that wall-clock
  time is interpreted in the *job's* real zone - not whichever zone
  abbreviation happens to be printed in the source text (those are
  ambiguous: AEST is shared by both NSW and Brisbane, which differ in
  daylight saving) and not the server machine's own zone (the old
  behavior - see below).
- On the Home tab's job draft form, the "Scheduled start" field shows and
  saves time in whichever work area is currently selected on that same
  form - pick the area first, then enter the time in that area's local
  time. If no work area is set yet, it falls back to a default (Adelaide).
- Job cards, the Jobs tab, the Excel export, and the Google Calendar event
  itself all display the scheduled time in the job's own work-area zone,
  with that zone's current abbreviation shown (e.g. "ACST" or "ACDT" -
  worked out automatically for whichever date is being shown).
- `TZ` in `server/.env` (e.g. `Australia/Adelaide`) is now only a
  **fallback** - used when a job's work area can't be determined at all
  (not guessed from the scraped address, not yet set by hand). It's no
  longer the single timezone the whole app runs on.

## 10. Google Calendar setup

Optional - skip this section and the app works exactly the same, just
without calendar invites (job cards will show "Not added to Google
Calendar: ..." after assigning).

This adds the job to a worker's calendar by creating an event on **your**
business's Google account and inviting the worker's email as an attendee
- it does not ask each worker to connect their own Google account, which
would need a much bigger per-worker OAuth setup.

1. In the [Google Cloud Console](https://console.cloud.google.com/):
   create a project (or use an existing one), enable the **Google Calendar
   API**, set up the OAuth consent screen (**Google Auth platform >
   Branding** - choose **External** audience unless you're on Google
   Workspace, and add your own account under **Audience > Test users**),
   then create an **OAuth client ID** of type **Desktop app** under
   **Google Auth platform > Clients**.
2. Copy that client's ID and secret into `server/.env` as
   `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.
   (There's no redirect URI field to fill in for a Desktop app client -
   Google Cloud Console doesn't show one for this client type, because it
   automatically allows any `127.0.0.1:<port>` loopback address. That's
   exactly what `scripts/getGoogleRefreshToken.js` listens on, so there's
   nothing else to configure here.)
3. Run:
   ```bash
   cd server
   npm run get-google-token
   ```
   Open the printed URL, sign in with the Google account whose calendar
   should receive job invites, and approve access.
4. Copy the `GOOGLE_REFRESH_TOKEN=...` line it prints into `server/.env`.
5. Restart the server (`npm run dev`). From now on, assigning a job
   creates a Calendar event with the worker invited, and a "View Google
   Calendar event" link appears on the job card.

By default this uses the signed-in account's main calendar (`primary`).
Set `GOOGLE_CALENDAR_ID` to a specific calendar's ID if you'd rather keep
job events separate from personal ones.

### The event's color, time zone, and description

- **Color** follows the job's work area (section 12) - Adelaide/green,
  Perth/yellow, Brisbane/purple, NSW/orange, Auckland/blue. If a job
  somehow doesn't have its own area set, the event falls back to whichever
  area the assigned worker(s) are in (`server/src/services/googleCalendar.js`'s
  `effectiveWorkArea`), so an event is essentially never left uncolored
  once someone's actually assigned.
- **Time zone** follows the same area (see section 9 > Timezones) - the
  event is created with an explicit `timeZone` alongside its `dateTime`, so
  it displays as the correct real time for that job's location regardless
  of which zone the viewing Google account defaults to.
- **Description** is built as plain text with real `•` bullet characters
  and blank lines between sections (not HTML) - Google Calendar's
  description field doesn't reliably render `<ul>`/`<li>` list markup, so
  plain bullets + line breaks is what actually looks like a bulleted list
  in the Calendar UI. It's laid out as separate sections: **Job details**
  (each scraped/typed fact - duration, order number, etc. - as its own
  bullet; the **Products** fact specifically is exploded into its own
  numbered list - `1. `, `2. `, `3. `, one per line - instead of one bullet
  with a dozen-plus items crammed onto a single semicolon-joined line),
  **Customer** (name, phone, email - each its own bullet), **Pay for this
  job**, then the assigned team and source link. Any section with nothing
  to show (e.g. no customer captured) is simply left out rather than
  showing an empty heading.
- **Pay for this job** shows ONLY a worker-payout figure - never the IKEA
  payout, GST, admin cut, or profit (those stay admin-only, inside the
  app's own Jobs tab). See "No invite until payout is set" below for how
  that figure is chosen and why nothing goes out at all until it's decided.

### No invite until payout is set, and per-worker pay privacy

**No calendar invite of any kind is sent until every currently-assigned
worker has a payout entered.** A job can be assigned and its team edited
freely before that - `job.status` becomes `"Assigned"` and the payout-entry
row for each worker appears on the job card immediately - but nobody is
notified via Google Calendar until the pay is actually settled. The job
card shows a "Calendar invite pending - enter a payout for every assigned
worker to send it" note in the meantime.

Once every assigned worker's payout is entered, `server/src/services/
googleCalendar.js`'s `syncAssignmentEvents()` decides how to send it -
Google Calendar has no way to show different text to different attendees
on one shared event, so:

- If **everyone on the job is being paid the same amount**, ONE shared
  event invites the whole team, and its Pay section shows that one figure
  once (`Worker payout: $30.00 each`).
- If **payouts differ between workers**, each worker gets their OWN
  personal event instead - only they're invited to it, and its Pay section
  shows just their own figure. Nobody can see what a teammate is being
  paid. Both events still list the full "Assigned team" by name for
  context - only the pay figure itself is hidden.

The admin isn't affected either way: the app's own Jobs tab always shows
the full breakdown (IKEA payout, GST, admin cut, every worker's payout,
profit) regardless of which path ran. A job can end up with more than one
Google Calendar event (`job.googleCalendar.events`, an array); the job
card links to each one, labelled with the worker's name when it's a
personal event.

## 11. Pay: IKEA payout, admin pay, worker payout & profit

There are three separate dollar figures on a priced job now, and the
whole point of tracking all three is the fourth one they produce - profit:

1. **IKEA payout** (`job.chargesTotal`) - what IKEA/the marketplace pays
   the business for the job, in AUD. Scraped automatically when the source
   page shows it (e.g. the real Beehiive job page's "Total ... AUD" line),
   or typed in by hand on the job draft form.
2. **Admin pay** (`job.pay.adminPay`) - the business's OWN cut of that
   payout, calculated automatically by `server/src/services/pay.js`:
   ```
   gstAmount = chargesTotal * 10%      // GST removed
   afterGst  = chargesTotal - gstAmount
   adminPay  = afterGst     * 75%      // the business's share of what's left
   ```
   Worked example: a **$100** payout has **10% GST** removed, leaving
   **$90.00**, and the business's **75% share** of that is **$67.50**. The
   breakdown (`gstAmount`, `afterGst`, `adminShare`, `adminPay`, and the
   rates used at the time) is snapshotted onto the job so it doesn't
   silently change later if `GST_RATE`/`ADMIN_SHARE` are ever tuned -
   already-assigned jobs keep the numbers they were actually invited with.
3. **Worker payout** (`job.assignedWorkers[].payout`) - what each assigned
   worker is actually paid for the job. This is **not** calculated by any
   formula - it's entered by hand per worker, once they're on the job (see
   section 7), since it's negotiated rather than a fixed split. A job with
   more than one worker (section 13) can give each one a different amount.
4. **Profit** = admin pay minus the total of everyone's worker payout on
   that job. This is the number that actually answers "how much money is
   being made."

All four are shown:

- A live **admin pay** preview on the job draft form as you type the
  charges total (worker payout doesn't exist yet at draft time - no one's
  assigned).
- On each job card once a price is set: IKEA payout, admin pay, each
  assigned worker's payout, and the resulting profit (colored green/red).
- In the **Google Calendar event description** once every assigned
  worker's payout is entered - but only their own worker-payout figure,
  never the IKEA payout/GST/admin cut/profit breakdown (see section 10 >
  "No invite until payout is set, and per-worker pay privacy" for exactly
  what each worker sees and why nothing is sent before that).
- On the **Jobs tab overview** (section 14): a KPI row totals IKEA payout,
  admin pay, worker payout, and profit across whatever's currently
  filtered, plus a per-job admin-pay breakdown and a per-worker payout
  breakdown.

Clearing the charges total (leaving it blank) clears the admin-pay
breakdown too; jobs with no price info simply don't show a pay line
anywhere.

## 12. Work areas & Google Calendar event colors

Both workers and jobs can have a **work area** - one of Adelaide, Perth,
Brisbane, NSW, or Auckland (`server/src/utils/workAreas.js` is the single
source of truth for the list, shared by both models, along with which real
timezone each one maps to - section 9 > Timezones). They mean related but
distinct things:

- **Worker.workArea** is set on the Workers page - which area a worker is
  based in/works in. It now actively gates assignment: the candidate
  ranking (Preview candidates/Auto-assign) hard-excludes any worker whose
  area doesn't match the job's (section 15) - an Adelaide job will never
  show an NSW-based worker as a candidate.
- **Job.workArea** is auto-guessed from the job's address when scraped (a
  simple keyword match on state/city names - "NSW"/"Sydney",
  "QLD"/"Brisbane", "WA"/"Perth", "SA"/"Adelaide", "Auckland"/"NZ"/"New
  Zealand" - see `guessWorkArea()`) and editable on the job draft form. It
  drives the job's scheduled-time timezone (section 9) and its Google
  Calendar event color: Adelaide = green, Perth = yellow, Brisbane =
  purple, NSW = orange, Auckland = blue (mapped to Google Calendar's own
  fixed event-color palette in `WORK_AREA_COLOR_IDS`, since Calendar
  doesn't support arbitrary hex colors on events). This is deliberately the
  JOB's own area first - so a job's color/timezone on a shared calendar
  stays consistent no matter who ends up doing it or if the assignment
  changes later - but if a job doesn't have its own area set (the address
  didn't auto-guess, or it was left blank), the calendar event falls back
  to whichever area the assigned worker(s) are actually in, so an event is
  never left uncolored just because the job's own area field was missed.

## 13. Multi-worker jobs

Not every job needs just one worker. `requiredWorkerCount()` in
`server/src/services/assignment.js` decides how many a job needs, and
whichever of these two rules asks for more wins (they're not additive):

- Over **3 hours** (`durationMinutes > 180`) needs at least **2** workers.
- An IKEA payout over **$500** (`chargesTotal > 500`) needs at least **3**
  workers.

Everything else just needs 1. `Job.assignedWorkers` is an array (each
entry a worker + their own payout - see section 11), not a single field,
so a job's "team" can be built up over time:

- **Auto-assign** fills the *whole remaining team* in one go - it computes
  how many more workers are needed (`requiredWorkerCount() -` however many
  are already on the job) and takes that many straight off the top of the
  ranking, skipping anyone already on the team.
- The **manual "Add to team"** button in the candidate preview table adds
  one specific worker on top of whoever's already assigned, rather than
  replacing the team - so you can auto-assign most of a team and hand-pick
  the rest, or build the whole thing by hand.
- Every time the team or a payout changes (auto-assign, a manual add, a
  removal, entering/editing a payout), the job's Google Calendar event(s)
  are deleted and recreated from scratch to match the current state -
  simpler and more reliable than trying to patch an existing event's
  attendee list in place. See section 10 > "No invite until payout is set,
  and per-worker pay privacy" for whether that's one shared event or one
  personal event per worker.
- The assignment engine's existing rules (availability, time-conflict
  exclusion, skill/location/load scoring - section 15) all still apply
  per-worker when filling a team; a worker already on *this* job's team is
  also excluded from its own ranking, so they're never suggested twice.

## 14. Jobs tab: filtering, charts & Excel export

The **Home** tab is now just for bringing in a new job (paste a link,
review the scraped draft, save it) - the full jobs list lives on its own
**Jobs** tab, so the two don't compete for space and Home stays focused.

The Jobs tab (`client/src/pages/Jobs.jsx`) adds:

- **Filters** - by time period (**Today** / **This week** [Mon-Sun] /
  **This month** / **All time**, default), by **worker** (a specific
  worker, **Unassigned**, or **All workers**, default), by **status**
  (**Unassigned** / **Assigned** / **Completed**, or **All statuses**,
  default), and by **work area** (Adelaide/Perth/Brisbane/NSW/Auckland,
  **No work area set**, or **All work areas**, default - matches the job's
  own work area, section 12). Filtering is by each job's scheduled time
  when it has one, falling back to when it was created otherwise, so a job
  that's never had a time set still shows up under "today" once it's added.
- **An overview chart** (`client/src/components/JobsChart.jsx`) - a small,
  dependency-free bar chart (plain HTML/CSS, no charting library needed)
  showing, across the filtered jobs: a KPI row (IKEA payout, admin pay,
  worker payout, and profit totals - section 11), jobs by status, admin
  pay by job, and worker payout by worker. It updates live as the filters
  change.
- **Export as Excel** - downloads the currently filtered jobs as a real
  `.xlsx` file (title, status, assigned worker(s), work area, location,
  schedule, duration, IKEA payout, admin pay, total worker payout, profit,
  and full customer details - name, phone, and email) via the `xlsx`
  (SheetJS) package. Run `npm install` in `client/` after unzipping to
  pull it in.

## 15. The assignment algorithm

Implemented in `server/src/services/assignment.js`, applied in this order:

1. **Availability filter (hard).** A worker is never a candidate for a
   time they told the fortnightly form they're not free for -
   `server/src/services/fortnightAvailability.js` parses their day's
   answer and compares it to the job's scheduled time (shown in the
   excluded list as e.g. "Only free 8am-11am that day ..."). This fails
   OPEN (does not exclude) whenever there's nothing to check against - no
   scheduled time on the job, or no submitted answer for that day - so a
   worker who simply hasn't answered yet isn't blocked from every job.
   There is no separate plain on/off toggle anymore (see section 18).
   Neither is a worker whose existing assigned job's scheduled time
   window genuinely overlaps the new job's a candidate - a worker can't
   physically be in two places at once, so a real time conflict is a hard
   exclusion, not just a score penalty (shown in the excluded list as
   "Time conflict with ..."). This only fires when BOTH jobs have a known
   `scheduledStart`/`durationMinutes` - if either is missing, there's
   nothing to compare, so the worker is not excluded on that basis.
2. **Work area filter (hard).** If the job has a work area set (Adelaide/
   Perth/Brisbane/NSW/Auckland - section 12), only workers whose OWN work
   area matches it exactly are considered at all - an Adelaide job will
   never show an NSW-based worker as a candidate, full stop, regardless of
   how well they'd otherwise score. A worker with no work area set on the
   Workers page doesn't match anything until they get one (shown in the
   excluded list as "Different work area ..."). If the job itself has no
   work area set, this filter doesn't apply and every worker is considered
   as before. This only gates the ranked candidate list (Preview
   candidates/Auto-assign) - manually adding a specific worker via "Add to
   team" still bypasses every check, same as it always has (section 16).
3. **Skill vs. difficulty.** Each job has a difficulty - **Easy** (under 1
   hour), **Medium** (1-3 hours), or **Difficult** (over 3 hours), either
   derived from the scraped/entered duration or set by hand, bumped up one
   tier for IKEA Secure It! items or a large product count. Since workers
   still have a more granular 1-5 `skillLevel`, each tier maps onto that
   same scale at its natural anchor (Easy=1, Medium=3, Difficult=5-
   `difficultyRank()` in `assignment.js`) purely so the two can be compared
   - a skillLevel of 5 against a Difficult job is an exact match and scores
   highest; being overqualified costs a little (keeps your most skilled
   people free for harder jobs); being underqualified costs a lot.
4. **Location.** If a worker and the job both have coordinates (usually
   automatic now, via geocoding), real great-circle distance is used
   (closer = higher score, banded at 5/20/50/100 km). Otherwise it falls
   back to a case-insensitive text match on the location field (exact
   match scores higher than a partial/substring match, no match scores
   zero). Since candidates are already narrowed to the job's own work area
   by rule 2, this is really about picking the closest match *within* that
   area.
5. **Existing assignments.** Workers already at `MAX_CONCURRENT_JOBS` active
   jobs are set aside unless literally nobody else qualifies (shown with a
   warning banner in the UI). Among workers with spare capacity, one who's
   already working a job **in the same area** is only lightly penalised
   (efficient - they're already local); one working elsewhere is penalised
   more (conflicts with their current commitment). Being completely free
   right now gives a small bonus.
6. **Priority tiebreaker.** A worker's own `priority` (Low/Medium/High) adds
   a small bonus, used only to separate otherwise-close candidates - it
   never overrides the rules above.

All scores are summed, candidates are ranked highest-to-lowest, and the
full breakdown (not just the winner) is returned so the UI can show *why*
a worker was suggested and let a human pick someone else instead.

If two candidates tie exactly on total score, the tie is broken by real
distance (the closer of the two wins) when both have coordinates - location
scoring uses coarse 5/20/50/100 km bands, so two workers at meaningfully
different distances can still land in the same band and tie on score alone;
comparing the raw distance avoids picking one arbitrarily in that case.

Weights live at the top of `assignment.js` if you want to tune them.

## 16. Extending it further

- **Smarter scraping for other sources:** the Beehiive-specific parser is
  regex-based against one real payload shape. A genuinely different
  source (a different marketplace, a plain careers-page HTML posting)
  will fall back to the generic heuristics, which are much rougher. For a
  new recurring source, add another dedicated parser branch the same way
  `draftFromBeehiiveJob` was added, or swap in an LLM call to pull
  structured fields out of the fetched page text - `scrapeJob(url)` is
  already isolated so that's a self-contained change.
- **Per-worker Google accounts:** the current Calendar integration uses
  one business account and invites workers by email. If workers should
  instead see jobs on a calendar you don't control at all (e.g. they want
  it to just work via their own Google login), that needs a full
  per-worker OAuth flow instead of the single refresh token here.
- **Manual override vs. time conflicts:** the automatic assignment engine
  hard-excludes a worker whose existing job genuinely overlaps the new
  job's scheduled time (see section 15). The manual "Assign" override
  (picking a specific worker directly, bypassing the ranking) intentionally
  skips *every* check, including that one, since it represents a deliberate
  human decision - it doesn't currently warn if the worker you pick that
  way happens to be double-booked.


## 17. Deploying it live (Render)

Everything above assumes you're running the app on your own computer
(`npm run dev` in `server/`, `npm run dev` in `client/`). This section
covers putting it on the internet as one always-on (well, "always-on" on a
free tier - see the caveat below) app with its own URL, so your team can
log in from their own phones/computers instead of only from your machine.

This app is deployed as **one Render Web Service** that does two jobs at
once: it serves the API (everything under `/api/...`, exactly like it does
locally) and it also serves the already-built React app for every other
URL. That's what the root `package.json` and the static-file serving added
to `server/src/index.js` are for - one service, one URL, no separate
frontend host and no CORS configuration to get right.

### 17.1 Push the code to GitHub

Render deploys by pulling from a GitHub (or GitLab/Bitbucket) repository,
so the code needs to be there first. From this project's folder:

```
git init
git add .
git commit -m "Initial commit"
```

Then create a new **empty** repository on github.com (don't let GitHub add
a README/`.gitignore` - this project already has its own), and push:

```
git remote add origin https://github.com/<your-username>/<repo-name>.git
git branch -M main
git push -u origin main
```

`.gitignore` already excludes `node_modules/`, `.env`, `dist/`, and the
saved Beehiive session file, so none of your secrets or local build output
will be pushed.

### 17.2 Create the Render Web Service

This has to be a **Docker**-environment Web Service, not Render's plain
Node one. The reason: Render's plain Node build runs as a non-root user,
and installing Chromium's OS-level libraries (what `playwright install
--with-deps` does) requires becoming root - trying it there fails at build
time with `su: Authentication failure`. The `Dockerfile` at the repo root
sidesteps this by starting from Playwright's own official image, which
already has Chromium and everything it needs baked in, so no root
escalation is ever required.

1. Sign in at [render.com](https://render.com) and choose **New > Web
   Service**.
2. Connect the GitHub repository you just pushed.
3. Render should auto-detect the `Dockerfile` at the repo root and set
   **Environment** to **Docker** on its own. If it instead defaults to
   "Node" (or you already created the service that way and hit the
   `su: Authentication failure` build error), open the service's
   **Settings** and look for an environment/runtime switch to change it to
   Docker; if Render doesn't offer that switch for an existing service,
   it's simplest to delete this Web Service and create a new one, this
   time confirming Docker is selected before the first deploy - you'll
   just need to re-add the environment variables (17.3) on the new one.
4. With Docker selected, **Build Command** and **Start Command** don't
   apply - the `Dockerfile` defines both (it builds the client, installs
   the server, and starts it with `node server/src/index.js`). Leave
   those fields as Render's Docker default (usually blank/greyed out).
5. **Instance type:** the Free tier works for trying this out. Two things
   to know about it (see 17.4 below) before relying on it day to day.

### 17.3 Environment variables

In the Render service's **Environment** tab, add the same variables you
already have in your local `server/.env` (open that file and copy the
values across - Render never sees your local machine, so nothing is
shared automatically):

| Key | What to set it to |
|---|---|
| `MONGO_URI` | Your MongoDB Atlas connection string (see 17.5 below - Atlas needs one extra step for Render to reach it) |
| `AUTH_SECRET` | The same value from your local `.env`, or generate a fresh one - either way, **use one value and don't change it after go-live** (changing it logs everyone out) |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | Same as local, if you set them - otherwise leave blank and read the generated password from the Render logs on first boot (Logs tab) |
| `TZ` | `Australia/Adelaide` (same as local) |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REFRESH_TOKEN` / `GOOGLE_CALENDAR_ID` | Same values as local - a refresh token isn't tied to a particular server, so the one you already generated keeps working here |
| `GOOGLE_AVAILABILITY_SHEET_ID` / `GOOGLE_AVAILABILITY_SHEET_RANGE` | Same values as local, if you've set up the availability sync (see section 18) |
| `GEOCODE_CONTACT` | Same as local |
| `LOCATIONIQ_API_KEY` | Same as local, if set |
| `CLIENT_ORIGIN` | Not needed anymore in this single-service setup (frontend and API are now the same origin) - fine to leave unset. The password-reset email's link falls back to Render's own request origin when this is unset, so it correctly points at your real `https://your-app.onrender.com` URL instead of `localhost` - see routes/auth.js's `resolveClientOrigin()` |

Don't set `PORT` - Render provides that automatically and the app already
reads `process.env.PORT`.

Once the variables are saved, click **Deploy**. The first build takes a
few minutes (it's downloading a full Chromium browser for the scraper on
top of the usual npm installs).

### 17.4 Two things that work differently once it's live

- **Free tier spins down when idle.** After ~15 minutes with no traffic,
  Render puts a free Web Service to sleep; the next request wakes it back
  up, which takes maybe 30-60 seconds. Fine for a small team tool, just
  don't be surprised by an occasional slow first load. Render's paid tiers
  remove this.
- **The saved Beehiive session doesn't survive a restart.** Locally,
  `server/.beehiive-session.json` sits on your disk and keeps working
  indefinitely. Render's free/standard Web Services have an *ephemeral*
  filesystem - anything written to disk is wiped every time the service
  redeploys or restarts (including waking up from being asleep, on some
  plans). In practice this means: after a redeploy, or after the service
  has spun down and woken back up, the first Beehiive job link may ask for
  a fresh login link again even if you pasted one recently. This isn't a
  bug, it's a real limitation of free/ephemeral hosting - if it becomes
  annoying, the fix would be storing that session in MongoDB instead of a
  local file (a real but separate change from "make it live" - ask if you
  want that done).

### 17.5 One extra step for MongoDB Atlas

Render's outbound IP address isn't fixed on the free/standard tiers, so
Atlas needs to accept connections from anywhere rather than from a
specific IP you'd normally allowlist:

In Atlas, go to **Network Access > Add IP Address > Allow Access from
Anywhere** (`0.0.0.0/0`). Without this, the deployed app will fail to
start with a MongoDB connection timeout, since Atlas will be rejecting
Render's connection before it even reaches your `MONGO_URI` credentials.

### 17.6 After it's live

Log in at the Render-provided URL (`https://<your-service-name>.onrender.com`)
using the same login you use locally (same MongoDB database = same user
accounts). From there everything works exactly as described in the rest of
this README - Settings still lets you add more logins for your team, from
their own devices, at that same URL.

## 18. Worker availability sync & fortnight rollout (Google Form)

The team fills in a fortnightly Google Form ("Bi-weekly Schedule Update")
with their availability - email, name, location, then a "Not available"
checkbox plus a Start time / End time picker per day of the upcoming two
weeks. The Workers page (`/workers`) has a **"Fortnight form rollout"**
card at the top that can fully automate the whole cycle:

- **Roll out to all workers** - creates the NEXT fortnight's Google Form
  itself (right dates already filled in), then emails every worker with an
  email address on file its link. No trip to Google Forms needed at all,
  once this is set up (see 18.1).
- **Sync fortnight availability** - pulls everyone's answers back into the
  app, filling in an "Availability" column next to each worker on this
  page (click it for the full day-by-day breakdown).
- The card also shows when the form was last rolled out and how many days
  until the next one is due (14 days later); rolling out again before then
  asks for confirmation first.

**This DOES feed the assignment engine.** There is no separate plain
"Available" toggle anymore (removed from the Workers page entirely) - a
worker is excluded from being assigned a job if the job's scheduled time
falls outside what they answered for that specific day (or if they picked
"Not available"), via `server/src/services/fortnightAvailability.js`. If
a worker hasn't answered for that day yet, they're NOT excluded (there's
nothing to check them against) - a human can still see the raw answer (or
its absence) via the Availability column's popup.

### 18.1 One-time setup

1. In the same Google Cloud project you used for Calendar (see section
   10), enable the **Google Forms API** and **Gmail API** (and **Google
   Sheets API** too, only if you want the fallback described in 18.4).
2. Re-run `npm run get-google-token` (see
   `server/scripts/getGoogleRefreshToken.js`) - it now requests every scope
   this app uses (Calendar, Gmail send, Forms create/read, and Sheets
   read) together, so this replaces your existing `GOOGLE_REFRESH_TOKEN`
   with one new token that can do all of it. Sign in with the same Google
   account as before when it opens the browser tab.
3. That's it - no spreadsheet ID or other config needed for the automatic
   path. Click **Roll out to all workers** on the Workers page whenever
   you're ready to send out the first one.
4. Every worker's email in this app must exactly match the email they type
   into the form (matching is case-insensitive, but otherwise exact). A
   response from an email that doesn't match any worker here is skipped
   and reported back in the sync result banner rather than silently
   dropped or creating a new worker automatically.

### 18.2 How it works under the hood

**Rolling out:** `server/src/services/formManager.js` builds a brand new
form via the Google Forms API - Email, Name, Location, then, per day of
the fortnight: an unticked "Not available" checkbox, a Start-time
question, and an End-time question, titled like "Monday (14/9/2026) -
Start time" (the upcoming Monday through the following Sunday). Start and
End use Google's own native time-of-day picker rather than a dropdown
list or free text - a compact hour/minute + AM/PM control in a single
row, with no restriction on which hours can be picked (a worker can pick
any time, any hour of the day). Every worker therefore answers in exactly
the same, unambiguous format. The form's own `responderUri` becomes the
link that gets emailed out, and each question's Forms-API id is
remembered (`FormRollout.questionMap`) so the next step knows exactly
which question is which.

**Syncing:** `server/src/services/availabilitySync.js` reads the checkbox
and both time answers straight back from the Forms API for any form
rolled out this way - no linked spreadsheet involved - and combines them
into one string ("8:00 AM - 5:00 PM" / "Not available") in
`Worker.formAvailability`, the same shape it's always stored in. A ticked
checkbox always means "Not available" for that day regardless of
whatever's in Start/End; if neither the checkbox nor a Start time was
answered at all, that day is stored as no answer (fortnightAvailability.js
then fails open on it, same as any day nobody's answered yet). It matches
each response to a worker by email, and only keeps entries from the last
~3 weeks per worker so old fortnights don't pile up indefinitely in the
database.

**Checking a job against it:** `fortnightAvailability.js` parses that
stored string and compares it to a job's scheduled time (in the job's own
work-area timezone). Because the auto-created form's time-picker answers
always carry an explicit AM/PM, this is an exact comparison with no
guesswork, and there's no cut-off hour - a job at any time of day is
checked the same way. The ORIGINAL, hand-made form's free-text answers
(read via the Sheets-based fallback below) still go through the same
parser's heuristics for a bare, unmarked range like "8-5" - there's no
5pm cut-off there either anymore, so a bare end hour is simply read as PM
unless that would put it before the start time (e.g. "8-11" is now read
as 8am-11pm, not 8am-11am) - see that file's own comments for the exact
rule.

If a step's Google scopes aren't set up yet, the relevant button just
reports "not configured" rather than failing oddly - the rest of the app
keeps working either way.

### 18.3 The original, hand-made form

If you'd rather keep using the original Google Form (the one this
integration was originally built against) instead of letting the app
create new ones, that still works: paste that form's link into the
card's **Form link** field and click **Save link** - "Roll out" will only
auto-create a new form when the Forms API scopes above are granted, so
leaving those out (skip step 1's Forms API / step 2's forms scopes) keeps
this manual path as the only option, and you'll duplicate the form by hand
in Google Forms every fortnight as before.

### 18.4 Reading the original form's answers (Google Sheets fallback)

A form the app didn't create itself has no Forms-API question map to read
by, so its answers are read from its linked Google Sheet instead:

1. Enable the **Google Sheets API** and make sure
   `https://www.googleapis.com/auth/spreadsheets.readonly` is in your
   refresh token's scopes (already included if you ran step 2 in 18.1).
2. Open the Google Form itself, go to its **Responses** tab, and click the
   green Sheets icon (top right of that tab) - this opens the actual
   spreadsheet Google Forms is writing responses into. Copy the long ID
   out of its URL: `docs.google.com/spreadsheets/d/`**`THIS PART`**`/edit`.
3. Set `GOOGLE_AVAILABILITY_SHEET_ID` in `server/.env` (and on Render, if
   deployed - see section 17.3) to that ID. Leave
   `GOOGLE_AVAILABILITY_SHEET_RANGE` on its default (`Form Responses 1`)
   unless you've renamed that tab in the spreadsheet.

The sync reads the header row and treats any column whose title ends in
`(D/M/YYYY)` - e.g. "Monday (14/9/2026)" - as one specific calendar day,
regardless of which day-of-week word comes before it or where it sits in
the sheet. This is only ever used as a fallback: once you roll out a
fortnight through the app itself, that and every later one read straight
from the Forms API instead (see 18.2).
