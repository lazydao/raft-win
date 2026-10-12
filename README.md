# Pontoon：Raft 的 Windows 客户端（非官方）

Pontoon 是 [app.raft.build](https://app.raft.build) 的 Windows 桌面客户端。它用 [Tauri 2](https://tauri.app) 写成，窗口里运行的就是 Raft 官方网页，所以功能和网页版保持同步；外面这层壳负责网页做不到的事情。

- **官方桌面协议**：实现了 Raft 公开的 `desktop-contract`（握手、窗口绑定 server、窗口标题、在新窗口打开 server），网页会识别成桌面环境运行。
- **多窗口**：在左上角的服务器菜单里按住 Ctrl（或 Shift）点击某个服务器，或者用鼠标中键点击，它会在新窗口里打开，几个服务器可以同时开着，不用来回切。每个窗口都会收到自己那个服务器的通知；已经开着的服务器再点一次会切到那个窗口。主窗口关闭后缩到托盘，其他窗口关闭就真的关掉。退出时开着的窗口，下次启动会重新打开。所有窗口共用同一个登录账号。
- **系统通知**：有人私信你或 @你，而窗口不在前台时，会弹出 Windows 通知，任务栏图标也会闪烁。
- **托盘常驻**：关闭窗口后程序留在托盘里，通知照常收到。托盘菜单里可以打开窗口（开了多个窗口时会逐个列出）、重新加载、设置开机启动、退出。菜单第一行和托盘图标的悬停提示会显示当前安装的版本号。
- **保持登录**：登录状态保存在本机，下次打开不用重新登录。
- **外部链接**：聊天里的链接用系统默认浏览器打开。Google、GitHub、Apple 登录页留在窗口里完成。
- **断网恢复**：连不上 Raft 时显示重试页面，网络恢复后会自动重连。
- **字体设置**：托盘菜单"字体设置…"里可以分别选界面字体（侧栏、标题、按钮）、对话字体（聊天消息正文）和代码字体，都从本机已安装的字体里选；代码字体默认只列等宽字体，对话字体不单独设置时跟随界面字体。也可以运行 `pontoon.exe --font-settings` 打开这个窗口。
- **其他**：只允许运行一个实例；记住窗口大小和位置；Ctrl + 加号/减号可以缩放。

图标是一只浮在水面上的海獭：一群海獭手拉手漂在水上，英文就叫 a raft of otters。

> "Raft" 是 Botiverse, Inc. 的商标。本项目与 Raft 官方无关，所以没有使用 Raft 的名称和标志作为应用名。

## 安装

运行 `Pontoon_<版本>_x64-setup.exe`，安装到当前用户目录，不需要管理员权限。如果系统里没有 WebView2 运行时（Windows 10 的较旧版本可能没有），安装程序会自动下载。

安装包目前没有代码签名，第一次运行时 SmartScreen 可能会拦截，点"更多信息 → 仍要运行"即可。

## 开发

需要 Node 22+ 和 Rust stable。

```sh
npm install
npm run dev          # 本机开发运行
npm run build        # 在 Windows 上打包 NSIS 安装包
```

### 在 Linux 上交叉编译 Windows 版

```sh
sudo apt install mingw-w64 nsis
rustup target add x86_64-pc-windows-gnu
npm run build:win-cross
# 产物：src-tauri/target/x86_64-pc-windows-gnu/release/bundle/nsis/*.exe
```

图标源文件是 `src-tauri/icons/pontoon-otter.svg`，改完后运行 `npx tauri icon src-tauri/icons/pontoon-otter.svg` 重新生成各尺寸图标。

### 测试

```sh
npm run test:rust                                    # Rust 单元测试
RAFT_SOURCE=../raft-source npm run test:contract     # 用官方校验器检查协议返回
RAFT_SOURCE=../raft-source npm run test:web          # 用官方网页代码做端到端检查
```

后两项测试需要先克隆 [botiverse/raft-source](https://github.com/botiverse/raft-source)，测试会直接用里面的 `desktop-contract` 校验器和网页端的桌面桥接代码，确认 Pontoon 的返回值和注入脚本能被官方网页接受。

## 工作原理

| 文件 | 作用 |
| --- | --- |
| `src-tauri/src/contract.rs` | 官方桌面协议的原生实现：注入运行环境、为每次页面加载签发文档身份，以及握手、绑定 server、设置标题、恢复页这些命令 |
| `src-tauri/src/notify.js` | 注入到网页里，监听 Socket.IO 的 `message:new`；遇到私信或 @你 的消息时请求原生通知 |
| `src-tauri/src/server_window.rs` | 多窗口：协议里可选的 `window.openServer` 扩展打开新的服务器窗口，记录每个窗口所在的服务器，退出时保存、启动时恢复 |
| `src-tauri/src/shell.rs` | 窗口、托盘、导航策略（哪些链接在窗口内打开，哪些交给浏览器）、联网检查、通知 |
| `src-tauri/src/font.rs`、`font.js` | 字体设置：读取系统字体列表（含是否等宽）、保存界面/对话/代码三种字体，并把它们注入网页 |
| `src-tauri/capabilities/` | 权限范围：app.raft.build 只能调用上面这些命令，字体设置命令只有本地的设置窗口能调用 |
| `dist/` | 本地的加载页、断网恢复页和字体设置页 |

为什么用 Tauri 包装网页，而不是做原生界面：Raft 官方的桌面版本身就是 Tauri 壳加载 app.raft.build，网页里已经有专门为桌面壳准备的协议（见 raft-source 的 `packages/desktop-contract` 和 `packages/web/src/desktop*.ts`）。重写原生界面需要重做实时同步和整个客户端，而且会一直落后于网页版。

## 许可

MIT，见 [LICENSE](LICENSE)。
