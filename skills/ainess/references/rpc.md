# @ainess/rpc

用 `RpcServer.listen({ host, port, onPeer, signal })` 开始监听。可选的 `signal` 用于取消监听启动。`RpcPeer.connect({ host, port }, { methods, signal })` 先拨通 TCP，再用同一个 socket 初始化 RPC 并完成握手。两阶段共用 10 秒时限，可通过 `signal` 取消。连接两端都可发起和处理调用。监听端在 `onPeer` 取得接入端点，处理函数通过上下文的 `peer` 发起同连接反向调用。用 `peer.register()` 注册连接专属方法，用 `server.register()` 注册监听器共享方法。连接专属方法优先于同名共享方法。返回的注销函数立即移除该注册，并等待它已接收的调用清理。任一端可用 `request(name, options?)` 接收单响应，用 `stream(name, options?)` 接收流。发送初始数据时，在方法名和选项之间传入 `Uint8Array`。提供 `options.input` 开启上传流，上传源应响应自己的 `AbortSignal`。处理方可通过 `input.stop()` 只停止上传方向。业务对象由应用编解码，结束时等待端点和监听器的 `close()`。 [RPC 手册](https://github.com/cevio/ainess/blob/main/packages/rpc/README.md)

连接双方通过 16 字节 `HELLO` 交换帧大小与接收窗口，后续通过字节窗口和 TCP 背压调度传输。两端启用 TCP KeepAlive，初始空闲阈值默认为 30 秒。监听端和拨号端都可用 `keepAliveInitialDelayMs` 设置本端的阈值，实际探测受平台限制。对任一端点使用 `peer.onClose(listener)` 订阅一次异步关闭通知，已关闭的端点也会通知新订阅。监听器接收 `RpcCloseInfo` 的 `reason` 和 `error`，返回的取消订阅函数由调用方管理。应用可在通知时从连接表移除端点，并自行安排重连。 [传输协议](https://github.com/cevio/ainess/blob/main/packages/rpc/README.md#传输协议) · [连接保活和关闭通知](https://github.com/cevio/ainess/blob/main/packages/rpc/README.md#连接保活和关闭通知)

调用选项 `onResponse` 可观察首个成功响应，`onFailure` 可观察已开始调用的失败来源、本端 `OPEN` 提交时间和流式响应是否已开始。由调用信号取消时，RPC 错误的 `cause` 保留信号原因。调用方通过 Promise 或迭代器接收调用结果。 [RPC 调用选项](https://github.com/cevio/ainess/blob/main/packages/rpc/README.md#发起调用)

按大小分批编码时使用 `rpcPayloadLimit(method?)` 取得当前协议的载荷上限。传方法名计算初始请求的可用字节数，省略时计算单个流元素或单响应的上限。 [RPC 接口](https://github.com/cevio/ainess/blob/main/packages/rpc/README.md#接口)

响应流在首次读取时启动，提前结束迭代时取消对应调用。长时间复用连接时可通过 `remainingOutgoingCallIds` 识别调用 ID 耗尽并安排换连，等在途工作结束再关闭旧端点。Registry 和业务 RPC 的通信双方须使用相同的 `HELLO` 布局。 [发现地址后直连](registry-client.md) · [按服务名调用](micro.md)

## 接入 TCP RPC

宿主提供 `@ainess/rpc`、`@ainess/framework` 和 `@deepseek-ai/cordis`。以下 `rpc.mjs` 把 RPC 监听器装配为框架入口，通过 `ctx.effect()` 托管，由框架关闭。拨号端请求问候时，接入端通过同一条连接反向调用拨号端的方法。

```js
import { defineApp, use } from '@ainess/framework'
import { RpcMode, RpcPeer, RpcServer } from '@ainess/rpc'

/** @type {import('@ainess/rpc').RpcAddress | undefined} */
let address

const app = defineApp({
  entries: {
    rpc: use(async (ctx) => {
      await ctx.effect(async () => {
        const server = await RpcServer.listen({
          host: '127.0.0.1',
          port: 0,
          onPeer(peer) {
            peer.register({
              name: 'demo.greet',
              mode: RpcMode.Unary,
              handle: ({ peer, signal }) => peer.request('demo.message', { signal, timeoutMs: 5_000 }),
            })
          },
        })
        address = server.address
        return () => server.close()
      })
    }),
  },
})

const running = await app.start()
try {
  if (!address) throw new Error('RPC entry did not start')
  const peer = await RpcPeer.connect(address, {
    methods: [{
      name: 'demo.message',
      mode: RpcMode.Unary,
      handle: () => new TextEncoder().encode('hello'),
    }],
  })
  try {
    const reply = await peer.request('demo.greet', {
      timeoutMs: 5_000,
    })
    console.log(new TextDecoder().decode(reply))
  } finally {
    await peer.close()
  }
} finally {
  await running.stop()
}
```

运行 `node rpc.mjs` 会输出 `hello`。`app.start()` 等待 RPC 监听就绪。`RpcPeer.connect()` 先拨通 TCP，再在同一条连接上完成 RPC 握手。监听端在分派首个入站调用前执行 `onPeer`。问候处理函数通过上下文的 `peer` 反向调用 `demo.message`，并用 `signal` 传递取消信号。长期使用的端点由其调用方或创建它的插件复用并在退出时关闭。 [同连接反向调用与双向流](https://github.com/cevio/ainess/blob/main/packages/rpc/README.md#快速开始)

插件若维护活跃连接表，可在 `onPeer` 中记录端点，并用 `peer.onClose(() => { peers.delete(peer) })` 在关闭时移除。拨号端可以用同一个接口接收异步关闭通知，按 `reason` 处理本端关闭、对端正常关闭和错误，并在应用层安排重连。 [连接保活和关闭通知](https://github.com/cevio/ainess/blob/main/packages/rpc/README.md#连接保活和关闭通知)
