# coop/ — 跨 session 协作能力族

[English](README.md) | 中文

跨 session 的 Master/Worker 计划协作。单一 **product** 包：workspace 共享文件存储即权威，没有可替换的 provider 契约。

| 包 | 角色 | ctx 键 |
|---|---|---|
| [`coop/`](coop/README.md) | workspace 共享的角色注册表、计划、文档与跨 session 信令投递。 | `ctx.coop` |

状态机、投递协议与配置契约由子 README 拥有。
