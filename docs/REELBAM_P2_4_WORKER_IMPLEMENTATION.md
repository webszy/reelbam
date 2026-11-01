# Reelbam P2.4 — 异步生成任务引擎

状态：2026-10-31 独立 Review 后的修复已完成，本地回归通过，等待复审。原始 Review 保留在 `docs/reviews/P2.4_REVIEW.md`；修复与验证见 `docs/reviews/P2.4_FIX_VALIDATION.md`。不自动进入 P2.5。

本阶段只有内部创建服务、D1 Outbox、独立 Video Worker 与 Mock 执行，没有公开生成 API、真实 Provider、真实支付或部署。根 Nuxt、Clerk/Creem 开关及公开预览隔离保留。

## 1. 创建与唯一账本

入口是 `server/services/video/create-generation.ts`，没有 HTTP 路由。

可信服务端传入 userId、幂等 key、未知输入、服务端报价、时间和 deadline。输入经纯结构校验与规范化后，先查 `(userId,idempotencyKey)`：

- 相同 hash 返回原 generation，不依赖当前路由、价格、素材 availability 或新 deadline。
- 不同合法输入返回 `idempotency_conflict`。
- 只有新任务才检查当前模型/路由、价格、输入素材归属与可用状态。

同一次 D1 `database.batch`：

1. generation INSERT，包含 route/price snapshot，状态 queued。
2. P2.3 的 generation/余额围栏、grant 扣减、entitlement transactions。
3. consume operation 和关闭校验。
4. 首条 start_submission Outbox INSERT。

任一语句失败全部回滚。没有独立永久扣费再创建任务的窗口。提交响应丢失依靠原 operation 和业务 key 回读，不换 key 重扣。两个不同 key 争用余额时，败者整批回滚。

失败继续使用 P2.3 的 `returnCreditsForFailedGeneration`，不另建积分系统。失败事实、终态、返还、到期作废和现金退款 shortfall 补收仍在同一个账本 batch。成功只登记资产和 succeeded，不返还。

## 2. Submit、恢复与合法状态

`step_id=generate`，稳定 submit key 为 `video_submit:{generationId}:generate:{attemptNumber}`。

首次领取在同一 batch 中创建 attempt 并 queued→submitting。已有未提交 attempt 的 queued 恢复也必须先完成 fenced queued→submitting。dispatch_started 和原 submittedAt 在外部调用前持久化。

| 结果 | 处理 |
| --- | --- |
| accepted | attempt 的 request ID/metadata、合法 generation→processing、首条 Poll Outbox、原步骤交付和释放租约同批提交。 |
| rejected，明确不存在上游任务 | 永久失败同批返还；可重试拒绝先原子关闭旧 attempt、保存不存在证据、置 queued 并写新 start 事件。下一次领取才创建新 attempt。 |
| unknown / ProviderError | 保留 dispatch_started 或 unknown，仅 recover；不退款、不换 Provider、不盲目 Submit。 |
| 未预期中断 | dispatch_started 留在 D1，租约到期后恢复同一 attempt。 |

恢复确认不存在时，不预先建立一条可以在 queued 状态调用 Submit 的新 attempt。提交预算最多 3 次；最后一次确认不存在后，通过合法 needs_review→failed 结算一次。

Mock 的 projectSubmission 是本地确定性身份重建，不是第二次 Submit。真实 adapter 不具备对应能力时进入 needs_review；Mock 验证不代表真实 Provider 计费幂等。

Poll 只查询已有 request ID。调用异常和 pending 消耗独立、持久化的 poll 预算，不消耗 submit 预算。recover 也有独立查询计数。默认每类最多 20 次；次数在外部 I/O 前保留，进程中断不会重置预算。延迟按 1、2、4…秒增长，最多 300 秒。

remote output 不下载，进入 `remote_output_unsupported` 待审。本阶段未实现真实下载、SSRF、重定向或远程流限额防护。

## 3. CAS、Lease 与结算防线

业务状态推进调用纯状态机的合法事件，不能把任意 from/to 字符串解释为许可。SQL 同时检查：

- generation owner、当前状态和 status_version。
- 当前 step 最新 attempt。
- attempt ID、lease owner/token、实时 lease_until。
- 事件对应的 accepted/request ID 或确认不存在证据。

外部 I/O 返回后重新读取时钟；不会因为拿到当前新 version 而授权旧执行者写入。accepted 保存和推进同批，迟到 accepted 不能让 storing 回到 processing。

失败围栏仍由 P2.3 执行。queued deadline 返还额外在结算 SQL 内排除任何未解决的 dispatch_started、unknown 或 accepted，即使历史行被错误标成 queued，也不能直接退款。

成功资产 INSERT、storing→succeeded、store_output 交付同批，检查最新 attempt 与 attempt/outbox 两个租约。终态没有出向事件。

运营性的 deadline/预算耗尽可以只按 generation version 停到 needs_review；这条路径不返还，也不调用 Provider。需要当前执行者结果的推进必须持有 attempt lease。

`claimAttempt` 会回读真实 token，不再将 UPDATE 0 行当作成功。

## 4. Outbox 与 Queue

资源：主队列 `reelbam-video-jobs`，DLQ `reelbam-video-jobs-dlq`。主队列配置一个 consumer 和 DLQ，DLQ 配置独立 consumer，避免循环。

消息只包含 v1 指针：eventId、generationId、eventType、stepId、attemptId。Consumer 回读实际 D1 Outbox 与 generation，拒绝不匹配、未知版本或不再需要的事件，不把 Queue 当事实源。

D1 commit → Queue send → D1 更新不是跨资源事务：

- send 失败保留 pending，指数退避。
- send 成功仍等待步骤持久化完成；dispatcher 释放发送租约并记录重发时间。
- send 后中断可重复发送；业务 attempt、租约、状态和账本负责幂等。
- 过期租约回收后立即恢复待发资格。
- 终态、needs_review、旧 attempt 和已完成阶段的事件，由 D1 当前状态判定后持久化关闭。
- 单条事件最多 8 次 dispatcher 发送，包括“发送成功却没有业务推进”的情况，不能只限制异常。
- 非 queued 事件耗尽后进入 needs_review，不退款；queued 的 dead 首事件等 deadline 安全结算，不不断新建事件重置预算。

Queue batch 逐条 ack/retry；一个失败不主动重试已成功条目。重试使用 30 秒延迟，并记录脱敏 generation/attempt/event 标识。DLQ 只回读、补持久事件或待审，不调用 Provider，也不退款。

## 5. Deadline、存储与维护公平性

queued deadline 处理可以在没有 inflight 首事件时补建一个结算领取事件，完全不依赖 Queue send 成功。若存在未确认接单，转 needs_review；账本 SQL 再做同样防线。

其他未确认提交/processing 超时进入 needs_review。storing 有独立预算：最多 6 次存储尝试、从 provider_completed 持久化起算 10 分钟。耗尽或超时进入 needs_review，保留对象与审计，不重新 Submit、不直接退款。

maintenance 每轮最多检查 20 个任务；检查后轮换调度时间，不能被最旧的无进展任务永久占满。维护只补事件、处理 deadline/停放和 Outbox，不执行 Provider Submit/Poll。

## 6. R2、Fixture 和对象保留

fixture 为自行生成的 1 秒、160×90 H.264 色块视频，1932 字节，无第三方素材。生成命令见 `workers/video-worker/fixtures/README.md`。

固定 SHA-256：

`665cc61f99b795554a96a73f9b7e3a6c61c91874501111f6c1d874076f6c4e29`

运行时嵌入字节与文件一致，测试检查 hash、视频轨道、FFmpeg 解码及本地 R2 读回。

对象键：

`private/{env}/generations/{generationId}/attempts/{attemptId}/outputs/{sha256}/output.mp4`

不再为新写入创建临时拷贝。R2 put 使用只创建条件和 SHA-256 校验；既存对象不能被旧执行者覆盖。head 同时核对长度、MIME 和 R2 保存的 checksum。

R2 put 成功而 D1 登记失败后保持 storing，后续用同一不可变对象重试登记，不调用 Provider。真实本地 workerd 销毁/重启后已验证该路径，Queue 内存可以丢失。

终态 generation 满 24 小时后，清理该 generation/attempt 前缀下超过 24 小时的无引用对象，包括旧版本 tmp。每轮有界分页，cursor/检查时间保存在 attempt metadata，合并更新不会替换 Provider 信息。任何 video_assets 已引用对象都保留；needs_review 和仍执行中的输出保留供恢复/核查，不自动清理。

不存永久公共 URL。远端 bucket 的实际权限、公开域名和真实部署未检查。

## 7. 成本、类型与观测

Mock 成本为 actual、0 USD、source=mock，与用户积分消费分开。unknown 金额/币种保持 NULL；同 attempt/kind 和账单唯一约束继续生效。

独立 Worker 启用 observability 和 traces，错误日志不输出 Provider 原始错误、密钥或签名 URL。

`typecheck:video` 不依赖 .nuxt。数据库测试通过 H3 的实际类型声明 Nitro 边界；H3 和 ESLint 已以现有锁定版本加入直接开发依赖，未升级其他依赖。新增 `typecheck:video-bindings` 通过 Wrangler 生成临时声明并验证实际 Env 与 queue/scheduled/fetch handler 兼容。该检查发现并修正了 Queue.send 返回值不能假定为 void 的类型偏差。

## 8. 本地验证

本轮已执行：

| 检查 | 结果 |
| --- | --- |
| 纯核心 | 21/21 PASS |
| 数据层，含账本/恢复故障 | 127/127 PASS |
| 原站点单元测试 | 151/151 PASS |
| Worker/Queue/Fixture | 5/5 PASS |
| 独立视频与 Worker 类型检查 | PASS |
| 生成 Wrangler binding/handler 类型检查 | PASS |
| Nuxt typecheck/build | PASS |
| lint | 0 errors，首页既有 v-html warning 1 条 |
| drizzle-kit check | PASS，无新增/修改迁移 |
| Public Preview 浏览器 | 无 D1/R2/Queue 可访问，表单只本地校验，登录/购买关闭 |

命令：

```sh
pnpm run test:video
pnpm run test:data
pnpm run test:unit
pnpm run test:video-engine
pnpm run test:video-fixture
pnpm run typecheck:video
pnpm run typecheck:video-bindings
pnpm exec tsc --project workers/video-worker/tsconfig.json
pnpm run typecheck
pnpm run lint
pnpm run build
pnpm run db:check
```

原来的 router 夹具失败、Creem 旧 batch 次数断言、24 个独立类型错误已修复。数据层和 Worker 测试都操作临时本地资源。具体日志与剩余验证限制见修复报告。

本地 Queues 不支持真实多 isolate consumer concurrency。本轮没有 Cloudflare 部署/真实 Cron、远端 D1/R2 权限、真实 Provider 或真实支付证据。不以本地成功宣称生产计费幂等。

## 9. 本地开发与停止点

`video:local:init` 仍仅应用本地迁移；两个 Worker 共用本地 D1/R2。必须在同一个 `video:dev` Wrangler 会话中连接 producer/consumer，分开的 dev 进程不共享队列内存。该命令需要先有 Nuxt 构建产物。

生产根 Wrangler 没有新增 Queue/R2；Nuxt build 不加载 Video Worker。没有公开假登录、免费充值或 mock-generate 路由。

**P2.4 修复到此停止，等待复审，不自动进入 P2.5。**
