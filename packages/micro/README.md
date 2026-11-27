# @ainess/micro

按目录装配业务 RPC 方法，并按服务名调用远程业务 RPC。客户端从应用注入的服务发现接口选址，合并同服务的并发发现请求，按 `host` 和 `port` 复用业务连接，并对持续失败的服务实例熔断。应用可以使用 [Registry 客户端](../registry-client/README.md) 作为发现提供者。

## 快速开始

在工作区消费包中将 `@ainess/micro` 声明为 `workspace:*` 依赖。安装 Cordis 插件时由应用提供 `@deepseek-ai/cordis`。下例通过固定的发现地址发起两个业务调用，可保存为 `micro.mjs`，在依赖 `@ainess/micro` 和 `@ainess/rpc` 的 ESM 应用中运行。

```js
import { createMicroClient } from '@ainess/micro'
import { RpcMode, RpcServer } from '@ainess/rpc'

const provider = await RpcServer.listen({
  host: '127.0.0.1',
  port: 0,
  methods: [
    {
      name: 'orders.echo',
      mode: RpcMode.Unary,
      handle: ({ data }) => data,
    },
    {
      name: 'orders.watch',
      mode: RpcMode.ServerStream,
      async *handle() {
        yield new TextEncoder().encode('updated')
      },
    },
  ],
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

应用使用 Registry 时先连接注册中心，再传入已就绪的 `registryClient.discovery`。Cordis 应用在装配插件中声明 `inject: ['registryClient']`，将该发现对象传给 `micro(ctx, options)`。业务插件通过 `inject: ['micro']` 从 `ctx.micro` 获取客户端。应用停止时等待根 Fiber 清理。 [Registry 与 Micro 装配示例](../../skills/ainess/references/micro.md)

## 公开接口

从 `@ainess/micro` 导入 `createMicroClient`、`micro`、`MicroClient`、`MicroOptions`、`MicroStreamOptions`、`MicroCircuitBreakerOptions`、`MicroDiscovery` 和 `MicroTimingEvent`。发现对象实现 `pick({ service, exclude? }, options?)`，输入包含服务名和可选的只读地址数组，返回 `Promise<RpcAddress | null>`。符合条件的地址用 `{ host, port }` 表示。无候选实例时返回 `null`。Micro 传入可选的 `options.signal`，发现端可用它在查询超时或客户端关闭时取消查询。Registry 客户端会把信号传给实际的 RPC。

| 接口 | 契约 |
| --- | --- |
| `createMicroClient(options)` | 创建 `MicroClient`。首次业务调用时按需选址和拨号。 |
| `micro(ctx, options)` | Cordis 插件。用 `MicroOptions` 创建客户端并提供 `ctx.micro`，卸载时关闭该客户端。 |
| `client.request(service, method, data?, options?)` | 接收 `signal`、`input`、`onResponse`、`onFailure` 和 `timeoutMs`，按服务名选址和调用方法，返回 `Promise<Uint8Array>`。 |
| `client.stream(service, method, data?, options?)` | 接收 `MicroStreamOptions`，返回 `AsyncIterableIterator<Uint8Array>`，从首次读取起选址并发起流式调用。提前退出迭代会释放本次调用。 |
| `client.close()` | 停止该客户端接收调用，结束等待与拨号，关闭业务连接。返回可重复等待的 `Promise<void>`。 |

`data` 为可选的 `Uint8Array`。需要传调用选项而没有初始数据时，将 `data` 传为 `undefined`。两类调用都支持 `signal`、上传流 `input` 和业务 RPC 观察器 `onResponse`、`onFailure`。观察器报告业务 RPC 自身的响应和错误。`onFailure` 触发取消时，调用方仍收到已确定的调用错误。若取消时流处于暂停状态，下次读取会抛出该错误。Micro 的调用时限触发后，业务 RPC 可向观察器报告本地 `CANCELLED`，调用方通过 Promise 或迭代器收到 `DEADLINE_EXCEEDED`。选址阶段的错误由 Micro 直接返回。业务对象由应用编解码。 [RPC 调用与流式传输](../rpc/README.md#发起调用)

| `MicroOptions` | 默认值 | 用途 |
| --- | --- | --- |
| `discovery` | 必填 | 应用拥有的服务发现对象。 |
| `timeoutMs` | `5000` | 每次业务调用的总时限，单位为毫秒，覆盖按需选址、建连和业务调用。单次调用可以覆盖。 |
| `resolveTimeoutMs` | 客户端的 `timeoutMs` | 同一服务的共享选址总预算，单位为毫秒，涵盖最多两次发现及整个连接等待过程。单次调用的时限和取消信号只控制各自等待。 |
| `connectTimeoutMs` | `5000` | 单次发现阶段和每个实际业务拨号各自的时限，单位为毫秒。业务拨号包含 TCP 建连和 RPC 握手，另受 RPC 层 10 秒时限约束，两个时限以先到者为准。 |
| `idleTimeoutMs` | `60000` | 空闲业务连接的回收时限，单位为毫秒。 |
| `circuitBreaker` | 启用 | 业务熔断配置。可传入 `MicroCircuitBreakerOptions` 覆盖默认值，或传入 `false` 关闭业务熔断。 |
| `onTiming` | 省略 | 可选的 `(event: MicroTimingEvent) => void`，用于观察发现、连接等待和业务 RPC 阶段。 |

数值选项接受 1 至 2,147,483,647 的整数，无效数值抛出 `RangeError`。`onTiming` 接受函数或 `undefined`，其他值会抛出 `TypeError`。服务名须为非空白字符串，发现返回的地址须包含非空白主机名与 1 至 65535 的整数端口。无效的服务名或发现地址以 `INVALID_ARGUMENT` 报告。

## 流式调用时限

`MicroStreamOptions` 支持 `signal`、`input`、`onResponse` 和 `onFailure`，并提供下面三个流式时限。数值均为毫秒，接受 1 至 2,147,483,647 的整数。总时限和首响应时限从首次读取开始。流的时限只作用于该次调用，共享选址使用客户端配置的 `resolveTimeoutMs`。

| `MicroStreamOptions` | 默认值 | 计时范围 |
| --- | --- | --- |
| `timeoutMs?: number \| false` | 客户端的 `timeoutMs` | 整次流调用，包括选址、建连与读取响应。传 `false` 关闭总时限计时器。 |
| `firstResponseTimeoutMs?: number` | 省略 | 从首次读取，覆盖选址与建连，直到首个 `DATA` 或正常结束 `END`。 |
| `readIdleTimeoutMs?: number` | 省略 | 首响应之后，每次后续 `next()` 等待结果的时长。调用者暂停读取的时间不计入，上传流进度不刷新这个时限。 |

上述流式时限到期时，迭代器抛出 `RpcError`，其 `code` 为 `DEADLINE_EXCEEDED`，`cause.phase` 为 `total`、`first-response` 或 `read-idle`。调用者通过 `signal` 主动取消时收到 `CANCELLED`。提前结束迭代同样释放该次调用。

RPC 在接受完整的成功响应帧时检查适用的时限，包括单响应的 `END`、流的 `DATA` 与正常结束 `END`。检查先于响应观察器执行，观察器耗时不会改变该帧的结果。首响应或读取等待在对应帧被接受时结束。

在快速开始示例的 `try` 块中加入以下调用，可用同一提供方验证长流配置并输出 `updated`。

```js
const updates = client.stream('orders', 'orders.watch', undefined, {
  timeoutMs: false,
  firstResponseTimeoutMs: 3_000,
  readIdleTimeoutMs: 10_000,
})

for await (const chunk of updates) {
  console.log(new TextDecoder().decode(chunk))
}
```

## 按目录装配 RPC 方法

从 `@ainess/micro/controllers` 导入 `loadMicroControllers`、`MicroControllersOptions`、`MicroControllerModule` 和 `MicroControllerDefinition`。在持有业务监听器的 Cordis 入口中声明工厂需要的 `inject`，再调用 `loadMicroControllers(ctx, options)`。它返回 `Promise<readonly RpcMethod[]>`，应用可以直接传给 `RpcServer.listen({ host, port, methods })`。 [Registry 与 Micro 完整示例](../../skills/ainess/references/micro.md#通过-micro-调用已登记服务)

| `MicroControllersOptions` | 用法 |
| --- | --- |
| `directory` | 必填。传入目录字符串或 `file:` URL。相对字符串以工作目录为基准。用 `new URL('./controllers/', import.meta.url)` 可定位到入口旁的目录。 |
| `prefix` | 可选。点分方法名前缀，如 `orders.v1`。服务发现键由应用独立指定。 |
| `extensions` | 可选。替换默认扩展名列表 `['.js', '.mjs']`。加载文件必须能由宿主的 Node.js 模块加载器导入。 |

默认扫描 `*.rpc.js` 和 `*.rpc.mjs`。默认导出是接收 Cordis `Context` 的同步工厂 `MicroControllerModule`，每个工厂返回一个 `{ mode, handle }` 定义。`MicroControllerDefinition` 沿用四种 `RpcMode` 与处理函数的类型对应关系，处理函数接收原生 RPC 调用上下文和 `signal`。流式输入与输出沿用 `@ainess/rpc` 的字节流。生产部署应将 `*.rpc.ts` 编译到扫描目录。 [RPC 模式与字节流](../rpc/README.md#发起调用)

文件路径决定方法名。静态段以点连接，`(group)` 目录省略，`index` 表示所在目录。以 `prefix` 为 `orders` 为例。

| 相对文件路径 | RPC 方法名 |
| --- | --- |
| `echo.rpc.mjs` | `orders.echo` |
| `(admin)/items/get.rpc.js` | `orders.items.get` |
| `items/index.rpc.js` | `orders.items` |
| `index.rpc.mjs` | `orders`，省略前缀时为 `index` |

方法名区分大小写，受 RPC 的 UTF-8 长度限制。路径参数和通配段会在加载时被拒绝，业务参数通过请求载荷传入。方法名发生变化属于 RPC 接口变更。 [文件路径语法](../loader/README.md#文件路由)

Loader 在入口启动阶段扫描目录并检查本批名称，名称冲突时报告两个文件。通过检查后才导入模块和执行工厂。路径、导入或定义错误会拒绝本批，模块相关错误包含文件路径。生命周期检查从应用调用 `loadMicroControllers()` 时开始。加载期间如果入口失去必需服务，或入口及其上层 Fiber 开始重启或卸载，加载以 `CANCELLED` 拒绝。已经开始的原生模块导入会结束，其余导入与工厂跳过。工厂应使用传入的 `ctx` 获取资源，由拥有资源的插件负责关闭。扫描目录为空时返回空数组。

应用可以合并多个目录的方法与手写定义，RPC 在绑定端口前校验整批注册。监听成功后，入口可以向 Registry 登记服务地址。入口持有监听器和登记，停机时注销并关闭监听器。`RpcServer.close()` 关闭连接并取消在途调用。目录加载本身只生成方法定义。 [RPC 方法注册与关闭](../rpc/README.md#注册与注销方法)

## 并发、切换和关闭

- Micro 按需建立业务连接。已有可用连接时直接复用，传输由 RPC 字节窗口和 TCP 背压调度。同一服务的并发调用共用一次选址，同一地址的并发使用共用一次拨号。
- 调用 ID 耗尽后，新调用可使用同一地址的新连接。旧连接在在途调用结束后关闭。
- 冷路径的发现和连接等待共用 `resolveTimeoutMs`。第一次连接等待最多使用当时剩余预算的一半，按毫秒向下取整且至少 1 毫秒。第一次拨号失败或等待到期时，将该地址放进 `exclude`，用剩余预算最多再选一次。第二次连接等待可使用全部剩余预算。
- 如果首次拨号在第二次发现或连接等待期间成功，选址可立即使用该连接，并取消备用查询或等待。备用查询返回 `null`、查询拒绝或备用连接失败时，可用剩余预算继续等待已发起的首次拨号。发现返回的地址仍须通过校验，无效地址以 `INVALID_ARGUMENT` 报告。每轮最多发现两次、启动两个拨号任务。继续等待时复用原拨号任务，按地址共享的实际拨号受自身期限约束。
- 单次发现或共享选址到期会结束相应的等待，并通过 `options.signal` 通知发现端。Micro 丢弃迟到的地址，发现端负责停止自身的查询。按地址共享的实际拨号可继续，受自身的时限和客户端生命周期约束。握手完成时若拨号时限已到，Micro 关闭该连接并按建连失败处理。地址没有其他已建立的业务连接时，实际建连失败或最后一条连接意外断开会触发 5 秒本地冷却。无可达实例时返回 `UNAVAILABLE`。选址任务失败后，同服务通常等 200 毫秒再查找，若地址冷却更早结束，可在冷却结束后再次查找。
- 业务 RPC 最多发起一次。RPC 提交初始请求前检查适用的总时限和首响应时限，即使请求已因 TCP 背压或窗口额度不足而排队。提交后，成功响应受适用的读取时限约束。已经收到的对端错误可直接返回给调用方。
- 单个调用取消或超时只结束自己的等待和调用。同一选址任务中的其他调用仍可继续。主动取消用 `CANCELLED` 报告，超时用 `DEADLINE_EXCEEDED` 报告。单响应调用已收到的对端错误会直接返回给调用方。
- 空闲业务连接达到回收时限后关闭。关闭客户端会等待它持有的业务 socket 全部关闭，发现对象和控制连接由应用关闭。服务提供方在业务监听器就绪后调用 Registry 的 `register()`，在停止时注销并关闭监听器。

## 调用阶段计时

配置 `onTiming(event)` 后，Micro 在实际执行的阶段结束时报告 `MicroTimingEvent`。每个事件包含服务名 `service`、阶段 `phase`、阶段耗时 `elapsedMs`（毫秒）和 `outcome`（`success` 或 `failure`）。失败时可附带阶段捕获的原始 `error`。

| `phase` | 额外字段 | 计时范围 |
| --- | --- | --- |
| `discovery` | `attempt`，从 `1` 开始 | 一次发现查询。`pick()` 正常返回 `null` 时也记为 `success`。 |
| `connect` | `attempt`，从 `1` 开始 | 每次等待拨号的时间。备用连接失败后继续等待首次拨号时，备用连接等待和恢复等待分别报告 `attempt: 2`。 |
| `rpc` | `method` | 单响应调用直到返回或失败。流式调用直到首次读取完成，包括首个元素、正常空流或失败。 |

直接复用可用连接时只执行 RPC 阶段。同服务的并发调用可共用发现与连接等待，排查单次调用的总耗时应在调用方单独测量。计时回调抛出的异常或返回的拒绝会被忽略。RPC 阶段报告失败后，计时回调触发的取消会保留已确定的调用错误。

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

从仓库根目录运行 `pnpm --filter @ainess/micro... run build` 和 `node --test 'packages/micro/test/*.test.js'`，验证目录加载、取消、真实 TCP 业务调用、Registry 登记与入口清理。运行 `pnpm test` 检查类型并运行整个工作区的测试。
