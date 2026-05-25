# hybgzs-wheel-spin

HYBGZS 转盘辅助脚本，适合部署到本地 NAS 的 Arcadia 平台作为定时任务运行，用于检查登录态、读取页面剩余次数、尝试调用正常抽奖接口并推送执行结果。

## 功能

- 打开 `https://cdk.hybgzs.com/entertainment/wheel`
- 使用浏览器 Cookie 登录态
- 读取页面显示的今日剩余转盘次数
- 在站点允许时调用正常抽奖接口
- 使用 `wheel-state.json` 记录当天已执行次数，避免重复运行时超额调用
- 遇到站点要求人机验证或拒绝自动化浏览器时停止并推送失败原因

## 人机验证限制

该脚本不会、也无法伪装正常浏览器或绕过站点的人机验证。

如果接口返回类似以下错误：

```text
请完成人机验证
检测到自动化浏览器，请使用正常浏览器访问
```

说明站点要求在正常浏览器里进行人工验证。此时脚本会停止执行，不会写入当天已完成记录，也不会继续尝试绕过验证。

抽奖需要用户在正常浏览器中手动完成验证后操作；本脚本只能在站点允许当前登录态直接调用正常接口时执行。

## 安装

脚本只依赖 Node.js 24+ 和 Arcadia 已安装的 Chromium，不需要安装 npm 依赖。

## 配置

不要把真实 Cookie 提交到 GitHub。请在 Arcadia 环境变量里配置：

```bash
HYBGZS_COOKIE="从浏览器复制的 Cookie 请求头"
HYBGZS_MAX_DAILY_SPINS=3
HYBGZS_CLICK_INTERVAL_MS=9000
HEADLESS=true
CHROME_BIN="/Arcadia 提供的 Chromium 可执行文件路径"
CHROME_NO_SANDBOX=true
CHROME_VERBOSE=false
BARK="你的 Bark key 或完整 Bark URL"
```

Cookie 获取方式：

1. 用浏览器登录并打开 `https://cdk.hybgzs.com/entertainment/wheel`
2. 打开开发者工具的 Network 面板
3. 找任意 `cdk.hybgzs.com` 请求
4. 复制 Request Headers 里的完整 `Cookie` 值

## 运行

```bash
npm start
```

## Arcadia 定时任务

建议每天运行一次。如果一天内运行多次，脚本也会读取 `wheel-state.json`，默认当天最多记录并执行 3 次。

任务命令：

```bash
npm run arcadia
```

脚本会使用 Arcadia 环境变量 `CHROME_BIN` 指向的 Chromium。如果 `CHROME_BIN` 没有设置、文件不存在或不可执行，脚本会直接输出明确错误。

Arcadia 如果以 root 运行 Chromium，需要 `--no-sandbox`。脚本默认会加这个参数；如果你的环境不需要，可以设置：

```bash
CHROME_NO_SANDBOX=false
```

如果 Arcadia 的 9222 端口被占用，可以额外设置：

```bash
CHROME_DEBUG_PORT=9223
```

默认不会输出 Chromium 自身的 DBus、DevTools 等无关日志。如果需要排查浏览器启动问题，可以临时设置：

```bash
CHROME_VERBOSE=true
```

## Bark 推送

脚本会读取 Arcadia 环境变量 `BARK`，并在运行完成、今日无剩余次数或运行失败时推送通知。

`BARK` 支持两种写法：

```bash
BARK="YOUR_KEY"
```

或：

```bash
BARK="https://api.day.app/YOUR_KEY"
```
