# coop/ — cross-session cooperation capability family

English | [中文](README.zh.md)

Cross-session Master/Worker plan cooperation. One **product** package: the workspace-shared file store is the authority, and there is no replaceable provider contract.

| Package | Role | ctx key |
|---|---|---|
| [`coop/`](coop/README.md) | Workspace-shared registry, plans, documents, and signal delivery across sessions. | `ctx.coop` |

The child README owns the state machine, delivery protocol, and configuration contract.
