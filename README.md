# Nuxt SaaS Starter

从现有项目抽取的通用基础模板：Nuxt 4 + Clerk + Creem + GA4 + Cloudflare Worker + D1。没有复制原项目的密钥、域名、云资源 ID、商品 ID 或用户数据。

## 已保留

- `/` 通用首页、`/login` 登录/注册与全局登录弹窗。
- `/pricing` 通用定价；支付完成后回到 `/pricing?order=...`，从服务端轮询订单状态。
- Clerk 会话鉴权、D1 本地用户同步、安全登录返回地址。Clerk 控制台中配置的 OAuth/邮箱登录方式由 Clerk 组件承载。
- Creem 一次性购买、商品价格校验、幂等订单、HMAC webhook 验签、原子发放额度、退款按比例回收、争议记录。
- GA4 已接入 `G-SNYP5DWY31`，首次页面就绪及 Nuxt 页面切换后上报 pageview；地址中的查询参数和 hash 不参与上报。
- D1 + Drizzle 初始迁移、离线可展示的页面、Worker 本地预览及部署脚本。

已移除搜索、报告/PDF、R2、Queues、匿名免费额度、OpenWebNinja、Turnstile、Meta Pixel/CAPI、客服、通知中心及原站品牌资源。未引用的 Element Plus 等依赖也已清理。

## 本地启动

使用 Node 22.19+（22.x）、24.11+（24.x）或 >=26（推荐 Node 24 LTS），以及 pnpm 11.24。Nuxt 已升级并固定为 4.5.2，其余直接依赖保持原版本；Worker compatibility_date 沿用 2026-07-28，匹配 Wrangler 4.114.0 自带 workerd 支持范围。升级 Wrangler 后再验证并更新兼容日期。

```sh
pnpm install --frozen-lockfile
cp .env.example .env
cp .dev.vars.example .dev.vars
pnpm db:deploy-local
pnpm db:seed-local
pnpm dev
```

默认访问 `http://localhost:3000`。不填密钥也可查看首页、定价和法律页面；登录显示不可用，购买按钮禁用。默认 D1 使用占位 ID，仅用于本地模拟，不连接原项目数据库。

`.env` 由 Nuxt 开发/构建脚本读取；`.dev.vars` 为 Wrangler 本地运行环境。不要把 `.env` 当作生产 Worker secrets，也不要提交这两个文件。Clerk 模块是否加载是在 Nuxt 启动/构建时确定的，所以配置后必须重启/重新构建。

## Clerk

在 `.env` 和 `.dev.vars` 填入你自己的 `NUXT_PUBLIC_CLERK_PUBLISHABLE_KEY`、`NUXT_CLERK_SECRET_KEY`，并在 Clerk 配置允许的应用域名和 OAuth 回调。登录后默认回到 `/`，定价页发起的登录返回 `/pricing`。

D1 用户通过受保护 API 中的 `ensureLocalUser` 按需同步；`/api/me` 返回基本资料和有效额度。保留原项目 Clerk 2.6.21 的 runtimeConfig 合并 patch，版本已固定，升级 SDK 时应重新检查该 patch。

没有保留 `/api/webhooks/clerk`：原实现只用于 Meta 注册转化，并非用户同步。当前不提供 Clerk 删除用户的自动同步；如需要，应新增独立的验签 webhook 和业务数据处理策略。

## Creem 配置

1. 使用自己的 Creem 测试商品。共享商品定义在 `shared/billing-catalog.ts`，默认示例是 5 / 10 / 30 credits，USD 4.99 / 8.99 / 19.99，有效期 365 天。
2. 初始 schema 迁移在 `drizzle/`；`database/catalog.sql` 创建默认禁用的商品，不含 provider ID。
3. 复制 `database/configure-products.sql.example` 到本地 SQL 文件，填写对应 Creem product ID，运行：

```sh
pnpm exec wrangler d1 execute DB --local --file /absolute/path/to/your-products.sql
```

4. `.dev.vars` 设置 `CREEM_API_KEY`、`CREEM_WEBHOOK_SECRET`。仅 `APP_ENVIRONMENT=production` 使用正式 Creem API，其余环境使用测试 API。正式和测试环境应使用不同 D1 数据库及商品 ID。
5. `.env` 与 `.dev.vars` 中同时设置 `NUXT_CREEM_PAYMENT_ENABLED=true` 和 `NUXT_PUBLIC_CREEM_PAYMENT_ENABLED=true`，重启应用。服务端开关控制是否允许创建订单，前端开关控制按钮。
6. 在 Creem 设置 webhook：`https://你的域名/api/webhooks/creem`；本地需要自备可被 Creem 访问的 HTTPS 地址。`APP_URL` 设置为应用可信 origin，不含路径/query/hash；用于服务端生成成功回跳地址。

保留支持的事件：`checkout.completed`、`refund.created`、`dispute.created`。未知事件验签后确认接收，不提供订阅续费/取消功能。`billing_subscriptions` 表是现有支付关系的预留结构，不代表已实现订阅功能。退款处理是**处理 Creem 退款事件**，不提供用户主动调用 Creem 退款的接口；争议仅审计 opened 状态。

只有验证通过的 webhook 可以确认付款、发放额度，成功回跳 URL 本身不会触发到账。购买及退款写入额度流水；通用业务如何消费额度由新项目实现，本模板没有搜索扣费逻辑。

修改示例套餐后运行 `pnpm db:seed:generate` 更新初始化种子。种子对已有记录不会覆盖；上线后商品价格/权益变更请新建数据库迁移，历史订单保持购买时快照。共享商品编码同时用于服务端购买校验与账单摘要。

## GA4 和站点信息

GA4 ID `G-SNYP5DWY31` 直接写在 `app/plugins/analytics.client.ts`，不需要 `.env` 或 Worker vars。插件在首次页面就绪和 Nuxt 页面切换完成后发送一次 `page_view`，同一路径的查询参数或 hash 变化不重复计数。页面地址和引荐地址均去掉查询参数及 hash，标题取自更新后的页面；Google Signals 和广告个性化已关闭。

为避免与手动上报重复，在 GA4「管理 → 数据流 → Web 数据流 → 增强型衡量 → 页面浏览 → 显示高级设置」中关闭“基于浏览器历史事件的页面变化”。上线后可通过 GA4 实时报告检查访问。

`.env` 仍用于配置站点名称、描述和 `NUXT_PUBLIC_SITE_URL`，生产环境通过 Worker vars 配置这些站点信息。

`/terms`、`/privacy`、`/refund-policy` 是明确的待发布占位页，没有复制原站法律条款，上线前填写自己的内容。UI 没有假称现有个人资料编辑页；账号管理使用 Clerk UserButton。

## 部署到自己的 Worker / D1

本模板未创建或部署任何云资源。先登录 Wrangler，创建你自己的 D1：

```sh
pnpm exec wrangler login
pnpm exec wrangler d1 create your-app-db
```

编辑 `wrangler.jsonc`：Worker name、D1 database_name/database_id；将 `APP_ENVIRONMENT` 改为 `production`、`APP_URL` 与 `NUXT_PUBLIC_SITE_URL` 改成自己的 HTTPS origin。按需添加自定义域名 routes，配置站点名称、GA ID、支付开关。现有配置未绑定原项目域名或资源。

生产 secrets 使用 Wrangler 独立设置（不要提交到源码）：

```sh
pnpm exec wrangler secret put NUXT_PUBLIC_CLERK_PUBLISHABLE_KEY
pnpm exec wrangler secret put NUXT_CLERK_SECRET_KEY
pnpm exec wrangler secret put CREEM_API_KEY
pnpm exec wrangler secret put CREEM_WEBHOOK_SECRET
```

Clerk publishable key 是公开配置，也可作为 vars；secret key 和 Creem keys 必须保持服务端 secret。构建环境的 `.env`/CI 也需配置两个 Clerk keys，以启用 Clerk 模块。以上命令仅为操作说明，本次抽取未执行。

```sh
pnpm db:deploy
pnpm db:seed
# 在自己的远端 D1 执行正式商品映射 SQL
pnpm cf-typegen
pnpm deploy:check
pnpm deploy
```

`deploy` 包含占位 D1 ID、生产 origin 和 Clerk 构建配置检查。`deploy:check` 仅构建和 dry-run 打包，不验证远端 secrets、Clerk 登录或真实支付。生产部署不会自动上传本地 `.env`。

## 验证和开发

```sh
pnpm test:unit
pnpm typecheck
pnpm lint
pnpm build
pnpm db:check
pnpm preview:worker
```

`db:deploy-local` / `db:seed-local` 只修改本地模拟 D1；无 `local` 的对应命令操作你配置的远端 D1。Worker 预览默认端口 8787，测试支付时将 `.dev.vars` 中的 APP_URL 改成实际访问 origin。

核心文件：`shared/billing-catalog.ts`（商品）、`server/utils/zBilling`（支付核心）、`server/api/webhooks/creem.post.ts`（到账/退款）、`server/database/schema/index.ts`（数据库）、`app/plugins/analytics.client.ts`（GA）、`nuxt.config.ts` / `wrangler.jsonc`（运行配置）。

### Nuxt 4.5.2 升级说明

升级后已验证类型检查、lint、139 项单元测试、普通构建、启用 Clerk 模块的构建以及 Worker dry-run。开发服务器首页响应正常。当前上游 Nuxt CLI 的 `@bomb.sh/tab` 对 `cac` 的 peer 版本声明，以及 Nuxt DevTools 的 Vite hook 会出现兼容性警告；本次检查未发现影响启动或构建。真实 Clerk 登录和 Creem 支付仍需使用自己的配置验证。
