# Business API Repository

这是一个可以直接部署到 Vercel 的 Next.js 16 项目。它复刻了原来的 API Repository 目录体验，并修复了“提交后刷新就消失”的问题：新增记录只会在 Supabase 真正写入成功后显示为已发布。

## 已包含的功能

- 56 条现有 API 作为静态基础数据；即使数据库暂时未连接，目录仍能使用
- 搜索，以及按 Category、Status、Company 筛选
- API 详情、endpoint 一键复制、官方文档链接和 CSV 导出
- 可公开使用、提交后立即发布的 Add API 表单
- 英文显示名称与当地语言官方原名分栏
- 9 个统一 Authentication 大类以及独立的 Authentication details
- Supabase 持久化、字段白名单、URL/长度校验、重复检查、蜜罐字段和进程内基础限流
- 响应式布局、键盘操作、焦点管理和社交分享预览图

## 目录

```text
app/
  api/apis/route.ts    # 读取与新增 API 的服务端接口
  data/apis.json       # 56 条基础数据
  globals.css          # 全站样式
  layout.tsx           # 页面元数据与根布局
  page.tsx             # 首页入口
components/
  api-repository.tsx   # 目录、详情与新增表单
lib/
  types.ts             # 类型、枚举与旧数据归一化
public/
  og.png               # 分享预览图
schema.sql             # Supabase 表结构和 RLS
```

## 1. 建立 Supabase 数据表

1. 打开你的 Supabase project。
2. 进入 **SQL Editor**，新建 query。
3. 复制并运行 [`schema.sql`](./schema.sql)。
4. 进入 **Project Settings → API Keys**，创建一个新的 server-side Secret Key。

不要把 Secret Key 提交到 GitHub，也不要使用 `NEXT_PUBLIC_` 前缀。之前泄露或作废的 key 不要再使用。

## 2. 本地运行

复制 `.env.example` 为 `.env.local`，只在你自己的电脑中填写：

```env
SUPABASE_URL=https://lkkbaljosnmtswpohrkv.supabase.co
SUPABASE_SECRET_KEY=sb_secret_your_new_server_only_key
NEXT_PUBLIC_SITE_URL=http://localhost:3000
```

然后运行：

```bash
pnpm install
pnpm dev
```

浏览器打开 `http://localhost:3000`。

## 3. 上传空的 GitHub repository

在这个项目目录运行；把最后一行替换成你自己的 repository URL：

```bash
git init
git add .
git commit -m "Create Business API Repository"
git branch -M main
git remote add origin https://github.com/YOUR-NAME/YOUR-REPOSITORY.git
git push -u origin main
```

也可以在 GitHub 网页中选择 **uploading an existing file**。此时只上传 `app`、`components`、`lib`、`public` 和根目录的源码/配置文件；不要上传 `node_modules`、`.next` 或 `.env.local`。

## 4. 部署到 Vercel

1. 在 Vercel 选择 **Add New → Project**。
2. Import 你的 GitHub repository；Framework Preset 会自动识别为 Next.js。
3. 在 **Environment Variables** 添加：
   - `SUPABASE_URL`
   - `SUPABASE_SECRET_KEY`
   - `NEXT_PUBLIC_SITE_URL`（第一次可先不填；部署成功后填 Vercel 的正式网址）
4. 点击 Deploy。
5. 如果部署后才修改环境变量，请在 Vercel 中重新 Redeploy。

部署完成后，任何访客都可以提交 API。成功提交会立即以 `Published` 状态写入 Supabase，并马上出现在公共目录中，刷新页面后仍然存在。静态 56 条数据与数据库记录会按“Company + API name”去重合并，并且访客不能用同名提交覆盖基础数据。

## 安全说明

- `SUPABASE_SECRET_KEY` 只在 `app/api/apis/route.ts` 的服务器环境使用。
- 新的 `sb_secret_*` key 只通过 `apikey` header 发送，不当作 Bearer JWT 使用。
- 浏览器没有 Supabase 写权限；新增内容必须经过服务端字段校验。
- 当前 `Map` 限流只对单个运行实例有效，不能替代生产级防滥用。公开推广前应再配置 Vercel WAF 或 Cloudflare Turnstile，并使用持久化、原子化的共享限流服务。
- 当前没有登录或人工审核；任何拿到 Vercel 链接的人都能提交并立即发布。内部传播时请控制链接范围，如果以后改为公开网站，应恢复审核或增加身份验证。
