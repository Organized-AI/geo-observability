/** A person's calendar day in their own time zone, as a UTC millisecond range. */

export function validZone(tz: unknown): string | null {
  if (typeof tz !== "string" || !tz || tz.length > 64) return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return null;
  }
}

/** Minutes the zone is ahead of UTC at that instant (negative west of Greenwich). */
export function offsetMinutes(tz: string, ms: number): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
      .formatToParts(new Date(ms))
      .map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour) % 24, Number(parts.minute), Number(parts.second));
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60_000);
}

/** UTC instant of local midnight at the start of `day` (YYYY-MM-DD) in `tz`. Twice through for days that change clocks. */
function localMidnight(day: string, tz: string): number {
  const naive = Date.parse(`${day}T00:00:00Z`);
  let guess = naive - offsetMinutes(tz, naive) * 60_000;
  guess = naive - offsetMinutes(tz, guess) * 60_000;
  return guess;
}

export function localDayRange(day: string, tz = "UTC"): { from: number; to: number } {
  const next = new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  return { from: localMidnight(day, tz), to: localMidnight(next, tz) - 1 };
}

/** The local date (YYYY-MM-DD) and hour at an instant. */
export function localNow(tz: string, ms: number): { day: string; hour: number } {
  const local = new Date(ms + offsetMinutes(tz, ms) * 60_000);
  return { day: local.toISOString().slice(0, 10), hour: local.getUTCHours() };
}
