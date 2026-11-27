# Changelog

## 2.0.0 — 2026-11-27

自包含重写。

- 删除 WorkBuddy / Qoder / OrcaTerm / MobileClaw / Trae / dsh-cost-meter / dsh-plugin-subscriptions 的全部监控与桥接。
- 新增方格 / 圆环 / 线条 / 渐变四种卡片风格；默认方格。
- 新增三页设置：卡片样式 / 厂商监控 / 其他工具。
- 厂商扩展到 23 家（21 家可直连，Grok / Copilot 暂不支持）；API Key、Cookie、OAuth、AK/SK、自定义 HTTPS 五种接入。
- Host 重写为 v2 路由：snapshot / providers / settings / refresh / credentials / tools / throttle / export / import / diagnostics。
- 凭据继续只进 DSH 凭据库；API Key 类厂商支持复用 DSH 官方 `apiKeyEnv`。
- 迁移 1.x 设置（`balance-settings.json` → `balance-settings-v2.json`），旧限流状态继续使用。
- 金额型无预算时隐藏空进度，放大金额；密度设置真正生效。
- 主题不再提供选项，始终跟随 DSH 软件明暗。
- 千帆限流保留四档试探节奏（频繁 / 正常 / 保守 / 几乎不），默认正常。

## 1.7.0

- 千帆限流试探节奏四档（未单独发布 npm 包）。

## 1.4.0

- 旧版：六家 API Key 厂商、WorkBuddy / Qoder / OrcaTerm / cost-meter / subscriptions 依赖桥接、仪表 / 玻璃 / 磁贴三风格、输入框胶囊。