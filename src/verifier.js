'use strict';

/**
 * 航电隔离令牌维护脚本 —— 离线穷尽复核引擎
 *
 * 指令（每行一条，# 为注释，空行忽略，关键字大小写不敏感）：
 *   acquire T      获取隔离令牌 T（已持有再获取 = 重复获取违规）
 *   operate T      操作令牌 T（仅可作用于当前持有令牌）
 *   release T      释放令牌 T（仅可作用于当前持有令牌）
 *   if / else / endif        条件块；复核按 TRUE / FALSE 两种结果穷尽展开
 *   loop K / endloop         有限次数循环；按执行 0..min(K,展开上界) 次穷尽展开
 *   return / abort           返回 / 中止；离开脚本前必须完成全部待执行清理续体
 *   cleanup / endcleanup     清理块：遇到时登记为“待执行清理续体”（defer / LIFO）
 *
 * 清理续体语义：
 *   - 遇到 cleanup：快照当前持有令牌，把块体登记入续体链，控制流跳到 endcleanup 之后；
 *   - 脚本自然结束 / return / abort：按 LIFO（嵌套由内向外）依次执行全部续体；
 *   - 续体内部可含条件、循环（同样两结果 / 有界展开）与嵌套 cleanup（压入同一链）；
 *   - 续体内部再次 return/abort 向外传播，继续触发其余续体（中止触发嵌套清理）。
 *
 * 穷尽方式：在抽象机状态上做 0-1 分层 FIFO 搜索。
 *   - 执行指令（含 cleanup 登记、return/abort）代价 1，条件取两种结果、循环次数选择、
 *     清理链展开等结构动作代价 0；
 *   - 条件 TRUE 先于 FALSE、循环次数由 0 升序入队；
 *   因此首个违规状态即【最短指令步数】，同步数下【保持源序】的完整路径。
 * 规范状态 = (控制栈及 pc, 持有令牌集, 续体链, 退出态)，据此去重并报告已穷尽状态数。
 */

const MAX_TOKENS = 8;
const MIN_TOKENS = 1;
const MAX_INSTRUCTIONS = 96;
const DEFAULT_LOOP_BOUND = 3;
const LOOP_BOUND_LIMIT = 64;
const MAX_STATES = 200000;

const INSTRUCTION_STEPS = new Set([
  'acquire', 'operate', 'release', 'return', 'abort', 'cleanup-register'
]);

class ParseError extends Error {
  constructor(message, line, code) {
    super(line == null ? message : `第 ${line} 行: ${message}`);
    this.name = 'ParseError';
    this.line = line;
    this.code = code || 'parse-error';
  }
}

function parse(text, opts = {}) {
  const names = opts.names || [];
  const declared = new Set(names);
  const maxLoop = opts.maxLoop != null ? opts.maxLoop : DEFAULT_LOOP_BOUND;

  const rawLines = String(text == null ? '' : text).split(/\r?\n/);
  const I = [];

  for (let i = 0; i < rawLines.length; i++) {
    const lineno = i + 1;
    const t = rawLines[i].trim();
    if (t === '' || t.startsWith('#')) continue;
    const p = t.split(/\s+/);
    const op = p[0].toLowerCase();
    const arity = (n) => {
      if (p.length !== n + 1) {
        throw new ParseError(`「${p[0]}」需要 ${n} 个参数，实得 ${p.length - 1} 个`, lineno);
      }
    };
    let ins;
    switch (op) {
      case 'acquire': arity(1); ins = { kind: 'acquire', token: p[1], line: lineno }; break;
      case 'operate': arity(1); ins = { kind: 'operate', token: p[1], line: lineno }; break;
      case 'release': arity(1); ins = { kind: 'release', token: p[1], line: lineno }; break;
      case 'if': {
        if (p.length > 2) {
          throw new ParseError(`「if」至多 1 个条件名参数（可选），实得 ${p.length - 1} 个`, lineno);
        }
        ins = { kind: 'if', line: lineno, condName: p[1] || null };
        break;
      }
      case 'else': arity(0); ins = { kind: 'else', line: lineno }; break;
      case 'endif': arity(0); ins = { kind: 'endif', line: lineno }; break;
      case 'loop': {
        arity(1);
        const b = Number(p[1]);
        if (!Number.isInteger(b) || b < 0) {
          throw new ParseError(`循环次数必须是非负整数: 「${p[1]}」`, lineno, 'bad-loop-bound');
        }
        if (b > LOOP_BOUND_LIMIT) {
          throw new ParseError(`循环上界越限: ${b} > ${LOOP_BOUND_LIMIT}`, lineno, 'loop-bound-exceeded');
        }
        ins = { kind: 'loop', bound: b, expanded: Math.min(b, maxLoop), line: lineno };
        break;
      }
      case 'endloop': arity(0); ins = { kind: 'endloop', line: lineno }; break;
      case 'return': arity(0); ins = { kind: 'return', line: lineno }; break;
      case 'abort': arity(0); ins = { kind: 'abort', line: lineno }; break;
      case 'cleanup': arity(0); ins = { kind: 'cleanup', line: lineno }; break;
      case 'endcleanup': arity(0); ins = { kind: 'endcleanup', line: lineno }; break;
      default:
        throw new ParseError(`未知指令: 「${p[0]}」`, lineno, 'unknown-instruction');
    }
    I.push(ins);
  }

  if (I.length > MAX_INSTRUCTIONS) {
    throw new ParseError(`结构化指令至多 ${MAX_INSTRUCTIONS} 条，实得 ${I.length} 条`, null, 'too-many-instructions');
  }

  pairAndCheckNesting(I);
  for (const ins of I) {
    if (ins.token && !declared.has(ins.token)) {
      throw new ParseError(`未知令牌「${ins.token}」（未在令牌清单中声明）`, ins.line, 'unknown-token');
    }
  }
  return I;
}

/** 块配对与嵌套合法性（未闭合 / 交叉闭合 = 非法跳出、穿越清理作用域） */
function pairAndCheckNesting(I) {
  const stack = [];
  let cleanupDepth = 0; // 静态 cleanup 嵌套深度
  for (let i = 0; i < I.length; i++) {
    const ins = I[i];
    if (ins.kind === 'if' || ins.kind === 'loop' || ins.kind === 'cleanup') {
      if (ins.kind === 'cleanup') {
        cleanupDepth += 1;
        ins.cleanupDepth = cleanupDepth;
      }
      stack.push(i);
    } else if (ins.kind === 'else') {
      const top = stack[stack.length - 1];
      if (top == null || I[top].kind !== 'if') {
        throw new ParseError('「else」没有处于开启状态的 if', ins.line, 'scope-jump');
      }
      if (I[top].elseIndex != null) {
        throw new ParseError('一个 if 块至多包含一个 else', ins.line, 'scope-jump');
      }
      I[top].elseIndex = i;
    } else if (ins.kind === 'endif' || ins.kind === 'endloop' || ins.kind === 'endcleanup') {
      const open = stack.pop();
      if (open == null) {
        throw new ParseError(`「${ins.kind}」没有匹配的开始指令`, ins.line, 'scope-jump');
      }
      const want = ins.kind === 'endif' ? 'if' : ins.kind === 'endloop' ? 'loop' : 'cleanup';
      if (I[open].kind !== want) {
        throw new ParseError(
          `「${ins.kind}」(第 ${ins.line} 行) 与未闭合的「${I[open].kind}」(第 ${I[open].line} 行) 交叉，非法跳出/穿越作用域`,
          ins.line,
          'scope-jump'
        );
      }
      I[open].match = i;
      ins.match = open;
      if (ins.kind === 'endcleanup') cleanupDepth -= 1;
    }
  }
  if (stack.length) {
    const top = I[stack[stack.length - 1]];
    throw new ParseError(`「${top.kind}」(第 ${top.line} 行) 缺少结束指令，作用域未闭合`, top.line, 'scope-jump');
  }
  for (const ins of I) {
    if (ins.kind === 'if' && ins.elseIndex != null && ins.elseIndex > ins.match) {
      throw new ParseError(`第 ${ins.line} 行 if 的 else 越出块范围`, ins.line, 'scope-jump');
    }
  }
}

/* ------------------------------------------------------------------ */
/* 状态构件                                                            */
/* ranges: 控制栈 [{s,e,kind,rem?,rejoin?}]  s 含 e 不含               */
/*   main    顶层                                                      */
/*   branch  条件某一分支，结束后跳到 rejoin                           */
/*   iter    循环体，rem=本次之后剩余迭代次数                          */
/*   cleanup 正在执行的清理续体                                        */
/* frames: 待执行清理续体链（LIFO，取末尾）                             */
/* ------------------------------------------------------------------ */

function heldArray(held) {
  return held.__order.filter((t) => held.has(t));
}
function cloneHeld(held, order) {
  const s = new Set(held);
  s.__order = order;
  return s;
}
function cloneRanges(rs) {
  return rs.map((r) => ({ ...r }));
}
function cloneFrames(fs) {
  return fs.map((f) => ({ ...f, registeredHeld: f.registeredHeld.slice() }));
}
function stateKey(s) {
  return s.ranges.map((r, i) =>
    `${r.kind[0]}${r.s}-${r.e}${r.rem != null ? 'x' + r.rem : ''}${i === s.ranges.length - 1 ? '@' + s.pc : ''}`
  ).join('/') +
    '||' + heldArray(s.held).join(',') +
    '||' + s.frames.map((f) => `${f.pc}#${f.depth}:${f.registeredHeld.join('.')}`).join('>') +
    '||' + (s.pendingExit || '-');
}

function fatal(type, message, line) {
  // 未知令牌 / 循环上界越限 / 非法跳出清理作用域等：报错并移除旧证据
  return {
    ok: false,
    fatal: true,
    evidenceRemoved: true,
    error: { type, message, line: line == null ? null : line }
  };
}

function verify(scriptText, options = {}) {
  const tokenNames = [];
  const seenName = new Set();
  for (const raw of options.tokenNames || []) {
    const t = String(raw).trim();
    if (!t) continue;
    if (seenName.has(t)) {
      return fatal('duplicate-token', `令牌清单重复: 「${t}」`);
    }
    seenName.add(t);
    tokenNames.push(t);
  }
  if (tokenNames.length < MIN_TOKENS || tokenNames.length > MAX_TOKENS) {
    return fatal('bad-token-count', `令牌数量须为 ${MIN_TOKENS}..${MAX_TOKENS} 个，实得 ${tokenNames.length} 个`);
  }

  let I;
  try {
    I = parse(scriptText, { names: tokenNames, maxLoop: options.maxLoop });
  } catch (e) {
    if (e instanceof ParseError) return fatal(e.code, e.message, e.line);
    throw e;
  }

  const rootHeld = new Set();
  rootHeld.__order = tokenNames;
  const initial = {
    ranges: [{ s: 0, e: I.length, kind: 'main' }],
    held: rootHeld,
    frames: [],
    pendingExit: null,
    exitLine: null,
    pc: 0,
    parent: null,
    lastStep: null
  };

  // 分层 FIFO：level d 的数组承载指令步数恰为 d 的状态；代价 0 的结构动作追加到当前层
  const levels = new Map([[0, { arr: [initial], i: 0 }]]);
  let dist = 0;
  const visited = new Set();
  let canonicalStates = 0;
  const exitsByPoint = new Map();

  function enqueue(parent, ns, step) {
    ns.parent = parent;
    ns.lastStep = step;
    const w = step && INSTRUCTION_STEPS.has(step.kind) ? 1 : 0;
    const d = dist + w;
    let lvl = levels.get(d);
    if (!lvl) {
      lvl = { arr: [], i: 0 };
      levels.set(d, lvl);
    }
    lvl.arr.push(ns);
  }

  function childOf(s) {
    return {
      ranges: s.ranges,
      held: s.held,
      frames: s.frames,
      pendingExit: s.pendingExit,
      exitLine: s.exitLine,
      pc: s.pc
    };
  }

  /* eslint no-labels: off */
  outer:
  for (;;) {
    let lvl = levels.get(dist);
    if (!lvl || lvl.i >= lvl.arr.length) {
      const next = levels.get(dist + 1);
      if (!next) break;
      dist += 1;
      continue;
    }
    const s = lvl.arr[lvl.i++];

    const key = stateKey(s);
    if (visited.has(key)) continue;
    visited.add(key);
    canonicalStates += 1;
    if (canonicalStates > MAX_STATES) {
      return fatal('state-limit', `规范状态数超出复核上限 ${MAX_STATES}（请收窄循环展开上界后重试）`);
    }

    // 违规态：分层 FIFO 保证首个弹出的即最短指令步数、同步数源序
    if (s.pendingExit === 'violation') {
      return buildFailure(s, canonicalStates, I, tokenNames);
    }

    // 控制栈空：展开剩余清理续体或形成出口
    if (s.ranges.length === 0) {
      if (s.frames.length) {
        continueChain(s);
      } else {
        recordExit(s);
      }
      continue;
    }

    const r = s.ranges[s.ranges.length - 1];
    if (s.pc >= r.e) {
      endRange(s, r);
      continue;
    }

    const ins = I[s.pc];

    if (ins.kind === 'return' || ins.kind === 'abort') {
      const ns = childOf(s);
      ns.ranges = [];
      ns.pendingExit = ins.kind;
      ns.exitLine = ins.line;
      enqueue(s, ns, {
        kind: ins.kind,
        line: ins.line,
        heldBefore: heldArray(s.held),
        pendingCleanups: s.frames.length,
        detail: `${ins.kind}：准备离开脚本，待执行清理续体 ${s.frames.length} 层（离开前必须全部完成）`
      });
      continue;
    }

    switch (ins.kind) {
      case 'acquire': {
        if (s.held.has(ins.token)) {
          raiseViolation(s, {
            type: 'double-acquire', line: ins.line, token: ins.token,
            detail: `重复获取已持有的令牌「${ins.token}」（循环重复获取）`
          }, {
            kind: 'acquire', line: ins.line, token: ins.token,
            heldBefore: heldArray(s.held), heldAfter: heldArray(s.held), ok: false,
            detail: `重复获取令牌「${ins.token}」（违规）`
          });
        } else {
          const before = heldArray(s.held);
          const ns = childOf(s);
          ns.held = cloneHeld(s.held, tokenNames);
          ns.held.add(ins.token);
          ns.pc = s.pc + 1;
          enqueue(s, ns, {
            kind: 'acquire', line: ins.line, token: ins.token,
            heldBefore: before, heldAfter: heldArray(ns.held), ok: true,
            detail: `获取令牌「${ins.token}」`
          });
        }
        break;
      }
      case 'operate': {
        if (!s.held.has(ins.token)) {
          raiseViolation(s, {
            type: 'operate-without-token', line: ins.line, token: ins.token,
            detail: `操作了当前未持有的令牌「${ins.token}」`
          }, {
            kind: 'operate', line: ins.line, token: ins.token,
            heldBefore: heldArray(s.held), heldAfter: heldArray(s.held), ok: false,
            detail: `操作令牌「${ins.token}」，但当前未持有（违规）`
          });
        } else {
          const ns = childOf(s);
          ns.pc = s.pc + 1;
          enqueue(s, ns, {
            kind: 'operate', line: ins.line, token: ins.token,
            heldBefore: heldArray(s.held), heldAfter: heldArray(s.held), ok: true,
            detail: `操作持有的令牌「${ins.token}」`
          });
        }
        break;
      }
      case 'release': {
        if (!s.held.has(ins.token)) {
          raiseViolation(s, {
            type: 'release-without-token', line: ins.line, token: ins.token,
            detail: `释放了当前未持有的令牌「${ins.token}」（分支遗漏释放导致错误硬件隔离状态）`
          }, {
            kind: 'release', line: ins.line, token: ins.token,
            heldBefore: heldArray(s.held), heldAfter: heldArray(s.held), ok: false,
            detail: `释放令牌「${ins.token}」，但当前未持有（违规）`
          });
        } else {
          const before = heldArray(s.held);
          const ns = childOf(s);
          ns.held = cloneHeld(s.held, tokenNames);
          ns.held.delete(ins.token);
          ns.pc = s.pc + 1;
          enqueue(s, ns, {
            kind: 'release', line: ins.line, token: ins.token,
            heldBefore: before, heldAfter: heldArray(ns.held), ok: true,
            detail: `释放令牌「${ins.token}」`
          });
        }
        break;
      }
      case 'if': {
        const elseAt = ins.elseIndex;
        const endAt = ins.match;
        // 源序：TRUE(then) 先入队，FALSE(else/空) 后入队（结构动作，代价 0）
        branch(s, ins, true, s.pc + 1, elseAt != null ? elseAt : endAt, endAt);
        if (elseAt != null) branch(s, ins, false, elseAt + 1, endAt, endAt);
        else branch(s, ins, false, endAt, endAt, endAt);
        break;
      }
      case 'loop': {
        // 源序：执行次数 0..expanded 升序入队（结构动作，代价 0）
        for (let k = 0; k <= ins.expanded; k++) {
          const ns = childOf(s);
          ns.ranges = cloneRanges(s.ranges);
          if (k === 0) {
            ns.pc = ins.match + 1;
          } else {
            ns.ranges.push({ s: s.pc + 1, e: ins.match, kind: 'iter', rem: k - 1, rejoin: ins.match + 1 });
            ns.pc = s.pc + 1;
          }
          enqueue(s, ns, {
            kind: 'loop-choice', line: ins.line, times: k, bound: ins.bound, expandedTo: ins.expanded,
            heldBefore: heldArray(s.held), heldAfter: heldArray(s.held),
            detail: `循环（第 ${ins.line} 行）本路径执行 ${k} 次（有界展开 0..${ins.expanded}，源上界 ${ins.bound}）`
          });
        }
        break;
      }
      case 'cleanup': {
        const before = heldArray(s.held);
        const ns = childOf(s);
        ns.frames = cloneFrames(s.frames);
        const depth = ins.cleanupDepth || ns.frames.length + 1;
        ns.frames.push({ pc: s.pc, end: ins.match, depth, registeredHeld: before.slice() });
        ns.pc = ins.match + 1;
        enqueue(s, ns, {
          kind: 'cleanup-register', line: ins.line, depth,
          heldBefore: before, heldAfter: before,
          detail: `登记清理续体（嵌套深度 ${depth}），登记时持有: ${before.join(', ') || '∅'}；块体延后至离开时 LIFO 展开`
        });
        break;
      }
      default: {
        // else / endif / endloop / endcleanup 由 range 边界处理，正常执行流不可达
        const ns = childOf(s);
        ns.pc = s.pc + 1;
        enqueue(s, ns, null);
      }
    }
  }

  function branch(parent, ifIns, value, bodyS, bodyE, endAt) {
    const ns = childOf(parent);
    ns.ranges = cloneRanges(parent.ranges);
    if (bodyS < bodyE) {
      ns.ranges.push({ s: bodyS, e: bodyE, kind: 'branch', rejoin: endAt + 1 });
      ns.pc = bodyS;
    } else {
      ns.pc = endAt + 1;
    }
    enqueue(parent, ns, {
      kind: 'condition', line: ifIns.line, value,
      heldBefore: heldArray(parent.held), heldAfter: heldArray(parent.held),
      detail: `条件（第 ${ifIns.line} 行）取 ${value ? 'TRUE' : 'FALSE'}`
    });
  }

  function endRange(s, r) {
    if (r.kind === 'branch') {
      const ns = childOf(s);
      ns.ranges = cloneRanges(s.ranges);
      ns.ranges.pop();
      ns.pc = r.rejoin;
      enqueue(s, ns, null);
    } else if (r.kind === 'iter') {
      const ns = childOf(s);
      ns.ranges = cloneRanges(s.ranges);
      if (r.rem > 0) {
        const top = ns.ranges[ns.ranges.length - 1];
        top.rem = r.rem - 1;
        ns.pc = top.s;
        enqueue(s, ns, {
          kind: 'loop-repeat',
          heldBefore: heldArray(s.held), heldAfter: heldArray(s.held),
          detail: `循环体完成，剩余执行 ${r.rem - 1} 次后汇合`
        });
      } else {
        ns.ranges.pop();
        ns.pc = r.rejoin;
        enqueue(s, ns, null);
      }
    } else if (r.kind === 'cleanup') {
      // 续体正常走完：继续链上其余续体
      continueChain(s);
    } else if (r.kind === 'main') {
      const ns = childOf(s);
      ns.ranges = [];
      ns.pendingExit = 'fall-through';
      enqueue(s, ns, null);
    }
  }

  function continueChain(s) {
    const frame = s.frames[s.frames.length - 1];
    const ns = childOf(s);
    if (!frame) {
      ns.ranges = [];
      enqueue(s, ns, null);
      return;
    }
    ns.frames = cloneFrames(s.frames);
    const f = ns.frames.pop();
    ns.ranges = [{ s: f.pc + 1, e: f.end, kind: 'cleanup' }];
    ns.pc = f.pc + 1;
    const cause = s.pendingExit === 'abort' ? '由 abort 触发'
      : s.pendingExit === 'return' ? '由 return 触发'
      : '脚本自然结束触发';
    enqueue(s, ns, {
      kind: 'cleanup-run', line: I[f.pc].line, depth: f.depth,
      registeredHeld: f.registeredHeld,
      heldBefore: heldArray(s.held), heldAfter: heldArray(s.held),
      detail: `${cause}：展开清理续体（LIFO 深度 ${f.depth}，第 ${I[f.pc].line} 行登记；登记时持有: ${f.registeredHeld.join(', ') || '∅'}）`
    });
  }

  function raiseViolation(s, violation, step) {
    const ns = childOf(s);
    ns.ranges = [];
    ns.frames = [];
    ns.pendingExit = 'violation';
    ns.__violation = violation;
    enqueue(s, ns, step);
  }

  function recordExit(s) {
    const held = heldArray(s.held);
    const clean = held.length === 0;
    const point = `${s.pendingExit}@${s.exitLine == null ? 'end' : s.exitLine}`;
    let rec = exitsByPoint.get(point);
    if (!rec) {
      rec = {
        kind: s.pendingExit,
        line: s.exitLine,
        clean: true,
        heldAfterVariants: [],
        cleanupChains: []
      };
      exitsByPoint.set(point, rec);
    }
    rec.clean = rec.clean && clean;
    const sig = held.join(',');
    if (!rec.heldAfterVariants.some((v) => v.join(',') === sig)) {
      rec.heldAfterVariants.push(held.slice());
    }
    const chain = extractChain(s);
    const csig = chain.map((c) => `${c.depth}:${c.line}`).join('>');
    if (!rec.cleanupChains.some((c) => c.map((x) => `${x.depth}:${x.line}`).join('>') === csig)) {
      rec.cleanupChains.push(chain.map((c) => ({
        depth: c.depth, line: c.line, registeredHeld: c.registeredHeld.slice()
      })));
    }

    if (!clean) {
      // 出口违规（清理已执行完毕仍持有令牌）：同样压入违规队列由分层 FIFO 裁决最短/源序
      const ns = childOf(s);
      ns.ranges = [];
      ns.frames = [];
      ns.pendingExit = 'violation';
      ns.__violation = {
        type: 'token-leaked',
        line: s.exitLine,
        exit: s.pendingExit,
        tokens: held.slice(),
        detail: `${exitLabel(s)}且全部清理续体执行完毕后仍持有令牌: ${held.join(', ')}`
      };
      enqueue(s, ns, {
        kind: 'exit', line: s.exitLine, exit: s.pendingExit,
        heldBefore: held.slice(), heldAfter: held.slice(), clean: false,
        detail: `${exitLabel(s)}形成出口，但清理后仍持有: ${held.join(', ')}`
      });
    }
  }

  function exitLabel(s) {
    if (s.pendingExit === 'fall-through') return '脚本自然结束';
    return `${s.pendingExit}（第 ${s.exitLine} 行）`;
  }

  function extractChain(s) {
    const out = [];
    let cur = s;
    while (cur) {
      const st = cur.lastStep;
      if (st && st.kind === 'cleanup-run') {
        out.push({ depth: st.depth, line: st.line, registeredHeld: st.registeredHeld });
      }
      cur = cur.parent;
    }
    return out.reverse();
  }

  function buildFailure(violState, states) {
    const trace = [];
    let cur = violState;
    while (cur) {
      // 注意：零成本汇合节点 lastStep 为 null，仍须沿 parent 继续，不能在此中断
      if (cur.lastStep) trace.push(cur.lastStep);
      cur = cur.parent;
    }
    trace.reverse();
    return {
      ok: false,
      fatal: false,
      evidenceRemoved: true, // 发现违规：旧的安全结论（旧证据）作废，以本路径为新证据
      stats: { canonicalStates: states, instructions: I.length, tokens: tokenNames.length },
      violation: violState.__violation,
      counterexample: {
        instructionSteps: trace.filter((st) => INSTRUCTION_STEPS.has(st.kind)).length,
        steps: trace
      }
    };
  }

  const exits = [...exitsByPoint.values()].map((e) => ({
    kind: e.kind,
    line: e.line,
    clean: e.clean,
    heldAfterVariants: e.heldAfterVariants,
    cleanupChains: e.cleanupChains
  })).sort((a, b) => {
    if (a.line == null && b.line != null) return 1;
    if (b.line == null && a.line != null) return -1;
    return (a.line || 0) - (b.line || 0) || a.kind.localeCompare(b.kind);
  });

  return {
    ok: true,
    fatal: false,
    stats: {
      canonicalStates,
      instructions: I.length,
      tokens: tokenNames.length,
      exits: exits.length
    },
    exits
  };
}

module.exports = {
  verify,
  parse,
  ParseError,
  MAX_TOKENS,
  MAX_INSTRUCTIONS,
  DEFAULT_LOOP_BOUND,
  LOOP_BOUND_LIMIT
};
