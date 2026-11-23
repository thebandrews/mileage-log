import { addFixes, emptyTrack, trackMiles, type Fix, type TrackState } from '@mileage/shared';
import { File, Paths } from 'expo-file-system';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import type { Point } from './location';

/**
 * Measures a trip's distance with the phone's GPS while the app is in the background.
 *
 * iOS wakes the app with batches of locations and runs the task below, even with the
 * screen locked; each batch is folded into a small file so nothing is lost if iOS ends
 * the app between batches. Only the running total leaves the phone, when the trip ends.
 */

const TASK = 'mileage-trip-track';
const file = new File(Paths.document, 'trip-track.json');

interface Saved {
  tripId: string;
  state: TrackState;
}

export interface Track {
  miles: number;
  /** The phone lost the trip for a stretch, so the miles may be short. */
  needsCheck: boolean;
  /** iOS is still delivering locations. */
  running: boolean;
}

export const gpsSupported = true;

function load(): Saved | null {
  try {
    return file.exists ? (JSON.parse(file.textSync()) as Saved) : null;
  } catch {
    return null;
  }
}

async function save(saved: Saved): Promise<void> {
  if (!file.exists) file.create({ intermediates: true });
  await file.write(JSON.stringify(saved));
}

// Batches can overlap; apply them one at a time so none overwrites another.
let queue: Promise<void> = Promise.resolve();
function update(fn: (s: Saved) => Saved | null): Promise<void> {
  queue = queue.then(async () => {
    const current = load();
    if (!current) return;
    const next = fn(current);
    if (next) await save(next);
  }, () => {});
  return queue;
}

const toFix = (l: Location.LocationObject): Fix => ({
  latitude: l.coords.latitude,
  longitude: l.coords.longitude,
  accuracy: l.coords.accuracy ?? null,
  timestamp: l.timestamp,
});

TaskManager.defineTask<{ locations: Location.LocationObject[] }>(TASK, async ({ data, error }) => {
  if (error || !data?.locations?.length) return;
  await update((s) => ({ ...s, state: addFixes(s.state, data.locations.map(toFix)) }));
});

/** Asks for location "Always" so the trip keeps measuring with the phone locked. Null when allowed. */
export async function gpsProblem(): Promise<string | null> {
  try {
    if (!(await Location.hasServicesEnabledAsync())) {
      return 'Location Services are off. Turn them on in Settings, or enter odometer readings.';
    }
    const fg = await Location.requestForegroundPermissionsAsync();
    if (!fg.granted) return 'Mileage Log can’t use your location. Allow it in Settings, or enter odometer readings.';
    const bg = await Location.requestBackgroundPermissionsAsync();
    if (!bg.granted) {
      return 'To measure miles with your phone locked, set Mileage Log’s location access to “Always” in Settings › Mileage Log › Location. Or enter odometer readings.';
    }
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

async function startUpdates(): Promise<void> {
  if (await Location.hasStartedLocationUpdatesAsync(TASK)) return;
  await Location.startLocationUpdatesAsync(TASK, {
    accuracy: Location.Accuracy.BestForNavigation,
    activityType: Location.ActivityType.AutomotiveNavigation,
    distanceInterval: 20,
    // Don't let iOS pause at a long red light and miss the rest of the drive.
    pausesUpdatesAutomatically: false,
    showsBackgroundLocationIndicator: true,
    foregroundService: {
      notificationTitle: 'Trip in progress',
      notificationBody: 'Mileage Log is measuring this trip.',
    },
  });
}

/** Starts measuring a trip that was just started, from where the phone is now. */
export async function beginTrack(tripId: string, start: Point | null): Promise<void> {
  queue = queue.then(async () => {
    const state = start
      ? addFixes(emptyTrack(), [{ ...start, accuracy: null, timestamp: Date.now() }])
      : emptyTrack();
    await save({ tripId, state });
  });
  await queue;
  await startUpdates();
}

/** The distance so far, or null if this phone isn't measuring that trip. */
export async function readTrack(tripId: string): Promise<Track | null> {
  await queue;
  const saved = load();
  if (!saved || saved.tripId !== tripId) return null;
  const running = await Location.hasStartedLocationUpdatesAsync(TASK).catch(() => false);
  return { miles: trackMiles(saved.state), needsCheck: saved.state.gaps > 0, running };
}

/** Picks a trip back up after iOS or a restart stopped the updates. */
export async function resumeTrack(tripId: string): Promise<boolean> {
  const t = await readTrack(tripId);
  if (!t) return false;
  if (!t.running) await startUpdates();
  return true;
}

/** Adds the end point and returns the final distance. */
export async function finishTrack(tripId: string, end: Point | null): Promise<Track | null> {
  if (end) {
    await update((s) =>
      s.tripId === tripId ? { ...s, state: addFixes(s.state, [{ ...end, accuracy: null, timestamp: Date.now() }]) } : null,
    );
  }
  return readTrack(tripId);
}

/** Stops measuring and forgets the trip. */
export async function stopTrack(): Promise<void> {
  try {
    if (await Location.hasStartedLocationUpdatesAsync(TASK)) await Location.stopLocationUpdatesAsync(TASK);
  } catch {
    // Already stopped.
  }
  queue = queue.then(() => {
    if (file.exists) file.delete();
  });
  await queue;
}
