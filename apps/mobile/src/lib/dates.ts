import { localDate, localTime } from '@mileage/shared';

export const deviceTimezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

const pad = (n: number) => String(n).padStart(2, '0');

/** First and last local date of the month containing `date` (YYYY-MM-DD). */
export function monthRange(date: string): { from: string; to: string } {
  const [y, m] = date.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${y}-${pad(m)}-01`, to: `${y}-${pad(m)}-${pad(last)}` };
}

export function shiftMonth(date: string, delta: number): string {
  const [y, m] = date.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-01`;
}

export function today(timezone = deviceTimezone()): string {
  return localDate(new Date().toISOString(), timezone);
}

export function nowTime(timezone = deviceTimezone()): string {
  return localTime(new Date().toISOString(), timezone);
}

/** "2026-11-03" + "08:15" in the device's zone → ISO instant, or null if invalid. */
export function toIso(date: string, time: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{1,2}:\d{2}$/.test(time)) return null;
  const [h, min] = time.split(':').map(Number);
  if (h > 23 || min > 59) return null;
  const d = new Date(`${date}T${pad(h)}:${pad(min)}:00`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function monthLabel(date: string): string {
  const [y, m] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 15)).toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

export function dayLabel(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

export const formatMiles = (n: number) =>
  n.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

export const formatMoney = (cents: number) =>
  (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
