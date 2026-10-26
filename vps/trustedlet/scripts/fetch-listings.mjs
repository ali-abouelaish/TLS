// Snapshot the agency's live Harbor Ops listings into listings.json for the website,
// and the staff-only fields into private/staff-listings.json.
//
// Usage (Node 20.12+, no dependencies):
//   node scripts/fetch-listings.mjs
//
// Reads HARBOR_OPS_BASE_URL and HARBOR_OPS_API_KEY from the environment, falling
// back to .env and then .env.example in the site folder for local builds. Never
// upload those files with the site: the key can read every listing column,
// including the landlord commission flag.
//
// Only the fields the site shows are written. listings.json is public; the staff
// file is served by server.mjs only to staff signed in from Harbor Ops. A failed
// run exits non-zero and leaves the previous files untouched. Harbor Ops refreshes
// once a day, so running this more than daily gains nothing.

import { existsSync } from 'node:fs';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = fileURLToPath(new URL('../listings.json', import.meta.url));
const STAFF_OUT = fileURLToPath(new URL('../private/staff-listings.json', import.meta.url));
for (const name of ['../.env', '../.env.example']) {
  const file = fileURLToPath(new URL(name, import.meta.url));
  if ((!process.env.HARBOR_OPS_BASE_URL || !process.env.HARBOR_OPS_API_KEY) && existsSync(file)) {
    process.loadEnvFile(file); // variables already set in the environment win
  }
}
const PAGE_SIZE = 200; // API maximum
const MAX_AGE_DAYS = 7; // `status` is always "available", so liveness comes from this
const ATTEMPTS = 3;

const base = process.env.HARBOR_OPS_BASE_URL?.trim().replace(/\/+$/, '');
const key = process.env.HARBOR_OPS_API_KEY?.trim();

const sleep = ms => new Promise(r => setTimeout(r, ms));
const num = v => (v === null || v === undefined || v === '' || !Number.isFinite(+v) ? null : +v);
const httpUrl = v => (typeof v === 'string' && /^https?:\/\//i.test(v) ? v : null);
const text = v => (v == null || /^(none)?$/i.test(String(v).trim()) ? null : String(v).trim());
const yesNo = v => (/^yes/i.test(v || '') ? true : /^no/i.test(v || '') ? false : null);

// SpareRoom links carry a tail of empty search params; keep just the ad id.
function spareroomUrl(v) {
  const url = httpUrl(v);
  if (!url) return null;
  const u = new URL(url), id = u.searchParams.get('flatshare_id');
  return /(^|\.)spareroom\.co\.uk$/.test(u.hostname) && id
    ? 'https://www.spareroom.co.uk/flatshare/flatshare_detail.pl?flatshare_id=' + encodeURIComponent(id)
    : url;
}

// `photos` is a JSON array in a string; `all_photos` is the same list comma-separated.
function photoList(row) {
  let list = row.photos;
  if (typeof list === 'string') try { list = JSON.parse(list); } catch { list = null; }
  if (!Array.isArray(list) || !list.length) list = String(row.all_photos || '').split(',');
  return [...new Set(list.map(s => httpUrl(String(s).trim())).filter(Boolean))];
}

async function getPage(offset) {
  const url = new URL('/api/public/scraped-listings', base);
  url.search = new URLSearchParams({
    max_age_days: MAX_AGE_DAYS, sort: 'created_at.desc', limit: PAGE_SIZE, offset
  });
  for (let attempt = 1; ; attempt++) {
    let res;
    try {
      res = await fetch(url, { headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' } });
    } catch (err) {
      if (attempt >= ATTEMPTS) throw new Error(`Could not reach ${url.origin}: ${err.cause?.message || err.message}`);
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    if (res.ok) return res.json();
    const msg = `${res.status} ${(await res.json().catch(() => ({}))).error || res.statusText}`;
    if (res.status === 401) throw new Error(`${msg}: the API key is missing, wrong or revoked.`);
    if (res.status === 403) throw new Error(`${msg}: the API key lacks the scraped_listings:read scope.`);
    if (res.status < 500 || attempt >= ATTEMPTS) throw new Error(msg);
    await sleep(1000 * 2 ** attempt); // 500s are database errors; the API says they are safe to retry
  }
}

// Whitelist: anything not listed here is never published. Deliberately left out: paying, flag, landlord_*,
// url and external_ref (the SpareRoom ad and its number; staff only, see toStaff), tenant_id, raw_row,
// drive_*, and details of current housemates (gender, occupation, smoker, pets) and gender/age preferences.
function toPublic(row) {
  const coords = row.coordinates && typeof row.coordinates === 'object' ? row.coordinates : {};
  const price = num(row.price);
  return {
    id: String(row.id),
    title: row.title || 'Room to let',
    location: row.location || '',
    type: row.property_type || null,
    rooms: num(row.room_count),
    priceMin: num(row.min_room_price_pcm) ?? price,
    priceMax: num(row.max_room_price_pcm) ?? price,
    bills: /^yes/i.test(row.bills_included || ''),
    availableDate: row.available_date ? String(row.available_date).slice(0, 10) : null,
    photo: httpUrl(row.first_photo_url),
    lat: num(row.latitude ?? row.lat ?? coords.lat ?? coords.latitude),
    lng: num(row.longitude ?? row.lng ?? row.lon ?? coords.lng ?? coords.lon ?? coords.longitude),
    // Detail page (Listing.dc.html) and its enquiry form
    description: text(row.description),
    photos: photoList(row),
    billsIncluded: text(row.bills_included), // "Yes" | "No" | "Some"
    deposit: num(row.deposit),
    minTerm: text(row.min_term),
    maxTerm: text(row.max_term),
    furnishings: text(row.furnishings),
    broadband: text(row.broadband),
    totalRooms: num(row.total_rooms),
    housemates: num(row.housemates),
    parking: yesNo(row.parking),
    garden: yesNo(row.garden),
    couplesOk: yesNo(row.couples_ok),
    smokingOk: yesNo(row.smoking_ok),
    petsOk: yesNo(row.pets_ok),
    referencesRequired: yesNo(row.references),
    suitableFor: text(row.pref_occupation),
    roomList: [1, 2, 3, 4]
      .map(i => ({ type: text(row[`room${i}_type`]), price: num(row[`room${i}_price_pcm`]), deposit: num(row[`room${i}_deposit`]) }))
      .filter(r => r.type || r.price != null)
  };
}

// Shown only to agency staff signed in from Harbor Ops, keyed by listing id in the staff file.
function toStaff(row) {
  const landlordId = text(row.landlord_id);
  return {
    landlordName: text(row.landlord_name),
    landlordUrl: landlordId ? `${base}/go/landlord/${encodeURIComponent(landlordId)}` : null, // opens it in Harbor Ops
    paying: yesNo(row.paying), // the landlord pays commission
    spareroomUrl: spareroomUrl(row.url),
    ref: text(row.external_ref) // e.g. "spareroom:18460400"; public enquiries use the listing id instead
  };
}

async function writeJson(file, data) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file + '.tmp', JSON.stringify(data, null, 2) + '\n');
  await rename(file + '.tmp', file);
}

async function main() {
  if (!base || !key) throw new Error('Set HARBOR_OPS_BASE_URL and HARBOR_OPS_API_KEY in .env, .env.example or the environment.');

  const byId = new Map(), staffById = new Map(); // new rows arriving mid-run can shift pages; de-dupe by id
  for (let offset = 0; ; ) {
    const page = await getPage(offset);
    const rows = page.data || [];
    for (const row of rows) {
      byId.set(String(row.id), toPublic(row));
      staffById.set(String(row.id), toStaff(row));
    }
    offset += rows.length;
    if (!page.pagination?.has_more || rows.length === 0) break;
  }

  const listings = [...byId.values()], generated_at = new Date().toISOString();
  await writeJson(STAFF_OUT, { generated_at, listings: Object.fromEntries(staffById) });
  await writeJson(OUT, { generated_at, listings });
  console.log(`Wrote ${listings.length} listings to ${OUT} and their staff details to ${STAFF_OUT}`);
}

main().catch(err => {
  console.error(`fetch-listings: ${err.message}`);
  process.exitCode = 1;
});
