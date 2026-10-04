# GitHub 代码与国内同域网站

GitHub 继续保存代码并运行构建；微信群分享的是国内服务器的 HTTPS 域名。网页、账号 API、SQLite 数据库和私有照片存储都在同一服务器，不在手机浏览器中连接 `github.io`、`chatgpt.site`、Neon 或 Supabase。GitHub Pages 本身的中国内地网络可达性不受应用控制。

**当前只完成部署准备，尚未接入国内服务器、迁移真实数据或通过国内手机无 VPN 验收。现有分享网址和数据没有切换。**

## 首次需要的资源

由群主管理一台中国内地 Linux x86_64 服务器和一个实际可用的域名，例如腾讯云轻量应用服务器。资源创建、计费选择和实名操作由群主本人完成，六位球友不需要云账号。按云厂商和属地要求完成域名备案，解析到服务器；对外开放 TCP 80、443，并安装 Docker Engine 与 Compose v2。服务器必须允许 HTTPS 证书签发及续期。服务器 IP 的明文 HTTP 不能替代正式 HTTPS 登录入口。

本版本为单实例，数据库和照片在本地 Docker 持久卷中；不要扩为多个副本，也不要把 SQLite 放进网络共享盘。应用端口 3000 仅在 Docker 私有网络可见，不发布到互联网。只有 Caddy 对外接受 HTTPS，并作为唯一可信反向代理。

## GitHub 直接连接服务器

[Deploy complete application to China server](https://github.com/zjwzkongqc/applications-mentioned-by-the-user-appshot/actions/workflows/deploy-china.yml) 会先检查部署配置。配置缺失时只显示缺项名称，跳过构建和服务器发布，不伪装部署成功。配置齐备时，工作流构建完整离线包，通过固定主机公钥的 SSH 上传，验证包和 HTTPS 的实际发布版本后，再原子切换 `current`。修改自动部署相关代码或手动运行此工作流会执行该流程。

群主在仓库 Settings → Secrets and variables → Actions 配置；球友不需要这些设置：

| 类型 | 名称 | 内容 |
| --- | --- | --- |
| Variable | `CHINA_HOST` | 国内服务器公网 IP 或主机名 |
| Variable | `CHINA_SSH_USER` | 管理这台应用服务器的 SSH 用户 |
| Variable | `CHINA_DOMAIN` | 已备案、解析到服务器且可签发证书的域名，不带 HTTPS 和路径 |
| Variable，可选 | `CHINA_SSH_PORT` | SSH 端口，默认 22 |
| Secret | `CHINA_SSH_PRIVATE_KEY` | 此服务器专用的 SSH 部署私钥 |
| Secret | `CHINA_SSH_KNOWN_HOSTS` | 经云控制台核验的服务器公钥记录，格式与 SSH known_hosts 一致 |

不要把私钥或服务器密码发进聊天、群、源码或工作流输入。由管理员把专用公钥放入服务器部署用户的 `authorized_keys`，私钥仅保存在 GitHub Actions Secret。服务器公钥须在腾讯云等服务商的服务器控制台核验，不通过未经核验的网络扫描自动信任。自定义 SSH 端口时 known_hosts 使用 `[主机]:端口` 形式。

服务器使用 Ubuntu 等含 Python 3、`flock`、`curl` 的 Linux，安装 Docker Engine 与 Compose v2；部署用户可以管理 Docker 并写入 `/opt/tennis-deploy`。Docker 管理权限影响整台服务器，应使用此小组专用服务器。GitHub 托管执行器需要能连接所配置的 SSH 端口。

自动部署采用 `/opt/tennis-deploy/releases/` 中的独立候选目录，运维入口为 `/opt/tennis-deploy/current`。首次保持维护状态；升级复制当前维护状态。启动或 HTTPS 版本验收失败时保留 `current` 及原配置，并尝试恢复原容器；错误日志只留在服务器私有目录，恢复失败仍需管理员处理。该流程不删除数据库卷、照片或旧版本。运维时先 `cd /opt/tennis-deploy/current`，再执行下述迁移、维护或备份命令。

## 手动下载部署包

运行 [Build complete China server package](https://github.com/zjwzkongqc/applications-mentioned-by-the-user-appshot/actions/workflows/build-china.yml)，或修改相关源码后推送 `main`。工作流检查和测试代码，再生成 `tennis-china-linux-amd64` artifact。下载其中的 `tennis-china-linux-amd64.tar.gz`，通过云控制台或管理员的安全连接上传至服务器固定目录，例如 `/opt/tennis-deploy`。

包内包含应用和 HTTPS 代理的完整 Docker 镜像、Compose 配置、安装脚本及 SHA-256 清单，不包含用户数据、恢复码、会话凭据、密钥或照片。安装使用 `docker load`，两种镜像的 `pull_policy` 均为 `never`；国内服务器启动时无需拉取 GitHub、Docker Hub 或 npm 内容。镜像安装不是数据库迁移。

```sh
mkdir -p /opt/tennis-deploy
cd /opt/tennis-deploy
tar -xzf /path/to/tennis-china-linux-amd64.tar.gz
bash install.sh your-real-domain.example
```

替换为已经备案、解析且可签发证书的真实域名。安装校验完整性，并默认 `MAINTENANCE_MODE=1`，防止原资料未导入时在一份空数据中建立账号。升级沿用同一目录、Compose 项目名和持久卷，保留已有维护状态。脚本拒绝静默更换原域名。不要使用 `docker compose down --volumes`，它会删除数据。

## 数据迁移与切换

先部署维护版本并测试 `https://你的域名/healthz`，再使用仓库现有完整后台迁移工具，安排旧站停止写入后导出 schema 5 的全部 15 张表和全部头像、训练照片。小组管理员 NDJSON 备份不包含登录凭据，不能代替完整服务端快照。快照必须通过私有连接直接传到目标服务器，不能进入 GitHub 仓库、Actions artifact 或网页下载目录。

使用 `scripts/import-backup.mjs` 作为离线管理任务导入**空的目标数据目录** `/var/lib/tennis/data`。该目录是持久卷中的子目录，导入的暂存、锁和原子重命名均在同一卷内；不要把卷挂载根目录作为导入目标。先停止业务容器，以 `docker compose run --rm --no-deps --entrypoint node app` 运行导入工具，并把私有快照以只读挂载提供给这次管理任务。完整数据导入未验证前不要关闭维护模式。导入器拒绝覆盖已有应用数据，迁移凭证保留经核验的原站和目标站地址。具体导出、私有快照路径和导入参数须在实际目标接入后确定。镜像内包含导入工具，正常业务容器不开放管理导入接口。

新域名无法读取旧域名的浏览器存储。迁移原账号数据后，球友使用本人原恢复码或原邮箱凭据找回；迁移不会要求重新建立六份球员卡。不要承诺旧域名的本地身份自动出现在新域名上。

私有快照文件保持 `0600`，挂载前由管理员安排其所有者为容器用户 UID 1000，使管理任务能读取；不要改为所有人可读。以下是参数模板，实际执行前须核对完整快照、地址和新的随机迁移编号：

```sh
docker compose stop app
docker compose run --rm --no-deps \
  --volume /private/full-backup.json:/run/private/full-backup.json:ro \
  --entrypoint node app scripts/import-backup.mjs \
  --snapshot /run/private/full-backup.json \
  --data-dir /var/lib/tennis/data \
  --migration-id VERIFIED_RANDOM_64_HEX \
  --from-api-origin https://tennis-dazi-club-2026.divine-seal-5110.chatgpt.site \
  --to-api-origin https://your-real-domain.example \
  --page-base-url https://zjwzkongqc.github.io/applications-mentioned-by-the-user-appshot/
```

必须验证：原群主和成员身份、资料、历史月度评分、0 分与待测、签到、训练记录、全部图片、成员权限、邀请期限、公开名片和撤回状态。后台数据保持私有，照片不能通过静态目录绕过成员验证。验收后由管理员将 `.env` 中 `MAINTENANCE_MODE=1` 改为 `0`，运行 `docker compose up -d --wait`。将新域名的群邀请发到微信群；国内版不会提供指向原 GitHub 页面的邀请按钮。

## 备份、更新与验收

数据独立于应用镜像。更新前在维护状态下停止写入，使用私有目录备份整个 `app-data` 持久卷及运维配置，保留数据库 WAL 和全部对象；备份不得上传公开 GitHub。升级不自动删库、删卷或删除旧镜像。回退前先保存新写入的数据，不能用旧快照覆盖新记录。

用六位球友实际所在的国内网络关闭 VPN，在微信与普通手机浏览器测试：打开页面、昵称建号、恢复码找回、加入小组、上传图片、保存资料、换设备和成员权限。当前执行环境与 GitHub Actions 的成功测试不能代替这些实测。即使选用国内云，正式入口仍以实际网络验收为准。
