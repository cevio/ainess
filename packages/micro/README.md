# @ainess/micro

按服务名调用远程业务 RPC。客户端从应用注入的服务发现接口选址，合并同服务的并发发现请求，按 `host` 和 `port` 复用业务连接，并对持续失败的服务实例熔断。应用可以使用 [Registry 客户端](../registry-client/README.md) 作为发现提供者。

## 快速开始

在工作区消费包中将 `@ainess/micro` 声明为 `workspace:*` 依赖。安装 Cordis 插件时由应用提供 `@deepseek-ai/cordis`。下例通过固定的发现地址发起两个业务调用，可保存为 `micro.mjs`，在依赖 `@ainess/micro` 和 `@ainess/rpc` 的 ESM 应用中运行。

```js
import { createMicroClient } from '@ainess/micro'
import { RpcMode, RpcServer } from '@ainess/rpc'

const provider = await RpcServer.listen({
  host: '127.0.0.1',
  port: 0,
  methods: [{
    name: 'orders.echo',
    mode: RpcMode.Unary,
    handle: ({ data }) => data,
  }],
})
const client = createMicroClient({
  discovery: {
    async pick({ service, exclude }) {
      const address = provider.address
      const excluded = exclude?.some(({ host, port }) => host === address.host && port === address.port)
      return service === 'orders' && !excluded ? address : null
    },
  },
})

try {
  const replies = await Promise.all(['first', 'second'].map(value =>
    client.request('orders', 'orders.echo', new TextEncoder().encode(value)),
  ))
  console.log(replies.map(reply => new TextDecoder().decode(reply)))
} finally {
  await client.close()
  await provider.close()
}
```

应用使用 Registry 时先连接注册中心，再传入已就绪的 `registryClient.discovery`。Cordis 应用在装配插件中声明 `inject: ['registryClient']`，将该发现对象传给 `micro(ctx, options)`。业务插件通过 `inject: ['micro']` 从 `ctx.micro` 获取客户端。应用停止时等待根 Fiber 清理。 [Registry 与 Micro 装配示例](../../skills/ainess/references/assembly.md#通过-micro-调用已登记服务)

## 公开接口

从 `@ainess/micro` 导入 `createMicroClient`、`micro`、`MicroClient`、`MicroOptions`、`MicroCircuitBreakerOptions` 和 `MicroDiscovery`。发现对象实现 `pick({ service, exclude? }, options?)`，输入包含服务名和可选的只读地址数组，返回 `Promise<RpcAddress | null>`。符合条件的地址用 `{ host, port }` 表示。无候选实例时返回 `null`。Micro 传入可选的 `options.signal`，发现端可用它在共享选址超时或客户端关闭时取消查询。Registry 客户端会把信号传给实际的 RPC。

| 接口 | 契约 |
| --- | --- |
| `createMicroClient(options)` | 创建 `MicroClient`。首次业务调用时按需选址和拨号。 |
| `micro(ctx, options)` | Cordis 插件。用 `MicroOptions` 创建客户端并提供 `ctx.micro`，卸载时关闭该客户端。 |
| `client.request(service, method, data?, options?)` | 按服务名选择业务连接，再按方法名发起调用，返回 `Promise<Uint8Array>`。 |
| `client.stream(service, method, data?, options?)` | 返回 `AsyncIterableIterator<Uint8Array>`，从首次读取起选址并发起流式调用。提前退出迭代会释放本次调用。 |
| `client.close()` | 停止该客户端接收调用，结束等待与拨号，关闭业务连接。返回可重复等待的 `Promise<void>`。 |

`data` 为可选的 `Uint8Array`。需要传调用选项而没有初始数据时，将 `data` 传为 `undefined`。调用选项沿用 RPC 的 `RpcCallOptions`，支持 `signal`、`timeoutMs`、上传流 `input` 和业务 RPC 观察器 `onResponse`、`onFailure`。观察器报告业务 RPC 自身的响应和错误。Micro 的总时限触发后，业务 RPC 可向观察器报告本地 `CANCELLED`，调用方通过 Promise 或迭代器收到 `DEADLINE_EXCEEDED`。选址阶段的错误由 Micro 直接返回。业务对象由应用编解码。 [RPC 调用与流式传输](../rpc/README.md#发起调用)

| `MicroOptions` | 默认值 | 用途 |
| --- | --- | --- |
| `discovery` | 必填 | 应用拥有的服务发现对象。 |
| `timeoutMs` | `5000` | 每次业务调用的总时限，单位为毫秒，覆盖按需选址、建连和业务调用。单次调用可以覆盖。 |
| `connectTimeoutMs` | `5000` | 每次共享选址和每次业务建连各自的时限，单位为毫秒。建连包含 TCP 拨号和 RPC 握手。 |
| `idleTimeoutMs` | `60000` | 空闲业务连接的回收时限，单位为毫秒。 |
| `circuitBreaker` | 启用 | 业务熔断配置。可传入 `MicroCircuitBreakerOptions` 覆盖默认值，或传入 `false` 关闭业务熔断。 |

数值选项接受 1 至 2,147,483,647 的整数，无效数值抛出 `RangeError`。服务名须为非空白字符串，发现返回的地址须包含非空白主机名与 1 至 65535 的整数端口。无效的服务名或发现地址以 `INVALID_ARGUMENT` 报告。

## 并发、切换和关闭

- Micro 按需建立业务连接。已有可用连接时直接复用，传输由 RPC 字节窗口和 TCP 背压调度。同一服务的并发调用共用一次选址，同一地址的并发使用共用一次拨号。
- 调用 ID 耗尽后，新调用可使用同一地址的新连接。旧连接在在途调用结束后关闭。
- 选中的地址拨号或握手失败时，选址任务携带 `exclude` 最多再选一次。地址没有其他已建立的业务连接时，建连失败或最后一条连接意外断开会触发 5 秒本地冷却。无可达实例时返回 `UNAVAILABLE`。选址任务失败后，同服务通常等 200 毫秒再查找，若地址冷却更早结束，可在冷却结束后再次查找。业务请求发出后，响应或错误直接交还调用方。
- 单个调用取消或超时只结束自己的等待和调用。同一选址任务中的其他调用仍可继续。主动取消用 `CANCELLED` 报告，超时用 `DEADLINE_EXCEEDED` 报告。单响应调用已收到的对端错误会直接返回给调用方。
- 共享选址到期或客户端关闭时，Micro 会结束等待，并通过 `options.signal` 通知发现端。发现端负责停止其自身的工作。
- 空闲业务连接达到回收时限后关闭。关闭客户端会等待它持有的业务 socket 全部关闭，发现对象和控制连接由应用关闭。服务提供方在业务监听器就绪后调用 Registry 的 `register()`，在停止时注销并关闭监听器。

## 业务熔断

每个客户端独立按 `service`、`host` 和 `port` 记录业务熔断。同一地址承载多个服务时，一个服务实例熔断后，其余服务可继续复用该地址的连接。拨号失败和意外断线仍由地址冷却处理。

| `MicroCircuitBreakerOptions` | 默认值 | 用途 |
| --- | --- | --- |
| `windowMs` | `10000` | 样本滑动窗口，单位为毫秒。使用十个等长时间桶，样本最多比精确窗口提前一个桶过期。 |
| `minimumCalls` | `10` | 判断失败率所需的有效样本数。 |
| `failureRateThreshold` | `50` | 打开熔断的失败率阈值，接受 1 至 100 的整数百分比。 |
| `openMs` | `5000` | 打开熔断后跳过实例的时长，单位为毫秒。 |
| `minTimeoutSampleMs` | `1000` | 普通单响应请求提交到 socket 后，要计入本地超时样本所需的最短等待时长，单位为毫秒。 |

样本达到 `minimumCalls` 且失败率达到阈值时打开熔断。单响应成功、流收到首个响应或正常空流结束记为成功。远端返回的 `UNAVAILABLE` 或 `DEADLINE_EXCEEDED` 记为失败。普通单响应请求超时时，若从提交到 socket 至截止时间之间已等待至少 `minTimeoutSampleMs`，也记为失败。每次流式调用最多记录一个样本。取消、参数错误、服务发现错误和连接失败由各自的调用或连接流程处理。

熔断打开时跳过该实例，优先复用同名服务其他实例的可用连接，需要发现时把该实例地址加入 `exclude`。冷却后，已有连接的恢复实例优先接受一个实际业务调用试探。试探期间其他调用仍走可用实例，在没有备选时按选址结果返回错误。试探成功重新放行，失败重新进入冷却，取消等未计入样本的结果释放试探资格。地址没有可用连接时，在下次需要发现时由 `pick()` 按需选址和拨号。冷却在查询期间结束时，共享选址可在剩余的选址机会内重新考虑该地址。已发出的业务调用各自结束，结果直接交给调用方。

## 验证

从仓库根目录运行 `pnpm --filter @ainess/micro... run build` 和 `node --test 'packages/micro/test/*.test.js'`。运行 `pnpm test` 检查类型并运行整个工作区的测试。
