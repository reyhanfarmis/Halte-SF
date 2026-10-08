# Halte SF — Muni + BART transit app

A web app you can install on your phone's home screen (PWA). Features:

- **Nearby**: every Muni and BART route within your range (500 m, 1 km or 1.5 km), each shown once at its closest stop, with real-time arrivals and walking time
- **Map**: every stop around you (tap a dot to see arrivals), "Show on map" from any stop, and route lines with live vehicles
- **Favorites**: save as many stops as you like (shown at the top of Nearby)
- **Spots**: SF skateparks from OpenStreetMap plus street spots anyone can add (public, shared with everyone), each with live one-seat Muni or BART directions from where you are
- **Hills**: drop up to 12 pins along the line you actually bomb; the route follows bikeable streets through every pin. An elevation profile sampled every ~25 m (USGS lidar) checks that it finishes lower than it starts, that any uphill bits are short enough to walk (8 m or less), and that it ends downhill. Live directions to the top, and hills anyone can add (shared publicly)
- **Ride time estimate**: for each hill, a physics model (gravity, rolling friction for 99a wheels, air drag, today's wind from Open-Meteo, your weight and top speed from Settings) estimates the ride down, the walk back up, one full lap, and the free-roll top speed
- **Terms & safety**: a skate-at-your-own-risk agreement users must accept before Spots and Hills
- **Routes**: every Muni route (Metro, bus, cable car) and BART line, stops in each direction, and where each vehicle is heading
- **Alerts**: Muni and BART service alerts
- **Reminders**: tap the bell on a departure and get alerted a few minutes before it arrives
- **Crowding levels** (when Muni reports them)
- Light/dark themes and 5 accent colors, no ads

Without the server set up, the app runs in **demo mode** with sample data.

## What's in the folder

| File | Purpose |
|---|---|
| `index.html` | The whole app (interface + logic) |
| `api/511.js` | Small proxy that calls 511.org and caches the results |
| `manifest.webmanifest`, `sw.js`, `icons/` | What makes the app installable |

## Put it on your phone (free, about 15 minutes)

1. **Get a 511 API key**: sign up at https://511.org/open-data/token. The key arrives by email.
2. **Put the code on GitHub**: create a new repository on github.com and upload everything in this folder (*Add file → Upload files*).
3. **Deploy on Vercel**: sign in to vercel.com with GitHub → *Add New → Project* → pick the repository.
4. Before clicking *Deploy*, open **Environment Variables** and add:
   - Name: `API_511_KEY`
   - Value: your 511.org key
5. Click **Deploy**. You'll get an address like `https://halte-sf.vercel.app`. The badge in the top-right corner switches from DEMO to **LIVE** once everything is connected.

## Install on your phone

- **iPhone (Safari)**: open the address → Share → *Add to Home Screen*.
- **Android (Chrome)**: open the address → ⋮ menu → *Install app* / *Add to Home screen*.

On iPhone, reminder notifications only work when the app is opened from its home-screen icon (iOS 16.4 or later).

## About the 511 quota

Muni arrivals refresh every 100 seconds and BART every 180 seconds to stay inside the default limit.

A default 511 key is limited to roughly 60 requests per hour. The proxy in `api/511.js` fetches **all** Muni predictions in one call every 75 seconds and shares them with every user, so usage stays around 50 requests/hour no matter how many people use the app. For faster updates or heavy use, ask for a higher limit at transitdata@511.org.

## Making changes

- Rename the app: the `<title>` and the `Halte` text in `index.html`, plus `name` in `manifest.webmanifest`.
- Run it on your computer: `npm i -g vercel`, then `vercel dev` in this folder (enter `API_511_KEY` when asked, or create a `.env` file containing `API_511_KEY=...`).

## Map notes

The map uses MapLibre GL with MapTiler's vector styles (light and dark).

1. Create a free key at maptiler.com (Account → API keys).
2. In Vercel → project → Settings → Environment Variables, add `MAPTILER_KEY` with that key, then redeploy.
3. Recommended: in MapTiler, restrict the key to your domain (e.g. `halte-sf.vercel.app`), since the key is visible to the browser.

Without `MAPTILER_KEY`, the app falls back to OpenStreetMap's standard raster tiles.

## Data sources for Spots and Hills

- Skateparks and street names: © OpenStreetMap contributors (ODbL), loaded from the Overpass API and cached for a day.
- Street routes for hills: FOSSGIS OSRM bike routing (routing.openstreetmap.de), © OpenStreetMap contributors.
- Elevation: USGS 3DEP Elevation Point Query Service (falls back to Open-Meteo).
- Wind for ride estimates: Open-Meteo current conditions, cached 15 minutes. Ride times are rough estimates, not safety advice.
- Spots and hills people add are public and stored in Upstash Redis (see below). Each phone gets a private random token so only the person who added something (or you, with ADMIN_TOKEN) can delete it. Anything reported by 3 different people is hidden automatically. Adding is limited to 10 per hour per connection, and only inside San Francisco.
- The terms in the app are a starting template, not legal advice. Have a lawyer review them if the app goes public or makes money.

## Public spots and hills: storage setup

1. In Vercel, open the halte-sf project → **Storage** → **Create Database** (or Marketplace) → **Upstash for Redis** → free plan → connect it to the project.
2. Vercel adds `KV_REST_API_URL` and `KV_REST_API_TOKEN` (or `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`) automatically. Redeploy.
3. Optional: add an environment variable `ADMIN_TOKEN` (a long random string you keep private). Using it as the token in a delete request removes any spot or hill.

Until storage is connected, new spots and hills are saved on the phone only, and the app says so.

## Not built yet

- **A→B trip planner**: needs a separate routing server (e.g. OpenTripPlanner) loaded with Bay Area GTFS data. A good next step.
- Notifications while the app is fully closed need a push service on the server.

Transit data from 511.org. Crediting 511.org as the data source is required (the app already does). Not an official SFMTA app.
