# Halte SF — a Muni transit app

A web app you can install on your phone's home screen (PWA). Features:

- **Nearby**: the closest stops to you, real-time arrivals per route, distance and walking time
- **Map**: every stop around you (tap a dot to see arrivals), "Show on map" from any stop, and route lines with live vehicles
- **Favorites**: save as many stops as you like (shown at the top of Nearby)
- **Spots**: SF skateparks from OpenStreetMap plus street spots you add yourself, each with live one-seat Muni directions from where you are
- **Hills**: bomb hills with grades measured from USGS elevation data, a difficulty level, warnings about what's at the bottom, live Muni directions to the top, and your own hills (tap both ends on the map)
- **Terms & safety**: a skate-at-your-own-risk agreement users must accept before Spots and Hills
- **Routes**: every Muni route (Metro, bus, cable car), stops in each direction, and where each vehicle is heading
- **Alerts**: Muni service alerts
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

A default 511 key is limited to roughly 60 requests per hour. The proxy in `api/511.js` fetches **all** Muni predictions in one call every 75 seconds and shares them with every user, so usage stays around 50 requests/hour no matter how many people use the app. For faster updates or heavy use, ask for a higher limit at transitdata@511.org.

## Making changes

- Rename the app: the `<title>` and the `Halte` text in `index.html`, plus `name` in `manifest.webmanifest`.
- Run it on your computer: `npm i -g vercel`, then `vercel dev` in this folder (enter `API_511_KEY` when asked, or create a `.env` file containing `API_511_KEY=...`).

## Map notes

Street maps use OpenStreetMap's free standard tiles, which are fine for personal or small-scale use. For lots of users, switch to a tile service such as MapTiler or Stadia Maps (just change the URL in the `initMap` function).

## Data sources for Spots and Hills

- Skateparks and street names: © OpenStreetMap contributors (ODbL), loaded from the Overpass API and cached for a day.
- Elevation: USGS 3DEP Elevation Point Query Service (falls back to Open-Meteo).
- Spots and hills users add are stored only on their own phone.
- The terms in the app are a starting template, not legal advice. Have a lawyer review them if the app goes public or makes money.

## Not built yet

- **A→B trip planner**: needs a separate routing server (e.g. OpenTripPlanner) loaded with Bay Area GTFS data. A good next step.
- Notifications while the app is fully closed need a push service on the server.

Transit data from 511.org. Crediting 511.org as the data source is required (the app already does). Not an official SFMTA app.
