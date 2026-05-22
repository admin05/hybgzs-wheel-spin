# hybgzs-wheel-spin

HYBGZS 转盘自动点击脚本，适合部署到本地 NAS 的 Arcadia 平台作为定时任务运行。

## 功能

- 打开 `https://cdk.hybgzs.com/entertainment/wheel`
- 使用浏览器 Cookie 登录态
- 每天最多执行 3 次转盘点击
- 使用 `wheel-state.json` 记录当天已执行次数，避免重复运行时超额点击

## 安装

```bash
npm install
npx playwright install chromium
```

## 配置

不要把真实 Cookie 提交到 GitHub。请在 Arcadia 环境变量里配置：

```bash
HYBGZS_COOKIE="从浏览器复制的 Cookie 请求头"
HYBGZS_MAX_DAILY_SPINS=3
HYBGZS_CLICK_INTERVAL_MS=9000
HEADLESS=true
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

如果 Arcadia 支持单独的安装命令，也可以这样配置：

安装命令：

```bash
npm run setup
```

运行命令：

```bash
npm start
```

如果看到 `Cannot find package 'playwright'`，说明运行前没有安装依赖。请使用上面的 `npm run arcadia`，或者先执行 `npm install`。
