import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { chromium, expect, type Browser } from '@playwright/test';
import { createApplication } from '../../apps/api/src/application.js';
import { IdentityService } from '../../packages/backend/src/modules/identity/identity.service.js';
import { availablePort, createTestCluster } from '../helpers/cluster.js';

const fixture = await createTestCluster();
let app: INestApplication | undefined;
let browser: Browser | undefined;
try {
  const identity = new IdentityService(fixture.db);
  const password = 'Synthetic-browser-fixture-123!';
  await identity.createInitialAdmin({
    email: 'operator@example.test',
    displayName: 'Operador de teste',
    password,
  });
  const admin = (await identity.login('operator@example.test', password)).user;
  const invitation = await identity.invite(admin, {
    email: 'client@example.test',
    displayName: 'Cliente de teste',
    role: 'client',
  });
  await identity.activate({ token: invitation.token, displayName: 'Cliente de teste', password });
  const port = await availablePort();
  const url = `http://127.0.0.1:${port}`;
  app = await createApplication(fixture.db, {
    publicUrl: url,
    staticDirectory: resolve('apps/web/dist'),
  });
  await app.listen(port, '127.0.0.1');
  assert.equal((await fetch(`${url}/api/health`)).status, 200);
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(url);
  await page.getByLabel('Email', { exact: true }).fill('client@example.test');
  await page.getByLabel('Palavra-passe', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Entrar no workspace' }).click();
  await page.getByRole('link', { name: 'Novo pedido', exact: true }).click();
  await page.getByLabel('Assunto', { exact: true }).fill('Pedido sintetico de validacao visual');
  await page.getByLabel('Tipo de pedido').selectOption('bug');
  await page.getByLabel('Ambiente', { exact: true }).selectOption('quality');
  await page.getByLabel('Prioridade', { exact: true }).selectOption('medium');
  await page
    .getByLabel('Descrição', { exact: true })
    .fill('Validar criacao e conversa sem dados reais de clientes.');
  await page.getByRole('button', { name: 'Criar pedido', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Pedido sintetico de validacao visual', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: /^Conversa/ }).click();
  await page.getByLabel('Adicionar mensagem').fill('Mensagem publica da fixture de browser.');
  await page.getByRole('button', { name: 'Enviar mensagem' }).click();
  await expect(
    page.getByText('Mensagem publica da fixture de browser.', { exact: true }),
  ).toBeVisible();
  assert.equal(await page.getByLabel('Visibilidade da mensagem').count(), 0);
  await mkdir(resolve('test-results'), { recursive: true });
  await page.screenshot({ path: resolve('test-results/zeroops-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole('heading', { name: 'Pedido sintetico de validacao visual', exact: true }),
  ).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  assert.equal(overflow, false, 'O portal tem overflow horizontal em mobile.');
  await page.screenshot({ path: resolve('test-results/zeroops-mobile.png'), fullPage: true });
  assert.deepEqual(errors, [], 'Erros JavaScript no browser.');
  console.info('Browser PASS: login, ticket, comentario publico, desktop e mobile sem overflow.');
} finally {
  if (browser) await browser.close();
  if (app) await app.close();
  await fixture.stop();
}
