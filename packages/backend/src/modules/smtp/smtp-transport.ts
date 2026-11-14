import nodemailer from 'nodemailer';

export interface SmtpConfig {
  host: string;
  port: number;
  from: string;
  secure?: boolean;
  requireTLS?: boolean;
  allowInsecureLoopback?: boolean;
  auth?: { user: string; pass: string };
  timeoutMs?: number;
}

/** Cria transporte SMTP com timeouts e acesso a ficheiros/URLs desativado. */
export function createMailTransport(smtp: SmtpConfig) {
  return nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure ?? false,
    requireTLS: smtp.requireTLS ?? true,
    ignoreTLS: Boolean(smtp.allowInsecureLoopback && !smtp.secure && smtp.requireTLS === false),
    auth: smtp.auth,
    connectionTimeout: Math.min(smtp.timeoutMs ?? 10000, 20000),
    greetingTimeout: Math.min(smtp.timeoutMs ?? 10000, 20000),
    socketTimeout: Math.min(smtp.timeoutMs ?? 10000, 20000),
    disableFileAccess: true,
    disableUrlAccess: true,
    logger: false,
    debug: false,
  });
}
