# Supabase Free：真实后台验收与剩余接入 — 2026-10-04

## 本轮实际结果

已在现有 `tennis-club` Free 项目 `kvbxmvwtblwibhesnleh` 内完成隔离验收。没有建立付费分支，没有升级套餐，没有切换 GitHub Pages，也没有操作原 ChatGPT Site 数据。

GitHub Actions：
https://github.com/zjwzkongqc/applications-mentioned-by-the-user-appshot/actions/runs/37205027784

- Workflow：`Test six members on isolated live Supabase`。
- Commit：`e6c7b4488e01212f9ffa0dd9a363ba9cb97efa30`。
- Job：`111444317202`，状态 success。
- 场景执行时间（UTC）：2026-10-04 13:16:50 至 13:16:55。
- 场景断言：**68 项通过**，失败项为空。
- 既有源码检查、自动测试命令也成功；其基础设施跳过项仍不能视为已通过。

## 测试的真实范围

共享业务 handler 使用与正式代码相同的固定源码 commit `ffbdc4b892be0da9d0674e77b00f524b5dfcd18b`，在 Supabase Edge Function 运行，连接真实 PostgreSQL 与真实私有 Storage。测试通过独立 Request/Response 对象调用业务 handler；外部 GitHub Actions 通过实际 HTTPS 启动验收。

**不是完整浏览器端到端测试，不是实际两台手机测试，不是正式迁移接收端解除维护后的联调，也不是中国内地网络验收。**

| 能力 | 实际验证 |
| --- | --- |
| 六人身份 | 建立 6 个不同的测试账号，分别加入同一个测试小组；另有 1 个组外测试账号 |
| 注册重试 | 首次响应丢失后的重试保留同一账号和恢复码，不新增重复账号 |
| 独立权限 | 不同成员获得不同的成员身份；组外账号和匿名访问被拒绝 |
| 填写保存 | 训练记录、内容、心得、后续计划在数据库持久保存，并重新读取核对 |
| 重复提交 | 同一条记录重试不会重复创建；另一成员复用该记录 ID 被拒绝 |
| 月度评分 | 历史月份保留，0 分与未测 null 不混淆，超过 10 分被拒绝 |
| 普通成员隔离 | B 修改/删除 A 的记录、修改 A 的月度评分或资料均被拒绝 |
| 恢复登录 | 使用恢复码创建新会话后，仍读到同一身份、记录和群主权限；接口层模拟换设备 |
| 私有照片 | 上传、读取字节比对通过；匿名、组外成员和已移除成员不能读取；普通成员不能删别人的照片 |
| 管理员备份 | 小组资料备份含记录与照片字节，不含账号凭据；普通成员不能下载管理员备份 |
| 成员移除/恢复 | 移除后访问被拒绝；恢复后重新允许访问 |
| 退出登录 | 当前会话被撤销，重新读取身份为空 |
| CORS | 允许 Pages 来源预检，拒绝不受信任来源预检 |

测试账号全部为合成资料，**不是六位朋友的正式账号**。没有创建 Chris 的正式账号，也没有给任何真实成员重置密码或恢复码。

## 数据库与照片隔离

测试使用 `tennis_acceptance` schema 与 `tennis-acceptance-avatars` 私有桶。数据库角色 `tennis_acceptance_runner` 为 NOLOGIN、NOBYPASSRLS，只获测试 schema 的权限；每个数据库事务显式 SET LOCAL ROLE 和 search_path。测试角色不能读取正式 `public.accounts`，也不能写入正式 `public.records`。

测试表从既有正式结构复制，包含对应主键、索引、检查及重建到测试 schema 的外键。测试表启用 RLS，只允许隔离测试角色；没有放行 anon 或 authenticated。

验收后的独立 SQL 复查结果：

| 项目 | 结果 |
| --- | ---: |
| 通过的场景断言 | 68 |
| 测试账号 | 0 |
| 测试训练记录 | 0 |
| 测试桶照片对象 | 0 |
| 正式目标账号 | 0 |
| 正式目标训练记录 | 0 |
| 正式迁移回执 | 0 |
| 测试角色可读正式账号 | false |
| 测试角色可写正式记录 | false |
| anon 可使用测试 schema | false |

测试报告保存在 `tennis_acceptance.runs`，不含凭据、恢复码、照片或真实用户内容。v1 日志写入把报告序列化为 JSONB 字符串；该份报告已转换为 JSONB 对象，并回读核对 68 项结果。归档入口把写入改为 `$3::text::jsonb`，不涉及业务行为或正式迁移回执；这一归档改动未重新跑整套真实场景。

安全 Advisor 返回原正式接收区 16 项 `RLS Enabled No Policy` INFO，无 WARNING/ERROR。这些表刻意只供后台使用，浏览器角色没有表级放行权限；不因 INFO 而添加开放策略。官方解释：https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy

## 一次性执行入口已关闭

验收函数的运行入口当时仅接受指定仓库、分支和工作流签发的 GitHub OIDC JWT，校验签名、issuer、audience、repository/owner ID、ref、workflow_ref、subject 和有效期，不需要把数据库密码或服务密钥放进 GitHub。

验收完成后，`tennis-acceptance` 已部署版本 2 关闭程序：不加载数据库或 Storage，恢复平台 JWT 检查，通过网关的请求仅返回 410。现有 `tennis-api` 迁移接收函数未修改。若要重跑，必须由项目管理方显式重新部署受限测试入口、审查期限与次数限制；直接重跑旧工作流不再能启动测试。

相关代码：
- `deploy/supabase-acceptance/scenarios.mjs`：68 项已运行场景。
- `deploy/acceptance-entry/index.ts`：受限入口归档，含上述日志序列化修正。
- `.github/workflows/acceptance-supabase.yml`：已完成的 HTTPS 验收工作流。

## 原数据迁移仍未执行

当前连接能管理 GitHub 和 Supabase，但没有原项目生产数据库/私有对象存储的管理接口，也未找到可用的原网球完整备份。原代码仓库的存在不能代替数据库读权限。**原库实际数据量尚未在本轮核实，不假定一定有或没有历史记录。**

需要原项目环境提供 schema 5 的一致性快照：完整 15 张应用表、账号与凭据哈希、会话及期限、群权限和邀请、月度评分、训练记录、签到、头像、训练照片及审计。小组 NDJSON 资料备份不含账号凭据，源码 ZIP 也不含数据库；两者均不能替代完整后台快照。

此外，原签名私钥没有出现在当前工作环境中。正式导入时必须由有权的源端执行签名，或双方按合法授权流程重新配置验证公钥；不制造回执，不把测试数据冒充原数据，不绕过鉴权。

### 可交给原项目管理环境的执行请求

请在“网球搭子·群里的网球小本本”的原项目环境中，核实生产数据库和私有照片存储访问权限，按本 GitHub 仓库 `scripts/build-migration-export.mjs` 与 `supabase/functions/tennis-api/import.mjs` 的 schema 5 格式导出完整私密后台快照。包含全部 15 张应用表和所有被引用图片的原字节与校验值，不只导出源码或小组资料 NDJSON。仅为一致性导出安排必要的短暂停写，导出后维持原服务可用；正式切换前仍需冻结并获取最终快照，不能使用已过时副本覆盖新增记录。快照保存在私密位置，不打印凭据或私钥，不提交公开 GitHub。回传各表数量、图片数量、schema 版本、文件校验值及私密交接方式；若源平台无数据库权限，明确报告缺失权限，不生成空快照。不要清空原数据、升级套餐或切换 Pages。

收到并校验有权限来源的完整快照后，剩余步骤为：真实导入与回执校验、原身份和资料核对、完整网页联调、国内手机网络验收，最后才切换 Pages。当前 Free 套餐已再次确认，不需要购买 NAS、服务器或域名。
