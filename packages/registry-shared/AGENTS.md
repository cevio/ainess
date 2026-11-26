# @ainess/registry-shared 开发指引

协议、公开入口和验证方式见[使用手册](README.md)。

- 本包拥有 Registry 注册发现的 RPC 方法名、数据类型、JSON 编解码及边界校验。服务端和客户端在各自的入口调用同一份协议实现。地址类型复用 `@ainess/rpc` 的 `RpcAddress`。
- `register` 和 `unregister` 以相同地址的一组服务 ID 为参数。`list` 查询一个服务 ID，`pick` 还可传入本次排除的地址数组。校验后保留原始地址和服务 ID，列表中的重复服务 ID 按首次出现顺序合并。
- 消息使用 UTF-8 JSON。通过 RPC 的 `rpcPayloadLimit()` 取得响应帧上限，按注册和注销方法名取较小的请求限额。恢复和批量注销按请求帧拆分，实例列表按响应 DATA 帧拆分。分帧保持输入顺序。
- `registryKeepAliveInitialDelayMs` 提供控制连接两端共用的 TCP 首次探测空闲阈值。连接、状态、重连策略和资源清理由服务端与客户端各自管理。编解码使用 Node.js 原生字节接口。
- 在根目录运行 `pnpm --filter @ainess/registry-shared... build` 和 `node --test 'packages/registry-shared/test/*.test.js'` 验证协议，再运行 `pnpm test` 验证整个工作区。
