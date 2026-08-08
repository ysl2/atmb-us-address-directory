import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { SettingsService } from './service.js';

const frequencySchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5),
  z.literal(10),
]);

const smartySchema = z.object({
  credentials: z.array(z.object({
    id: z.number().int().positive().optional(),
    authId: z.string().trim().min(1),
    authToken: z.string().trim().min(1).optional(),
    isActive: z.boolean(),
  })),
});

const smartyCredentialIdSchema = z.object({
  id: z.coerce.number().int().positive(),
});

const updateScheduleSchema = z.object({
  autoUpdateEnabled: z.boolean(),
  updateFrequencyDays: frequencySchema.nullable(),
  updateHour: z.number().int().min(0).max(23),
  updateMinute: z.union([z.literal(0), z.literal(30)]),
}).superRefine((value, context) => {
  if (value.autoUpdateEnabled && value.updateFrequencyDays === null) {
    context.addIssue({
      code: 'custom',
      path: ['updateFrequencyDays'],
      message: '开启自动更新时请选择更新频率',
    });
  }
});

const headCodeSchema = z.object({
  headCode: z.string(),
});
const proxySchema = z.object({
  url: z.string().trim().min(1).optional(),
  note: z.string().nullable().optional(),
  isActive: z.boolean().optional(),
});

const createProxySchema = proxySchema.extend({
  url: z.string().trim().min(1),
});

const proxyIdSchema = z.object({
  id: z.coerce.number().int().positive(),
});

export function registerSettingsRoutes(app: FastifyInstance, settingsService: SettingsService) {
  app.get('/api/admin/settings', async (request, reply) => {
    if (!requireAdmin(request, reply)) return reply;
    return { settings: settingsService.getSettings() };
  });

  app.patch('/api/admin/settings/smarty', async (request, reply) => {
    if (!requireAdmin(request, reply)) return reply;
    const parsed = smartySchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.code(400).send({ message: 'Smarty 配置字段不正确' });
    }

    try {
      return { settings: settingsService.saveSmartySettings(parsed.data) };
    } catch (error) {
      if (error instanceof Error && error.message === 'SMARTY_TOKEN_REQUIRED') {
        return reply.code(400).send({ message: '新增 Smarty 账号必须填写 Auth Token' });
      }
      if (error instanceof Error && error.message === 'SMARTY_DUPLICATE_AUTH_ID') {
        return reply.code(400).send({ message: 'Smarty Auth ID 不能重复' });
      }
      if (error instanceof Error && error.message === 'SMARTY_DUPLICATE_CREDENTIAL_ID') {
        return reply.code(400).send({ message: 'Smarty 账号 ID 不能重复' });
      }
      if (error instanceof Error && error.message === 'SMARTY_CREDENTIAL_NOT_FOUND') {
        return reply.code(400).send({ message: 'Smarty 账号不存在，请刷新后重试' });
      }
      throw error;
    }
  });

  app.post('/api/admin/settings/smarty/test', async (request, reply) => {
    if (!requireAdmin(request, reply)) return reply;

    try {
      return { settings: await settingsService.testSmartyConnections() };
    } catch (error) {
      if (error instanceof Error && error.message === 'SMARTY_NOT_CONFIGURED') {
        return reply.code(400).send({ message: '请先保存并启用至少一个 Smarty 账号' });
      }
      throw error;
    }
  });

  app.post('/api/admin/settings/smarty/:id/test', async (request, reply) => {
    if (!requireAdmin(request, reply)) return reply;
    const params = smartyCredentialIdSchema.safeParse(request.params);

    if (!params.success) {
      return reply.code(400).send({ message: 'Smarty 账号 ID 不正确' });
    }

    try {
      return { settings: await settingsService.testSmartyCredential(params.data.id) };
    } catch (error) {
      if (error instanceof Error && error.message === 'SMARTY_CREDENTIAL_NOT_FOUND') {
        return reply.code(404).send({ message: 'Smarty 账号不存在' });
      }
      throw error;
    }
  });


  app.get('/api/admin/settings/proxies', async (request, reply) => {
    if (!requireAdmin(request, reply)) return reply;
    return { items: settingsService.listProxies() };
  });

  app.post('/api/admin/settings/proxies', async (request, reply) => {
    if (!requireAdmin(request, reply)) return reply;
    const parsed = createProxySchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.code(400).send({ message: '代理字段不正确' });
    }

    try {
      return { item: settingsService.createProxy(parsed.data) };
    } catch (error) {
      if (error instanceof Error && (error.message === 'INVALID_PROXY_URL' || error.message === 'UNSUPPORTED_PROXY_PROTOCOL')) {
        return reply.code(400).send({ message: '代理地址支持 HTTP、HTTPS、SOCKS5 或 SOCKS5H host:port 格式' });
      }
      throw error;
    }
  });

  app.patch('/api/admin/settings/proxies/:id', async (request, reply) => {
    if (!requireAdmin(request, reply)) return reply;
    const params = proxyIdSchema.safeParse(request.params);
    const parsed = proxySchema.safeParse(request.body);

    if (!params.success || !parsed.success) {
      return reply.code(400).send({ message: '代理字段不正确' });
    }

    try {
      return { item: settingsService.updateProxy(params.data.id, parsed.data) };
    } catch (error) {
      if (error instanceof Error && error.message === 'PROXY_NOT_FOUND') {
        return reply.code(404).send({ message: '代理不存在' });
      }
      if (error instanceof Error && (error.message === 'INVALID_PROXY_URL' || error.message === 'UNSUPPORTED_PROXY_PROTOCOL')) {
        return reply.code(400).send({ message: '代理地址支持 HTTP、HTTPS、SOCKS5 或 SOCKS5H host:port 格式' });
      }
      throw error;
    }
  });

  app.delete('/api/admin/settings/proxies/:id', async (request, reply) => {
    if (!requireAdmin(request, reply)) return reply;
    const params = proxyIdSchema.safeParse(request.params);

    if (!params.success) {
      return reply.code(400).send({ message: '代理 ID 不正确' });
    }

    try {
      settingsService.deleteProxy(params.data.id);
      return reply.code(204).send();
    } catch (error) {
      if (error instanceof Error && error.message === 'PROXY_NOT_FOUND') {
        return reply.code(404).send({ message: '代理不存在' });
      }
      throw error;
    }
  });

  app.post('/api/admin/settings/proxies/:id/test', async (request, reply) => {
    if (!requireAdmin(request, reply)) return reply;
    const params = proxyIdSchema.safeParse(request.params);

    if (!params.success) {
      return reply.code(400).send({ message: '代理 ID 不正确' });
    }

    try {
      return { item: await settingsService.testProxy(params.data.id) };
    } catch (error) {
      if (error instanceof Error && error.message === 'PROXY_NOT_FOUND') {
        return reply.code(404).send({ message: '代理不存在' });
      }
      throw error;
    }
  });
  app.patch('/api/admin/settings/update-schedule', async (request, reply) => {
    if (!requireAdmin(request, reply)) return reply;
    const parsed = updateScheduleSchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.code(400).send({ message: '更新设置字段不正确' });
    }

    return { settings: settingsService.saveUpdateSchedule(parsed.data) };
  });

  app.patch('/api/admin/settings/head-code', async (request, reply) => {
    if (!requireAdmin(request, reply)) return reply;
    const parsed = headCodeSchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.code(400).send({ message: 'Head 代码字段不正确' });
    }

    return { settings: settingsService.saveHeadCode(parsed.data.headCode) };
  });

  app.post('/api/admin/settings/head-code/check', async (request, reply) => {
    if (!requireAdmin(request, reply)) return reply;
    const parsed = headCodeSchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.code(400).send({ message: 'Head 代码字段不正确' });
    }

    return settingsService.checkHeadCode(parsed.data.headCode);
  });
}

function requireAdmin(request: FastifyRequest, reply: FastifyReply) {
  const adminUserId = request.session.get('adminUserId');

  if (typeof adminUserId !== 'number') {
    reply.code(401).send({ message: '未登录' });
    return false;
  }

  return true;
}
