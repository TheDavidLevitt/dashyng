// Regression tests for the gap-fill recency decay in location-resolve.js.
// Run: node location-resolve.test.js  (exit 0 = pass). No framework — this repo has none.
'use strict';
const assert = require('assert');
const { resolveDayLocations, addDays } = require('./location-resolve');

const HOME = 'London';
const sig = (type, date, endDate, location, weight) => ({ type, date, endDate, location, weight, sourceUrl: 'u:' + location, note: '', createdAt: '2026-07-09T00:00:00Z' });
const daysBetween = (start, end) => { const out = []; for (let d = start; d <= end; d = addDays(d, 1)) out.push(d); return out; };
const resolve = (sigRows, opts = {}) => resolveDayLocations({
  days: daysBetween('2026-07-10', '2026-07-24'), lookback: '2026-05-11',
  sigRows, homeLocation: HOME, isLoi: () => false, ...opts,
});

// The 2026-07-10 bug: a Madrid car rental (Jul 6–10) and an old Paris flight (Jun 18)
// gap-filled Jul 20–24 as Madrid/Paris. With decay, stale evidence loses to home.
{
  const rows = [sig('flight', '2026-06-18', '2026-06-18', 'Paris', 100), sig('car', '2026-07-06', '2026-07-10', 'Madrid', 70)];
  const dayLoc = resolve(rows);
  for (const d of daysBetween('2026-07-20', '2026-07-24'))
    assert.strictEqual(dayLoc[d].location, HOME, `${d} must be home, got ${dayLoc[d].location}`);
  // fresh carry still works: a few days past the rental's end is plausibly "still there"
  assert.strictEqual(dayLoc['2026-07-11'].location, 'Madrid');
  assert.strictEqual(dayLoc['2026-07-13'].location, 'Madrid');
  assert.strictEqual(dayLoc['2026-07-14'].location, HOME, 'carry must stop after a few days');
}

// Same signals plus a London flight at gap+1 (lands Jul 25): the gap must still not
// become Madrid/Paris — it resolves to London (ahead pull or home default, same place).
{
  const rows = [
    sig('flight', '2026-06-18', '2026-06-18', 'Paris', 100),
    sig('car', '2026-07-06', '2026-07-10', 'Madrid', 70),
    sig('flight', '2026-07-25', '2026-07-25', 'London', 100),
  ];
  const dayLoc = resolve(rows);
  for (const d of daysBetween('2026-07-14', '2026-07-24')) {
    assert.notStrictEqual(dayLoc[d].location, 'Madrid', `${d} must not be Madrid`);
    assert.notStrictEqual(dayLoc[d].location, 'Paris', `${d} must not be Paris`);
  }
}

// LOI long-stay behavior preserved: a flight to Porto (a configured Location of Interest)
// with the return flight weeks out still carries the whole stay — the France use-case.
{
  const rows = [sig('flight', '2026-07-03', '2026-07-03', 'Porto', 100), sig('flight', '2026-08-02', '2026-08-02', 'London', 100)];
  const dayLoc = resolve(rows, { isLoi: p => p === 'Porto' });
  for (const d of daysBetween('2026-07-10', '2026-07-24'))
    assert.strictEqual(dayLoc[d].location, 'Porto', `${d} must stay Porto (LOI carry), got ${dayLoc[d].location}`);
}

// Direct coverage is untouched by decay: days inside a signal's own range keep it.
{
  const dayLoc = resolve([sig('hotel', '2026-07-12', '2026-07-16', 'London', 40)]);
  for (const d of daysBetween('2026-07-12', '2026-07-16'))
    assert.strictEqual(dayLoc[d].location, 'London');
}

// The other real 2026-07-10 junk bar was DIRECT, not gap fill: the extractor once encoded
// a round trip as ONE flight signal spanning the whole itinerary (Jun 18 → Jul 26 "Paris"),
// directly claiming Jul 20–24. Flight/train spans get clamped to a point event, so those
// days fall to the ahead London return leg / home instead. Overnight arrivals still work.
{
  const rows = [
    sig('flight', '2026-06-18', '2026-07-26', 'Paris', 100),  // poisoned append-only row
    sig('flight', '2026-06-18', '2026-06-18', 'Paris', 100),  // correct per-leg rows from the same email
    sig('flight', '2026-07-25', '2026-07-26', 'London', 100),   // overnight arrival: legit 1-day span
  ];
  const dayLoc = resolve(rows);
  for (const d of daysBetween('2026-07-10', '2026-07-24'))
    assert.strictEqual(dayLoc[d].location, HOME, `${d} must be home, got ${dayLoc[d].location}`);
}

// Pinned days are skipped entirely (rendered from the pinned bar, not recomputed).
{
  const dayLoc = resolve([], { pinnedOn: d => d === '2026-07-15' });
  assert.strictEqual(dayLoc['2026-07-15'], undefined);
  assert.strictEqual(dayLoc['2026-07-16'].location, HOME);
}

console.log('location-resolve tests: all passed');
