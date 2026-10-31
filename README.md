# 按住空格语音输入 · Hold-Space Voice Input

给 **DeepSeek Harness Web GUI** 用的输入框语音输入插件：在聊天输入框里**按住空格**说话，松开后自动转写并把文字插入草稿；轻敲空格仍然是普通空格。

识别走**本地 SenseVoice 模型**（离线、不上传音频、中文效果好），通过官方的实验性语音插件 `Voice Input` 提供。

```
输入框聚焦 → 按住空格 ≥ 220ms → 说话 → 松开 → 文字落进草稿
```

> 状态：在 DeepSeek Harness `0.2.1-rc.5`（Windows 桌面版）上验证。接口依赖 `conversation.input.right` 槽位与 `inputActions` 标准属性，其他版本可能不兼容。

---

## 功能

- **按住说话**：按住空格超过 220ms 开始录音，松开后识别并插入光标处；轻敲（< 220ms）插入一个普通空格。
- **本地识别**：SenseVoice（中/英/日/韩/粤），音频不出本机，不需要任何 API Key。
- **不干扰输入**：输入法组合输入（中文候选词）不会被劫持；`Esc` 取消本次录音；切走窗口自动中止。
- **状态可见**：录音时工具栏麦克风变红点脉冲，输入框内浮出“正在聆听…”提示；失败会给出具体原因（权限、无麦克风、模型未准备等）。
- **备用操作**：麦克风按钮支持点按开始/再次点按停止，给不方便长按的场景。
- **安全上限**：单次最长 60 秒，超时自动停止并识别。

## 环境要求

| 依赖 | 说明 |
|---|---|
| DeepSeek Harness（桌面版或 Web） | 需要 Plugins 页 / `plugin_manager` 能力 |
| 官方实验 bundle `@deepseek-ai/dsh-experimental-voice-input-bundle` | 提供本地语音服务；**必须先启用** |
| SenseVoice 模型 | 首次使用下载，约 **239 MB**，之后离线可用 |

## 安装

### 第 1 步：启用官方语音服务（只做一次）

1. 侧边栏打开 **Plugins**，找到 **Voice input**（蓝色波形图标）并启用。
2. 点输入框旁的麦克风 → 弹窗选 **Go to setup** → 在插件详情页点 **Download and prepare**，等待约 239 MB 下载完成（下载期间进度会节流，看起来“卡住”其实在下载，可以看 `~/.dsh/speech-to-text/sensevoice` 目录是否在变大）。
3. 下载完成后，官方麦克风可以正常录音，说明本地语音服务就绪。

### 第 2 步：安装本插件

**方式 A：图形界面（推荐）**

Plugins → 添加插件（`+`）→ 填入下面的 spec：

```
github:glory-salted-fish/holdspace
```

建议锁定版本，避免以后改动影响使用：

```
github:glory-salted-fish/holdspace#v1.1.0
```

安装完成后**刷新页面**（Ctrl+R）。

**方式 B：让 Agent 安装**

对 Agent 说：把这个 bundle 装上，`install_bundle` 的 target 用 `github:glory-salted-fish/holdspace#v1.1.0`。

### 第 3 步：使用

1. 点进聊天输入框（光标在里面）。
2. **按住空格**约 0.3–0.5 秒，看到“正在聆听…”。
3. 说话。
4. 松开空格，稍等 1 秒左右，识别文字会插入光标处。

## 常见问题

**按住空格没反应？**
- 确认焦点在输入框里（contenteditable），且不是普通 `<input>`。
- 确认插件已启用：Plugins 列表里能看到 **Hold-Space Voice Input**。
- 刷新页面后重试。

**提示“本地语音服务未启用”？**
说明官方 `Voice Input` bundle 没启用，或页面加载时它还没挂载。启用后刷新页面。

**提示“语音模型尚未准备”？**
回到第 1 步第 2 小步，完成 Download and prepare。

**长按空格结果变成空格？**
按住时间短于 220ms。阈值写死在 `client.js` 的 `HOLD_MS`，改完刷新即可。

**为什么不用浏览器 Web Speech API？**
Electron 内置窗口没有 Google 语音服务，`SpeechRecognition` 会直接报 `network`。这也正是本项目改用本地模型的原因。

## 工作原理

```
client.js（Web 半）
  ├─ ctx.slots.register('conversation.input.right')       → 麦克风按钮
  ├─ ctx.slots.register('conversation.input.overlay')     → 状态浮层
  ├─ document keydown/keyup (capture)                     → 空格状态机
  ├─ getUserMedia → AudioContext(16kHz) → PCM16 WAV       → 采集
  ├─ remote.speech.transcribe({ audioBase64 })            → SenseVoice 转写
  └─ inputActions.insertText(text, span)                  → 插入草稿（可撤销）
```

- 只监听 `contenteditable` 上的空格，普通输入框不受影响。
- 录音数据以 16 kHz 单声道 PCM16 WAV 编码，这是该 provider 要求的格式。
- 插入使用宿主的 `captureInsertion()` / `insertText(text, span)`，草稿被改动导致版本不一致时会回退到当前光标位置重试。

## 文件结构

| 文件 | 作用 |
|---|---|
| `package.json` | bundle 清单 + `dsh.client` 声明 |
| `cordis.patch.yml` | 向 Host 组合插入插件行 |
| `index.js` | Host 半（无逻辑，占位） |
| `client.js` | 全部交互与识别逻辑 |
| `locale/en.json`、`locale/zh.json` | 插件页标题/描述 |
| `icon.svg` | 插件图标 |

## 卸载

Plugins → Hold-Space Voice Input → **Remove**。模型缓存不会被删除，如需要可手动删除 `~/.dsh/speech-to-text/sensevoice`。

## 开发

```bash
node --check client.js     # 语法检查
node --check index.js
```

修改 `client.js` 后刷新页面即可加载新代码（无需重装）；如果是通过 `github:` 安装的，本地改动不会生效，需要用 `link:` 方式指向本地目录开发。

## License

MIT，见 [LICENSE](LICENSE)。SenseVoice 模型由第三方提供，遵循其自身许可，本项目不附带模型文件。
