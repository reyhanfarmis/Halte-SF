// Copy-pasted keys often carry a stray space or newline; strip them once for every setting.
for (const k of Object.keys(process.env)) if (typeof process.env[k] === "string") process.env[k] = process.env[k].trim();
// Small caching proxy for the 511.org API: Muni (agency "SF") and BART (agency "BA").
// Runs as a Vercel Serverless Function at /api/511?ep=...
// The API key lives in the API_511_KEY environment variable and is never sent to phones.
//
// Why a proxy: 511's default limit is only ~60 requests/hour per key.
// This proxy fetches ALL arrival predictions per agency in one call
// (StopMonitoring with no stopcode), caches them, and shares them with every user.
// Budget: Muni every 100 s (36/h) + BART every 180 s (20/h) + alerts every 15 min (8/h).
// More users never means more quota used. Ask transitdata@511.org for a higher limit to refresh faster.

const KEY = process.env.API_511_KEY;
const AGENCY = "SF"; // Muni: ids are used as-is
const BART = "BA"; // BART: stop and line ids are prefixed "BA:" so they never collide with Muni
const BASE = "https://api.511.org/transit/";

const TTL = {
  arrivals: 100, // Muni, ~36 calls/hour
  arrivalsBart: 180, // BART, ~20 calls/hour
  alerts: 900, // 4 calls/hour per agency
  stops: 86400,
  lines: 86400,
  pattern: 86400,
};

const mem = new Map();

function ci(obj, ...keys) {
  // case-insensitive property access (511 is inconsistent)
  let cur = obj;
  for (const k of keys) {
    if (cur == null || typeof cur !== "object") return undefined;
    if (k in cur) { cur = cur[k]; continue; }
    const hit = Object.keys(cur).find((x) => x.toLowerCase() === String(k).toLowerCase());
    cur = hit === undefined ? undefined : cur[hit];
  }
  return cur;
}
const arr = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
const txt = (v) => (v == null ? "" : typeof v === "string" ? v : Array.isArray(v) ? txt(v[0]) : ci(v, "value") ?? ci(v, "Text") ?? "");

async function get511(path, params, ttl, transform = (x) => x) {
  const key = path + "?" + new URLSearchParams(params).toString();
  const c = mem.get(key);
  if (c && c.v !== undefined && Date.now() - c.t < ttl * 1000) return c.v;
  if (c && c.p) return c.p;

  const url = new URL(BASE + path);
  url.searchParams.set("api_key", KEY);
  url.searchParams.set("format", "json");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const p = (async () => {
    const r = await fetch(url, { headers: { accept: "application/json" } });
    if (!r.ok) throw Object.assign(new Error("511 responded " + r.status), { status: r.status });
    const t = (await r.text()).replace(/^﻿/, ""); // 511 prefixes its JSON with a BOM
    return transform(JSON.parse(t));
  })();
  mem.set(key, { ...(c || {}), p });
  try {
    const v = await p;
    mem.set(key, { t: Date.now(), v });
    return v;
  } catch (e) {
    if (c && c.v !== undefined) { mem.set(key, { t: c.t, v: c.v }); return c.v; } // serve stale data when rate-limited (429)
    mem.delete(key);
    throw e;
  }
}

// ---------- slim the responses down to what the app uses ----------

function modeOf(m) {
  m = String(m || "").toLowerCase();
  if (m.includes("cable")) return "cable";
  if (m.includes("tram") || m.includes("metro") || m.includes("rail") || m.includes("light")) return "rail";
  return "bus";
}

const pre = (ag, id) => (id == null || id === "" ? id : ag === AGENCY ? id : ag + ":" + id);
const BART_COLORS = ["Yellow", "Red", "Green", "Blue", "Orange", "Grey", "Gray", "Beige", "Purple"];

function slimLines(json, ag = AGENCY) {
  return arr(json).map((l) => {
    const id = ci(l, "Id"), name = String(ci(l, "Name") || "");
    if (ag === BART) {
      const color = BART_COLORS.find((c) => new RegExp(c, "i").test(id + " " + name)) || "";
      return { id: pre(ag, id), code: color ? color[0] : String(ci(l, "PublicCode") || id).slice(0, 3), name: name || id, mode: "bart", color: color.toLowerCase() };
    }
    return {
      id,
      code: ci(l, "PublicCode") || id,
      name: name.replace(/\b\w+/g, (w) => w[0] + w.slice(1).toLowerCase()),
      mode: modeOf(ci(l, "TransportMode")),
    };
  });
}

function slimStops(json, ag = AGENCY) {
  const list = arr(ci(json, "Contents", "dataObjects", "ScheduledStopPoint"));
  return list
    .map((s) => ({
      id: pre(ag, ci(s, "id")),
      name: ag === BART ? String(ci(s, "Name") || "").replace(/\s*BART$/i, "") + " BART" : ci(s, "Name"),
      ...(ag === BART ? { agency: "bart" } : {}),
      lat: +ci(s, "Location", "Latitude"),
      lon: +ci(s, "Location", "Longitude"),
    }))
    .filter((s) => s.id && isFinite(s.lat) && isFinite(s.lon));
}

function indexArrivals(json, ag = AGENCY) {
  const delivery = arr(ci(json, "ServiceDelivery", "StopMonitoringDelivery"))[0];
  const visits = arr(ci(delivery, "MonitoredStopVisit"));
  const byStop = {};
  const byLine = {};
  const byVehicle = {}; // every upcoming stop of each vehicle, for trip planning
  for (const v of visits) {
    const j = ci(v, "MonitoredVehicleJourney") || {};
    const call = ci(j, "MonitoredCall") || {};
    const stop = pre(ag, ci(v, "MonitoringRef") || ci(call, "StopPointRef"));
    const eta = ci(call, "ExpectedArrivalTime") || ci(call, "ExpectedDepartureTime") || ci(call, "AimedArrivalTime") || ci(call, "AimedDepartureTime");
    if (!stop || !eta) continue;
    const a = {
      line: pre(ag, ci(j, "LineRef")),
      dest: txt(ci(j, "DestinationName")),
      dir: ci(j, "DirectionRef"),
      eta,
      rt: !!(ci(call, "ExpectedArrivalTime") || ci(call, "ExpectedDepartureTime")),
      vehicle: ci(j, "VehicleRef") || "",
      occ: ci(j, "Occupancy") || "",
    };
    (byStop[stop] ||= []).push(a);
    if (a.vehicle) (byVehicle[a.line + "|" + a.vehicle] ||= []).push({ stop, t: Date.parse(eta) });
    if (a.vehicle) {
      const k = a.line + "|" + a.vehicle;
      const cur = byLine[k];
      if (!cur || new Date(eta) < new Date(cur.eta)) {
        // GPS position the vehicle reported (SIRI VehicleLocation), plus heading
        const lat = +ci(j, "VehicleLocation", "Latitude"), lon = +ci(j, "VehicleLocation", "Longitude");
        const bearing = ci(j, "Bearing");
        byLine[k] = {
          line: a.line, dir: a.dir, dest: a.dest, vehicle: a.vehicle, nextStop: stop, eta, occ: a.occ,
          ...(lat && lon && isFinite(lat) && isFinite(lon) ? { lat, lon } : {}),
          ...(bearing != null && bearing !== "" && isFinite(+bearing) ? { bearing: +bearing } : {}),
        };
      }
    }
  }
  for (const k in byVehicle) byVehicle[k].sort((x, y) => x.t - y.t);
  for (const k in byStop) byStop[k].sort((x, y) => new Date(x.eta) - new Date(y.eta)).splice(12);
  return { updated: new Date().toISOString(), byStop, byVehicle, vehicles: Object.values(byLine) };
}

function slimPatterns(json, ag = AGENCY) {
  const pats = arr(ci(json, "journeyPatterns"));
  const best = {};
  for (const p of pats) {
    const dir = ci(p, "DirectionRef") || "?";
    const pts = [
      ...arr(ci(p, "PointsInSequence", "StopPointInJourneyPattern")),
      ...arr(ci(p, "PointsInSequence", "TimingPointInJourneyPattern")),
    ]
      .map((s) => ({ order: +ci(s, "Order"), id: pre(ag, ci(s, "ScheduledStopPointRef")), name: ci(s, "Name") }))
      .sort((a, b) => a.order - b.order);
    if (!best[dir] || pts.length > best[dir].stops.length) {
      best[dir] = { dir, name: ci(p, "Name") || dir, stops: pts.map(({ id, name }) => ({ id, name })) };
    }
  }
  return Object.values(best);
}

function slimAlerts(json, ag = AGENCY) {
  const ents = arr(ci(json, "Entities") ?? ci(json, "entity"));
  const t = (x) => {
    const tr = arr(ci(x, "Translations") ?? ci(x, "translation"));
    const en = tr.find((y) => /^en/i.test(ci(y, "Language") || "")) || tr[0];
    return ci(en, "Text") || "";
  };
  return ents
    .map((e) => {
      const a = ci(e, "Alert") || {};
      const lines = [...new Set(arr(ci(a, "InformedEntities") ?? ci(a, "informed_entity")).map((x) => ci(x, "RouteId") ?? ci(x, "route_id")).filter(Boolean).map((r) => pre(ag, r)))];
      return { id: pre(ag, ci(e, "Id") || ci(e, "id")), agency: ag === BART ? "bart" : "muni", title: t(ci(a, "HeaderText") ?? ci(a, "header_text")), body: t(ci(a, "DescriptionText") ?? ci(a, "description_text")), lines };
    })
    .filter((a) => a.title);
}

// ---------- combined Muni + BART data ----------

async function allArrivals() {
  const [sf, ba] = await Promise.all([
    get511("StopMonitoring", { agency: AGENCY }, TTL.arrivals, (j) => indexArrivals(j, AGENCY)),
    get511("StopMonitoring", { agency: BART }, TTL.arrivalsBart, (j) => indexArrivals(j, BART)).catch(() => null),
  ]);
  if (!ba) return sf;
  return {
    updated: sf.updated,
    byStop: { ...sf.byStop, ...ba.byStop },
    byVehicle: { ...sf.byVehicle, ...ba.byVehicle },
    vehicles: [...sf.vehicles, ...ba.vehicles],
  };
}
async function allStops() {
  const [sf, ba] = await Promise.all([
    get511("stops", { operator_id: AGENCY }, TTL.stops, (j) => slimStops(j, AGENCY)),
    get511("stops", { operator_id: BART }, TTL.stops, (j) => slimStops(j, BART)).catch(() => []),
  ]);
  return [...sf, ...ba];
}
async function allLines() {
  const [sf, ba] = await Promise.all([
    get511("lines", { operator_id: AGENCY }, TTL.lines, (j) => slimLines(j, AGENCY)),
    get511("lines", { operator_id: BART }, TTL.lines, (j) => slimLines(j, BART)).catch(() => []),
  ]);
  return [...sf, ...ba];
}
async function allAlerts() {
  const [sf, ba] = await Promise.all([
    get511("servicealerts", { agency: AGENCY }, TTL.alerts, (j) => slimAlerts(j, AGENCY)).catch(() => []),
    get511("servicealerts", { agency: BART }, TTL.alerts, (j) => slimAlerts(j, BART)).catch(() => []),
  ]);
  return [...sf, ...ba];
}

// ---------- OpenStreetMap (Overpass) with backup servers ----------

const OVERPASS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];
async function overpass(q) {
  let last;
  for (const url of OVERPASS) {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": "HalteSF/1.0 (personal transit app)" },
        body: "data=" + encodeURIComponent(q),
      });
      if (r.ok) return await r.json();
      last = new Error("OpenStreetMap responded " + r.status);
    } catch (e) { last = e; }
  }
  throw Object.assign(last || new Error("OpenStreetMap unavailable"), { status: 502 });
}

async function cached(key, ttl, fn) {
  const c = mem.get(key);
  if (c && c.v !== undefined && Date.now() - c.t < ttl * 1000) return c.v;
  if (c && c.p) return c.p;
  const p = fn();
  mem.set(key, { ...(c || {}), p });
  try {
    const v = await p;
    mem.set(key, { t: Date.now(), v });
    return v;
  } catch (e) {
    if (c && c.v !== undefined) { mem.set(key, { t: c.t, v: c.v }); return c.v; }
    mem.delete(key);
    throw e;
  }
}

// ---------- skate spots (© OpenStreetMap contributors, ODbL) ----------

const SF_BBOX = "37.70,-122.53,37.84,-122.35";
async function fetchSkateSpots() {
  const j = await overpass(`[out:json][timeout:25];(nwr["sport"="skateboard"](${SF_BBOX});nwr["leisure"="skatepark"](${SF_BBOX}););out center tags;`);
  const seen = new Set();
  const out = [];
  for (const e of j.elements || []) {
    const lat = e.lat ?? e.center?.lat, lon = e.lon ?? e.center?.lon;
    const t = e.tags || {};
    if (lat == null || lon == null || t.shop) continue;
    const name = t.name || "Skatepark";
    const key = name + "|" + Math.round(lat * 500) + "|" + Math.round(lon * 500); // merge pieces of the same park
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ id: "osm-" + e.type[0] + e.id, name, lat: +(+lat).toFixed(6), lon: +(+lon).toFixed(6), kind: "park" });
  }
  return out;
}

// ---------- hills: start/finish, street-following route, elevation profile ----------

// Well-known steep SF blocks: [street, cross street at one end, cross street at the other end] (OSM name regexes).
// Which end is the start (top) is decided by measured elevation.
const HILLS = [
  ["^Filbert Street$", "^Hyde Street$", "^Leavenworth Street$"],
  ["^22nd Street$", "^Church Street$", "^Vicksburg Street$"],
  ["^Jones Street$", "^Union Street$", "^Filbert Street$"],
  ["^Duboce Avenue$", "^Buena Vista Avenue", "^Alpine Terrace$"],
  ["^Jones Street$", "^Green Street$", "^Union Street$"],
  ["^Webster Street$", "^Vallejo Street$", "^Broadway$"],
  ["^Duboce Avenue$", "^Alpine Terrace$", "^Divisadero Street$"],
  ["^Jones Street$", "^Pine Street$", "^California Street$"],
  ["^Fillmore Street$", "^Vallejo Street$", "^Broadway$"],
  ["^Castro Street$", "^21st Street$", "^20th Street$"],
  ["^Divisadero Street$", "^Broadway$", "^Pacific Avenue$"],
  ["^Clipper Street$", "^Douglass Street$", "^Diamond Street$"],
];

async function fetchHillList() {
  // One Overpass call: the intersection node at each end, separated by marker elements.
  let q = "[out:json][timeout:60];";
  HILLS.forEach(([st, x1, x2], i) => {
    for (const [k, x] of [["a", x1], ["b", x2]]) {
      q += `way["name"~"${st}"](${SF_BBOX})->.s;way["name"~"${x}"](${SF_BBOX})->.c;node(w.s)(w.c);out;make m i=${i},e=${k};out;`;
    }
  });
  const j = await overpass(q);
  const parts = {};
  let buf = [];
  for (const el of j.elements || []) {
    if (el.type === "m") { parts[el.tags.i + el.tags.e] = buf; buf = []; } else buf.push(el);
  }
  const clean = (r) => r.replace(/[\^$]/g, "");
  const out = [];
  HILLS.forEach(([st, x1, x2], i) => {
    const na = (parts[i + "a"] || [])[0], nb = (parts[i + "b"] || [])[0];
    if (!na || !nb) return;
    out.push({ id: "h" + i, street: clean(st), a: { lat: na.lat, lon: na.lon, cross: clean(x1) }, b: { lat: nb.lat, lon: nb.lon, cross: clean(x2) } });
  });
  return out;
}

async function elevations(points) {
  // USGS 3DEP (lidar, ~1 m in SF), 8 requests at a time; Copernicus 90 m DEM (Open-Meteo) as a fallback.
  const out = new Array(points.length).fill(null);
  let i = 0;
  const worker = async () => {
    while (i < points.length) {
      const k = i++, p = points[k];
      try {
        const r = await fetch(`https://epqs.nationalmap.gov/v1/json?x=${p.lon}&y=${p.lat}&units=Meters&wkid=4326&includeDate=false`);
        if (r.ok) { const v = +(await r.json()).value; if (isFinite(v) && v > -100) out[k] = v; }
      } catch {}
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, points.length) }, worker));
  const missing = out.map((v, k) => (v == null ? k : -1)).filter((k) => k >= 0);
  if (missing.length) {
    const r = await fetch(`https://api.open-meteo.com/v1/elevation?latitude=${missing.map((k) => points[k].lat).join(",")}&longitude=${missing.map((k) => points[k].lon).join(",")}`);
    const j = await r.json();
    missing.forEach((k, n) => (out[k] = +j.elevation[n]));
    return { values: out, source: missing.length === points.length ? "Copernicus DEM (90 m)" : "USGS 3DEP + Copernicus DEM" };
  }
  return { values: out, source: "USGS 3DEP lidar" };
}

async function streetRoutes(points, alternatives) {
  // Street-following routes through every point in order. Bike profile: stays on streets a board can roll on
  // (no stairs or footpaths); one-way rules don't apply to the bike profile the way they do for cars.
  const coords = points.map((p) => `${p.lon},${p.lat}`).join(";");
  const url = `https://routing.openstreetmap.de/routed-bike/route/v1/driving/${coords}?overview=full&geometries=geojson&steps=true&continue_straight=true` +
    (alternatives ? "&alternatives=3" : "");
  const r = await fetch(url, { headers: { "user-agent": "HalteSF/1.0 (personal transit app)" } });
  if (!r.ok) throw Object.assign(new Error("Street routing responded " + r.status), { status: 502 });
  const j = await r.json();
  if (j.code !== "Ok" || !j.routes?.length) throw Object.assign(new Error("No street route through those points."), { status: 422 });
  return j.routes.map((rt) => ({
    coords: rt.geometry.coordinates.map(([lon, lat]) => ({ lat, lon })),
    streets: [...new Set(rt.legs.flatMap((l) => l.steps.map((s) => s.name)).filter(Boolean))],
  }));
}

function resample(coords, spacing, maxPts) {
  // points every `spacing` metres along the route (plus both ends), with distance from the start
  const segs = [];
  let total = 0;
  for (let k = 1; k < coords.length; k++) { const d = metres(coords[k - 1], coords[k]); segs.push(d); total += d; }
  const step = Math.max(spacing, total / (maxPts - 1));
  const pts = [{ ...coords[0], d: 0 }];
  let next = step, acc = 0;
  for (let k = 1; k < coords.length; k++) {
    const d = segs[k - 1];
    while (d > 0 && next <= acc + d && next < total) {
      const f = (next - acc) / d;
      pts.push({ lat: coords[k - 1].lat + (coords[k].lat - coords[k - 1].lat) * f, lon: coords[k - 1].lon + (coords[k].lon - coords[k - 1].lon) * f, d: next });
      next += step;
    }
    acc += d;
  }
  pts.push({ ...coords[coords.length - 1], d: total });
  return { pts, total };
}

const WALKABLE_CLIMB_M = 8; // any single uphill stretch up to ~8 m (about two floors) counts as an easy walk

function analyse(profile) {
  // climbs: stretches where the route gains more than 1.5 m before going down again
  const climbs = [];
  let low = profile[0], climbStart = null;
  for (let k = 1; k < profile.length; k++) {
    const p = profile[k];
    if (p.e < low.e) { if (climbStart && climbStart.gain > 1.5) climbs.push(climbStart); climbStart = null; low = p; continue; }
    const gain = p.e - low.e;
    if (gain > 0.3) climbStart = { from: Math.round(low.d), to: Math.round(p.d), gain: +gain.toFixed(1) };
  }
  if (climbStart && climbStart.gain > 1.5) climbs.push(climbStart);
  let steepest = 0;
  for (let k = 0; k < profile.length; k++) { // steepest downhill grade over any ~25 m+ stretch
    for (let m = k + 1; m < profile.length; m++) {
      if (profile[m].d - profile[k].d >= 25) { steepest = Math.max(steepest, ((profile[k].e - profile[m].e) / (profile[m].d - profile[k].d)) * 100); break; }
    }
  }
  const total = profile[profile.length - 1].d || 1;
  const finalFrom = total * 0.75; // last quarter of the route
  const fin = profile.filter((p) => p.d >= finalFrom);
  const finalDrop = fin.length > 1 ? fin[0].e - fin[fin.length - 1].e : 0;
  const climbInFinal = climbs.some((c) => c.to > finalFrom && c.gain > 1.5);
  const maxClimb = climbs.reduce((m, c) => Math.max(m, c.gain), 0);
  return {
    climbs, climb: +climbs.reduce((s, c) => s + c.gain, 0).toFixed(1), steepest: +steepest.toFixed(1),
    maxClimb: +maxClimb.toFixed(1), walkable: maxClimb <= WALKABLE_CLIMB_M,
    endsDownhill: finalDrop > 1 && !climbInFinal, finalDrop: +finalDrop.toFixed(1),
  };
}

async function measure(rt, start, finish, extra) {
  const { pts, total } = resample(rt.coords, 25, 80);
  const el = await elevations(pts);
  const profile = pts.map((p, k) => ({ d: Math.round(p.d), e: +el.values[k].toFixed(1) }));
  const a = analyse(profile);
  const drop = profile[0].e - profile[profile.length - 1].e;
  return {
    start: { ...start, elev: profile[0].e }, finish: { ...finish, elev: profile[profile.length - 1].e }, ...extra,
    path: rt.coords.map((c) => [+c.lat.toFixed(6), +c.lon.toFixed(6)]), streets: rt.streets,
    length: Math.round(total), drop: +drop.toFixed(1), grade: total ? +((drop / total) * 100).toFixed(1) : 0,
    steepest: a.steepest, climb: a.climb, climbs: a.climbs, maxClimb: a.maxClimb, walkable: a.walkable,
    endsDownhill: a.endsDownhill, finalDrop: a.finalDrop, downhillAll: a.climbs.length === 0, downhillOverall: drop > 0,
    profile, elevSource: el.source,
  };
}

async function routeHill(start, finish) {
  // Two points: make sure the start is the higher end, try alternative streets, keep the most downhill one.
  const ends = await elevations([start, finish]);
  let swapped = false;
  if (ends.values[1] > ends.values[0]) { [start, finish] = [finish, start]; swapped = true; }
  const routes = (await streetRoutes([start, finish], true)).slice(0, 3);
  let best = null;
  for (const rt of routes) {
    const cand = await measure(rt, start, finish, { swapped, via: 0 });
    const score = (c) => (c.walkable ? 0 : 1000) + (c.endsDownhill ? 0 : 100) + c.climb;
    if (!best || score(cand) < score(best) || (score(cand) === score(best) && cand.length < best.length)) best = cand;
    if (best.downhillAll) break;
  }
  return best;
}

async function routeHillThrough(points) {
  // Pinned line: start, points along the way, finish, in the order the rider tapped them.
  if (points.length === 2) return routeHill(points[0], points[1]);
  const [rt] = await streetRoutes(points, false);
  const r = await measure(rt, points[0], points[points.length - 1], { swapped: false, via: points.length - 2 });
  if (!r.downhillOverall) throw Object.assign(new Error("This line ends higher than it starts. Put the start pin at the top."), { status: 422 });
  return r;
}

function parsePoints(list) {
  const arrIn = Array.isArray(list) ? list : String(list || "").split(";");
  const pts = arrIn.map(parsePoint).filter(Boolean);
  return pts.length === arrIn.length ? pts : null;
}
function checkLine(pts) {
  if (!pts || pts.length < 2) return "Set at least a start and a finish.";
  if (pts.length > 12) return "Use 12 pins or fewer.";
  if (!pts.every(inSF)) return "Hills must be in San Francisco.";
  let len = 0;
  for (let k = 1; k < pts.length; k++) len += metres(pts[k - 1], pts[k]);
  if (len < 20 || len > 6000) return "The line must be 20 m to 6 km long.";
  return null;
}

// ---------- community spots & hills (public, stored in Upstash Redis) ----------
// Set up: Vercel → Storage / Marketplace → Upstash for Redis → connect to this project.
// Vercel then adds KV_REST_API_URL + KV_REST_API_TOKEN (or UPSTASH_REDIS_REST_URL + _TOKEN).
// Optional: ADMIN_TOKEN lets the app owner delete anything.

const crypto = require("crypto");
const RURL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const RTOK = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const ADMIN = process.env.ADMIN_TOKEN || "";
const sha = (x) => crypto.createHash("sha256").update(String(x)).digest("hex");

async function redis(...cmd) {
  if (!RURL || !RTOK) throw Object.assign(new Error("Community storage isn't set up yet."), { status: 503 });
  const r = await fetch(RURL, { method: "POST", headers: { authorization: "Bearer " + RTOK, "content-type": "application/json" }, body: JSON.stringify(cmd) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw Object.assign(new Error("Storage error: " + (j.error || r.status)), { status: 502 });
  return j.result;
}

const inSF = (p) => p && p.lat > 37.6 && p.lat < 37.86 && p.lon > -122.56 && p.lon < -122.33;
const cleanText = (t, max) => String(t || "").replace(/[\u0000-\u001f\u007f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
const SPOT_TYPES_OK = ["Ledge", "Stairs", "Rail", "Gap", "Bank", "Manual pad", "Park", "Other"];

async function rateLimit(ip, kind, max) {
  const key = `rl:${kind}:${sha(ip).slice(0, 16)}:${Math.floor(Date.now() / 3600000)}`;
  const n = await redis("INCR", key);
  if (n === 1) await redis("EXPIRE", key, 3700);
  if (n > max) throw Object.assign(new Error(kind === "status" ? "Too many reports from this connection. Try again in an hour." : "Too many additions from this connection. Try again in an hour."), { status: 429 });
}

function publicView(item) {
  const { owner, reporters, ...rest } = item;
  return rest;
}

async function listCommunity() {
  return cached("community", 20, async () => {
    const [sp, hl, st] = await Promise.all([redis("HVALS", "c:spots"), redis("HVALS", "c:hills"), redis("HGETALL", "c:status").catch(() => [])]);
    const parse = (arr) => (arr || []).map((x) => { try { return JSON.parse(x); } catch { return null; } })
      .filter((x) => x && !x.hidden).map(publicView);
    const status = {};
    const flat = Array.isArray(st) ? st : Object.entries(st || {}).flat();
    for (let i = 0; i + 1 < flat.length; i += 2) { try { status[flat[i]] = summarizeStatus(JSON.parse(flat[i + 1])); } catch {} }
    const users = await usersMap();
    const named = (x) => (x.uid && users[x.uid]?.name ? { ...x, by: users[x.uid].name } : x);
    const media = await mediaAll();
    for (const l of Object.values(media)) for (const m of l) if (m.uid && users[m.uid]?.name) m.by = users[m.uid].name;
    return { spots: parse(sp).map(named), hills: parse(hl).map(named), status, media };
  });
}
const bust = () => { mem.delete("community"); mem.delete("leaders"); };
// ---------- accounts: Sign in with Google (we keep only an anonymous id and the username people pick) ----------
const GCID = process.env.GOOGLE_CLIENT_ID || "";
let gKeys = null, gKeysAt = 0;
const b64u = (x) => Buffer.from(String(x).replace(/-/g, "+").replace(/_/g, "/"), "base64");
const err = (status, msg) => Object.assign(new Error(msg), { status });
async function googleKeys() {
  if (gKeys && Date.now() - gKeysAt < 3600000) return gKeys;
  const r = await fetch("https://www.googleapis.com/oauth2/v3/certs");
  if (!r.ok) throw err(502, "Couldn't reach Google to check the sign-in.");
  gKeys = (await r.json()).keys || []; gKeysAt = Date.now();
  return gKeys;
}
async function verifyGoogle(idToken) {
  const [h, p, sg] = String(idToken || "").split(".");
  if (!h || !p || !sg) throw err(401, "Sign-in failed. Try again.");
  const head = JSON.parse(b64u(h).toString()), pay = JSON.parse(b64u(p).toString());
  const jwk = (await googleKeys()).find((k) => k.kid === head.kid);
  if (!jwk || head.alg !== "RS256") throw err(401, "Sign-in failed. Try again.");
  const ok = crypto.verify("RSA-SHA256", Buffer.from(h + "." + p), crypto.createPublicKey({ key: jwk, format: "jwk" }), b64u(sg));
  if (!ok || pay.aud !== GCID || !["accounts.google.com", "https://accounts.google.com"].includes(pay.iss) || pay.exp * 1000 < Date.now())
    throw err(401, "Sign-in failed. Try again.");
  return pay;
}
async function getUser(uid) { try { return JSON.parse((await redis("HGET", "c:users", uid)) || "null"); } catch { return null; } }
async function userFrom(session) {
  if (!session || String(session).length < 20) return null;
  const uid = await redis("GET", "sess:" + sha(session));
  return uid ? getUser(uid) : null;
}
async function googleLogin(body, req) {
  const cookies = Object.fromEntries(String(req.headers.cookie || "").split(";").map((x) => x.trim().split("=")).filter((x) => x[0]));
  if (!body.g_csrf_token || cookies.g_csrf_token !== body.g_csrf_token) throw err(400, "Sign-in check failed. Try again.");
  const pay = await verifyGoogle(body.credential);
  const uid = "u" + sha("google:" + pay.sub).slice(0, 16);
  let u = await getUser(uid);
  if (!u) { u = { uid, name: null, created: new Date().toISOString() }; await redis("HSET", "c:users", uid, JSON.stringify(u)); }
  const tok = crypto.randomBytes(24).toString("hex");
  await redis("SET", "sess:" + sha(tok), uid, "EX", 180 * 86400);
  return { tok, isNew: !u.name };
}
const NAME_RE = /^[A-Za-z0-9_.]{3,20}$/;
const BAD_NAMES = /(fuck|shit|cunt|nigg|fag|bitch|whore|slut|rape|nazi|hitler|porn|admin|halte|moderator)/i;
async function setName(body) {
  const u = await userFrom(body.session);
  if (!u) throw err(401, "Sign in again.");
  const name = String(body.name || "").trim();
  if (!NAME_RE.test(name)) throw err(400, "Use 3–20 letters, numbers, _ or .");
  if (BAD_NAMES.test(name)) throw err(400, "Pick a different name.");
  const low = name.toLowerCase(), taken = await redis("HGET", "c:unames", low);
  if (taken && taken !== u.uid) throw err(409, "That name is taken.");
  if (u.name && u.name.toLowerCase() !== low) await redis("HDEL", "c:unames", u.name.toLowerCase());
  await redis("HSET", "c:unames", low, u.uid);
  u.name = name; await redis("HSET", "c:users", u.uid, JSON.stringify(u));
  bust();
  return { uid: u.uid, name };
}
async function whoAmI(body) {
  const u = await userFrom(body.session);
  if (!u) throw err(401, "Signed out.");
  return { uid: u.uid, name: u.name };
}
async function logout(body) { if (body.session) await redis("DEL", "sess:" + sha(body.session)); return { ok: true }; }
async function poster(body) {
  if (!GCID) return null; // accounts not switched on yet: posting stays anonymous
  const u = await userFrom(body.session);
  if (!u || !u.name) throw err(401, "Sign in to add spots, skateparks and hills.");
  return u;
}
async function usersMap() {
  const flat = await redis("HGETALL", "c:users").catch(() => []);
  const arr = Array.isArray(flat) ? flat : Object.entries(flat || {}).flat(), m = {};
  for (let i = 0; i + 1 < arr.length; i += 2) { try { m[arr[i]] = JSON.parse(arr[i + 1]); } catch {} }
  return m;
}

// ---------- photos & videos (Cloudinary, signed by this server so only signed-in people can upload) ----------
const CLD = (() => { const m = /^cloudinary:\/\/(\d+):([^@]+)@([\w-]+)/.exec(process.env.CLOUDINARY_URL || ""); return m ? { key: m[1], secret: m[2], cloud: m[3] } : null; })();
const MEDIA_MAX = 12, MEDIA_ID = /^[\w:.\-]{1,80}$/;
const sha1 = (x) => crypto.createHash("sha1").update(String(x)).digest("hex");
async function mediaList(key) { try { return JSON.parse((await redis("HGET", "c:media", key)) || "[]"); } catch { return []; } }
function mediaKey(body) {
  const kind = body.kind === "hill" ? "hill" : "spot", id = String(body.id || "");
  if (!MEDIA_ID.test(id)) throw err(400, "Unknown spot.");
  return kind + ":" + id;
}
async function mediaSign(body, ip) {
  if (!CLD) throw err(503, "Photo uploads aren't switched on yet.");
  const user = await poster(body);
  if (!body.token || String(body.token).length < 16) throw err(400, "Missing device token.");
  const key = mediaKey(body);
  if ((await mediaList(key)).filter((m) => !m.hidden).length >= MEDIA_MAX) throw err(400, `This place already has ${MEDIA_MAX} photos and videos.`);
  await rateLimit(ip, "media", 30);
  const timestamp = Math.floor(Date.now() / 1000), folder = "halte/" + key.replace(":", "/");
  const signature = sha1(`folder=${folder}&timestamp=${timestamp}${CLD.secret}`);
  return { cloud: CLD.cloud, apiKey: CLD.key, timestamp, folder, signature, user: user ? user.name : null };
}
async function mediaAdd(body) {
  if (!CLD) throw err(503, "Photo uploads aren't switched on yet.");
  const user = await poster(body), key = mediaKey(body);
  const pid = String(body.public_id || ""), ver = String(body.version || "");
  if (!pid.startsWith("halte/" + key.replace(":", "/") + "/") || sha1(`public_id=${pid}&version=${ver}${CLD.secret}`) !== body.signature)
    throw err(400, "That upload couldn't be checked.");
  const type = body.resource_type === "video" ? "video" : "image";
  const list = await mediaList(key);
  if (list.some((m) => m.pid === pid)) return { key, media: list.filter((m) => !m.hidden).map(publicMedia) };
  const newId = crypto.randomUUID().slice(0, 10);
  list.push({ id: newId, t: type, pid, v: ver, w: +body.width || 0, h: +body.height || 0, dur: +body.duration || 0,
    uid: user ? user.uid : undefined, owner: sha(body.token || ""), at: Date.now(), rep: [] });
  await redis("HSET", "c:media", key, JSON.stringify(list.slice(-40)));
  bust();
  return { key, added: newId, media: list.filter((m) => !m.hidden).map(publicMedia) };
}
function publicMedia(m) {
  const base = `https://res.cloudinary.com/${CLD ? CLD.cloud : "x"}/${m.t}/upload`;
  return m.t === "video"
    ? { id: m.id, t: "video", uid: m.uid, at: m.at, w: m.w, h: m.h, dur: m.dur, src: `${base}/q_auto,w_1080,c_limit/v${m.v}/${m.pid}.mp4`, thumb: `${base}/so_0,w_480,c_limit/v${m.v}/${m.pid}.jpg` }
    : { id: m.id, t: "image", uid: m.uid, at: m.at, w: m.w, h: m.h, src: `${base}/f_auto,q_auto,w_1600,c_limit/v${m.v}/${m.pid}`, thumb: `${base}/f_auto,q_auto,w_480,c_limit/v${m.v}/${m.pid}` };
}
async function mediaReport(body, ip) {
  const key = mediaKey(body), list = await mediaList(key), m = list.find((x) => x.id === body.mid);
  if (!m) throw err(404, "Already removed.");
  const who = sha(ip).slice(0, 16);
  if (!m.rep.includes(who)) m.rep.push(who);
  if (m.rep.length >= 2) m.hidden = true; // photos go faster than spots: 2 reports hide one
  await redis("HSET", "c:media", key, JSON.stringify(list));
  bust();
  return { reported: true, hidden: !!m.hidden };
}
async function mediaDelete(body) {
  const key = mediaKey(body), list = await mediaList(key), m = list.find((x) => x.id === body.mid);
  if (!m) throw err(404, "Already removed.");
  const user = m.uid ? await userFrom(body.session).catch(() => null) : null;
  const ok = (body.token && sha(body.token) === m.owner) || (ADMIN && body.token === ADMIN) || (user && user.uid === m.uid);
  if (!ok) throw err(403, "Only the person who posted this can delete it.");
  if (CLD) { // remove the file from Cloudinary too
    const ts = Math.floor(Date.now() / 1000);
    const form = new URLSearchParams({ public_id: m.pid, timestamp: String(ts), api_key: CLD.key, signature: sha1(`public_id=${m.pid}&timestamp=${ts}${CLD.secret}`) });
    await fetch(`https://api.cloudinary.com/v1_1/${CLD.cloud}/${m.t}/destroy`, { method: "POST", body: form }).catch(() => {});
  }
  await redis("HSET", "c:media", key, JSON.stringify(list.filter((x) => x.id !== m.id)));
  bust();
  return { deleted: m.id };
}
async function mediaAll() {
  const flat = await redis("HGETALL", "c:media").catch(() => []);
  const arr = Array.isArray(flat) ? flat : Object.entries(flat || {}).flat(), out = {};
  for (let i = 0; i + 1 < arr.length; i += 2) { try { const l = JSON.parse(arr[i + 1]).filter((m) => !m.hidden).map(publicMedia); if (l.length) out[arr[i]] = l; } catch {} }
  return out;
}
async function leaderboard() {
  return cached("leaders", 60, async () => {
    const [sp, hl, st, users] = await Promise.all([redis("HVALS", "c:spots"), redis("HVALS", "c:hills"), redis("HGETALL", "c:status").catch(() => []), usersMap()]);
    const score = {};
    const add = (uid, k) => { if (!uid || !users[uid]?.name) return; (score[uid] ||= { spots: 0, parks: 0, hills: 0, reports: 0, media: 0 })[k]++; };
    for (const x of sp || []) { try { const i = JSON.parse(x); if (!i.hidden) add(i.uid, i.cat === "park" ? "parks" : "spots"); } catch {} }
    for (const x of hl || []) { try { const i = JSON.parse(x); if (!i.hidden) add(i.uid, "hills"); } catch {} }
    const flat = Array.isArray(st) ? st : Object.entries(st || {}).flat();
    for (let i = 0; i + 1 < flat.length; i += 2) { try { for (const v of JSON.parse(flat[i + 1]).votes || []) add(v.u, "reports"); } catch {} }
    const md = await redis("HGETALL", "c:media").catch(() => []), mf = Array.isArray(md) ? md : Object.entries(md || {}).flat();
    for (let i = 0; i + 1 < mf.length; i += 2) { try { for (const m of JSON.parse(mf[i + 1])) if (!m.hidden) add(m.uid, "media"); } catch {} }
    const list = Object.entries(score).map(([uid, c]) => ({ uid, name: users[uid].name, ...c, points: Math.round((c.spots + c.parks + 2 * c.hills + 0.2 * c.reports + 0.5 * c.media) * 10) / 10 }))
      .sort((a, b) => b.points - a.points || a.name.localeCompare(b.name)).slice(0, 100).map((x, k) => ({ rank: k + 1, ...x }));
    return { updated: new Date().toISOString(), leaders: list };
  });
}


// "Is it knobbed?" reports: the latest report from any phone decides; one vote per phone per spot
function summarizeStatus(cur) {
  const v = [...((cur && cur.votes) || [])].sort((a, b) => b.at - a.at);
  const last = v[0], recent = v.filter((x) => Date.now() - x.at < 180 * 86400000);
  return { knobbed: !!last && last.s === "knobbed", at: last ? last.at : null,
    knobbedVotes: recent.filter((x) => x.s === "knobbed").length, clearVotes: recent.filter((x) => x.s === "clear").length };
}
async function setStatus(body, ip) {
  const kind = body.kind === "hill" ? "hill" : "spot";
  const id = cleanText(body.id, 80), st = body.status === "knobbed" ? "knobbed" : body.status === "clear" ? "clear" : null;
  if (!id || !st) throw Object.assign(new Error("Missing spot or status."), { status: 400 });
  if (!body.token || String(body.token).length < 16) throw Object.assign(new Error("Missing device token."), { status: 400 });
  await rateLimit(ip, "status", 30);
  const key = kind + ":" + id;
  let cur = null; try { cur = JSON.parse((await redis("HGET", "c:status", key)) || "null"); } catch {}
  cur = cur && Array.isArray(cur.votes) ? cur : { votes: [] };
  const who = sha(body.token).slice(0, 16), user = await userFrom(body.session).catch(() => null);
  cur.votes = cur.votes.filter((x) => x.w !== who && (!user || x.u !== user.uid)).concat({ w: who, u: user ? user.uid : undefined, s: st, at: Date.now() }).slice(-25);
  await redis("HSET", "c:status", key, JSON.stringify(cur));
  bust();
  return { key, ...summarizeStatus(cur) };
}

async function addSpot(body, ip) {
  const user = await poster(body);
  const name = cleanText(body.name, 60), note = cleanText(body.note, 300);
  const cat = body.cat === "park" ? "park" : "spot"; // skatepark or street spot
  const type = cat === "park" ? "Park" : SPOT_TYPES_OK.includes(body.type) ? body.type : "Other";
  const p = { lat: +body.lat, lon: +body.lon };
  if (name.length < 2) throw Object.assign(new Error("Give the spot a name."), { status: 400 });
  if (!inSF(p)) throw Object.assign(new Error("Spots must be in San Francisco."), { status: 400 });
  if (!body.token || String(body.token).length < 16) throw Object.assign(new Error("Missing device token."), { status: 400 });
  await rateLimit(ip, "add", 10);
  const item = { id: "c-" + crypto.randomUUID().slice(0, 12), kind: "spot", cat, name, type, note, lat: +p.lat.toFixed(6), lon: +p.lon.toFixed(6), created: new Date().toISOString(), owner: sha(body.token), reporters: [], uid: user ? user.uid : undefined };
  await redis("HSET", "c:spots", item.id, JSON.stringify(item));
  bust();
  return publicView(item);
}

async function addHill(body, ip) {
  const user = await poster(body);
  const name = cleanText(body.name, 60);
  const pts = body.pts ? parsePoints(body.pts) : [parsePoint(body.a), parsePoint(body.b)];
  if (name.length < 2) throw Object.assign(new Error("Give the hill a name."), { status: 400 });
  const bad = checkLine(pts && pts.every(Boolean) ? pts : null);
  if (bad) throw Object.assign(new Error(bad), { status: 400 });
  if (!body.token || String(body.token).length < 16) throw Object.assign(new Error("Missing device token."), { status: 400 });
  await rateLimit(ip, "add", 10);
  const route = await routeHillThrough(pts); // measured on the server, never trusted from the phone
  const item = { id: "c-" + crypto.randomUUID().slice(0, 12), kind: "hill", name, street: "", a: pts[0], b: pts[pts.length - 1], pts, route,
    created: new Date().toISOString(), owner: sha(body.token), reporters: [], uid: user ? user.uid : undefined };
  await redis("HSET", "c:hills", item.id, JSON.stringify(item));
  bust();
  return publicView(item);
}

async function getItem(kind, id) {
  const raw = await redis("HGET", kind === "hill" ? "c:hills" : "c:spots", String(id));
  if (!raw) throw Object.assign(new Error("Not found."), { status: 404 });
  return JSON.parse(raw);
}

async function deleteItem(body) {
  const kind = body.kind === "hill" ? "hill" : "spot";
  const item = await getItem(kind, body.id);
  const user = item.uid ? await userFrom(body.session).catch(() => null) : null;
  const ok = (body.token && sha(body.token) === item.owner) || (ADMIN && body.token === ADMIN) || (user && user.uid === item.uid);
  if (!ok) throw Object.assign(new Error("Only the person who added this can delete it."), { status: 403 });
  await redis("HDEL", kind === "hill" ? "c:hills" : "c:spots", item.id);
  bust();
  return { deleted: item.id };
}

async function reportItem(body, ip) {
  const kind = body.kind === "hill" ? "hill" : "spot";
  const item = await getItem(kind, body.id);
  const who = sha(ip).slice(0, 16);
  item.reporters = item.reporters || [];
  if (!item.reporters.includes(who)) item.reporters.push(who);
  if (item.reporters.length >= 3) item.hidden = true; // hidden after 3 different people report it
  await redis("HSET", kind === "hill" ? "c:hills" : "c:spots", item.id, JSON.stringify(item));
  bust();
  return { reported: true, hidden: !!item.hidden };
}

// ---------- trip planner: one direct Muni ride, using live predictions ----------

function metres(a, b) {
  const R = 6371e3, r = (x) => (x * Math.PI) / 180;
  const dLat = r(b.lat - a.lat), dLon = r(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
const walkMin = (m) => Math.max(1, Math.round((m * 1.3) / 80)); // street detour factor, ~80 m per minute

function planTrip(idx, stops, from, to) {
  const now = Date.now();
  const near = (p) => stops.map((s) => ({ ...s, d: metres(p, s) })).filter((s) => s.d <= 750).sort((a, b) => a.d - b.d).slice(0, 25);
  const O = near(from), D = new Map(near(to).map((s) => [s.id, s]));
  const best = new Map();
  for (const o of O) {
    const w1 = walkMin(o.d);
    for (const a of idx.byStop[o.id] || []) {
      if (!a.vehicle) continue;
      const t1 = Date.parse(a.eta);
      if (t1 < now + w1 * 60000 - 30000) continue; // can't make it to the stop in time
      for (const v of idx.byVehicle[a.line + "|" + a.vehicle] || []) {
        if (v.t <= t1 || !D.has(v.stop) || v.stop === o.id) continue;
        const dst = D.get(v.stop), w2 = walkMin(dst.d), arrive = v.t + w2 * 60000;
        const key = a.line + "|" + a.dest;
        const cur = best.get(key);
        if (!cur || arrive < cur.arriveMs) {
          best.set(key, {
            line: a.line, dest: a.dest, dir: a.dir, vehicle: a.vehicle, rt: a.rt, occ: a.occ, arriveMs: arrive,
            board: { stop: o.id, name: o.name, lat: o.lat, lon: o.lon, eta: a.eta, walk: w1 },
            alight: { stop: dst.id, name: dst.name, lat: dst.lat, lon: dst.lon, eta: new Date(v.t).toISOString(), walk: w2 },
          });
        }
      }
    }
  }
  const options = [...best.values()].sort((a, b) => a.arriveMs - b.arriveMs).slice(0, 5)
    .map(({ arriveMs, ...o }) => ({ ...o, arrive: new Date(arriveMs).toISOString() }));
  const direct = metres(from, to);
  return { updated: idx.updated, walkOnly: direct < 1600 ? walkMin(direct) : null, distance: Math.round(direct), options };
}

function parsePoint(s) {
  const [lat, lon] = String(s || "").split(",").map(Number);
  return isFinite(lat) && isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon } : null;
}

// ---------- handler ----------

module.exports = async function handler(req, res) {
  const q = req.query || {};
  const send = (code, body, maxAge = 0) => {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", maxAge ? `public, s-maxage=${maxAge}, stale-while-revalidate=${maxAge}` : "no-store");
    res.status(code).send(JSON.stringify(body));
  };
  if (!KEY && !["config", "wind", "fog", "spots", "hills", "hillroute", "community", "addspot", "addhill", "delete", "report", "status", "glogin", "setname", "me", "logout", "leaders", "mediasign", "addmedia", "mediareport", "mediadelete"].includes(q.ep)) return send(503, { error: "API_511_KEY is not set in your Vercel environment variables." });

  try {
    if (req.method === "POST") {
      let body = req.body || {};
      if (typeof body === "string") body = /urlencoded/.test(String(req.headers["content-type"] || "")) ? Object.fromEntries(new URLSearchParams(body)) : JSON.parse(body || "{}");
      const ip = String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "").split(",")[0].trim();
      switch (q.ep) {
        case "addspot": return send(200, await addSpot(body, ip));
        case "addhill": return send(200, await addHill(body, ip));
        case "delete": return send(200, await deleteItem(body));
        case "report": return send(200, await reportItem(body, ip));
        case "status": return send(200, await setStatus(body, ip));
        case "glogin": {
          // Google sends the person back here after they pick their account; we hand the app a session and go home
          let to = "/";
          try { const r = await googleLogin(body, req); to = `/#s=${r.tok}&n=${r.isNew ? 1 : 0}`; }
          catch (e) { to = "/#loginerr=" + encodeURIComponent(e.message || "Sign-in failed"); }
          res.setHeader("Location", to); res.setHeader("Cache-Control", "no-store"); res.status(303); return res.send("");
        }
        case "setname": return send(200, await setName(body));
        case "mediasign": return send(200, await mediaSign(body, ip));
        case "addmedia": return send(200, await mediaAdd(body));
        case "mediareport": return send(200, await mediaReport(body, ip));
        case "mediadelete": return send(200, await mediaDelete(body));
        case "me": return send(200, await whoAmI(body));
        case "logout": return send(200, await logout(body));
        default: return send(400, { error: "unknown ep" });
      }
    }
    switch (q.ep) {
      case "ping":
        return send(200, { ok: true, agency: AGENCY });
      case "lines":
        return send(200, await allLines(), 3600);
      case "stops":
        return send(200, await allStops(), 3600);
      case "arrivals": {
        const ids = String(q.stops || "").split(",").filter(Boolean).slice(0, 40);
        const idx = await allArrivals();
        const stops = {};
        for (const id of ids) stops[id] = idx.byStop[id] || [];
        return send(200, { updated: idx.updated, stops }, 30);
      }
      case "line": {
        const line = String(q.line || "");
        if (!line) return send(400, { error: "missing line parameter" });
        const ag = line.startsWith(BART + ":") ? BART : AGENCY;
        const raw = ag === BART ? line.slice(BART.length + 1) : line;
        const [dirs, idx] = await Promise.all([
          get511("patterns", { operator_id: ag, line_id: raw }, TTL.pattern, (j) => slimPatterns(j, ag)),
          allArrivals(),
        ]);
        return send(200, { directions: dirs, vehicles: idx.vehicles.filter((v) => v.line === line) }, 30);
      }
      case "vehicles": {
        // every Muni vehicle with a GPS position, from the same cached feed (no extra 511 calls)
        const idx = await allArrivals();
        const vehicles = idx.vehicles.filter((v) => v.lat != null);
        return send(200, { updated: idx.updated, vehicles }, 30);
      }
      case "hills":
        return send(200, await cached("hills", 7 * 86400, fetchHillList), 3600);
      case "hillroute": {
        const pts = q.pts ? parsePoints(q.pts) : [parsePoint(q.a), parsePoint(q.b)];
        const bad = checkLine(pts && pts.every(Boolean) ? pts : null);
        if (bad) return send(400, { error: bad });
        const key = "hr2|" + pts.map((p) => p.lat + "," + p.lon).join(";");
        return send(200, await cached(key, 7 * 86400, () => routeHillThrough(pts)), 86400);
      }
      case "wind": {
        // current wind at the hill (Open-Meteo, free, no key); cached 15 min per ~1 km cell
        const p = parsePoint(q.at);
        if (!p) return send(400, { error: "at must be lat,lon" });
        const key = "wind|" + p.lat.toFixed(2) + "," + p.lon.toFixed(2);
        const w = await cached(key, 900, async () => {
          const r = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${p.lat.toFixed(3)}&longitude=${p.lon.toFixed(3)}&current=wind_speed_10m,wind_direction_10m,wind_gusts_10m&wind_speed_unit=ms`);
          if (!r.ok) throw Object.assign(new Error("Weather responded " + r.status), { status: 502 });
          const c = (await r.json()).current || {};
          return { speed: +c.wind_speed_10m || 0, from: +c.wind_direction_10m || 0, gusts: +c.wind_gusts_10m || 0, time: c.time || "" };
        });
        return send(200, w, 600);
      }
      case "fog": {
        // Karl the Fog check (Open-Meteo, free, no key): is it foggy here now, and when does it clear? Cached 15 min per ~1 km cell
        const p = parsePoint(q.at);
        if (!p) return send(400, { error: "at must be lat,lon" });
        const key = "fog|" + p.lat.toFixed(2) + "," + p.lon.toFixed(2);
        const f = await cached(key, 900, async () => {
          const r = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${p.lat.toFixed(3)}&longitude=${p.lon.toFixed(3)}&hourly=visibility,cloud_cover_low,relative_humidity_2m,weather_code&timezone=America%2FLos_Angeles&forecast_days=2`);
          if (!r.ok) throw Object.assign(new Error("Weather responded " + r.status), { status: 502 });
          const h = (await r.json()).hourly || {};
          const times = h.time || [];
          const nowLocal = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles" }));
          const stamp = (d) => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0") + "T" + String(d.getHours()).padStart(2, "0") + ":00";
          let i = times.indexOf(stamp(nowLocal));
          if (i < 0) i = 0;
          const at = (k) => ({ vis: +(h.visibility || [])[k], low: +(h.cloud_cover_low || [])[k], rh: +(h.relative_humidity_2m || [])[k], code: +(h.weather_code || [])[k] });
          const level = (x) => {
            if (x.code === 45 || x.code === 48 || (x.vis > 0 && x.vis < 1500)) return "thick";
            if ((x.vis > 0 && x.vis < 5000) || (x.low >= 80 && x.rh >= 88)) return "fog";
            if (x.low >= 50 && x.rh >= 80) return "patchy";
            return "clear";
          };
          const now = at(i), lvl = level(now);
          let clears = null, arrives = null;
          for (let k = i + 1; k < Math.min(times.length, i + 14); k++) {
            const l = level(at(k));
            if (lvl !== "clear" && !clears && (l === "clear" || l === "patchy")) clears = times[k];
            if (lvl === "clear" && !arrives && (l === "fog" || l === "thick")) arrives = times[k];
          }
          return { level: lvl, visibility: now.vis, lowCloud: now.low, clears, arrives, time: times[i] || "" };
        });
        return send(200, f, 600);
      }
      case "config":
        // MapTiler keys are meant to be used in the browser; restrict yours to this site's address in MapTiler.
        return send(200, { maptilerKey: process.env.MAPTILER_KEY || "", googleClientId: GCID, media: !!CLD }, 300);
      case "leaders":
        return send(200, await leaderboard(), 30);
      case "community":
        return send(200, await listCommunity(), 15);
      case "spots":
        return send(200, await cached("spots", 86400, fetchSkateSpots), 3600);
      case "plan": {
        const from = parsePoint(q.from), to = parsePoint(q.to);
        if (!from || !to) return send(400, { error: "from and to must be lat,lon" });
        const [idx, stops] = await Promise.all([allArrivals(), allStops()]);
        return send(200, planTrip(idx, stops, from, to), 0);
      }
      case "alerts":
        return send(200, await allAlerts(), 300);
      default:
        return send(400, { error: "unknown ep" });
    }
  } catch (e) {
    return send([400, 403, 404, 422, 429, 503].includes(e.status) ? e.status : 502, { error: e.message });
  }
};
