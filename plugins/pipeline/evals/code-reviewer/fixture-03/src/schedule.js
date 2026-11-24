/** Parcels booked from this hour on are collected the next day. */
const LAST_HOUR = 17;

/**
 * The day a parcel booked now is collected.
 *
 * @param {{ now(): Date }} clock
 * @returns {string} the day, as YYYY-MM-DD (UTC)
 */
export function collectionDay(clock) {
  const day = clock.now();
  if (day.getUTCHours() >= LAST_HOUR) day.setUTCDate(day.getUTCDate() + 1);
  return day.toISOString().slice(0, 10);
}
