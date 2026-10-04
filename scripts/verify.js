'use strict';

/**
 * verify —— 一次性验收服务（执行后退出，以退出码报告结果）。
 *
 * 验收内容：
 *   1) 代码测试：node --test test/，覆盖
 *      · 分支遗漏释放   · abort 触发嵌套清理   · 循环重复获取
 *      以及未知令牌 / 循环上界越限 / 非法跳出清理作用域的报错与旧证据移除；
 *   2) 构建检查：构建静态复核页到 dist/ 并校验关键要素；
 *   3) HTTP 冒烟：请求健康地址与静态页面；并通过 /api/verify 复核三个规定场景。
 *
 * 目标服务：
 *   - 设置 APP_BASE_URL（如 compose 网络中的 http://app:8080）时直接对其冒烟；
 *   - 否则在本机临时端口拉起 src/server.js，冒烟结束后关闭。
 */

const { spawn, spawnSync } = require('node:child_process');
const path = require('node:path');
const http = require('node:http');

const ROOT = path.join(__dirname, '..');
const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 0);
const HEALTH_PATH = process.env.HEALTH_PATH || '/healthz';

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

function runNodeTest() {
  const r = spawnSync(process.execPath, ['--test', 'test/'], {
    cwd: ROOT, stdio: 'inherit', encoding: 'utf8'
  });
  record('代码测试（分支遗漏释放 / abort 嵌套清理 / 循环重复获取等 15 例）', r.status === 0,
    r.status === 0 ? 'node --test 全部通过' : `退出码 ${r.status}`);
  return r.status === 0;
}

function runBuild() {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'build.js')], {
    cwd: ROOT, stdio: 'inherit', encoding: 'utf8'
  });
  record('构建检查（静态复核页 dist/）', r.status === 0,
    r.status === 0 ? '页面构建并通过关键要素校验' : `退出码 ${r.status}`);
  return r.status === 0;
}

function request(method, urlPath, body, base) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request({
      hostname: base.hostname,
      port: base.port,
      path: urlPath,
      method,
      headers: data
        ? { 'content-type': 'application/json', 'content-length': data.length }
        : {}
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, text, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function waitFor(base, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const r = await request('GET', HEALTH_PATH, null, base);
        if (r.status === 200) return resolve();
      } catch {}
      if (Date.now() > deadline) return reject(new Error('服务在超时内未就绪'));
      setTimeout(tick, 200);
    };
    tick();
  });
}

function startLocalServer() {
  return new Promise((resolve, reject) => {
    const portFileData = [];
    const child = spawn(process.execPath, [path.join(ROOT, 'src', 'server.js')], {
      cwd: ROOT,
      env: { ...process.env, HOST, PORT: String(PORT) },
      stdio: ['ignore', 'pipe', 'inherit']
    });
    let settled = false;
    child.stdout.on('data', (d) => {
      portFileData.push(d);
      const m = Buffer.concat(portFileData).toString().match(/http:\/\/[^:]+:(\d+)/);
      if (m && !settled) {
        settled = true;
        resolve({ child, port: Number(m[1]) });
      }
    });
    child.on('error', (e) => { if (!settled) { settled = true; reject(e); } });
    child.on('exit', (code) => { if (!settled) { settled = true; reject(new Error('服务提前退出 ' + code)); } });
  });
}

const SCENARIOS = [
  {
    name: 'HTTP 场景复核：分支遗漏释放 => 违规',
    tokens: ['A'],
    script: `acquire A
if guard
release A
else
operate A
endif
return`,
    check: (r) => !r.ok && !r.fatal && r.violation && r.violation.type === 'token-leaked' &&
      r.counterexample.steps.some((s) => s.kind === 'condition' && s.value === false)
  },
  {
    name: 'HTTP 场景复核：abort 触发嵌套清理 => 安全且清理链为两层 LIFO',
    tokens: ['A'],
    script: `acquire A
cleanup
cleanup
release A
endcleanup
endcleanup
abort`,
    check: (r) => r.ok && r.exits.some((e) =>
      e.kind === 'abort' && e.clean && e.cleanupChains.some((c) => c.length === 2))
  },
  {
    name: 'HTTP 场景复核：循环重复获取 => double-acquire（最短路径执行 2 次）',
    tokens: ['A'],
    script: `loop 3
acquire A
operate A
endloop
return`,
    check: (r) => !r.ok && !r.fatal && r.violation && r.violation.type === 'double-acquire' &&
      r.counterexample.steps.some((s) => s.kind === 'loop-choice' && s.times === 2)
  }
];

async function runHttpSmoke(baseUrl) {
  const base = new URL(baseUrl);
  await waitFor(base, 15000);

  const health = await request('GET', HEALTH_PATH, null, base);
  let healthOk = false;
  try { healthOk = health.status === 200 && JSON.parse(health.text).status === 'ok'; } catch {}
  record(`HTTP 冒烟：GET ${HEALTH_PATH} 健康地址`, healthOk,
    healthOk ? '200 {status:ok}' : `HTTP ${health.status}`);

  const page = await request('GET', '/', null, base);
  const pageOk = page.status === 200 &&
    page.text.includes('离线穷尽复核台') && page.text.includes('/api/verify');
  record('HTTP 冒烟：GET / 静态复核页', pageOk,
    pageOk ? `200 text/html ${page.text.length} 字节` : `HTTP ${page.status}`);

  const staticPage = await request('GET', '/static/index.html', null, base);
  record('HTTP 冒烟：GET /static/index.html 静态页面', staticPage.status === 200 &&
    staticPage.text.includes('离线穷尽复核台'), `HTTP ${staticPage.status}`);

  for (const sc of SCENARIOS) {
    const r = await request('POST', '/api/verify', { script: sc.script, tokens: sc.tokens }, base);
    let body, ok = false;
    try { body = JSON.parse(r.text); ok = sc.check(body); } catch {}
    record(sc.name, ok, ok ? 'API 判定符合预期' : `HTTP ${r.status}：${(body && (body.violation || body.error || {}).type) || '响应不符'}`);
  }
}

async function main() {
  const testOk = runNodeTest();
  const buildOk = runBuild();

  let smokeOk = false;
  const baseUrl = process.env.APP_BASE_URL;
  let local = null;
  try {
    let target;
    if (baseUrl) {
      target = baseUrl;
    } else {
      local = await startLocalServer();
      target = `http://${HOST}:${local.port}`;
    }
    console.log(`[verify] HTTP 目标: ${target}`);
    await runHttpSmoke(target);
    smokeOk = true;
  } catch (e) {
    record('HTTP 冒烟（健康地址 / 静态页 / 场景复核）', false, e.message);
  } finally {
    if (local) local.child.kill('SIGTERM');
  }

  const failed = results.filter((r) => !r.ok);
  console.log('\n===== verify 验收汇总 =====');
  console.log(`通过 ${results.length - failed.length}/${results.length} 项`);
  if (failed.length) {
    console.log('失败项：');
    for (const f of failed) console.log('  - ' + f.name + (f.detail ? ' (' + f.detail + ')' : ''));
    process.exitCode = 1;
  } else {
    console.log('一次性验收服务全部通过，退出码 0');
  }
}

main().catch((e) => {
  console.error('[verify] 验收服务异常：', e);
  process.exit(1);
});
