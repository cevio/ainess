# @ainess/registry-shared

供 [@ainess/registry-server](../registry-server/README.md) 和 [@ainess/registry-client](../registry-client/README.md) 共用的注册发现协议与控制连接参数。普通应用从各自的角色包使用 Registry。直接实现或检查协议时，从 `@ainess/registry-shared` 导入下面的接口。

## 方法和类型

`registryMethods` 提供四个 RPC 方法名。`RpcAddress` 复用 [@ainess/rpc](../rpc/README.md) 的地址类型 `{ host: string, port: number }`。

| 方法名常量 | 模式 | 请求 | 响应 |
| --- | --- | --- | --- |
| `registryMethods.register` | `Unary` | `RegistrationRequest` | `RegisterResponse` |
| `registryMethods.unregister` | `Unary` | `RegistrationRequest` | `UnregisterResponse` |
| `registryMethods.list` | `ServerStream` | `ServiceQuery` | 每个数据帧为一批 `RpcAddress[]` |
| `registryMethods.pick` | `Unary` | `PickQuery` | `RpcAddress \| null` |

`RegistrationRequest` 包含 `host`、`port` 和 `services: readonly string[]`。`ServiceQuery` 为 `{ service: string }`。`PickQuery` 在此基础上接受可选的 `exclude?: readonly RpcAddress[]`。排除只作用于本次选址，地址按原始主机名和端口精确匹配。`RegisterResponse` 为 `{ registered: string[] }`，`UnregisterResponse` 为 `{ removed: string[] }`。

`PickQuery` 通过单帧发送。整个 JSON 请求的 UTF-8 字节数受 `rpcPayloadLimit(registryMethods.pick)` 限制。

`registryKeepAliveInitialDelayMs` 为 `5000`，可传给 RPC 的 `keepAliveInitialDelayMs` 选项，将 Registry 控制连接的 TCP KeepAlive 初始空闲阈值配置为 5 秒。实际探测受平台限制。 [RPC 连接保活](../rpc/README.md#连接保活和关闭通知)

## 编解码和校验

| 入口 | 用法 |
| --- | --- |
| `encodeRegistryMessage(value)`、`decodeRegistryMessage(bytes)` | 将可表示为 JSON 的消息转换成 UTF-8 字节，或将字节解析为待校验的值。无效 UTF-8 或 JSON 引发 `TypeError`。 |
| `parseRegistration(value)`、`parseServiceQuery(value)`、`parsePickQuery(value)` | 校验请求并返回新对象。服务 ID 和主机名为非空白字符串，端口是 1 至 65535 的整数。服务数组允许为空，重复 ID 只保留一次。`exclude` 可省略或传入地址数组。 |
| `parseRegisterResponse(value)`、`parseUnregisterResponse(value)` | 校验写入响应，返回对应的服务 ID 列表。 |
| `parseRegistryListBatch(value)`、`parseRegistryPickResponse(value)` | 校验列表批次或单个轮询结果。空候选的轮询结果为 `null`。 |
| `registryAddressKey(address)` | 返回由主机名和端口组成的稳定键。 |
| `encodeRegistryRegistration(request)` | 编码一次登记请求。注册和注销共用 65,506 字节的请求限额，确保每个服务都能单独注销。超出限额引发 `TypeError`。 |
| `encodeRegistryRegistrationBatches(request)` | 按帧大小和输入顺序惰性编码注册或注销批次，每次返回 `{ data, services }`。服务 ID 可用于校验该批确认。空输入产生零个批次，单项超出帧限额引发 `TypeError`。 |
| `encodeRegistryListBatches(addresses)` | 按相同规则分批编码地址，每次返回一个 `Uint8Array`。 |

校验器在消息形状无效时引发 `TypeError`。请求和响应的帧大小由 `@ainess/rpc` 的 `rpcPayloadLimit()` 提供。下面的 ESM 示例可在已依赖此包的应用里运行。

```js
import {
  decodeRegistryMessage,
  encodeRegistryRegistration,
  parseRegistration,
} from '@ainess/registry-shared'

const request = parseRegistration({
  host: '127.0.0.1',
  port: 7001,
  services: ['com.example.orders', 'com.example.refunds'],
})
const bytes = encodeRegistryRegistration(request)
console.log(parseRegistration(decodeRegistryMessage(bytes)))
```

内部编解码使用 Node.js 标准库，地址声明来自 `@ainess/rpc`。在仓库根目录运行 `pnpm --filter @ainess/registry-shared... build` 后执行 `node --test 'packages/registry-shared/test/*.test.js'`，验证参数校验、UTF-8 和跨帧传输。
