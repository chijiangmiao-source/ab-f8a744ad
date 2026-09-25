// 前端逻辑。
// 状态隔离原则：
//   draft（表格中正在编辑的内容）与 review（在途/已完成复核）完全分离——
//   任何复核返回都不会回写输入框；轮询按任务 id 校验，被取代或已取消的任务
//   迟到返回时只进入“已忽略”提示，绝不覆盖当前草稿状态或当前结论。

const $ = (sel) => document.querySelector(sel);

const state = {
  variables: ['shim_A', 'shim_B', 'shim_C'],
  matrix: [
    ['2', '1', '-1'],
    ['1', '-3', '2'],
  ],
  targets: ['3', '5'],
  currentJobId: null,
  running: false,
  currentJobToken: 0,      // 每次发起复核自增，旧任务返回靠它识别
  pollTimer: null,
  selectedConstraint: 0,
  lastResult: null,       // 当前展示的结论（仅属于 currentJobId）
  ignored: [],            // 迟到返回的旧任务记录
};

const EXAMPLES = {
  solvable: {
    variables: ['shim_A', 'shim_B', 'shim_C'],
    matrix: [['2', '1', '-1'], ['1', '-3', '2'], ['3', '-2', '1']],
    targets: ['3', '5', '8'],
  },
  obstruct: {
    // 前两行蕴含 3 | 14 的矛盾：第三行 = 行1+行2 时目标须被 3 整除
    variables: ['shim_A', 'shim_B', 'shim_C'],
    matrix: [['2', '1', '1'], ['1', '2', '2'], ['3', '3', '3']],
    targets: ['4', '10', '14'],
  },
  bigint: {
    variables: ['shim_X', 'shim_Y'],
    matrix: [
      ['1234567890123456789012345678901234567890', '9876543210987654321098765432109876543210'],
      ['9876543210987654321098765432109876543210', '-1234567890123456789012345678901234567890'],
    ],
    targets: ['3', '7'],
  },
};

// ---------- 草稿渲染 ----------
function renderTable() {
  const head = $('#matrix-head');
  const body = $('#matrix-body');
  head.innerHTML = '';
  body.innerHTML = '';

  const thIdx = document.createElement('th');
  thIdx.textContent = '#';
  head.appendChild(thIdx);
  state.variables.forEach((v) => {
    const th = document.createElement('th');
    th.textContent = v;
    head.appendChild(th);
  });
  const thTgt = document.createElement('th');
  thTgt.textContent = '目标 b';
  head.appendChild(thTgt);
  const thAct = document.createElement('th');
  thAct.textContent = '';
  head.appendChild(thAct);

  state.matrix.forEach((row, i) => {
    const tr = document.createElement('tr');
    const tdIdx = document.createElement('td');
    tdIdx.className = 'rowidx';
    tdIdx.textContent = i + 1;
    tr.appendChild(tdIdx);

    row.forEach((val, j) => {
      const td = document.createElement('td');
      const input = document.createElement('input');
      input.type = 'text';
      input.value = val;
      input.setAttribute('aria-label', `第 ${i + 1} 行变量 ${state.variables[j]} 的系数`);
      input.addEventListener('input', () => {
        state.matrix[i][j] = input.value;
        markDraftDirty();
      });
      td.appendChild(input);
      tr.appendChild(td);
    });

    const tdT = document.createElement('td');
    const tinput = document.createElement('input');
    tinput.type = 'text';
    tinput.value = state.targets[i];
    tinput.setAttribute('aria-label', `第 ${i + 1} 行目标值`);
    tinput.addEventListener('input', () => {
      state.targets[i] = tinput.value;
      markDraftDirty();
    });
    tdT.appendChild(tinput);
    tr.appendChild(tdT);

    const tdAct = document.createElement('td');
    tdAct.className = 'row-actions';
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'btn btn-ghost btn-sm';
    del.textContent = '删除';
    del.addEventListener('click', () => {
      state.matrix.splice(i, 1);
      state.targets.splice(i, 1);
      renderTable();
      markDraftDirty();
    });
    tdAct.appendChild(del);
    tr.appendChild(tdAct);
    body.appendChild(tr);
  });
}

function syncVariables() {
  const raw = $('#variables-input').value;
  const names = raw.split(/[\s,，、;；]+/).map((s) => s.trim()).filter(Boolean);
  if (names.length === 0) return null;
  const seen = new Set();
  for (const nm of names) {
    if (seen.has(nm)) return { error: `变量标识重复：${nm}` };
    seen.add(nm);
  }
  const oldN = state.variables.length;
  const newN = names.length;
  state.variables = names;
  if (newN !== oldN) {
    state.matrix = state.matrix.map((row) => {
      const next = new Array(newN).fill('0');
      for (let j = 0; j < Math.min(oldN, newN); j++) next[j] = row[j] ?? '0';
      return next;
    });
  }
  renderTable();
  return { ok: true };
}

function markDraftDirty() {
  // 草稿被编辑：与任何在途/已展示结论脱钩，但不清除结论面板，
  // 仅给出醒目标识；旧任务返回时由 token 判定为“已忽略”。
  const hadRunningJob = state.running;
  const detachedId = state.currentJobId;
  state.currentJobToken++;
  stopPolling();
  state.currentJobId = null;
  state.running = false;
  if (hadRunningJob && detachedId) {
    // 尽力通知服务端停止计算（不 await，不影响编辑）；结论保护以本地令牌为准
    fetch(`/api/reviews/${detachedId}/cancel`, { method: 'POST' }).catch(() => {});
    setButtonsRunning(false);
    showDraftFlag('草稿已修改：在途复核已与当前草稿脱钩（其迟到返回将被忽略），可直接重新发起');
  } else if (state.lastResult) {
    showDraftFlag('草稿已修改：以下结论对应修改前的草稿，仅供参照');
  }
}

function showDraftFlag(text) {
  const el = $('#draft-flag');
  el.textContent = text;
  el.hidden = false;
}
function clearDraftFlag() {
  $('#draft-flag').hidden = true;
}

// ---------- 复核发起 / 轮询 / 取消 ----------
async function submitReview() {
  const synced = syncVariables();
  if (synced && synced.error) return showFormError(synced.error);
  const payload = { variables: state.variables, matrix: state.matrix, targets: state.targets };

  setButtonsRunning(true);
  hideFormError();
  clearDraftFlag();
  $('#detail-card').hidden = true;

  try {
    const resp = await fetch('/api/reviews', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error?.message || `HTTP ${resp.status}`);

    state.currentJobId = data.id;
    state.currentJobToken++;
    state.running = true;
    const myToken = state.currentJobToken;
    state.lastResult = null;
    renderRunning(data.id);
    startPolling(data.id, myToken);
  } catch (err) {
    setButtonsRunning(false);
    showFormError(err.message);
  }
}

function startPolling(id, token) {
  stopPolling();
  const tick = async () => {
    try {
      const resp = await fetch(`/api/reviews/${id}`, { cache: 'no-store' });
      const job = await resp.json();
      // 关键守卫：只接受当前 token 的任务返回
      if (token !== state.currentJobToken || id !== state.currentJobId) {
        state.ignored.push({ id, at: new Date().toLocaleTimeString(), reason: '任务已被草稿编辑或新复核取代' });
        renderIgnored();
        return;
      }
      if (job.status === 'running') {
        renderRunning(id, job.stage);
        state.pollTimer = setTimeout(tick, 200);
        return;
      }
      state.running = false;
      if (job.status === 'cancelled') {
        renderCancelled(id);
        setButtonsRunning(false);
        return;
      }
      if (job.status === 'error') {
        renderError(job.error);
        setButtonsRunning(false);
        return;
      }
      state.lastResult = { id, result: job.result };
      state.selectedConstraint = 0;
      renderConclusion(id, job.result);
      setButtonsRunning(false);
    } catch {
      state.pollTimer = setTimeout(tick, 500);
    }
  };
  state.pollTimer = setTimeout(tick, 150);
}

function stopPolling() {
  if (state.pollTimer) {
    clearTimeout(state.pollTimer);
    state.pollTimer = null;
  }
}

async function cancelReview() {
  const id = state.currentJobId;
  if (!id) return;
  state.currentJobToken++; // 立即让任何迟到返回失效
  state.running = false;
  stopPolling();
  $('#cancel-btn').disabled = true;
  renderCancelling(id);
  try {
    await fetch(`/api/reviews/${id}/cancel`, { method: 'POST' });
  } catch { /* 状态以本地取消为准 */ }
  renderCancelled(id);
  setButtonsRunning(false);
}

function setButtonsRunning(running) {
  $('#submit-btn').disabled = running;
  $('#cancel-btn').disabled = !running;
  $('#submit-btn').textContent = running ? '复核进行中…' : '发起复核';
}

// ---------- 结论渲染 ----------
function renderRunning(id, stage) {
  $('#review-meta').textContent = `任务 ${id.slice(0, 8)}… 运行中${stage ? `（Smith 正规形第 ${stage.stage}/${stage.total} 主元）` : ''}`;
  $('#review-panel').innerHTML = `
    <div><span class="spinner"></span>正在以任意精度整数执行 Smith 正规形变换，请稍候……</div>
    <div class="poll-note">大系数计算在服务端分片让出执行，可随时取消；取消后迟到的计算结果会被丢弃。</div>`;
  $('#detail-card').hidden = true;
}

function renderCancelling(id) {
  $('#review-meta').textContent = `任务 ${id.slice(0, 8)}… 正在取消`;
  $('#review-panel').innerHTML = '<div class="badge badge-cancel">取消请求已发送，等待当前计算分片退出…</div>';
}

function renderCancelled(id) {
  $('#review-meta').textContent = `任务 ${id.slice(0, 8)}… 已取消`;
  $('#review-panel').innerHTML = '<div class="badge badge-cancel">已取消：该任务不会产生结论，其迟到返回将被忽略。</div>';
  $('#detail-card').hidden = true;
}

function renderError(error) {
  $('#review-meta').textContent = '计算失败';
  $('#review-panel').innerHTML = `<div class="form-error">${escapeHtml(error?.message || '未知错误')}</div>`;
}

function renderConclusion(id, r) {
  const meta = `任务 ${id.slice(0, 8)}… · ${r.dimensions.m} 条约束 × ${r.dimensions.n} 个变量 · 秩 ${r.dimensions.rank}`;
  $('#review-meta').textContent = meta;
  const panel = $('#review-panel');
  panel.innerHTML = '';

  if (r.solvable) {
    const box = document.createElement('div');
    box.className = 'solution-box';
    const pairs = r.variables.map((v, i) =>
      `<span><span class="var">${escapeHtml(v)}</span> = <strong>${r.solution[i]}</strong></span>`).join('');
    const nullNote = r.nullspace && r.nullspace.length > 0
      ? `<div class="transform-note">存在 ${r.nullspace.length} 个自由变量；以上为一组整数特解（自由变量取 0），通解 = 特解 + 齐次解基的整数线性组合。
         <details class="transform"><summary>查看齐次解基（V 的自由列，精确整数）</summary><div class="matrix-grid">${renderVectorList(r.nullspace)}</div></details></div>`
      : '<div class="transform-note">解唯一（主元数 = 变量数）。</div>';
    box.innerHTML = `<h3><span class="badge badge-ok">有整数解</span> 精确整数校正量（整数个最小垫片单位）</h3>
      <div class="solution-list">${pairs}</div>${nullNote}`;
    panel.appendChild(box);
  } else {
    const box = document.createElement('div');
    box.className = 'evidence-box';
    const items = r.obstructions.map((o) => obstructionHtml(o, r)).join('<hr style="border:none;border-top:1px dashed #e0b8b5;margin:10px 0"/>');
    box.innerHTML = `<h3><span class="badge badge-bad">无整数解</span> 规范除尽障碍（可逆整数行变换证据）</h3>
      <div class="obstr-list">${items}</div>`;
    panel.appendChild(box);
  }

  // 约束选择条
  const pills = document.createElement('div');
  pills.className = 'constraints-pills';
  r.constraints.forEach((c, i) => {
    const p = document.createElement('button');
    p.type = 'button';
    p.className = 'list-pill' + (i === state.selectedConstraint ? ' selected' : '');
    p.textContent = `约束 ${i + 1}`;
    p.addEventListener('click', () => {
      state.selectedConstraint = i;
      pills.querySelectorAll('.list-pill').forEach((el, j) => el.classList.toggle('selected', j === i));
      renderConstraintDetail(r, i);
    });
    pills.appendChild(p);
  });
  panel.appendChild(pills);
  renderConstraintDetail(r, state.selectedConstraint);
  $('#detail-card').hidden = false;
}

function obstructionHtml(o, r) {
  const signEq = o.type === 'zero-row'
    ? `<div class="evidence-desc">经可逆整数行变换后得到零系数行，其变换后目标为非零值，即 <code>0 = ${o.transformedTarget}</code>，矛盾。</div>`
    : `<div class="evidence-desc">主元 <code>d = ${o.pivot}</code> 不能整除变换后的目标 <code>c = ${o.transformedTarget}</code>：
        整数方程 <code>${o.pivot}·y = ${o.transformedTarget}</code> 要求整除，而规范余数
        <code>${o.transformedTarget} mod ${o.pivot} = ${o.remainder} ≠ 0</code>，故整数解不存在。</div>`;
  return `${signEq}
    <div class="evidence-row"><span class="lbl">可逆行组合系数 u =</span> [${o.uRow.join(', ')}]</div>
    <div class="evidence-row"><span class="lbl">变换后系数 u·A =</span> [${o.transformedCoefficients.map((c, i) => `${c}·${escapeHtml(r.variables[i])}`).join(' + ')}]</div>
    <details class="transform"><summary>查看完整 Smith 对角形 S 与幺模行变换 U（逐行精确整数，可独立复核 c = U·b）</summary>
      <div class="evidence-row" style="margin-top:6px"><span class="lbl">S 对角主元：</span>[${r.pivots.join(', ')}]</div>
      <div class="evidence-row"><span class="lbl">变换后目标 c = U·b：</span>[${r.transformedTargets.join(', ')}]</div>
      <div class="matrix-grid"><span class="lbl">U =</span><br>${renderIntMatrix(r.unimodularRowTransform)}</div>
      <div class="matrix-grid"><span class="lbl">S =</span><br>${renderIntMatrix(r.diagonalForm)}</div>
    </details>`;
}

function renderIntMatrix(mat) {
  return '<table class="intmatrix"><tbody>' +
    mat.map((row) => `<tr>${row.map((v) => `<td>${escapeHtml(v)}</td>`).join('')}</tr>`).join('') +
    '</tbody></table>';
}

function renderConstraintDetail(r, i) {
  const c = r.constraints[i];
  const el = $('#constraint-detail');
  if (!c) {
    el.innerHTML = '';
    return;
  }
  const terms = c.terms.map((t, j) => {
    const sign = j > 0 ? ' + ' : '';
    const product = t.product === null ? '<span class="sign">（无解，无校正量）</span>' : t.product;
    return `<div class="term-line">${j === 0 ? '' : '<span class="sign">＋</span> '}
      <span class="sign">(${escapeHtml(t.coefficient)}) × ${escapeHtml(t.variable)}${t.value !== null ? `（=${escapeHtml(t.value)}）` : ''} =</span> ${product}</div>`;
  }).join('');
  const sumLine = r.solvable
    ? `<div class="detail-sum">左侧和 = <strong>${c.leftSum}</strong> ｜ 目标 = <strong>${c.target}</strong>
         ｜ <span class="${c.balanced ? 'ok-text' : 'bad-text'}">${c.balanced ? '✓ 精确相等' : '✗ 不相等'}</span></div>`
    : `<div class="detail-sum">目标 = <strong>${c.target}</strong> ｜ <span class="bad-text">无整数解，左侧和不存在</span></div>`;
  el.innerHTML = `<div class="detail-box">
    <div class="detail-title">约束 ${i + 1} 各项乘积明细（全程精确整数文本）</div>
    ${terms}${sumLine}
  </div>`;
}

function renderVectorList(vectors) {
  return vectors.map((vec, i) =>
    `<div>基向量 ${i + 1}: [${vec.map(escapeHtml).join(', ')}]</div>`).join('');
}

function renderIgnored() {
  if (state.ignored.length === 0) return;
  let box = $('#ignored-box');
  if (!box) {
    box = document.createElement('div');
    box.id = 'ignored-box';
    box.className = 'solution-box';
    box.style.borderColor = '#e3d3a8';
    $('#review-panel').before(box);
  }
  box.innerHTML = `<h3>已忽略的迟到返回（未覆盖草稿与结论）</h3>` +
    state.ignored.slice(-5).map((g) =>
      `<div class="evidence-row"><span class="lbl">${g.at}</span> 任务 ${g.id.slice(0, 8)}…：${g.reason}</div>`).join('');
}

// ---------- 杂项 ----------
function showFormError(msg) {
  const el = $('#form-error');
  el.textContent = msg;
  el.hidden = false;
}
function hideFormError() {
  $('#form-error').hidden = true;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function loadExample(name) {
  const ex = EXAMPLES[name];
  state.variables = ex.variables.slice();
  state.matrix = ex.matrix.map((r) => r.slice());
  state.targets = ex.targets.slice();
  $('#variables-input').value = state.variables.join(', ');
  state.selectedConstraint = 0;
  state.lastResult = null;
  state.currentJobId = null;
  state.running = false;
  state.currentJobToken++;
  stopPolling();
  setButtonsRunning(false);
  $('#review-meta').textContent = '已载入示例，尚未发起复核。';
  $('#review-panel').innerHTML = '<div class="empty-state">提交后在此展示精确整数校正量，或无解时的规范除尽障碍。</div>';
  $('#detail-card').hidden = true;
  renderTable();
  clearDraftFlag();
}

// ---------- 绑定 ----------
$('#variables-input').addEventListener('change', () => {
  const synced = syncVariables();
  if (synced && synced.error) showFormError(synced.error); else hideFormError();
  markDraftDirty();
});
$('#add-row-btn').addEventListener('click', () => {
  state.matrix.push(new Array(state.variables.length).fill('0'));
  state.targets.push('0');
  renderTable();
  markDraftDirty();
});
$('#submit-btn').addEventListener('click', submitReview);
$('#cancel-btn').addEventListener('click', cancelReview);
$('#example-solvable-btn').addEventListener('click', () => loadExample('solvable'));
$('#example-obstruct-btn').addEventListener('click', () => loadExample('obstruct'));
$('#example-bigint-btn').addEventListener('click', () => loadExample('bigint'));

renderTable();
