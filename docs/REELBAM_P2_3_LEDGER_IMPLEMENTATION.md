# Reelbam P2.3 — 积分账本写入实现

状态：代码已写入，测试未运行（NOT RUN）。本阶段结束后停止，等待 GPT Review，不进入 P2.4。

余额仍只有 `entitlement_grants.remaining_quantity`。流水仍只有 `entitlement_transactions`。没有 `users.credits`，没有独立 video credit 表，没有第二套发放系统。定价与 365 天有效期未改。

## 实际 API

数据层：`packages/data/src/credits/`

| 函数 | 作用 |
| --- | --- |
| `getAvailableCredits(db, userId, now)` | 可消费余额。过滤条件与 `/api/me` 共用 `spendableCreditWhere` |
| `listChargeCandidates(db, userId, now)` | 扣费候选。只用时间/状态过滤，把未知来源交给 `planCreditConsumption` 失败关闭 |
| `consumeCreditsForGeneration(db, request)` | 对已存在的 `queued` 任务扣费 |
| `planConsumeForGeneration` / `commitConsumePlan` | 计划/提交拆分。测试可在两次调用之间插入退款或改余额 |
| `prepareConsumeCharge` | 不读 generation 行。P2.4 用它把 generation INSERT 放进同一 batch |
| `returnCreditsForFailedGeneration(db, request)` | 失败返还 + 任务进入 `failed` |
| `planReturnForFailedGeneration` / `commitReturnPlan` | 同样的计划/提交拆分 |
| `reconcileGrantLedger(db, grantId)` | 按流水重建余额，与 `remaining_quantity` 比较 |
| `ensureImmutableOrderCreditGrant` | Creem 发放核对：不可变身份 + 原始 grant 流水 |

`/api/me` 改为调用 `getAvailableCredits`。

P2.4 创建路径必须把 generation INSERT 作为 `composeBefore`、outbox INSERT 作为 `composeAfter`，与扣费同一 `database.batch`。对已经提交的 queued 行单独扣费只用于测试，不是创建入口。

成功落账（`output_stored` → `succeeded`）本阶段没有实现。

## 数据库原子性

写入走 Drizzle `database.batch()`，这是 D1 的事务边界。禁止 interactive `BEGIN`。

条件更新的 `WHERE` 只有主键。比较放在 `CASE ... ELSE -1`。已有 CHECK 拒绝 `-1`：

- `entitlement_grants.remaining_quantity >= 0`
- `billing_orders.refund_version >= 0`
- `video_generations.status_version >= 1`
- `video_outbox.delivery_attempt_count >= 0`

UPDATE 影响 0 行不是 SQL 错误。消费和返还都在插入 operation 之后再写一条 close-check：不匹配就把 `intended_quantity` 写成 `-1`，整批回滚。

消费 batch 顺序：`composeBefore` → generation 围栏 CASE → grant CASE → consume 流水 → consume operation → close-check → `composeAfter`。

返还 batch 顺序与设计第 4.1 / 11 节一致：订单 `refund_version` CASE（含 adjustment 计数、shortfall、已结算量）→ grant remaining/status CASE（净变化为 0 也写）→ generation 失败 CASE → 需要时的 outbox delivered CASE → 流水 → return operation → settlement → 订单关闭校验 → operation close-check。

零报价失败不走共享订单守卫：只写失败状态和全 0 的 return operation，不写积分流水。

## 原批次消费与返还

消费顺序：未过期且 `expires_at` 更近的 active 批次，然后更远的，然后 `expires_at` 为空。同等条件按 `created_at`、`id`。

跨 grant 拆分。每条 consume 流水的 `balance_before` / `quantity` / `balance_after` 对应该 grant。消费不改 grant status，余额到 0 仍是 `active`。

返还只根据原 consume 流水回到同一 grant。禁止新开永不过期 grant。

`policyRevoked` 不是列。存在 `transaction_type = revoke` 且 `source_type` 不是 `refund` / `video_generation_return_clawback` / `video_generation_return_forfeit` 时为 true。现金退款把 status 写成 `revoked` 且流水来源是 `refund`，按 false 处理。

到期返还：先 refund `+T`，再 expire `-(expired + sweep)`。不延长 `expires_at`。可消费余额不增加。

## 现金退款 shortfall

现金退款仍由 `applyRefundCreated` + `planGrantRefundReversal` 计算。本阶段只补 applied = 0 时的 grant CASE。

视频返还按 adjustment `created_at`、id 吃掉 outstanding shortfall。补收写入 `billing_refund_credit_settlements`，不改 historical `shortfall_quantity`。不从其他订单借额度。

非 order grant 出现 clawback > 0 时失败关闭（`invalid_grant`）。promotion 返还不加 `billing_orders.refund_version`。

§5.1 全额退款后返还：clawback = 6，spendable = 0，status 保持 revoked。  
§5.8 A/B：两个任务补收同一 shortfall 6，最终 settlement 合计 6，可消费 4，shortfall 列仍为 6。后提交的 stale plan 回滚后重读。

## Creem 兼容修复

位置：`server/api/webhooks/creem.post.ts`

1. `ensureOrderCreditFulfillment` 改为调用 `ensureImmutableOrderCreditGrant`。比较订单、grant 身份、权益合同、原始 grant 流水。不再要求 `remainingQuantity` 等于初始发放量，也不再要求 `status = active`。
2. 原始流水缺失时：grant 仍处于初始余额才允许插入该流水；已经消费、过期或撤销则返回 `ENTITLEMENT_TRANSACTION_MISSING`，不补满 remaining。
3. `applyRefundCreated` 对每个 plan 都发出 grant CASE，包括 `appliedQuantity = 0`。applied > 0 且下一个剩余为 0 才写成 `revoked`。金额公式、HMAC、event 去重、`refund_version`、迟到 `checkout.completed` 短路未改。

## 幂等

| 操作 | 键 |
| --- | --- |
| 消费 | `video_credit:consume:{generationId}` |
| 返还 | `video_credit:return:{generationId}` |
| 消费流水 | `entitlement:video_generation:{generationId}:grant:{grantId}:consume` |
| 返还流水 | 同一前缀加 `:refund` / `:clawback` / `:forfeit` / `:expire` |

operation 只有 `completed`。行存在即表示整批已提交。相同键相同输入返回原结果。相同键不同金额返回 `amount_conflict`。

公开 API 不自动重试。batch 抛错后只重读一次 operation。读到匹配结果则当作并发赢家。CHECK / FK / trigger 且读不到行则 `aborted`。其他错误且读不到行则抛 `LedgerCommitUnknown`，调用方不得换新 operation id 再扣一次。

## 测试

| 编号 | 文件 |
| --- | --- |
| T01–T17、§5.8、composeBefore 回滚、非法事件 | `packages/data/test/ledger.sqlite.test.ts` |
| T04 worker 竞态 | `packages/data/test/ledger-worker.ts` + sqlite 测试 |
| T13/T14 Creem 内存假库 | `server/api/webhooks/creem.test.ts` |

关键并发不用内存 mock。T04/T12 的确定性交错用真实 sqlite-proxy + WAL。T10/T13/T14/T17 调用真实 `applyRefundCreated` / `ensureOrderCreditFulfillment` / `applyCheckoutCompleted`。

建议命令（全部 NOT RUN）：

```sh
pnpm install --frozen-lockfile
pnpm run test:data
pnpm run test:unit
pnpm run typecheck:video
```

不要应用迁移。本机 pnpm 12 不得重写 lockfile。

## 未验证

- 上述命令均未执行
- 未应用 `0000`/`0001`/`0002`
- 未在 Cloudflare D1 上验证 batch 与 CHECK 行为
- sqlite-proxy 与 D1 `batch` 结果形状只按 Drizzle 源码对齐，没有跑通
- `node:sqlite` `stmt.columns()` 在本机 Node 上的实际返回未测
- T04 worker_threads 竞态未测
- Creem 签名、真实支付、真实 AI 均未调用

## P2.4 可调用接口

创建任务（同一 batch）：

1. `listChargeCandidates`
2. `prepareConsumeCharge`
3. `commitConsumePlan(db, plan, { composeBefore: [generationInsert], composeAfter: [outboxInsert] })`

已存在 queued 行：`consumeCreditsForGeneration`。

失败终态：`returnCreditsForFailedGeneration`，传入 `event`、`expectedVersion`、lease owner/token、`errorCode`。合法事件见设计第 11 节。`needs_review` 不会自动返还。

不要在任务插入之前单独永久扣费。不要在本阶段的返还函数里登记 `succeeded`。

## 已知风险与上线前阻断

1. 测试和 typecheck 未跑。这是本阶段的硬阻断。
2. D1 上 UPDATE 0 行 + close-check 的组合没有实库证明。
3. 成功落账未实现。Worker 不能把 `storing` 送到 `succeeded`。
4. 活跃任务配额仍无表。
5. `video_credit_operations` 没有 sweep 列，到期清扫从 expire 流水重建。
6. 消费 generation 围栏用 `json_extract(quote_snapshot)`。quote 文本损坏时 CASE 失败，整批回滚。
7. Creem 修复依赖 grant 身份与原始 grant 流水仍在。流水被破坏且 remaining 已变时走人工核查，不会自动补发。

## GPT Review 修复（2026-10-31）

状态：F01–F07 对应修复与回归测试源码已写入；所有动态检查仍为 **NOT RUN**。不进入 P2.4。

- F01：attempt-backed 返还必须提供 `attemptId`、`evidenceId`；Provider/存储失败还必须提供 `providerRequestId`。同一失败 batch 重查原 generation 状态、版本、具体 attempt、lease、事件、证据 ID、resolved_at、接单状态及同 step 最新 attempt。`unknown` 不具备失败返还资格。`submission_rejected` / `recovery_confirmed_absent` 要求已保存 `rejected` 且无 request ID；`provider_failed` / `storage_irrecoverable` 要求 `accepted` 且 request ID 一致。外部失败事实由可信服务端写入，不能接受客户端自报。`composeBefore` 可将该事实写入与失败返还放进同一 batch；lease 必须已持有。
- F02/F03：`reconcileGrantLedger` 在同一个读取 batch 中观察 grant 和流水，按持久化 `ledger_sequence` 从合法初始 grant、零余额开始逐条累计，检查序号缺口、归属、重复发放、断链及最终余额。不再按秒级时间或字符串 ID 推测写入顺序。
- F04：候选携带原 granted 数量；消费计划、可用余额和提交 CASE 验证合法整数及数量上限。新增迁移的触发器同时约束 INSERT/UPDATE，拒绝 NULL、非整数、负数及超发剩余量，feature 的 NULL 数量保留。
- F05：batch 已返回成功但 outcome 读取失败时，也统一抛出带原 operation ID 的 `LedgerCommitUnknown`。同身份恢复，不能换键重扣。
- F06：SQLite 主测试和 worker 在导入 Webhook 前加载测试 shim；修正 unknown 场景余额夹具。
- F07：新增 `packages/data/test/ledger-integrity.sqlite.test.ts`，覆盖同秒顺序、损坏账本、约束、attempt 证据、旧 attempt、lease 替换、成功后迟到失败、多 grant 第二条失败、outbox 失败、零报价、全额/40%/50% 退款、混合订单、提交响应及读取丢失、并发返还、退款/返还竞争、零回收与净变化为零，以及迟到到账重放。断言最终数据库行及历史 adjustment 保留。

### 新迁移与部署前提

新增 `drizzle/0003_ledger_integrity.sql` 和对应 snapshot/journal。`0000`、`0001`、`0002` 的 SQL/snapshot 保留原字节；本轮没有应用任何迁移。

`ledger_sequence` 由数据库 INSERT 触发器按 grant 自动分配，唯一索引防重复，旧业务键不变。旧数据在 0003 中按现有 SQLite rowid 插入顺序建立序号；rowid 不能证明曾经经过重建/导入的历史业务顺序。因此已有数据必须先做隔离副本迁移与逐 grant 对账，有断链就人工核查，不能补发或自动覆盖。非法旧数量会让 0003 失败，不能静默修复。既有流水业务字段、ID、现金 refund adjustment 不改写；只补写新增序号。

代码依赖 0003 的列和触发器，部署前必须先在隔离环境验收迁移与新旧支付路径。不要先启用新写入器再补迁移。`0003_snapshot.json` 是源码对应的手工元数据，尚未经 drizzle-kit 验证；触发器由迁移 SQL 管理。

### 复测步骤（全部 NOT RUN）

在 Reelbam 根目录、已准备好的匹配依赖环境中执行：

```sh
pnpm run test:data
pnpm run test:unit
pnpm run typecheck:video
pnpm run db:check
```

本轮不执行依赖安装。若环境依赖不齐，先单独确认安装授权和 pnpm 11.24.0 的 frozen lockfile。

1. `test:data` 使用 `createDatabase` 的真实 Drizzle D1 驱动，连接测试专用 D1 形状 binding；底层为临时 SQLite、WAL、外键、CHECK、触发器和整批事务。测试会在临时库中应用 0000–0003，不接触业务数据库。
2. 必须看到新旧测试都实际执行，worker 有超时退出保护；检查所有最终余额、流水、operation、adjustment、settlement、generation/outbox 断言通过。
3. 单独取得数据库验收授权后，在隔离本地 D1 上验证 0000–0003、CHECK/trigger 回滚、UPDATE 0 行关闭校验、并发双向退款/返还、提交结果恢复和原支付回归。SQLite binding 通过不代表 Cloudflare D1 实机通过。
4. 已有数据库只在隔离副本先迁移，逐条对账；不要对损坏历史自动重新发放。真实库应用、部署和推送需要另行安排。

CDF 验收状态：`INSUFFICIENT_EVIDENCE`，原因是按用户约束未运行测试/类型检查/迁移；仅完成源码与文件差异静态复核，不能据此宣布 P2.3 财务动态验收通过。
