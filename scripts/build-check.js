// 构建检查：本项目无编译步骤，以语法检查 + 模块可加载性作为构建门禁。
import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.git')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (name.endsWith('.js')) out.push(p);
  }
  return out;
}

const files = [
  ...walk(join(root, 'src')),
  ...walk(join(root, 'public')),
  ...walk(join(root, 'scripts')),
  ...walk(join(root, 'test')),
];

let failed = 0;
for (const f of files) {
  const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
  if (r.status !== 0) {
    failed++;
    console.error(`✗ 语法错误: ${f}\n${r.stderr}`);
  } else {
    console.log(`✓ ${f.slice(root.length + 1)}`);
  }
}

// 服务端模块必须可被正常加载（捕获顶层求值错误）
try {
  await import('../src/diophantine.js');
  await import('../src/protocol.js');
  await import('../src/reviewManager.js');
  console.log('✓ 服务端模块加载正常');
} catch (err) {
  failed++;
  console.error(`✗ 模块加载失败: ${err.stack || err.message}`);
}

if (failed > 0) {
  console.error(`构建检查失败：${failed} 项`);
  process.exit(1);
}
console.log('构建检查通过');
