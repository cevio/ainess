# @ainess/registry-client

用 `RegistryClient.connect(address, options?)` 连接 Registry。Cordis 应用提供 `@deepseek-ai/cordis`，在 `plugins` 中用 `use(registry, { address })` 装配。消费插件声明 `inject: ['registryClient']` 并使用 `ctx.registryClient.discovery`。 [Registry 客户端手册](https://github.com/cevio/ainess/blob/main/packages/registry-client/README.md)

- 业务监听就绪后，用 `register({ services, host, port })` 登记可拨号的地址，成功返回 `{ registered: string[] }`。用 `unregister({ services, host, port })` 注销指定服务。
- `list({ service })` 读取完整地址列表。`pick({ service, exclude? }, { signal }?)` 在单个请求帧内提交服务名和可选的排除地址，按等权轮询选出一个地址，无可选实例时返回 `null`。可选信号只取消该次选址。消费方用单独的 RPC 连接直连选出的地址。
- 首次连接失败由启动方处理。运行期断线后，客户端等待退避结束和旧控制 socket 关闭，再拨号并恢复仍有效的已确认登记。短暂恢复后再次断开会延续退避。恢复期间，查询和新的注册返回 `UNAVAILABLE`。

`options.signal` 可取消首次拨号和握手，`timeoutMs` 默认 `5000` 毫秒，用于控制连接上的发现和登记 RPC。观察 `client.state` 可区分 `ready`、`reconnecting` 和 `closed`。离线注销更新本地恢复清单，重新就绪后仅恢复剩余登记。直接建连的应用等待 `client.close()`，插件装配随 Fiber 清理。

## 通过 Registry 发现服务

宿主提供 `@ainess/registry-server`、`@ainess/registry-client`、`@ainess/rpc`、`@ainess/framework` 和 `@deepseek-ai/cordis`。将下例保存为 `registry.mjs`，用 `node registry.mjs` 验证业务 RPC 直连。

```js
import { defineApp, use } from '@ainess/framework'
import { RegistryClient, registry } from '@ainess/registry-client'
import { registryServer } from '@ainess/registry-server'
import { RpcMode, RpcPeer, RpcServer } from '@ainess/rpc'

const host = '127.0.0.1'
const directory = await defineApp({
  entries: { registryServer: use(registryServer, { host, port: 0 }) },
}).start()

let provider
let publisher
let consumer
let peer
try {
  const address = directory.ctx.registryServer.address
  provider = await RpcServer.listen({
    host,
    port: 0,
    methods: [{
      name: 'orders.health',
      mode: RpcMode.Unary,
      handle: () => new TextEncoder().encode('ready'),
    }],
  })
  publisher = await RegistryClient.connect(address)
  await publisher.discovery.register({ ...provider.address, services: ['orders'] })

  consumer = await defineApp({ plugins: { registry: use(registry, { address }) } }).start()
  const endpoint = await consumer.ctx.registryClient.discovery.pick({ service: 'orders' })
  if (!endpoint) throw new Error('No address registered for orders')

  peer = await RpcPeer.connect(endpoint)
  const reply = await peer.request('orders.health', { timeoutMs: 5_000 })
  console.log(new TextDecoder().decode(reply))
} finally {
  await peer?.close()
  await consumer?.stop()
  await publisher?.close()
  await provider?.close()
  await directory.stop()
}
```

示例输出 `ready`。部署时将 Registry、服务提供方和调用方置于各自的进程，给 Registry 客户端配置可拨号的 Registry 地址，并在提供方登记调用方可访问的业务地址。`pick()` 只选址，业务连接由调用方持有和关闭。重复发起业务请求时可以复用已经建立的 `RpcPeer`。

再次选址时可用 `discovery.pick({ service: 'orders', exclude: [endpoint] })` 跳过已知地址。排除按主机名和端口精确匹配，只作用于这次选址。无可选实例时返回 `null`。

一个业务监听器可通过 `services` 登记多个服务。业务计划下线时，可以先调用 `unregister({ services, host, port })` 撤销相应登记，再关闭监听器。关闭 Registry 客户端也会让服务端清理该控制连接的登记。应用托管的 `registry` 和 `registryServer` 插件均随 `running.stop()` 关闭。 [Registry 服务端](registry-server.md) · [通过 Micro 调用](micro.md)
