// Small caching proxy for the 511.org API (Muni / agency "SF").
// Runs as a Vercel Serverless Function at /api/511?ep=...
// The API key lives in the API_511_KEY environment variable and is never sent to phones.
//
// Why a proxy: 511's default limit is only ~60 requests/hour per key.
// This proxy fetches ALL Muni arrival predictions in one call
// (StopMonitoring with no stopcode), keeps them for 75 seconds, and shares them
// with every user. More users never means more quota used.

const KEY = process.env.API_511_KEY;
const AGENCY = process.env.AGENCY || "SF";
const BASE = "https://api.511.org/transit/";

const TTL = {
  arrivals: 75, // ~48 calls/hour
  alerts: 600, // 6 calls/hour
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

function slimLines(json) {
  return arr(json).map((l) => ({
    id: ci(l, "Id"),
    code: ci(l, "PublicCode") || ci(l, "Id"),
    name: String(ci(l, "Name") || "").replace(/\b\w+/g, (w) => w[0] + w.slice(1).toLowerCase()),
    mode: modeOf(ci(l, "TransportMode")),
  }));
}

function slimStops(json) {
  const list = arr(ci(json, "Contents", "dataObjects", "ScheduledStopPoint"));
  return list
    .map((s) => ({
      id: ci(s, "id"),
      name: ci(s, "Name"),
      lat: +ci(s, "Location", "Latitude"),
      lon: +ci(s, "Location", "Longitude"),
    }))
    .filter((s) => s.id && isFinite(s.lat) && isFinite(s.lon));
}

function indexArrivals(json) {
  const delivery = arr(ci(json, "ServiceDelivery", "StopMonitoringDelivery"))[0];
  const visits = arr(ci(delivery, "MonitoredStopVisit"));
  const byStop = {};
  const byLine = {};
  const byVehicle = {}; // every upcoming stop of each vehicle, for trip planning
  for (const v of visits) {
    const j = ci(v, "MonitoredVehicleJourney") || {};
    const call = ci(j, "MonitoredCall") || {};
    const stop = ci(v, "MonitoringRef") || ci(call, "StopPointRef");
    const eta = ci(call, "ExpectedArrivalTime") || ci(call, "ExpectedDepartureTime") || ci(call, "AimedArrivalTime") || ci(call, "AimedDepartureTime");
    if (!stop || !eta) continue;
    const a = {
      line: ci(j, "LineRef"),
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

function slimPatterns(json) {
  const pats = arr(ci(json, "journeyPatterns"));
  const best = {};
  for (const p of pats) {
    const dir = ci(p, "DirectionRef") || "?";
    const pts = [
      ...arr(ci(p, "PointsInSequence", "StopPointInJourneyPattern")),
      ...arr(ci(p, "PointsInSequence", "TimingPointInJourneyPattern")),
    ]
      .map((s) => ({ order: +ci(s, "Order"), id: ci(s, "ScheduledStopPointRef"), name: ci(s, "Name") }))
      .sort((a, b) => a.order - b.order);
    if (!best[dir] || pts.length > best[dir].stops.length) {
      best[dir] = { dir, name: ci(p, "Name") || dir, stops: pts.map(({ id, name }) => ({ id, name })) };
    }
  }
  return Object.values(best);
}

function slimAlerts(json) {
  const ents = arr(ci(json, "Entities") ?? ci(json, "entity"));
  const t = (x) => {
    const tr = arr(ci(x, "Translations") ?? ci(x, "translation"));
    const en = tr.find((y) => /^en/i.test(ci(y, "Language") || "")) || tr[0];
    return ci(en, "Text") || "";
  };
  return ents
    .map((e) => {
      const a = ci(e, "Alert") || {};
      const lines = [...new Set(arr(ci(a, "InformedEntities") ?? ci(a, "informed_entity")).map((x) => ci(x, "RouteId") ?? ci(x, "route_id")).filter(Boolean))];
      return { id: ci(e, "Id") || ci(e, "id"), title: t(ci(a, "HeaderText") ?? ci(a, "header_text")), body: t(ci(a, "DescriptionText") ?? ci(a, "description_text")), lines };
    })
    .filter((a) => a.title);
}

// ---------- skate spots (OpenStreetMap, © OpenStreetMap contributors, ODbL) ----------

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

const SF_BBOX = "37.70,-122.53,37.84,-122.35";
async function fetchSkateSpots() {
  const q = `[out:json][timeout:25];(nwr["sport"="skateboard"](${SF_BBOX});nwr["leisure"="skatepark"](${SF_BBOX}););out center tags;`;
  const r = await fetch("https://overpass-api.de/api/interpreter", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": "HalteSF/1.0 (personal Muni app)" },
    body: "data=" + encodeURIComponent(q),
  });
  if (!r.ok) throw Object.assign(new Error("OpenStreetMap responded " + r.status), { status: r.status });
  const j = await r.json();
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
    out.push({ id: "osm-" + e.type[0] + e.id, name, lat: +(+lat).toFixed(6), lon: +(+lon).toFixed(6), kind: "park", lit: t.lit || "", surface: t.surface || "" });
  }
  return out;
}

// ---------- bomb hills: grade from USGS elevation, intersections from OpenStreetMap ----------

// Well-known steep SF blocks: [hill street, one end cross street, other end cross street] (OSM name regexes).
// Top/bottom and grade are measured, not hard-coded.
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
const OSM_BBOX = "37.70,-122.53,37.84,-122.35";

async function overpass(q) {
  const r = await fetch("https://overpass-api.de/api/interpreter", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": "HalteSF/1.0 (personal Muni app)" },
    body: "data=" + encodeURIComponent(q),
  });
  if (!r.ok) throw Object.assign(new Error("OpenStreetMap responded " + r.status), { status: r.status });
  return r.json();
}

async function elevation(p) {
  try { // USGS 3DEP (lidar, ~1 m in SF)
    const r = await fetch(`https://epqs.nationalmap.gov/v1/json?x=${p.lon}&y=${p.lat}&units=Meters&wkid=4326&includeDate=false`);
    if (r.ok) { const j = await r.json(); const v = +j.value; if (isFinite(v) && v > -100) return { m: v, src: "USGS" }; }
  } catch {}
  const r = await fetch(`https://api.open-meteo.com/v1/elevation?latitude=${p.lat}&longitude=${p.lon}`); // fallback, ~90 m DEM
  const j = await r.json();
  return { m: +j.elevation[0], src: "Copernicus DEM" };
}

const BIG_ROADS = new Set(["primary", "secondary", "trunk", "primary_link", "secondary_link"]);
function describeEnd(node, ways, hillName) {
  const t = node?.tags || {};
  const cross = ways.find((w) => w.tags?.name && w.tags.name !== hillName) || null;
  return {
    control: t.highway === "traffic_signals" ? "signal" : t.highway === "stop" || t.stop ? "stop" : "none",
    cross: cross?.tags?.name || "",
    crossBusy: !!(cross && BIG_ROADS.has(cross.tags.highway)),
  };
}

function rateHill(h) {
  const level = h.grade >= 18 ? "Extreme" : h.grade >= 12 ? "Expert" : h.grade >= 7 ? "Advanced" : "Mellow";
  const warnings = [];
  if (h.grade >= 18) warnings.push("Grade this steep is beyond what most riders can control or stop on.");
  if (h.bottom.control === "signal") warnings.push(`Ends at a traffic light at ${h.bottom.cross || "the bottom"}.`);
  else if (h.bottom.control === "stop") warnings.push(`Stop sign at the bottom${h.bottom.cross ? " (" + h.bottom.cross + ")" : ""}. You must be able to stop.`);
  else warnings.push("No stop sign or signal mapped at the bottom. Cross traffic may not stop for you.");
  if (h.bottom.crossBusy) warnings.push(`${h.bottom.cross} is a busy street.`);
  if (h.street.busy) warnings.push("The hill itself is a busy street.");
  return { level, warnings };
}

async function measureHill(top, bottom, extra = {}) {
  const [e1, e2] = await Promise.all([elevation(top), elevation(bottom)]);
  let a = { ...top, elev: e1.m }, b = { ...bottom, elev: e2.m };
  if (b.elev > a.elev) [a, b] = [b, a]; // top is the higher end
  const length = metres(a, b);
  const drop = a.elev - b.elev;
  return { top: a, bottom: b, length: Math.round(length), drop: +drop.toFixed(1), grade: length ? +((drop / length) * 100).toFixed(1) : 0, elevSource: e1.src, ...extra };
}

async function fetchHills() {
  // One Overpass call: for each hill end, the intersection node and the ways through it, separated by markers.
  let q = "[out:json][timeout:60];";
  HILLS.forEach(([st, x1, x2], i) => {
    for (const [k, x] of [["a", x1], ["b", x2]]) {
      q += `way["name"~"${st}"](${OSM_BBOX})->.s;way["name"~"${x}"](${OSM_BBOX})->.c;node(w.s)(w.c)->.n;.n out tags;way(bn.n)["highway"];out tags;make m i=${i},e=${k};out;`;
    }
  });
  const j = await overpass(q);
  const parts = {};
  let buf = [];
  for (const el of j.elements || []) {
    if (el.type === "m") { parts[el.tags.i + el.tags.e] = buf; buf = []; } else buf.push(el);
  }
  const out = [];
  for (let i = 0; i < HILLS.length; i++) {
    const A = parts[i + "a"] || [], B = parts[i + "b"] || [];
    const na = A.find((e) => e.type === "node"), nb = B.find((e) => e.type === "node");
    if (!na || !nb) continue;
    const waysA = A.filter((e) => e.type === "way"), waysB = B.filter((e) => e.type === "way");
    const hillWay = [...waysA, ...waysB].find((w) => new RegExp(HILLS[i][0]).test(w.tags?.name || ""));
    const hillName = hillWay?.tags?.name || HILLS[i][0].replace(/[\^$]/g, "");
    try {
      const h = await measureHill({ lat: na.lat, lon: na.lon, _end: "a" }, { lat: nb.lat, lon: nb.lon, _end: "b" });
      const topIsA = h.top._end === "a";
      const endTop = describeEnd(topIsA ? na : nb, topIsA ? waysA : waysB, hillName);
      const endBot = describeEnd(topIsA ? nb : na, topIsA ? waysB : waysA, hillName);
      const hill = {
        id: "h" + i, name: `${hillName} (${endTop.cross || "?"} → ${endBot.cross || "?"})`,
        street: { name: hillName, busy: BIG_ROADS.has(hillWay?.tags?.highway) },
        top: { lat: h.top.lat, lon: h.top.lon, elev: h.top.elev, cross: endTop.cross },
        bottom: { lat: h.bottom.lat, lon: h.bottom.lon, elev: h.bottom.elev, ...endBot },
        length: h.length, drop: h.drop, grade: h.grade, elevSource: h.elevSource,
      };
      out.push({ ...hill, ...rateHill(hill) });
    } catch {}
  }
  return out.sort((a, b) => a.grade - b.grade);
}

async function measureCustomHill(p1, p2) {
  const h = await measureHill(p1, p2);
  // what's at the bottom: signals/stop signs and streets within 30 m
  let bottom = { control: "none", cross: "", crossBusy: false };
  try {
    const j = await overpass(`[out:json][timeout:20];(node(around:30,${h.bottom.lat},${h.bottom.lon})["highway"~"traffic_signals|stop"];way(around:25,${h.bottom.lat},${h.bottom.lon})["highway"]["name"];);out tags;`);
    const els = j.elements || [];
    const ctl = els.find((e) => e.type === "node");
    const ways = els.filter((e) => e.type === "way");
    bottom = {
      control: ctl?.tags?.highway === "traffic_signals" ? "signal" : ctl ? "stop" : "none",
      cross: ways.map((w) => w.tags.name).join(" / "),
      crossBusy: ways.some((w) => BIG_ROADS.has(w.tags.highway)),
    };
  } catch {}
  const hill = { street: { name: "", busy: false }, top: h.top, bottom: { ...h.bottom, ...bottom }, length: h.length, drop: h.drop, grade: h.grade, elevSource: h.elevSource };
  return { ...hill, ...rateHill(hill) };
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
  if (!KEY && !["spots", "hills", "hillcalc"].includes(q.ep)) return send(503, { error: "API_511_KEY is not set in your Vercel environment variables." });

  try {
    switch (q.ep) {
      case "ping":
        return send(200, { ok: true, agency: AGENCY });
      case "lines":
        return send(200, await get511("lines", { operator_id: AGENCY }, TTL.lines, slimLines), 3600);
      case "stops":
        return send(200, await get511("stops", { operator_id: AGENCY }, TTL.stops, slimStops), 3600);
      case "arrivals": {
        const ids = String(q.stops || "").split(",").filter(Boolean).slice(0, 30);
        const idx = await get511("StopMonitoring", { agency: AGENCY }, TTL.arrivals, indexArrivals);
        const stops = {};
        for (const id of ids) stops[id] = idx.byStop[id] || [];
        return send(200, { updated: idx.updated, stops }, 30);
      }
      case "line": {
        const line = String(q.line || "");
        if (!line) return send(400, { error: "missing line parameter" });
        const [dirs, idx] = await Promise.all([
          get511("patterns", { operator_id: AGENCY, line_id: line }, TTL.pattern, slimPatterns),
          get511("StopMonitoring", { agency: AGENCY }, TTL.arrivals, indexArrivals),
        ]);
        return send(200, { directions: dirs, vehicles: idx.vehicles.filter((v) => v.line === line) }, 30);
      }
      case "vehicles": {
        // every Muni vehicle with a GPS position, from the same cached feed (no extra 511 calls)
        const idx = await get511("StopMonitoring", { agency: AGENCY }, TTL.arrivals, indexArrivals);
        const vehicles = idx.vehicles.filter((v) => v.lat != null);
        return send(200, { updated: idx.updated, vehicles }, 30);
      }
      case "hills":
        return send(200, await cached("hills", 7 * 86400, fetchHills), 3600);
      case "hillcalc": {
        const a = parsePoint(q.a), b = parsePoint(q.b);
        if (!a || !b) return send(400, { error: "a and b must be lat,lon" });
        if (metres(a, b) < 20 || metres(a, b) > 3000) return send(400, { error: "Top and bottom must be 20 m to 3 km apart." });
        return send(200, await measureCustomHill(a, b), 86400);
      }
      case "spots":
        return send(200, await cached("spots", 86400, fetchSkateSpots), 3600);
      case "plan": {
        const from = parsePoint(q.from), to = parsePoint(q.to);
        if (!from || !to) return send(400, { error: "from and to must be lat,lon" });
        const [idx, stops] = await Promise.all([
          get511("StopMonitoring", { agency: AGENCY }, TTL.arrivals, indexArrivals),
          get511("stops", { operator_id: AGENCY }, TTL.stops, slimStops),
        ]);
        return send(200, planTrip(idx, stops, from, to), 0);
      }
      case "alerts":
        return send(200, await get511("servicealerts", { agency: AGENCY }, TTL.alerts, slimAlerts), 300);
      default:
        return send(400, { error: "unknown ep" });
    }
  } catch (e) {
    return send(e.status === 429 ? 429 : 502, { error: e.message });
  }
};
