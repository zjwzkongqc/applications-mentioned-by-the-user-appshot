# 独立新小本本：已发布与线上验收

更新时间：2026-10-04。此记录补充 `docs/fresh-release-20261004.md` 中的发布后状态。

## 已发布入口

https://zjwzkongqc.github.io/applications-mentioned-by-the-user-appshot/fresh/

GitHub main 已发布源码版本：`f0e7a655b1f31da1077d47a19dab8659c904e7d8`。

Pages 发布工作流：
https://github.com/zjwzkongqc/applications-mentioned-by-the-user-appshot/actions/runs/37208820518

该工作流已 completed / success，2026-10-04 14:21:29 UTC 完成。不是只有构建成功：部署后实际读取了新网址，并通过真实已发布 Pages 的浏览器表单验收。

## 线上验收结果

工作流产物 `fresh-published-verification`（artifact 11304988623）包含不含凭据的 JSON 验收报告和匿名首页截图。

`fresh-smoke-report.json`：passed=true，readOnly=true，9 项检查通过。

`fresh-live-report.json`：passed=true，livePages=true，37 项检查通过。这一次没有拦截或替换网页静态资源，使用实际 GitHub Pages 新入口和真实 Supabase 新站 API。

已通过：新账号注册、创建小组、第二名成员加入、匿名和组外访问拒绝、训练记录保存、月度六维评分保存、普通成员不能修改或删除他人记录、不能修改他人评分、恢复码建立新会话并保留身份与资料、私有照片上传和字节比对、匿名照片读取拒绝。

真实 Chromium 浏览器验证：手机尺寸页面加载；填写表单保存训练记录；刷新后记录仍在并从数据库回读核对；月度评分表单保存；两个独立浏览器上下文保持不同身份；恢复码表单登录找回原身份；手机页面无横向溢出；无 JavaScript 运行错误；新页面未向旧 ChatGPT Site 或旧迁移 API 发出请求。

报告中的一个 `net::ERR_ABORTED` 对应浏览器导航期间取消的组看板请求，未导致上述检查失败；不能把报告概括为“没有任何网络取消或网络事件”。

## 清理与数据保护复查

已按本次报告中的精确测试账号、测试小组及记录 ID 清理合成数据，未按昵称或宽泛条件删除其他用户。测试照片已由其作者测试账号通过应用 API 删除。

随后独立 SQL 复查：新站账号 0、小组 0、训练记录 0、月度评分 0、照片关系 0、照片桶对象 0；新站 enabled=true。新站保持可用空白状态，等待群主和朋友建立自己的真实账号，不保留测试人物。

旧 Supabase 迁移接收区的账号、记录、迁移回执仍为 0；这不代表旧 ChatGPT Site 的数据量为零。本轮没有接入或修改原 Site 数据库，没有导入、删除或覆盖旧资料。

新后台角色读取旧接收区账号表的权限为 false；匿名角色使用新 schema 的权限为 false。旧 Pages 根目录的构建配置未切换，旧 Site 地址不变。

## 费用和验收边界

仍使用已确认的 Supabase Free 项目；本轮没有升级套餐，没有购买服务器、域名或收费分支。

mainlandTested=false：美国 GitHub Runner、手机尺寸 Chromium 不是中国内地真实手机网络或微信内置浏览器。因此不能承诺大陆所有网络稳定访问。还需群主与一名朋友在自己的实际网络完成一次登录、填写、刷新及恢复身份试用。

## 开始使用

群主先打开新入口，点击“开始使用 / 找回名片”，选择第一次使用并填写昵称，保存只属于自己的恢复码。再创建小组，点击“邀请搭子”，把群邀请链接发给另外五人。

朋友必须通过同一小组邀请链接进入，各自创建名片、保存自己的恢复码并加入小组；不要每个人分别创建一个新群。使用网站不要求 ChatGPT、GitHub 或 Supabase 账户。旧站恢复码不会自动成为新站的身份凭据。

正式群主账号未代为创建，恢复码由本人浏览器生成并由本人保存，不应共享给群友或写入仓库。
