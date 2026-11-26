# @ainess/registry-server 开发指引

公开接口、RPC 行为和使用示例见[使用手册](README.md)。

- 包持有一个监听器和其内存服务目录。`RegistryServer.listen(address, options?)` 启动监听，`options.signal` 可取消启动，`address` 返回实际绑定地址，`close()` 关闭监听与接入连接。Cordis 插件 `registryServer` 在 `ctx.effect()` 中托管监听，在就绪后提供 `ctx.registryServer`，启动期间卸载时取消尚未完成的绑定。
- 运行时复用 `@ainess/rpc` 与 `@ainess/registry-shared`。服务声明、RPC 名称和数据校验来自共享包。Cordis 由宿主提供，插件从 `@deepseek-ai/cordis` 引用 `Context` 类型。
- 注册按服务和地址匹配。接入的控制连接将 TCP KeepAlive 的初始空闲阈值配置为 5 秒，实际探测受平台限制。每条 RPC 连接拥有自己的登记，重复注册保持幂等，部分注销和断线仅移除该连接的登记。服务目录按连接索引登记以便断线清理，同时按服务索引去重后的候选地址。
- `list` 捕获请求开始时的地址快照，按 RPC 帧分批交付。`pick` 沿每个服务的候选地址链表等权轮询，按本次 `exclude` 跳过地址，从选中的下一个候选继续。所有候选均被排除时返回 `null` 并保留游标。成员变化时从下一有效地址继续，单个地址的摘除不扫描其他候选。
- 根目录执行 `pnpm --filter @ainess/registry-server... run build`，再运行 `node --test packages/registry-server/test/registry-server.test.js`。真实 TCP 用例覆盖多连接归属、断线清理、轮询、多帧快照、Cordis 卸载和启动取消后的端口重新绑定。使用 `pnpm test` 验证整个工作区。
