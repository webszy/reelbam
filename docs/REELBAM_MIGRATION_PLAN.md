# Reelbam 模块迁移计划

日期：2026-10-31（Asia/Shanghai）。Phase 1 交付，未开始代码迁移。架构和审计事实以 [REELBAM_ARCHITECTURE.md](REELBAM_ARCHITECTURE.md) 为主；当前执行记录见 [REELBAM_PROGRESS.md](REELBAM_PROGRESS.md)。

## 1. 基线和迁移分类

Nuxt 源目录没有 `.git`，commit SHA 不可获取；核心版本 Nuxt 4.5.2 / Vue 3.5.40 / Nuxt UI 4.10.0 / Clerk 2.6.21 / Drizzle 0.45.2。ShrimpReel HEAD 为 `353351bbf4e8074d53e2cc219ddf79377402f8ac`，有预先存在的未跟踪 IDE 和 pnpm 文件。完整内容指纹见架构文档第 1 节。

**前置差异：** `reelbam/` 开始时为空，未发现模板副本；本阶段只创建三份文档，未擅自补复制、初始化 Git 或安装依赖。下表的目标路径均是未来路径，不表示已经存在。

| 分类 | 含义 |
| --- | --- |
| Keep | 保留 Nuxt 模板现有实现，避免引入第二套系统 |
| Port | 可提取的纯规则/算法；参数化站点值后迁移，不连带框架和 I/O |
| Adapt | 借鉴行为，但拆除 Env、D1、站点、认证、支付等耦合 |
| Rewrite | 用 Nuxt/独立 Worker 及新一致性协议重建边界 |
| Skip | 首版不迁移；不将它作为隐含前置依赖 |

## 2. 模块迁移映射

| 源模块 / 能力 | 分类 | Reelbam 落点 | 迁移边界和原因 |
| --- | --- | --- | --- |
| Nuxt 根应用、`app/`、Nuxt UI | Keep | 根 Nuxt、`app/` | 不迁到 apps/web，不迁 React 页面；保留现有视觉体系 |
| `server/services/users.ts`、Clerk 组件 | Keep | 原路径 | 用户身份仍经 Clerk；视频引用本地 users.id；不迁 ShrimpReel session/Google auth |
| Nuxt checkout、Creem provider/验签和订单查询 | Keep | `server/api/billing/`、`server/utils/zBilling/` | 维持单一支付到账来源、现有幂等合同和支付开关 |
| Nuxt grant/transaction、现金退款/争议审计 | Keep | 原表；未来共享 data 原语 | 表名、既有数据、金额回收语义不改；接入消费所需兼容调整单独验证 |
| `shared/billing-catalog.ts`、`database/catalog.sql` | Keep | 原路径 | 不引入 ShrimpReel packages/plans 的定价和有效期规则 |
| `src/server/video/types.ts` | Adapt | `video-contracts` + `video-core/ports.ts` | 移除 Style、固定 Provider id 联合、Env 和商家模型耦合；拆公共 DTO/内部执行协议 |
| `video/index.ts` 的 mock 与 Provider registry | Adapt | `video-core/providers/mock.ts`、`registry.ts` | 注入时钟、fixture 引用、配置；Mock 可复现成功/失败/pending/异常；首版只注册 Mock |
| `video/fal.ts` | Adapt，延后 | 将来的 `video-core/providers/fal.ts` | 保留结果/错误映射经验，注入请求和路由；解决 submit 不明确结果后才允许接入；本阶段和下一 Mock 阶段不调用 |
| `video/yir.ts` | Adapt，延后 | 将来的 `providers/yir.ts` + step 协议 | 稳定幂等 key 和多步推进可借鉴；拆开站点场景、文件转存、模型参数和费用观察 |
| `video/nanoapi.ts` | Adapt，延后 | 将来的 `providers/nanoapi.ts` | 有限列表查重不是强幂等；不可将原实现直接用于付费 submit 自动重试 |
| Provider 错误类别、状态归一化 | Port | `video-core/provider-error.ts`、`retry-policy.ts` | 采用普通类型；明确 retryable exception 与终态失败的区别；统一未知状态上限 |
| fal/yir/nanoapi 估价公式 | Port，延后 | `video-core/cost.ts` + 路由价格版本 | 将单价、模式、FPS 作为输入；公式反映源代码，并非已确认的现行供应商报价 |
| `jobs.ts` 状态推进规则 | Adapt | `video-core/state-machine.ts` | 保留终态互斥、多步 CAS 意图；拆出 submitting/storing 和不明确接单状态 |
| `jobs.ts` queue/scheduled 执行器 | Rewrite | `workers/video-worker/src/` | 不复制混合订单、订阅、通知维护；实现 outbox、lease、独立预算、DLQ 恢复 |
| `jobs.ts/storeOutputFromUrl` | Adapt | `workers/video-worker/src/storage.ts` | 保留流式写入/大小上限；补 URL、响应类型、超时、临时对象与引用安全清理 |
| `credits.ts` 先到期先扣算法 | Adapt | `packages/data/src/credits/consume.ts` | 改为 entitlement_grants/transactions；不迁三套余额/流水表或 users.credits |
| `credits.ts/generationRefundStatements` | Adapt | `data/credits/return.ts` | 从原 consume 流水确定来源；与失败终态同 batch；补到期/现金退款联动；不复制 legacy 永久批次兜底 |
| `credits.ts` 正向购买、signup、订阅入账 | Keep（由 Nuxt 替代） | Nuxt 既有发放路径 | 不接 ShrimpReel ledgerStatements 的正向入账入口 |
| `credits.ts/clawbackStatements`、`orders.ts/refundOrder` | Keep（由 Nuxt 替代） | Nuxt 累计退款及原订单回收规则 | 不沿用普通订单跨来源回收，不接第二个现金退款系统 |
| `media.ts/sniffImageType` | Port | `server/infrastructure/media-validation.ts` | 图片魔数判断可直接提取为纯函数；大小/允许类型来自服务端策略 |
| `media.ts/serveR2Object` | Adapt | `server/routes/media/` + R2 adapter | 保留 Range/ETag/下载行为，改用 Nuxt HTTP 边界；必须先做 owner 校验 |
| `media.ts/signedUploadUrl`、`jobToken` | Adapt，真实 Provider 前完成 | 服务端媒体签名工具 | 使用独立媒体签名密钥，不复制 SESSION_SECRET 认证体系；测试过期/越权/签名轮换 |
| `app.ts` uploads/generations API | Rewrite | `server/api/video/` + services | 复用校验/owner 需求；新增客户端幂等，D1 batch + outbox；不迁 Hono Context 和 middleware |
| `app.ts` 视频 webhook | Adapt，延后 | `server/api/webhooks/video/[provider].post.ts` | 仅作 poll 提示，校验任务/Provider 关联；不信任回调给出的成功、金额和输出 URL |
| `Generator.tsx` | Rewrite | Vue 组件及 composables，后续最小接入 | 迁移上传、提交、轮询、失败结算和记录需求；不迁 React hooks、session/checkout；不做 UI 重设计 |
| `http.ts/publicGeneration`、生成历史查询 | Adapt | contracts DTO + owner-scoped Nuxt API | 不泄露成本、provider_meta、签名和路由内部信息；列表分页稳定排序 |
| `admin.ts` 成本汇总、`reports.ts` | Adapt | `data/repositories/costs.ts`，后续受限查询 | 保留费用观察需求，改为逐 attempt/step、currency、estimated/actual；不复制原利润算法或后台路由 |
| `retention.ts` | Adapt | Worker 媒体清理任务，后续 | 保留执行中输入保护和幂等删除；保留天数由 Reelbam 决策，不直接继承 7/30 天 |
| `src/server.ts`、TanStack/React/Hono 入口 | Skip | 无 | 根 Nuxt 和独立 Video Worker 取代，不引入第二个 Web 应用 |
| Google/session、Waffo/Dodo/Stripe、订单调账/订阅引擎 | Skip | 无 | 认证、支付和账本使用 Nuxt；不导入这些数据库表 |
| 推荐奖励、兑换码、公开分享、SEO 热词文章、邮件/告警/备份后台、Umami | Skip | 无（另立范围） | 与 Mock 闭环无关，不借迁移引入产品扩张；保留必要的本地结构化日志即可 |
| `migrations/0001...0015` | Skip（直接导入） | 仅作设计参考 | 不能应用、拼接或重编号复制到 Reelbam；需要的能力转换成 Nuxt 基线上的独立增量 |
| `seed/templates`、展示/示例素材 | Adapt，先核对 | 本地 Mock 专用 fixture | 不自动复制整套品牌素材；确认素材用途、体积和权利后选择一个可用小视频 |
| 单元/E2E 用例 | Adapt | Reelbam 自己的测试目录 | 移植行为断言而非复制依赖原表/登录/开发充值端点的测试夹具 |

## 3. 积分差异与实施门槛

Nuxt 并非缺少账本：它已有 grant 与 transaction，缺的是可重试的视频消费/失败结算服务。ShrimpReel 不是单一 users.credits 的简单余额模型：它同样有批次、分配、过期和原路退回。迁移工作是把这些能力接到 Nuxt 原表和约束上，不是替换 Nuxt 或并存两个账本。

退款比例算法也不同：Nuxt 按累计退款目标向下取整、退满时取全部，再计算本次增量；ShrimpReel `orders.ts:560` 对单次部分退款使用 round，并以订单剩余可回收积分封顶。不能把两者视作可互换实现，Reelbam 保留 Nuxt 的累计计算方式和 shortfall 语义。

必须保留的 Nuxt 不变量：

1. 余额与 `/api/me` 使用相同有效条件；一个 grant 的流水可重建其 remaining；不消费未来生效、已过期、revoked 或其他 entitlement 的额度。
2. 原订单发放 key 不变；重复支付事件不会因消费后的余额变化重新发积分。
3. 现金退款仍用实际支付额、累计比例、原订单 grant、shortfall 审计；不能改用视频报价或套餐标价。
4. 一个生成任务只消费一次；一次失败结算只执行一次；多 grant 拆分行在单个 batch 中整体提交或回滚。
5. 成功与失败结算竞争有唯一胜者；成功不返还；失败返还不延长有效期，不恢复已现金退款的可用价值。
6. 未来 schema 移动不生成同名新表，不修改旧迁移，不把 Drizzle timestamp 秒整数与 ShrimpReel ISO 文本混写。

**接入前必须处理的兼容问题：** `creem.post.ts:318` 用原始 remaining/status 校验 grant；需要支持已消费 grant 的合法重放。应区分不可变发放事实和可变余额，用原始 grant transaction 及后续流水验证，不允许“修复”补满剩余积分。相同 event ID 的已处理快捷路径仍保留；需要覆盖不同 event ID、处理中断、现金退款后的迟到通知。

**必须先定稿的返还结算：** 原批次已过期，返还与 expire 同 batch；已现金退款，返还与补足回收同 batch，保留原 adjustment 的历史 shortfall，并记录补收关联。短缺核算没有实现前不能开放视频扣费接口。详细示例见架构文档第 7 节。

## 4. 拟新建和调整的文件

本节是后续实施清单，本阶段没有创建这些代码、配置或迁移。

| 文件组 | 计划文件 | 说明 |
| --- | --- | --- |
| 公共合同 | `packages/video-contracts/package.json`、`src/index.ts`、`src/public.ts`、`src/internal.ts` | DTO、输入/能力、任务状态、消息和快照版本；公共/内部入口分离 |
| 纯核心 | `packages/video-core/package.json`、`src/ports.ts`、`src/routing.ts`、`src/state-machine.ts`、`src/retry-policy.ts`、`src/provider-error.ts`、`src/providers/mock.ts`、`src/providers/registry.ts` | 只启用 Mock；不出现 H3、Clerk、Creem、D1/Env 导入 |
| 数据层 | `packages/data/package.json`、`src/client.ts`、`src/schema/index.ts`、`src/schema/billing.ts`、`src/schema/billing-values.ts`、`src/schema/video.ts` | 唯一 schema；原 billing 结构等价移动，server 原路径兼容导出 |
| 数据仓储 | `data/src/repositories/generations.ts`、`attempts.ts`、`outbox.ts`、`assets.ts`、`costs.ts` | D1 查询、CAS、lease 和可靠投递；不做用户认证或 Provider 调用 |
| 积分原语 | `data/src/credits/balance.ts`、`consume.ts`、`return.ts`、`settlement.ts` | 唯一账本消费/返还；与 Nuxt 原余额和现金退款边界共用 |
| HTTP 服务 | `server/services/video/create-generation.ts`、`query-generations.ts`、`catalog.ts`、`server/infrastructure/video-bindings.ts` | Clerk、校验、路由、平台端口装配；不把依赖注入容器做成额外框架 |
| API | `server/api/video/uploads.post.ts`、`generations/index.post.ts`、`generations/index.get.ts`、`generations/[id].get.ts`、`generations/[id]/video.get.ts` | 明确 API 路由为 `/api/video/...`；创建、记录、查询、私有成片 |
| 平台适配 | `server/infrastructure/media-validation.ts`、`media-storage.ts`、后续 `media-signing.ts` | R2 边界，owner 归属、响应大小与 Range |
| Video Worker | `workers/video-worker/package.json`、`tsconfig.json`、`wrangler.jsonc`、`src/index.ts`、`queue.ts`、`maintenance.ts`、`storage.ts`、`bindings.ts` | queue/scheduled 入口；显式 DLQ 路由，注入 Mock/core/data |
| 本地测试夹具 | `tests/fixtures/video/`、`tests/helpers/video-fixtures.ts` | 小视频、现有表的 grant+transaction 成对初始化；测试专用，不暴露免费充值或第二套认证 |
| 回归测试 | contracts/core 单元、data 原子性/并发、Worker 本地集成、Nuxt owner/API 测试 | 覆盖第 7 节矩阵；测试路径随已有测试 runner 约定定稿 |
| 原文件调整 | 根 `package.json`、`pnpm-workspace.yaml`、`drizzle.config.ts`、`wrangler.jsonc`、`server/database/*`、必要的 `server/types/billing.ts` 导出 | 保留根 Nuxt、锁文件和 Clerk patch；schema 不重复；追加独立 Worker 检查入口 |
| 最小账单兼容 | `server/api/webhooks/creem.post.ts`、相关 domain/tests | 仅在获准实施时处理消费后履约校验及晚到返还/现金回收联动，不在 Phase 1 改动 |
| 新增 SQL | 根 `drizzle/` 的下一个可用编号及对应 meta | 等 schema 和约束定稿后由 Nuxt 基线生成；不硬编码编号、不应用源 ShrimpReel 迁移 |
| 最小页面接入 | 后续 `app/components/video/`、`app/composables/useVideoGeneration.ts` | API/账本/Worker 通过后才做最小流程呈现，不属于当前文档阶段 |

无需为 Mock 安装 fal SDK、React、TanStack、Hono、另一支付 SDK 或新的认证 SDK。优先使用已有 TypeScript、Web API、Drizzle 和 Worker binding；新增测试工具如确需引入应说明现有 runner 无法覆盖的具体原因。

## 5. 建议实施顺序

以下阶段需要用户后续指令启动；本次不自动执行。

| 步骤 | 可执行任务 | 完成条件 |
| --- | --- | --- |
| P2.0 基线就绪 | 从本地 Nuxt 源复制到 Reelbam，保留本阶段 docs，排除密钥/缓存/Git 元数据；确认 Clerk patch、锁文件和现有业务完整 | 本地可核对等价基线；源目录不变；不用重新 clone |
| P2.1 合同与纯核心 | 注册 workspace、建立 contracts/core/data 边界，Mock registry、路由快照和状态规则 | 同模型两份 Mock Provider 配置可选择；旧任务快照不随默认配置改变；纯核心无框架/DB 导入 |
| P2.2 Schema 与信用结算方案 | 等价提取唯一 schema；定稿任务/attempt/outbox/成本表和原账本消费返还；定义现金退款联动；提出增量迁移供审阅 | 单一迁移历史、完整约束；无重复余额；支付重放兼容方案和故障用例明确；不自动远程 apply |
| P2.3 统一账本 | 实现同账本消费、返还、过期/回收抵扣；修正履约重放对可变余额的假设 | 余额不足和并发整体回滚；重复/跨批次/过期/现金退款竞争用例可验证 |
| P2.4 可靠异步执行 | 创建任务 + consume + outbox，同步调度与定时恢复；独立 Worker lease、submit、poll、storing、DLQ | 本地发送丢失、重复投递、旧消息、worker 中断可恢复；已拿 request ID 不再 submit |
| P2.5 Mock API 闭环 | 上传、提交、查询、记录、R2 输出/Range 与成本记录；采用 Clerk 测试身份 | 成功扣一次、失败结算一次、历史/余额一致、成本 0 明确；无真实 AI/支付调用 |
| P2.6 最小 UI 与复测 | 沿用 Nuxt UI，接最小生成交互；由用户依复测矩阵验收 | owner 边界、刷新/断网重试、历史、结果读取都可观察；不重做页面风格 |
| P3 以后 | 决定真实模型/Provider，核实供应商现行协议、费用、取消/恢复与幂等能力 | 另行确认范围、凭据/预算及付费联调；Mock 通过不等于真实供应商验收 |

P2.2 需要设计/审阅迁移不表示已经取得本地或远程迁移执行授权。此后的代码改动完成后应先报告复测步骤，按用户约定不直接编译运行、不直接推送 Git；运行权限以当次明确指令为准。

## 6. 风险、证据和待解决问题

| 优先级 / 风险 | 源码证据或现场事实 | 建议与待解决点 |
| --- | --- | --- |
| 阻断：主项目未复制 | `reelbam/` 初始为空 | 下一阶段先做本地基线复制；本次不扩大写入范围 |
| 高：两套余额/迁移冲突 | Nuxt entitlement 表与 ShrimpReel 0001/0009 表完全不同 | 只用 Nuxt 账本；SQL 算法适配，禁止迁移目录合并 |
| 高：消费后到账重放误判 | Nuxt `creem.post.ts:318,623` | immutable 发放核对与 mutable 余额分开；不同事件 ID 重放作为必测 |
| 高：现金退款后再返还 | Nuxt shortfall + ShrimpReel 直接 remaining 加回 | 完成原批次到期/回收联动和补收审计方案，防止返还恢复已现金退掉的价值 |
| 高：外部重复计费 | ShrimpReel `jobs.ts:131,147,152,159,291`；fal 未传业务 key；Nano 有限查重 | 区分接单不明确、拆分 poll 入队，稳定 attempt/key、恢复查询；真实 Provider 能力不足时禁止盲目重提 |
| 高：HTTP 重试重复扣费 | ShrimpReel `app.ts:313` 每次生成新 ID | `(user,key)` 唯一 + input hash；返回已建任务；客户端刷新后仍保留重试 key |
| 高：D1 与 Queue/R2 非原子 | `app.ts:316,343`；`jobs.ts:206` | outbox、对象状态和补偿；失败重发不重扣；测试真实本地共享状态 |
| 高：旧消费者覆盖状态 | `jobs.ts:147` 保存 request ID 无状态/lease fence；重复 poll 的 I/O 可并行 | lease token + task version + terminal CAS；失败成本独立观测；终态不回跳 |
| 中：重试语义不一致 | `video/types.ts:25` 有 retryable，`jobs.ts:201` 未分支 | 区分调用异常、终态错误、未知接单；分别限制队列/submit/poll/任务 deadline |
| 中：可变全局配置 | `jobs.ts:118` 与各 adapter 读取 site | 输入/路线/价格版本快照；旧任务保存兼容 adapter 配置；首版不自动 fallback |
| 中：成本低估/混算 | `0006_provider_cost.sql`、`jobs.ts:221` | 逐 attempt/step、实际/估算/未知、币种/单位；失败费用和账单延迟独立保存 |
| 中：用户并发限制竞态 | `app.ts:301` 的 active 查询在 batch 外 | 入库时原子约束，不能只靠 UI 或 rate limit |
| 中：框架自动导入泄漏 | Nuxt DB client 依赖 H3 event；schema 读 server/types | data 显式 binding 工厂，类型/枚举下沉后由 server re-export；独立 worker tsconfig |
| 中：配置/工具不等于可运行 | 模板无依赖和 .nuxt；本机 Node 24.18.0、pnpm 12.14.0，模板声明 pnpm 11.24.0 | 后续在 Reelbam 内匹配锁文件和工具版本；保留 Clerk patch，不在只读源目录 prepare/install |
| 待定：产品与素材 | 源项目是特定参考视频/风格产品；无 Reelbam 定价和真实模型选择 | 首版 Mock 先固定一种 capability；素材/保留期/定价以后明确，不默认继承源品牌规则 |
| 待定：身份与本地集成 | Clerk 测试凭据未验证；两 Worker 本地共享 D1/R2 未跑通 | 使用现有 Clerk 测试账号，纯测试注入 principal；不引入 dev-login 或 mock-pay 生产入口 |
| 待定：配置版本保留 | 路由快照中 adapter version 需能实际重建 | 确认兼容窗口、执行超时和配置发布顺序；版本号本身不能保证旧代码仍可执行 |

## 7. 后续复测矩阵

以下均为**待执行**的验证步骤，不是本次测试结果；只在 Reelbam 的隔离本地环境和明确启动下一阶段后执行。AI Provider 限定 Mock，Creem 购买保持关闭，测试积分通过原表成对 fixture 初始化，不创建新的到账系统。

| 编号 | 操作 / 故障注入 | 预期可观察结果 |
| --- | --- | --- |
| V01 | A 用户调用视频创建/查询/成片，B 用户访问 A 的 ID；未登录访问 | owner 访问成功；越权同不存在；未认证失败；不得靠客户端 userId 授权 |
| V02 | 可用 10 积分创建花费 6 的 Mock 成功任务 | 一任务、一 consume operation、按 grant 拆分流水总计 -6；终态 succeeded；R2 可播放/Range；余额 4；成本显式 Mock=0 |
| V03 | 同 key 同 body 并发发送多次，丢掉第一次响应后重试 | 同一个 generation ID，扣费总计仍 -6；同 key 换 body 返回 409；新 key 才是再次生成 |
| V04 | 可用 5 创建花费 6；含已过期/未来生效/其他权益的 grant | 余额不足，无任务、consume、outbox 残留；不能消费无效批次 |
| V05 | 两个不同 key 并发争用总计不足的余额；并发额度阈值 | 只能合法一部分成功，无负余额、孤立流水或并发上限穿透 |
| V06 | 多 grant，分别有近到期、远到期、不过期；任务失败 | 先到期先扣、逐 grant 对得上；按原 consume 返还，不延长有效期；失败/返还重放不增加第二次 |
| V07 | 消费后 grant 到期，再触发失败；消费期间现金全退或部分退 | 过期量不可花；现金回收 shortfall 经返还补收后余额正确；原调整历史与补收链接可追踪 |
| V08 | 成功/失败/DLQ/超时并发到达，随后迟到成功结果 | 唯一任务终态；成功不退款；失败只结算一次；迟到供应商费用仍有记录，旧消息不能改写新 attempt |
| V09 | D1 commit 后 queue.send 抛错；send 成功后标记前中断 | 已创建任务可查询；outbox 定时补发；重复消费不重扣，不把瞬时队列问题变成重复 submit |
| V10 | Mock 接单后、本地保存 ID 前中断；已保存 ID 后 poll 发送失败 | 稳定 key/恢复能力找回原任务；后者只补 poll；不再建立第二个外部任务 |
| V11 | Mock pending、429/网络异常、永久失败、hang、无效输出 | 正常 pending 不消耗 submit 预算；退避受限；deadline/DLQ 可恢复或唯一失败结算，无无限轮询 |
| V12 | R2 put 后 D1 完成更新失败；两路成片保存；读取 Range | 可重试登记、不误删获胜对象；未成功不暴露结果；206/ETag/下载权限正确 |
| V13 | 创建后改变默认 Provider/模型/价格/模板，再处理旧任务 | 按原快照执行及结算；同模型另一 Mock route 的新任务记录不同实际路线 |
| V14 | 原订单发放后消费，再发送相同/不同 event ID 的合法到账通知及修复重试 | 不新增 grant/补满余额，不误报合法消费为履约损坏；失配的不可变发放仍拒绝 |
| V15 | 使用本地签名 fixture 重放现金部分退款、全退款、争议、迟到到账 | 原有累计比例、shortfall、争议仅审计和订单终态保持；不访问 Creem，不从其他订单扣回 |
| V16 | 模拟估价、延迟实结、多步中途失败、重复账单 | 同成本对象实结取代估价，未知不当 0，失败计费仍入账，按币种和精度汇总不重复相加 |
| V17 | 重启两个本地 Worker，查询并恢复未完成任务 | 共同读取同一 D1/R2；outbox、lease、deadline 仍可恢复；不依赖进程内 Map 或 queue 消息保存业务事实 |
| V18 | 检查生产配置与打包依赖边界（实施后由用户运行） | Mock 故障端点/夹具入口不公开；浏览器无 data/secret；core 无框架/DB；Nuxt 与 worker 独立类型检查 |

## 8. 构建和测试条件检查结果

- Nuxt 模板提供 `test:unit`、`typecheck`、`lint`、`build`；尚无 node_modules 和生成 tsconfig，本次未安装和执行。
- ShrimpReel 提供 `typecheck`、Vitest、Playwright/E2E/sandbox；已有 node_modules 仅表示依赖目录存在，不代表已通过。测试夹具包含原表、原登录/支付路径，需要适配后才是 Reelbam 测试。
- 已阅读 jobs、credits、provider、输出大小上限及 generation 流程的测试断言；本次没有运行测试，也没有依据测试名推断完整并发安全。
- 不运行 `deploy`、`deploy:check`、远程 D1、seed、支付 sandbox、doctor 或任何可能调用外部服务的脚本。模板 `deploy:check` 也包含 build，不能当成无运行副作用的文件检查。
- 后续代码完成后的建议顺序是：用户先复核 diff/迁移，再按明确授权安装及静态检查，运行原账单回归，建立隔离本地 D1，验证两个 Worker Mock 集成，最后做 UI 复测。远程资源和真实供应商单独列阶段。

本阶段仅交付三份 Markdown，完成后停止。
