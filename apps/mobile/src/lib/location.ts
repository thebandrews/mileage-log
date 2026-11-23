import * as Location from 'expo-location';

export interface Point {
  latitude: number;
  longitude: number;
}

/**
 * Where the phone is now, or null if location is off, denied or slow.
 * Never throws: a missing location only means the trip has no address.
 */
export async function currentPoint(timeoutMs = 10_000): Promise<Point | null> {
  try {
    const permission = await Location.requestForegroundPermissionsAsync();
    if (!permission.granted) return null;
    const fix = await Promise.race([
      Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ]);
    if (!fix) {
      const last = await Location.getLastKnownPositionAsync({ maxAge: 5 * 60_000 });
      return last ? { latitude: last.coords.latitude, longitude: last.coords.longitude } : null;
    }
    return { latitude: fix.coords.latitude, longitude: fix.coords.longitude };
  } catch {
    return null;
  }
}
