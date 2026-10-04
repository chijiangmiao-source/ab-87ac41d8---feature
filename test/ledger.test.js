'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildLedger } = require('../src/verifier');

function point(r, kind, line, ctxKey) {
  return r.points.find((p) => p.kind === kind && p.line === line &&
    JSON.stringify(p.context) === JSON.stringify(ctxKey || []));
}

test('账本：安全脚本不截断，覆盖全部穷尽出口，事件按源指令顺序排列', () => {
  const script = `
acquire A
if g
  operate A
endif
release A
return`;
  const r = buildLedger(script, { tokenNames: ['A'], token: 'A' });
  assert.equal(r.fatal, false);
  assert.equal(r.safe, true);
  assert.equal(r.truncated, false);
  assert.equal(r.cutoff, null);
  assert.deepEqual(r.points.map((p) => `${p.kind}@${p.line}`),
    ['acquire@2', 'operate@4', 'release@6']);
  // 获取在条件分叉前：仅 1 条路径；operate 仅 TRUE 路径可达（1 条）；汇合后释放两路径都经过（2 条）
  assert.equal(point(r, 'acquire', 2).paths, 1);
  assert.equal(point(r, 'operate', 4).paths, 1);
  assert.equal(point(r, 'release', 6).paths, 2);
  const ex = r.exits[0];
  assert.equal(ex.kind, 'return');
  assert.equal(ex.released, 2);
  assert.equal(ex.stillHeld, 0);
  assert.equal(ex.neverHeld, 0);
  assert.equal(ex.conclusion.code, 'released');
});

test('账本：循环不同轮次的同名令牌事件分别标注并分列', () => {
  const script = `
loop 2
  acquire A
  operate A
  release A
endloop
return`;
  const r = buildLedger(script, { tokenNames: ['A'], token: 'A' });
  assert.equal(r.truncated, false);
  // 第 1 轮事件：k=1 与 k=2 两条路径经过（2 条）；第 2 轮事件：仅 k=2（1 条）
  const acqR1 = point(r, 'acquire', 3, [{ type: 'loop', line: 2, round: 1 }]);
  const acqR2 = point(r, 'acquire', 3, [{ type: 'loop', line: 2, round: 2 }]);
  assert.ok(acqR1 && acqR2, '两轮获取点必须分列');
  assert.equal(acqR1.paths, 2);
  assert.equal(acqR2.paths, 1);
  const opR1 = point(r, 'operate', 4, [{ type: 'loop', line: 2, round: 1 }]);
  const opR2 = point(r, 'operate', 4, [{ type: 'loop', line: 2, round: 2 }]);
  assert.equal(opR1.paths, 2);
  assert.equal(opR2.paths, 1);
  // 穷尽出口 3 条：循环 0 / 1 / 2 次；0 次路径从未持有 A，其余已释放
  const ex = r.exits[0];
  assert.equal(ex.totalPaths, 3);
  assert.equal(ex.released, 2);
  assert.equal(ex.neverHeld, 1);
  assert.equal(ex.conclusion.code, 'released-or-never');
});

test('账本：显式释放点与嵌套清理续体释放点分类标注（LIFO、深度与来源）', () => {
  const script = `
acquire A
cleanup
  cleanup
    release A
  endcleanup
endcleanup
if g
  return
else
  abort
endif`;
  const r = buildLedger(script, { tokenNames: ['A'], token: 'A' });
  assert.equal(r.truncated, false, JSON.stringify(r.error || r.cutoff));
  const cleanupRelease = r.points.filter((p) => p.kind === 'cleanup-release');
  assert.equal(cleanupRelease.length, 1);
  const p = cleanupRelease[0];
  assert.equal(p.line, 5);
  assert.equal(p.paths, 2); // return 与 abort 两条路径都经内层续体释放
  assert.deepEqual(p.context, [
    { type: 'cleanup', line: 3, depth: 1 }, // 内层续体在“外层续体执行期间”登记，来源带外层
    { type: 'cleanup', line: 4, depth: 2 }
  ]);
  assert.deepEqual(p.cleanupBlocks, [
    { line: 3, depth: 1 }, { line: 4, depth: 2 }
  ]);
  assert.equal(r.exits.length, 2);
  for (const e of r.exits) {
    assert.equal(e.stillHeld, 0);
    assert.equal(e.released, 1);
    assert.equal(e.conclusion.code, 'released');
  }
});

test('账本：循环内逐轮登记的清理块，截断时不含首条违规距离之后才执行的续体释放', () => {
  const script = `
loop 2
  acquire A
  cleanup
    release A
  endcleanup
  operate A
endloop
return`;
  const r = buildLedger(script, { tokenNames: ['A'], token: 'A' });
  // k=2 在第二轮重复获取（最短 4 步）=> 违规截断；k=0 出口此前已形成
  assert.equal(r.truncated, true);
  assert.equal(r.cutoff.reason, 'first-violation');
  assert.equal(r.cutoff.violation.type, 'double-acquire');
  assert.equal(r.cutoff.instructionSteps, 4);
  // 第 1 轮的获取/操作：k=1 与 k=2 两路径经过，均标注为第 1 轮
  assert.equal(point(r, 'acquire', 3, [{ type: 'loop', line: 2, round: 1 }]).paths, 2);
  assert.equal(point(r, 'operate', 7, [{ type: 'loop', line: 2, round: 1 }]).paths, 2);
  // k=1 路径的清理释放发生在出口展开（指令步 5），晚于首条违规（步 4）：不纳入截断账本
  assert.ok(!r.points.some((p) => p.kind === 'cleanup-release'),
    '首条违规之后才执行的续体释放不得出现在截断账本中');
  // 截断前只有循环 0 次形成的 return 出口（未曾持有）
  const ex = r.exits.find((e) => e.kind === 'return');
  assert.ok(ex);
  assert.equal(ex.neverHeld, 1);
  assert.equal(ex.totalPaths, 1);
});

test('账本：安全脚本中循环轮次内登记的清理续体，释放点同时标注轮次与清理块来源', () => {
  const script = `
loop 1
  acquire A
  cleanup
    release A
  endcleanup
  operate A
endloop
return`;
  const r = buildLedger(script, { tokenNames: ['A'], token: 'A' });
  // loop 1 展开 0..1：0 次路径从未持有 A；1 次路径在第 1 轮登记续体、离开时 LIFO 释放，安全
  assert.equal(r.truncated, false, JSON.stringify(r.cutoff || r.error));
  const cr = point(r, 'cleanup-release', 5, [
    { type: 'loop', line: 2, round: 1 },
    { type: 'cleanup', line: 4, depth: 1 }
  ]);
  assert.ok(cr, '清理释放点必须同时标注“第 1 轮登记”与“清理块 L4”来源');
  assert.equal(cr.paths, 1);
  assert.deepEqual(cr.cleanupBlocks, [{ line: 4, depth: 1 }]);
  assert.equal(point(r, 'acquire', 3, [{ type: 'loop', line: 2, round: 1 }]).paths, 1);
  assert.equal(point(r, 'operate', 7, [{ type: 'loop', line: 2, round: 1 }]).paths, 1);
  const ex = r.exits.find((e) => e.kind === 'return');
  assert.equal(ex.released, 1);
  assert.equal(ex.neverHeld, 1);
  assert.equal(ex.stillHeld, 0);
});

test('账本：违规脚本只覆盖首条违规前已执行的生命周期，并给出截断原因', () => {
  const script = `
acquire A
if g
  release A
else
  operate A
endif
return
acquire A
release A`;
  const r = buildLedger(script, { tokenNames: ['A'], token: 'A' });
  assert.equal(r.truncated, true);
  assert.equal(r.cutoff.violation.type, 'token-leaked');
  assert.match(r.cutoff.note, /首条违规/);
  // 违规在第 7 行 return 出口；第 9/10 行位于违规之后，不得出现在账本中
  assert.ok(r.points.every((p) => p.line <= 7));
  // 截断前 TRUE 路径已形成干净出口
  const ex = r.exits.find((e) => e.kind === 'return');
  assert.equal(ex.released, 1);
  assert.equal(ex.stillHeld, 1); // FALSE 路径的出口态在违规裁决同层已形成
  assert.equal(ex.conclusion.code, 'still-held');
});

test('账本：操作未持有令牌的违规，账本事件止于违规指令', () => {
  const script = `if g
operate A
else
acquire A
release A
endif
return`;
  const r = buildLedger(script, { tokenNames: ['A'], token: 'A' });
  assert.equal(r.truncated, true);
  assert.equal(r.cutoff.violation.type, 'operate-without-token');
  // TRUE 在 operate 处违规：该操作点是违规动作本身，账本不含违规之后的事件
  const lines = r.points.map((p) => p.line).sort((a, b) => a - b);
  assert.ok(lines.every((l) => l <= 2));
});

test('账本：令牌不在当前令牌表 => 明确拒绝（fatal），不产生账本', () => {
  const r = buildLedger('acquire A\nreturn', { tokenNames: ['A'], token: 'ZZ' });
  assert.equal(r.fatal, true);
  assert.equal(r.error.type, 'ledger-token-not-declared');
  assert.equal(r.points, undefined);
});

test('账本：脚本本身非法（未知令牌等）透传致命错误并标记旧证据移除', () => {
  const r = buildLedger('acquire NOPE\nreturn', { tokenNames: ['A'], token: 'A' });
  assert.equal(r.fatal, true);
  assert.equal(r.error.type, 'unknown-token');
  assert.equal(r.evidenceRemoved, true);
});

test('账本：安全脚本路径数守恒——穷尽出口具体路径数之和等于展开数', () => {
  const script = `
acquire A
if g
  operate A
endif
cleanup
  if h
    release A
  else
    release A
  endif
endcleanup
return`;
  const r = buildLedger(script, { tokenNames: ['A'], token: 'A' });
  assert.equal(r.truncated, false, JSON.stringify(r.cutoff || r.error));
  // 两个条件 2×2 = 4 条具体路径，全部在清理续体中释放
  const total = r.exits.reduce((n, e) => n + e.totalPaths, 0);
  assert.equal(total, 4);
  assert.equal(r.stats.pathsToExits, 4);
  const ex = r.exits.find((e) => e.kind === 'return');
  assert.equal(ex.released, 4);
  assert.equal(ex.stillHeld, 0);
  assert.equal(ex.neverHeld, 0);
  assert.equal(ex.conclusion.code, 'released');
});

test('账本：安全脚本各出口结论均为已释放，且嵌套清理路径计数正确', () => {
  const script = `
acquire A
cleanup
  if h
    release A
  else
    release A
  endif
endcleanup
abort`;
  const r = buildLedger(script, { tokenNames: ['A'], token: 'A' });
  assert.equal(r.truncated, false, JSON.stringify(r.cutoff || r.error));
  const ex = r.exits.find((e) => e.kind === 'abort');
  assert.equal(ex.totalPaths, 2);
  assert.equal(ex.released, 2);
  assert.equal(ex.stillHeld, 0);
  // 清理块内两个同名 release（不同分支）分列，各 1 条
  const cr = r.points.filter((p) => p.kind === 'cleanup-release' && p.line === 5);
  const cr2 = r.points.filter((p) => p.kind === 'cleanup-release' && p.line === 7);
  assert.equal(cr.length, 1);
  assert.equal(cr2.length, 1);
  assert.equal(cr[0].paths, 1);
  assert.equal(cr2[0].paths, 1);
});
