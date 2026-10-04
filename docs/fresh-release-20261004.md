# 独立新站发布记录 · 2026-10-04

用户已明确同意保留旧站，另建新小本本，不迁移旧资料。本次不是迁移完成声明。

新站地址：https://zjwzkongqc.github.io/applications-mentioned-by-the-user-appshot/fresh/

## 已核验：发布前

GitHub Actions `37208614395`（job `111454986130`）成功；版本 `253a9abd546fbffb5f0e3ddb8ef132421fa8c3d9`。

https://github.com/zjwzkongqc/applications-mentioned-by-the-user-appshot/actions/runs/37208614395

37 项真实 API / 浏览器断言通过，包括：注册独立身份、创建小组、另一成员加入、匿名及组外访问拒绝、训练文字和月度评分保存、普通成员不能修改/删除他人记录或修改他人评分、恢复码建立新会话并保留身份、照片上传读取字节相同、匿名照片访问拒绝，以及实际 Chromium 手机尺寸浏览器填写表单、刷新保留数据、月度评分表单保存、另一浏览器身份隔离、恢复码表单登录和无横向溢出。

发布前浏览器使用本次构建的静态资源，并连接真实 Supabase 新站 API。并非实际已发布 Pages 的验收；实际 Pages 在发布后的独立工作流中验证。美国 GitHub Runner、Chromium 手机尺寸并不代表中国内地手机或微信内置浏览器验收。

原应用自动测试命令成功，178 项通过，11 项基础设施用例跳过；跳过项不当作通过。

## 修正的实际问题

第一次使用 networkidle 等待页面不适合该应用；改为等待实际 UI 就绪。之后定位到登录后组数据加载慢：默认远端 Edge 地区对新加坡数据库多次往返，浏览器还在等待组数据。新站请求改用官方 `forceFunctionRegion=ap-southeast-1`，保持数据库鉴权不变，并为请求增加 30 秒超时提示。修正后 37 项实际 API / 浏览器检查通过。

官方区域调用说明：https://supabase.com/docs/guides/functions/regional-invocation

## 隔离与费用

- 使用现有 Free 项目，不新建付费分支，不购买服务器或域名。
- 新函数 `tennis-fresh`、新 schema `tennis_fresh`、新私有桶 `tennis-fresh-media`。
- 状态明确为 `new-empty-app`，不插入旧站迁移收据。
- 后台专用角色不能读取旧 `public.accounts` 或写入旧 `public.records`；浏览器角色不能直接读写新数据区。
- 原 `tennis-api` 保持维护状态；原站无数据读取、删除或迁移。
- 构建新子路径前后，原 Pages 的 index.html / config.js SHA-256 不变。
- 测试全为合成账号；按报告中精确 ID 清理，不删除其他用户。

## 发布后的验收

此提交请求首次发布后运行只读烟测及一次性完整表单验收。状态以 GitHub Pages 的 deploy 和 verify-published job 为准，不因提交此文档就声明已上线。

后续普通提交仅运行只读烟测，不创建测试账号。只有手动选择 full_fresh_acceptance，或提交消息明确包含 `[fresh-acceptance]`，才执行会创建临时账号的完整验收，并须按报告 ID 清理。

使用步骤见 `docs/fresh-start.md`。群主本人先建立身份、自己保存恢复码，再创建群并邀请其余五人；不共享管理平台账号或群主恢复码。
