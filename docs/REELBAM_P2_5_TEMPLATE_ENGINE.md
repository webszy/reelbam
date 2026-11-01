# Reelbam P2.5 — Template Engine

日期：2026-11-01（Asia/Shanghai）。本阶段建立离线模板解析，不开放 Generation HTTP API 或付费生成。

## 1. 基线与交付边界

开始时分支为 `main`，HEAD 为 `1b156483132846f5eccd1296e859cfbd495568b0`，工作区干净，与需求中的 P2.4 Review Fix 基线一致。没有覆盖用户未提交修改，没有 Git 提交、推送或部署。

已阅读架构、进度、Video Core 和 P2.4 Review Fix 文档，并逐项检查实际 Template、Model、Provider、Router、Worker catalog 和 `createGeneration` 接口。当前代码优先于历史文档；P2.4 原始记录保持原样。

Template → Model → Provider 的依赖方向保留。没有第二套 Model Registry、Provider Registry、Router、积分账本或 Worker pipeline。现有 Generation Service、D1 Schema/迁移、Clerk、Creem 和页面未改写。

## 2. 目录和数据边界

```text
packages/template-core/
  package.json
  src/
    types.ts       # Definition、版本快照、未来来源元数据
    errors.ts      # 不含私有 Prompt/输入值的分类错误
    validator.ts   # unknown → 规范化字段
    compiler.ts    # 简单变量语法和一次插值
    registry.ts    # 身份、版本、字段、默认参数、Model 校验
    resolver.ts    # Video Core / Router、可生成状态、快照
    index.ts
  test/
    fixtures.ts
    validator.test.ts
    compiler.test.ts
    registry.test.ts
    resolver.test.ts
server/templates/
  private.ts          # 原有七个 Prompt，版本和可信服务端配置
  engine.ts           # Public + Private Adapter、内部解析入口
  engine.test.ts      # 真实目录与无副作用集成验证
  text-to-video.ts    # 继续返回 generation_not_open
packages/video-core/src/development-catalog.ts
                       # Server / Worker 共用的本地 Mock 能力
workers/video-worker/src/catalog.ts
                       # 薄包装；仅注入已有 fixture ID
```

`shared/templates.ts` 仍是唯一公开目录，保留七个 Published、一个 Draft、所有 6 秒参数、输入字段、标签、媒体和 SEO；`shared/template-view.ts`、表单和前端文件保持原样。没有复制另一份 `DEMO_TEMPLATES`。`server/templates/private.ts` 是唯一私有配置来源，原七段 Prompt 的正文及 ID/Slug 对应关系不变。

Template Core 只依赖 `video-contracts`、`video-core` 和标准语言/Web API。Core 不读取 Nuxt RuntimeConfig、数据库或环境全局变量，不依赖 Vue、Clerk、Creem、D1/R2 或具体 Provider SDK。实际目录只在 Server Adapter 组合，Core 中没有站点模板/Prompt 数据副本。

私有配置、内部编译结果和 `routeSnapshot` 只能在服务端使用。公开页面继续只消费 `shared/`；不得直接 JSON 序列化整个 Resolver 返回值到普通 API 响应。构建产物扫描和原目录/页面单元测试用于验证该边界，证据见第 11 节。

## 3. TemplateDefinition 与版本

`TemplateDefinition` 包含：

| 字段 | 来源 / 规则 |
| --- | --- |
| `templateId`、`slug`、`status` | 原 Public Template |
| `version` | 私有 `templateVersion`，安全正整数，从 1 开始 |
| `generationMode` | 私有配置；第一版只接受 `text-to-video` |
| `modelId` | 生产逻辑 Model，当前全部为 `unassigned` |
| `offlineModelIds` | 显式 development/test 覆盖，当前为 `mock-motion` |
| `promptTemplate` | 原私有 Prompt |
| `inputFields` | 原 Public Template 字段，以结构兼容的纯 TS 类型传入 |
| `defaultParameters` | Public duration/aspectRatio + 私有 resolution/可选 seed/audio |

`defaultParameters` 使用现有 `GenerationParameters`：`durationSeconds`、`resolution`、可选 `aspectRatio`、`seed`、`generateAudio`。客户端输入只能包含已声明表单字段，无法补齐或覆盖 `resolution`。当前可信服务端默认值为 `720p`，仍需通过 Model 和 Route 的能力检查。

修改 Prompt、字段类型/约束/默认值、生成模式、模型绑定或默认生成参数等影响结果的配置时，必须增加模板版本。展示文案、标签、poster 等不影响生成结果的编辑不要求升级。版本只描述模板；Model revision、Route revision 和 adapterVersion 分别由原 Video Core 合同管理。

Registry 和解析结果都深拷贝并冻结；快照 JSON 序列化后可独立保存。后续任务必须同时保存完整 `generationInput` / `canonicalInput`、原 `routeSnapshot` 和模板快照，不能仅保存版本号后重新读取最新 Prompt。当前没有历史模板 CMS/数据库；保留独立快照即可恢复原生成请求，不能据此声称已有历史模板编辑/重编译功能。

## 4. Registry 与公开生成状态

`createServerTemplateRegistry()` 从原 Public/Private 数据组合七个 Published 定义。它验证整个公开目录（包括 Draft）的 ID/Slug 唯一性、私有配置唯一性、Public/Private 身份匹配，以及每个 Published 是否具有私有配置。无配置的 Draft 仍留在原公开目录中，未被新增成可生成定义。

`TemplateRegistry` 提供 `getTemplateDefinitionById()`、`getTemplateDefinitionBySlug()` 和 `listDefinitions()`。构造时调用 `validateTemplateRegistry()`，检查正整数版本、状态/模式、重复字段/非法 Key、字段默认值、Prompt 变量和默认生成参数。传入 `{ modelRegistry, environment }` 时还检查绑定 Model 及其能力；缺少注册模型或参数不兼容会失败。

结构有效与当前可生成是两个判断。`getServerTemplateGenerationAvailability()` / Core 的 `getTemplateGenerationAvailability()` 进一步检查 Model、启用且兼容的 Route、已注册 Provider/version 和显式环境。所有预期配置/路由失败返回 `generatable: false`；它不检查某次尚未填写的表单，不创建任务，也不打开产品功能。

Draft/Archived 在服务端公开入口被明确拒绝，未知身份返回 `template_not_found`。`Published` 继续仅表示页面可公开展示、索引；生产目录现在全部返回 `generation_unavailable`，即使错误地注入开发 Mock Registry 也无法通过。既有 `prepareTextToVideo()` 始终返回 `generation_not_open`，Generate 按钮仍是 “Not open yet”。

## 5. 严格输入校验

`validateTemplateInputs(definition, unknownInputs)` 接受 unknown，只接收普通对象或 null-prototype 对象，不接收数组、null、字符串、Date 或自定义原型对象。

规则：

- 只允许声明的字段；未知字段、Symbol Key、原型危险名、getter/setter 及非字符串值一律拒绝，不自动把对象/数字转换为字符串。
- Key 必须以 ASCII 字母开头，随后为字母、数字或下划线，最长 64；禁止 `__proto__`、`prototype`、`constructor` 及 Object.prototype 自有属性名。
- 字段定义不能重复；类型仅 text/textarea/select，required 必须为 boolean；长度限制为非负安全整数，min 不得大于 max。
- 对所有字符串 trim；缺失或全空白先使用已验证的 `defaultValue`，没有默认值时变成 `''`。必填仍为空则失败，可选空值明确保留。
- 非空值按 trim 后的 JavaScript UTF-16 长度检查 minLength/maxLength；可选空值不触发 minLength。Select 的非空值必须精确匹配已声明选项；配置中的选项必须非空、无首尾空白且不重复。
- 默认值在 Registry 和 Validator 中使用相同约束检查，不能用非法默认值绕过字段规则。

返回按字段定义顺序生成的冻结字符串对象。例如 Neon Night 会补出 `mood: 'quiet'` 和 `details: ''`。前端 `shared/template-form.ts` 继续只承担 UX，服务端重新校验。Core 已支持可选 minLength；现有 Public 字段没有配置 minLength，未来在公开表单配置该约束时需同步扩展其字段类型/UX，不能只依赖前端。

## 6. Prompt Compiler

```ts
compileTemplatePrompt(promptTemplate, normalizedInputs, inputFields)
```

第三个参数是必填的声明字段，防止直接调用 Compiler 时把任意输入属性当成合法变量。只接受 `{{key}}`，允许 Key 两侧空白；禁止表达式、属性访问、函数、过滤器、嵌套、孤立大括号和未闭合占位符。普通文本如需字面大括号，当前语法不提供转义。

Registry 先检查每个变量均已声明；Compiler 再使用同一 Validator 检查必填字段和显式默认规则。未知/缺失变量不被静默吞掉。插值只解析可信模板一次，用户值中的 `{{anything}}`、`$&` 或 `$1` 原样插入，不递归处理，不使用 eval/Function/replace replacement-string 执行规则。输入对象顺序不影响输出。

`renderPrivatePrompt()` 已调用同一 Validator/Compiler，删除了原宽松空串替换逻辑，并修复了私有配置的原型属性查询问题。Compiler 没有网络、数据库或 Provider 调用。

## 7. Resolver 接口和调用示例

服务端示例（Node 测试/内部调用，不是 HTTP API）：

```ts
import { createLocalMockRegistries } from './packages/video-core/src/index.ts'
import { resolvePublicTemplateGeneration } from './server/templates/engine.ts'

const { models, providers } = createLocalMockRegistries('test', { nowMs: () => 1000 })
const resolved = resolvePublicTemplateGeneration({
  slug: 'neon-night', // 或 templateId；两者只能选一个
  userInputs: {
    character: 'A courier',
    action: 'Walking through the rain',
  },
  modelRegistry: models,
  providerRegistry: providers,
  environment: 'test',
})

// resolved.generationInput 符合现有 GenerationInput：
// modelId = mock-motion，mode = text-to-video，私有编译 Prompt，
// parameters = { durationSeconds: 6, resolution: '720p', aspectRatio: '9:16' }
// 不调用 createGeneration，也不把 resolved 返回给普通模板页面。
```

Core 的 `resolveTemplateGeneration()` 在相同参数之外接收 `templateRegistry`，用于其他纯 TS 调用者。流程：显式环境校验 → 查询身份/状态 → 输入规范化 → Prompt 编译 → 环境模型绑定 → 已有 Video Core 输入/Model 校验 → 原 ProviderRouter.select → 返回三个不可变对象：

1. `generationInput`：完整可信执行请求，已通过 `validateGenerationInput` 和 Router 的 Model/Route 能力校验。
2. `templateSnapshot`：schemaVersion/source、templateId/templateSlug/templateVersion、normalizedInputs、generationMode、最终 modelId、resolvedParameters。
3. `routeSnapshot`：原 Video Core 的版本化 Route/Model/Provider/adapter/capability/input 快照，没有创建第二种路线合同。

错误由 `TemplateEngineError` 分类：`invalid_template`、`invalid_inputs`、`invalid_prompt`、`invalid_environment`、`template_not_found`、`template_not_published`、`generation_unavailable`。字段错误只携带字段名；内部 unavailable reason 可指明 model_unassigned/model_not_found/no_compatible_route/能力字段等。普通 API 未来只应映射安全的公开错误码。

## 8. Model / Provider 能力与 Mock 修复

单一 Mock 定义移到 `video-core/src/development-catalog.ts`；Server 与 Worker 均通过 `createLocalMockRegistries()` 使用已有 Registry。Worker 只保留注入现有 fixture ID 的薄包装。

| 配置 | P2.4 | P2.5 |
| --- | --- | --- |
| Model ID / Route ID | mock-motion / mock-motion-local | 不变 |
| Model revision / Route revision | 1 / 1 | **2 / 2** |
| mode | text-to-video | 不变 |
| durationSeconds | [5] | **[5, 6]** |
| resolutions | [720p] | 不变 |
| optionalParameters.aspectRatios | 未声明 | **[9:16]** |
| Provider / adapterVersion | mock-local / mock-v1 | 不变 |

Model 和 Route 约束同步更新；公开模板仍为 6 秒。未声明的 seed/audio、错误比例、时长、分辨率继续被拒绝，Route 也能收窄 Model 能力。Provider 禁用使用现有语义：不注册该 adapter/version；Route 另有 enabled 开关。没有修改真实 Provider 能力或增加真实 SDK。

显式 development/test 才能构造 Mock；其他环境仍由原 Mock factory 拒绝。生产绑定只读 `modelId`，绝不读取 offlineModelIds；即使有人将生产 modelId 错配为 mock-motion，Resolver 也会拒绝选出的 deterministic_mock adapter。原 Worker 环境校验及 production 空 Provider Registry 保留，已有运行时生产拒绝回归继续通过。

旧任务不重新选路。revision 1 的 JSON RouteSnapshot 仍能通过当前 `mock-v1` adapter 恢复：用保存的 5 秒 capability、原 input/Prompt 和 handle 获取状态，未替换成 revision 2。新增回归使用本地 `projectSubmission()` 派生旧 handle，未执行 submit；原 P2.4 workerd 重启恢复测试也继续通过。

必须区分四个时长：

| 对象 | 时长 / 含义 |
| --- | --- |
| Template Generation Duration | 6 秒，是请求参数 |
| Mock Provider Capability | 模拟接受 5/6 秒，是流程能力声明 |
| Mock Fixture | 约 1 秒、自制 160×90 MP4，是可解码测试文件 |
| Template Preview Video | 约 6.041667 秒，是页面展示样片 |

fixture 字节、大小、编码和存储逻辑未改；Mock 并没有真实生成 6 秒、720p、9:16 的视频。通过能力检查仅证明请求可以在模拟流程中路由，不能作为真实模型质量/长度证据。

## 9. 新增热门模板的步骤

1. 在唯一 `shared/templates.ts` 添加 Public Template：唯一稳定 ID/Slug、现有字段类型、分类/标签、预览媒体、SEO、生成时长/比例。Draft 先保持隐藏；展示视频必须注明是 Preview。
2. 在 `server/templates/private.ts` 添加对应私有配置和 Prompt。首次 templateVersion=1，明确 generationMode、生产逻辑 modelId、可信默认 resolution；只有离线测试需要时才显式配置 development/test Model。
3. Prompt 只引用声明字段；为 Select 设置合法选项，按需要配置默认值/长度约束。不要把私有 Prompt 或 Provider ID 加到 Public Template。
4. 运行 `createServerTemplateRegistry()` 和带模型上下文的 `validateTemplateRegistry()`；使用 Server availability 验证启用的 Route/Provider 能否接受默认参数。生产无正式模型时保留 unassigned，并期望 generation_unavailable。
5. 添加解析/输入/版本边界测试，执行 test:template 和完整回归；更新模板版本说明。发布页面不会自动开放 Generate，发布也不代表 Preview 由当前模型生成。

## 10. P2.6 Generation API 与持久化契约

P2.5 **没有**新增 D1 Migration、修改 schema/账本或调用正式扣费创建流程。Resolver 不接受 database、queue 或 quote，也没有任何可执行这些副作用的端口。Neon Night 测试仅验证其 input 与现有服务的校验/Router/哈希合同兼容。

未来 API 完成现有 Clerk 本地身份认证、owner/限额校验和服务端报价后，统一调用原 `createGeneration(database, { ...command, input: resolved.generationInput, quote }, deps)`。模板/客户端均不决定最终积分价格。Freeform 与 Template 共用该服务和现有 Outbox/Queue/Worker，不能另建模板专属任务管线。

已导出 `GenerationSourceMetadata` 类型预留：

```ts
type GenerationSourceMetadata =
  | {
    source: 'template'
    templateId: string
    templateVersion: number
    templateInputsSnapshot: Readonly<Record<string, string>>
  }
  | { source: 'freeform' }
```

模板元数据可由 `resolved.templateSnapshot` 映射，完整执行请求继续存 canonicalInput，原路线继续存 routeSnapshot。创建事务要一起固定来源、模板版本、规范化字段、完整输入、路线和报价；不允许历史任务跟随最新配置，重启只读保存的执行请求和路线，不重新编译 Prompt。当前 `createGeneration` 会自行选路；P2.6 必须让最终持久化的 RouteSnapshot 与创建事务选中的版本一致，不能先保存 Resolver 的路线再执行服务后来另选的路线。

**现有幂等缺口已确认：** `canonicalInputHash` 仅包含底层 GenerationInput。两个模板版本即使版本号不同，只要编译结果/模型/参数相同，当前哈希仍相同；source/templateId/version 没有进入重放身份。P2.5 不改变它，避免破坏已有任务/账本幂等。

P2.6 的迁移与兼容要求：

- 使用新的增量 Migration 增加上述模板来源字段，以及显式业务身份版本/哈希（例如 businessIdentityVersion=2）；保留现有 canonicalInputHash 作为底层执行请求校验，不能覆盖旧哈希。
- 新业务身份至少包含 source、templateId/version、规范化 templateInputsSnapshot、canonicalInputHash；Freeform 单独编码，避免来源碰撞。仍使用现有 `(user_id, idempotency_key)` 唯一约束和同一原子创建/扣费事务。
- 重试先查询已提交任务，再比较原身份，不能先按当前 Template/Model/价格解析。要支持语义规范化重放，需要保留原版本的字段/默认值规则（版本化定义归档或额外服务端定义快照）；本阶段的执行快照足够恢复任务，但不提供旧表单规则的归档。也可另存严格规范的原 API 请求身份，明确定义原请求重放语义。
- 原无模板元数据的历史行沿用 v1 哈希重放规则；仅在能确认原任务来源时标记 freeform，否则保留未知/null，禁止根据最新 Prompt 猜测或回填 templateId/version。旧任务不重扣、不重排路由、不重写报价。
- 正式接入前补充同 key 跨来源/模板版本冲突、同版本规范化重放、旧行兼容、模板编辑/下架后重放、并发创建原子性及保存路线一致性测试。

这些是下一阶段接口需求，尚未实现，不会自动继续 P2.6。

## 11. 实际验证与证据

Node v24.19.0，Corepack pnpm **11.24.0**，TypeScript 6.0.3，Wrangler 4.114.0。所有要求的 pnpm scripts 均实际运行；结果和原始输出位于 [证据目录](reviews/evidence/P2.5_TEMPLATE_ENGINE/)。

| 命令 | 结果 |
| --- | --- |
| pnpm test:template | PASS，101/101 新增测试 |
| pnpm test:video | PASS，21/21 |
| pnpm test:data | PASS，128/128 |
| pnpm test:video-engine | PASS，60/60；包含 data 中的 46 项 |
| pnpm test:unit | PASS，151/151 |
| pnpm typecheck:video | PASS，生产与测试两项目，包含 Core 和 Server Adapter |
| pnpm typecheck | PASS，Nuxt |
| pnpm lint | PASS，0 errors；保留既有 Revolver v-html warning 1 条 |
| pnpm build | PASS，Nuxt cloudflare-module 构建 |
| pnpm db:check | PASS，仅检查迁移元数据 |
| tsc --project workers/video-worker/tsconfig.json | PASS |
| Wrangler Video Worker deploy --dry-run | PASS，仅本地打包 |
| Wrangler Nuxt deploy --dry-run | PASS，仅本地打包 |

原 314 项测试全部保留并通过；新增 101 项与原套件不重复，合计 **415 项去重测试**。video-engine 中的 46 项不重复累计。全部测试 0 fail / skipped / cancelled。严格配置 strict、noUncheckedIndexedAccess、exactOptionalPropertyTypes 未关闭；生产类型项目不引入测试 globals，测试项目覆盖全部新增单元测试与 Server Adapter 集成测试。

Neon Night 完整测试经过真实 Public/Private 组合 → Validator → Compiler → GenerationInput → Model/ProviderRouter → RouteSnapshot，使用原数据库迁移建立的临时内存 SQLite，预置 10 积分后设置 query_only。解析后余额仍为 10、total_changes 不变、任务/attempt/outbox/扣费 operation 均为 0；网络/submit/poll 的禁止调用探针均为 0。测试没有调用 createGeneration。原 P2.4 套件另行使用隔离本地 SQLite 和实际 Miniflare/workerd 运行，未触及远端或既有业务库。

开发过程遇到的失败均已处理：

| 失败 | 具体原因 / 处理 |
| --- | --- |
| 初次 pnpm script 依赖检查 | 新 workspace 包触发 install，默认 store 与现有 node_modules 的 store 不同，非 TTY 拒绝重建；没有删除 node_modules，改用原 store |
| 原 store 的沙箱内 frozen offline install | pnpm 的 store SQLite 索引位于工作区外，沙箱无法写入；使用已授权的依赖安装权限 |
| offline supply-chain metadata 检查 | 缺少 electron-to-chromium 的 npm 元数据缓存；改用联网 frozen install 获取政策元数据，1195 项政策检查通过，依赖版本未升级 |
| 初次 script 带 --store-dir | pnpm run 不接受该 install 选项；依赖检查完成后使用标准 pnpm scripts |
| 早期局部 lint | TemplateRegistry 只用作类型却未使用 import type；已修复，完整 lint 通过 |

Wrangler 命令依据本项目安装版本的 `deploy --help` 和 [官方 Workers commands](https://developers.cloudflare.com/workers/wrangler/commands/workers/#deploy) 核对。dry-run 只验证构建/打包，不证明远端资源或线上并发。

## 12. 已知限制与验收

第一版只处理现有 text-to-video 文本字段；没有图片/参考视频输入、CMS、历史模板编辑器、真实模型/Provider、用户 History、管理后台或 HTTP Generation API。快照已返回但没有模板元数据持久化字段；报价、鉴权后的正式创建和来源幂等迁移留给 P2.6。生产生成仍关闭，真实 Provider/支付及线上资源验收不属于本阶段。

最终验收结论：**PASS**（P2.5 本地范围）。[results.json](reviews/evidence/P2.5_TEMPLATE_ENGINE/results.json) 记录 13 项检查全部通过；[去重明细](reviews/evidence/P2.5_TEMPLATE_ENGINE/test-deduplication.json) 验证 415 项独立测试，[类型边界](reviews/evidence/P2.5_TEMPLATE_ENGINE/type-boundaries.json) 确认生产/测试文件无漏检。

新 Nuxt 构建的 [客户端扫描](reviews/evidence/P2.5_TEMPLATE_ENGINE/client-boundary.json) 检查 33 个公开文本产物，对七段完整 Prompt 和三个私有配置标记均为零匹配。[范围核对](reviews/evidence/P2.5_TEMPLATE_ENGINE/scope.json) 确认 app/shared、Generation Service、data/账本、迁移、支付 API、Nuxt/Wrangler 配置和 fixture 均与基线一致，七段原私有 Prompt 保留。Nuxt dry-run 为 1657.88 KiB / gzip 395.47 KiB，独立 Video Worker 为 369.07 KiB / gzip 70.39 KiB；两次均明确 dry-run 退出。

验收条件逐项满足：七个 Published 可离线解析；私有 Prompt 未进入客户端；unknown 字段严格校验；模板版本/输入/参数可独立快照；编译确定且不递归；GenerationInput 合法；Model/Provider/Route 能力检查有效；6 秒+9:16 通过；原 5 秒及其余 P2.4 回归通过；生产仍拒绝 Mock；Resolver 未产生任务或积分消费；Nuxt/Video Worker 均可构建。没有将静态代码或展示 Preview 当作执行证据。

P2.5 到此停止，不自动进入 P2.6。

## 13. 修改文件清单

除以下文件及 `docs/reviews/evidence/P2.5_TEMPLATE_ENGINE/` 原始验证记录外，没有其他源码改动。完整包内文件树见第 2 节。

| 文件 / 目录 | 变更 |
| --- | --- |
| `packages/template-core/package.json` | 新包，依赖仅 contracts/core |
| `packages/template-core/src/{types,errors,validator,compiler,registry,resolver,index}.ts` | 新增纯 TS 模板核心 |
| `packages/template-core/test/{fixtures,validator.test,compiler.test,registry.test,resolver.test}.ts` | 新增核心测试及通用夹具 |
| `packages/video-core/src/development-catalog.ts` | 新增单一 Mock 能力配置，Model/Route revision 2 |
| `packages/video-core/src/index.ts` | 导出共享开发 catalog |
| `workers/video-worker/src/catalog.ts` | 删除重复配置，调用共享 catalog |
| `server/templates/private.ts` | 增加版本、环境模型绑定、服务端默认参数，复用严格 Compiler |
| `server/templates/engine.ts` | 新增 Adapter、内部 Resolver 和 availability |
| `server/templates/engine.test.ts` | 新增真实目录/副作用/环境边界集成测试 |
| `server/templates/text-to-video.ts` | 显式相对 .ts 导入，便于独立严格类型检查；关闭行为不变 |
| `package.json` | 新增 test:template |
| `pnpm-lock.yaml` | 仅新增 template-core 的 workspace importer；既有锁图不变 |
| `tsconfig.video.json`、`tsconfig.video-tests.json` | 增加 Server Adapter 生产/测试类型覆盖；原 packages 通配符覆盖 Core |
| `docs/REELBAM_P2_5_TEMPLATE_ENGINE.md` | 本阶段实现、接口、验证及 P2.6 契约 |
| `docs/REELBAM_PROGRESS.md` | 只在末尾追加 P2.5 记录 |

`pnpm-workspace.yaml` 已有 packages/*，无需改动。HEAD 仍为最初的 P2.4 提交，交付为未提交工作区修改，没有自动提交或推送。
