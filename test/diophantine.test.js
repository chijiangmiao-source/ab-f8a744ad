// 核心算法测试：SNF 不变量、可解/不可解判定、任意精度、取消。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { egcd, smithNormalForm, solveDiophantine, CancellationError } from '../src/diophantine.js';
import { parseIntegerText, parseReviewPayload, ValidationError } from '../src/protocol.js';
import { createReview, requestCancel, getReview } from '../src/reviewManager.js';

const I = (x) => BigInt(x);

function matMul(A, B) {
  const m = A.length, k = B.length, n = B[0].length;
  const C = Array.from({ length: m }, () => new Array(n).fill(0n));
  for (let i = 0; i < m; i++)
    for (let t = 0; t < k; t++)
      for (let j = 0; j < n; j++) C[i][j] += A[i][t] * B[t][j];
  return C;
}
function matVec(A, x) {
  return A.map((row) => row.reduce((s, a, j) => s + a * x[j], 0n));
}
// Bareiss 无分数消元求行列式（BigInt）
function det(M) {
  const n = M.length;
  if (n === 0) return 1n;
  const A = M.map((r) => r.slice());
  let sign = 1n;
  let prev = 1n;
  for (let k = 0; k < n - 1; k++) {
    if (A[k][k] === 0n) {
      let r = k + 1;
      while (r < n && A[r][k] === 0n) r++;
      if (r === n) return 0n;
      [A[k], A[r]] = [A[r], A[k]];
      sign = -sign;
    }
    for (let i = k + 1; i < n; i++) {
      for (let j = k + 1; j < n; j++) {
        A[i][j] = (A[i][j] * A[k][k] - A[i][k] * A[k][j]) / prev;
      }
    }
    prev = A[k][k];
  }
  return sign * A[n - 1][n - 1];
}

async function checkSNFInvariants(A) {
  const { S, U, V, pivots, rank, m, n } = await smithNormalForm(A.map((r) => r.slice()));
  // U、V 幺模：行列式 ±1
  assert.ok(m === 0 || det(U) === 1n || det(U) === -1n, 'U 必须幺模');
  assert.ok(n === 0 || det(V) === 1n || det(V) === -1n, 'V 必须幺模');
  // S = U A V
  const recon = matMul(matMul(U, A), V);
  assert.deepEqual(recon, S, 'S 必须等于 U·A·V');
  // S 对角，对角之外全 0
  for (let i = 0; i < m; i++)
    for (let j = 0; j < n; j++)
      if (i !== j) assert.equal(S[i][j], 0n, '非对角元必须为 0');
  // 主元为正且依次整除
  for (let i = 0; i < rank; i++) assert.ok(pivots[i] > 0n, '主元必须为正');
  for (let i = 1; i < rank; i++) assert.equal(pivots[i] % pivots[i - 1], 0n, '主元必须依次整除');
  for (let i = rank; i < Math.min(m, n); i++) assert.equal(S[i][i], 0n);
  return { S, U, V, pivots, rank };
}

test('egcd 对大整数给出贝祖等式', () => {
  for (const [a, b] of [[240n, 46n], [-17n, 5n], [0n, 7n], [10000000000000000000000n, 3n]]) {
    const { g, u, v } = egcd(a, b);
    assert.equal(u * a + v * b, g);
    assert.ok(g >= 0n);
  }
});

test('多组矩阵的 Smith 正规形不变量', async () => {
  const cases = [
    [[2n, 1n, 1n], [1n, 2n, 2n], [3n, 3n, 3n]],
    [[6n, 10n, 0n], [15n, 31n, 0n], [0n, 0n, -7n]],
    [[1n, 1n, 1n], [1n, 1n, 1n]],
    [[12n, 6n], [4n, 2n]],
    [[1n]],
    [[0n, 0n], [0n, 0n]],
    [[2n, 4n, 6n]],
    [[-3n, 0n], [0n, 5n]],
  ];
  for (const A of cases) await checkSNFInvariants(A);
});

test('对角例：可解', async () => {
  const r = await solveDiophantine([[2n, 0n], [0n, 3n]], [4n, 9n]);
  assert.equal(r.solvable, true);
  assert.deepEqual(r.solution, [2n, 3n]);
});

test('对角例：主元不整除目标 => 无解且障碍正确', async () => {
  // diag(2,4) 已是 Smith 形（2|4）；目标首项为 1，2 不整除 1
  const r = await solveDiophantine([[2n, 0n], [0n, 4n]], [1n, 0n]);
  assert.equal(r.solvable, false);
  assert.equal(r.obstructions.length, 1);
  const o = r.obstructions[0];
  assert.equal(o.type, 'divisibility');
  assert.equal(o.pivot, 2n);
  assert.equal(o.transformedTarget, 1n);
  assert.equal(o.remainder, 1n);
});

test('矛盾约束：零系数行对应非零目标', async () => {
  const r = await solveDiophantine([[1n, 1n], [1n, 1n]], [1n, 2n]);
  assert.equal(r.solvable, false);
  assert.ok(r.obstructions.some((o) => o.type === 'zero-row' && o.transformedTarget !== 0n));
});

test('本题型不可整除例：u·A 各系数均被 d 整除而 u·b 余 r≠0（独立复核证据）', async () => {
  const A = [[2n, 1n, 1n], [1n, 2n, 2n], [3n, 3n, 3n]];
  const b = [4n, 10n, 14n];
  const r = await solveDiophantine(A, b);
  assert.equal(r.solvable, false);
  assert.ok(r.obstructions.length >= 1);
  for (const o of r.obstructions) {
    // c = U·b
    const c = o.uRow.reduce((s, u, i) => s + u * b[i], 0n);
    assert.equal(c, o.transformedTarget);
    if (o.type === 'divisibility') {
      const d = o.pivot;
      assert.ok(d > 0n);
      // u·A 的每个分量必须被 d 整除（因为变换后该行等于 d·e_i·V^{-1}）
      for (const coeff of o.uA) assert.equal(coeff % d, 0n);
      // 余数规范且非零
      assert.ok(o.remainder > 0n && o.remainder < d);
      assert.equal(((o.transformedTarget % d) + d) % d, o.remainder);
    }
  }
});

test('欠定方程组：给出特解且 A·x = b，齐次基大小 = n-rank', async () => {
  const r = await solveDiophantine([[1n, 1n, 1n]], [5n]);
  assert.equal(r.solvable, true);
  assert.deepEqual(matVec([[1n, 1n, 1n]], r.solution), [5n]);
  assert.equal(r.nullspace.length, 2);
  // 齐次基每条都被 A 零化
  for (const v of r.nullspace) assert.deepEqual(matVec([[1n, 1n, 1n]], v), [0n]);
});

test('任意精度：远超安全整数范围仍精确求解并保持文本', async () => {
  const B10 = (e) => 10n ** BigInt(e);
  const A = [[B10(40) + 1n, 1n], [1n, B10(40) + 3n]];
  const x0 = [B10(30), -(B10(30)) + 7n];
  const b = matVec(A, x0);
  const r = await solveDiophantine(A, b);
  assert.equal(r.solvable, true);
  assert.deepEqual(matVec(A, r.solution), b);
  // 序列化文本保留全部数位
  const text = r.solution.map(String);
  assert.ok(text[0].length > 30);
  assert.equal(text[0], B10(30).toString());
  // 输入解析不经浮点数；对照证明 Number 路径会把 2^53+1 舍入成 2^53
  assert.equal(parseIntegerText('9007199254740993'), 9007199254740993n);
  assert.equal(Number('9007199254740993'), 9007199254740992);
});

test('非法整数文本被拒绝（指数/小数/空值）', () => {
  for (const bad of ['1e3', '1.5', 'NaN', '', '  ', '0x10', '1_000']) {
    assert.throws(() => parseIntegerText(bad, 'x'), ValidationError);
  }
});

test('载荷维度校验', () => {
  assert.throws(
    () => parseReviewPayload({ variables: ['a'], matrix: [[1n, 2n]], targets: ['0'] }),
    ValidationError
  );
  const p = parseReviewPayload({ variables: ['a', 'b'], matrix: [['1', '2']], targets: ['-3'] });
  assert.deepEqual(p.A, [[1n, 2n]]);
  assert.deepEqual(p.b, [-3n]);
});

test('预置取消标志时计算抛出 CancellationError', async () => {
  await assert.rejects(
    () => solveDiophantine([[1n]], [1n], { isCancelled: () => true }),
    (e) => e instanceof CancellationError
  );
});

test('任务管理器：发起后立即取消，结论必须为 cancelled 且 result 为 null', async () => {
  // 稠密大矩阵制造耗时；首个让出点之前取消标志也会被检查
  const N = 56;
  const A = Array.from({ length: N }, (_, i) =>
    Array.from({ length: N }, (_, j) => BigInt((i + 1) * (j + 2)) + 10n ** 40n));
  const b = Array.from({ length: N }, (_, i) => BigInt(i + 1));
  const id = createReview({ variables: Array.from({ length: N }, (_, i) => `v${i}`), A, b, m: N, n: N });
  requestCancel(id);
  const job = getReview(id);
  // 等待终态
  for (let i = 0; i < 200 && job.status === 'running'; i++) {
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(job.status, 'cancelled');
  assert.equal(job.result, null);
});
