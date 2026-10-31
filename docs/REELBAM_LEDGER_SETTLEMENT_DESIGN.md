# Reelbam 积分结算数据协议

状态：P2.2 设计与纯函数契约。P2.3 已按本协议实现写入器，并落地第 6 节与第 13 节的两处 Webhook 接点。实现记录见 [REELBAM_P2_3_LEDGER_IMPLEMENTATION.md](REELBAM_P2_3_LEDGER_IMPLEMENTATION.md)。下文里“本轮不改 Webhook / 消费 API 不得在接点落地之前开放”是 P2.2 的历史边界。`packages/data/src/credits/contract.ts` 只计算计划和守卫裁决。Webhook 的现金退款比例和 `planGrantRefundReversal` 保持原样。

余额只有一处：`entitlement_grants.remaining_quantity`，流水在 `entitlement_transactions`。`video_credit_operations` 和 `billing_refund_credit_settlements` 是结算审计，不保存第二份余额，也不新增 `users.credits`。

## 1. 事实源

| 记录 | 事实 |
| --- | --- |
| `video_generations` | 一次用户任务。状态、输入快照、路由快照、服务端报价和版本都在这里 |
| `video_attempts` | 某一步的一次 Provider 提交。重复队列消息命中同一 `submit_key` |
| `video_outbox` | 可恢复的投递记录。队列消息只是它的副本 |
| `entitlement_grants` / `entitlement_transactions` | 积分余额和全部增减 |
| `video_credit_operations` | 某次任务已经完成的消费或返还批次 |
| `billing_refund_credit_adjustments` | 现金退款当时的目标、实际回收和 shortfall。写入后不改数量 |
| `billing_refund_credit_settlements` | 后续视频返还补上了哪一笔 shortfall |
| `video_provider_costs` | 单次 attempt 的 estimated、actual 或 unknown 成本 |

`video_generations.route_snapshot` 使用 P2.1 `RouteSnapshot`，`schemaVersion` 为 1。报价单独放在 `quote_snapshot`，不放进路由快照。默认模型配置以后变化时，这两份快照仍能解释当时的任务。

持久化内容只包括规范输入、资产 ID、路由快照、服务端报价、对象 key、payload hash 和非机密恢复元数据。完整签名 URL、Provider 密钥和客户端传入的价格不入库。`recovery_metadata` 可以保存轮询游标和已公开的 job 标识；写入器要去掉凭据和签名 URL。

## 2. 可消费余额

一条 grant 可被视频消费，当且仅当：

- `entitlement_key = 'credits'`
- `entitlement_type = 'consumable'`
- `status = 'active'`
- `remaining_quantity > 0`
- `effective_at <= now`
- `expires_at is null` 或 `expires_at > now`

这与 `server/api/me.get.ts` 的合计条件一致，并且来源必须属于 `VIDEO_SPENDABLE_SOURCE_TYPES`：`order`、`subscription_cycle`、`admin`、`migration`、`promotion`。这五个值就是 grant 表 CHECK 允许的全部来源，所以今天的视频可消费余额和 `me.get` 的合计相同。本轮不改 `me.get`。以后若增加第六种来源，必须同时改这个允许列表和余额读取，再允许写入；否则扣费计划返回 `unsupported_source`，行列表为空。`expires_at = now` 已不可消费。

排序：

1. 有 `expires_at` 的排在 `expires_at is null` 之前。SQLite 默认 `NULLS FIRST`，查询必须显式把空到期放最后。
2. `expires_at` 升序。
3. `created_at` 升序。
4. `id` 按字符顺序升序。

`planCreditConsumption` 先按以上规则过滤和排序，确认合计足够后才生成扣费行。不足时返回 `insufficient_credits`，行列表为空。禁止先读出余额再无条件扣减，也禁止在余额不足时扣掉一部分。

## 3. 原子消费

P2.3 的创建入口在一个 D1 batch 内完成下面全部写入。batch 中任一语句失败，整批回滚。

1. 插入 `video_generations`：`status = 'queued'`，`status_version = 1`，`quoted_credits` 等于服务端报价，`canonical_input` 保存 `canonicalizeGenerationInput` 的原始字符串，`canonical_input_hash` 是该字符串 UTF-8 的 SHA-256 hex。
2. 按计划对每个 grant 执行条件更新。
3. 插入对应的负数 `consume` 流水。
4. 插入一条 `completed` 的 `video_credit_operations`，类型 `consume`。
5. 插入 `video_outbox`，事件 `start_submission`，`delivery_status = 'pending'`。

条件更新的 `WHERE` 只有主键。active、用户、权益、有效期和来源都在 `CASE` 里。计划读完后状态变成 `revoked` 而余额没变时，`WHEN` 不成立，写成 `-1`，整批失败：

```sql
update entitlement_grants
set remaining_quantity = case
      when user_id = :userId
       and entitlement_key = 'credits'
       and entitlement_type = 'consumable'
       and status = 'active'
       and remaining_quantity = :expected
       and effective_at <= :now
       and (expires_at is null or expires_at > :now)
       and source_type = :sourceType
       and source_id = :sourceId
       and source_type in ('order', 'subscription_cycle', 'admin', 'migration', 'promotion')
      then :expected - :quantity
      else -1
    end,
    updated_at = :now
where id = :grantId
```

`evaluateConsumeGuard` 按 grant id 升序做同一组检查。状态不是 `active` 时原因是 `grant_not_active`，失败模式仍是 `abort_batch`。空的扣费行不是零报价授权。多条 grant 里只要一条失败，整个消费 batch 回滚，不留下部分扣费。

消费不改 grant status。余额降到 0 仍然保持 `active`，因为 `remaining_quantity > 0` 已经使它不可消费。`revoked` 只留给现金退款或政策撤销。

`else -1` 被 `remaining_quantity >= 0` 拒绝，D1 回滚整批，流水和 outbox 都不会留下。调用方重新读取 grant 并重新计划。把 `status = 'active'` 或 `remaining = expected` 放进 `WHERE`、更新 0 行后继续插入，不是这个守卫。

报价为 0 时计划行是空的。batch 仍插入 generation、一条数量全 0 的 consume operation 和 outbox，不写 grant，不写流水。以后的失败结算走第 4.2 节，不走共享订单守卫。

### 幂等

- 操作键：`video_credit:consume:{generationId}`
- 流水键：`entitlement:video_generation:{generationId}:grant:{grantId}:consume`
- 流水 `source_type = video_generation`，`source_id = generationId`，`quantity` 为负
- 表约束：`unique(user_id, idempotency_key)`，以及每个 generation 只能有一条 `consume` operation

同一个用户和同一个客户端 key：

- 规范输入哈希相同：batch 因唯一约束回滚。读取已有 generation，返回该任务，不再扣费。
- 哈希不同：同样回滚。返回 409，不扣费，不新建任务。

冲突发生在插入 generation 时，后面的扣费语句随整批撤销。

### 规范化输入

哈希覆盖 `modelId`、`mode`、`parameters.durationSeconds`、`parameters.resolution`，以及实际出现的 `aspectRatio`、`seed`、`generateAudio`。文生视频包含 `prompt`。图生视频包含 `imageAssetId` 和可选 `prompt`。参考视频包含两个资产 ID 和可选 `prompt`。路由、报价、签名 URL 不进入这个字符串。

## 4. 幂等失败返还

只有 `failed` 可以做失败结算。`failureSettlementAllowed` 对 `succeeded` 和 `needs_review` 返回 false。`needs_review` 不是终态，不能触发返还。进入 `failed` 或 `succeeded` 的状态语句不是“最新 `status_version` 匹配即可”。原状态、合法事件和 lease 见第 11 节。`succeeded` 即使版本号就是当前读到的最新值，也不能进入 `failed`。

失败返还的状态更新、订单 `refund_version`、grant 余额、流水、operation 和 settlement 必须在同一个 batch。正常路径不允许先提交 `failed` 再另开事务返还。冲突的唯一结果是整批回滚，调用方丢弃这次计划并从头重读。`where` 影响 0 行然后继续插入返还，不是合法实现。

已有 `video_credit:return:{generationId}` 行时，重放直接返回，不再改余额。operation 只有 `completed`，因此行存在就表示整批已经提交。幂等键保持：

- 操作键：`video_credit:return:{generationId}`
- 返还流水：`entitlement:video_generation:{generationId}:grant:{grantId}:refund`
- clawback 流水：同一前缀加 `:clawback`
- forfeit、expire 仍使用 `:forfeit`、`:expire`

返还批次来自原 consume 流水，而不是来自当前余额：

```text
source_type = video_generation
source_id = generationId
transaction_type = consume
```

每条流水的 `grant_id` 和 `abs(quantity)` 是一条 `ConsumeLine`。禁止新开永不过期积分包。

`planCreditReturn` 对每个原 grant 按这个顺序处理数量 `T`：

1. 补收现金 shortfall。`outstanding = shortfall_quantity - 已结算 quantity`。按 `created_at`、再按 adjustment id 取用。`C = min(T, outstanding 合计)`。
2. 剩余 `rest = T - C`。
3. `policyRevoked = true`：`rest` 记为 forfeit。不把该 grant 上原有剩余一并没收。
4. 否则，`expires_at <= now`：`rest` 记为 expired，并把该 grant 当前剩余 sweep 进同一条 expire 流水。
5. 否则：`rest` 成为可消费余额。

流水顺序固定为：

| 顺序 | 类型 | 数量 | source_type | 键后缀 |
| --- | --- | --- | --- | --- |
| 1 | `refund` | `+T` | `video_generation_return` | `:refund` |
| 2 | `revoke` | `-C`，C 为 0 则不写 | `video_generation_return_clawback` | `:clawback` |
| 3 | `revoke` | `-forfeit`，为 0 则不写 | `video_generation_return_forfeit` | `:forfeit` |
| 4 | `expire` | `-(expired + sweep)`，为 0 则不写 | `video_generation_return_expiry` | `:expire` |

键的前缀是 `entitlement:video_generation:{generationId}:grant:{grantId}`。operation 行：

- 键：`video_credit:return:{generationId}`
- `intended = T 的合计`
- `intended = spendable + expired + clawback + forfeited`
- `expired_quantity` 只统计本次返还里到期的部分。sweep 由 expire 流水重建：`sweep = -expire.quantity - expired_quantity`

grant 更新直接落到计划的 `nextRemaining` 和 `nextStatus`，守卫仍是 `CASE remaining = expected ELSE -1`。最后一条流水的 `balance_after` 必须等于 `nextRemaining`。`remaining + T > granted` 时计划返回 `return_exceeds_grant`，写入器不得执行。

`policyRevoked` 由写入器传入。现金退款把余额扣到 0 时，现有 Webhook 也会把 status 写成 `revoked`，流水 `source_type` 是 `refund`。这种行必须传 `policyRevoked = false`。只有存在非 `refund`、也不是视频返还 clawback/forfeit 的 revoke，才传 `true`。

## 4.1 现金退款与返还的共享守卫

现金退款和视频返还共用 `billing_orders.refund_version`。它不再只表示退款行数；每笔成功的现金退款 batch 和每笔成功的视频返还 batch 都把它加 1。退款比例仍由退款行和 `planGrantRefundReversal` 计算，不读这个版本号。原 billing 表不新增列。

只把 grant 的 `UPDATE` 移出 `appliedQuantity > 0` 不够。applied 为 0 时，退款把余额写成原值，净变化为 0 的返还也把余额写成原值。两条 batch 的 `remaining = expected` 会同时成立。D1 batch 各自原子也不能让它们看见对方尚未提交的计划。

守卫失败必须让语句本身失败，从而回滚整个 batch。做法是 `CASE ... ELSE -1`，并由已有 `CHECK` 拒绝 `-1`：

- `billing_orders.refund_version >= 0`
- `entitlement_grants.remaining_quantity >= 0`
- `video_generations.status_version >= 1`
- `video_outbox.delivery_attempt_count >= 0`

`WHERE remaining = :expected` 或 `WHERE refund_version = :expected` 命中 0 行时，SQLite 认为语句成功。后面的返还插入仍会提交。协议禁止这种写法。`WHERE` 只允许主键：`id = :id`。比较放在 `CASE` 里。

纯函数 `evaluateSharedSettlementGuard` 的失败模式只有 `abort_batch`。裁决顺序固定：

1. claim 形状。grant 列表为空仍是 `missing_order_fence`，这不是零报价失败的入口。
2. `source_type = order` 的 grant 必须带上 `source_id` 对应订单的 `refund_version`。其他已消费来源的 `orderId` 必须为空，不为它们制造订单。缺订单围栏仍是 `missing_order_fence`。
3. 按 `order id` 升序比较实际出现的 `refund_version`。不一致是 `stale_refund_version`。没有订单语句的非 order 返还跳过这一步。余额有没有变化都不跳过 grant 检查。
4. 按 `grant id` 升序比较 `remaining` 和 `status`。`nextRemaining = expectedRemaining` 也要比较。不一致是 `stale_grant`。
5. 这些 grant 上当前存在的每条 adjustment 都必须出现在观测列表里。漏掉新插入的 adjustment，或 `shortfall` / 已结算量与读取值不同，是 `stale_settled`。
6. `expectedSettled + claimQuantity <= expectedShortfall`。超出是 `settlement_exceeds_shortfall`。adjustment 的 `grant_id` 必须等于 settlement 的 `grant_id`。

`cashRefundGuardClaim` 在 `appliedQuantity = 0` 时仍然产出 grant 写。`nextRemaining` 等于读取到的剩余。没有“applied 为 0 就省略 grant 语句”的分支。

### 读取顺序

返还 batch 在打开写入 batch 之前，按这个顺序读，不写：

1. `video_generations` 的 `status`、`status_version`、`deadline_at`。
2. 第 11 节要求的 attempt 和 outbox lease：`lease_owner`、`lease_token`、`lease_until`。
3. 若 `video_credit:return:{generationId}` 已存在，直接返回，不打开 batch。
4. 该 generation 的 consume 流水。
5. 这些流水指向的 grant：`remaining_quantity`、`status`、`granted_quantity`、`expires_at`、`source_type`、`source_id`、`user_id`。来源仍是 `order` 时才读第 6 步的订单。`subscription_cycle`、`admin`、`migration`、`promotion` 原路回到同一条 grant，不创建订单，不加 `refund_version`。已经写入 consume 流水的来源，即使以后移出允许列表，仍然原路返还，不在消费之后拒绝。不支持的来源在 `planCreditConsumption` 产生扣费行之前就返回 `unsupported_source`。
6. 仅对 `source_type = 'order'` 的 grant 读取 `billing_orders.refund_version`，`source_id` 就是订单 id。其他来源没有这笔读取。
7. 这些 grant 的 adjustment：`id`、`grant_id`、`shortfall_quantity`、`created_at`。不更新这些列。
8. `sum(billing_refund_credit_settlements.quantity)`，按 `adjustment_id` 分组。
9. 调用 `planCreditReturn`，再用 `returnGuardClaim` 把计划和上述读数包成 claim。

现金退款未来的读取顺序见第 13 节。算法仍是现有的 `planGrantRefundReversal`。

### 返还 batch 的语句顺序

下面全部在同一个 D1 batch。任一语句失败，整批回滚，调用方从读取顺序第 1 步重来。

1. 每个相关订单一条 `UPDATE`，`order id` 升序。即使 clawback 为 0、余额净变化为 0，也执行。观测谓词按该订单下每个 grant 的每条 adjustment 展开：

```sql
update billing_orders
set updated_at = :now,
    refund_version = case
      when refund_version = :expectedVersion
       and (
         select count(*)
         from billing_refund_credit_adjustments
         where grant_id = :grantId
       ) = :expectedAdjustmentCount
       and (
         select a.shortfall_quantity
         from billing_refund_credit_adjustments a
         where a.id = :adjustmentId
           and a.grant_id = :grantId
       ) = :expectedShortfall
       and (
         select coalesce(sum(s.quantity), 0)
         from billing_refund_credit_settlements s
         where s.adjustment_id = :adjustmentId
       ) = :expectedSettled
       and :expectedSettled + :claimQuantity <= :expectedShortfall
      then :expectedVersion + 1
      else -1
    end
where id = :orderId
```

多个 grant 或多个 adjustment 时，把同样的 `and` 谓词按每条观测继续放进同一个 `WHEN`。当时没有 adjustment 时只保留 `count(*) = 0`，不编一个不存在的 adjustment id。子查询比较出 NULL 时，`WHEN` 不成立，走 `ELSE -1`。

2. 每个计划中的 grant 一条 `UPDATE`。净变化为 0 也执行。`WHERE` 只有主键：

```sql
update entitlement_grants
set remaining_quantity = case
      when remaining_quantity = :expectedRemaining
       and status = :expectedStatus
      then :nextRemaining
      else -1
    end,
    status = case
      when remaining_quantity = :expectedRemaining
       and status = :expectedStatus
      then :nextStatus
      else status
    end,
    updated_at = :now
where id = :grantId
```

SQLite 对同一条 `UPDATE` 的赋值使用原行。两个 `CASE` 看到的都是读取时要校验的剩余和状态。

3. 第 11 节的 generation 状态语句。失败落账和成功落账都用它。成功落账不执行本列表的其余返还语句。
4. 先插入 clawback / forfeit / expire 流水和 `completed` 的 return operation，再插入 settlement。clawback 为 0 时不插 clawback 流水，也不插 settlement。
5. 关闭校验再次写入同一个订单版本。关系不成立时写成 `-1`，整批回滚，包括前面的版本加 1：

```sql
update billing_orders
set refund_version = case
      when refund_version = :expectedVersion + 1
       and (
         select clawback_quantity
         from video_credit_operations
         where id = :returnOperationId
           and operation_type = 'return'
           and generation_id = :generationId
       ) = (
         select coalesce(sum(quantity), 0)
         from billing_refund_credit_settlements
         where return_operation_id = :returnOperationId
       )
       and (
         select coalesce(sum(quantity), 0)
         from billing_refund_credit_settlements
         where return_operation_id = :returnOperationId
           and grant_id = :grantId
       ) = :grantClawback
       and (
         case
           when :grantClawback = 0 then not exists (
             select 1 from entitlement_transactions
             where idempotency_key = :clawbackKey
           )
           else (
             select -quantity
             from entitlement_transactions
             where idempotency_key = :clawbackKey
               and source_type = 'video_generation_return_clawback'
               and source_id = :generationId
               and grant_id = :grantId
               and transaction_type = 'revoke'
           ) = :grantClawback
         end
       )
      then refund_version
      else -1
    end
where id = :orderId
```

`evaluateClawbackLinkage` 是第 5 步的纯函数形式。operation 的 `clawback_quantity` 等于本 operation 的 settlement 合计。每个 grant 的 settlement 合计等于 clawback 流水的相反数。累计已结算量不得超过该 adjustment 的原 `shortfall_quantity`。idempotency key 必须仍是 `:clawback` 那个稳定键。

`0002` 的 `BEFORE INSERT` 触发器是最后一道约束，不是 0 行 `WHERE` 的替代品。它在插入时 `RAISE(ABORT)`：grant 与 adjustment 不一致、累计 settlement 超过 shortfall、return operation 不存在，或 clawback 流水还不够覆盖本次插入。触发器失败同样回滚整批。写入器仍然要先做版本和已结算量的 `CASE`，这样失败后会重读并重算，而不是把超额插入留到触发器才发现却沿用旧计划。

返还 batch 不更新、不删除 `billing_refund_credit_adjustments`。不从其他订单的 adjustment 借额度。非 `order` grant 的返还 batch 不写 `billing_orders`。同一 batch 里混合两种来源时，只给 `order` grant 发出版本语句；每条 grant 仍有自己的失败型余额 `CASE`。

## 4.2 零报价失败

报价为 0 的任务没有 grant，也没有订单。`evaluateSharedSettlementGuard` 对空 grant 列表仍然返回 `missing_order_fence`。零报价失败不调用它，也不把空 claim 当成成功。

进入这个分支要同时满足：

- `quoted_credits = 0`
- 已有一条 `consume` operation，generation 匹配，`intended`、`spendable`、`expired`、`clawback`、`forfeited` 都是 0
- 不存在 `source_type = video_generation` 且 `transaction_type = consume` 的流水
- 第 11 节的失败事件、版本和 lease 全部成立

缺 operation 是 `missing_consume_operation`。有消费流水是 `consume_ledger_present`。报价或数量不是 0 是 `not_zero_consume`。终态不合法时沿用第 11 节的原因。失败模式都是 `abort_batch`。

同一个 batch 里先跑失败状态语句，并在 `status_version` 的 `CASE` 中重查零 operation 和“没有消费流水”。然后插入一条数量全 0 的 return operation。不插入任何 `entitlement_transactions`，包括数量为 0 的行。不更新 grant，不更新订单。`evaluateZeroConsumeFailure` 返回的 `ledger` 是空数组。

## 5. 数字协议

购买 10，视频消费 6，剩余 4。下面的“返还前”都指现金退款 batch 已经提交后的行。

### 5.1 全额现金退款，随后视频失败

退款目标 10，当时只能回收 4，shortfall 6，grant 剩余 0，status `revoked`。视频失败返还 6：

- clawback 6，spendable 0，next remaining 0，status 保持 `revoked`
- 流水：`refund +6`（0 到 6），`revoke -6`（6 到 0）
- 新增 settlement：该 adjustment 6
- adjustment 的 `shortfall_quantity` 仍是 6

用户可消费余额是 0。

### 5.2 部分现金退款

50% 退款的累计目标是 `floor(10 * refund / paid) = 5`。当时剩余 4，所以 applied 4，shortfall 1，剩余 0。返还 6：

- clawback 1，spendable 5，next remaining 5，status 改为 `active`
- settlement 数量 1
- 原 adjustment 的 shortfall 1 不改

净额是 `10 - 5 = 5`。

### 5.3 两个 grant

到期较早的 grant 先被消费。返还按各条 consume 流水回到原 grant，再各自补收该 grant 的 shortfall。一个 return operation 可以插入多条 settlement，唯一键是 `(adjustment_id, return_operation_id)`。

### 5.4 消费后到期，再失败

剩余 4 且 `expires_at <= now`，没有 shortfall，返还 6：

- expired 6，sweep 4，spendable 0，next remaining 0，status `expired`
- 流水：`refund +6`（4 到 10），`expire -10`（10 到 0）
- operation.expired 是 6。sweep 4 留在 expire 流水里

### 5.5 政策撤销

剩余 4，政策撤销，返还 6：forfeit 6，sweep 0，next remaining 仍是 4，status 保持 `revoked`。这 4 不是可消费余额。

### 5.6 顺序和并发

视频返还先提交、全额退款后重试：返还把剩余从 4 恢复到 10，并把 `refund_version` 加 1。退款 batch 的版本 `CASE` 得到 `-1`，整批回滚。重试读到 10，applied 10，shortfall 0，剩余 0。

退款先提交、返还后重试：退款即使 applied 为 0 也写过 grant `CASE`，并把版本加 1。返还按第 4.1 节重读后走 5.1，settlement 补上 shortfall 6，剩余 0。

两个 batch 同时拿旧剩余或旧版本时，后提交的 `CASE` 得到 `-1`，整批回滚并按新行重算。adjustment 只插入一次，冲突仍使用现有 `onConflictDoNothing`。settlement 只追加。任何路径都不更新旧 shortfall。

### 5.7 零回收和净变化为零

剩余已经是 0，退款目标 6，applied 0，shortfall 6。退款 batch 仍执行 grant `CASE`：期望剩余 0，下一个剩余也是 0。同时 `refund_version` 加 1。

此时若返还已按“没有 shortfall”计划把剩余从 0 加到 6，它读到的版本已过期，订单 `CASE` 写成 `-1`，返还整批回滚。重试看到 shortfall 6，按 5.1 补收。

反过来，返还先把剩余加到 6 并加版本。退款仍拿着期望剩余 0：grant `CASE` 写成 `-1`，退款整批回滚。重试按新的剩余计算 applied，不留下“钱已退、积分又可用、shortfall 却按 0 剩余记账”的 adjustment。

只抬高版本、不写 grant `CASE`，挡不住消费把剩余改掉而不碰 `refund_version`。只写 grant `CASE`、不抬高版本，挡不住两条净变化为 0 的 batch：剩余前后都是 0，`remaining = 0` 同时成立。两个围栏都要出现在同一个 batch 里。

### 5.8 两个任务补收同一 shortfall

grant 10。任务 A 消费 6，任务 B 消费 4，剩余 0。部分退款目标 6，当时 applied 0，shortfall 6。A 和 B 都读到已结算 0、同一个 `refund_version`。

若两份计划都提交，A 会记 settlement 6，B 会记 settlement 4，合计 10，超过 shortfall 6，用户可消费余额变成 0。这是非法结果。

后提交的 batch 在订单 `CASE` 上失败并整批回滚，然后重读：

- A 先成功：settlement 6，剩余仍是 0，shortfall 列仍是 6。B 重算时已结算 6，clawback 0，可消费 4，剩余 4。
- B 先成功：settlement 4，剩余 0，shortfall 列仍是 6。A 重算时只再补收 2，可消费 4，剩余 4。

两条路径的最终合计都是补收 6、可消费 4、原 shortfall 6。`returnGuardClaim` 会把当时读到的已结算量放进观测。版本碰巧被写成新值、已结算量仍是 0 时，裁决是 `stale_settled`，同样 `abort_batch`。不向别的订单借这 6。A、B 的操作键仍分别是 `video_credit:return:gen-a` 和 `video_credit:return:gen-b`。

重复或乱序：

- 同一退款 ID 已有 adjustment 时，现有代码直接成功返回，不重新计算 shortfall。
- 同一返还键已存在时，不再改余额。
- 先失败后到账的重复 `checkout.completed` 按第 6 节处理，不把剩余恢复成初始值。
- `refunded` 或 `partially_refunded` 上的迟到支付通知保持现有提前成功返回。

## 6. Creem 重复到账

当前 `server/api/webhooks/creem.post.ts` 的 `grantMatchesExpected` 要求 `remainingQuantity` 等于初始发放量，且 `status = active`。`ensureOrderCreditFulfillment` 用 `onConflictDoNothing` 插入后调用它。订单仍是 `paid` 时，重复的合法 `checkout.completed` 会走这条校验。消费已经改变剩余后，校验返回 `ENTITLEMENT_GRANT_MISMATCH`。

P2.3 或后续单独授权的支付修复要把“合法履约”改成只核对不可变发放事实和原始 grant 流水：

- grant：`id`、`user_id`、`entitlement_key`、`entitlement_type`、`source_type`、`source_id`、`period_key`、`granted_quantity`、`effective_at`、`expires_at`
- 原始流水：既有 idempotency key，`transaction_type = grant`，`quantity = granted_quantity`，`balance_before = 0`，`balance_after = granted_quantity`，`source_type = order`，`source_id = order id`

剩余和 status 可以因消费、到期、退款或撤销而不同。此时结果是成功。插入保持 `onConflictDoNothing`，不新增 grant，不把剩余写回初始值。

以下仍然是履约损坏：

- grant 不存在：`ENTITLEMENT_GRANT_MISSING`
- 不可变 grant 字段不一致：`ENTITLEMENT_GRANT_MISMATCH`
- 原始 grant 流水缺失或不一致：`ENTITLEMENT_TRANSACTION_MISSING` / `ENTITLEMENT_TRANSACTION_MISMATCH`

保留现有 webhook event 的 processed 短路、订单 `refund_version`、退款比例、`planGrantRefundReversal`，以及 `refunded` / `partially_refunded` 的迟到支付短路。本轮没有改这些代码。

这组核对是开放消费的前置条件，不是可以和第一条消费请求并行的后续优化。在 `grantMatchesExpected` 仍比较剩余和 status 时，消费会把合法的重复 `checkout.completed` 报成履约损坏。因此在第 13 节的 Webhook 接点落地之前，不得启用消费或返还写入器。

## 7. Attempt、Outbox 和成本

当前单步任务的 `step_id` 固定为 `generate`。`submit_key` 为 `video_submit:{generationId}:{stepId}:{attemptNumber}`。

Attempt 在调用 Provider 之前插入，`acceptance_status = not_submitted`，`provider_request_id` 为空。调用结果：

| 结果 | acceptance | provider_request_id | 下一步 |
| --- | --- | --- | --- |
| 明确接受 | `accepted` | 必填 | 轮询已有 attempt |
| 明确拒绝 | `rejected` | 必须为空 | 才能使用下一个 attempt number |
| 调用失败或不确定 | `unknown` | 必须为空 | 只恢复，不新建提交 |

`(generation_id, step_id)` 在 `not_submitted`、`unknown`、`accepted` 上部分唯一。重复队列消息找到现有 `submit_key`，不插入新 attempt。`(provider_id, provider_request_id)` 在 request id 非空时唯一。

Outbox 的 payload 只带 `eventId`、`generationId`、`eventType`、`payloadVersion`。同一 `(generation_id, event_type)` 同时只能有一条 `pending` 或 `leased`。重试把同一行从 `leased` 改回 `pending`，并写 `next_retry_at`。进入 `dead` 的次数由 P2.3 Worker 决定，本协议不预设上限。

成本按 `(attempt_id, cost_kind)` 一行。`amount_unit` 固定为 `micro`，1 主币单位等于 1,000,000 micro。

`0001` 的金额 CHECK 在金额或币种为 NULL 时，比较结果是 NULL。SQLite 把 NULL 的 CHECK 当成通过，所以 `estimated` 可以带上空金额。`0001` 不改。`0002_provider_cost_check` 重建 `video_provider_costs`，用 `CASE` 得到 0 或 1：

- `unknown`：`amount_micros` 和 `currency` 都是 NULL。空金额不是 0。
- `estimated` 或 `actual`：两列都 `IS NOT NULL`，`typeof(amount_micros) = 'integer'`，金额大于或等于 0，币种匹配 `glob '[A-Z][A-Z][A-Z]'`。明确的 0 成本配 `USD` 这类三位大写字母币种，仍然合法。`usd`、`US`、`US1`、负数和非整数不合法。
- 同一 Provider 的 `provider_bill_id` 非空时唯一。重复回调冲突后不覆盖金额；金额不一致交给人工核对。
- 报表对每个 attempt 采用 actual，否则 estimated，否则 unknown。两类已知金额不能相加。

重建使用暂存表名。SQLite 3.25 及之后的 `ALTER TABLE RENAME` 会把 CHECK 里的表名改成 `video_provider_costs`。`0002` snapshot 记录的是改名之后的谓词。

## 8. 资产归属

`video_assets` 保存私有 R2 object key，不保存公开永久 URL。`(id, user_id)` 唯一，generation 的图片、参考视频和输出以复合外键指向它。SQLite 对可空复合外键使用 MATCH SIMPLE：资产 ID 为空时不检查，资产 ID 有值时必须和同一个 `user_id` 匹配。输出只在 `succeeded` 时必填。`failed` 与 `needs_review` 必须有错误码和时间；只有 `succeeded` 和 `failed` 写 `terminal_at`。

## 9. 测试

纯函数用例在 `packages/data/test/settlement-contract.test.ts` 和 `packages/data/test/settlement-guard.test.ts`。迁移形状在 `packages/data/test/migration-shape.test.ts`。本轮未运行。

守卫测试覆盖：applied 为 0 仍产生 grant 写；只改版本或只改剩余都会 `abort_batch`；净变化为 0 时剩余相同仍因 `refund_version` 失败；A/B 并发补收在两种提交顺序下都只结算 6、可消费 4、shortfall 仍是 6；clawback 流水、grant 和 settlement 不一致时失败；`succeeded` 加最新版本不能进入 `failed`；lease 丢失是 `lease_not_held` 而不是继续；known 0 与 unknown NULL 合法，空金额和非字母币种非法。来源测试覆盖：撤销但余额不变的消费整批失败；归属、权益、到期和不支持来源失败；order 与 promotion 一起扣费，返还只围栏 order；已消费的 promotion 可以原路返还；空 claim 仍是 `missing_order_fence`；零报价失败要求真实的零 consume operation 和零条消费流水，return 的流水数组为空。

写入器实现后还要有数据库用例：

| 用例 | 期望 |
| --- | --- |
| 两个请求同时消费最后 6 分 | 一个成功，另一个 `CASE` 失败并整批回滚 |
| 相同 key 与相同哈希重放 | 返回原任务，consume operation 仍是一条 |
| 相同 key 与不同哈希 | 409，余额不变 |
| 报价 0 | 有任务和 outbox，没有流水 |
| 全额退款后的失败返还 | 余额 0，settlement 6，adjustment shortfall 仍是 6 |
| 部分退款后的失败返还 | 补收 1，恢复 5，status `active` |
| 返还先于全额退款 | 退款重试后余额 0，shortfall 0 |
| 零回收与返还交错 | 后提交者整批回滚；重试后不会同时留下可消费积分和未补收的 shortfall |
| 5.8 的 A/B 并发返还 | 只补收 6，可消费 4，原 shortfall 仍是 6 |
| 两个 batch 交错 | 失败者重试，最终余额与先成功者的历史一致 |
| 到期后返还 | expire 流水包含 sweep，可消费余额 0 |
| 政策撤销后返还 | 无关剩余仍在行上，status 保持 `revoked` |
| 重复返还 | 第二批唯一冲突，余额只变化一次 |
| `succeeded` 加最新版本再投失败 | 语句失败，没有 return operation |
| 合法失败但 lease 已丢失 | 整批回滚，余额不变 |
| `output_stored` | 进入 `succeeded`，没有 return operation |
| 重复合法支付通知 | 不新发积分，不恢复初始剩余，不报履约损坏 |
| 不可变 grant 字段被改 | 仍是 `ENTITLEMENT_GRANT_MISMATCH` |
| 重复队列消息 | attempt 数不增加；`unknown` 不产生新的 submit |
| 重复账单回调 | actual 仍是一行；unknown 不被当成 0；known NULL 被拒绝 |
| 迁移 | 0000 与 0001 字节不变；0002 只重建成本表并追加触发器 |

数据库验证步骤见第 12 节。授权执行测试之前，不把这些用例写成已通过。

## 10. 本阶段没有实现的部分

没有 D1 结算写入器、Webhook 修改、Worker、队列、R2、视频 HTTP API、UI 或真实 Provider。活跃任务数量上限也没有表；先计数再插入会竞态，写 API 前要单独决定方案。第 4.1 节和第 11 节的 SQL 是写入器规范，本轮没有执行器去跑它们。

## 11. 失败与成功落账

`evaluateTerminalGuard` 先看当前状态和事件，再看版本，再看 lease。版本相等不能把非法事件变成合法事件。

| 原状态 | 事件 | 新状态 | 返还 | lease |
| --- | --- | --- | --- | --- |
| `queued` | `deadline_reached` | `failed` | 是 | outbox `start_submission` 仍被调用方持有，且 `deadline_at <= now` |
| `submitting` | `submission_rejected` | `failed` | 是 | 当前 attempt |
| `processing` | `provider_failed` | `failed` | 是 | 当前 attempt |
| `storing` | `storage_irrecoverable` | `failed` | 是 | 当前 attempt，以及 outbox `store_output` |
| `needs_review` | `recovery_confirmed_absent` | `failed` | 是 | 当前 attempt |
| `needs_review` | `provider_failed` | `failed` | 是 | 当前 attempt |
| `storing` | `output_stored` | `succeeded` | 否 | 当前 attempt，以及 outbox `store_output` |

`succeeded` 和 `failed` 没有出向事件。`needs_review` 本身不结算。上表以外的组合，包括 `succeeded` + `provider_failed`，裁决是 `illegal_transition`，失败模式 `abort_batch`。

lease 在更早的 batch 里取得。落账 batch 不负责首次领取，只在状态 `CASE` 里重读它。谓词放在 `status_version` 的 `CASE` 中，`WHERE` 只有 generation 主键。lease 不匹配时写成 `-1`，`status_version >= 1` 让整批失败。不允许先用 `WHERE lease_token = :token` 更新 0 行，再插入返还。

失败落账：

```sql
update video_generations
set status = 'failed',
    error_code = :errorCode,
    error_at = :now,
    terminal_at = :now,
    updated_at = :now,
    status_version = case
      when status = :fromStatus
       and status_version = :expectedVersion
       and (
         (status = 'queued' and :event = 'deadline_reached' and :deadlineAt <= :now)
         or (status = 'submitting' and :event = 'submission_rejected')
         or (status = 'processing' and :event = 'provider_failed')
         or (status = 'storing' and :event = 'storage_irrecoverable')
         or (status = 'needs_review' and :event = 'recovery_confirmed_absent')
         or (status = 'needs_review' and :event = 'provider_failed')
       )
       and (
         status = 'queued'
         or exists (
           select 1 from video_attempts
           where id = :attemptId
             and generation_id = video_generations.id
             and lease_owner = :leaseOwner
             and lease_token = :leaseToken
             and lease_until > :now
         )
       )
       and (
         not (
           (status = 'queued' and :event = 'deadline_reached')
           or (status = 'storing' and :event = 'storage_irrecoverable')
         )
         or exists (
           select 1 from video_outbox
           where id = :outboxId
             and generation_id = video_generations.id
             and event_type = case
               when status = 'queued' then 'start_submission'
               else 'store_output'
             end
             and delivery_status = 'leased'
             and lease_owner = :leaseOwner
             and lease_token = :leaseToken
             and lease_until > :now
         )
       )
      then :expectedVersion + 1
      else -1
    end
where id = :generationId
```

`queued` 不要求 attempt。其他失败行要求 attempt lease。`storage_irrecoverable` 还要求 `store_output`。`deadline_reached` 要求 `start_submission`。

成功落账只接受 `storing` 加 `output_stored`。`output_asset_id` 必须是本次写入的非空资产。`creditReturn` 为 false：batch 里不调用 `planCreditReturn`，不改 grant，不加 `refund_version`，不插入 return operation。状态语句失败则输出登记一并回滚。

```sql
update video_generations
set status = 'succeeded',
    output_asset_id = :outputAssetId,
    terminal_at = :now,
    updated_at = :now,
    status_version = case
      when status = 'storing'
       and status_version = :expectedVersion
       and :event = 'output_stored'
       and :outputAssetId is not null
       and exists (
         select 1 from video_attempts
         where id = :attemptId
           and generation_id = video_generations.id
           and lease_owner = :leaseOwner
           and lease_token = :leaseToken
           and lease_until > :now
       )
       and exists (
         select 1 from video_outbox
         where id = :outboxId
           and generation_id = video_generations.id
           and event_type = 'store_output'
           and delivery_status = 'leased'
           and lease_owner = :leaseOwner
           and lease_token = :leaseToken
           and lease_until > :now
       )
      then :expectedVersion + 1
      else -1
    end
where id = :generationId
```

当前状态是 `succeeded` 时，上面的失败语句和这条成功语句都不匹配，都会写成 `-1`。版本号相等不够。

需要结束的 outbox 行用同一 batch 里的失败值，而不是过滤 `WHERE`：

```sql
update video_outbox
set delivery_status = 'delivered',
    delivered_at = :now,
    lease_owner = null,
    lease_token = null,
    lease_until = null,
    updated_at = :now,
    delivery_attempt_count = case
      when id = :outboxId
       and generation_id = :generationId
       and delivery_status = 'leased'
       and event_type = :outboxEvent
       and lease_owner = :leaseOwner
       and lease_token = :leaseToken
       and lease_until > :now
      then delivery_attempt_count
      else -1
    end
where id = :outboxId
```

`delivery_attempt_count >= 0` 拒绝 `-1`。这只结束调用方仍持有的那次 lease。

## 12. 后续数据库验证

本轮不应用迁移，也不跑这些语句。取得本地库授权后，在空的 SQLite 或本地 D1 上依次应用 `0000`、`0001`、`0002`，然后核对：

1. `0000` 与 `0001` 文件哈希仍是测试里的常量。`sqlite_master` 里 `video_provider_costs` 的金额 CHECK 含 `typeof`、`is not null` 和 `glob '[A-Z][A-Z][A-Z]'`。
2. 插入 `estimated`、金额 0、币种 `USD` 成功。插入 `unknown`、金额 NULL、币种 NULL 成功。
3. 下列插入失败：`estimated` 金额 NULL；`estimated` 币种 NULL；`actual` 金额 `-1`；币种 `usd`、`US`、`US1`；`unknown` 金额 0。
4. 准备 grant 10、订单 `refund_version = 7`、A 消费 6、B 消费 4、一条 shortfall 6 且 applied 0 的 adjustment。开两个事务，都读到已结算 0 和版本 7。
5. 第一个事务按第 4.1 节提交 A 的返还，clawback 6。第二个事务仍带着版本 7 和已结算 0 提交 B 的 clawback 4。期望第二个事务因 CHECK 或触发器整笔回滚，不留下 B 的 settlement 或余额变化。
6. B 按新读数重放：已结算 6，clawback 0，剩余 4。`shortfall_quantity` 仍是 6。再按相反顺序重做一次：B 先补 4，A 再补 2，合计仍是 6，剩余 4。
7. 将 generation 设为 `succeeded` 且 `status_version` 等于读取值，再跑第 11 节的失败语句。期望语句失败，没有 return operation。
8. 合法 `processing` → `provider_failed`，但 attempt lease 已过期。期望整批回滚，grant 剩余不变。
9. 消费 batch 读到 `status = active`、剩余 6。提交前把同一行改成 `revoked` 且剩余仍是 6，再执行第 3 节的 `CASE`。期望 `-1` 被 CHECK 拒绝，generation、流水和 outbox 都没有留下。`WHERE status = 'active'` 这种 0 行更新不能当作通过。
10. 同一用户一条 order grant 和一条 promotion grant。扣费用第 3 节两条 `CASE`。失败返还只更新 order 的 `refund_version`；promotion 不插入订单。两条 grant 都回到原行。
11. 读集里放一条 `source_type` 不在允许列表的 grant，即使另一条 order grant 足够支付。期望扣费计划失败，余额不变。
12. 报价 0：consume operation 五列数量都是 0，没有 consume 流水。合法失败后同一 batch 插入全 0 的 return operation，仍然没有积分流水。若先插入一条 consume 流水再跑这段 `CASE`，期望整批回滚，不出现 return operation。

## 13. 后续 Webhook 的最小接点

本轮不改 `server/api/webhooks/creem.post.ts`。开放消费前，同一次授权里只改这两处，其余执行路径保持不动：

1. `grantMatchesExpected`：按第 6 节只比较不可变发放事实和原始 grant 流水。不再要求 `remainingQuantity` 等于初始发放量，也不再要求 `status = active`。
2. `applyRefundCreated`：对每个 `plan`，包括 `appliedQuantity = 0`，都发出第 4.1 节的 grant `CASE`。`nextRemaining = remaining - applied`；applied 为 0 时下一个剩余等于当前剩余。`WHERE` 只有 grant 主键。现有的订单 `refund_version` `CASE` 留在同一 batch，并且仍然先执行。不要改 `planGrantRefundReversal`、实付分母、累计比例、grant 过滤、adjustment 列或 `onConflictDoNothing`。

返还写入器以后也要加同一订单的 `refund_version`，并带上已结算量谓词。那不是 Webhook 里的代码。在第 1 点和第 2 点进入执行文件之前，消费和返还写入器都不启用。
