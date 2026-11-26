# @ainess/registry-shared

用于实现兼容的 Registry RPC 端点或协议测试。复用 `registryMethods`、请求和响应类型、消息编解码与校验。两端通过 `registryKeepAliveInitialDelayMs` 将控制连接的 TCP KeepAlive 初始空闲阈值配置为 5 秒。应用业务调用通过 `@ainess/registry-client` 进行。 [Registry 共享协议手册](https://github.com/cevio/ainess/blob/main/packages/registry-shared/README.md)

## 校验和编码登记

从 `@ainess/registry-shared` 导入协议函数。保存为 `registration.mjs`，运行 `node registration.mjs` 应输出地址和去重后的 `orders`、`refunds` 两个服务 ID。

```js
import {
  decodeRegistryMessage,
  encodeRegistryRegistration,
  parseRegistration,
} from '@ainess/registry-shared'

const request = parseRegistration({
  host: '127.0.0.1',
  port: 7001,
  services: ['orders', 'refunds', 'orders'],
})
const bytes = encodeRegistryRegistration(request)
console.log(parseRegistration(decodeRegistryMessage(bytes)))
```

`registryMethods` 定义 `register`、`unregister`、`list` 和 `pick` 的 RPC 方法名。处理方先解码 UTF-8 JSON，再调用对应的校验器，例如 `parsePickQuery` 读取服务名和可选排除地址。校验失败抛出 `TypeError`。

`encodeRegistryRegistrationBatches()` 按请求帧上限拆分恢复和注销清单，`encodeRegistryListBatches()` 按响应帧上限拆分地址快照。`pick` 请求提交在单个帧内，可用 RPC 的 `rpcPayloadLimit(registryMethods.pick)` 计算 UTF-8 载荷上限。 [RPC](rpc.md) · [Registry 服务端](registry-server.md) · [Registry 客户端](registry-client.md)
