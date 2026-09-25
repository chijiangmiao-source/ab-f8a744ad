// 一次性验收（执行后退出，以退出码报告）：
//   阶段 1：针对不可整除约束直接调用求解器，确认无解与规范除尽障碍证据；
//   阶段 2：代码测试（node --test）；
//   阶段 3：构建检查（语法 + 模块加载）；
//   阶段 4：HTTP 冒烟——健康路径 + 本题复核接口（可解例 / 不可整除例 / 大整数例 / 取消）。
// 环境变量：BASE_URL 指向待验收服务（Compose 中为 http://web:3000）。
import { spawn } from 'node:child_process';
import { solveDiophantine } from '../src/diophantine.js';

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:3000';
const failures = [];
const steps = [];

function step(name, fn) {
  steps.push({ name, fn });
}
function ok(msg) {
  console.log(`  ✓ ${msg}`);
}
function fail(msg) {
  failures.push(msg);
  console.error(`  ✗ ${msg}`);
}
function section(title) {
  console.log(`\n=== ${title} ===`);
}

function runCmd(cmd, args) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: 'inherit' });
    p.on('exit', (code) => resolve(code));
  });
}

async function httpJson(path, options = {}, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(new URL(path, BASE_URL), { ...options, signal: ctrl.signal });
    const text = await resp.text();
    let body = null;
    try { body = JSON.parse(text); } catch { body = text; }
    return { status: resp.status, body };
  } finally {
    clearTimeout(timer);
  }
}

async function waitForReview(id, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { status, body } = await httpJson(`/api/reviews/${id}`);
    if (status !== 200) throw new Error(`轮询任务返回 HTTP ${status}`);
    if (body.status !== 'running') return body;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('复核任务轮询超时');
}

// ---------- 阶段 1：不可整除约束的无解证据 ----------
step('不可整除约束：确认无解并给出规范除尽障碍', async () => {
  const A = [[2n, 1n, 1n], [1n, 2n, 2n], [3n, 3n, 3n]];
  const b = [4n, 10n, 14n];
  const r = await solveDiophantine(A, b);
  if (r.solvable) return fail('预期无解，但求解器报告有解');
  if (r.obstructions.length === 0) return fail('报告无解但未给出障碍证据');

  for (const o of r.obstructions) {
    // 证据可独立复核：c = u·b
    const c = o.uRow.reduce((s, u, i) => s + u * b[i], 0n);
    if (c !== o.transformedTarget) return fail(`证据 c≠u·b（${c} vs ${o.transformedTarget}）`);
    if (o.type === 'divisibility') {
      const d = o.pivot;
      if (d <= 0n) return fail('主元非正');
      if (o.uA.some((v) => v % d !== 0n)) return fail('u·A 存在不被主元整除的分量（证据不成立）');
      if (c % d === 0n) return fail('主元竟然整除变换后目标，矛盾结论错误');
      if (!(o.remainder > 0n && o.remainder < d)) return fail('规范余数越界');
      ok(`主元 d=${d} 不整除 c=${c}，规范余数 r=${o.remainder}（可逆行组合 u=[${o.uRow.join(',')}]）`);
    } else if (o.type === 'zero-row') {
      if (o.uA.some((v) => v !== 0n) || c === 0n) return fail('零行障碍证据不成立');
      ok(`零系数行对应非零目标 c=${c}`);
    }
  }
});

// ---------- 阶段 2：代码测试 ----------
step('代码测试（node --test）', async () => {
  const code = await runCmd(process.execPath, ['--test']);
  if (code !== 0) fail(`测试失败（退出码 ${code}）`);
});

// ---------- 阶段 3：构建检查 ----------
step('构建检查（语法 + 模块加载）', async () => {
  const code = await runCmd(process.execPath, ['scripts/build-check.js']);
  if (code !== 0) fail(`构建检查失败（退出码 ${code}）`);
});

// ---------- 阶段 4：HTTP 冒烟 ----------
step('HTTP 冒烟：健康路径 /healthz', async () => {
  const { status, body } = await httpJson('/healthz');
  if (status !== 200 || body.status !== 'ok') return fail(`健康路径异常：HTTP ${status}`);
  ok(`服务存活 ${BASE_URL}（uptime=${Math.round(body.uptime)}s）`);

  const home = await fetch(new URL('/', BASE_URL));
  if (home.status !== 200) return fail(`首页 HTTP ${home.status}`);
  const html = await home.text();
  if (!html.includes('垫片整数校正量复核')) return fail('首页内容不符');
  ok('首页可访问且内容正确');
});

step('HTTP 冒烟：可解复核返回精确整数校正量且每条约束平衡', async () => {
  const payload = {
    variables: ['shim_A', 'shim_B', 'shim_C'],
    matrix: [['2', '1', '-1'], ['1', '-3', '2'], ['3', '-2', '1']],
    targets: ['3', '5', '8'],
  };
  const created = await httpJson('/api/reviews', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (created.status !== 202 || !created.body.id) return fail(`发起复核失败：${created.status}`);
  const job = await waitForReview(created.body.id);
  if (job.status !== 'solvable') return fail(`预期 solvable，实际 ${job.status}`);
  const r = job.result;
  // 精确回代核验（用 BigInt 复核 HTTP 返回的文本）
  for (const row of r.constraints) {
    const s = row.terms.reduce((acc, t) => acc + BigInt(t.coefficient) * BigInt(t.value), 0n);
    if (s !== BigInt(row.target)) return fail(`约束 ${row.index + 1} 左侧和 ${s} ≠ 目标 ${row.target}`);
  }
  ok(`校正量 [${r.solution.join(', ')}]，全部 ${r.constraints.length} 条约束精确平衡`);
});

step('HTTP 冒烟：不可整除例返回无解与除尽障碍字段', async () => {
  const payload = {
    variables: ['shim_A', 'shim_B', 'shim_C'],
    matrix: [['2', '1', '1'], ['1', '2', '2'], ['3', '3', '3']],
    targets: ['4', '10', '14'],
  };
  const created = await httpJson('/api/reviews', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const job = await waitForReview(created.body.id);
  if (job.status !== 'unsolvable') return fail(`预期 unsolvable，实际 ${job.status}`);
  const o = job.result.obstructions[0];
  if (!o || (o.type !== 'divisibility' && o.type !== 'zero-row')) return fail('缺少障碍证据');
  if (!/^-?\d+$/.test(o.transformedTarget) || !/^-?\d+$/.test(o.pivot)) {
    return fail('障碍字段不是精确整数文本');
  }
  ok(`无解证据完整：类型=${o.type}，主元=${o.pivot}，变换后目标=${o.transformedTarget}，余数=${o.remainder}`);
});

step('HTTP 冒烟：超过安全整数范围的系数以精确文本呈现并正确求解', async () => {
  const huge = '1234567890123456789012345678901234567890'; // 40 位，远超 2^53
  // 由整数解 x0 = [2, -3] 反造目标，保证精确可解
  const x0 = [2n, -3n];
  const A = [[BigInt(huge), 1n], [0n, BigInt(huge)]];
  const b = A.map((row) => row[0] * x0[0] + row[1] * x0[1]);
  const payload = {
    variables: ['shim_X', 'shim_Y'],
    matrix: [[huge, '1'], ['0', huge]],
    targets: [b[0].toString(), b[1].toString()],
  };
  const created = await httpJson('/api/reviews', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const job = await waitForReview(created.body.id);
  if (job.status !== 'solvable') return fail(`大整数例预期 solvable，实际 ${job.status}（${JSON.stringify(job.error)}）`);
  if (job.result.solution[0] !== '2' || job.result.solution[1] !== '-3') {
    return fail(`大整数解不精确：${JSON.stringify(job.result.solution)}`);
  }
  // 返回的大系数必须是与输入逐位相同的文本
  const coeffText = job.result.constraints[0].terms[0].coefficient;
  if (coeffText !== huge) return fail(`大系数字符串失真：${coeffText}`);
  // 左侧和（含 40+ 位数字）必须逐位等于目标文本
  if (job.result.constraints[0].leftSum !== b[0].toString()) return fail('大整数左侧和失真');
  ok(`40 位系数逐位保留，校正量 [${job.result.solution.join(', ')}]，左侧和精确相等`);
});

step('HTTP 冒烟：非法输入（指数记法）被 400 拒绝', async () => {
  const payload = { variables: ['a'], matrix: [['1e3']], targets: ['0'] };
  const { status } = await httpJson('/api/reviews', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (status !== 400) return fail(`预期 400，实际 ${status}`);
  ok('拒绝了浮点/指数形式输入');
});

// ---------- 执行 ----------
(async () => {
  console.log(`验收目标: ${BASE_URL}`);
  for (let i = 0; i < steps.length; i++) {
    const { name, fn } = steps[i];
    section(`阶段 ${i + 1}/${steps.length}：${name}`);
    try {
      await fn();
    } catch (err) {
      fail(`${name} 抛出异常：${err.stack || err.message}`);
    }
  }

  section('验收结论');
  if (failures.length === 0) {
    console.log(`全部 ${steps.length} 个验收阶段通过。`);
    process.exit(0);
  }
  console.error(`${failures.length} 项验收失败：`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
})();
