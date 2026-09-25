// 任意精度丢番图方程组判定核心
// 对 A x = b（A 为 m×n 整数矩阵，b 为 m 维整数向量）：
//   1. 用扩展欧几里得算法构造 Smith 正规形 S = U A V（U、V 为幺模整数矩阵，det = ±1）；
//   2. 令 c = U b，则原方程组等价于 S y = c（x = V y）；
//   3. S 为对角矩阵 diag(d1,...,dr,0,...)，且 d1|d2|...|dr：
//      - 对每个主元 dk，必须有 dk | c_k，否则无解（规范除尽障碍）；
//      - 主元为 0 的行必须有 c_k = 0，否则无解（0·x = 非零）；
//   4. 有解时给出一组整数特解 x = V y（y_k = c_k/d_k，自由变量取 0），
//      齐次解空间由 V 的自由列给出。
// 全程使用 BigInt，不经过浮点数，商仅在确实整除时进行。

export class CancellationError extends Error {
  constructor() {
    super('复核已取消');
    this.name = 'CancellationError';
    this.code = 'ECANCELLED';
  }
}

const abs = (x) => (x < 0n ? -x : x);
const isBigInt = (x) => typeof x === 'bigint';

// 扩展欧几里得：返回 { g, u, v }，g > 0 且 u*a + v*b = g
export function egcd(a, b) {
  if (!isBigInt(a) || !isBigInt(b)) throw new TypeError('egcd 输入必须为 BigInt');
  const sa = a < 0n ? -1n : 1n;
  const sb = b < 0n ? -1n : 1n;
  let oldR = a < 0n ? -a : a;
  let r = b < 0n ? -b : b;
  let oldS = 1n;
  let s = 0n;
  let oldT = 0n;
  let t = 1n;
  while (r !== 0n) {
    const q = oldR / r; // 非负整数之间的截断除法即精确商
    [oldR, r] = [r, oldR - q * r];
    [oldS, s] = [s, oldS - q * s];
    [oldT, t] = [t, oldT - q * t];
  }
  // oldR=0 的情形（两数皆 0）在本算法调用点不会出现；这里保持 g>=0
  return { g: oldR, u: oldS * sa, v: oldT * sb };
}

function identity(size) {
  const m = new Array(size);
  for (let i = 0; i < size; i++) {
    m[i] = new Array(size).fill(0n);
    m[i][i] = 1n;
  }
  return m;
}

function cloneMatrix(A) {
  return A.map((row) => row.slice());
}

function swapRows(M, a, b) {
  const t = M[a];
  M[a] = M[b];
  M[b] = t;
}

function swapCols(M, a, b) {
  for (let i = 0; i < M.length; i++) {
    const t = M[i][a];
    M[i][a] = M[i][b];
    M[i][b] = t;
  }
}

function matmul(A, B) {
  const m = A.length;
  const k = B.length;
  const n = k === 0 ? 0 : B[0].length;
  const C = Array.from({ length: m }, () => new Array(n).fill(0n));
  for (let i = 0; i < m; i++) {
    for (let t = 0; t < k; t++) {
      const aik = A[i][t];
      if (aik === 0n) continue;
      for (let j = 0; j < n; j++) C[i][j] += aik * B[t][j];
    }
  }
  return C;
}

function matvec(A, x) {
  const m = A.length;
  const n = x.length;
  const y = new Array(m).fill(0n);
  for (let i = 0; i < m; i++) {
    let s = 0n;
    for (let j = 0; j < n; j++) s += A[i][j] * x[j];
    y[i] = s;
  }
  return y;
}

// 计算 Smith 正规形。
// hooks: { isCancelled?: () => boolean, yield?: () => Promise<void>, onStage?: (info)=>void }
// 返回 { S, U, V, pivots: BigInt[], rank, m, n, operations }
export async function smithNormalForm(Ain, hooks = {}) {
  const isCancelled = hooks.isCancelled || null;
  const yieldToLoop = hooks.yield || null;
  const onStage = hooks.onStage || null;
  let opsBudget = 0;
  const maybeYield = async (force = false) => {
    if (isCancelled && isCancelled()) throw new CancellationError();
    if (yieldToLoop && (force || ++opsBudget >= 2048)) {
      opsBudget = 0;
      await yieldToLoop();
      if (isCancelled && isCancelled()) throw new CancellationError();
    }
  };

  const m = Ain.length;
  const n = m === 0 ? 0 : Ain[0].length;
  const S = cloneMatrix(Ain);
  const U = identity(m);
  const V = identity(n);
  const operations = [];

  let k = 0;
  const limit = Math.min(m, n);
  while (k < limit) {
    await maybeYield(true);
    if (onStage) onStage({ stage: k + 1, total: limit });

    // 1. 在右下角子矩阵中选取【绝对值最小】的非零元作为主元，经行/列交换移到 (k,k)。
    //    最小主元策略是抑制朴素 Smith 算法中间系数膨胀的标准手段，
    //    也使后续 gcd 下降链具有接近欧几里得算法的步数。
    let pi = -1;
    let pj = -1;
    let pAbs = 0n;
    for (let i = k; i < m; i++) {
      for (let j = k; j < n; j++) {
        const v = S[i][j];
        if (v === 0n) continue;
        const a = v < 0n ? -v : v;
        if (pi === -1 || a < pAbs) {
          pi = i;
          pj = j;
          pAbs = a;
        }
      }
    }
    if (pi === -1) break; // 子矩阵全零，秩为 k

    if (pi !== k) {
      swapRows(S, k, pi);
      swapRows(U, k, pi);
      operations.push({ type: 'row-swap', a: k, b: pi });
    }
    if (pj !== k) {
      swapCols(S, k, pj);
      swapCols(V, k, pj);
      operations.push({ type: 'col-swap', a: k, b: pj });
    }

    // 2. 消去主元列下方 / 主元行右方元素。
    //    - 若当前主元 p 整除该元素：使用平凡 Bezout 系数（u=sign(p), v=0），
    //      只对主元行/列变号即可把该元素清零，不向另一方向引入非零；
    //    - 若不整除：扩展欧几里得给出新主元 g=gcd(p,x)，|g|<|p|，主元严格变小，
    //      整轮重来（自然数严格递减保证终止）。
    let reduced = true;
    while (reduced) {
      reduced = false;

      // 主元列（行变换，同步作用于 U）
      for (let i = k + 1; i < m; i++) {
        const x = S[i][k];
        if (x === 0n) continue;
        const p = S[k][k];
        let u, v, g;
        if (x % p === 0n) {
          g = p < 0n ? -p : p;
          u = p < 0n ? -1n : 1n;
          v = 0n;
        } else {
          ({ g, u, v } = egcd(p, x));
        }
        const rk = S[k].slice();
        const ri = S[i].slice();
        const xg = x / g;
        const pg = p / g; // g|p、g|x 保证精确
        for (let j = 0; j < n; j++) {
          S[k][j] = u * rk[j] + v * ri[j];
          S[i][j] = -xg * rk[j] + pg * ri[j];
        }
        const uk = U[k].slice();
        const ui = U[i].slice();
        for (let j = 0; j < m; j++) {
          U[k][j] = u * uk[j] + v * ui[j];
          U[i][j] = -xg * uk[j] + pg * ui[j];
        }
        operations.push({ type: 'row-combine', a: k, b: i, u: u.toString(), v: v.toString() });
        await maybeYield();
        if (g < abs(p)) {
          reduced = true; // 主元严格变小，整轮重来
          break;
        }
      }
      if (reduced) continue;

      // 主元行（列变换，同步作用于 V）
      for (let j = k + 1; j < n; j++) {
        const x = S[k][j];
        if (x === 0n) continue;
        const p = S[k][k];
        let u, v, g;
        if (x % p === 0n) {
          g = p < 0n ? -p : p;
          u = p < 0n ? -1n : 1n;
          v = 0n;
        } else {
          ({ g, u, v } = egcd(p, x));
        }
        const ck = new Array(m);
        const cj = new Array(m);
        for (let r = 0; r < m; r++) {
          ck[r] = S[r][k];
          cj[r] = S[r][j];
        }
        const vk = new Array(n);
        const vj = new Array(n);
        for (let r = 0; r < n; r++) {
          vk[r] = V[r][k];
          vj[r] = V[r][j];
        }
        const xg = x / g;
        const pg = p / g;
        for (let r = 0; r < m; r++) {
          S[r][k] = u * ck[r] + v * cj[r];
          S[r][j] = -xg * ck[r] + pg * cj[r];
        }
        for (let r = 0; r < n; r++) {
          V[r][k] = u * vk[r] + v * vj[r];
          V[r][j] = -xg * vk[r] + pg * vj[r];
        }
        operations.push({ type: 'col-combine', a: k, b: j, u: u.toString(), v: v.toString() });
        await maybeYield();
        if (abs(g) < abs(p)) {
          reduced = true;
          break;
        }
      }
      if (reduced) continue;

      // 3. 主元行/列已清零，但若主元不能整除右下角子矩阵某元素，
      //    用幺模列变换 (Ck,Cj) <- (Ck+Cj, Ck)（行列式 -1）把该元素
      //    引入主元列下沿，下一轮 gcd 必使主元严格变小。
      const p = S[k][k];
      repair: for (let i = k + 1; i < m; i++) {
        for (let j = k + 1; j < n; j++) {
          if (S[i][j] % p !== 0n) {
            const ck = new Array(m);
            const cj = new Array(m);
            for (let r = 0; r < m; r++) {
              ck[r] = S[r][k];
              cj[r] = S[r][j];
            }
            const vk = new Array(n);
            const vj = new Array(n);
            for (let r = 0; r < n; r++) {
              vk[r] = V[r][k];
              vj[r] = V[r][j];
            }
            for (let r = 0; r < m; r++) {
              S[r][k] = ck[r] + cj[r];
              S[r][j] = ck[r];
            }
            for (let r = 0; r < n; r++) {
              V[r][k] = vk[r] + vj[r];
              V[r][j] = vk[r];
            }
            operations.push({ type: 'col-repair', a: k, b: j });
            reduced = true;
            await maybeYield();
            break repair;
          }
        }
      }
    }

    // 4. 规范主元符号为正（行乘 -1，仍为可逆整数行变换）
    if (S[k][k] < 0n) {
      for (let j = 0; j < n; j++) S[k][j] = -S[k][j];
      for (let j = 0; j < m; j++) U[k][j] = -U[k][j];
      operations.push({ type: 'row-sign', a: k });
    }
    k++;
  }

  const rank = k;
  const pivots = [];
  for (let i = 0;i< rank; i++) pivots.push(S[i][i]);
  return { S, U, V, pivots, rank, m, n, operations };
}

// 判定 A x = b 的整数可解性并构造证据与特解。
export async function solveDiophantine(Ain, bin, hooks = {}) {
  const A = cloneMatrix(Ain);
  const b = bin.slice();
  const { S, U, V, pivots, rank, m, n, operations } = await smithNormalForm(A, hooks);
  const c = matvec(U, b);

  const obstructions = [];

  // 主元行：d_k 必须整除变换后的目标 c_k
  for (let i = 0; i < rank; i++) {
    const d = pivots[i];
    if (c[i] % d !== 0n) {
      const uRow = U[i];
      const uA = new Array(n).fill(0n);
      for (let t = 0; t < m; t++) {
        const coeff = uRow[t];
        if (coeff === 0n) continue;
        for (let j = 0; j < n; j++) uA[j] += coeff * A[t][j];
      }
      // 余数按非负规范给出（0 <= r < d）
      let r = c[i] % d;
      if (r < 0n) r += d;
      obstructions.push({
        type: 'divisibility',
        row: i,
        pivot: d,
        transformedTarget: c[i],
        remainder: r,
        uRow,
        uA,
      });
    }
  }
  // 零主元行：0·x 必须等于 0
  for (let i = rank; i < m; i++) {
    if (c[i] !== 0n) {
      const uRow = U[i];
      const uA = new Array(n).fill(0n);
      for (let t = 0; t < m; t++) {
        const coeff = uRow[t];
        if (coeff === 0n) continue;
        for (let j = 0; j < n; j++) uA[j] += coeff * A[t][j];
      }
      obstructions.push({
        type: 'zero-row',
        row: i,
        pivot: 0n,
        transformedTarget: c[i],
        remainder: c[i],
        uRow,
        uA,
      });
    }
  }

  const solvable = obstructions.length === 0;
  let solution = null;
  let nullspace = null;

  if (solvable) {
    // y_k = c_k/d_k，自由变量取 0；x = V y
    const y = new Array(n).fill(0n);
    for (let i = 0; i < rank; i++) y[i] = c[i] / pivots[i];
    solution = matvec(V, y);

    // 齐次解基：V 中对应自由变量 y_{rank..n-1} 的列
    nullspace = [];
    for (let j = rank; j < n; j++) {
      const vec = new Array(n);
      for (let i = 0; i < n; i++) vec[i] = V[i][j];
      nullspace.push(vec);
    }
  }

  return {
    solvable,
    A,
    b,
    S,
    U,
    V,
    c,
    pivots,
    rank,
    m,
    n,
    operations,
    obstructions,
    solution,
    nullspace,
  };
}

// 用解回代核验每条原始约束：各项乘积、左侧和、是否等于目标
export function verifyConstraints(result) {
  const { A, b, solution, variables, n, m } = result;
  const rows = [];
  for (let i = 0; i < m; i++) {
    const terms = [];
    let sum = 0n;
    for (let j = 0; j < n; j++) {
      const coeff = A[i][j];
      const value = solvableOrNull(result) ? solution[j] : null;
      const product = value === null ? null : coeff * value;
      if (product !== null) sum += product;
      terms.push({
        coefficient: coeff,
        variable: variables ? variables[j] : `x${j + 1}`,
        value,
        product,
      });
    }
    rows.push({ index: i, terms, sum, target: b[i], balanced: sum === b[i] });
  }
  return rows;
}

function solvableOrNull(result) {
  return result.solvable && result.solution;
}

export const _internal = { matmul, matvec, identity, cloneMatrix };
