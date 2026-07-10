// Pure day-by-day location resolution for resolveLocationBars (server.js) — extracted so
// the gap-fill rules are testable without the Sheets/Express machinery (node location-resolve.test.js).
//
// Recency decay (added 2026-07-10): the original "nearest evidence" gap fill ignored how
// stale that evidence was — a car rental that ended Jul 6–10 and a flight dated Jun 18
// were still claiming Jul 20–24. A signal may only carry gap days past its own end while
// "probably still there" is plausible: a few days for ordinary evidence, much longer when
// the place is a configured Location of Interest (family bases host multi-week stays —
// the use-case the LOI-preference pick below was built around). Staler evidence loses to
// the home default.
'use strict';

const dstr = d => d.toISOString().slice(0, 10);
const addDays = (dateStr, n) => dstr(new Date(Date.parse(dateStr + 'T12:00:00Z') + n * 86400000));

const GAPFILL_CARRY_DAYS = 3;      // non-LOI evidence may claim at most this many days past its endDate
const GAPFILL_CARRY_DAYS_LOI = 45; // LOI evidence carries long stays, but a spring trip can't claim mid-summer
const GAPFILL_AHEAD_MAX_DAYS = 5;  // ahead-only evidence pulls days toward it at most this far out

// Flights/trains are point events — a multi-day span on one means the extractor once
// encoded a whole round-trip itinerary as a single signal (a Jun 18 → Jul 26 "Paris"
// row directly claimed late July). The Signals sheet is append-only, so bad historical
// rows can't be removed; clamp them here instead. Overnight arrivals (1-day span) pass.
const POINT_TYPE_MAX_SPAN_DAYS = 1;
function clampSignalSpan(sig) {
  if (sig.type !== 'flight' && sig.type !== 'train') return sig;
  const span = Math.round((Date.parse(sig.endDate) - Date.parse(sig.date)) / 86400000);
  return span > POINT_TYPE_MAX_SPAN_DAYS ? { ...sig, endDate: addDays(sig.date, POINT_TYPE_MAX_SPAN_DAYS) } : sig;
}

// days: ascending YYYY-MM-DD strings to resolve; lookback: earliest date the behind
// search may reach; sigRows: [{type,date,endDate,location,weight,sourceUrl,note}];
// isLoi(place): whether a place matches a configured Location of Interest;
// pinnedOn(d): truthy when d is covered by a user-pinned bar (skipped here).
// Returns { [date]: { location, sourceUrl, note } } for every non-pinned day.
function resolveDayLocations({ days, lookback, sigRows, isLoi = () => false, homeLocation = '', pinnedOn = () => null }) {
  sigRows = sigRows.map(clampSignalSpan);
  const directOn = d => {
    const hits = sigRows.filter(s => d >= s.date && d <= s.endDate);
    if (!hits.length) return null;
    hits.sort((a, b) => b.weight - a.weight || (a.createdAt < b.createdAt ? 1 : -1));
    return hits[0];
  };
  const dayLoc = {};
  for (const d of days) {
    if (pinnedOn(d)) continue;
    const direct = directOn(d);
    if (direct) { dayLoc[d] = { location: direct.location, sourceUrl: direct.sourceUrl, note: direct.note }; continue; }
    // nearest evidence behind (back to lookback) and ahead (past the window, so a booking
    // just beyond the visible range can still pull the last visible days toward it)
    let behind = null, ahead = null;
    for (let b = d; b >= lookback; b = addDays(b, -1)) { const h = directOn(b); if (h) { behind = h; break; } }
    for (let a = d, i = 0; i < 90; a = addDays(a, 1), i++) { const h = directOn(a); if (h) { ahead = h; break; } }
    if (behind) {
      const daysPastEnd = Math.round((Date.parse(d) - Date.parse(behind.endDate)) / 86400000);
      if (daysPastEnd > (isLoi(behind.location) ? GAPFILL_CARRY_DAYS_LOI : GAPFILL_CARRY_DAYS)) behind = null;
    }
    let pick = null;
    if (behind && ahead) pick = isLoi(ahead.location) ? ahead : (isLoi(behind.location) ? behind : ahead);
    else if (behind) pick = behind;
    else if (ahead) pick = ahead; // gated by distance just below
    if (ahead && pick === ahead && !behind) {
      const gapDays = Math.round((Date.parse(ahead.date) - Date.parse(d)) / 86400000);
      if (gapDays > GAPFILL_AHEAD_MAX_DAYS) pick = null; // too far out to assume "already traveling there"
    }
    dayLoc[d] = pick ? { location: pick.location, sourceUrl: pick.sourceUrl, note: pick.note } : { location: homeLocation || 'Location?', sourceUrl: '', note: '' };
  }
  return dayLoc;
}

module.exports = { resolveDayLocations, clampSignalSpan, addDays, GAPFILL_CARRY_DAYS, GAPFILL_CARRY_DAYS_LOI, GAPFILL_AHEAD_MAX_DAYS };
