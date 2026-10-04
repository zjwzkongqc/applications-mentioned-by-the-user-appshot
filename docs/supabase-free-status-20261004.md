# Supabase Free 部署记录 — 2026-10-04

本记录更新本轮准备说明中的账户、项目和后台状态。目标仍为 GitHub Pages + Supabase Free；不购买服务器、域名或付费附加功能。

## 本轮已完成

| 项目 | 实际结果 |
| --- | --- |
| 组织套餐 | 创建前确认 Free；部署后再次查询仍为 Free |
| 创建项目报价 | $0 / 月；经用户确认后创建 |
| 项目 | `tennis-club`，ref `kvbxmvwtblwibhesnleh` |
| 地区 | `ap-southeast-1`（新加坡） |
| 初始状态 | 创建返回 `ACTIVE_HEALTHY` |
| 数据结构 | 15 张应用表 + 1 张迁移收据表，共 16 张；与已有 schema 5 对应 |
| RLS | 16 张表全部启用；浏览器 anon/authenticated 角色没有表级直接读写权限 |
| 图片存储 | `tennis-avatars` 私有桶，单文件上限 2 MiB，JPEG/PNG/WebP |
| 后台函数 | `tennis-api` 版本 2，平台状态 ACTIVE |
| 当前数据 | 账户 0、训练记录 0、迁移收据 0；未导入或覆盖原数据 |
| Pages | 未切换后台地址，未修改 main 分支 |

安全检查仅返回 16 项 `RLS Enabled No Policy` 的 INFO 提示，没有返回 WARNING/ERROR。当前设计只允许后台访问应用表，浏览器不能直接读写，因此没有为浏览器创建放行策略；成员身份和内容归属仍必须由现有业务 API 验证。这并不是对应用整体安全或六人权限隔离的完整验收。

## 真实 HTTPS 检查

首次部署暴露出路径适配问题：平台运行时去掉 `/functions/v1`，而既有 handler 期待完整路径。已在 API-only 入口增加严格的函数路径规范化，保留请求内容和签名导入路径；不是删除权限或迁移保护。

修正后 [GitHub Actions 第 2 次检查](https://github.com/zjwzkongqc/applications-mentioned-by-the-user-appshot/actions/runs/37203729006/attempts/2) 实际通过。日志对应 job `111441240020`：

| 请求 | 实际响应 | 含义 |
| --- | --- | --- |
| `/healthz` | HTTP 200，`ok=true`，`maintenance=true` | 函数和数据库检查成功；业务仍未就绪 |
| `/api/auth/me` | HTTP 503，`ready=false` | 未迁移时账号接口保持关闭 |
| `/api/board` | HTTP 503，`ready=false` | 未迁移时组内内容接口保持关闭 |

同时验证了 Pages CORS 来源和 `Cache-Control: no-store`。测试未携带任何用户凭据，没有创建或读出个人记录。

**这次成功仅证明迁移接收端已部署、数据库连通并在未初始化时保持关闭，不代表球友已经能登录保存。** GitHub 美国测试机的结果也不能替代中国内地手机网络验收。

## 可重现代码

本次连接器部署的完整入口文件位于 `deploy/supabase-connected/`：

- `index.ts`：API-only 入口；复用既有身份验证、业务接口和签名导入。
- `canonical-request.mjs`：只还原精确函数路径，不接受任意转发主机。
- `deno.json`：部署时显式使用 `import_map_path=deno.json`。
- `canonical-request.test.mjs`：13 项路径、请求内容、签名路径和边界测试。

本地 Node.js 22.16.0 下对应 13 项测试全部通过，无跳过：

```sh
node --check deploy/supabase-connected/canonical-request.mjs
node --test deploy/supabase-connected/canonical-request.test.mjs
```

业务源文件固定引用已审查的 Git commit `ffbdc4b892be0da9d0674e77b00f524b5dfcd18b`，不跟随可变 main。发布接口关闭平台默认 JWT 检查，是因为应用已有自身会话与权限机制，迁移入口另有签名验证；不代表允许匿名访问私密数据。

后续重新部署这些文件时，必须传相对的 `import_map_path: deno.json`，不能沿用上次部署生成的临时绝对路径。原先常规打包流程尚未包含这个独立入口的运行时路径适配，不要在未合并、测试修复前直接用旧打包入口覆盖已修正的函数。

## 未完成与阻碍

**尚未取得并导入原后台的完整私密迁移快照，也未完成签名导入操作。** 现有程序是原应用的迁移接收端：没有通过校验的迁移收据就不开放业务。不能为了让测试变绿而插入虚假收据，不能把缺账号凭据的小组 NDJSON 备份当作完整迁移快照。

原账户、群权限、邀请期限、月度评分、训练记录、头像、训练照片和审计均须完整迁移并核对。接着需要两个真实测试身份验证登录、保存、跨设备恢复、普通成员不能修改他人内容、私有照片权限，再由实际中国内地手机网络验证。全部通过后才修改 Pages 配置并开放六人正式使用。

若以后明确选择不沿用原数据、另外创建一个全新的空群，应实现与原迁移隔离的安全初始化流程；本轮没有作出该切换，也没有删除或重置任何旧内容。

密码、私密恢复码、平台令牌、服务密钥、数据库连接串、完整快照和照片均未提交到公共仓库或测试日志。
