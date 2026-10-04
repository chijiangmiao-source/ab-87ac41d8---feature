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
