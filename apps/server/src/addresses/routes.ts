import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { ServerConfig } from '../auth/config.js';
import type { TaskExecutorLike } from '../tasks/scheduler.js';
import type { TaskService } from '../tasks/service.js';
import type { AddressService } from './service.js';

const rdiSchema = z.enum(['Residential', 'Commercial']);
const cmraSchema = z.enum(['Yes', 'No']);
const rdiFilterSchema = z.enum(['Residential', 'Commercial', 'none']);
const cmraFilterSchema = z.enum(['Yes', 'No', 'none']);
const priceSchema = z.enum(['all', 'lt10', 'lt20', 'gte20']);
const dollarPriceSchema = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z.string()
    .trim()
    .regex(/^\d+(?:\.\d{1,2})?$/)
    .transform((value) => {
      const [dollars, fraction = ''] = value.split('.');
      return Number(dollars) * 100 + Number(fraction.padEnd(2, '0'));
    })
    .refine(Number.isSafeInteger)
    .optional(),
);

const querySchema = z.object({
  keyword: z.string().optional(),
  state: z.string().optional(),
  rdi: rdiFilterSchema.optional(),
  cmra: cmraFilterSchema.optional(),
  featured: z.enum(['true', 'false']).optional(),
  price: priceSchema.optional(),
  minPrice: dollarPriceSchema,
  maxPrice: dollarPriceSchema,
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().optional(),
});

const updateSchema = z.object({
  name: z.string().min(1).optional(),
  streetAddress: z.string().min(1).optional(),
  city: z.string().min(1).optional(),
  state: z.string().length(2).optional(),
  postalCode: z.string().min(3).optional(),
  rdi: rdiSchema.optional(),
  cmra: cmraSchema.optional(),
  priceCents: z.coerce.number().int().nonnegative().optional(),
  isFeatured: z.boolean().optional(),
  isVisible: z.boolean().optional(),
  statusNote: z.string().nullable().optional(),
});

const mailboxUpdateTaskSchema = z.object({
  addressIds: z.array(z.coerce.number().int().positive()).max(100).optional().default([]),
  stageIds: z.array(z.coerce.number().int().positive()).max(100).optional().default([]),
}).refine((input) => input.addressIds.length + input.stageIds.length > 0);

const smartySyncTaskSchema = z.object({
  stageIds: z.array(z.coerce.number().int().positive()).min(1).max(100),
});

export function registerAddressRoutes(
  app: FastifyInstance,
  addressService: AddressService,
  config: ServerConfig,
  taskService?: TaskService,
  taskExecutor?: TaskExecutorLike | null,
) {
  app.get('/api/admin/addresses', async (request, reply) => {
    if (!requireAdmin(request, reply)) return reply;
    const parsed = querySchema.safeParse(request.query);

    if (!parsed.success) {
      const hasInvalidPrice = parsed.error.issues.some((issue) => (
        issue.path[0] === 'minPrice' || issue.path[0] === 'maxPrice'
      ));

      if (hasInvalidPrice) {
        return reply.code(400).send({ message: '价格必须是大于等于 0 且最多保留两位小数的美元金额' });
      }

      return reply.code(400).send({ message: '筛选参数不正确' });
    }

    if (
      parsed.data.minPrice !== undefined
      && parsed.data.maxPrice !== undefined
      && parsed.data.minPrice > parsed.data.maxPrice
    ) {
      return reply.code(400).send({ message: '最低价格不能高于最高价格' });
    }

    const rawQuery = request.query as Record<string, unknown>;
    const hasPriceRange = 'minPrice' in rawQuery || 'maxPrice' in rawQuery;
    const { featured, maxPrice, minPrice, price, ...filters } = parsed.data;

    return addressService.listAddresses({
      ...filters,
      featured: featured ? featured === 'true' : undefined,
      price: hasPriceRange ? undefined : price,
      minPriceCents: minPrice,
      maxPriceCents: maxPrice,
    });
  });

  app.get('/api/admin/addresses/stats', async (request, reply) => {
    if (!requireAdmin(request, reply)) return reply;
    return addressService.getStats();
  });

  app.get('/api/admin/states', async (request, reply) => {
    if (!requireAdmin(request, reply)) return reply;
    return { items: addressService.listStates() };
  });

  app.get('/api/admin/addresses/:id', async (request, reply) => {
    if (!requireAdmin(request, reply)) return reply;
    const { id } = request.params as { id: string };
    const item = addressService.getAddress(Number(id));

    if (!item) {
      return reply.code(404).send({ message: '地址不存在' });
    }

    return { item };
  });

  app.patch('/api/admin/addresses/:id', async (request, reply) => {
    if (!requireAdmin(request, reply)) return reply;
    const { id } = request.params as { id: string };
    const parsed = updateSchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.code(400).send({ message: '地址字段不正确' });
    }

    const item = addressService.updateAddress(Number(id), parsed.data);

    if (!item) {
      return reply.code(404).send({ message: '地址不存在' });
    }

    return { item };
  });

  app.post('/api/admin/addresses/:id/images', async (request, reply) => {
    if (!requireAdmin(request, reply)) return reply;
    const { id } = request.params as { id: string };
    const file = await request.file();

    if (!file) {
      return reply.code(400).send({ message: '请选择图片文件' });
    }

    try {
      const image = addressService.uploadStreetViewImage({
        addressId: Number(id),
        buffer: await file.toBuffer(),
        originalFileName: file.filename,
        mimeType: file.mimetype,
        uploadDir: config.addressImageUploadDir,
        publicBase: config.addressImagePublicBase,
      });

      if (!image) {
        return reply.code(404).send({ message: '地址不存在' });
      }

      return { image };
    } catch (error) {
      if (error instanceof Error && error.message === 'INVALID_IMAGE_TYPE') {
        return reply.code(400).send({ message: '仅支持 JPG / PNG 图片' });
      }
      if (error instanceof Error && error.message === 'IMAGE_TOO_LARGE') {
        return reply.code(400).send({ message: '图片不能超过 5MB' });
      }
      throw error;
    }
  });

  app.delete('/api/admin/addresses/:id/images', async (request, reply) => {
    if (!requireAdmin(request, reply)) return reply;
    const { id } = request.params as { id: string };
    const item = addressService.clearStreetViewImage({
      addressId: Number(id),
      uploadDir: config.addressImageUploadDir,
    });

    if (!item) {
      return reply.code(404).send({ message: '地址不存在' });
    }

    return { item };
  });

  app.post('/api/admin/addresses/mailbox-update-tasks', async (request, reply) => {
    if (!requireAdmin(request, reply)) return reply;
    if (!taskService) {
      return reply.code(503).send({ message: '任务服务不可用' });
    }

    const parsed = mailboxUpdateTaskSchema.safeParse(request.body ?? {});

    if (!parsed.success) {
      return reply.code(400).send({ message: '请选择需要更新编号的地址' });
    }

    if (taskService.hasRunningTask()) {
      return reply.code(409).send({ message: '已有任务正在执行，请等待完成后再更新编号' });
    }

    const item = taskService.createMailboxUpdateTask({
      addressIds: parsed.data.addressIds,
      stageIds: parsed.data.stageIds,
      createdBy: 'admin',
    });

    if (!item) {
      return reply.code(404).send({ message: '未找到可更新编号的地址' });
    }

    void taskExecutor?.enqueue(item.id);

    return reply.code(201).send({ item });
  });

  app.post('/api/admin/addresses/smarty-sync-tasks', async (request, reply) => {
    if (!requireAdmin(request, reply)) return reply;
    if (!taskService) {
      return reply.code(503).send({ message: '任务服务不可用' });
    }

    const parsed = smartySyncTaskSchema.safeParse(request.body ?? {});

    if (!parsed.success) {
      return reply.code(400).send({ message: '请选择需要同步 RDI/CMRA 的地址' });
    }

    if (taskService.hasRunningTask()) {
      return reply.code(409).send({ message: '已有任务正在执行，请等待完成后再同步 RDI/CMRA' });
    }

    const item = taskService.createSmartySyncTask({
      stageIds: parsed.data.stageIds,
      createdBy: 'admin',
    });

    if (!item) {
      return reply.code(404).send({ message: '未找到可同步 RDI/CMRA 的地址' });
    }

    void taskExecutor?.enqueue(item.id);

    return reply.code(201).send({ item });
  });

  app.post('/api/admin/addresses/smarty-refresh-all-task', async (request, reply) => {
    if (!requireAdmin(request, reply)) return reply;
    if (!taskService) {
      return reply.code(503).send({ message: '任务服务不可用' });
    }

    if (taskService.hasRunningTask()) {
      return reply.code(409).send({ message: '已有任务正在执行，请等待完成后再全量验证 RDI/CMRA' });
    }

    const item = taskService.createSmartyRefreshAllTask({
      createdBy: 'admin',
    });

    if (!item) {
      return reply.code(404).send({ message: '没有可重新验证的地址' });
    }

    void taskExecutor?.enqueue(item.id);

    return reply.code(201).send({ item });
  });

  app.get('/go/get-us-residential-address', async (_request, reply) => {
    reply.setCookie('atmb_referral_visited', '1', {
      httpOnly: true,
      maxAge: 60 * 60 * 24 * 30,
      path: '/',
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
    });

    return reply.redirect('https://anytimemailbox.referralrock.com/l/1RENHONGLIU21/');
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
