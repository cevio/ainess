---
name: ainess
description: 按包选择、接入和验证 Ainess。用于装配 Cordis 应用、通过 CLI 启停、接入 HTTP、Next.js、Model、TypeORM、Redis、TCP RPC、Registry 服务发现和 Micro，以及复用目录加载能力。
---

# 使用 Ainess

先查应用依赖和项目指引，确认应用用 `ainess.config` 还是直接用 Cordis 装配。下表链接到随技能安装的包级参考。每份参考说明公开入口、宿主依赖、接入示例和资源清理，并链接到包手册。

## 选择包

| 包 | 使用场景 |
| --- | --- |
| [@ainess/framework](references/framework.md) | 装配 Cordis 应用，按组等待插件和入口就绪，管理启动失败和停机。 |
| [@ainess/cli](references/cli.md) | 用 `ainess start` 读取 ESM 配置，处理进程信号和退出。 |
| [@ainess/http](references/http.md) | 装配 Koa 中间件、Controller、HTTP 监听器和请求取消。 |
| [@ainess/http-next](references/http-next.md) | 在同一 HTTP 监听器上提供 Ainess API 和 Next.js。 |
| [@ainess/model](references/model.md) | 定义和注入领域方法，按目录装配，生成类型与运行清单。 |
| [@ainess/typeorm](references/typeorm.md) | 通过 Cordis 提供原生 TypeORM 数据源，复用仓储和事务。 |
| [@ainess/ioredis](references/ioredis.md) | 通过 Cordis 复用 Redis 单节点、Sentinel 或 Cluster 客户端。 |
| [@ainess/loader](references/loader.md) | 为目录插件复用文件扫描、默认导出解码和文件路由。 |
| [@ainess/rpc](references/rpc.md) | 在已知地址上建立可双向调用的 TCP 连接，发送单响应或流式 RPC。 |
| [@ainess/registry-server](references/registry-server.md) | 监听注册中心端口，按连接管理服务登记并提供轮询选址。 |
| [@ainess/registry-client](references/registry-client.md) | 登记、查询和选择服务地址，断线重连时恢复登记。 |
| [@ainess/registry-shared](references/registry-shared.md) | 实现兼容的 Registry RPC 端点或编写协议测试。 |
| [@ainess/micro](references/micro.md) | 按目录装配 RPC 方法，按服务名发起调用并管理连接、选址和熔断。 |

## 组合使用

- 框架先激活 `plugins`，再启动 `entries`。把数据库、Model 和路由放在前一组，把监听器放在后一组。进程入口可用 CLI 启停。 [应用装配](references/framework.md) · [启动命令](references/cli.md)
- Controller 在请求边界校验输入，Model 方法通过自己的 `inject` 取得 TypeORM 等依赖。需要在同一端口服务页面时，再为 `httpListener` 装配 Next.js。 [HTTP、Model 和 TypeORM](references/http.md#运行-httpmodel-和-typeorm) · [Next.js](references/http-next.md)
- 业务入口可从 `*.rpc.js` 或 `*.rpc.mjs` 加载 RPC 方法，再启动监听并向 Registry 登记。需要自行管理业务连接时，选址后用 RPC 直连。需要按服务名调用时，将发现对象注入 Micro。 [注册与直连](references/registry-client.md) · [目录加载与 Micro 调用](references/micro.md#通过-micro-调用已登记服务)
- 独立 Cordis 宿主先停止入口并等待清理，再卸载根 Fiber。使用 framework 时等待 `running.stop()`。连接、定时器等外部资源由创建它们的插件通过 `ctx.effect()` 管理。

## 开发和验证

1. 根据实际安装版本核对公开入口和类型。在 Ainess 源码检出内读根 `llms.txt`、包级 `AGENTS.md` 和手册。 [文档索引](https://github.com/cevio/ainess/blob/main/llms.txt)
2. 消费插件用 `inject` 声明实际使用的服务。按公开契约校验外部输入，并把请求取消信号传给支持取消的下游操作。
3. 从应用入口验证请求、相关失败路径和退出顺序。Ainess 仓库运行 `pnpm test` 及包手册指定的集成验证。
