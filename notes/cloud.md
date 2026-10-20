# GCP 面板托管

范围：云端托管只读研究面板及手动采集；无钱包、交易或自动采集任务。当前实例选择及原因见 DECISIONS DDA-009。

## 位置与状态归属

- 项目：tothemoon-477410；实例：silasvps；区域：us-west1-b。
- 面板：127.0.0.1:8787，独立 dda.service 和 dda 系统用户。
- 程序：/opt/dda/releases/<版本>；/opt/dda/current 指向当前版本。
- 独立运行时：/opt/dda/runtime，固定 Node v24.15.0，不替换其他应用的 Node。
- 唯一数据目录：/var/lib/dda（与 deploy/dda.service 一致）。发布包不包含数据；禁止用本地空目录覆盖。
- 节点配置：/etc/dda/dda.env，root 写、dda 组读，默认免费公共节点。
- 云端暂不安装 Python 模型环境；导出建模数据后使用本地 research/uv.lock 环境。

## 访问

Mac 双击交付目录的「打开云端DDA.command」。脚本使用当前已获授权的 Google Cloud 账号，经 IAP 建立仅监听本机 18787 的转发，打开 http://127.0.0.1:18787。终端需保持打开。断开通道不停止已启动采集；请使用面板停止按钮或等待会话期限。

手动等价操作：

```sh
gcloud compute ssh silasvps --project=tothemoon-477410 --zone=us-west1-b --tunnel-through-iap -- -N -L 127.0.0.1:18787:127.0.0.1:8787 -o ExitOnForwardFailure=yes -o ServerAliveInterval=30
```

不开放公网 8787，不添加防火墙规则，不修改其他网站代理。

## 发布与恢复

在本地构建，避免 1GB 共享虚拟机承担前端编译：

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm exec tsc -p tsconfig.server.json
pnpm test
mkdir -p work/cloud-stage
cp package.json pnpm-lock.yaml work/cloud-stage/
pnpm --dir work/cloud-stage install --prod --frozen-lockfile --ignore-scripts
cp -R build dist deploy work/cloud-stage/
tar -czf work/dda-cloud.tar.gz -C work/cloud-stage package.json pnpm-lock.yaml build dist deploy node_modules
```

传输至所选机器后核对 SHA256，使用独立的受限部署单元执行安装脚本：`sudo systemd-run --unit=dda-deploy-<唯一版本名> --collect --property=MemoryMax=160M --property=CPUWeight=10 --property=Nice=10 /bin/bash <install.sh绝对路径> <归档绝对路径> <唯一版本名>`。随后检查该单元日志和 DDA 健康状态，不以提交命令成功代替部署成功。安装脚本只替换 DDA 自己的服务和 current 链接；失败时恢复先前链接与服务配置，首次安装失败则停止。数据目录在发布之外。生产依赖在本地按锁文件安装、禁用依赖安装脚本，随包上传；云端不执行包管理器。当前使用的可选原生模块已携带 Linux x64 预编译产物，部署后以真实运行验证兼容性。

更新前先停止采集、导出所需快照与原始记录，确认旧会话已结束。保留前一版本。回滚前停止 dda.service，将 current 指向前一发布目录，再启动；不回滚或覆盖 SQLite。未来涉及数据结构变更必须单独做备份与迁移验证。

```sh
sudo systemctl status dda --no-pager
sudo journalctl -u dda -n 50 --no-pager
sudo systemctl restart dda
```

主机重启后只恢复面板，不自动采集。服务限制内存 384MB、V8 堆 256MB、CPU 调度权重 25；这是共享机器的初始预算；实际长期负载及大量会话回放仍需观测。默认归档不自动删除，需观察磁盘；此轮不安装额外监控常驻任务。

## 验收

记录实际部署归档 SHA256、Node 版本、真实短会话、重启前后摘要、原始数据与所有导出格式。短时冒烟只证明部署链路，不替代三十分钟真实覆盖检查或竞争过滤有效性评估。未经独立复核，明确标记待审。
