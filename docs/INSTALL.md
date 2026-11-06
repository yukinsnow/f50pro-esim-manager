# 安装、绑定与回退

先阅读根目录 README 和 SAFETY。完整包不是 Magisk flashable ZIP，**不要在Magisk中刷入**。

## 目录

`device/install.sh` 交互安装 `manager`、`manager.sh`、`lpac` 到 `/data/adb/f50-esim/`。调用时使用 Root shell 的前台终端，交互输入你自己先前读取的32位 EID。EID仅变换为二进制BCD并SHA256摘要后保存在设备，不写入Git。

```sh
# 主机侧，将占位符替换为明确的F50 ADB序列号
adb -s <F50_SERIAL> push device /data/local/tmp/f50-esim-package
adb -s <F50_SERIAL> shell
# 以下在设备交互shell内；su路径需与你自己的Root安装一致
/debug_ramdisk/su
sh /data/local/tmp/f50-esim-package/install.sh
/data/adb/f50-esim/manager.sh status
```

只要你没有在UI确认写操作，安装器不会执行卡操作。`status`仅检查环境、公钥和原厂卡槽；列表读取时才通过GetEID核对绑定。

进入高级后台的「插件功能」先导出备份，删除旧的 `F50-9esim-ReadOnly-v1` 条目，再导入新版文本并提交。保留其他插件，刷新后应显示「eSIM管理」。插件文本无Token或口令。

## 升级与回退

安装器发现旧文件时会在`/data/adb/f50-esim/backup-时间-PID/`保留旧二进制/启动器/EID摘要。原生插件应通过UFI插件管理停用或恢复导出的旧条目。

如需要恢复设备文件：确认没有运行任务、没有`read.lock`，逐个核对备份后再手动恢复；本项目不提供会在未知卡状态下自动清锁、杀进程、重放任务的卸载器。仅停用插件即可停止从页面触发新操作，不会重置卡。

本包不更改systemd、Magisk service.d、ADB、Wi-Fi、DNS、iptables、透明代理、SIM槽切换或原厂管理员密码。无需额外常驻Web服务；由UFI现有认证Root API按需启动命令。
