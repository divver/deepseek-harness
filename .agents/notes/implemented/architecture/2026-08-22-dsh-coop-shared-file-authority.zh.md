# Agent Note：dsh-coop —— 基于共享文件的跨 session 协作（2026-08-22）

[English](2026-08-22-dsh-coop-shared-file-authority.md) | 中文

实现 [`.agents/specs/2026-08-21-coop-cross-session-v3.md`](../../../.agents/specs/2026-08-21-coop-cross-session-v3.md)（P0–P3）。该 spec 在实现前经过针对代码库的对抗式评审；本笔记记录 shipped 设计与评审文本的分歧及原因。

## 投递只有一条路径，不是两条

spec 的快慢分层建议"在线对端用 followup，离线对端用信令文件"。实际 shipped：每条通知先追加一条 inbox 信令行，然后投递方在对端 agent 同进程存活时立即按其水位线排水。单一投递机制，没有快慢去重问题；跨进程对端只是稍后排空（`agent/session-start`）。水位线文件（`.consumed/<id>`）只由消费者写入、信令行只由生产者追加，因此评审标记的追加/消费竞态不可能发生。

通知刻意不用 `Agent.inject`：它只入队不唤醒 driver，空闲 worker 永远不会行动。`followup` 会唤醒。

## 锁取代了冲突重试

spec 草案的"rename 原子性作为 planId 锁 + COOP_CONFLICT 重试"误读了 `rename` 语义；评审确认原子发布下读者不会看到中间态，而 LLM 驱动的重试是不确定的循环。所有 registry/plan 的读-改-写周期都运行在 `@deepseek-ai/dsh-atomic-write` 的 `withFileLock` 内，校验也在锁内回调中完成。master 单例检查与它的写入共享 registry 锁，关闭了草案中的 TOCTOU。

## 与评审 spec 的偏差

- **镜像事件不带 `ignorable: true`。** `Session.append()` 无法设置信封标记（只有持久化种子写入者可以）；因此四个 `coop/*` 类型经由 `gen-persistence-catalog` 加入 `KNOWN_SESSION_EVENT_TYPES`。跨构建容忍度依托仓库的 pre-release 锁步姿态，而非逐事件守卫。若下游插件生态需要词汇表外的 coop 事件，`Session.append` 必须先长出 ignorable 选项。
- **`coop_execute_begin` 存在**（不在 spec 工具列表中）：没有它就没有东西迁移 `ready_to_execute → executing`，executing 看门狗会成为死代码、状态机不可观测。
- **存活仅靠心跳**；持久化 header 存在性检查被推迟（README 已知限制），因为崩溃的 session 反正会停止打点。
- **`autoDrive` 配置在加载时抛错**（`COOP_CONFIG_UNSUPPORTED`）直到 P4 执行中断管道存在 —— 接受该键等于承诺包无法兑现的确定性执行。
- **`--any-cwd` 全局表写入**发生在本地提交之前；两者之间崩溃会留下可回收的过期行，而不是撕裂的本地条目。

## 验证形态

Store 行为直接在临时目录上覆盖；service 行为通过真实 agent 主干（`mountAgentLoopTestDependencies`）运行，三个活跃 session 共享一个临时 workspace —— 注册/单例拒绝、直到 `closed` 的完整 happy path、亲和性拒绝、abort 收口、re-notify 幂等，以及两个看门狗超时（回溯文件而非睡眠）。测试政策要求的免密双 session 快照夹具仍欠着；在它随 `examples/coop` 落地之前，service 级套件钉住同样的转录事实（唤醒的 `[coop]` turn 被逐字断言）。

## 同日跟进：一次真实的混版本故障后，镜像改为 opt-in

上面的 ignorable 偏差立刻咬人：在已发布的 `dsh` profile 内运行仓库构建的插件，使每条镜像追加都落入读者构建早于 `coop/*` 词汇表的日志，resume 失败（`session contains event type "coop/registry"`）。rc.5 与 rc.7 的 `Session.append` 都无法附加信封标记，公共 API 内不存在写入侧修复。shipped 解法：`Config.mirrorEvents`（默认关）门控全部十一次镜像追加；共享文件保持权威，模型可见输入由原生记录的 followup turn 覆盖。已被污染的日志可离线修复——给 zstd JSONL 的每行 `coop/*` 加 `"ignorable":true`。正确修复——核心 session 的追加时 ignorable 选项，或发布 coop 让词汇表与读者一起前进——推迟到其中之一落地。

## 跟进：活跃 session 的 inbox 轮询

仅有 session-start 时，一个打开但空闲的 worker 对激活之后写入的信令是盲的 —— 而这正是 TUI 用户注视的 master 通知 worker 时刻。CoopService 现在运行 `ctx.effect` 间隔（`inboxPollMs`，默认 1s），带每 session 重入守卫地排空每个活跃 agent 的 inbox；非参与者每 tick 只付出一次 ENOENT 读取。
