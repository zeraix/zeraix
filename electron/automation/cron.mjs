/**
 * Cron expressions: parsing, and "which fires were due in this window".
 *
 * The scheduler (§12.2) never asks "is it time yet" -- it asks which fires fell between
 * `lastFiredAt` and now, because the app is closed for most of the calendar and a 5-second gap and a
 * 5-day gap have to take the same code path. That makes `fireTimesBetween` the only function here
 * that matters; everything else exists to serve it.
 *
 * Standard 5-field syntax: `minute hour day-of-month month day-of-week`. Seconds are deliberately
 * unsupported -- the scheduler ticks per minute, and a field the engine cannot honour is worse than
 * one it never offered.
 *
 * No `electron` import, no clock of its own: every entry point takes its bounds as arguments, so the
 * whole file is exercisable under `npm test` (§9.1).
 */

/** Field bounds, in expression order. */
const FIELDS = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "dayOfMonth", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "dayOfWeek", min: 0, max: 6 },
];

/** Three-letter aliases, so `0 9 * * MON` parses. Case-insensitive. */
const NAMES = {
  month: { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 },
  dayOfWeek: { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 },
};

/** Convenience expressions users are likely to have seen elsewhere. */
const ALIASES = {
  "@hourly": "0 * * * *",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@weekly": "0 0 * * 0",
  "@monthly": "0 0 1 * *",
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
};

/**
 * A parsed expression: one set of permitted values per field, plus whether dom/dow were restricted.
 *
 * That last pair is not bookkeeping -- it decides how days match. See `dayMatches`.
 */
export class CronExpression {
  constructor(sets, domRestricted, dowRestricted) {
    this.sets = sets;
    this.domRestricted = domRestricted;
    this.dowRestricted = dowRestricted;
  }
}

/** Expand one field into the set of values it permits. Throws with the field named, not just "invalid". */
function parseField(raw, field) {
  const { name, min, max } = field;
  const out = new Set();

  for (const part of String(raw).split(",")) {
    const piece = part.trim();
    if (!piece) throw new Error(`${name}: empty value in "${raw}"`);

    // `*/n` and `a-b/n` share a step suffix; `a/n` is accepted as "from a to the max, every n".
    const [spec, stepRaw] = piece.split("/");
    let step = 1;
    if (stepRaw !== undefined) {
      step = Number(stepRaw);
      if (!Number.isInteger(step) || step < 1) throw new Error(`${name}: step must be a positive integer, got "${stepRaw}"`);
    }

    let lo;
    let hi;
    if (spec === "*") {
      lo = min;
      hi = max;
    } else if (spec.includes("-")) {
      const [a, b] = spec.split("-");
      lo = toNumber(a, name);
      hi = toNumber(b, name);
    } else {
      lo = toNumber(spec, name);
      // A bare number with a step means "from here onwards"; without one it is a single value.
      hi = stepRaw === undefined ? lo : max;
    }

    // 7 is a second spelling of Sunday in every cron implementation worth matching.
    if (name === "dayOfWeek") {
      if (lo === 7) lo = 0;
      if (hi === 7) hi = 0;
    }

    if (lo < min || hi > max || lo > hi) {
      throw new Error(`${name}: "${piece}" is outside ${min}-${max}`);
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }

  if (out.size === 0) throw new Error(`${name}: "${raw}" permits no values`);
  return out;

  function toNumber(token, fieldName) {
    const text = String(token).trim().toLowerCase();
    const named = NAMES[fieldName]?.[text];
    if (named !== undefined) return named;
    const n = Number(text);
    if (!Number.isInteger(n)) throw new Error(`${fieldName}: "${token}" is not a number`);
    return n;
  }
}

/** Parse a 5-field expression. Throws on anything malformed -- callers surface the message verbatim. */
export function parseCron(expression) {
  const text = String(expression ?? "").trim().toLowerCase();
  if (!text) throw new Error("cron expression is empty");

  const normalized = ALIASES[text] ?? text;
  const parts = normalized.split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`cron expression must have 5 fields (minute hour day-of-month month day-of-week), got ${parts.length}`);
  }

  const sets = {};
  FIELDS.forEach((field, i) => {
    sets[field.name] = parseField(parts[i], field);
  });

  return new CronExpression(sets, parts[2].trim() !== "*", parts[4].trim() !== "*");
}

/** Whether an expression is parseable. For validation paths that want a boolean, not an exception. */
export function isValidCron(expression) {
  try {
    parseCron(expression);
    return true;
  } catch {
    return false;
  }
}

/**
 * Does this calendar day match?
 *
 * When BOTH day-of-month and day-of-week are restricted, cron matches a day if *either* does -- so
 * `0 0 1 * MON` is "the 1st, and every Monday", not "Mondays that fall on the 1st". This is the one
 * genuinely surprising rule in cron, it is what every other implementation does, and a schedule that
 * quietly disagrees with the user's other tools is worse than one that is merely strict.
 */
function dayMatches(expr, date) {
  // The month gates everything: without this, `@yearly` fires on the 1st of every month.
  if (!expr.sets.month.has(date.getMonth() + 1)) return false;
  const dom = expr.sets.dayOfMonth.has(date.getDate());
  const dow = expr.sets.dayOfWeek.has(date.getDay());
  if (expr.domRestricted && expr.dowRestricted) return dom || dow;
  return dom && dow;
}

/** Hours and minutes ascending, so a day's fire times come out in order. */
const ascending = (set) => [...set].sort((a, b) => a - b);

/**
 * Every fire time in the half-open interval `(after, until]`, in ascending order.
 *
 * Half-open at the lower bound on purpose: `after` is the last fire already accounted for, and
 * including it would run that one a second time on the next tick.
 *
 * Iterates by *day* and then over the permitted hours/minutes, rather than minute-by-minute across
 * the window. A workflow that fires once a month, after the laptop was shut for six weeks, would
 * otherwise cost ~60k pointless checks to find two fires.
 *
 * @param {string|CronExpression} expression
 * @param {number} after  Exclusive lower bound (ms). The scheduler passes `lastFiredAt`.
 * @param {number} until  Inclusive upper bound (ms), normally now.
 * @param {{limit?: number}} [opts] Stop once `limit` fires are found; `truncated` then reports that
 *   more were due. The scheduler uses this to cap backfill without scanning the whole window.
 * @returns {{times: number[], truncated: boolean}}
 */
export function fireTimesBetween(expression, after, until, { limit = Infinity } = {}) {
  const expr = expression instanceof CronExpression ? expression : parseCron(expression);
  const times = [];
  if (!(until > after)) return { times, truncated: false };

  const hours = ascending(expr.sets.hour);
  const minutes = ascending(expr.sets.minute);

  // Start at local midnight of the day `after` falls in: fires later that same day still count.
  const cursor = new Date(after);
  cursor.setHours(0, 0, 0, 0);

  // A generous ceiling on how far we will walk. Reached only by an expression that never matches
  // (e.g. Feb 30) -- without it that becomes an unbounded loop rather than an empty result.
  const MAX_DAYS = 366 * 5;

  for (let day = 0; day <= MAX_DAYS; day += 1) {
    if (cursor.getTime() > until) break;

    if (dayMatches(expr, cursor)) {
      for (const h of hours) {
        for (const m of minutes) {
          // Rebuilt per candidate rather than added as milliseconds: DST shifts mean a "day" is not
          // always 24h, and "09:00 local" must stay 09:00 across the change.
          const at = new Date(
            cursor.getFullYear(),
            cursor.getMonth(),
            cursor.getDate(),
            h,
            m,
            0,
            0,
          ).getTime();
          if (at > after && at <= until) {
            times.push(at);
            // One past the limit is enough to know the caller's cap was exceeded.
            if (times.length > limit) return { times: times.slice(0, limit), truncated: true };
          }
        }
      }
    }

    cursor.setDate(cursor.getDate() + 1);
    // setDate can land mid-day across a DST boundary; renormalise so the walk stays on midnights.
    cursor.setHours(0, 0, 0, 0);
  }

  return { times, truncated: false };
}

/**
 * The next fire strictly after `from`, or null if the expression matches nothing within the horizon.
 *
 * The dashboard's "next run" column reads this. It is a thin wrapper over the same walk rather than a
 * second implementation, so the time a user is shown cannot disagree with the time that actually fires.
 */
export function nextFireAfter(expression, from) {
  const expr = expression instanceof CronExpression ? expression : parseCron(expression);
  // Two years is past any schedule worth showing a countdown for, and bounds the walk for an
  // expression that never matches.
  const horizon = from + 366 * 2 * 24 * 60 * 60 * 1000;
  const { times } = fireTimesBetween(expr, from, horizon, { limit: 1 });
  return times[0] ?? null;
}

/**
 * A human reading of an expression, for UI that must not show raw cron.
 *
 * Covers only the shapes the Simple-mode picker can produce; anything hand-written in the JSON tab
 * returns null and the caller falls back to showing the expression itself. Guessing at arbitrary
 * cron in prose would eventually describe a schedule wrongly, which is worse than showing syntax.
 */
export function describeCron(expression) {
  let expr;
  try {
    expr = parseCron(expression);
  } catch {
    return null;
  }

  const { minute, hour, dayOfMonth, month, dayOfWeek } = expr.sets;
  const one = (set) => (set.size === 1 ? [...set][0] : null);
  const full = (set, size) => set.size === size;

  const m = one(minute);
  const h = one(hour);
  const hhmm = m !== null && h !== null ? `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}` : null;
  const everyDay = full(dayOfMonth, 31) && full(month, 12) && full(dayOfWeek, 7);

  // Every day at a fixed time.
  if (hhmm && everyDay) return { kind: "daily", time: hhmm };

  // A fixed time on chosen weekdays.
  if (hhmm && full(dayOfMonth, 31) && full(month, 12) && dayOfWeek.size < 7) {
    return { kind: "weekly", time: hhmm, days: [...dayOfWeek].sort((a, b) => a - b) };
  }

  // Every N minutes / every hour on the hour.
  if (h === null && full(hour, 24) && everyDay) {
    if (m !== null) return { kind: "hourly", minute: m };
    const sorted = [...minute].sort((a, b) => a - b);
    const step = sorted.length > 1 ? sorted[1] - sorted[0] : null;
    const even = step !== null && sorted.every((v, i) => i === 0 || v - sorted[i - 1] === step) && 60 % step === 0;
    if (even && sorted[0] === 0) return { kind: "everyMinutes", minutes: step };
  }

  return null;
}
