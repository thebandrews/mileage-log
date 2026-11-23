import { describe, expect, it } from 'vitest';
import { addFixes, emptyTrack, haversineMeters, trackMiles, type Fix } from '../src/index.js';

// Heading north from a Seattle start: 0.001° latitude ≈ 111.2 m.
const START = { latitude: 47.6, longitude: -122.33 };
const T0 = Date.parse('2026-11-23T16:00:00Z');

/** n fixes `stepDeg` apart, `secs` apart, all with the given accuracy. */
function drive(n: number, stepDeg = 0.001, secs = 5, accuracy = 5, from = 0): Fix[] {
  return Array.from({ length: n }, (_, i) => ({
    latitude: START.latitude + (from + i) * stepDeg,
    longitude: START.longitude,
    accuracy,
    timestamp: T0 + (from + i) * secs * 1000,
  }));
}

describe('GPS track', () => {
  it('measures a straight drive', () => {
    const s = addFixes(emptyTrack(), drive(101)); // 100 steps of ~111 m
    expect(s.meters).toBeCloseTo(haversineMeters(START, { ...START, latitude: START.latitude + 0.1 }), 0);
    expect(trackMiles(s)).toBe(6.9);
    expect(s.gaps).toBe(0);
  });

  it('gives the same answer when fixes arrive in batches or out of order', () => {
    const fixes = drive(50);
    const once = addFixes(emptyTrack(), fixes);
    let batched = emptyTrack();
    for (let i = 0; i < fixes.length; i += 7) batched = addFixes(batched, fixes.slice(i, i + 7).reverse());
    expect(batched.meters).toBeCloseTo(once.meters, 6);
  });

  it('ignores jitter while parked but still counts a slow crawl', () => {
    const parked: Fix[] = Array.from({ length: 60 }, (_, i) => ({
      latitude: START.latitude + (i % 2 ? 0.00003 : -0.00003), // ±3 m wobble
      longitude: START.longitude,
      accuracy: 8,
      timestamp: T0 + i * 1000,
    }));
    expect(addFixes(emptyTrack(), parked).meters).toBe(0);

    // 4 m per fix for 100 fixes: each step is under the jitter threshold, the total isn't.
    const crawl = drive(101, 0.000036, 1, 5);
    expect(addFixes(emptyTrack(), crawl).meters).toBeGreaterThan(350);
  });

  it('skips inaccurate fixes and GPS jumps', () => {
    const fixes = drive(21);
    fixes.splice(10, 0, { ...fixes[10], accuracy: 300, latitude: fixes[10].latitude + 0.05 }); // poor fix far off
    fixes.splice(15, 0, { ...fixes[15], timestamp: fixes[15].timestamp - 1, latitude: fixes[15].latitude + 0.02 }); // 2 km jump in 4 s
    const s = addFixes(emptyTrack(), fixes);
    expect(s.meters).toBeCloseTo(addFixes(emptyTrack(), drive(21)).meters, 0);
    expect(s.rejected).toBe(2);
  });

  it('recovers when the first point was the bad one', () => {
    const bad: Fix = { latitude: START.latitude - 0.05, longitude: START.longitude, accuracy: 20, timestamp: T0 - 2000 };
    const s = addFixes(emptyTrack(), [bad, ...drive(31)]);
    // A few fixes are lost while it works out the first point was wrong; the rest of the drive counts.
    expect(s.meters).toBeGreaterThan(0.9 * addFixes(emptyTrack(), drive(31)).meters);
    expect(s.meters).toBeLessThan(addFixes(emptyTrack(), drive(31)).meters + 1);
  });

  it('flags a long silence that ends far away', () => {
    const before = drive(10);
    const after = drive(10, 0.001, 5, 5, 60).map((f) => ({ ...f, timestamp: f.timestamp + 10 * 60_000 }));
    const s = addFixes(emptyTrack(), [...before, ...after]);
    expect(s.gaps).toBe(1);
    // A long stop that ends where it started is not a gap.
    const lunch = drive(10).map((f, i) => (i < 5 ? f : { ...f, timestamp: f.timestamp + 45 * 60_000 }));
    expect(addFixes(emptyTrack(), lunch).gaps).toBe(0);
  });
});
