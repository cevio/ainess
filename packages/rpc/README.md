# @ainess/rpc

用 TCP 长连接执行字节级 RPC。同一条连接的两个端点都可以发起和处理调用。每个调用可以发送单请求或输入流，接收单响应或输出流。运行时仅使用 Node.js 原生 API。应用负责提供服务地址、定义方法名和编解码业务数据。

在工作区消费包中将 `@ainess/rpc` 声明为 `workspace:*` 依赖。从 `@ainess/rpc` 导入 `RpcPeer`、`RpcServer`、模式枚举和类型。`RpcClient` 是 `RpcPeer` 的别名。

## 快速开始

下面的 ESM 示例只建立一条 TCP 连接。拨号端调用 `demo.echo`，接入端在处理它时用同一连接反向调用 `demo.ready`，随后逐块回显上传数据。保存为消费包内的 `echo.mjs`，构建工作区后运行 `node echo.mjs`。

```js
import { RpcMode, RpcPeer, RpcServer } from '@ainess/rpc'

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const server = await RpcServer.listen({ host: '127.0.0.1', port: 0 })

try {
  const peer = await RpcPeer.connect(server.address)
  try {
    const removeReady = peer.register({
      name: 'demo.ready',
      mode: RpcMode.Unary,
      handle: () => encoder.encode('ready'),
    })
    const unregister = server.register({
      name: 'demo.echo',
      mode: RpcMode.Bidi,
      async *handle({ peer, input, signal }) {
        yield await peer.request('demo.ready', { signal, timeoutMs: 5_000 })
        for await (const chunk of input) yield chunk
      },
    })
    for await (const chunk of peer.stream('demo.echo', {
      input: async function* (signal) {
        signal.throwIfAborted()
        yield encoder.encode('hello')
        signal.throwIfAborted()
        yield encoder.encode('world')
      },
      timeoutMs: 5_000,
    })) {
      console.log(decoder.decode(chunk))
    }
    await unregister()
    await removeReady()
  } finally {
    await peer.close()
  }
} finally {
  await server.close()
}
```

依次输出 `ready`、`hello`、`world`。可以把上传源换成 `signal => createReadStream(path, { signal, highWaterMark: 64 * 1024 })`，按块读取文件并在上传被停止时关闭读取流。 [Node.js 文件读取流](https://nodejs.org/api/fs.html#fscreatereadstreampath-options)

## 接口

| 入口 | 行为 |
| --- | --- |
| `RpcServer.listen({ host, port, methods?, onPeer?, keepAliveInitialDelayMs?, signal? })` | 开始监听，返回 `Promise<RpcServer>`。可用端口 `0` 分配空闲端口，再从 `server.address` 读取地址。可通过 `methods` 在监听前预注册共享方法。`keepAliveInitialDelayMs` 应用于每条接入连接。`signal` 可取消启动并以 `CANCELLED` 拒绝。成功返回后的监听由 `server.close()` 关闭。 |
| `onPeer(peer)` | 监听端在协议握手完成后同步调用，早于该连接首个入站调用的分派。首个调用所需的方法应在回调的同步部分注册。回调异常会关闭该连接。 |
| `server.register({ name, mode, handle })` | 注册监听器共享方法，已有接入连接的后续调用也能使用。返回注销函数 `() => Promise<void>`。 |
| `RpcPeer.connect({ host, port }, { signal?, methods?, keepAliveInitialDelayMs? }?)` | 先拨通 TCP，再在同一个 socket 上初始化 RPC 并完成 `HELLO` 握手，返回 `Promise<RpcPeer>`。两阶段共用从拨号开始计的 10 秒时限，到期关闭 socket 并以 `UNAVAILABLE` 拒绝。可用 `signal` 取消任一阶段。`methods` 在发送 `HELLO` 前注册，接入端可在 `onPeer` 中立即调用。`keepAliveInitialDelayMs` 配置拨号端的首次探测。 |
| `peer.remainingOutgoingCallIds` | 只读 `number`，表示此端点尚可分配的调用 ID 数量。ID 耗尽或连接开始关闭后为 `0`。 |
| `rpcPayloadLimit(method?)` | 返回单帧可用的载荷字节数。传方法名时返回扣除 UTF-8 方法名及长度字段后的初始请求上限。省略方法名时返回单个流元素或单响应的上限。方法名无效时抛出 `INVALID_ARGUMENT`。 |
| `peer.register({ name, mode, handle })` | 注册该端点的连接专属方法，返回注销函数 `() => Promise<void>`。 |
| `peer.request(name, options?)` 或 `peer.request(name, data, options?)` | 按方法名立即发起调用，返回 `Promise<Uint8Array>`。 |
| `peer.stream(name, options?)` 或 `peer.stream(name, data, options?)` | 返回一次性 `AsyncIterableIterator<Uint8Array>`，在首次读取时按方法名发起调用。 |
| `peer.onClose(listener)` | 订阅该端点的关闭通知，监听器接收 `RpcCloseInfo`。返回取消订阅函数 `() => void`。 |
| `peer.close()`、`server.close()` | 返回 `Promise<void>`。端点关闭当前连接，服务端关闭监听和接入连接，相关在途调用一并终止。可重复调用。 |

### 注册与注销方法

每个方法包含 `{ name, mode, handle }`。方法名区分大小写，支持中文等 Unicode 字符，UTF-8 编码必须为 1 至 255 字节。空字符串、超过字节上限、包含非法 Unicode 或与同一注册表中的方法重名时，注册抛出 `INVALID_ARGUMENT`。预注册列表遵循相同规则。端点或监听器开始关闭后，其 `register()` 抛出 `UNAVAILABLE`。

接入端收到调用时，优先查找当前连接的专属方法，再查找监听器共享方法。拨号端通过自己的连接注册表提供方法。调用注销函数会立即移除该注册，并等待它已接收的调用退出，包括处理函数和响应流的清理。可重复调用同一个注销函数，端点或监听器关闭后也可用它等待清理。旧方法等待清理时可以注册同名新方法，已接收的调用继续使用原来的处理函数。

查找不到方法时，调用方收到 `RpcError`，其 `code` 为 `NOT_FOUND`。调用模式与注册的方法不匹配时，`code` 为 `INVALID_ARGUMENT`。这两类错误只结束当前调用，连接可以继续复用。

处理函数接收 `{ data, signal, peer }`，流式输入时另有 `input`。用上下文的 `peer` 发起反向调用会复用当前 TCP 连接。单响应处理函数返回 `Uint8Array`，流式响应处理函数返回 `AsyncIterable<Uint8Array>`。两种返回值都可以通过 Promise 提供。

### 发起调用

| `RpcMode` | 值 | 任一端的调用方式 |
| --- | --- | --- |
| `Unary` | `0b00` | `request('demo.greet')` |
| `ClientStream` | `0b01` | `request('files.upload', { input })` |
| `ServerStream` | `0b10` | `stream('demo.list')` |
| `Bidi` | `0b11` | `stream('demo.chat', { input })` |

`data` 是调用开始时送达的请求数据或元数据。省略 `data` 或显式传入 `undefined` 时，服务端收到长度为 0 的 `Uint8Array`。需要同时传数据和选项时，可用 `request(name, data, { timeoutMs: 5_000 })`。所有业务数据和流元素都是 `Uint8Array`，也可使用在其他 JavaScript 上下文中创建的实例。直接把 `ArrayBuffer` 或 `SharedArrayBuffer` 当作请求数据，或传入因内存转移或缩容而失效的视图时，该调用返回 `INVALID_ARGUMENT`。

传输以视图的实际偏移和长度为准，包可以直接使用调用方交付的缓冲区。传入、返回或 `yield` 后按只读处理，已收到的字节可以在后续读取后继续使用。需要转移收到数据的底层内存时，先复制到新的 `Uint8Array`。

`options.input` 接收上传方向独立的 `AbortSignal`，返回按需读取的异步可迭代对象。自然耗尽只关闭上传方向。处理方调用 `input.stop()` 或提前结束输入迭代时，RPC 会终止上传并中止上传源的信号，响应可以继续。文件或其他等待中的读操作应监听该信号。

接收输入流或响应流时，每个迭代器最多允许一个等待中的 `next()`。使用 `for await...of` 会逐项读取。

`options.signal` 中止整个调用，以 `CANCELLED` 报告并在错误的 `cause` 保留信号原因。`options.timeoutMs` 接受 1 至 2,147,483,647 的整数，省略时不限时。流式调用的时限从首次读取时开始。调用方提前结束响应迭代时也会取消整个调用。网络断开或调用失败时，单响应 Promise 拒绝，流在读到失败时抛出错误。调用方可从 `RpcError.code` 获取错误代码。处理函数可抛出 `new RpcError(code, message?, options?)` 指定错误码。应用自行决定是否重试，超时或断线时对端可能已经执行了方法。

`options.openDeadline` 供已经持有调用时限的上层传入 `{ at, cause? }`。`at` 是本进程 `performance.now()` 时间基准上的绝对毫秒值，须为非负有限数。RPC 在提交 `OPEN` 到 socket 前检查该值和 `timeoutMs` 对应的时限，包括发送队列因背压或窗口额度恢复而继续写入时。先到的时限使未提交的 `OPEN` 被丢弃并返回本端 `DEADLINE_EXCEEDED`。若由 `openDeadline` 触发，错误会保留其中的 `cause`。等待队列期间的主动取消仍用 `signal` 或 `timeoutMs`。

`options.beforeResponse` 在每个有效的 `DATA` 或成功 `END` 交给调用方前同步执行，适合上层检查响应时限。同步抛出 `RpcError` 会以本端失败结束该调用，其他异常以 `INTERNAL` 报告并保留 `cause`。返回值会被忽略。对端的 `ERROR` 帧沿用正常错误处理路径。

`options.onResponse` 在处理首个流响应数据或成功结束帧时同步调用一次。成功结束帧也包括单响应和正常空流。观察器按接收帧的顺序执行。

`options.onFailure` 可为已经开始的调用观察一次失败。参数 `RpcCallFailure` 包含调用错误 `error`、来源 `source` 和可选的发送及响应状态。来源 `remote` 表示收到对端的错误帧，`transport` 表示连接终止或发送失败，`local` 表示本端取消、超时、输入失败或同步响应检查拒绝。若 `OPEN` 已提交到本端 socket，`sentAt` 为提交时的本端 `performance.now()` 值，单位为毫秒。如果流在失败前接受过响应数据，`responseStarted` 为 `true`。

终态观察器在本调用的响应或错误就绪后同步执行，随后取消仍在运行的本地上传。观察器的异常或拒绝由 RPC 忽略。调用开始前的参数校验和已取消状态，以及业务结果和调用错误，都通过返回的 Promise 或迭代器报告。

包还导出 `Bytes`、`ByteStream`、`RpcAddress`、`RpcPeerOptions`、`RpcServerOptions`、`RpcCallOptions`、`RpcCallFailure`、`RpcCall`、`RpcInput`、`RpcStreamingCall`、`RpcMethod`、`RpcErrorCode`、`RpcCloseInfo` 和 `RpcCloseReason` 类型。

同一个连接可以并发承载两个方向的调用。应用在卸载时关闭自己创建的拨号端点和监听器。需要关闭服务端已接入的某一条连接时，可以调用该连接的 `peer.close()`。如果在 Cordis 中创建连接，由创建资源的插件注册清理，并等待监听或握手完成后再提供给消费者。

同一连接上的在途调用数可随负载增长。字节窗口和 TCP 背压控制数据发送。排队的请求、正在执行的调用和未读完的流都会占用内存。调用方可用截止时间或取消信号结束等待。

调用开始并分配 ID 时消耗一个 ID，每个 ID 在当前连接上只分配一次。连接池可通过 `remainingOutgoingCallIds` 决定何时排空和替换连接。调用 ID 耗尽后，通过该连接发起新调用会收到 `RESOURCE_EXHAUSTED`。

### 连接保活和关闭通知

拨号端和接入端都启用 TCP KeepAlive，默认将首次探测的空闲阈值设为 30 秒。`keepAliveInitialDelayMs` 可设为 1,000 至 32,767,000 毫秒的整数。Node.js 将其向下取整到秒，再按平台限制应用。例如，Node.js 所用的 libuv 在 SmartOS 上把低于 10 秒的值上调到 10 秒。无效值使启动以 `INVALID_ARGUMENT` 拒绝。实际发现断线的时间取决于 TCP 的探测过程。调用方可通过 `timeoutMs` 限制等待 RPC 响应的时间，应用负责决定是否重连。 [Node.js TCP KeepAlive](https://nodejs.org/api/net.html#socketsetkeepalive) · [libuv 平台设置](https://github.com/nodejs/node/blob/v24.22.1/deps/uv/src/unix/tcp.c#L444-L480) · [Linux TCP 参数上限](https://github.com/torvalds/linux/blob/master/include/net/tcp.h)

`peer.onClose(listener)` 在端点开始关闭并终止在途调用后异步通知，每个订阅最多收到一次。关闭后订阅也会异步收到该端点的最终通知。回调执行前可以取消订阅。监听器抛出异常或返回拒绝的 Promise 时，其他监听器仍会收到通知。

`RpcCloseInfo` 提供只读的 `reason` 和 `error` 两个字段。 `error` 是用于结束在途调用的 `RpcError`。 `reason` 以当前端点的视角说明关闭原因。

| `RpcCloseReason` | 含义 |
| --- | --- |
| `'local'` | 本端主动关闭，包括监听器关闭其接入端点。 |
| `'remote'` | 收到对端正常结束 TCP 连接的通知。 |
| `'error'` | TCP 传输、RPC 协议或端点运行出现错误。 |

下面的示例在接入端跟踪活跃连接，在拨号端记录关闭原因。

```js
import { RpcPeer, RpcServer } from '@ainess/rpc'

const peers = new Set()
const server = await RpcServer.listen({
  host: '127.0.0.1',
  port: 0,
  onPeer(peer) {
    peers.add(peer)
    peer.onClose(() => { peers.delete(peer) })
  },
})

try {
  const peer = await RpcPeer.connect(server.address)
  peer.onClose(({ reason, error }) => {
    console.log('连接关闭', reason, error.code)
  })
  await peer.close()
} finally {
  await server.close()
}
```

## 传输协议

一条 TCP 连接建立后双方交换 `HELLO`，公布单帧大小和接收窗口。调用 ID `0` 用于连接级帧。拨号端分配递增的奇数 ID，接入端独立分配递增的非零偶数 ID。ID 达到上限后可用新连接继续发起调用。所有整数采用大端序。每帧先写 12 字节头，再写消息体。

| 帧头字段 | 长度 |
| --- | --- |
| 消息体长度 | `u32` |
| 调用 ID | `u32` |
| 帧类型 | `u8` |
| 标志 | `u8` |
| 保留字段 | `u16`，值为 0 |

帧的消息体最多 64 KiB。`OPEN` 的消息体先写 `u8` 方法名的 UTF-8 字节数，再写对应字节的名称和调用的 `data`。`data` 上限是 65,535 字节减去方法名的 UTF-8 字节数。收到无效 UTF-8 名称时拒绝该帧。较大的数据可通过流分块传输。

| 帧 | 值 | 用途 |
| --- | --- | --- |
| `HELLO` | 1 | 交换单帧大小和接收窗口 |
| `OPEN` | 2 | 以标志中的 `RpcMode` 开始调用 |
| `DATA` | 3 | 一个流元素 |
| `END_INPUT` | 4 | 正常结束上传 |
| `END` | 5 | 成功结束响应，单响应在这一帧携带结果 |
| `ERROR` | 6 | 结束发生错误的调用 |
| `WINDOW_UPDATE` | 7 | 归还发送额度 |
| `STOP_INPUT` | 8 | 提前停止上传 |
| `CANCEL` | 9 | 取消整个调用 |

`HELLO` 消息体固定为 16 字节，由下表所列的四个 `u32` 数值按顺序组成。握手要求两端采用这一消息布局，部署时请同步升级 Registry、RPC 服务和客户端。

| 字段 | 本端公布的值 |
| --- | --- |
| 单帧消息体上限 | 65,536 字节 |
| 连接级短消息窗口 | 1 MiB |
| 连接级流式数据窗口 | 4 MiB |
| 单调用流式窗口 | 262,192 字节，可容纳 4 个最大 `DATA` 帧 |

各端的连接级接收窗口由这条连接上的调用共享。`OPEN` 和携带消息体的 `END` 占用短消息额度，剩余额度低于短消息窗口的四分之三时批量补回。`DATA` 同时占用连接级流式额度和单调用流式额度，包括帧头在内按字节计算。收端消费数据后累积待归还的流式额度。累积达到窗口的一半或剩余额度不足一个最大帧时尽快发送额度更新，其余情况使用 1 毫秒的定时器合并更新。`WINDOW_UPDATE` 携带一个 `u32` 增量。调用 ID 为 0 时，标志 0 归还短消息额度，标志 1 归还连接级流式额度。非零调用 ID 配合标志 0 归还对应调用的流式额度。

发送端从连接级流式额度中为响应保留最多一个最大帧的空间，保留后的窗口仍可容纳一个最大上传帧。上传因共享额度不足而排队时，能发送的响应可以先发。这让双方同时上传时，仍有空间发送响应并继续处理输入。响应持续占满可用额度时，上传需要等待共享额度累积。

TCP 读写高水位均为 262,192 字节，发送端按写入背压暂停和恢复。`OPEN` 先准备帧体，再分配调用 ID，发送时将帧头写入同一缓冲区。其他帧在帧体不超过 4 KiB 时也合入同一个写缓冲，更大的帧分开提交帧头和帧体。并发小帧可在同一事件循环批量写出。排队等待消费的 `DATA` 若引用超过其计费字节数四倍的接收缓冲，会复制到独立缓冲区，以限制队列保留的内存。

`ERROR` 消息体先写 `u16` 错误码，再写最多 1,024 字节的 UTF-8 消息。错误码 1 至 7 依次对应 `CANCELLED`、`DEADLINE_EXCEEDED`、`INVALID_ARGUMENT`、`NOT_FOUND`、`RESOURCE_EXHAUSTED`、`UNAVAILABLE` 和 `INTERNAL`。

## 单连接性能实测

2026 年 11 月 25 日在一台 Intel Core i9-9880H、16 GiB 内存的 macOS 机器上使用 Node.js v24.22.1 测试。
客户端和服务端各自运行在独立进程中，通过本机的一条 TCP 连接传输原始二进制数据。测试关闭 TLS 和压缩。
WS 使用 `ws` 8.23.0，原生掩码使用 `bufferutil` 4.2.0，gRPC 使用 `@grpc/grpc-js` 1.14.7。

### 吞吐

单响应场景做原样回传，并发数指同时等待结果的调用数。所有结果取三轮中位数，单轮测量 900 毫秒或 1.8 秒。
本节 Ainess 数据采集于取消在途请求数上限之前。1,024 和 4,096 并发组分别将当时两端的 `maxConcurrentCalls` 配置为对应值。
gRPC 在 256 和 1,024 并发组分别设置相同的 HTTP/2 并发流上限。表中「—」表示对应场景未采集。

| 场景 | Ainess | WS | WS + 原生掩码 | gRPC |
| --- | ---: | ---: | ---: | ---: |
| 32 B，1 并发（请求/秒） | 13,242 | 11,542 | 10,995 | — |
| 128 B，128 并发（请求/秒） | 241,016 | 79,354 | 90,621 | — |
| 128 B，256 并发（请求/秒） | 305,965 | 110,536 | 98,639 | 5,455 |
| 128 B，1,024 并发（请求/秒） | 434,793 | 98,231 | 98,615 | 6,251 |
| 128 B，4,096 并发（请求/秒） | 220,667 | 79,572 | 75,924 | — |
| 4 路响应流，4 KiB 分块（MiB/s） | 526 | 223 | 246 | — |
| 4 路响应流，64 KiB 分块（MiB/s） | 519 | 421 | 451 | — |

1,024 并发时，Ainess 的吞吐约为两种 WS 中较快一组的 4.4 倍，P99 延迟为 7.44 毫秒，
两种 WS 分别为 13.69 和 12.86 毫秒。32 B 单并发时各组的三轮结果区间有重叠。
Ainess 在 4,096 并发时的三轮吞吐从约 11.9 万到 35.2 万请求/秒，波动大于 1,024 并发组。

### 内存

RSS 按客户端和服务端同一时刻的进程驻留内存相加。每轮重新启动两个进程，预热前测量空闲 RSS，
随后在 1.8 秒的正式测量期内约每 100 毫秒采样一次。空闲值和观测峰值均取三轮中位数，单位为 MiB。

| 场景 | Ainess | WS | WS + 原生掩码 | gRPC |
| --- | ---: | ---: | ---: | ---: |
| 固定混合负载组的空闲 RSS | 84 | 92 | 93 | 109 |
| 固定混合负载峰值 RSS | 138 | 146 | 148 | 335 |
| 128 B，256 并发峰值 RSS | 167 | 147 | 218 | 451 |
| 128 B，1,024 并发峰值 RSS | 345 | 279 | 277 | 512 |
| 128 B，4,096 并发峰值 RSS | 302 | 290 | 287 | — |

固定混合负载以每秒 4,000 次为目标发起 128 B 单响应调用，同时运行 4 路响应流，以 64 KiB 分块，每路目标 16 MiB/s。
Ainess 和两种 WS 均达到约 4,000 请求/秒和 64 MiB/s。gRPC 的中位数为 3,970 请求/秒和 62.8 MiB/s，
三轮共丢弃 383 次计划发起的请求。固定混合负载下，Ainess 的峰值 RSS 低于两种 WS。
1,024 并发满载时，Ainess 的峰值 RSS 高出约 66 至 68 MiB。满载时各实现每秒完成的工作量不同。

## 构建和验证

在仓库根目录运行 `pnpm --filter @ainess/rpc build`，生成 `dist/` 中的 ESM 运行时和类型声明。运行 `node --test 'packages/rpc/test/*.test.js'` 执行包测试。根目录的 `pnpm test` 同时构建工作区、检查测试类型，并运行所有包的测试。
