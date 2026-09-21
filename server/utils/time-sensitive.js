/**
 * Detect element names that are time/date-sensitive and will change between
 * test planning and execution, causing locator mismatches.
 *
 * Catches:
 *  - Countdown timers: "5 days", "19 hrs", "Sale ends in 6 days : 1 hrs ..."
 *  - Clock times: "12:30:45"
 *  - Calendar dates: "14/08/2026", "08/14/26", "2026-08-14" (date-picker
 *    buttons whose label is the current date — these never match on a later run).
 */
function isTimeSensitiveName(name) {
  if (!name) return false;
  const lower = name.toLowerCase();
  return /\b\d+\s*(days?|hrs?|hours?|mins?|minutes?|secs?|seconds?)\b/.test(lower)
    || /sale ends in/.test(lower)
    || /\d{1,2}:\d{2}:\d{2}/.test(lower)
    // Calendar dates — DD/MM/YYYY, MM/DD/YYYY, DD-MM-YY, etc.
    || /\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/.test(lower)
    // ISO dates — YYYY-MM-DD, YYYY/MM/DD
    || /\b\d{4}[/-]\d{1,2}[/-]\d{1,2}\b/.test(lower);
}

module.exports = { isTimeSensitiveName };
