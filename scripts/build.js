'use strict';

/**
 * 构建：把 web/ 下的静态复核页发布到 dist/（零依赖拷贝 + 基础校验）。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'web');
const DIST = path.join(ROOT, 'dist');

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}
function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const name of fs.readdirSync(from)) {
    fs.copyFileSync(path.join(from, name), path.join(to, name));
  }
}

function build() {
  rmrf(DIST);
  copyDir(SRC, DIST);
  const index = path.join(DIST, 'index.html');
  if (!fs.existsSync(index)) throw new Error('构建失败：dist/index.html 缺失');
  const html = fs.readFileSync(index, 'utf8');
  const checks = [
    ['离线穷尽复核台', html.includes('离线穷尽复核台')],
    ['提交复核按钮', html.includes('btnVerify')],
    ['清空草稿与结论', html.includes('清空草稿与结论')],
    ['复核 API 调用', html.includes('/api/verify')],
    ['令牌生命周期账本入口', html.includes('btnLedger') && html.includes('ledgerToken')],
    ['账本 API 调用', html.includes('/api/ledger')],
    ['账本失效保护', html.includes('旧账本与结论快照已失效')]
  ];
  const failed = checks.filter(([, ok]) => !ok);
  if (failed.length) throw new Error('构建失败：页面缺少关键要素: ' + failed.map(([n]) => n).join(', '));
  return { outDir: DIST, files: fs.readdirSync(DIST) };
}

if (require.main === module) {
  const r = build();
  console.log('[build] 静态复核页已构建 ->', r.outDir, '(' + r.files.join(', ') + ')');
}

module.exports = { build };
