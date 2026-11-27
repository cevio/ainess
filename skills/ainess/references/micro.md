# @ainess/micro

使用 `createMicroClient({ discovery })` 或 Cordis 插件 `micro`。应用可以在声明 `inject: ['registryClient']` 的装配插件中调用 `micro(ctx, { discovery: ctx.registryClient.discovery })`。业务插件声明 `inject: ['micro']`，从 `ctx.micro` 调用 `request(service, method, data?, options?)` 或 `stream(service, method, data?, options?)`。同服务的首次并发调用共享选址，同地址共享拨号和可用连接。Micro 按需建立业务连接，RPC 用字节窗口调度同一连接上的请求。建连失败时使用 `exclude` 再选一次。Micro 通过 `pick(query, options?)` 的 `options.signal` 传递共享选址取消。停止时由 `micro` 等待业务连接关闭，发现对象由应用托管。 [Micro 手册](https://github.com/cevio/ainess/blob/main/packages/micro/README.md)

Micro 默认按服务和地址记录业务熔断。打开熔断后跳过该实例，另选地址时用 `exclude`。冷却后用单个实际业务调用试探，已发出的调用独立结束。应用可用 `circuitBreaker` 配置阈值，或传 `false` 关闭业务熔断。 [Micro 业务熔断](https://github.com/cevio/ainess/blob/main/packages/micro/README.md#业务熔断)

`timeoutMs` 默认 `5000` 毫秒，覆盖一次调用的选址、建连和业务响应，可逐次覆盖。共享选址用独立的 `resolveTimeoutMs` 总预算，默认取客户端的 `timeoutMs`，覆盖最多两次发现及整个连接等待过程。第一次最多等待当时剩余预算的一半，按毫秒向下取整且至少 1 毫秒。失败或等待到期时把地址加入 `exclude`，使用剩余预算再选一次。若首次拨号在第二次发现或连接等待期间成功，选址可立即使用该连接，并取消备用查询或等待。备用查询返回 `null`、查询拒绝或备用连接失败时，可用剩余预算继续等待已发起的首次拨号。无效发现地址以 `INVALID_ARGUMENT` 报告。每轮最多发起两次发现和两个实际拨号任务。

`connectTimeoutMs` 默认 `5000` 毫秒，约束单次发现和每个实际业务拨号。单次发现超时会通过 `options.signal` 取消查询并丢弃迟到的地址。业务拨号包含 TCP 建连和 RPC 握手，另受 RPC 层 10 秒时限约束，两个时限以先到者为准。握手完成时若拨号时限已到，关闭该连接并按拨号失败处理。选址到期结束当前等待，按地址共用的实际拨号继续遵循自身期限。调用者取消只结束本次调用，业务 RPC 在原有时限内最多发起一次。业务连接空闲时按 `idleTimeoutMs` 回收，默认 `60000` 毫秒。调用 ID 用尽时可建立新连接，旧连接在在途调用结束后退出。 [RPC 连接生命周期](rpc.md)

排查冷路径耗时时，可通过 `onTiming(event)` 接收 `MicroTimingEvent`。事件包含 `service`、`phase`、`elapsedMs` 和 `outcome`，失败时可带原始 `error`。`discovery` 和 `connect` 阶段带从 `1` 起的 `attempt`。每个 `connect` 事件对应一段拨号等待，备用连接失败后继续等待首次拨号时，两段等待均为 `attempt: 2`。`rpc` 阶段带 `method`，计至单响应结果或首次流读取结束。观察器只报告实际执行的阶段，共享选址的阶段可能同时服务多个调用。计时回调的异常或拒绝由 Micro 忽略。RPC 阶段报告失败后，计时回调触发的取消会保留已确定的调用错误。 [计时事件契约](https://github.com/cevio/ainess/blob/main/packages/micro/README.md#调用阶段计时)

流式调用使用 `MicroStreamOptions`，其 `timeoutMs` 默认为客户端的 `timeoutMs`，传 `false` 关闭整次流的时限。`firstResponseTimeoutMs` 从首次读取开始，覆盖选址、建连，直到首个 `DATA` 或正常 `END`。`readIdleTimeoutMs` 在首响应后按每次等待中的 `next()` 计时，消费者暂停读取的时长不计入，上传进度不刷新时限。两个阶段时限均可省略，配置数值时使用 1 至 2,147,483,647 范围内的整数毫秒。Micro 的流式时限到期时报告 `DEADLINE_EXCEEDED`，`cause.phase` 分别为 `total`、`first-response` 或 `read-idle`。调用者主动取消用 `CANCELLED` 报告。 [流式调用时限与示例](https://github.com/cevio/ainess/blob/main/packages/micro/README.md#流式调用时限)

单响应和流式调用都在接受完整的成功响应帧前检查适用的时限，检查先于响应观察器执行。首响应或读取等待在对应帧被接受时结束。`onFailure` 内触发取消时，调用方仍收到已确定的调用错误。若取消时流处于暂停状态，下次读取会抛出该错误。 [RPC 调用选项](rpc.md)

## 通过 Micro 调用已登记服务

宿主提供 `@ainess/framework`、`@deepseek-ai/cordis`、`@ainess/registry-server`、`@ainess/registry-client`、`@ainess/rpc` 和 `@ainess/micro`。在应用目录创建 `controllers/echo.rpc.mjs`。

```js
import { RpcMode } from '@ainess/rpc'

/** @type {import('@ainess/micro/controllers').MicroControllerModule} */
const echo = () => ({
  mode: RpcMode.Unary,
  handle: ({ data }) => data,
})

export default echo
```

将下例保存为同一应用目录中的 `micro-registry.mjs`，运行 `node micro-registry.mjs`。

```js
import assert from 'node:assert/strict'
import { defineApp, use } from '@ainess/framework'
import { micro } from '@ainess/micro'
import { loadMicroControllers } from '@ainess/micro/controllers'
import { registry } from '@ainess/registry-client'
import { RegistryServer } from '@ainess/registry-server'
import { RpcServer } from '@ainess/rpc'

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
          const methods = await loadMicroControllers(ctx, {
            directory: new URL('./controllers/', import.meta.url),
            prefix: 'orders',
          })
          await ctx.effect(async () => {
            const server = await RpcServer.listen({ host, port: 0, methods })
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
  const decoded = replies.map(reply => new TextDecoder().decode(reply))
  assert.deepEqual(decoded, ['first', 'second'])
  console.log(decoded)

  await provider.stop()
  assert.deepEqual(await running.ctx.registryClient.discovery.list({ service: 'orders' }), [])
} finally {
  try {
    await provider?.stop()
  } finally {
    try {
      await consumer?.stop()
    } finally {
      await directory.close()
    }
  }
}
```

示例输出 `['first', 'second']`，并检查提供方停止后 Registry 查询为空。提供方启动时先加载方法，在业务监听就绪后登记地址。调用方的两个请求共用首次选址和拨号，各自发送 RPC。提供方的入口 Fiber 注销服务并关闭监听器，调用方的业务连接由 `micro` 管理，控制连接由 `registry` 管理。直接使用 `createMicroClient()` 时等待其 `close()` 回收业务连接。需要替换 Registry 时，可注入应用持有的 `MicroDiscovery`，它的 `pick()` 在无符合条件的实例时返回 `null`。 [Registry 登记与恢复](registry-client.md)

`loadMicroControllers(ctx, { directory, prefix?, extensions? })` 默认扫描 `*.rpc.js` 和 `*.rpc.mjs`。文件默认导出接收 `ctx` 的同步工厂，返回单个 `{ mode, handle }`。入口把工厂用到的服务放进 `inject`。文件的静态段和可选前缀连成点分方法名，`(group)` 目录省略，`index` 表示所在目录。方法名和批次冲突先于导入检查。生命周期检查从调用加载器时开始。加载期间如果入口失去必需服务，或入口及其上层 Fiber 开始重启或卸载，加载以 `CANCELLED` 拒绝。运行时通过 `RpcServer.listen({ methods })` 一次注册全部方法。 [Controller 契约](https://github.com/cevio/ainess/blob/main/packages/micro/README.md#按目录装配-rpc-方法) · [通用 Loader](loader.md)
