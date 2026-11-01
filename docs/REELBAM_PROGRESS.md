# Reelbam 进度

更新日期：2026-10-31（Asia/Shanghai）。当前停止点：**P2.4 独立 Review 后修复已完成；账本/恢复故障、实际 workerd 重启与 R2 登记、类型检查、构建和无绑定公开预览回归通过。未部署、未推送、未进入 P2.5，等待复审。**

## 当前状态

Reelbam 保留根 Nuxt 应用。P2.0 已复制 77 个模板文件并将 package name 改为 reelbam。P2.1 写入了 contracts/core/data 包和纯核心。P2.2 把唯一 Drizzle Schema 移到 `packages/data`，追加视频业务表和 `0001` 迁移文件，并定稿积分结算协议。P2.3 写入了唯一账本上的消费、失败返还和 Creem 发放核对。现有独立 Video Worker 与内部创建服务；没有视频 HTTP API 或真实生成 UI。下方早期阶段记录为历史现场。

复制前实际检查：`reelbam/` 只有三份 Phase 1 文档和系统 `.DS_Store`，没有非文档代码冲突。复制使用逐文件排除和独占新建，不覆盖现有文件、不删除目标文件。原有 `.DS_Store` 未处理；三份文档复制时全部保留，之后只主动更新本进度文档。

独立 Git 仓库仍为 `main`；未暂存、未创建提交、未设置远端、未推送。下方 P2.0 清单保留为历史记录；P2.1 的实际差异另列。代码和测试已写入，不表示类型检查、测试、构建或运行通过。

## P2.0 来源与完整性证据（历史记录）

| 项目 | 本次结果 |
| --- | --- |
| Nuxt 源目录 | 只读，无 `.git`；无法取得 commit SHA |
| Nuxt 源文件集合 | 77 个文件，前后 SHA-256 一致：`9c5250bb067b2e47293cf33359b8d9b44b8af004b9b4db82f9fc5c8a3a8fbd33` |
| ShrimpReel HEAD | `353351bbf4e8074d53e2cc219ddf79377402f8ac`，未变 |
| ShrimpReel 源文件集合 | 279 个文件，前后 SHA-256 一致：`6ecebe1bfe5e84eb30c0071bef5349bdf13ff0044b78168217fdf830d3fb279f` |
| 源项目既有未跟踪项 | ShrimpReel `.idea/`、`pnpm-lock.yaml`、`pnpm-workspace.yaml` 保留，Git 状态未变 |
| 文档保护 | `REELBAM_ARCHITECTURE.md`、`REELBAM_MIGRATION_PLAN.md` 与本阶段开始前 SHA-256 一致，未改写历史或设计 |
| 源码差异 | 对 77 个复制文件核对，仅 `package.json` 不同；解析 JSON 后仅 name 改变，scripts、dependencies、devDependencies、engines 和 packageManager 未变 |
| CodeGraph | 三目录无 `.codegraph/`，无可用 MCP；按无索引跳过及源目录只读限制未初始化 |

源文件集合指纹算法沿用 [架构文档](REELBAM_ARCHITECTURE.md) 第 1 节，排除 Git/依赖/IDE/系统元数据，不声称审计了 node_modules 或 Git 内部文件。复制前后另外核对 Reelbam 文档及全部复制文件；没有从 ShrimpReel 复制模块、迁移、配置或依赖。

## P2.0 已完成

- [x] 检查三目录实际文件结构，阅读三份 Phase 1 文档，确认目标无代码冲突。
- [x] 从本地模板复制完整应用源码及配套配置，共 77 个文件，保留根 Nuxt 结构。
- [x] 保留 `.env.example`、`.dev.vars.example`；实际 `.env` / `.env.local` / `.dev.vars` 等配置和运行产物未复制。源目录本次没有命中排除项，不代表未设置排除规则。
- [x] 保留 `pnpm-lock.yaml`、`pnpm-workspace.yaml`、`patches/`、原有 Drizzle schema、迁移和 meta。
- [x] 将 npm package name 改为 `reelbam`；未改标题、描述、Nuxt/Wrangler 配置或任何业务实现。
- [x] 初始化独立 Git 仓库；未暂存、提交、配置远端或推送。
- [x] 对源码、Clerk patch/锁文件、测试入口、环境忽略规则、支付关闭和 D1 占位配置完成静态核对。
- [x] 核对两个原始项目的源文件集合无变化，两份架构文档无变化，更新本进度文档。

### 复制文件清单与数量

| 主要目录 / 文件 | 文件数 | 内容 |
| --- | --- | --- |
| `app/` | 23 | 页面、布局、组件、composables、工具、样式、analytics 插件及原测试 |
| `server/` | 31 | Clerk 用户同步、业务 API、Creem Checkout/Webhook、zBilling、类型、D1/Drizzle schema/client 和原测试 |
| `shared/` | 1 | `billing-catalog.ts` |
| `drizzle/` | 3 | `0000_fast_magdalene.sql`、`meta/0000_snapshot.json`、`meta/_journal.json` |
| `database/` | 2 | `catalog.sql`、`configure-products.sql.example` |
| `patches/` | 1 | `@clerk__nuxt@2.6.21.patch` |
| `scripts/` | 4 | alias register/loader、catalog generator、deployment checker |
| 根目录配套文件 | 12 | 见下方完整根文件列表 |
| 合计 | **77** | 另保留 `docs/` 三份文件，不计入模板复制数量 |

复制的根文件：`package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`、`nuxt.config.ts`、`wrangler.jsonc`、`drizzle.config.ts`、`tsconfig.json`、`eslint.config.mjs`、`README.md`、`.gitignore`、`.env.example`、`.dev.vars.example`。

### 静态核对结果

| 核对项 | 结果及边界 |
| --- | --- |
| 必需目录/文件 | package、lock、workspace、Nuxt/Wrangler config，以及 app/server/shared/drizzle/database/patches 全部存在 |
| Clerk patch | 内容未改，workspace 引用未改；文件 SHA-256 和锁文件 patch hash 均为 `3019428358704851d20428050cf06690e9c05875960a2230152fbe2048d61908`；未安装依赖，尚未验证实际应用 patch |
| 原始数据库 | `server/database/schema/index.ts`、`drizzle.config.ts`、3 个迁移/meta 文件逐字节一致；未生成、修改或应用迁移 |
| 认证/支付/积分 | 用户服务、billing API、Creem Webhook、zBilling 及共享 catalog 原样保留；未重构登录、支付或账本 |
| 测试脚本 | package scripts 完整保留；`test:unit` 的 10 个测试文件入口均存在；未运行 |
| 锁文件/工作区 | 与模板逐字节一致；没有增加 workspace 包、依赖或改写锁文件 |
| 环境忽略规则 | 使用 Git 规则静态检查：`.env`、`.env.local`、`.env.production`、`.dev.vars` 及其 local/production 变体被忽略；两个 example 文件允许跟踪 |
| 产物忽略规则 | node_modules、.nuxt、.output、.wrangler 被忽略；Clerk patch、锁文件和迁移允许跟踪；未创建真实环境文件来检查规则 |
| 支付开关 | Wrangler 的 `NUXT_CREEM_PAYMENT_ENABLED` 和 `NUXT_PUBLIC_CREEM_PAYMENT_ENABLED` 仍为字符串 `false`；未新增启用支付的实际 env；Nuxt 配置逻辑未改 |
| D1 | binding 仍为 `DB`；`database_id` 仍是 `00000000-0000-0000-0000-000000000000`；原 Worker/数据库名称保留模板值，未绑定真实资源 |
| 后续阶段边界 | 未建立 packages、video-core、Provider Adapter、Worker、Queue、R2 绑定或新数据库表；Wrangler 未新增 queues |

本阶段静态核对是文件/JSON/文本/哈希/Git 元数据检查，没有调用应用测试 runner、构建器、依赖安装器或 Cloudflare 命令。

## Node 与 pnpm 要求

| 项目 | 模板声明 / 本机现场 |
| --- | --- |
| Node engines | `^22.19.0 || ^24.11.0 || >=26.0.0`，完整保留 |
| packageManager | `pnpm@11.24.0`，完整保留 |
| 本机只读检查 | Node `v24.18.0`；pnpm `12.14.0`，与 Phase 1 相同 |

本机 Node 位于声明范围内；pnpm 实际版本与声明不同。未来获准安装时应先使用匹配的 pnpm `11.24.0` 并保持 frozen lockfile；本阶段没有切换或安装工具链，没有使用 pnpm 12 重写锁文件，也没有执行 `pnpm install` 或 `postinstall`。

## 尚未执行的验证

- [ ] 依赖安装及 Clerk patch 实际应用。
- [ ] Nuxt prepare、lint、类型检查、build、dev/preview 或浏览器验证。
- [ ] 原有单元测试；测试入口存在不等于测试通过。
- [ ] Clerk 登录/用户同步、Checkout/Webhook/退款、积分发放在运行时的回归。
- [ ] 本地或远程 D1 迁移、seed、Cloudflare Worker dry-run 或部署。
- [ ] 真实 AI Provider、付费 API、支付 sandbox 或任何新队列服务。
- [ ] Git 初始提交或远端配置。

当前应用未安装 node_modules，未生成 .nuxt/.output/.wrangler；不能将本阶段结论表述为“已可运行”或“支付测试通过”。

## Phase 1 记录与后续风险

Phase 1 已完成双源源码审计、Keep/Port/Adapt/Rewrite/Skip 映射、统一账本/路由快照/独立 Worker 规划，以及 V01–V18 待执行复测矩阵。Phase 1 时 Reelbam 为空是历史现场；P2.0 已解决应用基线缺失，两份 Phase 1 文档保留原审计语境。

文档入口：

1. [REELBAM_ARCHITECTURE.md](REELBAM_ARCHITECTURE.md)：总体设计和审计证据。
2. [REELBAM_MIGRATION_PLAN.md](REELBAM_MIGRATION_PLAN.md)：迁移边界、顺序、风险与复测矩阵。
3. 本文件：P2.0 实际状态。

仍待未来处理的审计发现：支付履约重放对可变余额的假设；客户端生成幂等；外部接单不明确及重复 submit；现金退款/过期后的返还；单字段成本混算。上述均未在 P2.0 修改，也不应夹带到纯基线复制中。

## P2.1 本阶段交付

- [x] 建立 pnpm Workspace，包名为 `@reelbam/video-contracts`、`@reelbam/video-core`、`@reelbam/data`；Nuxt 不搬离根目录。
- [x] 公开/内部合同分入口；三种生成模式使用可判别联合类型，提供未知输入的字段与模式校验。
- [x] 模型/Provider/实际 Provider Model/Capability/Route 分离；模型和 Route 参数双重校验，Route 只允许收窄能力。
- [x] 静态 Model Registry、按 Provider ID + adapterVersion 注册的 Provider Registry、确定性 Router 与可 JSON 保存的冻结快照。
- [x] Provider submit accepted/rejected/unknown；查询 pending/completed/failed；调用 ProviderError 与任务失败分开，错误分类不授予自动重提许可。
- [x] Mock 以注入时钟和 metadata 计算状态；无 Map、定时等待或网络；支持失败、hang、查询临时不可用、未知提交和恢复；明确 0 成本，真实未知成本类型独立。
- [x] Mock 仅显式 development/test 可构造；不提供生产 fallback。两个 Mock Provider 配置只作为测试/示例，不默认接入应用。
- [x] 纯任务状态规则覆盖 queued/submitting/submission_unknown/processing/storing/succeeded/failed/needs_review；无 CAS/Lease/Queue 实现。
- [x] 写入四组 Node 原生单元测试及静态 A/B 配置，覆盖输入、Registry、Route、Snapshot、Mock 和状态机。
- [x] data 仅有空导出包边界；原 schema/client/迁移位置不变。
- [x] 补充 [Video Core 使用和检查说明](REELBAM_VIDEO_CORE.md)，包含 Mock 使用方式、限制和用户执行的命令。
- [x] 完成文件级静态核对：23 个新增文件、4 个既有文件修改，四个测试文件共编写 21 个用例；JSON、相对导入路径、文档链接、旧锁图保留和修改范围核对无异常。未运行 TS 编译器或测试 runner。

### 文件变更

| 范围 | 内容 |
| --- | --- |
| 根 `pnpm-workspace.yaml` | 添加 `packages/*`，保留原 allowBuilds、patchedDependencies、release-age 例外 |
| 根 `package.json` | 只增加 `test:video` 与 `typecheck:video`；原 scripts、依赖、版本和 engines 不变 |
| 根 `pnpm-lock.yaml` | 只追加三个 importer 和 core → contracts 本地 link；未重建旧锁记录，未安装依赖 |
| 根 `tsconfig.video.json` | 与 Nuxt 生成配置独立的 packages 类型检查入口 |
| `packages/video-contracts/` | package exports + public.ts/internal.ts |
| `packages/video-core/src/` | provider、validation、model-registry、router、state-machine、public-generation、value、providers/mock 和 registry、index |
| `packages/video-core/test/` | contracts/router/mock/state-machine 四个 .test.ts + fixtures.ts |
| `packages/data/` | package.json + src/index.ts，仅包边界 |
| `docs/` | 本进度更新；新增 REELBAM_VIDEO_CORE.md；两份 Phase 1 设计文档未修改 |

原 `app/`、`server/`、`shared/`、`database/`、`drizzle/`、`patches/`、Nuxt/Wrangler 配置及原测试 loader 均未改；两份源项目保持只读。支付开关保持关闭，D1 占位 ID 未替换，未添加 Queue/R2 绑定。

### 未验证项与已知限制

- **未执行**：依赖安装、pnpm 锁文件一致性检查、Clerk patch 实际应用、typecheck、lint、四组新增测试、原有 test:unit、build、dev/preview、部署。没有宣称任何测试通过。
- 锁文件仅做可审阅的本地 Workspace 追加，必须用 pnpm 11.24.0 的 frozen 安装确认；不使用本机 12.14.0 改写依赖图。
- packages 直接导出 TS 源码，未提供发布用 JS；core 的运行时导入仅相对路径，contracts 引用均为 type-only，纯测试不需要 Nuxt/Clerk/Cloudflare。
- 模型和 Route 示例位于测试夹具，没有生产模型目录、模型后台、真实 Provider 或凭据。每模型每模式当前只接受一个 capability。
- Mock 输出只有逻辑 fixture 引用，没有 R2/二进制读取或可播放生成器。首次 submit 前和结果返回后的持久化仍由未来执行器负责；丢失 metadata 不能从内存恢复。
- Mock 重复 submit 的确定性依赖同一 key/时间/配置；跨进程已有结果应恢复保存的 metadata，不能用新配置重建旧 submit。生产计费幂等仍未解决。
- RouteSnapshot 是可信服务端内部合同；未来从 D1 读取需验证版本、完整性和归属。当前冻结不等于数据库不可变约束，Provider Registry 保留旧版本也需发布流程保证。
- 状态机不实现 deadline 调度、事件证据、CAS、Lease、失败退款或自动恢复。needs_review 非终态，不可直接退款；具体恢复必须结合持久化来源/证据。

### 用户执行的检查步骤（本次未运行）

在 Reelbam 根目录使用受支持 Node、pnpm **11.24.0**，先确认版本。纯测试可先执行 `pnpm run test:video`，不需安装 Nuxt 依赖；需要完整类型/应用检查时由用户安排 `pnpm install --frozen-lockfile`，然后依次执行：

```sh
pnpm run typecheck:video
pnpm run test:video
pnpm run test:unit
pnpm run lint
pnpm run typecheck
pnpm run build
```

预期：独立 TS 检查无错误；新增断言覆盖两路线、快照重启、三种提交结果及终态规则且无网络；原测试回归通过；Nuxt 打包不受影响。全部结果需实际执行后才能确认。详细场景和前置条件见 [REELBAM_VIDEO_CORE.md](REELBAM_VIDEO_CORE.md)。

## P2.2 本阶段交付

执行前在 `reelbam/docs/`、仓库 Markdown 和当前会话材料中没有找到已保存的 P2.1 Review，也没有记录在案的未关闭 P0/P1。P2.1 测试仍未运行，这是未验证项，不把未运行当成已关闭缺陷，也不把 P2.1 明确延后的持久化缺口当成要在本阶段用临时代码补上的故障。因此进入 P2.2。只修改 `reelbam/`。

- [x] 唯一 Schema 位于 `packages/data/src/schema/`。`billing.ts` 的表定义与 Nuxt 模板 `server/database/schema/index.ts` 去导入后的正文逐字一致。
- [x] 枚举、权益快照纯类型下沉到 `billing-values.ts`。`server/types/billing.ts` 继续导出这些符号，并保留依赖 `shared/billing-catalog` 的价格码。
- [x] `server/database/schema/index.ts` 只做兼容重导出。`createDatabase(binding)` 接收外部 D1 binding。Nuxt 的 `getDatabase` 仍负责读取 binding 和错误包装。
- [x] `drizzle.config.ts` 指向 `packages/data/src/schema/index.ts`。
- [x] 新增 `video_assets`、`video_generations`、`video_attempts`、`video_outbox`、`video_credit_operations`、`video_provider_costs`、`billing_refund_credit_settlements`。
- [x] 手写 `drizzle/0001_video_business.sql`，并用本地解析器生成 `drizzle/meta/0001_snapshot.json` 和 journal 第二条。0000 SQL 与 0000 snapshot 的 SHA-256 未变。
- [x] 纯函数结算契约写入 `packages/data/src/credits/contract.ts`。它不读写 D1。
- [x] 协议说明写入 [REELBAM_LEDGER_SETTLEMENT_DESIGN.md](REELBAM_LEDGER_SETTLEMENT_DESIGN.md)。
- [x] 新增迁移形状测试和结算契约测试。本轮没有授权执行它们。
- [ ] 未修改 Creem Webhook、退款金额算法、Worker、Queue、R2、视频 API 和 UI。
- [ ] 未安装依赖、未运行测试、lint、类型检查、构建、drizzle-kit 或任何本地/远端迁移。

### 已实现范围

| 范围 | 内容 |
| --- | --- |
| Schema | 原 13 张 billing/用户/权益表只搬迁定义；新增 7 张表及约束 |
| 客户端 | `packages/data` 的 `createDatabase`；server client 改为调用它 |
| 迁移文件 | `0001_video_business`。journal `prev` 关系：0001.prevId = 0000.id `9b9d794b-f9d5-4346-96d1-82b46b9d6e23` |
| 结算 | 消费排序、条件更新语义、失败返还、现金退款 shortfall 补收、Creem 重放的验证设计 |
| 测试文件 | `packages/data/test/migration-shape.test.ts`、`packages/data/test/settlement-contract.test.ts` |

0000 SQL SHA-256 仍为 `d56c012e7d9b84af6fcf20a1ff0f7ec061903a13bba22bec092f9f5d5233f387`。0000 snapshot SHA-256 仍为 `5040896ca8b667ed2f68c91f86f5081fc2975de76e8e57b2adcb9ae7019078a1`。这两份哈希是在生成本地 0001 snapshot 之后重新计算的。

### 文件变更

| 路径 | 变更 |
| --- | --- |
| `packages/data/src/schema/billing.ts` | 原表定义，导入改为 data 内的值类型 |
| `packages/data/src/schema/billing-values.ts` | 新增，枚举与权益快照类型 |
| `packages/data/src/schema/video.ts` | 新增，七张新表 |
| `packages/data/src/schema/index.ts` | 新增，唯一 Schema 出口 |
| `packages/data/src/client.ts` | 新增，外部 D1 binding 客户端 |
| `packages/data/src/credits/contract.ts` | 新增，纯结算与输入哈希契约 |
| `packages/data/src/index.ts` | 导出客户端和契约 |
| `packages/data/package.json` | 增加 drizzle-orm 与 video-contracts 依赖及子路径导出 |
| `packages/data/test/*.test.ts` | 新增两个未运行测试 |
| `server/database/schema/index.ts` | 改为重导出 |
| `server/database/client.ts` | 改为调用 `createDatabase` |
| `server/types/billing.ts` | 值类型改为重导出，目录价格码保留 |
| `drizzle.config.ts` | schema 路径改为 packages/data |
| `drizzle/0001_video_business.sql` | 新增增量 SQL |
| `drizzle/meta/0001_snapshot.json` | 新增，本地解析器生成，不是 drizzle-kit 产物 |
| `drizzle/meta/_journal.json` | 追加 idx 1，0000 条目字段未改 |
| `package.json` | 只增加 `test:data` |
| `tsconfig.video.json` | 增加 `@reelbam/data` 路径 |
| `pnpm-lock.yaml` | 只给 `packages/data` importer 补上两条依赖 |
| `docs/REELBAM_LEDGER_SETTLEMENT_DESIGN.md` | 新增协议 |
| `docs/REELBAM_PROGRESS.md` | 本文件 |

`app/`、`shared/`、`database/`、`patches/`、Nuxt/Wrangler 配置、Creem Webhook 和退款算法未改。两个源项目未改。未提交、未推送、未部署。

### 未验证范围

- [ ] `pnpm install --frozen-lockfile`，以及手改 lock importer 是否被 pnpm 11.24.0 接受。禁止用本机 pnpm 12.14.0 重写锁文件。
- [ ] `pnpm run test:data`、`pnpm run test:video`、`pnpm run test:unit`。
- [ ] `pnpm run typecheck:video`、`pnpm run typecheck`、lint、build。
- [ ] `pnpm run db:generate` / `drizzle-kit check`。0001 SQL 和 snapshot 的一致性只经过本地解析器交叉核对，不能写成 drizzle-kit 已生成。
- [ ] 本地或远端 D1 应用 0001。部分索引、CHECK、复合外键都未在数据库执行。
- [ ] 原支付导入在 Nuxt 类型检查和 webhook 测试中的实际兼容。静态上重导出符号仍覆盖现有导入。
- [ ] Clerk、Creem、积分发放和现金退款运行时回归。
- [ ] P2.3 的 D1 写入器、队列投递和并发重试。纯函数计划不等于已结算。

用户稍后可执行：

```sh
pnpm install --frozen-lockfile
pnpm run test:data
pnpm run typecheck:video
pnpm run test:unit
pnpm run db:check
```

`db:check` 只检查迁移元数据，不应用迁移。应用迁移仍需单独授权。没有 node_modules 时以上命令无法执行。

### 已知风险与待确认

1. 0001 snapshot 由 `/tmp` 本地解析器从 SQL 组装后已删除该脚本。它保证 0000 表 JSON 深度相等，并解析了新表的列、CHECK、外键和部分索引。drizzle-kit 0.31.10 可能仍会整理空白或索引顺序。
2. `video_credit_operations` 不单列 sweep。到期清扫数量由 expire 流水的负数减去 `expired_quantity` 重建。Review 若要求单独列，需要另一次增量迁移。
3. `policyRevoked` 不是数据库列。现金退款把余额打到 0 时也会把 grant status 写成 `revoked`。P2.3 写入器必须只把非 `refund` 来源的撤销当成政策撤销。传错会把应恢复的积分作废。
4. `quoted_credits` 与 `quote_snapshot.creditAmount` 的相等由写入器保证，SQL 未做 JSON 提取约束。
5. 活跃任务配额没有新表。先查数量再插入会在并发下超卖名额。P2.3 实现前需要单独决定配额方案。
6. Outbox 进入 `dead` 的次数上限留到 Worker 阶段，本阶段不假装已有重试策略。
7. Creem 重复到账仍按当前 `grantMatchesExpected` 比较 `remaining` 和 `status`。兼容方案只写在设计文档中，Webhook 代码未改，重放缺陷仍然存在。

## P2.2 修订：守卫协议与已知成本

本轮只修订数据基础和结算设计，不进入 P2.3，不实现消费 API、返还执行器、Worker、Provider 或 UI，也不改 Webhook 执行文件。

- 现金退款和返还共用 `billing_orders.refund_version` 与 grant `CASE`。applied 为 0、净余额变化为 0 也要校验。冲突只允许整批回滚后重读。
- 同一 adjustment 的 settlement 累计不得超过原 shortfall。`0002` 触发器用 `RAISE(ABORT)` 卡住超额、错 grant 和缺少 clawback 流水。不删除、不改写历史 shortfall，不从其他订单借额度，幂等键不变。
- 失败和成功落账写明原状态、合法事件、版本和 lease。最新版本不能授权 `succeeded` → `failed`。
- `video_provider_costs` 的 known 成本改为 `CASE`：金额和币种显式非 NULL，金额为非负整数，币种为三个大写字母。known 0 与 unknown NULL 仍合法。`0000`、`0001` 未改。Schema 与 `0002` snapshot 已同步。
- Creem 不可变发放事实核对仍保留，并写明必须在开放消费前完成。Webhook 只记录两处未来接点。
- 第二轮补了消费提交的失败型 `CASE`、五种来源的原路返还，以及零报价失败的单独分支。空的共享守卫 claim 仍然失败。`0000` 与 `0001` 仍未改写。

新增纯函数测试 `packages/data/test/settlement-guard.test.ts` 和 `packages/data/test/settlement-source.test.ts`。本轮未安装依赖、未运行测试、未应用迁移、未部署、未推送。

复测仍待授权后执行：

```sh
pnpm install --frozen-lockfile
pnpm run test:data
pnpm run typecheck:video
```

数据库步骤见 [REELBAM_LEDGER_SETTLEMENT_DESIGN.md](REELBAM_LEDGER_SETTLEMENT_DESIGN.md) 第 12 节，需要单独的迁移授权，本轮不执行。

## P2.3 积分消费、返还与 Creem 兼容

本轮只实现统一余额查询、原子消费、幂等失败返还、到期/现金退款联动结算，以及 Creem 重复到账核对。没有 Nuxt 视频 HTTP API、Queue Consumer、Worker 编排或真实 AI 调用。没有新表、没有改旧迁移、没有第二套余额。

实现记录见 [REELBAM_P2_3_LEDGER_IMPLEMENTATION.md](REELBAM_P2_3_LEDGER_IMPLEMENTATION.md)。

### 已写入

- `packages/data/src/credits/{spendable,consume,return,fulfillment,reconcile,runtime}.ts`
- `/api/me` 改为 `getAvailableCredits` / `spendableCreditWhere`
- `ensureOrderCreditFulfillment` 改为不可变发放核对；`applyRefundCreated` 对 applied = 0 也写 grant CASE
- sqlite 账本测试 T01–T17 与 Creem 回归用例
- `test:data` 增加 `--import ./scripts/alias-register.mjs`，以便数据测试加载 webhook

### 未验证（NOT RUN）

```sh
pnpm install --frozen-lockfile
pnpm run test:data
pnpm run test:unit
pnpm run typecheck:video
```

未应用迁移，未部署，未提交，未调用真实支付或 AI。

**完成 P2.3 后立即停止，等待 GPT Review。不要进入 P2.4。**

## P2.0 复核步骤

本阶段可直接进行静态复核，无需安装或启动应用：

1. 对照上方清单确认根 Nuxt 结构和 77 个模板文件；比较源与 Reelbam，模板文件应只有 package name 的差异。
2. 核对两份架构文档原样保留，本进度文件标记 P2.0；检查锁文件、Clerk patch 和迁移内容未变。
3. 查看 Git 状态，应处于 main 的无提交状态、无远端、无暂存；本地环境/运行产物受忽略规则保护。
4. 检查实际环境文件不存在、支付标志仍 false、D1 ID 仍是占位值，且没有 packages/workers 或新基础设施。

上述复核步骤记录 P2.0 时的期望。P2.1、P2.2 和 P2.3 已按后续授权写入。P2.4 也已按本次授权写入，见文末。

## P2.3 GPT Review 修复（2026-10-31）

针对 F01–F07 写入 attempt 失败证据围栏、持久化流水顺序与完整重建、合法发放数量检查、提交成功后读取异常处理，并修复/扩充数据库测试源码。新增 `0003_ledger_integrity`，旧迁移未改写。测试夹具改为生产 Drizzle D1 驱动加真实临时 SQLite，仍需实际 Cloudflare D1 验收。

本轮测试、lint、类型检查、构建和数据库迁移均 **NOT RUN**；未安装依赖、未提交、未推送、未部署。详细字段、迁移前提及复测步骤见 `REELBAM_P2_3_LEDGER_IMPLEMENTATION.md` 的 GPT Review 修复节。CDF 完成门禁为 `INSUFFICIENT_EVIDENCE`，不标记财务验收通过，不进入 P2.4。

## P2.4 异步生成任务引擎与 Review 修复

首次实现及其故障由 docs/reviews/P2.4_REVIEW.md 保留，原始结论为 BLOCKED。随后按用户“你来修复”的指令修复 F01–F08，并处理 F09–F11；没有进入 P2.5。

修复内容：原子 accepted/状态/Outbox 协议、所有业务推进的合法事件和实时租约、queued deadline 账本防线、Outbox 收敛及 dead 首事件恢复、持久存储/恢复预算、维护轮换、先查幂等重放、可播放 fixture、不可覆盖 R2 对象和终态无引用对象清理。补齐正式故障回归、实际 workerd 重启、本地 R2/D1 中断恢复和逐条 batch ack 测试。

已执行：core 21/21、data 127/127、unit 151/151、Worker/Queue/Fixture 5/5；独立视频/Worker 类型检查、生成 Wrangler binding 类型检查、Nuxt typecheck/build、drizzle-kit check 均通过。lint 0 errors，保留首页既有 v-html warning 一条。无 D1/R2/Queue 的浏览器预览和表单校验通过，登录、购买与真实生成仍关闭。

没有新增或修改 drizzle 迁移，没有远端资源操作、真实 Provider/支付、部署、Git 提交或推送。真实多 isolate 并发与 Cloudflare 部署验收仍未执行；本地结果不替代该证据。

详细实现见 [REELBAM_P2_4_WORKER_IMPLEMENTATION.md](REELBAM_P2_4_WORKER_IMPLEMENTATION.md)，修复证据见 [P2.4_FIX_VALIDATION.md](reviews/P2.4_FIX_VALIDATION.md)。

**P2.4 修复到此停止，等待复审，不自动进入 P2.5。**

## P2.4 Review Fix 复测（2026-11-01，Asia/Shanghai）

审查输入为 `main@455841c38d8a8156a5b0b2e6e2940a5d7a9ec2f5` 加进入本轮时已有的 46 个修改/未跟踪文件，保留此前修复及历史验证记录。本轮未将旧的 FAIL 或 NOT RUN 改写成通过。

新增最小修复：Router fixture 延迟选择并缓存 Snapshot/adapter，全禁用 Route 的异常回到断言阶段；Worker 业务依赖初始化显式校验 development/test/production，非法值不再回退 development。生产与测试 TypeScript 项目分开严格执行，测试用 H3 globals 不进入纯生产源码检查。

补充 unknown → needs_review 后无伪造失败证据/无退款的 R23；实际 workerd 重启测试改用 Worker scheduled 入口恢复，并新增非法环境与 production 禁止执行已保存 Mock 路线的运行时回归。

本轮实际执行（Node v24.19.0、Corepack pnpm **11.24.0**）：frozen install PASS，锁文件相对本轮开始未变；Core **21/21**、data **128/128**、unit **151/151**、video-engine **60/60**。去重为 **314 项测试通过**，无失败/跳过。独立生产/测试/Worker 类型、生成 binding/handler 类型、Nuxt typecheck/build、lint、db:check 全部 PASS；lint 保留既有 v-html warning 1 条。

默认沙箱首次阻止 Miniflare/Wrangler 的本地监听，保留 BLOCKED 证据，使用本地监听权限复跑通过；dry-run 默认日志路径不可写时也保留原输出，改用临时可写日志目录复跑通过。没有跳过关键验证后标记成功。

当前 fixture 已为此前生成的 1932 字节自制 MP4，本轮实测 H.264、160×90、10 帧、1 秒、FFmpeg 解码通过，运行时/R2/hash 一致。源 Wrangler 配置的双 Worker 与独立 Worker 本地启动通过；四份迁移仅应用于新建临时 D1；scheduled、非法环境和 production 检查通过，dev 进程均已停止。Nuxt 和 Video Worker **两次最终 dry-run 均 PASS**，根公开预览配置仍无 Queue/R2。

验收结论 **PASS（P2.4 本地范围）**。远端 D1、线上多 isolate 并发、真实 Provider/支付、Clerk 登录端到端仍 NOT RUN，不能据本轮结果宣称生产已验收。6 秒模板与 5 秒能力差异交由 P2.5 的 Compiler/模型绑定解决；needs_review 人工处理和真实环境验收仍是正式收费生成前置条件。

完整变更、问题根因、覆盖矩阵、命令/原始证据、剩余事项及迁移前核对方案见 [REELBAM_P2_4_REVIEW_FIX.md](REELBAM_P2_4_REVIEW_FIX.md)。没有修改历史迁移或业务财务数据，没有远端资源操作、正式部署、付费调用、Git 提交或推送。

**本轮到此停止，保持 P2.4，不自动进入 P2.5。**

## P2.5 Template Engine（2026-11-01，Asia/Shanghai）

按本次明确的 P2.5 指令开始工作。实际基线为 `main@1b156483132846f5eccd1296e859cfbd495568b0`，工作区干净；历史 P2.4 审查和验证记录完整保留。

新增独立纯 TypeScript `packages/template-core`：严格 unknown 输入校验、字段/默认值规则、单次 Prompt 变量编译、Template Registry、既有 Model/ProviderRouter 能力验证、可生成状态，以及模板版本/输入/参数/路线快照。Server Adapter 仅组合原 `shared/templates.ts` 和 `server/templates/private.ts`，没有复制模板目录或 Prompt。原七个 Published、一个 Draft、6 秒展示参数、页面/SEO/前端表单和私有 Prompt 正文保留。

私有配置增加 templateVersion=1、text-to-video、可信 720p 默认分辨率及显式 development/test 的 mock-motion 绑定。生产 modelId 继续为 unassigned，所有生产模板返回 generation_unavailable，禁止 Mock fallback；原 Generate 关闭状态与 generation_not_open 不变。renderPrivatePrompt 已复用严格 Compiler/Validator。

Mock 能力统一到 Video Core 单一 catalog，由 Server/Worker 共用：时长 [5,6]、720p、显式 9:16，Model/Route revision 同步升至 2。mock-v1 adapter 不变，旧 revision 1 RouteSnapshot 仍按原 5 秒请求和保存的 Prompt 恢复。fixture 原字节不变，约 1 秒/160×90；模板请求 6 秒、Mock 模拟能力和约 6.041667 秒 Preview 是不同对象，未宣称 Mock 真实生成 6 秒视频。

本轮实际执行（Node v24.19.0、Corepack pnpm 11.24.0）：test:template **101/101**、test:video **21/21**、test:data **128/128**、test:video-engine **60/60**、test:unit **151/151**。保留原 **314** 项独立测试，新增 **101** 项，合计 **415** 项去重测试；video-engine 与 data 重复的 46 项只计算一次。所有测试 0 fail、0 skipped、0 cancelled。

typecheck:video 的生产/测试严格项目、Nuxt typecheck、独立 Worker 类型、lint、build、db:check 和 Nuxt/Video Worker 两次 Wrangler dry-run 全部通过。strict、noUncheckedIndexedAccess、exactOptionalPropertyTypes 保留，新增 Core/测试/Adapter 无漏检。lint 仅保留首页既有 v-html warning 1 条。新 Nuxt 客户端 33 个文本产物对七段完整私有 Prompt 及配置标记均零匹配。

Neon Night 完整离线集成经过 Public/Private → Validator → Compiler → GenerationInput → ProviderRouter → RouteSnapshot；禁止写入的临时 SQLite 中解析前后余额均为 10，total_changes 不变，任务/attempt/outbox/消费 operation 均为 0，submit/poll/网络调用探针均为 0。没有调用正式 createGeneration；原 P2.4 实际 workerd/Queue/R2 回归另行全部通过。

pnpm 新 workspace 检查最初受 store 路径、沙箱写权限、offline 政策元数据缓存及一次 CLI 选项使用错误影响；已使用原 store 完成 frozen install 和 1195 项政策核对，没有升级依赖。早期 import type lint 错误已修复。具体失败原因和最终结果保留在实现文档，不以跳过检查通过。

P2.6 契约仅设计：source、templateId/version、templateInputsSnapshot 与原 canonicalInput/routeSnapshot 同时固定；现有 canonicalInputHash 无法区分模板来源/版本，需未来增量 Migration 和版本化业务幂等身份、旧行兼容及重放先查原任务，禁止按最新 Prompt 恢复。没有在本阶段修改 schema、迁移、积分账本、Generation Service、支付流程或 Worker 管线。

验收结论：**PASS**（P2.5 本地范围）。未开放真实生成、HTTP Generation API、History/CMS，未执行真实 AI/支付调用、远端数据库操作、部署、Git 提交或推送。实现与接口见 [REELBAM_P2_5_TEMPLATE_ENGINE.md](REELBAM_P2_5_TEMPLATE_ENGINE.md)，原始输出与结果索引见 [P2.5 evidence](reviews/evidence/P2.5_TEMPLATE_ENGINE/results.json)。

**完成 P2.5 后立即停止，不自动继续 P2.6。**
