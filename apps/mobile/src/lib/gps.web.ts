import type { Point } from './location';

/**
 * A browser stops reporting location once the page is in the background or the screen locks,
 * so the web app doesn't measure trips: it uses odometer readings (or the car) instead.
 */

export interface Track {
  miles: number;
  needsCheck: boolean;
  running: boolean;
}

export const gpsSupported = false;

export async function gpsProblem(): Promise<string | null> {
  return 'The web app can’t measure trips with GPS. Enter odometer readings, or use the iPhone app.';
}
export async function beginTrack(_tripId: string, _start: Point | null): Promise<void> {}
export async function readTrack(_tripId: string): Promise<Track | null> {
  return null;
}
export async function resumeTrack(_tripId: string): Promise<boolean> {
  return false;
}
export async function finishTrack(_tripId: string, _end: Point | null): Promise<Track | null> {
  return null;
}
export async function stopTrack(): Promise<void> {}
