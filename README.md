# Business API Repository

这是一个可以直接部署到 Vercel 的 Next.js 16 项目。它复刻了原来的 API Repository 目录体验，并修复了“提交后刷新就消失”的问题：新增记录只会在 Supabase 真正写入成功后显示为已保存。

## 已包含的功能

- 56 条现有 API 作为静态基础数据；即使数据库暂时未连接，目录仍能使用
- 搜索，以及按 Category、Status、Company 筛选
- API 详情、endpoint 一键复制、官方文档链接和 CSV 导出
- 可公开使用的 Add API 表单
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

## 安全说明

- `SUPABASE_SECRET_KEY` 只在 `app/api/apis/route.ts` 的服务器环境使用。
- 新的 `sb_secret_*` key 只通过 `apikey` header 发送，不当作 Bearer JWT 使用。
- 浏览器没有 Supabase 写权限；新增内容必须经过服务端字段校验。
- 当前 `Map` 限流只对单个运行实例有效，不能替代生产级防滥用。公开推广前应再配置 Vercel WAF 或 Cloudflare Turnstile，并使用持久化、原子化的共享限流服务。
