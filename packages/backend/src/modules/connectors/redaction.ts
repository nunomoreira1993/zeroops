const SENSITIVE_COLUMN =
  /pass(word)?|pwd|secret|token|api_?key|cvv|cvc|card_?number|cardnum|iban|salt/i;
const CARD_NUMBER = /\b\d(?:[ -]?\d){12,18}\b/g;

function luhn(digits: string) {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let digit = Number(digits[digits.length - 1 - i]);
    if (i % 2) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
}

/** Mascara números de cartão válidos (Luhn) mantendo os últimos 4 dígitos para correlação. */
export function redactText(text: string) {
  return text.replace(CARD_NUMBER, (match) => {
    const digits = match.replace(/\D/g, '');
    return digits.length >= 13 && luhn(digits) ? `****${digits.slice(-4)}` : match;
  });
}

/** Redige colunas sensíveis e limita valores textuais antes de os expor como evidência. */
export function redactValue(column: string, value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (SENSITIVE_COLUMN.test(column)) return '[redigido]';
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return `[binário ${value.length} bytes]`;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string')
    return redactText(value.length > 2000 ? `${value.slice(0, 2000)}…` : value);
  if (typeof value === 'object') return redactText(JSON.stringify(value)).slice(0, 2000);
  return value;
}
