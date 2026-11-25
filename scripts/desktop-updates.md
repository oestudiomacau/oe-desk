# OE DESK 桌面端更新

从 0.1.1 开始，安装版启动时会检查稳定版本。客户也可以在「连接配置 → 软件更新」手动检查，发现新版后可查看说明或下载适用于本机的安装包。

## 发布新版

1. 在 `package.json` 和 `package-lock.json` 同步提升三个数字组成的版本号，例如 `0.1.2`。
2. 用 `scripts/package-windows.ps1` 打包 Windows。Mac 打包使用 `scripts/package-macos.py`，分别构建 `arm64` 和 `x64`，省略私有资料选项。
3. 在 GitHub 仓库 `oestudiomacau/oe-desk` 创建稳定 Release，例如 `v0.1.2`，写入更新说明，添加要支持的公开安装包并发布。沿用构建脚本输出的文件名。

| 系统 | Release 附件示例 |
| --- | --- |
| Windows x64 | `OE-DESK-Setup-0.1.2.exe` |
| macOS Apple 芯片 | `OE-DESK-0.1.2-macOS-arm64.zip` |
| macOS Intel | `OE-DESK-0.1.2-macOS-x64.zip` |

Release 附件对外公开。私有安装包、首次导入密码和模型配置应通过私下交付。

## 客户如何安装

- Windows：下载后退出 OE DESK，运行新版安装程序。
- macOS：解压后退出 OE DESK，将新版应用拖进「应用程序」并替换。
- 客户日常编辑的资料、知识库和模型密钥都保存在各自 Windows 或 macOS 用户的应用数据目录。原机覆盖安装会继续加载该目录。
- 已经装了 0.1.0 的客户需要先覆盖安装 0.1.1，随后可以在应用内看到新版本。
