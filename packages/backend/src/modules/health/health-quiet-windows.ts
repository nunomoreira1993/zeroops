import type { HealthQuietWindow, HealthSettings } from '../../../../contracts/src/index.js';

const minutesOf = (clock: string) => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3, 5));
const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Hora local no fuso (acompanha a mudança de hora): minutos desde a meia-noite e dia da semana. */
export function localClock(now: Date, timeZone: string): { minutes: number; weekday: number } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const part = (type: 'hour' | 'minute' | 'weekday') =>
    parts.find((item) => item.type === type)?.value ?? '';
  return {
    minutes: Number(part('hour')) * 60 + Number(part('minute')),
    weekday: WEEKDAYS[part('weekday')] ?? 0,
  };
}

/**
 * Indica se `now` cai na janela; o fim é exclusivo e `start` > `end` atravessa a meia-noite.
 * `days` são os dias em que a janela começa: depois da meia-noite conta o dia anterior.
 */
export function withinQuietWindow(window: HealthQuietWindow, now: Date): boolean {
  const { minutes, weekday } = localClock(now, window.timezone);
  const start = minutesOf(window.start);
  const end = minutesOf(window.end);
  const days = window.days ?? [0, 1, 2, 3, 4, 5, 6];
  if (start < end) return minutes >= start && minutes < end && days.includes(weekday);
  if (minutes >= start) return days.includes(weekday);
  return minutes < end && days.includes((weekday + 6) % 7);
}

/** Janela de silêncio ativa para o alvo (verificação, `rule:<Alerta>` ou `probe:<id>`). */
export function activeQuietWindow(
  settings: Pick<HealthSettings, 'quietWindows'>,
  target: string,
  now: Date,
): HealthQuietWindow | undefined {
  return settings.quietWindows.find(
    (window) => window.checks.includes(target) && withinQuietWindow(window, now),
  );
}
