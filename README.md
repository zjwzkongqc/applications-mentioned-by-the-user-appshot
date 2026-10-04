# 网球搭子 · 群里的网球小本本

供微信群友记录打球与长期成长的网页：自己的昵称和头像、签到、训练内容与效果、下一次计划、六维自评，以及群里的故事和梗。

分享入口与源码使用 **GitHub**：

https://zjwzkongqc.github.io/applications-mentioned-by-the-user-appshot/

点击“邀请搭子 → 复制群邀请链接”后分享到微信群。群友建立自己的名片，记录各自训练。六维指标为正手稳定性、反手稳定性、发球控制、接发球能力、网前截击、移动与回位，每项 1–10 分。

## 进入自己的账户

首次建立名片后，页面保存免密码身份，并提供本人私密恢复码。同一微信或浏览器再次打开链接时自动进入自己的账户；换设备或清理缓存后使用本人恢复码找回。昵称、头像和历史跟随账户，每个群可使用不同的群昵称。

恢复码仅供本人保存，不能发进群或邀请链接。已登录设备可重新生成恢复码，旧码失效；退出登录撤销当前设备的凭据。仅凭昵称不能认领旧成员。应用自身的身份机制无需群友注册微信小程序、公众号或托管平台。

## GitHub Pages 与共享后台

GitHub Pages 发布静态网页；多人账户、共享记录和头像需要独立后台。本仓库已准备 Node.js + SQLite + 持久头像存储的后台，以及完整数据校验与导入工具。**准备源码尚未完成实际后台迁移**：部署资源、完整快照和手机访问测试完成后才切换网页。

详细配置、可选托管费用、数据迁移与回退步骤见 [独立后台迁移说明](docs/backend-migration.md)。修改网页不会自动迁移数据库。私有记录、头像、恢复凭据和数据备份不提交到仓库。

仓库 Pages 设置的 Source 使用 GitHub Actions。推送 `main` 或运行 [发布工作流](https://github.com/zjwzkongqc/applications-mentioned-by-the-user-appshot/actions/workflows/deploy.yml) 时自动检查、测试、构建并发布。新后台确认可用后，通过仓库 Actions Variables 的 `TENNIS_API_BASE_URL`、`TENNIS_MIGRATION_FROM_ORIGIN` 和 `TENNIS_MIGRATION_ID` 配置切换；未配置时保持现有发布配置。

## 检查与构建

要求 Node.js 22.13 或更新版本。

```sh
npm ci
npm run check
npm test
npm run build:pages
npm run build:node
```

网页输出到 `dist/pages`，独立后台输出到 `dist/node`，表结构在 `drizzle/`。独立后台运行不需要 npm 依赖，生产数据目录必须在源码目录之外的持久存储中。

签到按北京时间每天一次；补录历史训练不会补造签到。成长走势使用月度自评均值，未填写的自评不计为零分。
