// Pure scheduling and laundry rules. Dates are local calendar days as 'YYYY-MM-DD' strings,
// which avoids time-zone surprises and compares correctly as plain strings.
(function (root) {
  const pad = (n) => String(n).padStart(2, '0');

  function toDay(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function parseDay(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); }
  function today(now) { return toDay(now || new Date()); }

  function addDays(s, n) { const d = parseDay(s); d.setDate(d.getDate() + n); return toDay(d); }

  // Jan 31 + 1 month = Feb 28 (clamped), like iOS Calendar.
  function addMonths(s, n) {
    const [y, m, d] = s.split('-').map(Number);
    const t = new Date(y, m - 1 + n, 1);
    const last = new Date(t.getFullYear(), t.getMonth() + 1, 0).getDate();
    t.setDate(Math.min(d, last));
    return toDay(t);
  }

  function advance(s, rule) {
    const n = Math.max(1, Math.floor(rule.every) || 1);
    if (rule.unit === 'days') return addDays(s, n);
    if (rule.unit === 'months') return addMonths(s, n);
    return addDays(s, 7 * n);
  }

  // Whole days from a to b (positive when b is later). Rounding absorbs daylight-saving hours.
  function daysBetween(a, b) { return Math.round((parseDay(b) - parseDay(a)) / 86400000); }

  function rollPast(start, day, rule) {
    let next = start;
    for (let i = 0; next <= day && i < 1000; i++) next = advance(next, rule);
    return next;
  }

  // Next due date after the task is done (on time, early or late).
  // fromCompletion: count from the day it was done.
  // fixed dates: stay on the original rhythm; doing it early uses up this cycle,
  // doing it very late never leaves a backlog of missed cycles.
  function nextAfterDone(due, doneDay, rule) {
    if (rule.fromCompletion) return advance(doneDay, rule);
    return rollPast(advance(due, rule), doneDay, rule);
  }

  // "Not needed yet": skip this round, come back next cycle.
  function nextAfterSkip(due, todayDay, rule) {
    return rollPast(advance(due, rule), todayDay, rule);
  }

  function summary(rule) {
    const n = Math.max(1, Math.floor(rule.every) || 1);
    const unit = rule.unit || 'weeks';
    return n === 1 ? 'Every ' + unit.slice(0, -1) : 'Every ' + n + ' ' + unit;
  }

  const BASKET = ['Empty', 'Half', 'Nearly', 'Full'];
  // 0,1 -> skip   2 -> either   3 -> do now
  function basketAdvice(level) { return level <= 1 ? 'skip' : level === 2 ? 'either' : 'now'; }

  // Next person in a rotation, by member list order.
  function nextInRotation(memberIds, currentId) {
    if (!memberIds.length) return null;
    const i = memberIds.indexOf(currentId);
    return memberIds[(i + 1) % memberIds.length];
  }

  const api = { toDay, parseDay, today, addDays, addMonths, advance, daysBetween,
    nextAfterDone, nextAfterSkip, summary, BASKET, basketAdvice, nextInRotation };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.HBLogic = api;
})(typeof window !== 'undefined' ? window : globalThis);
