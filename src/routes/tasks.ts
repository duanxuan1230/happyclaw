// 定时任务 was replaced by automations (/api/automations).

import { Hono } from 'hono';
import type { Variables } from '../web-context.js';

const tasksRoutes = new Hono<{ Variables: Variables }>();

tasksRoutes.all('*', (c) =>
  c.json({ error: '定时任务已改为自动化，请使用 /api/automations' }, 410),
);

export default tasksRoutes;
