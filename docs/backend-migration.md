# 免费 Supabase 后台迁移

分享入口保持 [GitHub Pages](https://zjwzkongqc.github.io/applications-mentioned-by-the-user-appshot/)。共享后台使用 Supabase Free：Postgres 保存共同记录，private Storage 保存头像，Edge Functions 执行应用自己的免密码身份与权限检查。群友无需注册托管平台。

这是部署与迁移准备说明。**目前新免费后台尚未完成实际部署、原数据导入和微信访问验收。** 完成这些步骤后才切换公开网页；提交源码不会自动迁移数据。

## 群主首次准备

1. 在 [Supabase](https://supabase.com/dashboard/sign-up) 使用 **Continue with GitHub** 登录，创建 Free organization 和一个 Free project。
2. 优先选择 **Southeast Asia (Singapore)**，具体区域为 `ap-southeast-1`。可选项受当时容量与账户免费项目配额影响。
3. 使用创建页面的密码生成功能，私下保存数据库密码。不要把密码、服务密钥或平台 access token 发进聊天、群、邀请链接或仓库。
4. 提供公开项目 URL：`https://<project-ref>.supabase.co`。公开 URL 不能代替平台部署权限。

标准 Free 项目创建流程无需购买套餐或绑定付费信用卡。只保留 Free 方案，不启用收费附加项。新平台的首次账户建立仍需群主本人完成。

## GitHub 部署准备版本

在 Supabase 创建 scoped personal access token，只选择这个项目，授予 **Database Read-write** 和 **Edge Functions Read-write**。将 token 私下存入 GitHub 仓库 Settings → Secrets and variables → Actions → Secrets，名称为 `SUPABASE_ACCESS_TOKEN`。不需要授予计费、组织管理、其他项目或 API 服务密钥的读取权限。

在 [Supabase 部署工作流](https://github.com/zjwzkongqc/applications-mentioned-by-the-user-appshot/actions/workflows/deploy-supabase.yml) 手动运行并填写 `project_ref`。项目 ref 是公开 URL 中 `.supabase.co` 前面的 20 位小写字母。工作流检查源码、运行测试、构建函数、初始化应用 schema 并部署 `tennis-api`；不会上传快照、自动清空数据库或自动切换 Pages。

建表使用 Management API，不需要把数据库密码或 service role key 提供给 GitHub。该 SQL API 当前标记为 Beta；若平台接口不可用，可在 Dashboard SQL Editor 执行 `supabase/migrations/` 中的应用 schema。函数手动发布也可使用 Edge Functions → **Deploy a new function → Via Editor**，粘贴构建产生的完整 `dist/supabase/tennis-api.ts`。

函数配置 `verify_jwt=false`，使原邀请与免密码 session 能进入应用自己的验证逻辑。这不是取消业务权限检查。Schema 启用应用表 RLS、撤销浏览器角色权限，并建立 private `tennis-avatars` 桶。

运行时平台默认注入 `SUPABASE_URL`、`SUPABASE_DB_URL` 和 `SUPABASE_SERVICE_ROLE_KEY`；这些连接和服务密钥只在 Edge 内部使用，不写入网页 `config.js`。若数据库 TLS 需要专用 CA，可在平台设置 `TENNIS_DB_CA_PEM`，仍保留证书验证。仅在自动配置该环境变量时，token 另需 **Edge Function Secrets Read-write**；正常首次部署不需要这项权限。

## 地址与迁移配置

函数入口为 `https://<project-ref>.supabase.co/functions/v1/tennis-api`，健康检查路径为该入口后的 `/healthz`。

`supabase/functions/tennis-api/migration-config.mjs` 保存公开的迁移编号、经核验的原后台 origin、Pages 地址和 ECDSA 验证公钥。这些值不是用户凭据；签名私钥不在仓库。正常部署无需另行填写迁移秘密环境变量。

目标后台未收到完整校验的导入凭证时，共享 API 保持不可用，避免朋友在一份空的新数据中建立账户或记录。健康检查成功只代表服务已响应，不代表导入或手机验收完成。

## 迁移顺序

1. 先部署新后台准备版本，保留原服务可用。请原先打不开页面的群友在大陆实际手机、微信和网络中测试 GitHub 分享页与新服务地址。区域距离较近不等于已验证可达。
2. 核对公开迁移配置中的编号、原 origin、新项目 origin 和 Pages 地址，整个流程使用同一组值。先验证目标数据库、private 头像桶和导入权限。
3. 为原服务安排短暂维护窗口，暂停写入并等待在途写入结束。`scripts/build-migration-export.mjs` 只在明确调用时生成临时管理导出版，正常发布不会包含它。管理员在原平台的秘密环境变量设置随机 `TENNIS_MIGRATION_ADMIN_TOKEN`，并开启 `TENNIS_MIGRATION_FREEZE=1`。
4. 服务端私有导出读取同一个数据库批次中的全部 11 张表，以及每个引用头像的原字节、类型和 SHA-256。缺对象、失败或超过 32 MiB 时拒绝半份备份。只读列表或抽样检查不能替代这份一致快照。
5. 快照和签名私钥只保存在仓库之外的私有目录中，目录权限 0700、文件 0600。快照不会通过 GitHub、Pages、构建产物或公开下载接口传递。
6. 管理员使用 `scripts/send-supabase-backup.mjs` 将完整快照直接通过 HTTPS 发送到目标的 `/functions/v1/tennis-api/api/_owner/migration-import`。请求签名覆盖原字节 SHA-256、五分钟时间窗口、随机 nonce 和迁移元组。该接口不接受浏览器 Origin、Cookie 或普通登录凭据，不开放 CORS。无需将私有签名密钥部署到目标服务。
7. 导入拒绝已有应用数据的目标，验证记录字段、关系、头像字节和哈希。全部内容成功写入后才发布迁移凭证；失败不得开放半份群数据。同一已成功快照的签名重试可确认原凭证，不能替换已有数据。响应未确认时先检查目标凭证，不清空或覆盖数据。失败时保留私有暂存头像，重试仅复用字节、类型与哈希完全匹配的对象；不自动删除，以免断线后的延迟删除误伤已经成功导入的头像。
8. 校验原账户、恢复码、仍有效的设备凭据、原成员编号、群主权限、头像、签到、训练记录与六维成长数据。迁移只读身份验证接口不会生成新账户或登录凭据。
9. 在 GitHub Actions Variables 设置下表配置并重新运行 Pages 工作流。原设备打开 GitHub 链接后，网页只有在目标、迁移编号和服务器凭证匹配时才保留原身份；再用另一设备的本人恢复码验证找回。原群邀请链接继续有效。
10. 手机端验收通过后，原后台保持停止写入，并移除临时导出管理员秘密，避免两份群数据分别更新。

| Pages Actions Variable | 切换时的值 |
| --- | --- |
| `TENNIS_API_BASE_URL` | `https://<project-ref>.supabase.co`，不带路径 |
| `TENNIS_API_PATH_PREFIX` | `/functions/v1/tennis-api` |
| `TENNIS_MIGRATION_FROM_ORIGIN` | 同一原后台 origin |
| `TENNIS_MIGRATION_ID` | 同一迁移编号 |

私有发送工具的参数只传路径和公开 origin，不传私钥内容：

```sh
node scripts/send-supabase-backup.mjs \
  --input /private/migration/snapshot.json \
  --signing-key /private/migration/signing-key.pk8 \
  --origin 'https://<project-ref>.supabase.co'
```

上述路径仅为格式示例，不能把私有文件放进源码目录。`scripts/import-supabase-backup.mjs` 保留作为 owner 的私有直接导入维护工具；其数据库连接和 service key 只能通过私有 0600 配置文件、标准输入或明确选择的环境变量读取。

## 免费额度、维护与回退

当前 Free 包含 500 MB 数据库、1 GB 文件存储、每月 50 万次 Edge 调用、5 GB 普通出站流量及 5 GB 缓存出站流量，最多 2 个活跃免费项目。当前群数据量小，仍须监测实际用量；长期记录和头像会逐渐增长。

低活跃持续 7 天可能触发自动暂停，即使偶尔使用也不能保证免暂停。群主可在 Dashboard 点击 **Resume project**；最新官方规则允许暂停后最多 1 年内恢复。Free 不提供始终在线保证，也不提供可下载的 Dashboard 数据库备份。持续维护应安排独立的私有备份，不能把私有数据上传公开仓库。

切换前的故障可恢复原服务写入并保留原 Pages 配置。切换后若新后台已接受写入，必须先暂停并备份新数据、同步差异后再回退；不能直接用旧快照覆盖新记录。原快照、旧设备身份和恢复凭据应保留至迁移验收完成。

账户仍使用应用自己的免密码身份。同一设备、同一浏览器记住本人；换设备或清理缓存后使用本人保存的私密恢复码。仅凭昵称无法认领旧成员，退出本设备后也不会再次自动导入旧身份。

## 官方参考

- [免费额度与价格](https://supabase.com/pricing)
- [项目暂停与恢复](https://supabase.com/docs/guides/platform/free-project-pausing)
- [支持区域](https://supabase.com/docs/guides/platform/regions)
- [计费与信用卡要求](https://supabase.com/docs/guides/platform/get-set-up-for-billing)
- [Dashboard 部署函数](https://supabase.com/docs/guides/functions/quickstart-dashboard)
- [函数发布与 GitHub Actions](https://supabase.com/docs/guides/functions/deploy)
- [函数环境变量](https://supabase.com/docs/guides/functions/secrets)
- [Scoped access token 权限](https://supabase.com/docs/guides/platform/personal-access-tokens)
- [Management API 官方 OpenAPI](https://github.com/supabase/supabase/blob/master/apps/docs/spec/api_v1_openapi.json)
