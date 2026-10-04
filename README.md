# 航电隔离令牌维护脚本 · 离线穷尽复核台

工程师离线复核维护脚本在**中止或提前返回**时是否遗漏释放硬件隔离令牌。对每个
控制路径穷尽展开，追踪「当前持有令牌」与「待执行清理续体」，确保所有
`return` / `abort` / 自然结束出口在离开脚本前完成全部清理。

## 能力边界

- 令牌 **1–8** 个，结构化指令 **至多 96** 条。
- 指令：`acquire` / `operate` / `release T`；`if [条件名]` / `else` / `endif`；
  `loop K` / `endloop`（有限次数，静态上界 ≤ 64，复核按可配置展开上界展开 0..K 次）；
  `return`；`abort`；`cleanup` / `endcleanup`（可嵌套，LIFO 续体）。
- 每个条件按 **TRUE / FALSE 两种结果**展开；循环按 **0..K 次**展开；
  `operate` / `release` 只能作用于当前持有令牌。
- `cleanup` 块在遇到时登记续体（快照持有令牌），脚本离开时（含 abort 传播）
  按嵌套由内向外 LIFO 执行；续体内可含条件/循环/嵌套清理。
- 违规证据：按**最短指令步数**（0-1 分层 FIFO）、同长度**保持源序**
  （TRUE 先于 FALSE，循环次数升序）给出完整逐步路径、令牌变化与清理展开。
- 安全结论：报告**已穷尽的规范状态数**及各出口（return/abort/自然结束）的清理结果。
- **令牌生命周期账本**：复核完成后可在结果页选择令牌，针对当前已完成复核生成账本——
  按源指令顺序汇总该令牌的获取点、操作点、显式释放点、嵌套清理释放点及各自
  可达路径数（按规范状态计）；循环内不同轮次、清理块中的同名令牌来源分别标明；
  每个出口给出该令牌**已释放 / 未曾持有 / 仍被持有**的规范结论。
  违规脚本的账本只覆盖**首条违规前已执行的生命周期**并标明截断原因；
  安全脚本覆盖全部穷尽出口。令牌不在当前令牌表、复核尚未完成、重新复核或清空后，
  页面显示明确原因且不展示旧账本。
- **未知令牌、循环上界越限、非法跳出/穿越清理作用域**直接报错并标记
  `evidenceRemoved`（旧证据作废）；发现违规时同样移除旧安全证据。

## 本地运行（零依赖，Node ≥ 20）

```bash
npm start                 # 默认 0.0.0.0:8080，健康地址 /healthz
HOST=127.0.0.1 PORT=8091 HEALTH_PATH=/ready npm start
npm test                  # 代码测试（node --test，23 例）
npm run build             # 构建静态复核页到 dist/
npm run verify            # 一次性验收：测试 + 构建 + HTTP 冒烟，退出码报告
```

## Compose

```bash
HOST_PORT=8080 docker compose up --build
# 复核页：     http://localhost:8080/
# 健康地址：   http://localhost:8080/healthz
docker compose run --rm verify   # 仅跑一次性验收服务（退出码报告）
```

- `app`：常驻复核页 + 健康地址 + `/api/verify`、`/api/clear`、`/api/meta`。
- `verify`：**执行后退出**的一次性验收服务。它运行代码测试（覆盖分支遗漏释放、
  abort 触发嵌套清理、循环重复获取）、构建页面，并对 `app` 请求健康地址与静态
  页面完成 HTTP 冒烟，以退出码报告全部结果。

## HTTP 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/healthz`（可用 `HEALTH_PATH` 配置） | 健康地址 |
| GET | `/`、`/static/index.html` | 静态复核页 |
| POST | `/api/verify` | `{script, tokens, maxLoop?}` 穷尽复核 |
| POST | `/api/ledger` | `{script, tokens, token, maxLoop?}` 指定令牌的生命周期账本 |
| POST | `/api/clear` | 清空草稿与结论（旧证据移除确认） |
| GET | `/api/meta` | 令牌/指令上限 |

### 生命周期账本（`/api/ledger`）

- 复用同一套穷尽机重新展开同一输入，并追踪指定令牌：账本点含
  `acquire` / `operate` / `explicit-release` / `cleanup-release` 四类，
  按源指令行号排序，各自给出可达路径数（执行到该点的规范状态数）。
- 账本模式下规范状态额外区分「目标令牌是否曾获取」与「循环所选总次数」，
  因此循环不同轮次、清理块（含嵌套深度）中的同名令牌来源分别标明；
  普通 `/api/verify` 的规范状态定义与结论不受影响。
- 出口结论：`released`（已释放）/ `never-held`（未曾持有）/ `still-held`（仍被持有），
  并附各分类路径计数；存在仍被持有路径时结论为 `still-held`。
- 脚本违规时 `ledger.truncated = true` 并给出 `truncation`（类型/行号/详情），
  账本仅含首条违规前已执行的生命周期；安全脚本 `truncated = false`，覆盖全部穷尽出口。
- 令牌不在当前令牌表：HTTP 422 + `unknown-token`，不生成账本。
