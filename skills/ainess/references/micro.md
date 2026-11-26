# @ainess/micro

使用 `createMicroClient({ discovery })` 或 Cordis 插件 `micro`。应用可以在声明 `inject: ['registryClient']` 的装配插件中调用 `micro(ctx, { discovery: ctx.registryClient.discovery })`。业务插件声明 `inject: ['micro']`，从 `ctx.micro` 调用 `request(service, method, data?, options?)` 或 `stream(service, method, data?, options?)`。同服务的首次并发调用共享选址，同地址共享拨号和可用连接。Micro 按需建立业务连接，RPC 用字节窗口调度同一连接上的请求。建连失败时使用 `exclude` 再选一次。Micro 通过 `pick(query, options?)` 的 `options.signal` 传递共享选址取消。停止时由 `micro` 等待业务连接关闭，发现对象由应用托管。 [Micro 手册](https://github.com/cevio/ainess/blob/main/packages/micro/README.md)

Micro 默认按服务和地址记录业务熔断。打开熔断后跳过该实例，另选地址时用 `exclude`。冷却后用单个实际业务调用试探，已发出的调用独立结束。应用可用 `circuitBreaker` 配置阈值，或传 `false` 关闭业务熔断。 [Micro 业务熔断](https://github.com/cevio/ainess/blob/main/packages/micro/README.md#业务熔断)

`timeoutMs` 默认 `5000` 毫秒，覆盖一次调用的选址、建连和业务响应，可逐次覆盖。`connectTimeoutMs` 默认 `5000` 毫秒，分别用于共享选址和业务建连，后者还受 RPC 连接期限约束。业务连接空闲时按 `idleTimeoutMs` 回收，默认 `60000` 毫秒。调用 ID 用尽时可建立新连接，旧连接在在途调用结束后退出。调用者取消只结束本次调用，业务请求发出后直接交付响应或错误。 [RPC 连接生命周期](rpc.md)

## 通过 Micro 调用已登记服务

宿主提供 `@ainess/framework`、`@deepseek-ai/cordis`、`@ainess/registry-server`、`@ainess/registry-client`、`@ainess/rpc` 和 `@ainess/micro`。将下例保存为 `micro-registry.mjs`，运行 `node micro-registry.mjs`。

```js
import { defineApp, use } from '@ainess/framework'
import { micro } from '@ainess/micro'
import { registry } from '@ainess/registry-client'
import { RegistryServer } from '@ainess/registry-server'
import { RpcMode, RpcServer } from '@ainess/rpc'

const host = '127.0.0.1'
const directory = await RegistryServer.listen({ host, port: 0 })
const address = directory.address
let provider
let consumer

try {
  provider = await defineApp({
    plugins: { registry: use(registry, { address }) },
    entries: {
      orders: use({
        inject: ['registryClient'],
        /** @param {import('@deepseek-ai/cordis').Context} ctx */
        async apply(ctx) {
          const discovery = ctx.registryClient.discovery
          await ctx.effect(async () => {
            const server = await RpcServer.listen({
              host,
              port: 0,
              methods: [{ name: 'orders.echo', mode: RpcMode.Unary, handle: ({ data }) => data }],
            })
            const registration = { ...server.address, services: ['orders'] }
            try {
              await discovery.register(registration)
            } catch (error) {
              await server.close()
              throw error
            }
            return async () => {
              try {
                await discovery.unregister(registration)
              } finally {
                await server.close()
              }
            }
          })
        },
      }),
    },
  }).start()

  const running = await defineApp({
    plugins: {
      registry: use(registry, { address }),
      micro: use({
        inject: ['registryClient'],
        /** @param {import('@deepseek-ai/cordis').Context} ctx */
        apply(ctx) {
          return micro(ctx, { discovery: ctx.registryClient.discovery })
        },
      }),
    },
  }).start()
  consumer = running

  const replies = await Promise.all(['first', 'second'].map(value =>
    running.ctx.micro.request('orders', 'orders.echo', new TextEncoder().encode(value)),
  ))
  console.log(replies.map(reply => new TextDecoder().decode(reply)))
} finally {
  try {
    await Promise.all([consumer?.stop(), provider?.stop()])
  } finally {
    await directory.close()
  }
}
```

示例输出 `['first', 'second']`。提供方在业务监听就绪后登记地址，停机时注销并关闭监听器。调用方的两个请求共用首次选址和拨号，各自独立发送 RPC。业务连接由 `micro` 管理，控制连接由 `registry` 管理。直接使用 `createMicroClient()` 时等待其 `close()` 回收业务连接。可注入其他实现了 `MicroDiscovery.pick()` 的发现对象，无符合条件的实例时返回 `null`，由应用持有发现对象。 [Registry 登记与恢复](registry-client.md)
