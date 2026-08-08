import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { createDatabase, ensureDatabaseSchema } from '@atmb/db';

import { createServer } from '../src/server.ts';

const testEnv = {
  NODE_ENV: 'test',
  ADMIN_USERNAME: 'admin',
  ADMIN_PASSWORD: 'secret123',
  ADMIN_DISPLAY_NAME: '测试管理员',
  SESSION_SECRET: 'test-session-secret-at-least-32-characters',
  WEB_ORIGIN: 'http://localhost:3000',
};

async function buildTestServer(options: {
  databaseUrl?: string;
  smartyClient?: {
    testConnection: (credentials: { authId: string; authToken: string }) => Promise<{ ok: boolean; message?: string }>;
  };
  proxyTester?: {
    testProxy: (proxy: { id: number; url: string; note: string | null; isActive: boolean }) => Promise<{ ok: boolean; message?: string; sampleAddress?: string }>;
  };
} = {}) {
  const app = await createServer({
    databaseUrl: options.databaseUrl ?? ':memory:',
    env: testEnv,
    logger: false,
    smartyClient: options.smartyClient,
    proxyTester: options.proxyTester,
  });

  await app.ready();
  return app;
}

async function loginCookie(app: Awaited<ReturnType<typeof createServer>>) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/admin/auth/login',
    payload: {
      username: 'admin',
      password: 'secret123',
    },
  });

  const setCookie = response.headers['set-cookie'];
  const header = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  assert.ok(header, 'expected login to set session cookie');
  return header.split(';')[0] ?? '';
}

test('protects system settings endpoints', async (t) => {
  const app = await buildTestServer();
  t.after(() => app.close());

  const response = await app.inject({
    method: 'GET',
    url: '/api/admin/settings',
  });

  assert.equal(response.statusCode, 401);
});

test('returns default system settings safely', async (t) => {
  const app = await buildTestServer();
  t.after(() => app.close());
  const cookie = await loginCookie(app);

  const response = await app.inject({
    method: 'GET',
    url: '/api/admin/settings',
    headers: { cookie },
  });

  assert.equal(response.statusCode, 200);
  const { settings } = response.json();
  assert.deepEqual(settings.smartyCredentials, []);
  assert.equal(settings.smartyConnectionStatus, 'not_configured');
  assert.equal(settings.autoUpdateEnabled, true);
  assert.equal(settings.updateFrequencyDays, 1);
  assert.equal(settings.updateHour, 8);
  assert.equal(settings.updateMinute, 30);
  assert.equal(settings.headCode, '');
  assert.equal('smartyAuthToken' in settings, false);
});

test('saves a Smarty credential pool without returning or storing plaintext tokens', async (t) => {
  const databaseUrl = join(process.cwd(), '.runtime', 'test-system-settings.sqlite');
  rmSync(databaseUrl, { force: true });
  const app = await buildTestServer({ databaseUrl });
  let sqlite: Database.Database | null = null;
  t.after(async () => {
    sqlite?.close();
    await app.close();
    rmSync(databaseUrl, { force: true });
  });
  const cookie = await loginCookie(app);

  const response = await app.inject({
    method: 'PATCH',
    url: '/api/admin/settings/smarty',
    headers: { cookie },
    payload: {
      credentials: [
        { authId: 'smarty-auth-id-1', authToken: 'smarty-secret-token-1', isActive: true },
        { authId: 'smarty-auth-id-2', authToken: 'smarty-secret-token-2', isActive: false },
      ],
    },
  });

  assert.equal(response.statusCode, 200);
  const { settings } = response.json();
  assert.equal(settings.smartyCredentials.length, 2);
  assert.deepEqual(
    settings.smartyCredentials.map((credential: { authId: string; hasAuthToken: boolean; isActive: boolean }) => ({
      authId: credential.authId,
      hasAuthToken: credential.hasAuthToken,
      isActive: credential.isActive,
    })),
    [
      { authId: 'smarty-auth-id-1', hasAuthToken: true, isActive: true },
      { authId: 'smarty-auth-id-2', hasAuthToken: true, isActive: false },
    ],
  );
  assert.equal(JSON.stringify(settings).includes('smarty-secret-token'), false);

  sqlite = new Database(databaseUrl);
  const rows = sqlite
    .prepare('SELECT auth_token_encrypted AS token FROM smarty_credentials ORDER BY id')
    .all() as Array<{ token: string }>;
  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => row.token !== 'smarty-secret-token-1' && row.token !== 'smarty-secret-token-2'));
  assert.ok(rows.every((row) => /^v1:/.test(row.token)));
});

test('updates, disables, renames, and removes Smarty credentials while retaining blank tokens', async (t) => {
  const databaseUrl = join(process.cwd(), '.runtime', 'test-smarty-pool-updates.sqlite');
  rmSync(databaseUrl, { force: true });
  const app = await buildTestServer({ databaseUrl });
  t.after(async () => {
    await app.close();
    rmSync(databaseUrl, { force: true });
  });
  const cookie = await loginCookie(app);
  const created = await app.inject({
    method: 'PATCH',
    url: '/api/admin/settings/smarty',
    headers: { cookie },
    payload: {
      credentials: [
        { authId: 'account-a', authToken: 'token-a', isActive: true },
        { authId: 'account-b', authToken: 'token-b', isActive: true },
      ],
    },
  });
  const [accountA] = created.json().settings.smartyCredentials as Array<{ id: number }>;
  assert.ok(accountA);

  const sqlite = new Database(databaseUrl);
  const encryptedBefore = (sqlite
    .prepare('SELECT auth_token_encrypted AS token FROM smarty_credentials WHERE id = ?')
    .get(accountA.id) as { token: string }).token;

  const updated = await app.inject({
    method: 'PATCH',
    url: '/api/admin/settings/smarty',
    headers: { cookie },
    payload: {
      credentials: [
        { id: accountA.id, authId: 'account-a-renamed', isActive: false },
      ],
    },
  });

  assert.equal(updated.statusCode, 200);
  assert.equal(updated.json().settings.smartyCredentials.length, 1);
  assert.equal(updated.json().settings.smartyCredentials[0].authId, 'account-a-renamed');
  assert.equal(updated.json().settings.smartyCredentials[0].isActive, false);
  const encryptedAfter = (sqlite
    .prepare('SELECT auth_token_encrypted AS token FROM smarty_credentials WHERE id = ?')
    .get(accountA.id) as { token: string }).token;
  const rowCount = (sqlite.prepare('SELECT COUNT(*) AS count FROM smarty_credentials').get() as { count: number }).count;
  sqlite.close();

  assert.equal(encryptedAfter, encryptedBefore);
  assert.equal(rowCount, 1);
});

test('tests individual and all enabled Smarty credentials', async (t) => {
  const testedAuthIds: string[] = [];
  const app = await buildTestServer({
    smartyClient: {
      async testConnection(credentials) {
        testedAuthIds.push(credentials.authId);
        return credentials.authId === 'smarty-auth-id-1'
          ? { ok: true }
          : { ok: false, message: 'Smarty 返回 402' };
      },
    },
  });
  t.after(() => app.close());
  const cookie = await loginCookie(app);

  await app.inject({
    method: 'PATCH',
    url: '/api/admin/settings/smarty',
    headers: { cookie },
    payload: {
      credentials: [
        { authId: 'smarty-auth-id-1', authToken: 'smarty-secret-token-1', isActive: true },
        { authId: 'smarty-auth-id-2', authToken: 'smarty-secret-token-2', isActive: true },
        { authId: 'smarty-auth-id-disabled', authToken: 'disabled-token', isActive: false },
      ],
    },
  });

  const response = await app.inject({
    method: 'POST',
    url: '/api/admin/settings/smarty/test',
    headers: { cookie },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.json().settings.smartyConnectionStatus, 'connected');
  assert.deepEqual(testedAuthIds, ['smarty-auth-id-1', 'smarty-auth-id-2']);
  const credentials = response.json().settings.smartyCredentials;
  assert.equal(credentials[0].lastStatus, 'success');
  assert.equal(credentials[1].lastStatus, 'failed');
  assert.equal(credentials[2].lastStatus, 'not_tested');

  const individualResponse = await app.inject({
    method: 'POST',
    url: `/api/admin/settings/smarty/${credentials[2].id}/test`,
    headers: { cookie },
  });
  assert.equal(individualResponse.statusCode, 200);
  assert.deepEqual(testedAuthIds, ['smarty-auth-id-1', 'smarty-auth-id-2', 'smarty-auth-id-disabled']);
});

test('validates new Smarty credentials and duplicate Auth IDs', async (t) => {
  const app = await buildTestServer();
  t.after(() => app.close());
  const cookie = await loginCookie(app);

  const missingToken = await app.inject({
    method: 'PATCH',
    url: '/api/admin/settings/smarty',
    headers: { cookie },
    payload: { credentials: [{ authId: 'new-account', isActive: true }] },
  });
  assert.equal(missingToken.statusCode, 400);

  const duplicates = await app.inject({
    method: 'PATCH',
    url: '/api/admin/settings/smarty',
    headers: { cookie },
    payload: {
      credentials: [
        { authId: 'duplicate', authToken: 'token-1', isActive: true },
        { authId: 'duplicate', authToken: 'token-2', isActive: true },
      ],
    },
  });
  assert.equal(duplicates.statusCode, 400);
});

test('migrates the legacy single Smarty credential into the pool once', async (t) => {
  const databaseUrl = join(process.cwd(), '.runtime', 'test-smarty-legacy-migration.sqlite');
  rmSync(databaseUrl, { force: true });
  const database = createDatabase({ url: databaseUrl });
  ensureDatabaseSchema(database.sqlite);
  database.sqlite.prepare(`
    INSERT INTO system_settings (
      id, smarty_auth_id, smarty_auth_token_encrypted,
      smarty_connection_status, smarty_connection_message, smarty_last_tested_at,
      created_at, updated_at
    ) VALUES (
      1, 'legacy-auth-id', 'v1:legacy-token',
      'connected', 'legacy connection passed', '2026-08-08T00:00:00.000Z',
      CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    )
  `).run();
  database.sqlite.close();

  const app = await buildTestServer({ databaseUrl });
  t.after(async () => {
    await app.close();
    rmSync(databaseUrl, { force: true });
  });

  const sqlite = new Database(databaseUrl);
  const migrated = sqlite.prepare(`
    SELECT auth_id AS authId, auth_token_encrypted AS token,
           last_status AS lastStatus, last_message AS lastMessage, last_checked_at AS lastCheckedAt
    FROM smarty_credentials
  `).get() as {
    authId: string;
    token: string;
    lastStatus: string;
    lastMessage: string;
    lastCheckedAt: string;
  };
  const legacy = sqlite.prepare('SELECT smarty_auth_id AS authId, smarty_auth_token_encrypted AS token FROM system_settings').get() as {
    authId: string;
    token: string | null;
  };
  sqlite.close();

  assert.deepEqual(migrated, {
    authId: 'legacy-auth-id',
    token: 'v1:legacy-token',
    lastStatus: 'success',
    lastMessage: 'legacy connection passed',
    lastCheckedAt: '2026-08-08T00:00:00.000Z',
  });
  assert.deepEqual(legacy, { authId: '', token: null });
});

test('validates update schedule and saves head code', async (t) => {
  const app = await buildTestServer();
  t.after(() => app.close());
  const cookie = await loginCookie(app);

  const invalidSchedule = await app.inject({
    method: 'PATCH',
    url: '/api/admin/settings/update-schedule',
    headers: { cookie },
    payload: {
      autoUpdateEnabled: true,
      updateFrequencyDays: 7,
      updateHour: 8,
      updateMinute: 15,
    },
  });
  assert.equal(invalidSchedule.statusCode, 400);

  const scheduleResponse = await app.inject({
    method: 'PATCH',
    url: '/api/admin/settings/update-schedule',
    headers: { cookie },
    payload: {
      autoUpdateEnabled: false,
      updateFrequencyDays: null,
      updateHour: 23,
      updateMinute: 30,
    },
  });
  assert.equal(scheduleResponse.statusCode, 200);
  assert.equal(scheduleResponse.json().settings.autoUpdateEnabled, false);
  assert.equal(scheduleResponse.json().settings.updateFrequencyDays, null);
  assert.equal(scheduleResponse.json().settings.nextRunAt, null);

  const headResponse = await app.inject({
    method: 'PATCH',
    url: '/api/admin/settings/head-code',
    headers: { cookie },
    payload: {
      headCode: '<meta name="theme-color" content="#057f93">\n<script>alert("x")</script>',
    },
  });
  assert.equal(headResponse.statusCode, 200);
  assert.match(headResponse.json().settings.headCode, /theme-color/);

  const checkResponse = await app.inject({
    method: 'POST',
    url: '/api/admin/settings/head-code/check',
    headers: { cookie },
    payload: {
      headCode: '<meta name="theme-color" content="#057f93">\n<script>alert("x")</script>',
    },
  });
  assert.equal(checkResponse.statusCode, 200);
  assert.deepEqual(checkResponse.json(), {
    lineCount: 2,
    characterCount: 71,
    warnings: [],
  });
});

test('manages proxy library entries and records proxy test result', async (t) => {
  const tested: Array<{ url: string; isActive: boolean }> = [];
  const app = await buildTestServer({
    proxyTester: {
      async testProxy(proxy) {
        tested.push({ url: proxy.url, isActive: proxy.isActive });
        return { ok: true, message: 'Parsed 1 address from Texas', sampleAddress: 'Austin, TX 78701' };
      },
    },
  });
  t.after(() => app.close());
  const cookie = await loginCookie(app);

  const createResponse = await app.inject({
    method: 'POST',
    url: '/api/admin/settings/proxies',
    headers: { cookie },
    payload: {
      url: '127.0.0.1:8080',
      note: 'primary pool',
    },
  });

  assert.equal(createResponse.statusCode, 200);
  const created = createResponse.json().item;
  assert.equal(created.url, 'http://127.0.0.1:8080');
  assert.equal(created.note, 'primary pool');
  assert.equal(created.isActive, true);

  const updateResponse = await app.inject({
    method: 'PATCH',
    url: `/api/admin/settings/proxies/${created.id}`,
    headers: { cookie },
    payload: {
      isActive: false,
      note: 'paused for now',
    },
  });

  assert.equal(updateResponse.statusCode, 200);
  assert.equal(updateResponse.json().item.isActive, false);
  assert.equal(updateResponse.json().item.note, 'paused for now');

  const testResponse = await app.inject({
    method: 'POST',
    url: `/api/admin/settings/proxies/${created.id}/test`,
    headers: { cookie },
  });

  assert.equal(testResponse.statusCode, 200);
  assert.deepEqual(tested, [{ url: 'http://127.0.0.1:8080', isActive: false }]);
  assert.equal(testResponse.json().item.lastTestStatus, 'success');
  assert.equal(testResponse.json().item.lastTestMessage, 'Parsed 1 address from Texas');
  assert.equal(testResponse.json().item.lastTestSampleAddress, 'Austin, TX 78701');

  const socksUpdateResponse = await app.inject({
    method: 'PATCH',
    url: `/api/admin/settings/proxies/${created.id}`,
    headers: { cookie },
    payload: {
      url: 'socks5h://127.0.0.1:6153',
    },
  });

  assert.equal(socksUpdateResponse.statusCode, 200);
  assert.equal(socksUpdateResponse.json().item.url, 'socks5h://127.0.0.1:6153');
  assert.equal(socksUpdateResponse.json().item.lastTestStatus, 'not_tested');
  assert.equal(socksUpdateResponse.json().item.lastTestMessage, null);
  assert.equal(socksUpdateResponse.json().item.lastTestSampleAddress, null);
  assert.equal(socksUpdateResponse.json().item.lastTestedAt, null);

  const socksTestResponse = await app.inject({
    method: 'POST',
    url: `/api/admin/settings/proxies/${created.id}/test`,
    headers: { cookie },
  });

  assert.equal(socksTestResponse.statusCode, 200);
  assert.equal(socksTestResponse.json().item.lastTestStatus, 'success');
  assert.deepEqual(tested, [
    { url: 'http://127.0.0.1:8080', isActive: false },
    { url: 'socks5h://127.0.0.1:6153', isActive: false },
  ]);

  const unsupportedProxyResponse = await app.inject({
    method: 'POST',
    url: '/api/admin/settings/proxies',
    headers: { cookie },
    payload: {
      url: 'ftp://127.0.0.1:21',
    },
  });

  assert.equal(unsupportedProxyResponse.statusCode, 400);
  assert.match(unsupportedProxyResponse.json().message, /SOCKS5/);

  const listResponse = await app.inject({
    method: 'GET',
    url: '/api/admin/settings/proxies',
    headers: { cookie },
  });

  assert.equal(listResponse.statusCode, 200);
  assert.equal(listResponse.json().items.length, 1);

  const deleteResponse = await app.inject({
    method: 'DELETE',
    url: `/api/admin/settings/proxies/${created.id}`,
    headers: { cookie },
  });

  assert.equal(deleteResponse.statusCode, 204);

  const emptyResponse = await app.inject({
    method: 'GET',
    url: '/api/admin/settings/proxies',
    headers: { cookie },
  });
  assert.deepEqual(emptyResponse.json().items, []);
});
