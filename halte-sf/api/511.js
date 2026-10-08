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

async function walkRoutes(a, b) {
  // Street-following routes for walking/skating (FOSSGIS OSRM foot profile), with alternatives.
  const url = `https://routing.openstreetmap.de/routed-foot/route/v1/driving/${a.lon},${a.lat};${b.lon},${b.lat}?overview=full&geometries=geojson&alternatives=3&steps=true`;
  const r = await fetch(url, { headers: { "user-agent": "HalteSF/1.0 (personal transit app)" } });
  if (!r.ok) throw Object.assign(new Error("Street routing responded " + r.status), { status: 502 });
  const j = await r.json();
  if (j.code !== "Ok" || !j.routes?.length) throw Object.assign(new Error("No street route between those points."), { status: 422 });
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
    while (next <= acc + d && next < total) {
      const f = (next - acc) / d;
      pts.push({ lat: coords[k - 1].lat + (coords[k].lat - coords[k - 1].lat) * f, lon: coords[k - 1].lon + (coords[k].lon - coords[k - 1].lon) * f, d: next });
      next += step;
    }
    acc += d;
  }
  pts.push({ ...coords[coords.length - 1], d: total });
  return { pts, total };
}

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
  for (let k = 0; k < profile.length; k++) { // steepest grade over any ~25 m+ stretch
    for (let m = k + 1; m < profile.length; m++) {
      if (profile[m].d - profile[k].d >= 25) { steepest = Math.max(steepest, ((profile[k].e - profile[m].e) / (profile[m].d - profile[k].d)) * 100); break; }
    }
  }
  return { climbs, climb: +climbs.reduce((s, c) => s + c.gain, 0).toFixed(1), steepest: +steepest.toFixed(1) };
}

async function routeHill(start, finish) {
  // 1) make sure the start is the higher end
  const ends = await elevations([start, finish]);
  let swapped = false;
  if (ends.values[1] > ends.values[0]) { [start, finish] = [finish, start]; swapped = true; }
  // 2) street routes between them, 3) elevation every ~25 m on each, 4) keep the most downhill one
  const routes = (await walkRoutes(start, finish)).slice(0, 3);
  let best = null;
  for (const rt of routes) {
    const { pts, total } = resample(rt.coords, 25, 40);
    const el = await elevations(pts);
    const profile = pts.map((p, k) => ({ d: Math.round(p.d), e: +el.values[k].toFixed(1) }));
    const a = analyse(profile);
    const drop = profile[0].e - profile[profile.length - 1].e;
    const cand = {
      start: { ...start, elev: profile[0].e }, finish: { ...finish, elev: profile[profile.length - 1].e }, swapped,
      path: rt.coords.map((c) => [+c.lat.toFixed(6), +c.lon.toFixed(6)]), streets: rt.streets,
      length: Math.round(total), drop: +drop.toFixed(1), grade: total ? +((drop / total) * 100).toFixed(1) : 0,
      steepest: a.steepest, climb: a.climb, climbs: a.climbs, downhillAll: a.climbs.length === 0,
      profile, elevSource: el.source,
    };
    if (!best || cand.climb < best.climb || (cand.climb === best.climb && cand.length < best.length)) best = cand;
    if (best.downhillAll) break;
  }
  return best;
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
  if (n > max) throw Object.assign(new Error("Too many additions from this connection. Try again in an hour."), { status: 429 });
}

function publicView(item) {
  const { owner, reporters, ...rest } = item;
  return rest;
}

async function listCommunity() {
  return cached("community", 20, async () => {
    const [sp, hl] = await Promise.all([redis("HVALS", "c:spots"), redis("HVALS", "c:hills")]);
    const parse = (arr) => (arr || []).map((x) => { try { return JSON.parse(x); } catch { return null; } })
      .filter((x) => x && !x.hidden).map(publicView);
    return { spots: parse(sp), hills: parse(hl) };
  });
}
const bust = () => mem.delete("community");

async function addSpot(body, ip) {
  const name = cleanText(body.name, 60), note = cleanText(body.note, 300);
  const type = SPOT_TYPES_OK.includes(body.type) ? body.type : "Other";
  const p = { lat: +body.lat, lon: +body.lon };
  if (name.length < 2) throw Object.assign(new Error("Give the spot a name."), { status: 400 });
  if (!inSF(p)) throw Object.assign(new Error("Spots must be in San Francisco."), { status: 400 });
  if (!body.token || String(body.token).length < 16) throw Object.assign(new Error("Missing device token."), { status: 400 });
  await rateLimit(ip, "add", 10);
  const item = { id: "c-" + crypto.randomUUID().slice(0, 12), kind: "spot", name, type, note, lat: +p.lat.toFixed(6), lon: +p.lon.toFixed(6), created: new Date().toISOString(), owner: sha(body.token), reporters: [] };
  await redis("HSET", "c:spots", item.id, JSON.stringify(item));
  bust();
  return publicView(item);
}

async function addHill(body, ip) {
  const name = cleanText(body.name, 60);
  const a = parsePoint(body.a), b = parsePoint(body.b);
  if (name.length < 2) throw Object.assign(new Error("Give the hill a name."), { status: 400 });
  if (!inSF(a) || !inSF(b)) throw Object.assign(new Error("Hills must be in San Francisco."), { status: 400 });
  if (metres(a, b) < 20 || metres(a, b) > 3000) throw Object.assign(new Error("Start and finish must be 20 m to 3 km apart."), { status: 400 });
  if (!body.token || String(body.token).length < 16) throw Object.assign(new Error("Missing device token."), { status: 400 });
  await rateLimit(ip, "add", 10);
  const route = await routeHill(a, b); // measured on the server, never trusted from the phone
  const item = { id: "c-" + crypto.randomUUID().slice(0, 12), kind: "hill", name, street: "", a, b, route, created: new Date().toISOString(), owner: sha(body.token), reporters: [] };
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
  const ok = (body.token && sha(body.token) === item.owner) || (ADMIN && body.token === ADMIN);
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
  if (!KEY && !["spots", "hills", "hillroute", "community", "addspot", "addhill", "delete", "report"].includes(q.ep)) return send(503, { error: "API_511_KEY is not set in your Vercel environment variables." });

  try {
    if (req.method === "POST") {
      const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
      const ip = String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "").split(",")[0].trim();
      switch (q.ep) {
        case "addspot": return send(200, await addSpot(body, ip));
        case "addhill": return send(200, await addHill(body, ip));
        case "delete": return send(200, await deleteItem(body));
        case "report": return send(200, await reportItem(body, ip));
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
        const a = parsePoint(q.a), b = parsePoint(q.b);
        if (!a || !b) return send(400, { error: "a and b must be lat,lon" });
        if (metres(a, b) < 20 || metres(a, b) > 3000) return send(400, { error: "Start and finish must be 20 m to 3 km apart." });
        const key = "hr|" + q.a + "|" + q.b;
        return send(200, await cached(key, 7 * 86400, () => routeHill(a, b)), 86400);
      }
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
