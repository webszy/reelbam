# Reelbam P2.1：独立 Video Core 使用与复核

日期：2026-10-31。仅实现 Workspace、合同、注册/路由、Mock 和纯状态规则；没有 HTTP、数据库持久化、积分消费、Worker 或真实供应商。下文命令及代码示例均未运行。

## 包与依赖

```text
根 Nuxt 应用（原样保留）
packages/
  video-contracts/  @reelbam/video-contracts
    src/public.ts   公开输入、模型能力、公开生成 DTO
    src/internal.ts ProviderRoute、RouteSnapshot、handle、内部任务状态
  video-core/       @reelbam/video-core → video-contracts
    src/            validation、registries、router、Provider 接口、Mock、状态机、公开投影
    test/           Node test runner；两个 Mock Provider 静态配置在 fixtures.ts
  data/             @reelbam/data，空导出，仅包边界
```

contracts 的 `.` 只导出公开类型；`/internal` 单独暴露内部类型。core 是服务端执行核心，不能作为浏览器 DTO 入口；`toPublicGeneration` 用字段白名单投影，不输出路线或恢复 metadata。TypeScript 包 exports 不是安全访问控制，未来 HTTP 仍须认证、校验归属和过滤响应。

包均为 private `0.0.0`，直接导出 `.ts` 源码；面向本仓库 Node/Nuxt TypeScript 工具链，未提供发布用 JS/dist。现有业务未导入这些包。core 仅添加 contracts 的 `workspace:*` 本地依赖，没有第三方运行时依赖。data 未导入 Drizzle，也未移动现有 schema。

`pnpm-workspace.yaml` 只追加 `packages/*`；allowBuilds、patchedDependencies、最低发布年龄例外保留。锁文件手工追加三个 importer 和 core → contracts 的 link；原 root importer、所有既有 package/snapshot、版本和 Clerk patch hash 保留，未运行 pnpm 生成。匹配 pnpm 的 frozen 安装仍需用户验证，不能把文本一致性当作安装成功。

## 合同、能力和确定性路由

- `GenerationInput` 用 mode 判别：text 必须 Prompt；image 必须 imageAssetId；reference 必须 imageAssetId + referenceVideoAssetId。后两者的 Prompt 由模型和 Route 的 capability 控制。
- `Capability` 定义稳定 id、mode、Prompt 策略、时长、分辨率、可选 aspectRatio/seed/audio 的允许范围。不传可选约束表示不支持，不会静默忽略传入参数。
- Logical Model 与实际 Provider Model 分离；一个模型可有多个 Route。Route 只能缩小模型对外声明，不能扩大；每个模型每种 mode 当前只声明一个 capability。
- Router 接受 unknown，先验证严格字段，再验证模型能力和 Route 实际能力；不能从请求传 Provider ID、Endpoint 或任意内部字段。未知字段明确拒绝。
- 路由忽略 disabled、无已注册 adapter/version 或不匹配参数的路线；数字较小的 priority 优先，同值按 routeId 字符顺序排序，与数组顺序无关。无可用路线抛 RoutingError，不自动降级为 Mock。
- Snapshot 包含版本、逻辑模型 revision、Route revision、Provider/Provider Model/adapterVersion、实际 capability 和原输入的深拷贝。运行内冻结；JSON 保存/恢复后按原 Provider/adapterVersion 执行，不重新调用 select。

静态两路线示例在 `packages/video-core/test/fixtures.ts`：A 优先级 10，只接 reference 的 4 秒/480p；B 优先级 20，支持三模式、4/8 秒、480p/720p。两者只是假供应商配置，不是实接两个供应商。配置停用 A 后，新任务选 B；已有 A snapshot 仍要求 A 的兼容 adapter，缺失时明确报错，不替换为 B。

## Provider 接口与错误

`submit` 返回 accepted（handle）、rejected（确认未创建）、unknown（可持久化 recoveryMetadata）。`getStatus` 返回 pending / completed / failed；调用异常抛 `ProviderError`，它的七种错误分类没有 retryable 或自动重提许可。费用是 unknown 或带币种/整数微单位的 estimated/actual，未知费用不填 0。

`recoverSubmission`、`cancel` 是可选能力；Mock 实现恢复、不实现取消。接口中恢复 not_found 表示适配器已明确确认未受理；未来真实适配器不能把普通查不到、列表延迟或 HTTP 404 直接当作该保证。网络适配器应注入 `ProviderDependencies.request` 和配置，不能读取隐式全局环境；本阶段没有任何网络实现。

调用方必须在首次尝试前持久化 submissionKey、submittedAtMs 和 snapshot，并在恢复时沿用。Mock 的 deterministic_mock 标记只表示模拟任务派生是确定的，不是生产供应商强幂等保证。现在尚无 D1 层保证同 key 不被配上另一个输入；该唯一性和输入 hash 检查属于 P2.2。

## Mock 使用示例

下面演示直接操作已有测试夹具；不是新增应用入口或生产 seed。可在 Node TS 工具链中参考它编写本地实验，不需要网络或 Cloudflare。

```ts
import { createMockProvider } from '../packages/video-core/src/index.ts'
import { setup } from '../packages/video-core/test/fixtures.ts'

const { router } = setup()
let now = 1000
const snapshot = router.select({
  modelId: 'mock-motion',
  mode: 'reference-to-video',
  imageAssetId: 'image-1',
  referenceVideoAssetId: 'video-1',
  parameters: { durationSeconds: 4, resolution: '480p' },
})
const adapter = createMockProvider({
  environment: 'test',
  providerId: snapshot.providerId,
  adapterVersion: snapshot.adapterVersion,
  scenario: { submit: 'accepted', outcome: 'completed', completeAfterMs: 3000 },
}, { nowMs: () => now })
const result = await adapter.submit({
  snapshot, submissionKey: 'generation-1:step-1', submittedAtMs: now,
})
if (result.kind === 'accepted') {
  const saved = JSON.parse(JSON.stringify({ snapshot, handle: result.handle }))
  now = 4000
  // 模拟进程重启：新的 adapter 只读取保存的 handle 和 snapshot。
  const restarted = createMockProvider({
    environment: 'test', providerId: snapshot.providerId,
  }, { nowMs: () => now })
  const status = await restarted.getStatus(saved.handle, saved.snapshot)
  // 预期 completed，输出 { kind: 'fixture', fixtureId: 'reelbam/mock-video-v1' }，actual 成本 0。
}
```

支持的场景参数：

| 参数 | 值 / 用途 |
| --- | --- |
| submit | accepted / rejected / unknown |
| outcome | completed / failed / hang |
| completeAfterMs | 从首次保存的 submittedAtMs 起计算就绪时刻 |
| statusUnavailableForMs | 此时间段查询抛 provider_unavailable，之后正常查询 |
| recovery | unknown 提交后恢复为 accepted / not_found / unknown |
| failureCode | rejected/failed 的标准原因 |
| fixtureId | 输出逻辑 fixture 引用；不解析 R2、文件或远程 URL |

metadata 保存结果、时刻、输入快照身份和 fixture 引用；重启后不会用新配置重置旧 job 的状态。hang 不依赖定时器，直到执行层决定 deadline；Mock 本身不会自动终止或返还积分。仅精确的 development/test 环境值允许构造 Mock，production、staging、preview、缺失/未知值均拒绝。没有生产环境后门或全局 Provider 默认 fallback。

当前 fixture 是逻辑标识，没有复制视频二进制，也未实现存储输出；这不影响纯核心状态测试，但不等于已有可播放 Mock 视频。

## 状态规则

```text
queued --start_submission--> submitting
submitting --accepted--> processing --completed--> storing --output_stored--> succeeded
submitting --unknown/调用异常--> submission_unknown
submission_unknown --恢复受理--> processing
submission_unknown --确认未受理--> queued
submission_unknown/processing/storing --deadline--> needs_review
needs_review --恢复受理--> processing
needs_review --确认未受理/明确失败--> failed
submitting --明确拒绝--> failed
processing --上游明确失败--> failed
storing --不可恢复存储失败--> failed
```

poll_call_failed 保持 processing，storage_call_failed 保持 storing；都不能回到 queued 或触发 submit。needs_review 不是终态，不应触发失败退款。succeeded/failed 拒绝全部后续事件，包括重复和迟到事件；未来执行器可在读到终态后 ack/no-op，但不能绕过状态约束。

状态机只接收状态与已确认的领域事件；不验证外部消息证据、计算 deadline、实现 CAS/Lease，也不执行任何扣费或返还。needs_review 的恢复需要未来保存其来源和证据，不能把这个状态单独当作可安全重提的许可。

## 用户执行的检查命令

本阶段没有执行下列命令；结果全部为**未验证**。在 `reelbam/` 使用 Node 声明范围和 pnpm **11.24.0**。本机此前 pnpm 为 12.14.0，先由用户确认所用版本，不用新版改写旧锁文件。

```sh
pnpm --version
pnpm run typecheck:video
pnpm run test:video
pnpm run test:unit
pnpm run lint
pnpm run typecheck
pnpm run build
```

前置条件是用户自行安排匹配版本的依赖安装。纯 `test:video` 使用 Node 原生 runner 和相对 `.ts` 源导入，不加载 Nuxt alias loader、ofetch、Clerk 或 Cloudflare，因此可用受支持 Node 直接执行 package script；它不需要 Nuxt prepare。typecheck:video 需要已有 TypeScript 和 @types/node，Nuxt 的 lint/typecheck/build 还需依赖和生成配置。

匹配工具链后可由用户执行 `pnpm install --frozen-lockfile`；当前锁文件追加的 workspace importer/link 尚未通过 pnpm 验证。若安装报告差异，先保留日志核对，不能用升级依赖或丢掉 Clerk patch 作为修复方式。

预期结果：

1. typecheck:video 无 TS 错误，独立于 .nuxt；test:video 的输入/registry/route/Mock/状态机用例全部通过且无网络请求。
2. 原有 test:unit 回归通过；Clerk、Creem、账本、schema 和迁移仍与 P2.0 相同。
3. lint/typecheck/build 通过仅说明静态/打包接受，不代表 HTTP、D1 或视频生成闭环已实现。

测试覆盖矩阵对应四个测试文件：contracts（输入、能力、公开投影、Model Registry），router（多 Route/优先级/禁用/快照/拒绝），mock（提交三结果、恢复、临时异常、hang、重启、环境限制、费用），state-machine（合法/非法转移和终态）。这些是已编写的断言，不是已通过的结论。

P2.2 应接续快照/handle/attempt 持久化、客户端幂等和输入 hash、唯一 schema/增量迁移方案、统一 entitlement 账本的扣费/返还/现金退款联动；本阶段未开始这些实现。
