# 网球搭子 · 群里的网球小本本

微信群里分享链接即可使用的网球兴趣小组记录应用：自己的昵称与头像、签到打卡、训练项目与效果复盘、下一次训练计划、六维自评、长期成长档案，以及群里的故事和梗。

网页与自动发布使用 **GitHub Pages**。共享记录和头像继续保存在之前已上线的小本本服务中。本方案不需要开通 Cloudflare 账户，也不需要填写云服务 API Token。

## 打开与分享

GitHub Pages 地址：

https://zjwzkongqc.github.io/applications-mentioned-by-the-user-appshot/

打开后创建群，点击 **邀请搭子 → 复制群邀请链接**，把链接发到微信群。朋友可以自己取名、上传头像并记录训练。

已有群可以在[原小本本](https://tennis-dazi-club-2026.divine-seal-5110.chatgpt.site)点击 **邀请 → 复制 GitHub 邀请链接**。在原先建立名片的微信或浏览器中打开这条 GitHub 链接，点击 **使用原页面的名片**，再确认连接，就能继续使用原来的成员身份、头像、训练记录与群主权限。

## GitHub Pages 发布

1. 打开 [Settings → Pages](https://github.com/zjwzkongqc/applications-mentioned-by-the-user-appshot/settings/pages)。
2. 在 **Build and deployment → Source** 选择 **GitHub Actions**。
3. 推送 `main` 后自动检查、构建并发布；也可以打开 [发布工作流](https://github.com/zjwzkongqc/applications-mentioned-by-the-user-appshot/actions/workflows/deploy.yml) 点击 **Run workflow**。
4. 在成功的部署任务中查看最终网页地址。

首次启用 Pages 需要 GitHub 仓库设置权限；当前写源码的 GitHub 连接不能代为更改该设置。无需配置仓库 Secrets 或 Variables。

## 数据与身份

GitHub Pages 托管网页和静态文件；共享数据库与上传接口由现有的小本本服务提供。修改 Pages 网页不会清空原来的群记录。服务地址在 `scripts/build-pages.mjs` 中配置。

群邀请链接包含访问凭据，请只在群里分享。源码仓库不包含群友记录、头像、邀请凭据或成员凭据。

记录保存到共享服务，成员身份凭据保存在当前微信/浏览器本机。清除浏览器数据或换设备后，需要重新建立名片或通过原页面连接现有名片。同一浏览器中的多个群分别记住身份。首次连接原名片时会请求本人确认，凭据不会进入复制的邀请链接。

签到按北京时间每天一次；补录历史训练不会补造签到。六维成长走势展示月度自评均值，未填写自评的记录不计为零分。

## 本地检查与构建

要求 Node.js 22 或更新版本。

```sh
npm ci
npm run check
npm test
npm run build:pages
```

静态网页输出到 `dist/pages`。通过本地静态服务器打开该目录即可预览布局；连接共享接口需要使用受信任的 GitHub Pages 域名。

`src/worker.js` 与 `drizzle/` 是已有共享服务的实现与表结构，用于维护接口。数据库、头像和本地状态不提交到 GitHub。网页部署工作流只发布 `dist/pages`。
