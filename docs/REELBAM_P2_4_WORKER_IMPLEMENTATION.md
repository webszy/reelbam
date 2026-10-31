# Reelbam P2.4 — 异步生成任务引擎

状态：内部服务、Outbox、独立 Video Worker 和 Mock 闭环已写入。下面列出的测试已实际执行。没有公开生成 API，没有真实 Provider，没有部署，没有远端迁移。完成后停止，等待 GPT Review，不进入 P2.5。

P2.3 的 `prepareConsumeCharge` / `commitConsumePlan` 可以把 generation 插入和 outbox 插入放进同一次 `database.batch`。失败终态继续调用 `returnCreditsForFailedGeneration`。P2.3 没有成功落账写入器。本阶段按结算设计第 11 节补了 `insertOutputAndSucceed`：它只登记资产并把 `storing` 收到 `succeeded`，不改 grant、不写返还流水。

## 1. 创建任务和 Outbox 的事务边界

入口：`server/services/video/create-generation.ts` 的 `createGeneration`。没有 HTTP 路由。

调用方传入已经可信的 `userId`、幂等键、未信任的输入对象、服务端报价和截止时间。函数不接受客户端指定的 Provider 地址、API Key、扣费金额、任务状态或余额。报价只接受 `parseCreditQuoteSnapshot` 的五字段快照。模型、能力和路线由传入的 `ModelRegistry` / `ProviderRegistry` 决定，结果冻结进 `route_snapshot`。

同一个 `database.batch` 的顺序：

1. `composeBefore`：插入 `video_generations`，`status = queued`，`status_version = 1`。
2. P2.3 消费围栏、grant `CASE`、consume 流水、consume operation、close-check。
3. `composeAfter`：插入 `video_outbox`，事件 `start_submission`，`delivery_status = pending`。

任一语句失败，整批回滚。余额不足在开批之前返回，不留 generation、operation 或 outbox。Outbox 插入失败同样回滚扣费。相同 `userId + idempotencyKey` 且规范化输入哈希相同，返回原任务，不再扣费。哈希不同返回 `idempotency_conflict`。唯一约束冲突或 `LedgerCommitUnknown` 会按幂等键重读，不会换一个新任务再扣一次。

`canonicalizeGenerationInput` 只含模型、模式、参数和资产 ID。签名 URL、随机数和当时的默认 Provider 不进入哈希。

Queue `send` 在这次提交之后。发送失败只把 outbox 留在 `pending`。创建结果仍然是已排队任务。

## 2. Queue、DLQ 和消息

资源名：

| 资源 | 名称 |
| --- | --- |
| 主队列 | `reelbam-video-jobs` |
| DLQ | `reelbam-video-jobs-dlq` |

DLQ consumer 没有自己的 dead letter queue，避免循环。Video Worker 用 `batch.queue` 区分两条队列。无法识别的队列只 ack，不改任务。

消息只有：

```json
{
  "messageVersion": 1,
  "eventId": "<outbox id>",
  "generationId": "<id>",
  "eventType": "start_submission | poll_status | store_output",
  "stepId": "generate",
  "attemptId": "<id 或 null>"
}
```

没有余额、价格、密钥或任务状态。Consumer 读 D1。Outbox payload 是同一份指针。

投递：

- Dispatcher 先领取 outbox，再 `send`。
- 发送失败：释放为 `pending`，写 `queue_send_failed`，稍后重发。
- 发送成功：释放领取并写 `next_retry_at`，不把“已发送”当成业务完成。Consumer 在步骤落库时才把该行标成 `delivered`。
- 发送成功但释放更新中断：行保持 `leased`。租约到期后可以再发。Consumer 按 D1 状态幂等。
- 领取者崩溃：`lease_until` 过后其他执行者回收。

生产用的根 `wrangler.jsonc` 没有 queue 或 R2。Nuxt 的 producer 只写在 `wrangler.video-local.jsonc`，给显式的本地全模式使用。`nuxt.config.ts` 仍指向 `./wrangler.jsonc`。

## 3. Video Worker

目录 `workers/video-worker/`：

| 文件 | 作用 |
| --- | --- |
| `src/index.ts` | queue、scheduled、以及一律 404 的 fetch |
| `src/queue.ts` | 按队列名分发，DLQ 不直接判失败 |
| `src/maintenance.ts` | 调用数据层定时恢复 |
| `src/generation-runner.ts` | 装配 D1、R2、Mock registry |
| `src/storage.ts` | R2 `put` / `head` / `delete` |
| `src/bindings.ts` | binding 形状 |
| `src/catalog.ts` | 仅 development/test 的 Mock 模型 |
| `src/fixture.ts` | 合成测试视频字节 |
| `wrangler.jsonc` | consumer、DLQ、D1、R2、cron |

Worker 不导入 Clerk、Creem、Nuxt、React 或真实 AI SDK。`APP_ENVIRONMENT=production` 时不构造 Mock，也不调用 Provider。`pnpm build` / `pnpm deploy` 不引用这个 Worker。

执行逻辑在 `packages/data/src/video/`，这样 SQLite 测试不需要启动 Worker 进程。

## 4. Submit、Poll 和恢复

`step_id` 固定为 `generate`。`submit_key` 为 `video_submit:{generationId}:generate:{attemptNumber}`。

顺序：

1. 持久化 attempt，`acceptance_status = not_submitted`，并写入租约。
2. 状态从 `queued` 收到 `submitting`。
3. 单独提交 `dispatch_started` 和稳定的 `submittedAt`。
4. 然后才调用 `submit`。
5. 按结果分类并持久化。
6. 再安排 poll outbox。Poll 发送失败不再次 submit。

| 结果 | 持久化 | 下一步 |
| --- | --- | --- |
| accepted | request id、route 上的 provider、attempt、metadata | 只 poll |
| rejected 且确认没有上游任务 | `rejected`，request id 为空 | 可重试的限流/超时/不可用会换下一个 attempt；内容策略等直接失败返还 |
| unknown 或调用抛错 | `submission_unknown` 或保留 `dispatch_started` | `recoverSubmission`，不重新 submit，不退款，不换 Provider |

Mock 在保存 request id 之前中断时，恢复调用 `projectSubmission` 再 `recoverSubmission`。这是对同一 `submissionKey` 的本地投影，不是第二次 `adapter.submit`。真实适配器没有 `projectSubmission` 时进入 `needs_review`。

Poll 返回 pending 只增加 poll 计数并安排下一次查询。网络错误同样不 submit。明确 failed 走 P2.3 返还。超过 poll 预算或无法确认上游时进入 `needs_review`，不退款、不换路线。

`output.kind = remote` 只进入 `needs_review`（`remote_output_unsupported`）。本阶段不下载外部 URL。

Deadline：仍是 `queued` 且没有上游任务时，用 `deadline_reached` 做失败返还。已经 submit 但无法确认上游的状态进入 `needs_review`。`storing` 继续登记输出，不因为截止时间重新生成。

## 5. CAS、Lease 和版本

非终态更新把谓词放在 `status_version` 或 `attempt_number` 的 `CASE` 里，失败写成 `-1`，由已有 CHECK 回滚整批。`WHERE` 只有主键。

Attempt 和 outbox 使用 `lease_owner`、`lease_token`、`lease_until`。新执行者只能在租约为空或已过期时领取。旧 token 的后续写入会触发 `-1`。

终态：

- 失败：`returnCreditsForFailedGeneration`。证据更新放在 `composeBefore`，和失败状态、返还流水同一批。`unknown` 不能走这条路径。
- 成功：`insertOutputAndSucceed`。资产插入、`storing + output_stored`、`store_output` 交付在同一批。不调用积分计划。

`succeeded` 和 `failed` 没有出向事件。迟到失败消息在读到终态后直接 ack。

## 6. R2 输出

合成文件：`workers/video-worker/fixtures/mock-video-v1.mp4`。53 字节，自行构造的 `ftyp/mdat`，fixture id 为 `reelbam/mock-video-v1`。不是 ShrimpReel 素材。

对象键：

- 临时：`private/{env}/generations/{id}/attempts/{attemptId}/tmp/{leaseToken}.mp4`
- 最终：`private/{env}/generations/{id}/attempts/{attemptId}/output.mp4`

要求 `video/mp4`，大小大于 0 且不超过 5_000_000。`head` 必须和 fixture 字节数一致。D1 资产 id 为 `asset_{generationId}_{attemptId}`，状态 `available`，哈希 sha256。没有公开 URL。

R2 成功而 D1 失败时，对象留在最终键上。重试只登记资产，不调用 Provider。两个 Worker 抢同一资产 id 时，只有持有当前 attempt 租约和 `store_output` 租约的批次能把 generation 收成 `succeeded`。失败者的临时键只有在 `video_assets` 没有引用时才删除。

Mock 成本写入 `video_provider_costs`：`actual`、`amount_micros = 0`、`currency = USD`、`source = mock`。未知成本仍是 `unknown` 且金额为 NULL，不会写成 0。积分消费仍在 `entitlement_transactions`。

## 7. 定时恢复

`runMaintenance` 每次最多 20 行：

- 回收过期 outbox 租约。
- 补发到期的 pending outbox。
- 为 `processing` / `submission_unknown` 补 poll，为 `storing` 补 `store_output`，为仍需启动的任务补 `start_submission`。
- `queued` 且已过 deadline：走失败返还。
- 其他非 storing 状态已过 deadline：`needs_review`，不调用 Provider，不退款。

维护本身不 submit、不 poll Provider、不退款，除了上面这条已经允许的 queued deadline 结算。

DLQ 只根据 D1 做 `ignore`、补一条 outbox，或 `needs_review`。它不调用 Provider，不退款，不覆盖 `succeeded`，也不把旧 attempt 写成新 attempt 的失败。

## 8. 本地命令

Wrangler `4.114.0`。Miniflare `4.20260722.0` 随 Wrangler 安装。

```sh
pnpm run test:video-engine
pnpm run video:local:init
pnpm run video:worker:dev
pnpm run video:dev
```

`video:local:init` 只执行 `wrangler d1 migrations apply DB --local`，并且拒绝参数里的 `remote`。持久化目录是 `.wrangler/state/video-local`。Web 配置和 Video Worker 使用同一个 D1 名 `nuxt-saas-starter-db`、同一个 R2 名 `reelbam-video-output`、同一个主队列名。

本地限制：

- Queue 在单个 Miniflare 会话的内存里。两个分开的 `wrangler dev` 进程即使 `--persist-to` 相同，也只共享 D1/R2 文件，不共享队列。
- 要让 Nuxt producer 和 Video consumer 互相投递，需要同一次 `pnpm run video:dev`（重复 `--config`）。本次没有启动这个长进程。
- 本地 consumer 并发不等于生产的多 isolate。两个 consumer 抢同一任务是在同一个 SQLite 连接上测试的。
- `video:dev` 依赖已经构建的 `.output/server/index.mjs`。它不是 `nuxt build` 或静态预览的依赖。

测试身份只出现在 `packages/data/test` 和 Worker 的 development catalog。没有公开假登录或充值路由。

## 9. 已执行的测试

命令：

```sh
node --experimental-transform-types --import ./scripts/alias-register.mjs --test \
  packages/data/test/video-engine.sqlite.test.ts \
  workers/video-worker/test/queue-roundtrip.test.mjs
```

结果：24 个测试，24 通过，约 1.2 秒。数据库是临时 SQLite，应用了仓库里的迁移文件，并检查了 generation、operation、outbox、attempt、asset、cost、余额和 settlement 行。

| 编号 | 结果 |
| --- | --- |
| T01 原子创建、扣费、outbox，并跑通 Mock 成功 | 通过 |
| T02 余额不足无残留 | 通过 |
| outbox 插入失败回滚扣费 | 通过 |
| T03 相同幂等键不重复扣费 | 通过 |
| T04 同键不同输入冲突 | 通过 |
| T05 发送失败后 outbox 保留并可再发 | 通过 |
| T06 发送成功但更新中断，重复消息只 submit 一次 | 通过 |
| T07 两个 consumer 只有一个 submit | 通过 |
| T08 过期租约可接管，旧 token 不能改 request id | 通过 |
| T09 Mock 已接单但 request id 未保存，恢复到同一个 job id | 通过 |
| T10 poll 发送失败不再 submit | 通过 |
| T11 pending 轮询不增加 submit | 通过 |
| T12 明确失败只返还一次 | 通过 |
| T13 `submission_unknown` 不退款、不第二次 submit | 通过 |
| T14 成功后的迟到失败不改变终态 | 通过 |
| T15 R2 已写入、D1 完成失败，重试不重新生成 | 通过 |
| T16 重复登记只留一个最终资产 | 通过 |
| T17 DLQ 不退款、不 submit | 通过 |
| T18 新的 runner 对象能继续崩溃任务 | 通过 |
| T19 默认路线改变后旧快照仍用原 Provider | 通过 |
| T20 Mock 成本 0 USD，积分流水仍是消费 6 | 通过 |
| T21 全额现金退款后的生成失败，shortfall 不变、可消费为 0、只返还一次 | 通过 |
| T22 `app/` 与 `server/api/` 不引用创建服务、Worker 或 `/api/video`；根 wrangler 无 queue/R2 | 通过 |
| Miniflare producer → consumer，消息写入共享 D1 | 通过 |

另外：`packages/video-core/test/*.test.ts` 21 个里 20 个通过。失败的是既有 `router.test.ts`「不存在的模型…」：`setup({ routes: 全部 disabled })` 在返回前自己调用 `select`，于是在断言前抛出 `no_compatible_route`。本阶段没有改 router 或这个夹具。

## 10. 未执行或失败的检查

- `pnpm run test:data`、`pnpm run test:unit`、lint、`nuxt typecheck`、build、浏览器预览。页面没有改，T22 是源码扫描，不是浏览器点击。
- `tsc --project tsconfig.video.json` 仍有 24 个错误。新增的 video/worker/create 文件不在其中。错误来自既有测试把 `mode` 推成 `string`，以及 `server/api/webhooks/creem.post.ts` 的 Nuxt 全局在这个独立 tsconfig 里不可见。
- `pnpm run video:local:init` 和 `pnpm run video:dev` 没有执行。没有启动两个长期 Wrangler 进程。
- 没有应用远端 D1，没有 `wrangler deploy`，没有 git 提交或推送。
- 没有真实 Provider、真实支付或公开 R2 读取。
- SQLite batch 通过不等于 Cloudflare D1 实机通过。

## 11. P2.5 可调用的接口

创建，仅服务端：

```ts
createGeneration(database, {
  userId,          // 由 Clerk 会话注入，不要读客户端字段
  idempotencyKey,
  input,           // 未知 JSON，函数内部校验
  quote,           // 服务端价格快照，不是客户端金额
  nowMs,
  deadlineAtMs,
}, { models, providers, queue })
```

执行：

- `dispatchDueOutbox` / `dispatchOutboxRow`
- `handleVideoMessage(deps, message, 'queue' | 'dlq')`
- `runMaintenance`
- 失败结算继续用 `returnCreditsForFailedGeneration`
- 成功登记用 `insertOutputAndSucceed`

P2.5 仍需自己加 owner 校验的 HTTP、预览和 Range 下载。不要把 Queue 消息里的字段当成余额或状态。

## 12. 生产 Public Preview 的隔离

- 根 `wrangler.jsonc` 和 `nuxt.config.ts` 的 Wrangler 路径没有改。
- 首页、模板和市场 Studio 页面没有改，也不会请求视频任务 API。
- 生成、支付和积分购买入口没有打开。
- Video Worker 不是静态构建依赖。
- 公开预览构建不需要 Queue、R2、Clerk 或 Creem 凭据。
- D1 database id 仍是占位值。支付开关仍是 `false`。

**P2.4 到此停止。不要自动进入 P2.5。**
