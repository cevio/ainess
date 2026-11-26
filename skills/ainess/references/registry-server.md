# @ainess/registry-server

独立运行服务注册中心。用 `RegistryServer.listen({ host, port }, { signal })` 打开监听，第二个参数用于可选的启动取消。读取 `server.address` 并在退出时等待 `server.close()`。Cordis 应用在 `entries` 传入 `use(registryServer, { host, port })`，启动完成后从 `running.ctx.registryServer.address` 获取监听地址，应用停止时由插件关闭。登记归提交它的连接，断线时清理该连接的登记。多个连接可以登记同一个服务地址，查询按地址去重。 [Registry 服务端手册](https://github.com/cevio/ainess/blob/main/packages/registry-server/README.md)

## 在 Cordis 中启动注册中心

应用提供 `@ainess/registry-server`、`@deepseek-ai/cordis` 和示例用到的 `@ainess/registry-client`。保存为 `registry-server.mjs` 并运行。`port: 0` 由操作系统分配空闲端口，查询一个未登记的服务会输出 `[]`。

```js
import { Context } from '@deepseek-ai/cordis'
import { RegistryClient } from '@ainess/registry-client'
import { registryServer } from '@ainess/registry-server'

const ctx = new Context()
try {
  await ctx.plugin(registryServer, { host: '127.0.0.1', port: 0 }).await()
  const client = await RegistryClient.connect(ctx.registryServer.address)
  try {
    console.log(await client.discovery.list({ service: 'orders' }))
  } finally {
    await client.close()
  }
} finally {
  await ctx.fiber.dispose()
}
```

服务端的 `list` 分批返回当前查询开始时的快照。`pick` 按服务独立轮询，跳过请求排除的地址，全部被排除时返回 `null` 并保留轮询位置。关闭监听器会结束接入的控制连接及其登记。客户端负责登记恢复，RPC 方法和消息形状由共享包定义。 [业务服务登记与选址](registry-client.md) · [Registry 协议](registry-shared.md)
