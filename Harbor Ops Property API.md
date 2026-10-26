# Harbor Ops Property API

Oct 21, 2026 · @Ali

## Overview

The Property API lets trusted partners read an agency's room listings from Harbor Ops, and lets the listings scraper fetch which landlord profiles to scrape. Every request is scoped to one agency (tenant), and partners only ever see that agency's data.

| Endpoint | Method | Who calls it | Auth |
| --- | --- | --- | --- |
| `/api/public/scraped-listings` | GET | Partner platforms, agency websites | Per-agency public API key |
| `/api/landlords/spareroom-profiles` | GET | The listings scraper (internal) | Platform `SCRAPER_API_KEY` |
| `/go/landlord/{landlord_id}` | GET | People, from a browser link | Harbor Ops login |

Listings come from two daily pipelines: the SpareRoom scraper and landlord listing spreadsheets. Both write to the same `scraped_listings` table, which the public endpoint reads.

## Authentication & base URL

Partners authenticate with a per-agency public API key. The agency is worked out from the key, so the host you call doesn't decide whose data you get.

**Base URL:** the agency's Harbor Ops address, for example `https://{slug}.harborops.co.uk`.

**Getting a key**

1. An agency admin opens **Settings → API Keys** and creates a key.
2. The full key (starts with `hopk_`) is shown once. Harbor Ops stores only a hash, so a lost key has to be replaced.
3. New keys get the `scraped_listings:read` scope by default.
4. Revoking a key on the same page takes effect on the next request.

**Sending the key** (either header works):

```http
Authorization: Bearer hopk_xxxxxxxxxxxx
x-api-key: hopk_xxxxxxxxxxxx
```

The scraper endpoint uses a separate platform secret, `SCRAPER_API_KEY`, sent as `Authorization: Bearer <key>`. It is not issued to agencies or partners.

## Endpoints

### GET /api/public/scraped-listings

Returns the agency's listings, newest first, 50 per page. Needs a key with the `scraped_listings:read` scope.

| Query param | Type | Default | What it does |
| --- | --- | --- | --- |
| `limit` | integer | 50 | Page size, clamped to 1–200 |
| `offset` | integer | 0 | Rows to skip, for paging |
| `sort` | `column.dir` | `created_at.desc` | Columns: `created_at`, `updated_at`, `last_seen_at`, `price`, `available_date`, `min_room_price_pcm`, `max_room_price_pcm`. Direction `asc` or `desc` |
| `max_age_days` | integer | none | Only listings confirmed live in the last N days; drops rows of unknown age |
| `source` | text | none | `spareroom` or `spreadsheet` |
| `landlord_id` | uuid | none | Exact match |
| `property_type` | text | none | Exact match |
| `paying` | text | none | `yes` or `no` (landlord pays commission) |
| `status` | text | none | Exact match. Not a liveness signal, see below |
| `min_price`, `max_price` | number | none | Range on `price` (£ per month) |
| `location` | text | none | Case-insensitive "contains" |
| `available_from` | `YYYY-MM-DD` | none | `available_date` on or after this date |

The response holds the rows, paging info and how many distinct landlords match:

```json
{
  "data": [ { "id": "…", "title": "…", "price": 750, "landlord_name": "Acme Lettings", "age_days": 1, "stale": false } ],
  "pagination": { "limit": 50, "offset": 0, "total": 123, "has_more": true },
  "landlord_count": 17
}
```

Each row is a full listing (title, location, coordinates, price, deposit, terms, up to four rooms with type, price and deposit, photos and so on) plus three added fields:

- `landlord_name`: the linked landlord's name, or `null`.
- `age_days`: whole days since the listing was last confirmed live, or `null` if never recorded.
- `stale`: `true` when `age_days` is over 7 or unknown.

**Freshness:** `status` is always `"available"`, even for listings that came down months ago. Use `stale` or `age_days`, or ask the server to filter with `max_age_days=7`. That filter is opt-in, so it won't change results for existing callers.

### GET /api/landlords/spareroom-profiles

Internal: tells the scraper which SpareRoom profiles to read for one agency. Takes a required `tenant_id` query param and the `SCRAPER_API_KEY`. Only landlords with a SpareRoom profile URL are returned, sorted by name, as parallel arrays (same index = same landlord):

```json
{
  "profiles": ["https://www.spareroom.co.uk/…"],
  "paying_flags": ["yes"],
  "profile_flags": [""],
  "names": ["Acme Lettings"],
  "ids": ["<landlord uuid>"]
}
```

The scraper stores `ids[i]` as `landlord_id` on each listing it writes. `profile_flags` is reserved and always empty.

### GET /go/landlord/{landlord\_id}

A stable browser link to a landlord's page in Harbor Ops, for emails and partner screens. No key is needed and the link is the same for every agency.

- **Signed in:** redirects to `https://{their-agency}.harborops.co.uk/landlords/{landlord_id}`.
- **Signed out:** goes to the login page, then on to the landlord after sign-in.
- A user only sees landlords in their own agency. A link to another agency's landlord opens an empty page.

## Errors & limits

Errors come back as JSON with a single message: `{ "error": "Unauthorized" }`.

| Status | Endpoint | Meaning |
| --- | --- | --- |
| 400 | spareroom-profiles | `tenant_id` is missing |
| 401 | Both API endpoints | Key missing, wrong or revoked |
| 403 | scraped-listings | Key lacks the `scraped_listings:read` scope |
| 500 | Both API endpoints | Database error; safe to retry |

- Pages hold at most 200 rows. Use `offset` and `has_more` to walk the rest.
- Bad filter values are ignored rather than rejected: a non-numeric price, a malformed date or an unknown sort column falls back to the default.
- `landlord_count` is worked out from at most 10,000 matching listings.
- No rate limit is enforced today. Both pipelines refresh once a day, so polling more than hourly gains nothing.
- `/go/landlord` never returns an error page: a malformed id redirects to the "not found" page.

## Example

Fetch live rooms in Manchester under £800 a month, cheapest first:

```bash
curl "https://acme.harborops.co.uk/api/public/scraped-listings?location=manchester&max_price=800&max_age_days=7&sort=price.asc&limit=2" \
  -H "Authorization: Bearer hopk_xxxxxxxxxxxx"
```

```json
{
  "data": [
    {
      "id": "7c1e…",
      "source": "spareroom",
      "title": "Double room near Piccadilly",
      "location": "Manchester M1",
      "price": 650,
      "available_date": "2026-11-01",
      "bills_included": "Yes",
      "room_count": 3,
      "first_photo_url": "https://…",
      "landlord_id": "b5b0…",
      "landlord_name": "Acme Lettings",
      "last_seen_at": "2026-10-21T02:40:00Z",
      "age_days": 0,
      "stale": false
    }
  ],
  "pagination": { "limit": 2, "offset": 0, "total": 14, "has_more": true },
  "landlord_count": 6
}
```

The row is trimmed for space; real rows carry every listing column. For the next page, repeat the call with `offset=2`.
