import axios from 'axios';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';
import type { DatabaseContext } from '@atmb/db';
import { US_STATES } from '@atmb/shared';
import type {
  AdminProxyListItem,
  AdminProxyTestStatus,
  AdminSmartyCredential,
  AdminSystemSettings,
  HeadCodeCheckResponse,
  SmartyCredentialStatus,
  UpdateFrequencyDays,
  UpdateMinute,
} from '@atmb/shared';

import type { ServerConfig } from '../auth/config.js';
import { parseLocationDetail, parseLocationList } from '../crawl/parser.js';
import { HttpCrawlFetcher } from '../crawl/pipeline.js';
import { normalizeProxyUrl, type CrawlProxy } from '../proxy.js';

export interface SmartyClient {
  testConnection(credentials: { authId: string; authToken: string }): Promise<{
    ok: boolean;
    message?: string;
  }>;
}

export interface SaveSmartySettingsInput {
  credentials: Array<{
    id?: number;
    authId: string;
    authToken?: string;
    isActive: boolean;
  }>;
}

export interface ProxyTestResult {
  ok: boolean;
  message?: string;
  sampleAddress?: string;
}

export interface ProxyTester {
  testProxy(proxy: AdminProxyListItem): Promise<ProxyTestResult>;
}

export interface SaveProxyInput {
  url?: string;
  note?: string | null;
  isActive?: boolean;
}

interface ProxyRow {
  id: number;
  url: string;
  note: string | null;
  isActive: number;
  lastTestStatus: AdminProxyTestStatus;
  lastTestMessage: string | null;
  lastTestSampleAddress: string | null;
  lastTestedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface SmartyCredentialRow {
  id: number;
  authId: string;
  authTokenEncrypted: string;
  isActive: number;
  lastStatus: SmartyCredentialStatus;
  lastMessage: string | null;
  lastCheckedAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SaveUpdateScheduleInput {
  autoUpdateEnabled: boolean;
  updateFrequencyDays: UpdateFrequencyDays | null;
  updateHour: number;
  updateMinute: UpdateMinute;
}

interface SystemSettingsRow {
  id: number;
  autoUpdateEnabled: number;
  updateFrequencyDays: UpdateFrequencyDays | null;
  updateHour: number;
  updateMinute: UpdateMinute;
  headCode: string;
  updatedAt: string;
}

export class HttpSmartyClient implements SmartyClient {
  async testConnection(credentials: { authId: string; authToken: string }) {
    const response = await axios.get('https://us-street.api.smarty.com/street-address', {
      params: {
        'auth-id': credentials.authId,
        'auth-token': credentials.authToken,
        street: '1600 Amphitheatre Pkwy',
        city: 'Mountain View',
        state: 'CA',
        candidates: 1,
      },
      timeout: 10000,
      validateStatus: () => true,
    });

    return response.status >= 200 && response.status < 300
      ? { ok: true }
      : { ok: false, message: `Smarty 返回 ${response.status}` };
  }
}

export class HttpProxyTester implements ProxyTester {
  async testProxy(proxy: AdminProxyListItem): Promise<ProxyTestResult> {
    const state = US_STATES.find((item) => item.slug === 'alabama') ?? US_STATES[0];
    if (!state) {
      return { ok: false, message: 'No state target available' };
    }

    const url = `https://www.anytimemailbox.com/l/usa/${state.slug}`;
    const fetcher = new HttpCrawlFetcher({
      proxyProvider: () => ({ id: proxy.id, url: proxy.url }),
      requestDelayMs: { min: 0, max: 0 },
    });

    try {
      const response = await fetcher.fetchHtml(url);
      if (response.status < 200 || response.status >= 300) {
        return { ok: false, message: `ATMB state page returned ${response.status}` };
      }

      const locations = parseLocationList(response.html, url);
      const sampleLocation = locations[0];
      if (!sampleLocation) {
        return { ok: false, message: `No addresses parsed from ${state.name}` };
      }

      const detailResponse = await fetcher.fetchHtml(sampleLocation.url, { referer: url });
      const detail = parseLocationDetail(detailResponse.html, detailResponse.finalUrl);
      const sample = detail.detailAddress || sampleLocation.address || sampleLocation.name;

      return detail.address
        ? {
            ok: true,
            message: `Parsed ${locations.length} address(es) from ${state.name}; detail page reachable`,
            sampleAddress: sample,
          }
        : { ok: false, message: `Detail page did not contain an address for ${sampleLocation.name}` };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'Proxy test failed' };
    }
  }
}

export class SettingsService {
  constructor(
    private readonly database: DatabaseContext,
    private readonly config: ServerConfig,
    private readonly smartyClient: SmartyClient = new HttpSmartyClient(),
    private readonly proxyTester: ProxyTester = new HttpProxyTester(),
  ) {}

  ensureDefaultSettings() {
    this.database.sqlite
      .prepare(`
        INSERT OR IGNORE INTO system_settings (
          id, smarty_auth_id, smarty_connection_status, auto_update_enabled,
          update_frequency_days, update_hour, update_minute, head_code, created_at, updated_at
        ) VALUES (1, '', 'not_configured', 1, 1, 8, 30, '', ?, ?)
      `)
      .run(new Date().toISOString(), new Date().toISOString());
  }

  getSettings(): AdminSystemSettings {
    return toSafeSettings(this.getRow(), this.listSmartyCredentials());
  }

  getSmartyCredentialsPool() {
    return this.getSmartyCredentialRows()
      .filter((credential) => Boolean(credential.isActive))
      .map((credential) => ({
        id: credential.id,
        authId: credential.authId,
        authToken: decryptSecret(credential.authTokenEncrypted, this.config.sessionSecret),
      }));
  }

  getUpdateSchedule() {
    const current = this.getRow();

    return {
      autoUpdateEnabled: Boolean(current.autoUpdateEnabled),
      updateFrequencyDays: current.updateFrequencyDays,
      updateHour: current.updateHour,
      updateMinute: current.updateMinute,
    };
  }

  saveSmartySettings(input: SaveSmartySettingsInput) {
    const currentRows = this.getSmartyCredentialRows();
    const currentById = new Map(currentRows.map((row) => [row.id, row]));
    const authIds = input.credentials.map((credential) => credential.authId.trim());
    if (new Set(authIds).size !== authIds.length) {
      throw new Error('SMARTY_DUPLICATE_AUTH_ID');
    }
    const credentialIds = input.credentials
      .map((credential) => credential.id)
      .filter((id): id is number => id !== undefined);
    if (new Set(credentialIds).size !== credentialIds.length) {
      throw new Error('SMARTY_DUPLICATE_CREDENTIAL_ID');
    }

    const now = new Date().toISOString();
    const save = this.database.sqlite.transaction(() => {
      const keptIds = new Set<number>();

      for (const current of currentRows) {
        this.database.sqlite
          .prepare('UPDATE smarty_credentials SET auth_id = ? WHERE id = ?')
          .run(`__pending_smarty_${current.id}_${now}`, current.id);
      }

      for (const credential of input.credentials) {
        const authId = credential.authId.trim();
        const authToken = credential.authToken?.trim();

        if (credential.id !== undefined) {
          const current = currentById.get(credential.id);
          if (!current) {
            throw new Error('SMARTY_CREDENTIAL_NOT_FOUND');
          }

          const tokenChanged = Boolean(authToken);
          const authIdChanged = authId !== current.authId;
          this.database.sqlite
            .prepare(`
              UPDATE smarty_credentials
              SET
                auth_id = @authId,
                auth_token_encrypted = @token,
                is_active = @isActive,
                last_status = @lastStatus,
                last_message = @lastMessage,
                last_checked_at = @lastCheckedAt,
                updated_at = @updatedAt
              WHERE id = @id
            `)
            .run({
              id: current.id,
              authId,
              token: tokenChanged
                ? encryptSecret(authToken!, this.config.sessionSecret)
                : current.authTokenEncrypted,
              isActive: credential.isActive ? 1 : 0,
              lastStatus: tokenChanged || authIdChanged ? 'not_tested' : current.lastStatus,
              lastMessage: tokenChanged || authIdChanged ? null : current.lastMessage,
              lastCheckedAt: tokenChanged || authIdChanged ? null : current.lastCheckedAt,
              updatedAt: now,
            });
          keptIds.add(current.id);
          continue;
        }

        if (!authToken) {
          throw new Error('SMARTY_TOKEN_REQUIRED');
        }

        const result = this.database.sqlite
          .prepare(`
            INSERT INTO smarty_credentials (
              auth_id, auth_token_encrypted, is_active, created_at, updated_at
            ) VALUES (@authId, @token, @isActive, @now, @now)
          `)
          .run({
            authId,
            token: encryptSecret(authToken, this.config.sessionSecret),
            isActive: credential.isActive ? 1 : 0,
            now,
          });
        keptIds.add(Number(result.lastInsertRowid));
      }

      for (const current of currentRows) {
        if (!keptIds.has(current.id)) {
          this.database.sqlite.prepare('DELETE FROM smarty_credentials WHERE id = ?').run(current.id);
        }
      }
    });

    save();

    return this.getSettings();
  }

  async testSmartyConnections() {
    const credentials = this.getSmartyCredentialRows().filter((credential) => Boolean(credential.isActive));
    if (credentials.length === 0) {
      throw new Error('SMARTY_NOT_CONFIGURED');
    }

    for (const credential of credentials) {
      await this.testSmartyCredentialRow(credential);
    }

    return this.getSettings();
  }

  async testSmartyCredential(id: number) {
    await this.testSmartyCredentialRow(this.getSmartyCredentialRow(id));

    return this.getSettings();
  }

  markSmartyCredentialSuccess(id: number) {
    const now = new Date().toISOString();
    this.database.sqlite
      .prepare(`
        UPDATE smarty_credentials
        SET last_status = 'success', last_message = NULL,
            last_checked_at = @now, last_used_at = @now, updated_at = @now
        WHERE id = @id
      `)
      .run({ id, now });
  }

  markSmartyCredentialFailure(id: number, message: string) {
    const now = new Date().toISOString();
    this.database.sqlite
      .prepare(`
        UPDATE smarty_credentials
        SET last_status = 'failed', last_message = @message,
            last_checked_at = @now, last_used_at = @now, updated_at = @now
        WHERE id = @id
      `)
      .run({ id, message, now });
  }

  private async testSmartyCredentialRow(credential: SmartyCredentialRow) {
    let result: { ok: boolean; message?: string };
    try {
      result = await this.smartyClient.testConnection({
        authId: credential.authId,
        authToken: decryptSecret(credential.authTokenEncrypted, this.config.sessionSecret),
      });
    } catch (error) {
      result = {
        ok: false,
        message: error instanceof Error ? error.message : 'Smarty connection test failed',
      };
    }
    const now = new Date().toISOString();
    this.database.sqlite
      .prepare(`
        UPDATE smarty_credentials
        SET last_status = @status, last_message = @message,
            last_checked_at = @now, updated_at = @now
        WHERE id = @id
      `)
      .run({
        id: credential.id,
        status: result.ok ? 'success' : 'failed',
        message: result.message ?? null,
        now,
      });
  }

  private listSmartyCredentials() {
    return this.getSmartyCredentialRows().map(toSafeSmartyCredential);
  }

  private getSmartyCredentialRows() {
    return this.database.sqlite
      .prepare(`
        SELECT
          id,
          auth_id AS authId,
          auth_token_encrypted AS authTokenEncrypted,
          is_active AS isActive,
          last_status AS lastStatus,
          last_message AS lastMessage,
          last_checked_at AS lastCheckedAt,
          last_used_at AS lastUsedAt,
          created_at AS createdAt,
          updated_at AS updatedAt
        FROM smarty_credentials
        ORDER BY id ASC
      `)
      .all() as SmartyCredentialRow[];
  }

  private getSmartyCredentialRow(id: number) {
    const row = this.getSmartyCredentialRows().find((credential) => credential.id === id);
    if (!row) {
      throw new Error('SMARTY_CREDENTIAL_NOT_FOUND');
    }

    return row;
  }

  saveUpdateSchedule(input: SaveUpdateScheduleInput) {
    const now = new Date().toISOString();

    this.database.sqlite
      .prepare(`
        UPDATE system_settings
        SET
          auto_update_enabled = @enabled,
          update_frequency_days = @frequency,
          update_hour = @hour,
          update_minute = @minute,
          updated_at = @updatedAt
        WHERE id = 1
      `)
      .run({
        enabled: input.autoUpdateEnabled ? 1 : 0,
        frequency: input.autoUpdateEnabled ? input.updateFrequencyDays : null,
        hour: input.updateHour,
        minute: input.updateMinute,
        updatedAt: now,
      });

    return this.getSettings();
  }

  saveHeadCode(headCode: string) {
    this.database.sqlite
      .prepare('UPDATE system_settings SET head_code = ?, updated_at = ? WHERE id = 1')
      .run(headCode, new Date().toISOString());

    return this.getSettings();
  }


  listProxies() {
    return this.database.sqlite
      .prepare(`
        SELECT
          id,
          url,
          note,
          is_active AS isActive,
          last_test_status AS lastTestStatus,
          last_test_message AS lastTestMessage,
          last_test_sample_address AS lastTestSampleAddress,
          last_tested_at AS lastTestedAt,
          created_at AS createdAt,
          updated_at AS updatedAt
        FROM proxy_library
        ORDER BY id DESC
      `)
      .all()
      .map((row) => toSafeProxy(row as ProxyRow));
  }

  createProxy(input: SaveProxyInput) {
    if (!input.url) {
      throw new Error('INVALID_PROXY_URL');
    }

    const now = new Date().toISOString();
    const url = normalizeProxyUrl(input.url);
    const result = this.database.sqlite
      .prepare(`
        INSERT INTO proxy_library (url, note, is_active, created_at, updated_at)
        VALUES (@url, @note, @isActive, @now, @now)
      `)
      .run({
        url,
        note: normalizeProxyNote(input.note),
        isActive: input.isActive === false ? 0 : 1,
        now,
      });

    return this.getProxy(Number(result.lastInsertRowid));
  }

  updateProxy(id: number, input: SaveProxyInput) {
    const current = this.getProxyRow(id);
    const now = new Date().toISOString();
    const nextUrl = input.url === undefined ? current.url : normalizeProxyUrl(input.url);
    const urlChanged = nextUrl !== current.url;

    this.database.sqlite
      .prepare(`
        UPDATE proxy_library
        SET
          url = @url,
          note = @note,
          is_active = @isActive,
          last_test_status = @lastTestStatus,
          last_test_message = @lastTestMessage,
          last_test_sample_address = @lastTestSampleAddress,
          last_tested_at = @lastTestedAt,
          updated_at = @updatedAt
        WHERE id = @id
      `)
      .run({
        id,
        url: nextUrl,
        note: input.note === undefined ? current.note : normalizeProxyNote(input.note),
        isActive: input.isActive === undefined ? current.isActive : input.isActive ? 1 : 0,
        lastTestStatus: urlChanged ? 'not_tested' : current.lastTestStatus,
        lastTestMessage: urlChanged ? null : current.lastTestMessage,
        lastTestSampleAddress: urlChanged ? null : current.lastTestSampleAddress,
        lastTestedAt: urlChanged ? null : current.lastTestedAt,
        updatedAt: now,
      });

    return this.getProxy(id);
  }

  deleteProxy(id: number) {
    const result = this.database.sqlite.prepare('DELETE FROM proxy_library WHERE id = ?').run(id);
    if (result.changes === 0) {
      throw new Error('PROXY_NOT_FOUND');
    }
  }

  async testProxy(id: number) {
    const current = this.getProxy(id);
    const result = await this.proxyTester.testProxy(current);
    const now = new Date().toISOString();

    this.database.sqlite
      .prepare(`
        UPDATE proxy_library
        SET
          last_test_status = @status,
          last_test_message = @message,
          last_test_sample_address = @sampleAddress,
          last_tested_at = @testedAt,
          updated_at = @updatedAt
        WHERE id = @id
      `)
      .run({
        id,
        status: result.ok ? 'success' : 'failed',
        message: result.message ?? null,
        sampleAddress: result.sampleAddress ?? null,
        testedAt: now,
        updatedAt: now,
      });

    return this.getProxy(id);
  }

  getRandomActiveProxy(): CrawlProxy | null {
    const rows = this.database.sqlite
      .prepare('SELECT id, url FROM proxy_library WHERE is_active = 1 ORDER BY id ASC')
      .all() as Array<{ id: number; url: string }>;

    if (!rows.length) return null;
    return rows[Math.floor(Math.random() * rows.length)] ?? null;
  }

  getProxy(id: number) {
    return toSafeProxy(this.getProxyRow(id));
  }
  checkHeadCode(headCode: string): HeadCodeCheckResponse {
    const warnings: string[] = [];

    if (/<script\b[^>]*>/i.test(headCode) && !/<\/script>/i.test(headCode)) {
      warnings.push('存在未闭合的 script 标签');
    }
    if (/<style\b[^>]*>/i.test(headCode) && !/<\/style>/i.test(headCode)) {
      warnings.push('存在未闭合的 style 标签');
    }

    return {
      lineCount: headCode.length ? headCode.split(/\r\n|\r|\n/).length : 0,
      characterCount: headCode.length,
      warnings,
    };
  }

  private getProxyRow(id: number): ProxyRow {
    const row = this.database.sqlite
      .prepare(`
        SELECT
          id,
          url,
          note,
          is_active AS isActive,
          last_test_status AS lastTestStatus,
          last_test_message AS lastTestMessage,
          last_test_sample_address AS lastTestSampleAddress,
          last_tested_at AS lastTestedAt,
          created_at AS createdAt,
          updated_at AS updatedAt
        FROM proxy_library
        WHERE id = ?
      `)
      .get(id) as ProxyRow | undefined;

    if (!row) {
      throw new Error('PROXY_NOT_FOUND');
    }

    return row;
  }

  private getRow(): SystemSettingsRow {
    this.ensureDefaultSettings();

    return this.database.sqlite
      .prepare(`
        SELECT
          id,
          auto_update_enabled AS autoUpdateEnabled,
          update_frequency_days AS updateFrequencyDays,
          update_hour AS updateHour,
          update_minute AS updateMinute,
          head_code AS headCode,
          updated_at AS updatedAt
        FROM system_settings
        WHERE id = 1
      `)
      .get() as SystemSettingsRow;
  }
}

function toSafeProxy(row: ProxyRow): AdminProxyListItem {
  return {
    id: row.id,
    url: row.url,
    note: row.note,
    isActive: Boolean(row.isActive),
    lastTestStatus: row.lastTestStatus,
    lastTestMessage: row.lastTestMessage,
    lastTestSampleAddress: row.lastTestSampleAddress,
    lastTestedAt: row.lastTestedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function normalizeProxyNote(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function toSafeSmartyCredential(row: SmartyCredentialRow): AdminSmartyCredential {
  return {
    id: row.id,
    authId: row.authId,
    hasAuthToken: Boolean(row.authTokenEncrypted),
    isActive: Boolean(row.isActive),
    lastStatus: row.lastStatus,
    lastMessage: row.lastMessage,
    lastCheckedAt: row.lastCheckedAt,
    lastUsedAt: row.lastUsedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toSafeSettings(row: SystemSettingsRow, smartyCredentials: AdminSmartyCredential[]): AdminSystemSettings {
  const autoUpdateEnabled = Boolean(row.autoUpdateEnabled);
  const activeCredentials = smartyCredentials.filter((credential) => credential.isActive);
  const successfulCredentials = activeCredentials.filter((credential) => credential.lastStatus === 'success');
  const failedCredentials = activeCredentials.filter((credential) => credential.lastStatus === 'failed');
  const smartyConnectionStatus = activeCredentials.length === 0
    ? 'not_configured'
    : successfulCredentials.length > 0
      ? 'connected'
      : failedCredentials.length === activeCredentials.length
        ? 'failed'
        : 'not_configured';
  const smartyConnectionMessage = activeCredentials.length === 0
    ? '尚未配置启用的 Smarty 账号'
    : successfulCredentials.length > 0
      ? `${successfulCredentials.length}/${activeCredentials.length} 个启用账号可用`
      : failedCredentials.length === activeCredentials.length
        ? `${failedCredentials.length} 个启用账号均不可用`
        : `${activeCredentials.length - failedCredentials.length} 个启用账号尚未测试`;

  return {
    smartyCredentials,
    smartyConnectionStatus,
    smartyConnectionMessage,
    autoUpdateEnabled,
    updateFrequencyDays: row.updateFrequencyDays,
    updateHour: row.updateHour,
    updateMinute: row.updateMinute,
    nextRunAt: nextRunAt(autoUpdateEnabled, row.updateFrequencyDays, row.updateHour, row.updateMinute),
    headCode: row.headCode,
    updatedAt: row.updatedAt,
  };
}

function nextRunAt(
  enabled: boolean,
  frequencyDays: UpdateFrequencyDays | null,
  hour: number,
  minute: number,
) {
  if (!enabled || !frequencyDays) {
    return null;
  }

  const now = new Date();
  const next = new Date(now);
  next.setHours(hour, minute, 0, 0);

  if (next <= now) {
    next.setDate(next.getDate() + frequencyDays);
  }

  return next.toISOString();
}

function encryptionKey(secret: string) {
  return createHash('sha256').update(secret).digest();
}

function encryptSecret(value: string, secret: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(secret), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [
    'v1',
    iv.toString('base64url'),
    tag.toString('base64url'),
    encrypted.toString('base64url'),
  ].join(':');
}

function decryptSecret(value: string, secret: string) {
  const [version, ivValue, tagValue, encryptedValue] = value.split(':');

  if (version !== 'v1' || !ivValue || !tagValue || !encryptedValue) {
    throw new Error('INVALID_ENCRYPTED_SECRET');
  }

  const decipher = createDecipheriv(
    'aes-256-gcm',
    encryptionKey(secret),
    Buffer.from(ivValue, 'base64url'),
  );
  decipher.setAuthTag(Buffer.from(tagValue, 'base64url'));

  return Buffer.concat([
    decipher.update(Buffer.from(encryptedValue, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}
