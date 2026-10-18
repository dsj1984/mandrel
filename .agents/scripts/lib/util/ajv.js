/**
 * The one Ajv factory for validators that need string formats. Mandrel's
 * schemas declare only `date-time` and `date`, so those two are registered by
 * hand — a port of ajv-formats' full-mode RFC 3339 checks — instead of
 * loading the whole ajv-formats plugin.
 */

import AjvDraft07 from 'ajv';
import AjvDraft2020 from 'ajv/dist/2020.js';

const DATE = /^(\d\d\d\d)-(\d\d)-(\d\d)$/;
const TIME = /^(\d\d):(\d\d):(\d\d(?:\.\d+)?)(z|([+-])(\d\d)(?::?(\d\d))?)?$/i;
const DATE_TIME_SEPARATOR = /t|\s/i;
const DAYS = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/**
 * @param {number} year
 * @returns {boolean}
 */
function isLeapYear(year) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

/**
 * RFC 3339 full-date on a real calendar day.
 *
 * @param {string} str
 * @returns {boolean}
 */
function isDate(str) {
  const m = DATE.exec(str);
  if (!m) return false;
  const year = +m[1];
  const month = +m[2];
  const day = +m[3];
  if (month < 1 || month > 12 || day < 1) return false;
  return day <= (month === 2 && isLeapYear(year) ? 29 : DAYS[month]);
}

/**
 * A `:60` second is valid only at 23:59 UTC once the offset is applied.
 *
 * @param {RegExpExecArray} m
 * @returns {boolean}
 */
function isLeapSecond(m) {
  const sign = m[5] === '-' ? -1 : 1;
  const utcMin = +m[2] - +(m[7] || 0) * sign;
  const utcHr = +m[1] - +(m[6] || 0) * sign - (utcMin < 0 ? 1 : 0);
  const atLastHour = utcHr === 23 || utcHr === -1;
  return atLastHour && (utcMin === 59 || utcMin === -1) && +m[3] < 61;
}

/**
 * RFC 3339 full-time with a required `Z` or `±hh:mm` offset.
 *
 * @param {string} str
 * @returns {boolean}
 */
function isTime(str) {
  const m = TIME.exec(str);
  if (!m || !m[4]) return false;
  if (+(m[6] || 0) > 23 || +(m[7] || 0) > 59) return false;
  if (+m[1] <= 23 && +m[2] <= 59 && +m[3] < 60) return true;
  return isLeapSecond(m);
}

/**
 * RFC 3339 date-time: full-date, a `T`/`t`/space separator, full-time.
 *
 * @param {string} str
 * @returns {boolean}
 */
function isDateTime(str) {
  const parts = str.split(DATE_TIME_SEPARATOR);
  return parts.length === 2 && isDate(parts[0]) && isTime(parts[1]);
}

/**
 * @template {import('ajv').default} T
 * @param {T} ajv
 * @returns {T}
 */
function withFormats(ajv) {
  ajv.addFormat('date-time', isDateTime);
  ajv.addFormat('date', isDate);
  return ajv;
}

const Draft07 = AjvDraft07.default ?? AjvDraft07;
const Draft2020 = AjvDraft2020.default ?? AjvDraft2020;

/**
 * Draft-07 Ajv with the `date-time` and `date` formats registered.
 *
 * @param {import('ajv').Options} [options]
 * @returns {import('ajv').default}
 */
export function createAjv(options = {}) {
  return withFormats(new Draft07(options));
}

/**
 * Draft 2020-12 Ajv with the `date-time` and `date` formats registered.
 *
 * @param {import('ajv').Options} [options]
 * @returns {import('ajv/dist/2020.js').default}
 */
export function createAjv2020(options = {}) {
  return withFormats(new Draft2020(options));
}
