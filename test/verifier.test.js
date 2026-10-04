'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { verify, parse, LOOP_BOUND_LIMIT, MAX_INSTRUCTIONS } = require('../src/verifier');

function stepKinds(r) {
  return r.counterexample.steps.map((s) => s.kind);
}
function linesOf(r, kind) {
  return r.counterexample.steps.filter((s) => s.kind === kind).map((s) => s.line);
}

test('场景一：分支遗漏释放 —— FALSE 分支操作未配对释放，形成泄漏违规路径', () => {
  const script = `
acquire A
if guard
  release A
else
  operate A
endif
return`;
  const r = verify(script, { tokenNames: ['A'] });
  assert.equal(r.ok, false);
  assert.equal(r.fatal, false);
  assert.equal(r.evidenceRemoved, true);
  // 最短违规路径必须走 FALSE（else 分支）
  const cond = r.counterexample.steps.find((s) => s.kind === 'condition');
  assert.equal(cond.value, false);
  // 违规类型：离开脚本后仍持有（else 分支没有 release）
  assert.equal(r.violation.type, 'token-leaked');
  // 完整逐步路径包含令牌获取、操作、返回与出口
  const kinds = stepKinds(r);
  assert.ok(kinds.includes('acquire'));
  assert.ok(kinds.includes('operate'));
  assert.ok(kinds.includes('return'));
  // 同长度源序：TRUE 分支（先释放）是安全的，不应当被报为违规
});

test('场景一反例对照：两个分支都释放时安全，并报告穷尽状态数与出口清理', () => {
  const script = `
acquire A
if guard
  release A
else
  operate A
  release A
endif
return`;
  const r = verify(script, { tokenNames: ['A'] });
  assert.equal(r.ok, true, JSON.stringify(r.violation || r.error));
  assert.ok(r.stats.canonicalStates > 0);
  assert.equal(r.exits.length, 1);
  assert.equal(r.exits[0].kind, 'return');
  assert.equal(r.exits[0].clean, true);
});

test('直接操作未持有令牌在分支内即可判定违规（不止泄漏）', () => {
  const script = `if c
operate A
else
release A
endif
return`;
  const r = verify(script, { tokenNames: ['A'] });
  assert.equal(r.ok, false);
  assert.equal(r.fatal, false);
  // TRUE 与 FALSE 分别在 operate/release 未持有令牌处违规，先取源序的 TRUE
  assert.equal(r.violation.type, 'operate-without-token');
});

test('场景二：abort 触发嵌套清理 —— 两层 cleanup 按 LIFO 展开并完成释放', () => {
  const script = `
acquire A
cleanup
  cleanup
    release A
  endcleanup
endcleanup
abort`;
  const r = verify(script, { tokenNames: ['A'] });
  assert.equal(r.ok, true, JSON.stringify(r.violation));
  const exit = r.exits.find((e) => e.kind === 'abort');
  assert.ok(exit);
  assert.equal(exit.clean, true);
  // 清理链：两层，深度 1 为外层、深度 2 为内层，LIFO 先执行内层
  const chain = exit.cleanupChains[0];
  assert.equal(chain.length, 2);
  assert.equal(chain[0].depth, 1);
  assert.equal(chain[1].depth, 2);
});

test('场景二负例：abort 时清理续体未释放令牌 => 违规，轨迹含清理展开', () => {
  const script = `
acquire A
cleanup
  operate A
endcleanup
abort`;
  const r = verify(script, { tokenNames: ['A'] });
  assert.equal(r.ok, false);
  assert.equal(r.violation.type, 'token-leaked');
  const kinds = stepKinds(r);
  assert.ok(kinds.includes('cleanup-register'));
  assert.ok(kinds.includes('cleanup-run'));
  assert.ok(kinds.includes('abort'));
});

test('清理续体内 abort 向外传播，继续触发外层续体（中止触发嵌套清理）', () => {
  const script = `
acquire A
cleanup
  acquire B
  cleanup
    release B
  endcleanup
  abort
endcleanup
return`;
  // 外层续体在 abort 传播后仍须执行：它不释放 A，因此 A 泄漏；但 B 必须被内层清掉
  const r = verify(script, { tokenNames: ['A', 'B'] });
  assert.equal(r.ok, false);
  assert.deepEqual(r.violation.tokens.sort(), ['A']);
});

test('场景三：循环重复获取 —— 第二次迭代 acquire 已持有的令牌', () => {
  const script = `
loop 3
  acquire A
  operate A
endloop
return`;
  const r = verify(script, { tokenNames: ['A'] });
  assert.equal(r.ok, false);
  assert.equal(r.violation.type, 'double-acquire');
  assert.equal(r.violation.line, 3);
  const choice = r.counterexample.steps.find((s) => s.kind === 'loop-choice');
  // 最短路径：恰好需要 2 次迭代才复现重复获取
  assert.equal(choice.times, 2);
  assert.equal(r.counterexample.instructionSteps, 3); // acquire, operate, 再 acquire
});

test('循环体配对获取/释放时，0..K 各次数均安全', () => {
  const script = `
loop 3
  acquire A
  operate A
  release A
endloop
return`;
  const r = verify(script, { tokenNames: ['A'] });
  assert.equal(r.ok, true, JSON.stringify(r.violation));
  assert.equal(r.exits[0].clean, true);
});

test('最短性：更深位置的同型违规不得抢先于浅层违规（按指令步数 BFS）', () => {
  // else 分支第 4 行立即 release 未持有令牌；then 分支要走很多步才泄漏
  const script = `
acquire A
if c
  operate A
  operate A
  operate A
  release A
else
  release A
  acquire A
endif
return`;
  const r = verify(script, { tokenNames: ['A'] });
  assert.equal(r.ok, false);
  // FALSE 路径：release(L4 源码第 9 行附近) 本身合法（A 仍持有），随后 acquire A 重复获取
  // 关键：最短违规一定出现在 FALSE（步数更短），违规行是 else 中的 acquire
  const cond = r.counterexample.steps.find((s) => s.kind === 'condition');
  assert.equal(cond.value, false);
});

test('未知令牌报错并标记移除旧证据', () => {
  const r = verify('acquire ZZ', { tokenNames: ['A'] });
  assert.equal(r.fatal, true);
  assert.equal(r.error.type, 'unknown-token');
  assert.equal(r.error.line, 1);
  assert.equal(r.evidenceRemoved, true);
});

test('循环上界越限报错', () => {
  const script = `loop ${LOOP_BOUND_LIMIT + 1}\nendloop`;
  const r = verify(script, { tokenNames: ['A'] });
  assert.equal(r.fatal, true);
  assert.equal(r.error.type, 'loop-bound-exceeded');
  assert.equal(r.evidenceRemoved, true);
});

test('非法跳出/穿越清理作用域（交叉闭合）报错', () => {
  const r = verify('cleanup\nif c\nendcleanup\nendif', { tokenNames: ['A'] });
  assert.equal(r.fatal, true);
  assert.equal(r.error.type, 'scope-jump');
  assert.equal(r.evidenceRemoved, true);
});

test('未闭合清理块报错', () => {
  const r = verify('acquire A\ncleanup\nrelease A', { tokenNames: ['A'] });
  assert.equal(r.fatal, true);
  assert.equal(r.error.type, 'scope-jump');
});

test('令牌数量与指令条数边界', () => {
  assert.equal(verify('acquire A', { tokenNames: [] }).fatal, true);
  assert.equal(verify('acquire A', { tokenNames: Array(9).fill(0).map((_, i) => 'T' + i) }).fatal, true);
  const tooMany = Array(MAX_INSTRUCTIONS + 1).fill('operate A').join('\n');
  const r = verify(tooMany, { tokenNames: ['A'] });
  assert.equal(r.fatal, true);
});

test('return 前经条件两分支后，在汇合处统一清理（安全）', () => {
  const script = `
acquire A
if c
  operate A
endif
cleanup
  release A
endcleanup
return`;
  const r = verify(script, { tokenNames: ['A'] });
  assert.equal(r.ok, true, JSON.stringify(r.violation));
  const exit = r.exits.find((e) => e.kind === 'return');
  assert.equal(exit.clean, true);
});

/* ---------------- 令牌生命周期账本 ---------------- */

test('账本：安全脚本按源指令顺序汇总四类点，出口结论 已释放，覆盖全部出口', () => {
  const script = `acquire A
if guard
operate A
release A
else
release A
endif
return`;
  const r = verify(script, { tokenNames: ['A'], ledgerToken: 'A' });
  assert.equal(r.ok, true, JSON.stringify(r.violation));
  const L = r.ledger;
  assert.ok(L, '安全复核须附账本');
  assert.equal(L.token, 'A');
  assert.equal(L.truncated, false);
  assert.equal(L.truncation, null);
  // 获取点 / 操作点 / 显式释放点（两个分支各一处），无嵌套清理释放点
  const byCat = (c) => L.points.filter((p) => p.category === c);
  assert.deepEqual(byCat('acquire').map((p) => p.line), [1]);
  assert.deepEqual(byCat('operate').map((p) => p.line), [3]);
  assert.deepEqual(byCat('explicit-release').map((p) => p.line), [4, 6]);
  assert.equal(byCat('cleanup-release').length, 0);
  // 按源指令顺序排列
  const lines = L.points.map((p) => p.line);
  assert.deepEqual(lines, [...lines].sort((a, b) => a - b));
  // 每个点都有可达路径数
  assert.ok(L.points.every((p) => p.paths >= 1));
  // 出口结论：已释放（两条路径都获取并释放）
  assert.equal(L.exits.length, 1);
  assert.equal(L.exits[0].kind, 'return');
  assert.equal(L.exits[0].conclusion, 'released');
  assert.equal(L.exits[0].released >= 1, true);
  assert.equal(L.exits[0].stillHeld, 0);
});

test('账本：循环内不同轮次分别标明', () => {
  const script = `loop 2
acquire A
release A
endloop
return`;
  const r = verify(script, { tokenNames: ['A'], ledgerToken: 'A' });
  assert.equal(r.ok, true, JSON.stringify(r.violation));
  const acq = r.ledger.points.filter((p) => p.kind === 'acquire');
  // 展开 0..2 次：第 1/1、1/2、2/2 轮分别标明
  const rounds = acq.map((p) => `${p.loops[0].iter}/${p.loops[0].total}`).sort();
  assert.deepEqual(rounds, ['1/1', '1/2', '2/2']);
  assert.ok(acq.every((p) => p.loops[0].line === 1 && p.scope === 'main'));
  const rel = r.ledger.points.filter((p) => p.category === 'explicit-release');
  assert.deepEqual(rel.map((p) => `${p.loops[0].iter}/${p.loops[0].total}`).sort(), ['1/1', '1/2', '2/2']);
});

test('账本：清理块中的同名令牌来源分别标明（嵌套清理释放点）', () => {
  // 主流程获取并释放 A；清理续体内两次重新获取同名令牌 A，
  // 分别由深度 1 清理块显式释放、深度 2 嵌套清理块释放：来源须分别标明
  const script = `acquire A
release A
cleanup
acquire A
release A
acquire A
cleanup
release A
endcleanup
endcleanup
abort`;
  const r = verify(script, { tokenNames: ['A'], ledgerToken: 'A' });
  assert.equal(r.ok, true, JSON.stringify(r.violation));
  const L = r.ledger;
  const acqMain = L.points.find((p) => p.kind === 'acquire' && p.scope === 'main');
  assert.ok(acqMain && acqMain.line === 1 && acqMain.cleanup === null);
  const acqCleanup = L.points.filter((p) => p.kind === 'acquire' && p.scope === 'cleanup');
  assert.deepEqual(acqCleanup.map((p) => p.line), [4, 6]);
  assert.ok(acqCleanup.every((p) => p.cleanup.line === 3 && p.cleanup.depth === 1));
  const cleanupRel = L.points.filter((p) => p.category === 'cleanup-release');
  assert.equal(cleanupRel.length, 2);
  assert.deepEqual(
    cleanupRel.map((p) => `${p.line}@d${p.cleanup.depth}`).sort(),
    ['5@d1', '8@d2']
  );
  assert.equal(L.points.some((p) => p.category === 'explicit-release'), true); // 主流程 L2
  const exit = L.exits.find((e) => e.kind === 'abort');
  assert.equal(exit.conclusion, 'released');
});

test('账本：违规脚本只覆盖首条违规前已执行的生命周期并标明截断原因', () => {
  const script = `loop 3
acquire A
operate A
endloop
return`;
  const r = verify(script, { tokenNames: ['A'], ledgerToken: 'A' });
  assert.equal(r.ok, false);
  assert.equal(r.violation.type, 'double-acquire');
  const L = r.ledger;
  assert.equal(L.truncated, true);
  assert.equal(L.truncation.type, 'double-acquire');
  assert.equal(L.truncation.line, 2);
  assert.ok(L.truncation.detail.includes('重复获取'));
  // 违规指令（第二轮起的 acquire）未执行：账本只含各展开的首轮获取与操作
  const acq = L.points.filter((p) => p.kind === 'acquire');
  assert.ok(acq.length > 0);
  assert.ok(acq.every((p) => p.loops[0].iter === 1));
  assert.equal(L.points.some((p) => p.kind === 'release'), false);
});

test('账本：出口仍被持有（泄漏违规）给出 仍被持有 结论', () => {
  const r = verify('acquire A\nreturn', { tokenNames: ['A'], ledgerToken: 'A' });
  assert.equal(r.ok, false);
  assert.equal(r.violation.type, 'token-leaked');
  assert.equal(r.ledger.truncated, true);
  const exit = r.ledger.exits.find((e) => e.kind === 'return');
  assert.equal(exit.conclusion, 'still-held');
  assert.equal(exit.stillHeld >= 1, true);
});

test('账本：仅单分支获取时令牌在出口区分 已释放 / 未曾持有', () => {
  const script = `if c
acquire A
release A
endif
return`;
  const r = verify(script, { tokenNames: ['A'], ledgerToken: 'A' });
  assert.equal(r.ok, true, JSON.stringify(r.violation));
  const exit = r.ledger.exits.find((e) => e.kind === 'return');
  assert.equal(exit.conclusion, 'released'); // 存在获取并释放的路径
  assert.equal(exit.released >= 1, true);
  assert.equal(exit.neverHeld >= 1, true); // FALSE 分支未曾持有
});

test('账本：令牌不在当前令牌表时明确拒绝且不生成账本', () => {
  const r = verify('acquire A', { tokenNames: ['A'], ledgerToken: 'ZZ' });
  assert.equal(r.fatal, true);
  assert.equal(r.error.type, 'unknown-token');
  assert.ok(r.error.message.includes('不在当前令牌表'));
  assert.equal(r.ledger, undefined);
});

test('账本：未指定账本令牌时普通复核不附账本（原行为不变）', () => {
  const r = verify('acquire A\nrelease A\nreturn', { tokenNames: ['A'] });
  assert.equal(r.ok, true);
  assert.equal(r.ledger, undefined);
});
