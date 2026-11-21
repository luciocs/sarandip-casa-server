// SPDX-License-Identifier: AGPL-3.0-only
// Local clock for every turn. Computed at call time, never cached.
// Time zone comes from the TZ var (IANA, default UTC). Offset is read from ICU.
import { DEFAULT_TZ } from "./config";

export type ClockLang = "en" | "pt-BR";

export interface LocalClock {
  timezone: string;
  local_date: string;
  weekday: string;
  local_time: string;
  utc_offset: string;
  local_datetime: string;
  iso_local: string;
}

export function clockLang(language?: string): ClockLang {
  const l = (language || "en").toLowerCase();
  return l.startsWith("pt") ? "pt-BR" : "en";
}

export function resolveTz(tz?: string): string {
  const t = (tz || DEFAULT_TZ).trim() || DEFAULT_TZ;
  try {
    Intl.DateTimeFormat("en", { timeZone: t }).format(new Date());
    return t;
  } catch {
    return DEFAULT_TZ;
  }
}

function parts(d: Date, tz: string, locale: string, opts: Intl.DateTimeFormatOptions): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of new Intl.DateTimeFormat(locale, { timeZone: tz, ...opts }).formatToParts(d)) out[p.type] = p.value;
  return out;
}

export function localClock(now: Date = new Date(), tz: string = DEFAULT_TZ, language: string = "en"): LocalClock {
  const zone = resolveTz(tz);
  const lang = clockLang(language);
  const n = parts(now, zone, "en-GB", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  const w = parts(now, zone, lang, { weekday: "long", month: "long" });
  const asUtc = Date.UTC(+n.year, +n.month - 1, +n.day, +n.hour % 24, +n.minute, +n.second);
  const offMin = Math.round((asUtc - Math.floor(now.getTime() / 1000) * 1000) / 60000);
  const sign = offMin < 0 ? "-" : "+";
  const a = Math.abs(offMin);
  const utc_offset = `${sign}${String(Math.floor(a / 60)).padStart(2, "0")}:${String(a % 60).padStart(2, "0")}`;
  const hh = String(+n.hour % 24).padStart(2, "0");
  const local_time = `${hh}:${n.minute}`;
  const day = String(+n.day);
  const local_date = lang === "pt-BR" ? `${n.day}/${n.month}/${n.year}` : `${n.year}-${n.month}-${n.day}`;
  const local_datetime = lang === "pt-BR"
    ? `${w.weekday}, ${day} de ${w.month} de ${n.year}, ${local_time}`
    : `${w.weekday}, ${day} ${w.month} ${n.year}, ${local_time}`;
  return {
    timezone: zone,
    local_date,
    weekday: w.weekday,
    local_time,
    utc_offset,
    local_datetime,
    iso_local: `${n.year}-${n.month}-${n.day}T${hh}:${n.minute}:${n.second}${utc_offset}`,
  };
}

export function clockLine(c: LocalClock, language: string = "en"): string {
  if (clockLang(language) === "pt-BR") {
    return `Agora, no fuso ${c.timezone} (UTC${c.utc_offset}): ${c.local_datetime}. Use isto para responder data, dia da semana e hora; não invente outro horário.`;
  }
  return `Now, in time zone ${c.timezone} (UTC${c.utc_offset}): ${c.local_datetime}. Use this for the date, weekday and time; do not invent another time.`;
}
