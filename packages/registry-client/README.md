# @ainess/registry-client

用一条 TCP RPC 控制连接向 Registry 登记服务实例、列出服务地址或选择一个地址。应用可以从返回的地址直接连接业务 RPC。Registry 断开后，客户端重连并恢复服务端已确认的登记。

在工作区消费包中将 `@ainess/registry-client` 声明为 `workspace:*` 依赖。客户端使用 [@ainess/rpc](../rpc/README.md) 和 [Registry 协议](../registry-shared/README.md)，运行时连接 [@ainess/registry-server](../registry-server/README.md)。Cordis 插件使用宿主的 `@deepseek-ai/cordis`。

## 快速开始

先启动 Registry，并将下例中的地址改为实际 Registry 的监听地址。提供方应先绑定业务端口，再登记消费者能够拨号的地址。

```js
import { RegistryClient } from '@ainess/registry-client'

const client = await RegistryClient.connect({ host: '127.0.0.1', port: 9900 })
const endpoint = { host: '10.0.0.21', port: 7001 }

try {
  await client.discovery.register({ ...endpoint, services: ['orders', 'refunds'] })
  console.log(await client.discovery.list({ service: 'orders' }))
  console.log(await client.discovery.pick({ service: 'orders' }))
  console.log(await client.discovery.pick({ service: 'orders', exclude: [endpoint] }))
  await client.discovery.unregister({ ...endpoint, services: ['refunds'] })
} finally {
  await client.close()
}
```

## 公开接口

从 `@ainess/registry-client` 导入 `RegistryClient`、`registry` 以及相关类型。地址采用 `RpcAddress` 的 `{ host, port }`。登记或部分注销采用 `RegistrationRequest` 的 `{ host, port, services }`。`list` 接受 `ServiceQuery` 的 `{ service }`，`pick` 接受 `PickQuery` 的 `{ service, exclude? }`。

| 接口 | 契约 |
| --- | --- |
| `RegistryClient.connect(address, options?)` | 建连并等待 RPC 握手，返回 `Promise<RegistryClient>`。首次失败直接拒绝。可用 `options.signal` 取消首次建连。 |
| `client.discovery.register(request)` | 将一批可装入单个 RPC 请求帧的服务提交给 Registry，确认后返回 `Promise<RegisterResponse>`。其中 `registered` 是本次确认的服务 ID。客户端按地址合并并保存已确认的登记。 |
| `client.discovery.unregister(request)` | 从本地恢复清单撤销指定服务。在线时按帧大小分批撤销，等待服务端确认，再完成 `Promise<void>`。离线时完成本地撤销。 |
| `client.discovery.list(query)` | 收齐一次有限响应流，返回 `Promise<RpcAddress[]>`。Registry 无匹配项时返回空数组，流失败时拒绝。 |
| `client.discovery.pick(query, options?)` | 返回 `Promise<RpcAddress \| null>`。Registry 按服务等权轮询，跳过本次 `exclude` 中的地址，无可选实例时返回 `null`。可通过 `options.signal` 取消该次 RPC，此时以 `CANCELLED` 拒绝，控制连接可继续使用。 |
| `client.state` | 只读的 `RegistryClientState`，值为 `ready`、`reconnecting` 或 `closed`。 |
| `client.close()` | 取消拨号和退避等待，等待控制 socket 关闭和客户端清理，返回同一个 `Promise<void>`。Registry 在断线时清理连接的登记。 |
| `registry(ctx, options)` | Cordis 插件，选项为 `RegistryOptions` 的 `{ address, timeoutMs? }`。握手完成后提供 `ctx.registryClient`。 |

`RegistryClientOptions.timeoutMs` 设置单次 Registry RPC 的时限，包括重连后的每批登记，默认 `5000` 毫秒。接受 `1` 至 `2147483647` 的整数。首次建连时限由 RPC 握手约定决定。普通请求包含非法字段时抛出 `TypeError`，RPC 调用失败以 `RpcError` 报告。

`exclude` 接受 `readonly RpcAddress[]`。按原始主机名和端口精确匹配，排除只作用于这次选址。省略或传入空数组时，从服务的全部已登记实例中轮询。服务 ID 和排除地址编码成 UTF-8 JSON 后共享 65,512 字节的请求载荷上限。超出限额时返回 `INVALID_ARGUMENT`。

## 连接、恢复和关闭

- 一个客户端拥有一个 Registry 控制连接，首次建连和重连都将 TCP KeepAlive 的初始空闲阈值配置为 5 秒。实际探测和断线判定受平台的 TCP KeepAlive 行为影响。同一客户端两次登记同一项时，本地恢复清单只保留该项，一次注销即可撤销。写入按调用顺序处理，读取可以并发。 [RPC 连接保活](../rpc/README.md#连接保活和关闭通知)
- 控制连接的调用 ID 用尽时，客户端等待在途调用结束，再关闭连接并恢复登记。排空期间新发出的 RPC 返回 `RESOURCE_EXHAUSTED`。已有的本地注销仍从恢复清单移除，旧连接上的登记会随关闭清理。 [RPC 调用 ID](../rpc/README.md#接口)
- 当前端点断开后，客户端以带抖动的指数退避重连。退避与旧 socket 的关闭并行等待，两者完成后开始拨号。初始退避为 100 至 200 毫秒，每次退避最多 5 秒。连接恢复后若在 5 秒内再次断开，客户端沿用退避进度。持续就绪至少 5 秒后再断开，从初始间隔重试。
- 客户端按地址分批恢复仍在本地清单中的登记，全部确认后切回 `ready`。恢复期间撤销清单中的登记会关闭正在恢复的连接并取消在途恢复请求。客户端用最新清单重试。恢复中的登记、列出和选择报 `UNAVAILABLE`。
- 新登记在 RPC 确认后纳入恢复清单。写入超时等导致结果不明确时，客户端关闭该连接并用已确认且仍保留的登记重建状态。调用方可以在连接就绪后重新提交未确认的新增登记。
- Cordis 应用通过 `ctx.plugin(registry, options)` 挂载插件，等待 Fiber 的 `await()` 完成。消费插件声明 `inject: ['registryClient']`，通过 `ctx.registryClient.discovery` 使用。插件通过 `ctx.effect()` 关闭连接和重连任务。应用退出时等待根 Fiber 的 `dispose()`。

## 验证

从仓库根目录运行 `pnpm test`。包测试通过真实 TCP 验证协议调用、初次连接与重连时两端的 KeepAlive 设置、正常停机、断线重连、登记恢复、部分注销、写入超时和初次连接取消。
