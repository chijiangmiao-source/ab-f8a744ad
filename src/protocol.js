// 精确整数文本 <-> BigInt。页面提交的系数与目标一律以十进制文本承载，
// 绝不经过 Number()/parseFloat，因此超过安全整数范围（±2^53-1）也不丢精度。

export const INTEGER_RE = /^[+-]?\d+$/;

export function parseIntegerText(text, where) {
  if (typeof text !== 'string') {
    throw new ValidationError(`${where} 必须是整数字符串`);
  }
  const t = text.trim();
  if (!INTEGER_RE.test(t)) {
    throw new ValidationError(`${where} 不是合法整数（仅接受可选正负号与十进制数字，不接受小数、指数或空值）：${preview(t)}`);
  }
  try {
    return BigInt(t);
  } catch {
    throw new ValidationError(`${where} 无法解析为整数：${preview(t)}`);
  }
}

function preview(t) {
  return t.length > 40 ? `${t.slice(0, 37)}...` : t;
}

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
    this.code = 'EVALIDATION';
  }
}

// 解析复核请求：
// { variables: string[], matrix: string[][], targets: string[] }
// 返回 { variables: string[], A: bigint[][], b: bigint[], raw }
export function parseReviewPayload(payload) {
  if (!payload || typeof payload !== 'object') throw new ValidationError('请求体必须是 JSON 对象');

  const variables = payload.variables;
  const matrix = payload.matrix;
  const targets = payload.targets;

  if (!Array.isArray(variables) || variables.length === 0) {
    throw new ValidationError('variables 必须是非空数组（变量标识）');
  }
  const n = variables.length;
  const names = [];
  const seen = new Set();
  for (let j = 0; j < n; j++) {
    const name = typeof variables[j] === 'string' ? variables[j].trim() : '';
    if (!name) throw new ValidationError(`第 ${j + 1} 个变量标识为空`);
    if (seen.has(name)) throw new ValidationError(`变量标识重复：${name}`);
    seen.add(name);
    names.push(name);
  }

  if (!Array.isArray(matrix) || matrix.length === 0) {
    throw new ValidationError('matrix 必须是非空二维数组（每行一条约束）');
  }
  const m = matrix.length;
  const A = [];
  for (let i = 0; i < m; i++) {
    const row = matrix[i];
    if (!Array.isArray(row)) throw new ValidationError(`第 ${i + 1} 行系数不是数组`);
    if (row.length !== n) {
      throw new ValidationError(`第 ${i + 1} 行有 ${row.length} 个系数，但变量有 ${n} 个`);
    }
    const brow = [];
    for (let j = 0; j < n; j++) {
      brow.push(parseIntegerText(row[j], `第 ${i + 1} 行第 ${j + 1} 列系数`));
    }
    A.push(brow);
  }

  if (!Array.isArray(targets)) throw new ValidationError('targets 必须是数组');
  if (targets.length !== m) {
    throw new ValidationError(`目标向量有 ${targets.length} 项，约束有 ${m} 行`);
  }
  const b = targets.map((t, i) => parseIntegerText(t, `第 ${i + 1} 条约束目标`));

  return { variables: names, A, b, m, n };
}

// 结构化结果 -> 线上 JSON。所有 BigInt 以十进制字符串输出，前端按文本渲染。
export function serializeResult(result, variables) {
  return {
    solvable: result.solvable,
    dimensions: { m: result.m, n: result.n, rank: result.rank },
    pivots: result.pivots.map(String),
    transformedTargets: result.c.map(String),
    unimodularRowTransform: result.U.map((row) => row.map(String)),
    diagonalForm: result.S.map((row) => row.map(String)),
    columnBasis: result.V.map((row) => row.map(String)),
    operations: result.operations,
    variables,
    solution: result.solution ? result.solution.map(String) : null,
    nullspace: result.nullspace ? result.nullspace.map((vec) => vec.map(String)) : null,
    obstructions: result.obstructions.map((o) => ({
      type: o.type,
      row: o.row,
      pivot: String(o.pivot),
      transformedTarget: String(o.transformedTarget),
      remainder: String(o.remainder),
      uRow: o.uRow.map(String),
      transformedCoefficients: o.uA.map(String),
    })),
    constraints: buildConstraints(result, variables),
  };
}

function buildConstraints(result, variables) {
  const { A, b, solution, m, n, solvable } = result;
  const rows = [];
  for (let i = 0; i < m; i++) {
    const terms = [];
    let sum = 0n;
    for (let j = 0; j < n; j++) {
      const coeff = A[i][j];
      const value = solvable ? solution[j] : null;
      const product = value === null ? null : coeff * value;
      if (product !== null) sum += product;
      terms.push({
        coefficient: String(coeff),
        variable: variables[j],
        value: value === null ? null : String(value),
        product: product === null ? null : String(product),
      });
    }
    rows.push({
      index: i,
      terms,
      leftSum: solvable ? String(sum) : null,
      target: String(b[i]),
      balanced: solvable ? sum === b[i] : null,
    });
  }
  return rows;
}
