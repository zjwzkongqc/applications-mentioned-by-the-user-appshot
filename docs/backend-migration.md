# 免费 Neon 后台迁移

分享入口保持 [GitHub Pages](https://zjwzkongqc.github.io/applications-mentioned-by-the-user-appshot/)。免费目标后台使用 Neon Free：Postgres 保存共同记录，私有 S3 兼容对象存储保存头像和训练照片，Neon Functions 执行应用自己的身份与权限检查。群友无需注册托管平台。

这是部署与迁移准备说明。**目前新 Neon 后台尚未完成实际部署、原数据导入和微信访问验收。** 完成这些步骤后才切换公开网页；提交源码不会自动迁移数据。此前 Supabase Free 方案因低活跃可能需要群主手动恢复而被替换，旧平台代码仅保留为历史兼容模块，不作为当前部署入口。

当前线上数据为 schema 5，共 15 张应用表，包含 `account_credentials`、`monthly_ratings`、`record_photos` 和 `audit_events`。通用严格校验与导入导出核心已支持这些表及现有表的新字段，并通过完整迁移检查和真实 PostgreSQL 测试；Neon 的函数、存储和部署对接仍需真实项目联调。旧 schema 4 的 11 表工具不能用来切换线上数据。

## 群主首次准备

1. 登录或建立 [Neon Console](https://console.neon.tech/) 账户，创建一个 **Free project**，选择 **Singapore**，区域标识为 `aws-ap-southeast-1`。可选项受当时容量影响。
2. 保留创建好的主分支、默认数据库 `neondb` 与默认 owner 角色 `neondb_owner`，不要改名，以保持平台自动注入的连接与部署一致。提供公开 **Project ID**；部署时使用同一项目中已有的 **Branch ID**，可从 Console 复制，它不是数据库密码。
3. 使用 Neon 的 GitHub 集成连接本仓库，可自动添加仓库 secret `NEON_API_KEY` 与 variable `NEON_PROJECT_ID`；也可由本人把 API key 私下保存到 GitHub Actions Secrets。
4. 不要把 API key、数据库连接字符串、存储密钥或签名私钥发进聊天、群、邀请链接或仓库。只提供公开项目 ID 即可推进项目核对，不需要在聊天中提供数据库密码。

官方 Free 方案没有使用期限且无需信用卡。只选择 Free 方案，不启用收费附加项。新平台的首次账户建立与仓库授权仍需群主本人完成。

## GitHub 部署准备版本

在 [Neon 部署工作流](https://github.com/zjwzkongqc/applications-mentioned-by-the-user-appshot/actions/workflows/deploy-neon.yml) 手动运行，填写公开 `project_id` 与 `branch_id`。`project_id` 也可使用 Neon GitHub 集成提供的 `NEON_PROJECT_ID` 变量；`branch_id` 必须指定已有分支。

工作流读取私有 secret `NEON_API_KEY`，检查源码、运行测试、构建完整函数包、核验 Free 套餐与分支，然后在已有项目中初始化应用表、配置私有存储并部署函数 `tennisapi`。无法确认套餐或权限时停止；不会创建项目、升级套餐、上传快照、清空数据库或自动切换 Pages。

若部署 key 无法读取确认 Free 归属所需的组织信息，由群主在 Neon 核对 key 与账户权限，不使用付费备用方案或绕过核验。建表使用 `neon/schema.sql`，仅在目标无应用表时初始化；部分表存在时拒绝覆盖。

函数运行于 Node.js 24，支持浏览器访问的 HTTPS API，使用应用自己的会话、恢复码和成员关系验证；群友无需 Neon 登录。所有图片保留在 private 桶中，通过业务 API 鉴权读取。公开球员卡仅按本人主动开启的范围提供资料。

平台向函数注入 `DATABASE_URL_UNPOOLED` 和私有 S3 的 `AWS_ENDPOINT_URL_S3`、`AWS_REGION`、`AWS_ACCESS_KEY_ID`、`AWS_SECRET_ACCESS_KEY`。发布脚本设置 `TENNIS_PUBLIC_ORIGIN` 与 `TENNIS_BUCKET`，不需要群主手填上述连接或存储凭据。数据库连接、对象存储密钥和部署 key 均只在后台或 GitHub Secrets 中使用，不写入网页 `config.js`，也不发到聊天。

## 地址与迁移配置

函数入口使用 Neon 实际返回并经代码核验的 `invocation_url` HTTPS origin，不带路径。官方函数主机使用 `*.compute.<cell>.<region>.aws.neon.tech` 格式；必须复制部署返回的实际地址，不能从 Project ID 猜测。健康检查为该 origin 后的 `/healthz`，业务路径直接为 `/api/...`，不使用额外平台路径前缀。

函数包内的公开迁移配置保存迁移编号、经核验的原后台 origin、Pages 地址和 ECDSA 验证公钥。这些值不是用户凭据；签名私钥不在仓库。正常部署无需另行填写迁移秘密环境变量。

目标后台未收到完整校验的导入凭证时，共享 API 保持不可用，避免朋友在一份空的新数据中建立账户或记录。健康检查成功只代表服务已响应，不代表导入或手机验收完成。

## 迁移顺序

1. 先确认免费后台、快照格式、表字段清单、对象清单、签名验证和导入凭证均已与线上 schema 5 同步，并通过完整迁移测试。旧 11 表快照、只含头像的对象清单或小组 NDJSON 资料备份都不能替代完整后台迁移快照。然后部署新后台准备版本，保留原服务可用。请原先打不开页面的群友在大陆实际手机、微信和网络中测试 GitHub 分享页与新服务地址。区域距离较近不等于已验证可达。
2. 核对公开迁移配置中的编号、原 origin、新函数 origin 和 Pages 地址，整个流程使用同一组值。在真实 Free 项目先验证数据库、私有存储与导入权限。导入器会先用私有 canary 检查防覆盖的条件上传；平台不支持时拒绝迁移。应用完整快照上限为 32 MiB，但平台请求体接收能力尚未实测，必须在冻结原服务前验证本次完整快照大小的接收能力。普通 2 MiB 图片可上传不能替代完整快照验证。
3. 上述验收通过后，才为原服务安排短暂维护窗口，暂停写入并等待在途写入结束。`scripts/build-migration-export.mjs` 只在明确调用时生成临时管理导出版，正常发布不会包含它。管理员在原平台的秘密环境变量设置随机 `TENNIS_MIGRATION_ADMIN_TOKEN`，并开启 `TENNIS_MIGRATION_FREEZE=1`。冻结也拦截会写审计的 `GET/HEAD /api/export`，其他正常只读访问保留。
4. 最终服务端私有导出必须读取同一个数据库批次中的全部 15 张应用表，包含原邮箱与密码哈希参数、恢复码和设备凭据哈希及到期时间、成员状态、邀请期限、公开分享状态、月度评分、照片关系与审计事件；每个被引用头像和训练照片都必须包含原字节、类型与 SHA-256。缺表、字段或对象时拒绝半份备份。快照仍受工具明确的整体大小上限约束，不能为绕过上限漏掉照片。只读列表或抽样检查不能替代这份一致快照。
5. 快照和签名私钥只保存在仓库之外的私有目录中，目录权限 0700、文件 0600。快照不会通过 GitHub、Pages、构建产物或公开下载接口传递。
6. 管理员使用 `scripts/send-neon-backup.mjs` 将完整快照直接通过 HTTPS 发送到目标的 `/api/_owner/migration-import`。请求签名覆盖原字节 SHA-256、五分钟时间窗口、随机 nonce 和迁移元组。该接口不接受浏览器 Origin、Cookie 或普通登录凭据，不开放 CORS。无需将私有签名密钥部署到目标服务。
7. 导入拒绝已有应用数据的目标，验证所有记录字段、关系、凭据格式、图片字节与哈希。全部内容成功写入后才发布 schema 5 迁移凭证；失败不得开放半份群数据。同一已成功快照的签名重试可确认原凭证，不能替换已有数据。响应未确认时先检查目标凭证，不清空或覆盖数据。失败时保留私有暂存对象，重试仅复用字节、类型与哈希完全匹配的对象；不自动删除，以免断线后的延迟删除误伤已经成功导入的图片。
8. 校验原账户、邮箱密码登录、恢复码、仍有效的设备凭据、原成员编号与状态、群主权限、头像、私有训练照片、签到、训练记录、历史月度评分、0 分和待测、公开球员卡与撤回状态、审计及管理员资料导出。迁移只读身份验证接口不得生成新账户、登录凭据或延长邀请期限。
9. 在 GitHub Actions Variables 设置下表配置并重新运行 Pages 工作流。原设备打开 GitHub 链接后，网页只有在目标、迁移编号和服务器凭证匹配时才保留原身份；再用另一设备的本人恢复码或邮箱密码验证找回。仍有效的原邀请保留其原有效期，已过期或撤销的邀请不能重新启用。
10. 手机端验收通过后，原后台保持停止写入，并移除临时导出管理员秘密，避免两份群数据分别更新。

| Pages Actions Variable | 切换时的值 |
| --- | --- |
| `TENNIS_API_BASE_URL` | Neon 已验证的实际 `invocation_url` origin，不带路径 |
| `TENNIS_API_PATH_PREFIX` | 删除此变量或留空 |
| `TENNIS_MIGRATION_FROM_ORIGIN` | 同一原后台 origin |
| `TENNIS_MIGRATION_ID` | 同一迁移编号 |

私有发送工具的参数只传路径和公开 origin，不传私钥内容：

```sh
node scripts/send-neon-backup.mjs \
  --input /private/migration/snapshot.json \
  --signing-key /private/migration/signing-key.pk8 \
  --origin 'https://<部署返回的实际函数主机>'
```

上述路径和主机仅为格式示例，必须使用部署返回并已核验的真实函数地址，不能把私有文件放进源码目录。不要把整份快照、私钥或连接字符串作为命令行内容。

## 免费额度、维护与回退

Neon Free 官方没有使用期限、不需信用卡。数据库空闲约五分钟后缩到零，下次请求自动唤醒，不要求群主因闲置手动恢复；唤醒时可能需要短暂等待。

| 免费额度 | 当前官方包含量 |
| --- | --- |
| PostgreSQL 数据 | 每项目 1 GB |
| 私有对象存储 | 5 GB |
| 数据库计算 | 每月 100 CU-hours |
| 出站流量 | 每月 5 GB |
| Functions 活跃容量 | 每月 10 active capacity-hours |
| Functions 等待容量 | 每月 400 waiting capacity-hours |
| Functions 调用 | 每月 100 万次 |

这些是额度，不是无限资源或永远免费承诺。用尽计算、调用或流量额度可能暂时不可用，需要等待额度周期恢复或由群主重新决定方案；不会自动升级付费。当前群数据量小，仍须监测长期记录和照片增长。新加坡部署不保证大陆微信可达，必须实际测试。持续维护应安排独立私有备份，不能把私有数据上传公开仓库。

切换前的故障可恢复原服务写入并保留原 Pages 配置。切换后若新后台已接受写入，必须先暂停并备份新数据、同步差异后再回退；不能直接用旧快照覆盖新记录。原快照、旧设备身份和恢复凭据应保留至迁移验收完成。

新用户只需昵称与本人私密恢复码，不需邮箱密码。同一设备、同一浏览器记住本人；换设备或清理缓存后使用本人恢复码。注册回复丢失时保留临时注册准备，重试继续保存同一账户。原有邮箱账号与旧名片仍保留，迁移不重新生成其凭据或到期时间。仅凭昵称无法认领旧成员，退出本设备后不会再次自动导入旧身份。公开球员卡维持本人主动开启和撤回状态，私有训练照片不会随迁移自动变为公开。

## 官方参考

- [免费额度与价格](https://neon.com/pricing)
- [Functions 概述与运行环境](https://neon.com/docs/compute/functions/overview)
- [空闲缩到零与自动唤醒](https://neon.com/docs/introduction/scale-to-zero)
- [私有对象存储](https://neon.com/docs/storage/overview)
- [浏览器调用与 CORS](https://neon.com/docs/compute/functions/authentication)
- [GitHub Actions 与平台集成](https://neon.com/guides/neon-functions-github-actions)
- [函数部署 API](https://neon.com/docs/compute/functions/deploy)
