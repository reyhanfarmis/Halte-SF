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
    if (a.vehicle) {
      const k = a.line + "|" + a.vehicle;
      const cur = byLine[k];
      if (!cur || new Date(eta) < new Date(cur.eta)) byLine[k] = { line: a.line, dir: a.dir, vehicle: a.vehicle, nextStop: stop, eta };
    }
  }
  for (const k in byStop) byStop[k].sort((x, y) => new Date(x.eta) - new Date(y.eta)).splice(12);
  return { updated: new Date().toISOString(), byStop, vehicles: Object.values(byLine) };
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

// ---------- handler ----------

module.exports = async function handler(req, res) {
  const q = req.query || {};
  const send = (code, body, maxAge = 0) => {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", maxAge ? `public, s-maxage=${maxAge}, stale-while-revalidate=${maxAge}` : "no-store");
    res.status(code).send(JSON.stringify(body));
  };
  if (!KEY) return send(503, { error: "API_511_KEY is not set in your Vercel environment variables." });

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
      case "alerts":
        return send(200, await get511("servicealerts", { agency: AGENCY }, TTL.alerts, slimAlerts), 300);
      default:
        return send(400, { error: "unknown ep" });
    }
  } catch (e) {
    return send(e.status === 429 ? 429 : 502, { error: e.message });
  }
};
