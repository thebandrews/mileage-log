/** A GPS fix from the phone. */
export interface Fix {
  latitude: number;
  longitude: number;
  /** Horizontal accuracy radius in metres, if the phone reported one. */
  accuracy: number | null;
  /** Milliseconds since the epoch. */
  timestamp: number;
}

/** Distance measured so far for one trip. Small enough to save after every batch of fixes. */
export interface TrackState {
  meters: number;
  /** The last fix that was counted; distance is measured from here. */
  last: Fix | null;
  /** Fixes counted / thrown away, for diagnostics. */
  accepted: number;
  rejected: number;
  /** Fixes thrown away in a row as jumps; enough of them means the last point was the bad one. */
  jumpStreak: number;
  /**
   * Times the phone went quiet for minutes and came back far away (app suspended, no signal).
   * The straight line across a gap undercounts, so the trip's miles deserve a check.
   */
  gaps: number;
}

export const emptyTrack = (): TrackState => ({
  meters: 0,
  last: null,
  accepted: 0,
  rejected: 0,
  jumpStreak: 0,
  gaps: 0,
});

/** Fixes less accurate than this are skipped (city canyons, indoor starts). */
export const MAX_ACCURACY_M = 65;
/** Faster than this between two fixes is a GPS jump, not driving (~155 mph). */
export const MAX_SPEED_MS = 70;
/** Movement smaller than this is treated as jitter while parked. */
export const MIN_STEP_M = 10;
/** After this many jumps in a row, trust the new position and restart from it. */
const JUMP_RESET = 3;
/** A silence longer than this that covers more than GAP_METERS counts as a gap. */
const GAP_SECONDS = 120;
const GAP_METERS = 1000;

export const METERS_PER_MILE = 1609.344;

export function haversineMeters(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }) {
  const R = 6_371_000;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.latitude - a.latitude);
  const dLng = rad(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Adds a batch of fixes to a trip's distance. Pure: returns a new state.
 * Skips inaccurate fixes, out-of-order fixes, parked jitter and GPS jumps.
 */
export function addFixes(state: TrackState, fixes: readonly Fix[]): TrackState {
  const s: TrackState = { ...state };
  const ordered = [...fixes].sort((a, b) => a.timestamp - b.timestamp);
  for (const f of ordered) {
    if (!Number.isFinite(f.latitude) || !Number.isFinite(f.longitude) || (f.accuracy !== null && f.accuracy > MAX_ACCURACY_M)) {
      s.rejected++;
      continue;
    }
    if (!s.last) {
      s.last = f;
      s.accepted++;
      continue;
    }
    if (f.timestamp <= s.last.timestamp) {
      s.rejected++;
      continue;
    }
    const d = haversineMeters(s.last, f);
    const dt = (f.timestamp - s.last.timestamp) / 1000;
    const step = Math.max(MIN_STEP_M, Math.min(s.last.accuracy ?? MIN_STEP_M, f.accuracy ?? MIN_STEP_M));
    if (d < step) {
      // Parked or crawling: keep measuring from the earlier point so slow movement still adds up.
      continue;
    }
    if (d / dt > MAX_SPEED_MS) {
      s.rejected++;
      s.jumpStreak++;
      if (s.jumpStreak >= JUMP_RESET) {
        // The point we were measuring from was the outlier: restart from here without adding distance.
        s.last = f;
        s.jumpStreak = 0;
      }
      continue;
    }
    if (dt > GAP_SECONDS && d > GAP_METERS) s.gaps++;
    s.meters += d;
    s.last = f;
    s.accepted++;
    s.jumpStreak = 0;
  }
  return s;
}

/** Miles for the log, one decimal place. */
export const trackMiles = (s: TrackState) => Math.round((s.meters / METERS_PER_MILE) * 10) / 10;
