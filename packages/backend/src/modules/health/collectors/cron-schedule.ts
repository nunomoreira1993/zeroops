interface CronField {
  values: Set<number>;
  wildcard: boolean;
}

interface CronSchedule {
  minute: CronField;
  hour: CronField;
  dayOfMonth: CronField;
  month: CronField;
  dayOfWeek: CronField;
}

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
const MAX_SEARCH_DAYS = 400;

function formatter(timeZone: string) {
  let value = formatters.get(timeZone);
  if (!value) {
    value = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    formatters.set(timeZone, value);
  }
  return value;
}

function localParts(instant: Date, timeZone: string): LocalParts {
  const parts = formatter(timeZone).formatToParts(instant);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((item) => item.type === type)?.value);
  return {
    year: value('year'),
    month: value('month'),
    day: value('day'),
    hour: value('hour'),
    minute: value('minute'),
  };
}

function parseField(source: string, minimum: number, maximum: number): CronField {
  const values = new Set<number>();
  const wildcard = source === '*';
  for (const component of source.split(',')) {
    const [range, stepValue, extra] = component.split('/');
    if (!range || extra !== undefined) throw new Error('Campo cron inválido.');
    const step = stepValue === undefined ? 1 : Number(stepValue);
    if (!Number.isInteger(step) || step < 1 || step > maximum - minimum + 1)
      throw new Error('Passo cron inválido.');
    let start = minimum;
    let end = maximum;
    if (range !== '*') {
      const bounds = range.split('-');
      if (bounds.length > 2) throw new Error('Intervalo cron inválido.');
      start = Number(bounds[0]);
      end = bounds.length === 2 ? Number(bounds[1]) : start;
      if (
        !Number.isInteger(start) ||
        !Number.isInteger(end) ||
        start < minimum ||
        end > maximum ||
        start > end
      )
        throw new Error('Valor cron fora do intervalo.');
    }
    for (let item = start; item <= end; item += step)
      values.add(maximum === 7 && item === 7 ? 0 : item);
  }
  if (!values.size) throw new Error('Campo cron vazio.');
  return { values, wildcard };
}

function parseSchedule(expression: string): CronSchedule {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error('Use cinco campos cron numéricos.');
  return {
    minute: parseField(fields[0]!, 0, 59),
    hour: parseField(fields[1]!, 0, 23),
    dayOfMonth: parseField(fields[2]!, 1, 31),
    month: parseField(fields[3]!, 1, 12),
    dayOfWeek: parseField(fields[4]!, 0, 7),
  };
}

function matchesDate(schedule: CronSchedule, year: number, month: number, day: number) {
  if (!schedule.month.values.has(month)) return false;
  const dayOfMonthMatches = schedule.dayOfMonth.values.has(day);
  const dayOfWeek = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  const dayOfWeekMatches = schedule.dayOfWeek.values.has(dayOfWeek);
  if (schedule.dayOfMonth.wildcard) return dayOfWeekMatches;
  if (schedule.dayOfWeek.wildcard) return dayOfMonthMatches;
  return dayOfMonthMatches || dayOfWeekMatches;
}

function offsetAt(instantMs: number, timeZone: string) {
  const rounded = Math.floor(instantMs / 60000) * 60000;
  const parts = localParts(new Date(rounded), timeZone);
  return (Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute) - rounded) / 60000;
}

function instantsForLocalTime(parts: LocalParts, timeZone: string): number[] {
  const localAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
  const offsets = new Set([
    offsetAt(localAsUtc - 26 * 3600000, timeZone),
    offsetAt(localAsUtc, timeZone),
    offsetAt(localAsUtc + 26 * 3600000, timeZone),
  ]);
  return [...offsets]
    .map((offset) => localAsUtc - offset * 60000)
    .filter((instant) => {
      const actual = localParts(new Date(instant), timeZone);
      return (
        actual.year === parts.year &&
        actual.month === parts.month &&
        actual.day === parts.day &&
        actual.hour === parts.hour &&
        actual.minute === parts.minute
      );
    })
    .sort((a, b) => a - b);
}

/** Primeira ocorrencia real da agenda depois do instante, respeitando o fuso e transicoes DST. */
export function nextCronOccurrenceAfter(
  expression: string,
  timeZone: string,
  after: Date,
): Date | null {
  const schedule = parseSchedule(expression);
  const afterMs = after.getTime();
  if (!Number.isFinite(afterMs)) throw new Error('Instante cron inválido.');
  const start = localParts(after, timeZone);
  const firstDate = Date.UTC(start.year, start.month - 1, start.day);

  for (let dayOffset = 0; dayOffset <= MAX_SEARCH_DAYS; dayOffset++) {
    const date = new Date(firstDate + dayOffset * 86400000);
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth() + 1;
    const day = date.getUTCDate();
    if (!matchesDate(schedule, year, month, day)) continue;

    for (const hour of [...schedule.hour.values].sort((a, b) => a - b)) {
      for (const minute of [...schedule.minute.values].sort((a, b) => a - b)) {
        const parts = { year, month, day, hour, minute };
        for (const candidate of instantsForLocalTime(parts, timeZone)) {
          if (candidate > afterMs) return new Date(candidate);
        }
      }
    }
  }
  return null;
}
