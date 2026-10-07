# 苹果官网配色

按用户要求，正式 `/fresh/` 记录本直接采用苹果中国官网的基础色值。此变更只涉及呈现，账号、训练、心愿和私密图片接口沿用现有实现。

## 核对来源

2026-10-07 读取 [苹果中国官网](https://www.apple.com.cn/) 及其当日加载的 [主样式](https://www.apple.com.cn/v/homepage/a/styles/main.built.css)、[首页样式](https://www.apple.com.cn/v/homepage/a/styles/homepage.built.css)。源样式中的 RGB 值换算为下表十六进制值，直接用于本站。

| 用途 | 色值 | 官网样式依据 |
| --- | --- | --- |
| 卡片、面板 | `#FFFFFF` | `--sk-body-background-color` |
| 页面底色 | `#F5F5F7` | `--sk-fill-tertiary` |
| 正文、标题 | `#1D1D1F` | `--sk-body-text-color` |
| 次级说明 | `#6E6E73` | `--sk-glyph-gray-secondary` |
| 分隔线 | `#D2D2D7` | `--sk-fill-gray-tertiary` |
| 主要按钮与图表 | `#0071E3` | 官网按钮背景及 `--sk-focus-color` |
| 文字链接 | `#0066CC` | `--sk-body-link-color` |
| 辅助蓝色、焦点描边 | `#0077ED` | `--sk-button-background-hover` |

色值直接引用；布局、网球图标及业务内容仍属于记录本。页面不加载苹果的外部 CSS、字体、图片或标志，不增加任何第三方资源请求。

本站小号白字按钮的悬停态采用同套色板中的深蓝 `#0066CC`，以保持文字对比度；`#0077ED` 用于焦点描边。

## 实现范围

`src/apple-theme.css` 作为 `/fresh/` 的最后一层样式，通过 `scripts/build-fresh-pages.mjs` 复制并加内容版本号。包括导航、欢迎页、记录、名片、六边形雷达图、签到、成长图、训练表单、弹窗、账号恢复和心愿大图卡片。大块面板使用白与浅灰，蓝色用于操作与数据强调；错误与警告保留独立语义。

浏览器主题栏和新站 favicon 同步更新，系统字体继续本地渲染。旧站根路径和五套独立配色 Demo 沿用各自的样式。每日心愿邮件中的作图提示词也应沿用新的中性底色及蓝色点缀。

验证沿用已有隔离浏览器流程，覆盖本人登录、上传、记录、心愿、不同账号切换和窄屏布局；线上仅做只读检查。样式发布不需要数据库变更或后端部署。
