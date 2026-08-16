/**
 * discover-stations.ts — find live WAQI feeds near the seeded locations.
 *
 * Run:
 *   npm run discover:stations            # report + paste-ready seed SQL
 *   npm run discover:stations -- --all   # include stations already seeded
 *
 * This is the tool for the day a station dies. WAQI's Indonesian coverage moves:
 * uids disappear, sensors go dormant, and `ingest/aq.ts` will eventually mark a
 * station inactive and tell you to run this. It touches no database — it reads
 * the compile-time seed mirror in src/lib/stations.ts and prints SQL for you to
 * paste, because adding a station is a decision (is it near enough? is it the
 * right network?) rather than something a cron job should do unattended.
 *
 * ---------------------------------------------------------------------------
 * Why two calls per station
 * ---------------------------------------------------------------------------
 * `/v2/map/bounds/` is cheap and returns everything in a box, but only
 * `{lat, lon, uid, aqi, station:{name, time}}` — no attribution, so no way to
 * tell a BMKG reference monitor from someone's Clarity sensor, and the licence
 * obligation (WAQI requires the upstream network to be credited) cannot be met
 * from it. So each candidate's `/feed/@uid/` is fetched too. Twenty stations at
 * a 250 ms delay is about five seconds.
 *
 * It also independently re-verifies the "Unknown ID" behaviour: a uid that the
 * bounds sweep returns but whose feed says `{"status":"error"}` is a ghost, and
 * seeding it would produce a station that never reports.
 */

import { ALL_STATIONS, LOCATIONS, STALE_FEED_HOURS, type LocationConfig } from '../src/lib/stations';
import type { LocationSlug } from '../src/lib/types';
import { fetchJson, sleep } from './lib/http';
import { guessNetwork, parseWaqiFeed } from './lib/waqi';

const DELAY_MS = 250;

/**
 * Bounding boxes to sweep, `lat1,lng1,lat2,lng2` (south-west, north-east).
 * Deliberately wider than the locations themselves: a replacement station 20 km
 * away is still far better than no station, which is Bali's current situation.
 */
const BOXES: { name: string; latlng: string }[] = [
  { name: 'Jabodetabek', latlng: '-6.70,106.30,-5.85,107.20' },
  { name: 'Bali', latlng: '-8.95,114.70,-8.20,115.60' },
];

/** Great-circle distance in km. Plain haversine; the earth is a sphere here. */
function haversineKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function nearestLocation(lat: number, lon: number): { loc: LocationConfig; km: number } {
  // Indonesian locations only: a Jakarta sweep must never propose attaching a
  // station to a Singapore region, whose PM2.5 comes from data.gov.sg anyway.
  const candidates = LOCATIONS.filter((l) => l.country === 'ID');
  let best = { loc: candidates[0], km: Number.POSITIVE_INFINITY };
  for (const loc of candidates) {
    const km = haversineKm(lat, lon, loc.lat, loc.lon);
    if (km < best.km) best = { loc, km };
  }
  return best;
}

interface Candidate {
  uid: string;
  name: string;
  lat: number;
  lon: number;
  ageHours: number | null;
  aqi: number | null;
  pm25: number | null;
  attributions: string[];
  network: string | null;
  nearest: LocationSlug;
  nearestKm: number;
  seeded: boolean;
  status: 'fresh' | 'stale' | 'no-pm25' | 'dead';
  detail: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

async function sweep(token: string, box: { name: string; latlng: string }): Promise<{ uid: string; lat: number; lon: number; name: string }[]> {
  const url = `https://api.waqi.info/v2/map/bounds/?latlng=${box.latlng}&networks=all&token=${encodeURIComponent(token)}`;
  const res = await fetchJson<unknown>(url);
  if (!res.ok) {
    console.error(`  ✗ ${box.name}: ${res.message}`);
    return [];
  }
  const body = res.data;
  if (!isRecord(body) || !Array.isArray(body.data)) {
    console.error(`  ✗ ${box.name}: unexpected response shape`);
    return [];
  }
  const out: { uid: string; lat: number; lon: number; name: string }[] = [];
  for (const entry of body.data) {
    if (!isRecord(entry)) continue;
    const uid = entry.uid;
    const lat = entry.lat;
    const lon = entry.lon;
    if (typeof uid !== 'number' || typeof lat !== 'number' || typeof lon !== 'number') continue;
    const station = isRecord(entry.station) ? entry.station : null;
    out.push({ uid: String(uid), lat, lon, name: typeof station?.name === 'string' ? station.name : `uid ${uid}` });
  }
  return out;
}

function sqlEscape(s: string): string {
  return s.replace(/'/g, "''");
}

async function main(): Promise<void> {
  const token = process.env.WAQI_TOKEN?.trim();
  if (!token) {
    console.error('Missing WAQI_TOKEN. Add it to .env.local (see .env.example) or export it before running.');
    process.exitCode = 1;
    return;
  }

  const includeSeeded = process.argv.slice(2).includes('--all');
  const seededUids = new Set(ALL_STATIONS.filter((s) => s.source === 'waqi').map((s) => s.sourceStationId));
  const now = new Date();

  console.log('Sweeping WAQI /v2/map/bounds/ …');
  const found = new Map<string, { uid: string; lat: number; lon: number; name: string }>();
  for (const box of BOXES) {
    const hits = await sweep(token, box);
    console.log(`  ${box.name.padEnd(12)} ${hits.length} station(s)`);
    for (const h of hits) found.set(h.uid, h);
  }

  console.log(`\nResolving ${found.size} feed(s) for freshness and attribution …\n`);
  const candidates: Candidate[] = [];

  for (const [i, hit] of [...found.values()].entries()) {
    if (i > 0) await sleep(DELAY_MS);

    const res = await fetchJson<unknown>(`https://api.waqi.info/feed/@${hit.uid}/?token=${encodeURIComponent(token)}`);
    const nearest = nearestLocation(hit.lat, hit.lon);

    const base = {
      uid: hit.uid,
      name: hit.name,
      lat: hit.lat,
      lon: hit.lon,
      nearest: nearest.loc.slug,
      nearestKm: nearest.km,
      seeded: seededUids.has(hit.uid),
    };

    if (!res.ok) {
      candidates.push({ ...base, ageHours: null, aqi: null, pm25: null, attributions: [], network: null, status: 'dead', detail: res.message });
      continue;
    }

    // A generous staleness budget here (not STALE_FEED_HOURS): the question is
    // "is this station alive at all", not "can I use this hour right now".
    const parsed = parseWaqiFeed(res.data, { now, staleHours: 24 * 7 });
    const attributionObjects = isRecord(res.data) && isRecord(res.data.data) && Array.isArray(res.data.data.attributions)
      ? (res.data.data.attributions as { name?: string; url?: string }[])
      : [];

    if (!parsed.ok) {
      candidates.push({
        ...base,
        ageHours: parsed.ageHours ?? null,
        aqi: null,
        pm25: null,
        attributions: [],
        network: guessNetwork(attributionObjects),
        status: parsed.reason === 'no-pm25' ? 'no-pm25' : parsed.reason === 'stale' ? 'stale' : 'dead',
        detail: `${parsed.reason}: ${parsed.detail}`,
      });
      continue;
    }

    candidates.push({
      ...base,
      name: parsed.stationName ?? hit.name,
      ageHours: parsed.ageHours,
      aqi: parsed.aqi,
      pm25: parsed.pm25,
      attributions: parsed.attributions,
      network: guessNetwork(attributionObjects),
      status: parsed.ageHours > STALE_FEED_HOURS ? 'stale' : 'fresh',
      detail: '',
    });
  }

  candidates.sort((a, b) => a.nearestKm - b.nearestKm);

  /* -- report ------------------------------------------------------------- */
  console.log('='.repeat(112));
  console.log(
    'uid'.padEnd(10) +
      'station'.padEnd(32) +
      'nearest'.padEnd(17) +
      'km'.padStart(6) +
      'age'.padStart(8) +
      'AQI'.padStart(6) +
      'µg/m³'.padStart(8) +
      '  network  status',
  );
  console.log('='.repeat(112));
  for (const c of candidates) {
    console.log(
      c.uid.padEnd(10) +
        c.name.slice(0, 31).padEnd(32) +
        c.nearest.padEnd(17) +
        c.nearestKm.toFixed(1).padStart(6) +
        (c.ageHours === null ? '—' : `${c.ageHours.toFixed(1)}h`).padStart(8) +
        (c.aqi === null ? '—' : String(c.aqi)).padStart(6) +
        (c.pm25 === null ? '—' : c.pm25.toFixed(1)).padStart(8) +
        `  ${(c.network ?? '?').padEnd(8)} ${c.status}${c.seeded ? ' [SEEDED]' : ''}` +
        (c.detail ? `  ${c.detail}` : ''),
    );
  }

  console.log('\nAttributions (the licence obligation — /about must credit these):');
  const networks = new Map<string, Set<string>>();
  for (const c of candidates) {
    for (const a of c.attributions) {
      if (!networks.has(a)) networks.set(a, new Set());
      networks.get(a)!.add(c.nearest);
    }
  }
  for (const [name, slugs] of [...networks].sort()) {
    console.log(`  ${name} — ${[...slugs].sort().join(', ')}`);
  }

  /* -- coverage warnings --------------------------------------------------- */
  console.log('\nCoverage per Indonesian location (fresh stations within 25 km):');
  for (const loc of LOCATIONS.filter((l) => l.country === 'ID')) {
    const near = candidates.filter((c) => c.nearest === loc.slug && c.status === 'fresh' && c.nearestKm <= 25);
    const flag = near.length === 0 ? '  ✗ NO LIVE COVERAGE' : near.length === 1 ? '  ! single point of failure' : '';
    console.log(`  ${loc.slug.padEnd(17)} ${near.length} fresh${flag}`);
  }

  /* -- seed SQL ------------------------------------------------------------ */
  const proposals = candidates.filter(
    (c) => c.status === 'fresh' && c.nearestKm <= 25 && (includeSeeded || !c.seeded),
  );

  console.log(`\n${'='.repeat(112)}\nPASTE-READY SEED SQL${includeSeeded ? ' (--all: includes already-seeded stations)' : ''}\n${'='.repeat(112)}`);
  if (proposals.length === 0) {
    console.log('-- Nothing new within 25 km of a seeded location. Widen BOXES or relax the radius if a location has no coverage.');
  } else {
    console.log(`-- Generated by scripts/discover-stations.ts on ${now.toISOString().slice(0, 10)}.`);
    console.log('-- Review the `nearest` assignment before running: proximity is a hint, not a decision.');
    console.log("-- A null network means WAQI's attribution did not identify one; leave it null rather than guessing.");
    console.log('insert into public.stations (location_id, source, source_station_id, name, network, lat, lon, is_active)');
    console.log('select l.id, v.source, v.source_station_id, v.name, v.network, v.lat, v.lon, true');
    console.log('from (values');
    // The separating comma must precede the trailing comment, not follow it —
    // `…),  -- note` is valid SQL, `…)  -- note,` silently comments the comma
    // out and the paste fails at the next row.
    console.log(
      proposals
        .map((c, i) => {
          const tuple =
            `  ('${c.nearest}', 'waqi', '${sqlEscape(c.uid)}', '${sqlEscape(c.name)}', ` +
            `${c.network ? `'${c.network}'` : 'null'}, ${c.lat.toFixed(6)}, ${c.lon.toFixed(6)})`;
          const sep = i === proposals.length - 1 ? '' : ',';
          return `${tuple}${sep}  -- ${c.nearestKm.toFixed(1)} km away, ${c.ageHours?.toFixed(1)}h old`;
        })
        .join('\n'),
    );
    console.log(') as v (location_slug, source, source_station_id, name, network, lat, lon)');
    console.log('join public.locations l on l.slug = v.location_slug');
    console.log('on conflict (source, source_station_id) do update set');
    console.log('  location_id = excluded.location_id,');
    console.log('  name        = excluded.name,');
    console.log('  network     = excluded.network,');
    console.log('  lat         = excluded.lat,');
    console.log('  lon         = excluded.lon,');
    console.log('  is_active   = true;');
    console.log('\n-- Then mirror the same rows into WAQI_STATIONS in src/lib/stations.ts and 0004_seed.sql.');
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
