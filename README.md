# 网球搭子 · 群里的网球小本本

微信群里分享链接即可使用的网球兴趣小组记录应用。支持自己的昵称与头像、签到打卡、训练项目与效果复盘、下一次训练计划、六维自评、长期成长档案，以及群里的故事和梗。

这是完整应用源码：前端与 API 运行在同一个 Cloudflare Worker，D1 保存群与训练记录，R2 保存头像。GitHub Actions 负责检查、构建、迁移和发布。GitHub Pages 不能独立运行这些数据库与上传功能。

## 连接 Cloudflare 后上线

1. 登录自己的 Cloudflare，在 **Workers & Pages** 开通 Workers 并注册自己的 **workers.dev 子域名**，在 **R2** 开通存储。首次部署需要先完成这些控制台步骤，CI 无法交互开通。
2. 在 Cloudflare 创建限定到自己账户的 API Token，给予 **Workers Scripts: Edit**、**D1: Edit**、**Workers R2 Storage: Edit** 和 **Account Settings: Read** 权限。Token 只填写在 GitHub Secret 中。
3. 打开本仓库 [Settings → Secrets and variables → Actions](https://github.com/zjwzkongqc/applications-mentioned-by-the-user-appshot/settings/secrets/actions)：
   - 在 **Secrets** 添加 `CF_API_TOKEN`，值为上一步的 Token。
   - 在 **Variables** 添加 `CF_ACCOUNT_ID`，值为 Cloudflare 控制台显示的 32 位账户 ID。
4. 打开 [Actions → Deploy tennis club](https://github.com/zjwzkongqc/applications-mentioned-by-the-user-appshot/actions/workflows/deploy.yml)，点击 **Run workflow**，选择 `main`。
5. 成功后在工作流的 **Publish application** 日志里找到 `https://…workers.dev` 地址。打开它，创建自己的群，再点 **邀请搭子** 复制群邀请链接发到微信群。

第一次部署会查找名为 `tennis-club` 的 D1 数据库与 R2 桶，缺少时自动创建，然后依次应用数据库迁移。之后推送 `main` 会自动发布。还没有填写 Cloudflare 配置时，推送只执行源码检查与构建；手动部署会明确提示缺少配置。

如果要使用指定的存储，添加可选 GitHub Variables：

| 变量 | 用途 | 默认值 |
| --- | --- | --- |
| `CF_D1_DATABASE_ID` | 指定已存在的 D1 数据库 UUID | 查找或创建数据库 |
| `CF_D1_DATABASE_NAME` | 首次查找/创建数据库时的名称 | `tennis-club` |
| `CF_R2_BUCKET_NAME` | 使用或创建的 R2 桶名 | `tennis-club` |
| `CF_WORKER_NAME` | 发布的 Worker 名称 | `tennis-club` |

建议使用专门的数据库与头像桶；指定已有数据库时，工作流会在该数据库上应用本项目的迁移。

## 已有群与数据

此前的 [在线小本本](https://tennis-dazi-club-2026.divine-seal-5110.chatgpt.site) 继续可用。部署到自己的 Cloudflare 是一个独立的新环境，**不会自动迁移此前的群、记录、头像或浏览器身份**。新环境需要创建群并分享新的邀请链接。

群邀请链接含有访问凭据，请只在群里分享。仓库包含代码和空表结构，不包含群友记录、头像、邀请凭据或 API Token。签到按北京时间每天一次；补录历史训练不会补造签到。六维成长走势展示月度自评均值，未填写自评的记录不计为零分。

## 本地运行

要求 Node.js 22 或更新版本。

```sh
npm ci
npm run check
npm test
npm run build
npm run db:migrate:local
npm run dev
```

打开 `http://127.0.0.1:5173`。本地数据库与头像放在 `.wrangler/state`，不提交到 GitHub。

生产部署配置由脚本根据 GitHub Variables 生成，不使用 `wrangler.json` 中的本地占位数据库。迁移文件在 `drizzle/`，已发布的迁移保持不变；修改表结构后运行 `npm run db:generate` 生成新的迁移。
