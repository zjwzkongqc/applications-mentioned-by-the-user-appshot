# 网球搭子 · 群里的网球小本本

供微信群友记录打球与长期成长的网页：自己的昵称和头像、签到、训练内容与效果、下一次计划、六维自评，以及群里的故事和梗。

GitHub 分享入口：

https://zjwzkongqc.github.io/applications-mentioned-by-the-user-appshot/

点击“邀请搭子 → 复制群邀请链接”后分享到微信群。邀请七天有效，只展示小组名称与口号；球友登录并主动加入后，才能查看组内名片、记录与照片。成员修改自己的内容，后台验证成员关系和归属。

六维指标为正手稳定性、反手稳定性、发球控制、接发球能力、网前截击、移动与回位，每项 0–10 分，也可单独保留“待测”。月度球员卡逐月保存，与自己的上次比较，0 分与待测分开记录。

## 进入自己的账户

新用户只需填写昵称建立个人名片，保存私密恢复码，无需邮箱或密码。同一设备、同一浏览器再次打开时自动进入；换设备或清理缓存后，使用本人恢复码找回球员卡、照片、记录和群主权限。每个群可使用不同的群昵称。昵称不是登录凭据，小组邀请不能认领别人的名片。

首次回复丢失时，页面保留临时注册准备；重试继续保存同一个账号和恢复码，不新建重复名片。完成保存或退出时清除注册准备。原有邮箱账号可从“以前用邮箱登录的账号”使用原邮箱和密码登录，恢复码也继续可用。原设备的旧名片先保存原身份即可继续使用，原头像、历史和权限保留。

恢复码仅供本人保存，不能发进群或邀请链接。已登录设备可重新生成恢复码，旧码失效；退出登录撤销当前设备的凭据。仅凭昵称不能认领旧成员。群友无需注册微信小程序、公众号、GitHub 或 Neon 账户。

## 私密分享与管理

月度评分的 0 分与待测分开保存，历史月份保留。打球照片默认仅组内可见。本人可主动公开自己的头像、昵称、介绍和最新月度评分，公开链接支持立即撤回。管理员可撤销邀请、移除或恢复成员、代改资料与评分并留操作记录，下载包含图片字节与历史的 NDJSON 小组资料备份（不含账号凭据，不是后台迁移快照）。

## 免费发布方案与当前状态

网页通过 GitHub Pages 分享；免费目标后台使用 Neon Free 的 Postgres 保存共同记录，私有 S3 兼容存储保存头像和训练照片，Neon Functions 提供业务 API。管理平台账户只由群主维护。此前 Supabase 方案因低活跃可能需要群主手动恢复，已由此方案替换。

**新 Neon 后台尚未完成实际部署和数据迁移。** 当前线上应用的数据为 schema 5，包含原账户凭据、月度评分、训练照片与审计。通用迁移核心已支持完整的 15 张表及所有头像、训练照片，并通过身份、数据导入和真实 PostgreSQL 检查；Neon 函数和私有存储仍须完成平台联调。不能套用旧 schema 4 的 11 表工具。

已有 GitHub 分享入口不代表已切换到 Neon。群主创建 Free project、部署、完整原数据导入及实际手机访问验收完成后，才更新网页配置。迁移须保留原账户与凭据、群权限和邀请期限、所有评分、记录、头像、照片与审计，不建立一份空的群数据。

Neon Free 官方方案没有使用期限，不需信用卡；数据库空闲约五分钟后缩到零，下次查询自动唤醒，无需群主因闲置手动恢复。免费仍有数据库、存储、计算、调用和流量额度，超额可能暂时不可用。以 [官方价格](https://neon.com/pricing) 和 [自动唤醒说明](https://neon.com/docs/introduction/scale-to-zero) 为准；不承诺无限用量、长期始终在线或大陆微信可达。

创建 Free project、配置 GitHub 发布、迁移和回退步骤见 [免费后台迁移说明](docs/backend-migration.md)。密码、平台 token、登录凭据、私有快照与头像文件均不提交到仓库或 Pages。

## GitHub 发布

仓库 Pages 设置的 Source 使用 GitHub Actions。推送 `main` 或运行 [网页发布工作流](https://github.com/zjwzkongqc/applications-mentioned-by-the-user-appshot/actions/workflows/deploy.yml) 时，自动检查、测试、构建并发布静态网页。

免费后台使用单独的 [Neon 部署工作流](https://github.com/zjwzkongqc/applications-mentioned-by-the-user-appshot/actions/workflows/deploy-neon.yml)。群主创建新加坡 Free project，保留默认数据库 `neondb` 与角色 `neondb_owner`，将 `NEON_API_KEY` 私下保存到 GitHub Actions Secrets，手动填写公开 `project_id` 与 `branch_id`。Neon 官方 GitHub 集成也可代写部署 secret 和项目变量。这一步只部署准备版本，不自动导入原数据或切换 Pages，也不会创建项目或升级套餐。

新后台验收后再设置 Actions Variables：

| 变量 | 值 |
| --- | --- |
| `TENNIS_API_BASE_URL` | 已验证的 Neon 函数 `invocation_url` 的完整 HTTPS origin，不带路径 |
| `TENNIS_API_PATH_PREFIX` | 删除此变量或留空，Neon 入口无需额外前缀 |
| `TENNIS_MIGRATION_FROM_ORIGIN` | 经核验的原后台 origin |
| `TENNIS_MIGRATION_ID` | 与后台公开迁移配置一致的 64 位小写十六进制编号 |

未配置新后台时保持现有发布配置。修改网页或提交源码不会迁移数据库。

## 检查与构建

Neon 函数运行于 Node.js 24；本地检查与打包建议使用同一版本。

```sh
npm ci
npm run check
npm test
npm run build:pages
npm run build:neon
```

网页输出到 `dist/pages`，后台包输出到 `dist/neon/function.zip`，包含入口 `index.mjs`。Neon 表结构位于 `neon/schema.sql`，函数源码位于 `neon/functions/tennis-api/`。

签到按北京时间每天一次；补录历史训练不会补造签到。成长走势优先使用独立月度自评；没有月度卡时保留原场次自评均值。未填写的自评不计为零分。
