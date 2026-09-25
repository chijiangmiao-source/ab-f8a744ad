// 复核任务生命周期管理。
// 关键点：计算在事件循环中分片让出（setImmediate），取消标志在每个分片边界检查；
// 任务结束时原子判定状态——已请求取消则绝不写入结论，前端亦按任务 id 隔离，
// 因此“发起大复核后立即改草稿/取消”时，迟到的旧结果不可能覆盖当前草稿。

import { randomUUID } from 'node:crypto';
import { solveDiophantine, CancellationError } from './diophantine.js';
import { serializeResult } from './protocol.js';

const TTL_MS = Number(process.env.REVIEW_TTL_MS || 10 * 60 * 1000);
const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [id, job] of reviews) {
    if (now - job.updatedAt > TTL_MS) reviews.delete(id);
  }
}, 60_000);
sweeper.unref?.();

export const reviews = new Map();

const yieldToLoop = () => new Promise((resolve) => setImmediate(resolve));

export function createReview(parsed) {
  const id = randomUUID();
  const job = {
    id,
    status: 'running', // running | solvable | unsolvable | cancelled | error
    cancelRequested: false,
    result: null,
    error: null,
    stage: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    variables: parsed.variables,
    dimensions: { m: parsed.m, n: parsed.n },
  };
  reviews.set(id, job);

  // 异步执行，不阻塞 HTTP 响应
  queueMicrotask(() => run(job, parsed));
  return id;
}

async function run(job, parsed) {
  try {
    const result = await solveDiophantine(parsed.A, parsed.b, {
      isCancelled: () => job.cancelRequested,
      yield: yieldToLoop,
      onStage: (s) => {
        job.stage = s;
      },
    });
    // 原子收口：取消优先，迟到的结果不得落盘为结论
    if (job.cancelRequested) {
      job.status = 'cancelled';
      job.updatedAt = Date.now();
      return;
    }
    job.result = serializeResult(result, parsed.variables);
    job.status = result.solvable ? 'solvable' : 'unsolvable';
  } catch (err) {
    if (err instanceof CancellationError || job.cancelRequested) {
      job.status = 'cancelled';
    } else {
      job.status = 'error';
      job.error = { code: err.code || 'EINTERNAL', message: err.message };
    }
  } finally {
    job.updatedAt = Date.now();
  }
}

// 返回 true：任务已进入/已处于取消；false：任务已有终态结论（调用方可忽略）
export function requestCancel(id) {
  const job = reviews.get(id);
  if (!job) return false;
  if (job.status === 'running') {
    job.cancelRequested = true;
    job.updatedAt = Date.now();
    return true;
  }
  return false;
}

export function getReview(id) {
  return reviews.get(id) || null;
}

export function publicStatus(job) {
  return {
    id: job.id,
    status: job.status,
    cancelRequested: job.cancelRequested,
    stage: job.stage,
    dimensions: job.dimensions,
    variables: job.variables,
    result: job.result,
    error: job.error,
  };
}
