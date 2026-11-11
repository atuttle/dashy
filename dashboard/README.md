# Dashy dashboard

Plain JavaScript, CSS, and HTML built with Vite. The Android Home HQ app can display
a bundled build or a hosted URL.

## Local development

From this directory, run `npm ci`, then `npm run dev`. Open the localhost URL Vite
prints. The development server handles `GET /api/weather` and `GET /api/calendars`
and binds to localhost because calendar responses contain private event details.

Develop and verify changes locally. Install updates on the frame only when Dad
explicitly requests it; local edits and builds do not authorize a device update.

Copy `.env.example` to `.env.local` and set `PIRATE_WEATHER_API_KEY`. The key is
server-only: do not prefix it with `VITE_`, put it in JavaScript, or commit it.
`.env.local` is ignored. Restart Vite after changing the key.

## Live weather

The location and refresh interval are in `js/weather-config.js`. The initial
location is New York, NY 10001, at 40.7128, -74.006. Pirate Weather is requested
with `units=us`, so temperatures are Fahrenheit and wind speeds are mph.

`GET /api/weather` returns only normalized display data: source, location, units,
fetch time, current conditions, high/low, hourly forecasts, and a `stale` flag.
The secret is sent to Pirate Weather in its `apikey` header, with a dummy key in
the request path. Provider errors and headers are never returned to the browser.
Other request methods return 405. Missing credentials or unavailable data return
503 with a generic error message.

Requests share a fifteen-minute server cache and concurrent requests are combined.
Failures retry after one minute. Last-known data is retained for up to two hours
and marked stale; older data is hidden rather than replaced by sample temperatures.
The browser also keeps its last forecast locally for reloads/offline use.

The black line beneath weather is covered by a neon green bar that shrinks over
fifteen minutes. Its left edge stays fixed. It resets only when a new successful
forecast arrives; refreshing/reconnecting keeps the line black. Reloading the page
resumes the countdown from the saved fetch time rather than starting it over.

Current and hourly forecasts come from [Pirate Weather](https://pirateweather.net/).
The smart-home page still uses demo data. Countdowns replaces Chores and Skydiving
replaces Shopping in the sidebar; the legacy views are no longer imported or styled.
The home screen has a 1/3-width time/photos/next-countdown column and 2/3-width column with
weather and skydiving sharing its top row above the calendar. Weather shows seven
hours; skydiving occupies the upper-right corner. The Today Home status pod is
removed and the photo tile fills the remaining space beneath the compact countdown.

## Weekend skydiving

`GET /api/skydiving` provides two independent sources for KMDT (Harrisburg), not the
New York location used by the main weather pod:

- Aviation: the embedded forecast JSON and sky-condition labels from the
  [USAirNet page](https://www.usairnet.com/cgi-bin/launch/code.cgi?state=PA&sta=KMDT).
  Its converted chart values supply mph and feet; raw bulletin wind values are
  knots and raw cloud-base values are hundreds of feet. Explicit unlimited cloud
  base is distinct from missing cloud base. Flight category is taken from the page.
- Longer range: Pirate Weather's `extend=hourly` forecast for the same station.
  The existing private API key authenticates the request in a header.

Saturday and Sunday each use 9 AM–calculated local sunset in Eastern time.
On the current day only remaining jumping hours count; completed days say finished.
The current weekend remains displayed through Sunday, then rolls forward Monday.
Each day's rating uses its worst available forecast point in that window. Tap a day
for the values, reasons, source issue time, and fetch time.
The pod shows the days side by side, with 1px gaps between colored forecast bands
and the overall label beneath each stack. Each band represents an actual forecast
time (hourly for basic data, three-hourly for aviation); duplicate source times use
the more restrictive result. Unknown data is gray. The entire day, including its
bands and label, opens the existing day-details modal; bands have no separate action.

Detailed no-go: IFR/MVFR (also LIFR), wind >=24 mph, gust spread >15 mph, or cloud
base <3,000 ft AND mostly cloudy or worse. Detailed likely requires VFR, partly
cloudy or better, wind <=18 mph, gust spread <12 mph, and base >=5,000 ft (or
explicitly unlimited). Everything else is questionable.

Basic probable requires rain probability <=20%, cloud cover <=60% (partly cloudy
or better), and wind <=18 mph. A rain/snow/sleet/hail forecast icon or wind >=24 mph
is no-go; everything else is maybe. Missing required values cannot earn a favorable
rating. These labels describe the configured forecast limits.

Full-day aviation coverage takes priority. Outside that horizon, the pod explicitly
labels the basic forecast. A partial aviation forecast may downgrade the basic
rating, so known bad aviation conditions are not hidden by a favorable fallback.
Missing full-day coverage is unavailable, unless known bad conditions already
establish no-go. No category is inferred from lowest cloud base alone.

Sources refresh hourly, coalescing requests; failed sources retry after five minutes.
Source fetch age is preserved across reloads. Old model runs (>6 hours) are rejected;
stale/expired sources (>2 hours since fetch) do not produce ratings. Independent
source failures still allow the other source to be used with its own label.

Native `SkydivingData` provides the same response format for the bundled app;
rating rules and sunset calculations remain shared JavaScript. Updating these
files does not install them on the frame. The optional public Worker does not
currently serve this route.

## Skydiving logbook view

The Skydiving sidebar view is separate from the live skydiving weather pod. Its
large diagonal 45-degree **Placeholder data** ribbon with stitched edges marks the
entire page as sample data. The Logbook label sits beside the Skydiving heading,
aligned on the text baseline so descenders hang below the label.
It shows total/current-year/last-12-month jump totals, named rigs with reserve-repack
expiration dates/countdowns, annual and monthly bar charts, and an instructor panel
with the last TI/AFF/IAD jump dates. The instructor panel is conditional on
`isInstructor`; no instructor currency rules are assumed.

Sample values are generated in `js/skydiving-log-model.js`. To connect the site later,
replace `window.DATA.skydivingLog` with a response in this shape and emit
`App.emit('data')`. Set `placeholder` to false only after supplying real data:

```json
{
  "placeholder": true,
  "totalJumps": 1313,
  "rigs": [{ "name": "Primary rig", "reserveRepackExpiresOn": "2027-01-17" }],
  "jumpCountsByYear": [{ "year": 2026, "count": 212 }],
  "jumpCountsByMonth": [{ "month": "2026-11", "count": 7 }],
  "isInstructor": true,
  "instructor": {
    "lastTIJumpOn": "2026-11-04",
    "lastAFFJumpOn": "2026-10-19",
    "lastIADJumpOn": "2026-08-19"
  }
}
```

Dates are date-only ISO strings. Monthly charts include the current month and the
previous eleven, in Eastern time; missing months/counts show unknown rather than
inventing zeros. Include the complete annual/monthly arrays in a real response.
The mock is local-only and makes no new network requests or changes to the frame.

## Live calendars

Set the five `ICAL_*_URL` variables in `.env.local` for laptop development. On the
frame, the native app reads those feeds from its private imported JSON config.
Dad's personal/work feeds share one column; Mom, Kiddo, and Family each have their
own. The home pod, next event, and Calendar view all use the live events.

Feeds refresh every fifteen minutes. Failed feeds retry after one minute and keep
their last successful response for up to 24 hours with an unavailable indicator.
Calendar events are kept in memory, not browser local storage. No sample events
are substituted on failure. Feeds are read-only; edit events in Google Calendar.

The Calendar header has the same circular refresh button as Countdowns. It sends
`POST /api/calendars` to fetch all five feeds immediately, bypassing the fifteen-
minute cache and failure backoff. The button disables while refreshing; the selected
date, calendar mode, and scroll position are preserved. Failures retain available
events and show the existing unavailable message. Normal automatic polling resumes
afterward. The separate countdown feed keeps its own schedule and refresh control.
The localhost endpoint rejects cross-origin manual refresh requests; private URLs
and provider errors remain server/native-only. Unsupported methods return 405.

`ical.js` expands recurring events, time zones, exclusions, and modified instances
over the previous 45 days and next 90 days. Duplicate UIDs/occurrences within
Dad's feeds are merged; Family remains independent. Backend responses contain
only the calendar fields needed for display, never the private feed URL.

## Countdowns

Set `ICAL_COUNTDOWNS_URL` in ignored `.env.local`. The private Android config uses
an optional `"countdowns": {"url": "https://your-private-feed"}` section, generated
and imported alongside the other private settings. This feed is independent of
the five household feeds and does not add events to the regular calendar lanes.

The Countdowns sidebar view uses two columns of tall banners (232px minimum,
matching the Today next-up card). Each shows hours, days, weeks, or months until
an event, its exact date, and background art selected from the title. Event icons
are removed; the header retains its functional refresh icon. Backgrounds are
bundled for offline use:

- Birthdays: warm coral with balloons, confetti, streamers, and presents.
- Christmas: forest green, pine branches, ornaments, and snowflakes.
- Thanksgiving: chestnut/terracotta, leaves, acorns, and wheat.
- New Year's: midnight blue, muted fireworks, and confetti.
- Valentine's Day: deep berry with soft pink hearts.
- Easter: sage with pastel eggs, flowers, and a rabbit.
- Independence Day: navy with muted red/white fireworks and stars.
- Halloween: orange/black with subtle ghosts, bats, and cobwebs.
- St. Patrick's Day: emerald with shamrocks and knotwork.
- Mother's Day: dusty lavender with cream flowers and leafy stems.
- Father's Day: denim blue with plaid, ties, and stars.
- Memorial Day: slate navy with muted stripes, stars, and red poppies.
- Wedding anniversaries: wine red with interlocking rings and floral linework.
- Dating anniversaries: purple with hearts.
- Labor Day: deep teal with gears, a wrench, and a work glove.
- Veterans Day: olive with stars, service ribbons, and laurel.

Titles match case-insensitively, including `Independence Day` for July 4th.
Apostrophe variants and `wedding anniverary` are accepted. Other gift holidays
retain their generic green style.
Units align with the top
of the number; titles sit closer beneath it. Long titles wrap, banners grow to
fit their contents, and dates stay inside the card. The
list scrolls. All-day events use calendar dates; timed events under a day use
hours. Today's all-day events say Today; ongoing events say Now. Week/month counts
are approximate; the exact event date remains visible. Days stay as days through
14; 15–56 days use weeks; 57+ days use months. The header shows a relative last-update
label and the same circular refresh button as Agents, without the refresh schedule.
The button fetches the feed immediately, disables during the request, and preserves
the old update time on failure. Manual refresh does not shift the fixed schedule.

Today shows only the nearest upcoming countdown between the clock and photo tile, in a
compact 94px banner with the same themed background, the count beside the text,
smaller type, and a two-line
title. Tap it to open the full Countdowns view. The selection updates every minute,
includes all-day events happening today, and skips already-started timed events or
multi-day events underway. Saved/offline dates are labeled. If no countdown is
available, the slot is hidden and the photo tile expands. This uses the existing
feed cache and adds no source requests or refresh schedule.

Recurring events expand 400 days ahead and show the next occurrence per series.
Modified/canceled instances are honored, and past events disappear. Countdown
numbers update every minute independently of feed requests.

`GET /api/countdowns` checks the source at **6 AM, noon, and 5 PM America/New_York**,
including daylight-saving changes. The first run fetches immediately; later starts
reuse a private saved cache if it covers the latest scheduled slot. A missed slot
is caught up once when the dashboard next runs/resumes. Failed requests retry after
five minutes (or the next fixed slot, if sooner), preserving the saved source date
and clearly marking saved data as unavailable/stale in the view.

`POST /api/countdowns` forces a manual check, bypassing the schedule cache and error
backoff. Concurrent manual requests share a fetch. Localhost rejects cross-origin
manual requests; the native wrapper permits them only from its trusted dashboard.

The sanitized feed and original fetch timestamp persist in ignored, owner-only
`.cache/countdowns/` on the laptop and app-private no-backup storage on Android.
Cache filenames are hashes; switching feed URLs cannot reuse the old feed's data.
Credentials and unused iCal metadata never enter browser responses, site assets,
or the APK. Browser storage is not used. The public Worker does not expose this
private endpoint. Local builds do not install on the frame or import its config.

## Driving times

Set `TOMTOM_API_KEY` and `DASHY_HOME_ADDRESS` in ignored `.env.local` for laptop
development. The optional `travel` section in `config.local.json` stores the same
settings for the frame, using `provider: "tomtom"`, `apiKey`, and `homeAddress`.
Both values remain in server/native code; neither enters JavaScript assets or the
APK. Existing weather/calendar/photo settings are preserved when adding travel.

For upcoming timed events, Dashy uses physical US street addresses in `location`.
Vague labels, virtual meeting links, PO boxes, and unresolved/ambiguous addresses
are skipped. Every route starts at the configured home address. It does not track
anyone's current location or infer a route from the preceding appointment.

TomTom Orbis Geocoding v2 resolves addresses and Routing v3 supplies traffic-aware
driving estimates for the event's arrival time. The buffer is **drive time / 6**,
capped at 15 minutes: a 35-minute drive gets 5 minutes 50 seconds extra. Leave-by
subtracts both from the event start. The home hero shows Leave in/Leave now;
event details show driving time, buffer, and the TomTom source.

The next four addressed events within 24 hours are checked. Routes refresh every
30 minutes, increasing to every five minutes within two hours of departure.
Geocoded positions stay in server/native memory for a day. Failed requests retry
after five minutes and remove the departure estimate; browser estimates expire
after 15 minutes near departure or an hour for distant trips. Nothing is saved in
browser storage. `GET /api/travel` returns timing/status only, never home details,
coordinates, credentials, or raw provider errors. The public Worker does not
provide this private endpoint. Native support is built locally; installation and
config import still require an explicit frame-update request.

API references: [TomTom geocoding](https://docs.tomtom.com/geocoding-api/documentation/tomtom-orbis-maps/v2/geocode)
and [routing](https://docs.tomtom.com/routing-api/documentation/tomtom-orbis-maps/v3/calculate-route).

## Google Photos

Create a dedicated link-shared album in Google Photos and set
`GOOGLE_PHOTOS_ALBUM_URL` in ignored `.env.local`. Regenerate private Android config
with `python3 kiosk/config.py create --force`; its optional `photos.albumUrl` is
provisioned with the existing USB config importer when a frame update is requested.
No Google login or account cookies are stored on the frame. Anyone possessing the
album link can view that album, so the link stays private like the calendar feeds.

The shared album reader follows Google's public, undocumented album pagination
instead of stopping at the initial HTML page's roughly 300 items. It contacts
Google directly, not a third-party album proxy. Protocol reference:
[Album Slideshow's shared-album reader](https://github.com/eyalgal/album_slideshow/blob/main/custom_components/album_slideshow/google_scraper.py).
Google may change this format; failed or partial listings preserve the last complete
cache rather than deleting photos. Videos are skipped, and missing dates/locations
are not replaced by demo captions.

`GET /api/photos` lists locally saved photos using opaque IDs and same-origin
image URLs; `GET /api/photos/<id>` serves the cached bytes. Neither route exposes
the album link, Google media keys, or remote image URLs. GET is the only supported
method. The development server remains bound to localhost and denies direct access
to the cache folder.

Album checks run hourly while the dashboard is open, retrying failures after five
minutes. Initial downloads run in the background and the first photo can display
while the rest sync. Successful inventories apply additions/removals. Cached photos
survive app/server restarts and work offline. Photo favorites are local to Dashy;
they never modify Google Photos.

Each album cache holds up to 1,000 photos or 512 MiB, preferring recent photos when capped;
the Photos view reports a limit or offline/syncing status. Images are requested at
up to 1920×1920 without cropping. On the laptop, files live in ignored, server-only
`.cache/photos/` with owner-only permissions. On Android, `PhotoData` keeps them in
the app's private no-backup directory, outside the APK and ordinary Android backups.
The cache is isolated by album, so changing the link never displays a previous
album's photos. Uninstalling/clearing app data deletes the on-frame cache.

The home tile, Photos page, and automatic photo screen saver use the same live
photo library. Single-photo albums and empty albums are supported. After one idle
minute, other views return to Today; after two idle minutes, the photo screen saver
opens during the day. Tap it to return to Today.

Night mode switches on at 9:30 PM in the device's local time, including when the
app starts during the night, and returns to the normal dashboard at 6 AM. Tap the
night clock to use the dim dashboard; after 20 idle seconds it returns to the clock.
Scheduled changes wait for any full-screen alert to be dismissed. The optional
public Worker does not serve the private photo routes. Building this code does not
deploy it to the frame.

## Verification

`npm test` checks real HTTP against a local test weather server, including invalid
credentials, rate limiting, outages, incomplete responses, body timeouts, caching,
midnight rollover, stale-data handling, and the countdown. It uses a fake key and
does not contact Pirate Weather. `npm run build` creates the static site in `dist/`.

## Hosting and the frame

### On-frame secret storage

Home HQ now supports importing `config.local.json` directly into Android's private
app storage over USB. It reads this file automatically after startup, independently
of your laptop. See [private configuration over USB](kiosk/README.md#private-configuration-over-usb).
The real file is ignored by Git and blocked by the Vite development server;
`config.example.json` is the tracked template.

The bundled dashboard's `/api/calendars` and `/api/weather` requests are handled by
native `FrameData` code. It fetches the providers over HTTPS using the private
config, caches responses, and returns display data without credentials. No server
listens on the local port; these routes exist only inside the app's WebView. The
frame operates independently of the laptop and does not require hosting.

### Optional hosted deployment

The Cloudflare Worker in `server/worker.js` serves the same weather route beside
the static site. Before deploying, configure the `PIRATE_WEATHER_API_KEY` Worker
secret; the local `.env.local` file is not uploaded as a production secret.
The cache is per running server/Worker instance, not a global rate limiter.
The optional public Worker does not expose the private calendar feeds.

For the hosted approach, deploy the site and backend together and set Home HQ's
saved dashboard URL to that deployment. A static-only APK does not include the
Node/Worker backend. Secrets must never be included in the public site or APK.

No deployment or frame update is performed by the local development commands.
