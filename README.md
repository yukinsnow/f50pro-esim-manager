# F50 Pro · UFI eSIM Manager 🧪

> **实验功能，缺乏充分验证。不是已完成端到端验证的生产级管理器。**
>
> 仅读取路径在一台 **中兴 F50 Pro / MU3356 / Android 15 / B28** 上验证。配置启用、停用、重命名、下载、删除、通知发送 **尚未完成真实写卡验证**。可能导致断网、配置不可用或不可恢复的配置丢失。不要用唯一可联网、不可补发或高价值配置试验。

UFI-TOOLS 的原生文本插件 + 设备端 LPAC 引擎。沿用高级后台的弹窗、输入框、按钮和登录，不嵌入 iframe，不修改 UFI APK。

Root 实验记录与恢复注意事项：[f50pro-b28-root-guide](https://github.com/yukinsnow/f50pro-b28-root-guide)。**本仓库不会帮你 Root 或刷机。**

## 当前实现与验证边界

| 功能 | 当前状态 |
| --- | --- |
| EID、芯片信息、配置列表、通知列表 | **单台设备实机读取通过** |
| UFI 插件保存、已登录 Root API 读卡、未登录访问拒绝 | 实测通过 |
| 启用 / 停用 / 昵称 / 删除 | 已实现调用及确认，**未真实写卡验证** |
| 激活码 / 确认码下载 | 已实现 LPAC 协议路径，**未完成真实下载验证** |
| 通知发送 | 已实现，**未实机发送验证**；不会自动发送或删除通知 |
| QR 图片解析 | 浏览器本地 `BarcodeDetector` 可用时支持，否则粘贴激活码；不上传图片 |
| 手机视觉效果、完整重启恢复 | 尚未完成验收 |

“代码实现了”不等于“你的卡能安全执行”。没有实机测试成功率、兼容全部 9esim 型号或全固件通用的承诺。

## 适配范围

- 已 Root 的 F50 Pro MU3356，测试固件 `F50ProV1.0.0B28` / `20260818.180242`。
- UFI-TOOLS 4.0.0 的 `com.minikano.f50_sms`，可用的 `runShellWithRoot` / 私有 Root socket。
- UFI 自带 `sendat`、`curl`；Magisk BusyBox；局域网可信环境。
- 可插拔 eUICC 放在**物理 SIM2**。原厂后台选值 `sim_slot=12`，当前实现 AT modem 索引固定为 0；不要据 Android 的逻辑槽号判断物理卡槽。
- 未验证其他中兴型号、F50 非 Pro、其他固件和其他 eUICC。不是通用 Android LPA。

## 安装

从 [Releases](https://github.com/yukinsnow/f50pro-esim-manager/releases) 下载标记 **Pre-release / alpha** 的完整包并校验 `SHA256SUMS`。只有 `.txt` 插件不够，设备端引擎也必须安装。

1. 保留原来的 UFI 插件导出和配置；确认有独立的 Wi-Fi / 有线网络与恢复途径。
2. 在已知可用的只读工具中读取你自己卡的 EID，保存于本地，**不要提交到 Issue 或 GitHub**。
3. 解压，使用 ADB 将 `device/` 复制到设备 `/data/local/tmp/f50-esim-package/`。有多台 ADB 设备时务必 `adb -s <你的F50序列号>`。
4. 审查 `install.sh` 后在设备 Root shell 执行。安装器交互读取预期 EID，**不在脚本/仓库内硬编码任何卡身份**：
   ```sh
   sh /data/local/tmp/f50-esim-package/install.sh
   ```
   仅绑定 EID 摘要、安装本模块文件，不启停卡配置、不改网络、不刷分区、不启动公开 HTTP 服务。已有安装会保留旧文件到独立备份目录；存在操作锁时拒绝覆盖。
5. 在 UFI「插件功能」中导出备份，**移除旧版只读插件**，导入 `F50-9esim-Manager.txt` 并提交，刷新页面。保留其他插件。
6. 点击「eSIM管理」，先只读核对 EID / 配置。默认显示写操作尚未经实机充分验证。

详见 [安装与回退](docs/INSTALL.md)、[风险与验证](docs/SAFETY.md)。下载需要设备能访问 SM-DP+ 的互联网；仅能打开后台不证明下载联网可用。

## 操作保护（不能消除实验风险）

- 每个写操作单独确认；删除还需输入 ICCID 尾号，后端禁止删除已启用配置。
- 操作前重新列举目标；每次开通道核对不可变 EID；每条 APDU 核对原厂物理卡槽及当前卡身份。
- 操作互斥，写任务提交一次；异步查询结果，不自动重试写卡，不自动通知发送。
- 中断后返回“不确定”，禁止自动补救 APDU；异常任务需人工核对，**不要删记录重放**。
- 激活码在浏览器加密后提交，LPAC 通过私有文件描述符收参；减少命令日志/argv 明文泄漏。**LAN HTTP 仍不是 HTTPS，加密并不防止页面被篡改。**
- 不上传卡配置，不收集遥测。下载/通知由用户触发后会与所指定运营商服务通信。

## 构建与测试

在 Linux **aarch64**（与目标架构一致）安装 GCC、Python 3、Go、Node.js：

```sh
python3 build_engine.py
CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o build/engine/manager manager.go
python3 build_manager_plugin.py
GO111MODULE=off go test manager.go manager_test.go
node test_native_manager.js
python3 scripts/package.py
```

源码已附带固定版本 LPAC/cJSON，不在构建时获取不固定的最新依赖。C 静态 Linux aarch64 程序在本机 Android 内核上实测运行；未依赖 Android 私有共享库，但这不构成所有设备兼容保证。

## 开源与来源

- 本项目集成层 / UI / LPAC CLI：**AGPL-3.0-or-later**，见 [LICENSE](LICENSE)。
- LPAC：<https://github.com/estkme-group/lpac>，精确提交见 [UPSTREAM.json](UPSTREAM.json)。库/驱动分别遵守各自许可证（libeuicc LGPL 等）；保留 `vendor/` 下全部声明。
- cJSON：MIT，完整版权声明在 `vendor/cjson/LICENSE`。
- UFI-TOOLS：<https://github.com/kanoqwq/UFI-TOOLS>。本包不重分发其 APK 或私有配置。

Release 附源码包；完整对应源码与静态适配构建脚本均可获取。没有任何设备镜像、ADB 密钥、EID、IMSI、真实 ICCID、后台口令或订阅配置。
