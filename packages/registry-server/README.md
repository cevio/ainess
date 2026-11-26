# @ainess/registry-server

为 Ainess 运行 TCP 注册与发现服务。监听器维护内存目录，通过 RPC 连接管理登记归属。应用可以直接启动监听器，或用 Cordis 插件托管它。客户端应用可使用 [`@ainess/registry-client`](../registry-client/README.md)。

## 公开接口

从 `@ainess/registry-server` 导入以下入口。

| 入口 | 契约 |
| --- | --- |
| `RegistryServer.listen({ host, port }, { signal }?)` | 等 TCP 监听就绪，返回 `Promise<RegistryServer>`。`port: 0` 由系统分配端口。绑定失败时拒绝。可用 `signal` 取消启动，此时以 `CANCELLED` 拒绝。成功返回后的监听由 `server.close()` 关闭。 |
| `server.address` | 监听期间返回实际绑定的 `{ host, port }`。监听关闭后读取会抛出 `UNAVAILABLE`。 |
| `server.close()` | 关闭监听和全部接入连接，返回 `Promise<void>`。重复调用等待同一次关闭。 |
| `registryServer(ctx, { host, port })` | Cordis 插件。通过 `ctx.effect()` 托管监听器，绑定成功后提供 `ctx.registryServer`。启动期间卸载插件或应用会取消尚未完成的绑定。 |

主入口复用 `@ainess/rpc` 和 `@ainess/registry-shared`。使用插件的应用提供 `@deepseek-ai/cordis`，消费插件声明 `inject: ['registryServer']`。通过 `ctx.plugin(registryServer, address).await()` 等待监听就绪，应用退出时等待根 Fiber 清理。

## 注册与查询

请求和响应使用 UTF-8 JSON。`register` 与 `unregister` 的 `host/port` 是业务服务公布的地址。`services` 为服务 ID 数组，相同 ID 在一次调用中只计算一次。

| RPC | 模式 | 请求 | 响应 |
| --- | --- | --- | --- |
| `registry.discovery.register` | Unary | `{ services: string[], host: string, port: number }` | `{ registered: string[] }` 确认请求中的服务。重复登记得到相同确认。 |
| `registry.discovery.unregister` | Unary | `{ services: string[], host: string, port: number }` | `{ removed: string[] }` 返回当前连接实际撤销的服务。重复撤销时为 `[]`。 |
| `registry.discovery.list` | ServerStream | `{ service: string }` | 每批是 `{ host, port }[]`，分帧交付请求开始时的快照。服务不存在时响应流为空。 |
| `registry.discovery.pick` | Unary | `{ service: string, exclude?: { host: string, port: number }[] }` | 跳过排除地址后等权轮询选出的 `{ host, port }`，无可选实例时为 `null`。 |

注册将服务合并到对应地址。同一连接在同一地址可以登记多个服务，下线时传入需要撤销的服务子集。若两条连接登记了同一服务和地址，查询只返回一个候选，最后一条登记撤销或断线后才移除此候选。断线通过 `RpcPeer.onClose()` 清除该连接的全部登记。目录随监听器存活，客户端重连后按当前需要重新提交登记。 [RPC 连接关闭通知](../rpc/README.md#连接保活和关闭通知)

Registry 接入的控制连接将 TCP KeepAlive 的初始空闲阈值配置为 5 秒。实际探测和静默断线的发现时间取决于平台的 TCP KeepAlive 行为。 [RPC 连接保活](../rpc/README.md#连接保活和关闭通知)

每个服务使用独立的轮询位置。`pick` 从当前位置起按地址插入顺序选择可用实例，下次从选中实例之后继续。排除按原始主机名和端口精确匹配，只作用于当前请求。省略 `exclude` 或传入空数组时直接选取当前位置。带排除条件时最多扫描一轮，若所有候选均被排除，返回 `null` 并保留当前位置。

批量断线清理按该连接的登记数处理。`list` 生成该服务的地址快照，后续登记变化在下一次查询体现。取消响应流会结束本次查询。输入校验失败返回 `INVALID_ARGUMENT`。

## 使用示例

在工作区中构建包，将以下示例保存到依赖这几个包的 ESM 应用中运行。它用 Cordis 启动注册服务，直接发送一次注册和一次选址请求。

```js
import { Context } from '@deepseek-ai/cordis'
import { RpcPeer } from '@ainess/rpc'
import { registryServer } from '@ainess/registry-server'
import {
  decodeRegistryMessage, encodeRegistryMessage, registryKeepAliveInitialDelayMs, registryMethods,
} from '@ainess/registry-shared'

const ctx = new Context()
try {
  await ctx.plugin(registryServer, { host: '127.0.0.1', port: 0 }).await()
  const peer = await RpcPeer.connect(ctx.registryServer.address, {
    keepAliveInitialDelayMs: registryKeepAliveInitialDelayMs,
  })
  try {
    const registration = { services: ['com.example.orders'], host: '127.0.0.1', port: 7000 }
    await peer.request(registryMethods.register, encodeRegistryMessage(registration))
    const selected = await peer.request(registryMethods.pick, encodeRegistryMessage({ service: 'com.example.orders' }))
    console.log(decodeRegistryMessage(selected))
  } finally {
    await peer.close()
  }
} finally {
  await ctx.fiber.dispose()
}
```

## 验证

在仓库根目录运行 `pnpm --filter @ainess/registry-server... run build` 和 `node --test packages/registry-server/test/registry-server.test.js`。运行 `pnpm test` 进一步检查测试类型和工作区集成。
