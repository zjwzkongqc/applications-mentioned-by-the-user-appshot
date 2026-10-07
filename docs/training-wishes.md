# 训练心愿

当前功能仅用于 GitHub Pages 的 `/fresh/` 新版，由现有 `tennis-fresh` 后台保存。

- 每小时按 ¥150 计算，每分钟 ¥2.50；后台以整数分计算。
- 汇总当前账号名下所有群的训练记录时长，包括已有记录。单独签到不计时。
- 修改或删除训练记录后，累计训练等值和心愿进度重新计算。
- 心愿填写名称、目标价格和可选图片，跟随账号保存；网页及图片接口仅本人可查看和修改。昵称、心愿名称及目标金额会通过私有每日邮件汇总给群主制作图片，页面表单已说明，详见 [每日制作清单](daily-wish-images.md)。
- 每个心愿都对照同一份累计训练等值，不是资金分配；实现一个心愿不会扣减累计值。
- “心愿已实现”由本人标记，可以改回继续努力。进度达到目标不会自动标记购买。
- 训练等值是自我激励的估算，不代表实际收入、存款或可兑换余额。

## 实现与发布

前端 `src/wishes.js` 和 `src/wishes.css` 仅由 `scripts/build-fresh-pages.mjs` 加入新版，旧站入口不加载该功能。个人数据不加入群动态或公开球员卡。

`deploy/fresh/wishes.mjs` 验证已有的 `X-Tennis-Session` 会话，只操作对应账号的心愿。图片复用私有 `tennis-fresh-media` 存储桶，经相同账号校验后读取；前端不包含后台密钥。

增量 SQL 在 `deploy/fresh/migrations/`，与旧站迁移脚本分开保存，避免把新功能应用到其他数据库。仅为 `tennis_fresh` 新增 `training_wishes` 表；RLS 只允许后台专用角色，前端公共角色无访问权。

发布顺序：验证源代码和测试 → 应用此增量 SQL → 部署该提交的 `deploy/fresh/index.ts` 与其心愿模块到现有 `tennis-fresh` 函数 → 更新 GitHub main 并等待 Pages 自动发布 → 检查新页面和 API。原有函数依赖继续使用固定版本。

验证：`node test/wishes-api.test.mjs` 检查计算、真实记录变更、会话、越权和图片；安装 Playwright 后运行 `node test/wishes-browser.mjs` 检查手机端完整操作。浏览器测试使用隔离的 SQLite 数据，不向线上群写测试记录。
