# Staged changes：20 个 commit 的拆分计划

## 1. 范围、规模与执行原则

本计划最初基于 2026-09-06 的 Git index，基线 HEAD 为 `a77ae8a0972f6d6fa39bb4a1cfaf4615a05cf91e`。首次检查开始时没有 tracked unstaged diff。随后按用户要求，已在工作区完成 milestone 文件重命名，以及测试入口、npm 命令、工具配置名称和本计划的引用更新；没有修改业务逻辑、改写 index 或创建 commit。后文使用新路径，原始规模统计仍指首次检查的 79 个文件，不含本计划。下文 F01–F37 的修复代码仍是未来建议，尚未应用。

原始 staged diff 共 **79 个文件，15,422 行新增、102 行删除**。其中应用源码的新增加删除约 **8,260 行**（Python 应用和 TypeScript，包含类型、注释、CSS、模板，不含 fake runtime）；测试和 fake runtime 约 **5,942 行**；其余是工具、配置、依赖和翻译。仅应用源码按 20 份平均就约 413 行，不能诚实地把全部改动描述成“每个约 100 行”。

建议优先满足 **20 个 commit、每个围绕一个模块或目标、依赖可顺序落地**。纯业务编排尽量保持约 100–150 行；manifest 校验、IndexedDB、Worker 和生命周期基础提交明确允许超额。下表是原 diff 的粗略审阅规模，不把测试、类型或重复实现隐藏为“免费行数”，也不包含建议修复的新增量。若约 100 行是硬上限，就必须增加 commit 数或缩减本批功能，单靠重新暂存无法同时满足两个目标。

拆分时遵守以下规则：

1. 按本文件顺序落地；每个 commit 的测试应只引用已经存在的模块。`src/tests/test_index.ts` 随对应测试逐次加入 import，不能一次加入全部 17 项。
2. `package.json` 按 hunk 分配，脚本引用的文件必须同 commit 或更早存在；`package-lock.json` 的 LiteRT 依赖只放在 C12。测试 fixture 的 import 也要随拆分调整。
3. `model-manager.ts`、`pv-app.ts`、模型卡和聚合测试必须按函数/测试案例拆分，新文件可以分多次引入。不要用会假装成功的空方法填补后续功能；尚未实现的方法和调用一起延后。
4. 下文“问题与建议”是对当前 staged 实现的附加建议。纯历史拆分应保持最终 tree 等价；采纳修复后则有意不等价，需要在对应 commit description 中明确列出修复。不要把原本没有的文件称为 staged 文件。
5. 原文件中的 M0/M1/M2/M3/M4 是历史里程碑命名，不作为 commit 边界。M1–M4 文件已按下表改为功能命名；使用最终名称直接加入对应功能 commit，不增加第 21 个“改名”提交。跨模块的集成测试靠近完整集成处，领域测试随领域提交。
6. 不为满足行数而单独提交 imports、只搬测试或只放类型的无意义提交。大提交内部可以分几个 review 段，但段的行数不能冒充 commit 的行数。

### 已实施的文件命名整理

检查到 12 个使用 milestone 文件名的文件：8 个测试、4 个验证工具。它们都有持续的测试/发布用途，没有仅记录 milestone 完成状态的空文件，因此全部保留并重命名，没有删除测试案例或验证逻辑。没有发现以 M1/M2 命名的其他现存源码文件；模型存储测试里的模型 ID `m1` 不是 milestone，不做替换。

| 旧路径 | 新路径 | 保留原因与 commit 归属 |
|---|---|---|
| `src/tests/test_m3_integration.ts` | `src/tests/test_on-device-integration.ts` | 模式、模型加载、建议生成和移除的集成合同；C15 |
| `src/tests/test_m3_runtime.ts` | `src/tests/test_inference-runtime.ts` | Worker protocol/client、fake adapter、Local provider；C10/C12/C15 |
| `src/tests/test_m4_compatibility.ts` | `src/tests/test_model-capabilities.ts` | 模拟能力/配额/adapter 失败分支，不能命名为真实平台矩阵；C13 |
| `src/tests/test_m4_diagnostics.ts` | `src/tests/test_diagnostics-exporter.ts` | 诊断 schema 与敏感信息过滤回归；C19 |
| `src/tests/test_m4_failure_injection.ts` | `src/tests/test_model-failure-recovery.ts` | 断流、候选失败、存储失配、设备丢失；C14/C15 |
| `src/tests/test_m4_feature_flags.ts` | `src/tests/test_feature-flags.ts` | cohort、rollout 和不回落 Cloud；C16 |
| `src/tests/test_m4_performance_soak.ts` | `src/tests/test_local-inference-regressions.ts` | fake runtime 响应性、多语言解析、重复调用与恢复；并非真正 soak；C20 |
| `src/tests/test_m4_privacy_network.ts` | `src/tests/test_local-inference-privacy.ts` | 页面 fetch 拦截下的 Local 隐私回归；C20 |
| `tools/verify-m1-prompt-parity.mjs` | `tools/verify-prompt-parity.mjs` | 浏览器 renderer 与 Python canonical Jinja 的实际比较；C02 |
| `tools/verify-m4-compatibility.mjs` | `tools/verify-on-device-compatibility.mjs` | 校验真实平台证据；缺少矩阵输入应补输入而非删除校验；C20 |
| `tools/verify-m4-privacy-network.mjs` | `tools/verify-local-inference-privacy.mjs` | 快速静态边界检查；保留其非 wire-level 验证限制；C20 |
| `tools/m4-soak-runner.mjs` | `tools/verify-on-device-soak.mjs` | 验证已有 soak 报告，不负责运行/采集 soak；C20 |

已同步 `src/tests/test_index.ts` 的 import、隐私工具中的测试路径、相关 describe/log/comment 的 milestone 前缀，以及测试内部的 milestone fixture 名称。对外调用名称的迁移如下（未保留旧别名）：

| 旧名称 | 新名称 |
|---|---|
| `verify:m1-prompts` / `test:m1-prompts` | `verify:prompt-parity` / `test:prompt-parity` |
| `verify:m4-privacy` | `verify:local-privacy` |
| `verify:m4-compatibility` | `verify:on-device-compatibility` |
| `test:m4-soak` | `test:on-device-soak` |
| `M4_SOAK_RESULT` | `ON_DEVICE_SOAK_RESULT` |
| `M4_COMPATIBILITY_RESULTS` | `ON_DEVICE_COMPATIBILITY_RESULTS` |
| `docs/m4/compatibility.json` / `docs/m4/results` | `docs/on-device/compatibility.json` / `docs/on-device/results` |

上述证据目录在原仓库中不存在；这里只更新工具约定，没有创建假的矩阵或测量结果。外部 CI 若使用旧命令/环境变量，需要同步迁移。`test:on-device-soak` 仍保留原 test 前缀以限制本轮为命名整理；C20 F34 建议移到 `verify:on-device-soak` 并修默认 test 聚合，尚未实施。M0 的缺失 harness 路由/部署边界问题仍留在 C04/C20，不属于这 12 个现存 milestone 文件的改名范围。

命名整理验证：8 个 suite 的 47 个 `it()` 案例数量保持不变；测试聚合入口的所有 import 和 npm 中所有 Node 工具路径均可解析；4 个改名工具通过 `node --check`；`verify-local-inference-privacy.mjs` 静态检查通过；可执行引用中未残留旧文件名/命令/环境变量，旧名仅保留于本节迁移表。未安装项目依赖，因此没有运行完整浏览器测试或 prompt parity，原 F23 编译问题仍待修复。

## 2. 总览与依赖

| Commit | 建议标题 | 直接依赖 | 应用源码审阅量估计，不含测试 | 主要边界 |
|---|---|---|---:|---|
| C01 | `refactor(suggestions): define inference routes and preserve cloud behavior` | HEAD | 170–240 | 配置迁移、provider 契约、Cloud/router |
| C02 | `feat(prompts): render canonical templates in the browser` | C01 | 150–180 | prompt、输出解析、parity |
| C03 | `feat(models): validate the public model manifest contract` | HEAD | 670 | Python/TS schema，一处明显超额 |
| C04 | `feat(security): isolate browser resources and harden sessions` | HEAD | 130–180 | Flask/静态头、session、限流基础 |
| C05 | `feat(models): serve catalog metadata and signed downloads` | C03、C04 | 500–560 | catalog、API、HTTP client |
| C06 | `test(distribution): verify private GCS download contracts` | C05 | 0；工具 490 | IAM/CORS/Range/live 验证 |
| C07 | `feat(storage): persist model artifacts in OPFS` | HEAD | 376，含内存实现 | 文件写入、读取、promotion |
| C08 | `feat(storage): track model versions transactionally` | C03 | 641，含内存实现 | IndexedDB、active/LKG |
| C09 | `feat(models): verify artifacts with streaming SHA-256` | C07 | 631，含重复 hash 实现 | 哈希、背压、Worker |
| C10 | `feat(runtime): define capabilities and runtime contracts` | C03 | 约 576；另 fake 181 | lifecycle/adapter/protocol/preflight |
| C11 | `feat(downloads): resume pinned artifacts across tabs` | C05、C07、C08、C10 | 495 | downloader 和下载锁 |
| C12 | `feat(runtime): run LiteRT inference in a dedicated worker` | C04、C10 | 910；另构建 46 | 真 Worker、client、Wasm 打包 |
| C13 | `feat(models): orchestrate installation and offline startup` | C08–C12 | 约 600–700 | manager 核心安装/激活 |
| C14 | `feat(models): update and roll back verified versions` | C13 | 约 180–240 | 更新、LKG、清理和移除 |
| C15 | `feat(suggestions): integrate local generation with stale-result guards` | C01、C02、C12–C14 | 约 380–440 | Local provider、app 请求链 |
| C16 | `feat(rollout): gate local activation without cloud fallback` | C04、C13、C15 | 约 230–270 | flags endpoint、cohort、启动策略 |
| C17 | `feat(settings): manage on-device models from the settings UI` | C14–C16 | 约 650–750，含模板/CSS | 设置、模型卡、删除确认 |
| C18 | `feat(models): import debug model artifacts locally` | C09、C13、C17 | 约 150–190 | 导入与 UI 入口 |
| C19 | `feat(diagnostics): export local runtime and storage health` | C13、C17 | 约 400–470，含模板 | diagnostics、资源面板 |
| C20 | `test(release): add privacy and real-device evidence gates` | C01–C19 | 0；工具约 264 | 集成回归、发布脚本、翻译余项 |

C03/C07/C08/C09/C10/C11/C12/C13 是超出 100 行预期最明显的部分。它们是独立可审阅的领域实现，已经没有空间在 20 个 commit 内全部再细分。C12 应按“load/smoke”“generation/cancel”“client settlement”三段阅读，C13 按“恢复”“安装”“激活”三段阅读，但仍是一个 commit。

## 3. 每个 commit 的具体内容

### C01 — Provider 契约和 Cloud 行为保持

**目标：** 引入推理目的地这一独立配置，保持已有 Gemini 请求内容和结果不变。此时不在产品 UI 中开放 Local。

**核心文件/函数：**

- `src/config-storage.ts`：`InferenceMode`、`Config.inferenceMode`；`src/constants.ts`：默认 `cloud`。
- `src/state.ts`：`inferenceModeSignal`、getter/setter、`loadState()` 对旧配置和非法值的迁移。
- `src/suggestion-provider.ts`：request/result/partial/identity/error/provider 契约。
- `src/cloud-suggestion-provider.ts`：`getIdentity()`、`abort()`、`suggest()` 包装 `MacroApiClient.fetchSuggestions()`。
- `src/suggestion-provider-router.ts`：`selected()` 的 Cloud 延迟初始化、`abort()` 和 `suggest()` 的严格目的地选择。

**测试分配：** `test_config-storage.ts`、`test_state.ts` 全部新增案例；`test_suggestion-providers.ts` 中 Cloud payload、Local 报错不 fallback、切路由取消的案例。当前该测试文件顶层 import 了后续 prompt/mock provider，需要先使用只实现 `SuggestionProvider` 的最小测试对象，C02 再加剩余 import。测试入口同步添加。

**验收：** 旧 localStorage 未配置时仍是 Cloud；非法 mode 不启用 Local；Cloud macro 参数逐项一致；Local 报错不实例化 Cloud。此提交不改 `PvAppElement` 构造器，实际接线在 C15。

**完善建议：** 这里没有需要独立修复的确定性缺陷。Cloud/local 的身份必须用于后续缓存隔离，不能只以语言作为 key。

### C02 — 浏览器复用 canonical prompts 和解析逻辑

**目标：** 将现有后端 Jinja 模板作为唯一 prompt 来源，建立可离线测试的 renderer/parser。

**核心文件/函数：** `src/prompt-templates.ts` 的 10 个模板 import 和 `PROMPT_IDS`；`src/jinja2.d.ts`；`src/prompt-renderer.ts` 的 `renderPrompt()`、`getPromptIds()`；`src/suggestion-parser.ts` 的 `normalizeLocalInput()`、`parseSuggestionResponse()`；`src/on-device/model-identity.ts` 的未配置身份。

**工具/测试：** `tools/verify-prompt-parity.mjs` 比较 10 个模板 × 21 组变量；`src/tests/mock-suggestion-providers.ts`；C01 剩余的 `test_suggestion-providers.ts` 模板、日文规范化、去重和取消案例。`package.json` 在 build/watch/pretest 中加入 `.jinja2=text`，加入 `pretest:js`、`verify:prompt-parity` 和 `test:prompt-parity`。Worker build 留给 C12。

**验收：** `npm run verify:prompt-parity`；模板清单与 `templates/prompts`、语言配置匹配；未知模板/语法/变量明确失败。现有模板本身没有 staged 改动，不重复提交。

**完善建议：** mock 当前并行生成词句，真实 Local provider 在 C15 串行执行。保留 mock 只用于路由和竞态测试；词优先时序用真实 Local provider + fake runtime 测，避免从 mock 推断生产时序。例如：

```ts
const calls: string[] = [];
const adapter = new FakeModelRuntimeAdapter({
  generateHandler: async prompt => {
    calls.push(prompt);
    return '1. example';
  },
});
// C15 中加载 adapter 后使用 LocalSuggestionProvider；断言 calls 先词后句。
```

### C03 — 前后端模型 manifest 契约

**目标：** 对公开模型元数据使用一致的字段白名单、数值边界和不可执行约束。

**核心文件/函数：** `model_manifest.py`：`validate_manifest()`、`get_public_manifest()`、允许值集合和字段白名单；`src/on-device/model-manifest.ts`：类型、`validateModelManifest()`、`rejectUnknownKeys()`、控制字符检查。Python 的 bucket/object 私有字段只在服务端配置验证中启用。

**测试分配：** `test_model-manifest.ts` 全部；`tests/test_model_catalog.py` 中纯 manifest 测试。该 Python 文件目前顶层 import `main`，并有使用 catalog/limiter 的 autouse fixture；必须把这些 import/fixture 和 API 测试留到 C05，C03 临时在测试中定义有效 manifest fixture，不能提前引用不存在的 `model_catalog.py`。

**验收：** 两端接受同一个合法 fixture、规范化 SHA；拒绝未知嵌套字段、NaN/Infinity、重复语言、0 generation、非法 adapter 和不合理 token 上限。此提交约 670 行，是明确的规模例外。

**问题 F01（确定，契约不一致）：** 两端 validator 接受 version `.`、`..`，C07 `assertSafeStorageTarget()` 却拒绝，导致合法 catalog 元数据在写盘时失败。两端统一拒绝，增加同一组 fixture：

```python
if version in ('.', '..'):
  raise ManifestValidationError('version must not be a dot path segment')
```

```ts
if (record.version === '.' || record.version === '..') {
  throw new ManifestValidationError('version must not be a dot path segment');
}
```

导入的 `gcsGeneration: '0'` 是 C18 自行构造的特殊记录，不能通过放宽公共 schema 解决；在 C18 明确其本地来源。

### C04 — 浏览器隔离、session 与安全头

**目标：** 给 Flask 和 App Engine 静态资源建立一致的安全环境，为 Worker 准备 isolation。

**核心文件/函数：** `main.py` 的 secret 初始化、session cookie 配置、`SetRequestId()`、SeaSurf 注册顺序、`AddSecurityHeaders()`、`HandleForbidden()`、`CONTENT_SECURITY_POLICY`；`app_security.py` 的 `SlidingWindowRateLimiter.check()/clear()`；`app.yaml` 静态响应头和一小时缓存；`templates/base.jinja` 字体 stylesheet 的 anonymous CORS；`src/index.ts` 的 capability dataset。

`pyproject.toml` 删除 `flask-cors` 与 `main.py` 删除 `CORS(app)` 同提交。`main.py` 中 `ENABLE_M0_HARNESS`、`RestrictM0Harness()`、`M0()` 和兼容 alias 也归这里，按下述问题处理。模型授权 session 和签名路由在 C05。

**测试：** `tests/test_main.py` 的所有头/404/静态配置案例。增加 M0 开关、错误响应和 limiter 时间边界案例；`SIGNED_URL_RATE_LIMIT` 的配置与 limiter 实例可在 C05 使用它时引入。

**问题 F02（已用纯 Python 复现）：** limiter 只清理当前 key 的旧事件，不删除其他过期 key。不同 IP 长期累积，`_events` 没有界限。建议周期性、在锁内清理过期桶，并加 key 数量上限策略；最小示意：

```python
# 放在 with self._lock 内；生产实现按周期运行，避免每请求全量扫描。
for old_key, old_events in list(self._events.items()):
  if not old_events or old_events[-1] <= cutoff:
    del self._events[old_key]
```

验证 10,000 个唯一 key 过期后被回收；同 key 恰好到期后可访问。该 limiter 仍是进程级 backstop，不应在文档中称为全局配额。

**问题 F03（确定，缺失依赖）：** 新增 `/m0` 路由引用 `templates/m0.jinja`，该文件既不在 HEAD，也不在 staged diff；打开开关后会模板缺失。建议本批删除未交付 harness 的路由和无调用者 alias，保留默认隐藏的测试意图；若未来真的交付 harness，再连同模板/脚本一起加。示意：

```python
# 在 harness 未交付的版本中，不调用 render_template('m0.jinja')。
@app.route('/m0')
def M0():
  flask.abort(404)
```

**跨提交验证：** C09 的 Blob hash Worker 与 `worker-src 'self'` 冲突；C12 还需在这份 CSP 下验证真实 Wasm 编译。不要以字符串包含断言代替真实页面加载检查。

### C05 — 模型 catalog、签名下载 API 与客户端

**目标：** 仅从部署配置读取模型，返回公开 manifest，并给确切 version/generation 生成短期 URL。

**核心文件/函数：**

- `model_catalog.py`：`_load_and_validate_config()`、`get_default_manifest()`、`get_model()`、`generate_signed_download_url()`、`_generate_gcs_v4_signed_url()`、startup singleton 和测试 reset；`EXAMPLE_MODEL_CONFIG` 只作示例 fixture。
- `main.py`：`Root()` 设置应用 session；`GetDefaultOnDeviceModel()`；`GetSignedDownloadUrl()` 的 CSRF/session、ID/version 验证、限流、错误映射、no-store 和 URL 脱敏。
- `src/on-device/model-client.ts`：`ModelApiClient`、`HttpModelApiClient.getDefaultManifest()`、`getSignedDownloadUrl()`、`getCsrfToken()`。
- `pyproject.toml` 增加 `google-cloud-storage`。

**测试：** 补全 `tests/test_model_catalog.py` 的 catalog/API/autouse fixtures 和 fake signer；恢复 C03 延后的 import；校验未知模型/版本、403、429、generation 参数、private 字段剥离和日志脱敏。前端 API 错误/响应校验应补直接测试，不只由 manager 间接覆盖。

**问题 F04（确定，异常输入导致 500）：** `request.get_json(silent=True)` 可返回数组/字符串/数字，随后 `data.get('version')` 会抛异常，且位于业务 try 外。建议在调用 `.get()` 前限制为 object：

```python
if not isinstance(data, dict):
  return flask.jsonify({
      'error': 'INVALID_REQUEST_BODY',
      'message': 'Request body must be an object',
  }), 400
version = data.get('version')
```

用已授权且带 CSRF 的 client 分别提交 `[]`、`"text"`、`123`、`true`，均应得到 JSON 400。前端同样在访问 `data.url` 前排除 null/array：

```ts
if (!data || typeof data !== 'object' || Array.isArray(data)) {
  throw new Error('Malformed signed download URL response from server');
}
```

**部署待验证：** 当前 signer 直接依赖 `storage.Client()` 默认凭据能签名。单元测试的 FakeBlob 只验证参数，不能证明 App Engine 运行身份能签 V4 URL；C06 的 live gate 必须使用真实部署签名身份跑通。访问 `/` 即可获得授权标记，它是应用会话门槛，不是用户登录或 internal cohort 鉴权。

### C06 — GCS 分发策略与 live 合同验证

**目标：** 将 bucket/IAM/CORS 配置与浏览器下载所需 HTTP 合同对应起来。

**核心文件/函数：** `tools/verify_gcs_distribution.py` 的 `_is_safe_cors_origin()`、`validate_cors_policy()`、`validate_bucket_security()`、`validate_generation_pinning()`、`simulate_range_download_contract()`、`verify_live_distribution()`、`_open_signed_url()` 和 CLI；`tests/test_gcs_distribution.py` 全部。`package.json` 加 `verify:gcs` 和 `verify:gcs:policy`。

**验收：** 本地 policy/pytest 不访问云端；live 使用部署 config、`MODEL_SIGNER_IAM_MEMBER`、`ON_DEVICE_ALLOWED_ORIGINS`，验证 UBLA、无公共 IAM、generation/size、200/206/416。live 当前只读取 1 字节，不验证完整 SHA；不能称为 artifact digest 验证。

**问题 F05（纯函数已复现）：** `_is_safe_cors_origin('https://voice.example.com\n')` 返回 True；URL parser 会规范化部分控制字符。解析前应拒绝控制字符，避免输入验证依赖 parser 清洗：

```python
if any(ord(c) <= 0x20 or ord(c) == 0x7f for c in origin):
  return False
```

增加尾部换行、tab、前导空白、DEL 案例。已有带换行测试的字符串还包含第二个 URL/path，不能单独验证换行这个边界。

**完善建议 F06：** `simulate_range_download_contract()` 对 suffix range `bytes=-5` 的行为不是“最后 5 字节”；当前浏览器只用 `bytes=offset-`，主路径不受影响，但工具名称暗示一般 Range 合同。要么明确仅支持 offset range，要么补 suffix 和负数校验：

```python
if not parts[0]:
  suffix = int(parts[1])
  if suffix <= 0:
    return 416, {'Content-Range': f'bytes */{total_size}'}, b''
  start, end = max(0, total_size - suffix), total_size - 1
```

### C07 — OPFS 文件持久化

**目标：** 建立安全路径下的 partial/final 文件读写和晋升合同，供下载/哈希复用。

**核心文件/函数：** `src/on-device/model-storage.ts` 全部：`ModelStorage`、`assertSafeStorageTarget()`、`OpfsModelStorage` 的目录、`writeChunk()`、`readChunk()`、`promotePartialToModel()`、查询/删除；`InMemoryModelStorage` 同合同实现。`test_model-storage.ts` 全部。

**验收：** offset 写入、chunk 读取、partial promotion、版本间隔离、unsafe path。现有测试只实例化内存实现，应补真实 OPFS 的 close/reopen、异常中断和删除失败测试。

**问题 F07（确定，错误被吞）：** `deleteModel()`、`deletePartial()` 等捕获所有异常，权限/磁盘失败被误认为“不存在”，上层可能删掉 metadata 并显示删除成功。仅吞 `NotFoundError`：

```ts
} catch (error) {
  if (!(error instanceof DOMException && error.name === 'NotFoundError')) {
    throw error;
  }
}
```

**性能/容量风险 F08：** 每个网络 chunk 都 `createWritable({keepExistingData:true})`、seek、write、close，可能反复复制已有大文件；promotion 又在保留 partial 时完整复制 final。C10 仅估算 1.2 倍空间，无法覆盖普通复制路径的 partial + final 峰值。建议写入会话复用 writable，异常时 abort；promotion 若不能采用可用的原子 move，就按双份候选容量估算：

```ts
// 设计示意：下载期间复用同一 writable，结束/暂停时统一 close。
try {
  await writable.seek(offset);
  await writable.write(chunk as unknown as BufferSource);
} catch (error) {
  await writable.abort();
  throw error;
}
// C10 的复制方案 preflight：至少为 2 * candidateSize 留空间，另加 headroom。
```

需要 2GB 级真实 OPFS 测量才能确认耗时和实际配额峰值；这里不声称已测量。新增写入会话 API 是建议改造，不是现有函数。

### C08 — IndexedDB 元数据和 active/LKG 事务

**目标：** 分开记录模型与版本，实现 active、last-known-good（LKG）和下载进度的持久状态。

**核心文件/函数：** `src/on-device/model-metadata.ts` 全部：`ModelRecord/ModelVersionRecord`、`getDb()`、CRUD、`updateDownloadOffset()`、`setVerificationState()`、`setActiveVersion()`、`markVersionVerifiedAndActive()`、`rollbackToLastKnownGood()`、`finalizeActiveVersion()`、`deleteVersion()`、recovery/close，以及 InMemory 实现。

**测试：** `test_model-metadata.ts` 的 InMemory/IndexedDB 共用合同、数据库 reopen、schema upgrade、recovery。此提交不包含 manager 的更新业务。

**问题 F09（确定，事务完成边界错误）：** 多个写方法在 request success 或还未等待 put 时 resolve。`markVersionVerifiedAndActive()` 尤其在 `modelStore.put()` 后立刻成功返回，事务随后 abort 时，manager 已可能进入 ready。`finalizeActiveVersion()` 已使用正确的 `tx.oncomplete` 边界，可统一其他写方法：

```ts
return new Promise<void>((resolve, reject) => {
  const tx = db.transaction([STORE_MODELS, STORE_VERSIONS], 'readwrite');
  tx.oncomplete = () => resolve();
  tx.onabort = () => reject(tx.error ?? new Error('Metadata transaction aborted'));
  tx.onerror = () => reject(tx.error ?? new Error('Metadata transaction failed'));
  // 原 get/put callback 只组织事务，不调用 resolve()。
});
```

验证最后一个 put 后、commit 前注入 abort，Promise 必须 reject，active/LKG 不得部分更新。

**问题 F10（确定，blocked 被当成功）：** `recoverCorruptedDatabase()` 在 `deleteDatabase.onblocked` resolve，数据库实际上没删掉；其他 tab 未处理 `versionchange` 也可能导致恢复一直无法完成。建议打开成功后注册关闭逻辑，blocked 明确反馈给调用方，不报告恢复成功：

```ts
request.onsuccess = () => {
  const db = request.result;
  db.onversionchange = () => { db.close(); this.dbPromise = null; };
  resolve(db);
};
// deleteDatabase 的 blocked 分支应通知 UI/超时失败，不能 resolve 成功。
```

### C09 — 流式 SHA-256 和后台校验

**目标：** 不把整个模型读入内存，按块计算 digest，并对 Worker 消费增加背压。

**核心文件/函数：** `src/on-device/hash-verifier.ts` 全部：`StreamingSha256.update()/digest()/transformBlock()`、`HASH_WORKER_SCRIPT`、`verifyArtifactDigestInWorker()`、`verifyArtifactDigestInThread()`、`verifyArtifactDigest()`；`test_hash-verifier.ts` 全部，包括 NIST 向量、跨 chunk、损坏、short read、两条执行路径一致性。

**问题 F11（确定，跨文件冲突）：** C04 CSP 为 `worker-src 'self'`，这里却通过 Blob URL 创建 hash Worker；当前策略没有许可 `blob:`。失败后无提示回退主线程，破坏“后台校验”意图。建议将 hash worker 作为同源静态入口打包，提取 SHA 实现供两端共享，顺便消除当前约 200 行手写重复代码：

```ts
// 建议新增 src/on-device/hash-worker.ts，复用提取后的 StreamingSha256。
const worker = new Worker('/static/hash-worker.js');
```

新入口和打包命令必须一起加入本 commit（可在 C09 建独立 hash build；C12 再合并进 `tools/build-worker.mjs`）。不要只是给 CSP 全面放开动态脚本。

**完善建议：** `sendAndWait()` 无超时，Worker 沉默时校验会永久 pending；创建 Worker 在 try 前，创建失败会泄漏 Blob URL。采用静态入口后消除 URL 生命周期问题，并给握手/chunk/finalize 加定时拒绝：

```ts
const timer = setTimeout(() => reject(new Error('Hash worker timed out')), 30_000);
// 在成功、error 和清理路径都 clearTimeout(timer)。
```

验收必须包括真实响应 CSP 下确实使用后台 Worker，不能只验证 fallback 算出的 digest 正确。

### C10 — 能力探测、生命周期和 runtime 协议

**目标：** 定义下载/模型管理与推理运行时的边界，并明确不支持设备如何失败。

**核心文件/函数：** `model-lifecycle.ts` 的状态、错误码和进度；`model-capabilities.ts` 的 `checkCapabilities()`、checker 注入和 quota/memory/persistence；`model-runtime-adapter.ts` 的 `ModelRuntimeAdapter`、`GenerationOptions/RuntimeMetrics`；`worker-protocol.ts` 的版本、请求/响应联合类型、`isWorkerRequest()/isWorkerResponse()`；`fake-runtime-adapter.ts` 全部。

**测试分配：** `test_inference-runtime.ts` 的协议和 FakeModelRuntimeAdapter 分组先加入，WorkerClient 和 Local provider 分组分别等 C12/C15；暂不加入依赖 manager 的 `test_model-capabilities.ts`，放 C13。若在这里测试 capabilities，直接调用 `checkCapabilities()`。

**问题 F12（确定，验证不完整）：** `GENERATE` 消息只检查 sequenceId 和 prompt，不检查 temperature/topP/maxOutputTokens；load 只检查 manifest 是 object。建议 optional generation 参数有限数值、整数和范围校验，load 使用 C03 validator，异常返回 false：

```ts
const validMax = value.maxOutputTokens === undefined ||
  (Number.isInteger(value.maxOutputTokens) &&
   (value.maxOutputTokens as number) > 0 &&
   (value.maxOutputTokens as number) <= 4096);
const validTemperature = value.temperature === undefined ||
  (typeof value.temperature === 'number' &&
   Number.isFinite(value.temperature) && value.temperature >= 0 && value.temperature <= 2);
// 与原 GENERATE 条件合并；topP 同理限制 0..1。
```

**完善建议：** quota 探测异常时当前返回近似无限容量，不应将“未知”显示成“有足够空间”；容量预检按 C07 实际写入策略计算峰值。增加 unknown quota 的显式状态，而不是放大默认数值。

### C11 — 可恢复下载和跨 tab 下载锁

**目标：** 下载同一个不可变模型时，安全恢复 partial、更新过期签名并协调并发下载。

**核心文件/函数：** `model-downloader.ts` 的 `getValidSignedUrl()`、`validateSignedUrlResponse()`、`validateDownloadResponse()`、`downloadArtifact()`；`tab-coordinator.ts` 的 `acquireDownloadLock()`、广播、subscribe/close。缓存 key 绑定 model/version/generation；403 仅重签一次；416/忽略 Range 的 200 从头重启；OPFS 实际长度作为恢复 offset。

**测试分配：** `test_tab-coordinator.ts` 全部。当前 downloader 案例集中在 `test_model-manager.ts`，可先提取成直接构造 `ModelDownloader` 的案例：200/206/403、错误 Content-Range、metadata 冲突、offset；C13 再补编排状态断言。可复用该文件路径逐步增长，不提前 import manager。

**问题 F13（确定，短响应丢弃可恢复数据）：** read loop 在 EOF 不检查最终长度，交给 C13 校验后被当作 checksum mismatch 删除 partial。实际是连接干净结束但下载不全时，应保留 partial 并报告下载未完成：

```ts
if (bytesDownloaded !== manifest.sizeBytes) {
  throw new ModelManagerError('ERR_DOWNLOAD_FAILED', 'Download ended before the expected size');
}
```

同时在 finally 释放 reader，异常时取消 body；测试短 200、短 206 后仍可从已存 offset 恢复。

**完善建议 F14：** URL 只校验 HTTPS，没有约束 hostname、userinfo、重复 generation。虽然生产 CSP 提供额外限制，HTTP client/downloader 的可信 URL 合同也应与部署保持一致：

```ts
if (parsedUrl.origin !== 'https://storage.googleapis.com' ||
    parsedUrl.username || parsedUrl.password ||
    parsedUrl.searchParams.getAll('generation').length !== 1) {
  throw new ModelManagerError('ERR_GENERATION_MISMATCH', 'Unexpected model download destination');
}
```

如果部署需要别的 GCS endpoint，使用显式部署白名单。跨 tab 的本地状态污染问题在实际消费广播的 C13 处理。

### C12 — 真实 LiteRT Worker、RPC client 与构建

**目标：** 将模型加载、smoke 和串行生成放入经典 Worker，主线程通过 adapter 接口消费流。

**核心文件/函数：**

- `inference-worker.ts`：`handleMessage()`、`getCapabilities()`、`loadModel()`、`runSmokeTest()`、`generate()`、`cancelGeneration()`、`disposeEngine()`、metrics/error 封装。
- `worker-client.ts`：`getWorker()`、`postRequest()`、`handleWorkerMessage()`、`handleRuntimeFailure()`、`load()`、`generate()`、`cancel()`、`dispose()`、`getMetrics()`。
- `tools/build-worker.mjs`：IIFE bundle、同源 Wasm/glue 复制；`.gitignore` 的 worker bundle/map（尾部空行变动同此 commit）；`package.json`/`package-lock.json` 的 `@litert-lm/core@0.15.0` 和 build 接线。

**测试：** `test_inference-runtime.ts` 的 ProtocolFakeWorker/InferenceWorkerClient 分组。再补真实 Worker 延迟结算、crash、取消超时和 disposal 测试，不能只依赖 fake 在同一调用栈里立刻返回所有消息。

**问题 F15（确定，开发路径漏构建）：** 项目推荐 `npm i && npm run dev`，但 `dev → watch` 只构建 index，不调用 worker builder 或复制 Wasm。全新 checkout 的 Local 路径缺少资源。最小修改：

```json
{
  "predev": "node tools/build-worker.mjs"
}
```

这只解决首次 dev；开发时改 Worker 还应加入 watcher 或说明需重新 build。对生成的 vendor/root Wasm 应补 gitignore，部署时却必须包含生产运行时所需资源。

**问题 F16（确定，取消响应过早）：** Worker 收到 CANCEL 后立刻发 DONE，未等 `activeGeneration.done`；client 因此设置 ready。旧 GENERATE 的 CANCELED 晚到时会清掉唯一 `activeStreamHandler`，可能影响新生成；若取消发生在 `createConversation()` 中，`if (generation.canceled) return` 甚至不发 CANCELED，旧 Promise 等到超时。

建议 CANCEL 的 DONE 表示旧任务已真正释放，并保证每个生成有终态：

```ts
case 'CANCEL': {
  const previous = activeGeneration;
  cancelGeneration(data.sequenceId);
  await previous?.done;
  post(data.requestId, 'DONE', {operation: 'cancel'});
  return;
}
// generate 中 createConversation 之后的取消分支：
if (generation.canceled) {
  post(request.requestId, 'CANCELED', {sequenceId: request.sequenceId});
  return;
}
```

client 还应按 requestId 管理流 handler，旧任务 finally 只清理自己；generation timeout/dispose 时拒绝全部 pending、清 timer 并终止失控 Worker，不让晚到消息把 error 改回 ready。测试顺序为旧取消 ACK、立刻启动新生成、旧消息延迟到达，断言新输出完整且 pending 清空。

**问题 F17（确定，资源生命周期不足）：** probeDevice 没有在正常 dispose 时 destroy；多次能力探测还反复注册同一个 `.lost.then`。给 probe 单独生命周期，销毁前移除全局引用，让主动销毁不被误判为设备丢失：

```ts
const owned = probeDevice;
probeDevice = null;
owned?.destroy();
// lost handler 首先判断 if (probeDevice !== owned) return;
```

**部署待验证：** 实际 CSP 下 Wasm 初始化是否需要增加 `script-src 'wasm-unsafe-eval'`；在 main/app.yaml 同步、以真实 LiteRT 启动结果决定，不能仅放宽 `unsafe-eval`。Worker 当前忽略 manifest 的 input/generation 上限，C15 应按已加载 manifest 限制请求，长 prompt 也需明确超限处理。

### C13 — 模型安装、激活和离线恢复编排

**目标：** 将存储、下载、校验和 runtime 合成首次安装与重启恢复的完整生命周期。

**核心文件/函数：** `model-manager.ts` 的 `ModelManagerOptions`、`defaultModelCandidateProbe()`、`LEGAL_STATE_TRANSITIONS`、构造/监听/getter、`bindRuntimeAdapter()/handleRuntimeStatus()`、`checkCapabilities()`、`initialize()/startup()`、`loadActiveModel()/unloadActiveModel()`、`downloadModel()/executeDownload()`、`verifyAndPromote()/activateCandidate()`、`pauseDownload()` 和进度广播。先不加入 C14 更新/回滚/删除、C18 import 和 C19 历史记录。

**测试：** `test_model-manager.ts` 的 fixture/主生命周期/下载/校验/恢复/preflight 案例；`test_model-capabilities.ts` 全部（其作用是模拟 capability 分支，不是真平台矩阵）；C11 的直接 downloader 测试保留。增加使用真实 adapter 状态回调的生命周期测试。

**问题 F18（确定，本地 runtime 状态被远端覆盖）：** 构造器收到同 modelId 的 `STATE_CHANGE` 后直接 `transitionTo(msg.state)`，忽略 version。其他 tab 的 ready 不表示本 tab Worker 已加载，还可能触发非法转换。`executeDownload()` 发现另一 tab 已激活版本后也直接 ready，没有本地 load。

建议广播只更新远端进度/文件可用信息，ready 由本 tab runtime 决定；锁内复用 artifact 后走本地激活：

```ts
// executeDownload 的“已完成 artifact”分支：
this.activeManifest = completedRecord.manifest;
await this.activateCandidate(completedRecord.manifest);
return;
// 广播进度至少同时匹配 modelId 和 version；不复制远端 ready/generating。
```

增加双 tab、不同行为状态/不同版本测试，第二 tab 必须实际 load 之后才 ready。Web Locks 缺失时当前无互斥 fallback；若浏览器支持范围包含该情况，应禁止并发写或明确不支持。

**问题 F19（确定，暂停竞态）：** 等待 Web Lock 时还没有 AbortController，点击 cancel 只改 UI state，拿到锁后仍执行下载；校验阶段也不读取 abort，可能暂停后继续激活。建议将一次安装的 AbortController 提升到 `downloadModel()` 开始，传到锁队列、下载、校验和激活前检查：

```ts
const controller = new AbortController();
this.downloadAbortController = controller;
await this.tabCoordinator.acquireDownloadLock(modelId, version, async () => {
  controller.signal.throwIfAborted();
  // 下载与校验每阶段共用 signal；过期 operation 不得再发布状态。
});
```

这是接口设计示意；`acquireDownloadLock` 需扩展 signal 参数，使队列本身能取消。测试等待锁时取消、校验时取消、快速暂停再恢复。

**完善建议：** runtime adapter 为空时当前仍可能 ready；生产 manager 应要求 adapter，测试通过 fake 明确注入。`loadActiveModel()` 的 OPFS open 在 try 外，打开失败不会统一记录 manager error，应移入受控加载边界。

### C14 — 更新、回滚、健康确认和移除

**目标：** 候选版本失败时保持旧模型可用；首次真实成功后再清理 LKG；移除先释放 runtime。

**核心函数：** `model-manager.ts` 的 `checkForUpdate()`、`updateModel()`、`rollback()`、`confirmActiveVersionHealthy()`、`removeModel()`、`cleanupOrphanPartials()`；复用 C08 事务接口。

**测试：** `test_model-manager.ts` 的 update_available、quota failure、checksum/smoke failure、rollback、first-success cleanup、site-data loss、orphan 案例；`test_model-failure-recovery.ts` 的下载/更新/存储故障案例。该文件的 Local provider/device loss 案例等 C15 才添加。

**问题 F20（确定，更新状态覆盖可用性）：** `checkForUpdate()` 将 ready 改为 update_available，而 C15 readyChecker 只认 ready，用户仅检查更新就无法继续本地输入。check 按钮还在 downloading/generating 时可用，会请求状态机不允许的转换。建议把候选更新作为独立字段，不改变正在运行的状态：

```ts
// 设计示意：新增 availableUpdate 字段，保留 runtime lifecycle。
if (modelRecord?.activeVersion !== remoteManifest.version) {
  this.availableUpdate = remoteManifest;
  return remoteManifest;
}
```

C17 根据 `pendingUpdate` 显示更新按钮。测试发现新版本后仍可生成、生成过程中检查更新不抛非法转换。

**问题 F21（确定，常规 UI 移除失败）：** `downloaded` 不允许转 `not_downloaded`，但 C17 在 downloaded 显示 Remove；删文件成功后 `transitionTo` 抛错。增加这条合法转换，覆盖 unloaded→remove。另外，`removeModel()` 把 `activeManifest` 清空，卡片随即显示 Download，但点击时 `downloadModel()` 没有 manifest；应保留可下载 catalog manifest 或显式重新 initialize。

```ts
// LEGAL_STATE_TRANSITIONS.downloaded 增加：
'not_downloaded'
// 删除后保留已知、可重新安装的 manifest；本地 import 则回到获取 catalog 的流程。
```

**问题 F22（确定，候选与 active 混用）：** `downloadModel(newManifest)` 在成功激活前修改 activeManifest；update 暂停时只恢复 error 分支，可能留下旧 runtime + 新 manifest + not_downloaded。建议单独维护 candidateManifest，成功事务后才更新 activeManifest；错误或取消恢复旧状态，不能让身份指向未加载版本。示意：

```ts
const previous = this.activeManifest;
try {
  await this.installCandidate(newManifest); // 建议提取，失败/取消明确 reject。
} catch (error) {
  this.activeManifest = previous;
  // 按是否曾替换 runtime 决定恢复 load；随后向调用者报告失败。
  throw error;
}
```

`confirmActiveVersionHealthy()` 还应保护 LKG 与 active 相同的异常/旧 fixture 数据，防止删掉当前版本；清理失败应可重试，不能先永久丢失唯一清理指针：

```ts
if (model.lastKnownGoodVersion === model.activeVersion) return null;
```

### C15 — Local provider 与主应用建议链路

**目标：** 完整接通本地词/句生成，同时保留 Cloud、取消和过期结果保护。

**核心文件/函数：** `local-suggestion-provider.ts` 全部：`suggest()` 词优先串行生成、partial words、sequence/AbortController、错误归一化和 `UnavailableLocalSuggestionProvider`；`pv-app.ts` 的 provider/manager 构造接线、`isBlank()` 回退、`updateSuggestions()`、`cacheKey()`、请求计数、partial/final guards、健康确认。flags 的 connectedCallback 部分延后 C16，setting properties 延后 C17；少量既有模板空行整理归 C17。

**测试：** `test_pv-app.ts` 全部新增案例；`test_inference-runtime.ts` 的 Local provider 分组；`test_on-device-integration.ts` 全部；C14 延后的 `test_model-failure-recovery.ts` Local/runtime 故障案例。

**问题 F23（确定，构建阻断）：** 当前 `pv-app.ts` 的 finally 缺少一个闭合 `}`，Gate 3 紧接 `if (this.inFlightRequests === 0)` 的闭合后，导致 setTimeout 回调结构无法正确解析。修复应跟该方法首次落地，不另做无上下文修复 commit：

```ts
} finally {
  this.inFlightRequests--;
  if (this.inFlightRequests === 0) this.isLoading = false;
} // 当前 staged 源码缺少这一行。
// Gate 3 留在 finally 外。
if (!result || requestId !== this.suggestionRequestId ||
    mode !== this.stateInternal.inferenceMode) return;
```

**问题 F24（确定，await 后缺少 stale guard）：** Gate 3 之后 `await confirmActiveVersionHealthy()` 可能很慢。等待期间新输入/切模式，旧结果仍更新 UI/cache。每个可能让执行权交出的 await 之后重新判定；健康确认也应接受完成结果的 modelId/version，避免确认了别的新 active：

```ts
await this.modelManager.confirmActiveVersionHealthy();
if (requestId !== this.suggestionRequestId || mode !== this.stateInternal.inferenceMode) return;
```

测试让 cleanup deferred，期间发新输入，再释放旧 cleanup；旧结果不得覆盖新结果。旧请求的 error alert 同样应检查 sequence/mode，避免过期错误打断用户。

**完善建议 F25：** provider 硬编码 128/256 输出 token、temperature/topP，Worker 又硬编码 input 2048，忽略 manifest 中有效配置；按加载 manifest 限制上限，不在 provider 复制另一份模型配置：

```ts
const maxOutputTokens = Math.min(requestedLimit,
  manifest.generation.maxOutputTokens, manifest.capabilities.maxOutputTokens);
```

需要 adapter/provider 增加获得配置的接口；对于未知 tokenizer 的输入长度不能用字符数冒充 token 数，应明确拒绝/截断策略。`abort()` 的 `void runtimeAdapter.cancel()` 应捕获 rejection，取消失败交由 runtime 状态报告，避免 unhandled rejection。

**测试问题 F26（确定，资源和 fixture）：** `test_on-device-integration.ts`（以及 C20 privacy suite）为 fake 模型分配 `new Uint8Array(2008432640)`，每个 case 可占约 2GB，完全没有使用真实推理。改成小 payload 并同步 manifest size/SHA；容量测试单独模拟大数：

```ts
const payload = new Uint8Array(1024);
const file = new File([payload], 'fixture.litertlm');
const manifest = {...TEST_MANIFEST, sizeBytes: file.size};
// 涉及摘要验证时同时计算/更新 fixture.sha256。
```

fixture 还把 `lastKnownGoodVersion` 初始化为 active 本身；应为 null，否则成功建议触发 C14 cleanup 时可误删自身。

### C16 — 服务端 feature flags 和安全 rollout

**目标：** 默认 Cloud，新启用 Local 由 rollout 控制；已选择 Local 的用户不会被 flags 静默切到 Cloud。

**核心文件/函数：** `main.py.GetFeatures()`；`src/feature-flags.ts` 的 defaults、`hashClientIdToBucket()`、`isClientInOnDeviceCohort()`、`resolveSafeInferenceMode()`、`FeatureFlagsManager.fetchFlags()`；`pv-app.ts` 的 feature flags 字段、connectedCallback 中 fetch/client ID/eligibility，以及 Local startup。

**测试：** `tests/test_features.py`、`src/tests/test_feature-flags.ts`；补 flags 请求失败、禁用且 local 未安装、internal session、canary 上限和异步返回顺序。Python fixture 应隔离/恢复环境变量和 `main.app.config['TESTING']`，避免环境影响默认值测试。

**问题 F27（确定，异步结果和存储异常）：** `fetchFlags().then(async ...)` 内 localStorage/UUID 操作可能 throw，但没有 catch。调用 `getActiveVersionMetadata()` 时 startup 未完成还可能返回 null；随后用早先读到的 inferenceMode 写回，会覆盖用户在 metadata await 期间的选择。

建议把启动协调收敛到一个有错误处理的流程；installed 判断等待本地 reconciliation；flags 只更新资格，不重复写回未改变的 mode：

```ts
const flags = await this.featureFlags.fetchFlags();
// 使用有 try/catch 的 getOrCreateClientId；持久化不可用则用会话 ID。
this.localActivationAllowed = isClientInOnDeviceCohort(flags, clientId);
// 不用异步早期 snapshot 覆盖用户当前 state.inferenceMode。
```

`fetchFlags()` 还应严格解析 boolean 和有限 0..100 percentage，而非 `!!data.debugModelImport`（字符串 `"false"` 为 true）。已有 Local 保持 Local 是产品隐私不变量；全局 kill switch 在这里实际只暂停新激活。

### C17 — 设置页和模型生命周期卡片

**目标：** 用户能选择推理源、查看安装进度、加载/卸载、检查/安装更新和确认移除。

**核心文件/函数：** `pv-setting-panel.ts` 的 modelManager/rollout properties、`onInferenceModeChange()`、独立 Cloud model selector、响应式滚动尺寸、模型移除 sibling dialog/焦点恢复；`pv-on-device-model-card.ts` 的样式、状态/进度订阅、metadata/preflight、download/load/unload/retry/check/update/remove 操作和主体 render；`ui-utils.ts` 的 bytes/speed/state/badge/error 展示；`pv-app.ts` 的 setting 属性传递。

本 commit **不**加入卡片的 file import 字段/handler/按钮（C18），也不加入 diagnostics import/metrics/timer/details（C19）。卡片不能提前 import 后续文件。`xliff/ja.xlf` 中本次 UI/state/error 对应 trans-unit 同步加入，保留 placeholder ID；诊断/导入文案后移。

**测试：** `test_on_device_model_card.ts`、`test_on_device_settings.ts`；实测 keyboard、焦点恢复、下载/错误状态、删除后的重装、候选更新不影响正在运行的模型。若采纳 C14 更新字段分离，同步修改 Update 按钮显示条件。

**问题 F28（确定，切模式没有通知请求链）：** 设置 setter 只改 state，`pv-app.ts` 没有订阅 mode 变化来取消旧任务；切换期间 debounce 中的旧 Cloud 请求可能仍发出，因为 pre-dispatch Gate 2 只比较 requestId。建议设置事件在 state 变更后同步通知 app 取消，并在 dispatch 前双重检查：

```ts
// onInferenceModeChange 中：
this.state.inferenceMode = mode;
this.dispatchEvent(new CustomEvent('inference-mode-change', {
  bubbles: true, composed: true, detail: {mode},
}));
// app handler 先 clearTimeout、递增 requestId、providers.abort，再按需刷新。
// updateSuggestions 的定时回调入口：
if (requestId !== this.suggestionRequestId || mode !== this.stateInternal.inferenceMode) return;
```

测试 Cloud debounce 已排队时切 Local，即使没有继续打字也不得 dispatch 旧 Cloud 请求。

**问题 F29（确定，未捕获 UI 异步失败）：** `onUnloadClick()`、`onInferenceModeChange()` 的 startup、`executeRemoveModel()` 没有完整 error UI；删除先关闭确认框再执行可能丢失失败反馈。采用与 download 一致的 try/catch，在删除成功后关窗，失败展示 error。还应防止操作重复点击和忙时更新检查。

### C18 — Debug 本地模型导入

**目标：** 在 feature flag 允许时，导入用户指定 `.litertlm` 到 OPFS，记录来源并通过加载/smoke 激活。

**核心文件/函数：** `model-importer.ts.importLocalModel()`、`ModelImporterContext`；`model-manager.ts.importLocalModel()` 及对应 import；卡片 `triggerFileImport()`、`onFileImportChange()`、隐藏 input 和 debug 按钮；对应日文 trans-unit。

**问题 F30（确定，首次导入无法激活）：** importer 写盘/metadata 后直接 `activateCandidate()`；manager 从初始 not_downloaded 直接转 loading，C13 的合法状态集合不允许，且这个 transition 在 try 外。ready 下直接导入也存在同样问题。应由 manager 显式进入导入/加载流程，先释放旧 runtime，保留旧 active 身份直至成功；最小首次导入处理：

```ts
// 文件与 metadata 已落盘之后，manager 的 activation callback 内：
if (this.getState() === 'not_downloaded') this.transitionTo('downloaded');
await this.activateCandidate(manifest);
```

这段仅修首次路径；ready→导入、失败恢复必须用 C14 候选安装流程处理，不能随意放开所有状态转换。

**问题 F31（确定，失败反馈/残留不完整）：** `activateCandidate()` catch 后只设置 error 不 reject，importer 仍返回成功；导入无 quota/preflight、无 lock，失败后可遗留 partial/final，时间戳 version 也可能碰撞。建议使用 UUID 版本、同模型写锁、阶段化清理并向调用者传播错误：

```ts
const version = `v-${crypto.randomUUID()}`;
try {
  // 在能力/容量预检和锁内执行 copy、save、activate。
} catch (error) {
  await storage.deletePartial(modelId, version);
  // 仅清理未激活 candidate；不要删除旧 active/LKG。
  throw error;
}
```

“计算过 SHA”只能证明复制一致，不能证明发行方认证。保留 `importStatus: 'unverified_import'`；把 generation 0 隔离为本地来源类型，禁止进入 GCS 签名下载路径。

**测试：** 新增首次导入、ready 时换入、扩展名大小写、空文件、容量不足、load/smoke reject、取消/残留清理、来源标签。当前 staged 没有专门 importer 测试，需在采纳此计划时补到 manager/卡片测试，不能宣称已覆盖。

### C19 — 本地诊断导出和资源面板

**目标：** 导出模型/存储状态和受控错误信息，资源面板仅在展开时轮询。

**核心文件/函数：** `diagnostics-exporter.ts` 的 report type、`sanitizeDiagnosticText()`、`exportPrivacySafeDiagnostics()`、`downloadDiagnosticsReport()`；manager 的 `StateTransitionRecord`、transition history（最多 50）和 getter；卡片的 metrics、memory、timer、`onDiagnosticsToggle()`、`onExportDiagnosticsClick()` 和 details render；相应 XLIFF 文案。

**测试：** `test_diagnostics-exporter.ts`；卡片 disconnect 清 timer、关闭 details 停轮询、导出确实只本地下载；可选 memory API 缺失时显示 unavailable。

**问题 F32（确定，隐私声明强于实际过滤）：** 导出把 arbitrary runtime error.message 经过 URL/token 正则后纳入报告，同时固定声明 userText/persona/history 不包含。普通用户文本如 `Generation failed for prompt: 私密内容` 不会被这些正则消除。建议使用 error code 的固定描述，导出不带原始自由文本：

```ts
lastError: {
  code: rawError?.code ?? null,
  sanitizedMessage: rawError ? 'See the local UI for error details.' : null,
},
```

更完整实现可用 errorCode→固定消息白名单。测试注入普通私密文本、persona、无 query URL 和 token 多种格式，检查整个序列化报告；不能仅检查那几个固定 false 字段。

**完善建议 F33：** `recordRuntimeMetrics()` 以 totalMs 不同判断“新样本”，同延迟的两次生成被合并；两秒采样又可能跳过多次生成。由 runtime 暴露 generation ID/完成时间或完成事件后记录：

```ts
if (metrics.generationId === this.lastRecordedGenerationId) return;
this.lastRecordedGenerationId = metrics.generationId;
```

这是建议新增字段，需同步 runtime/fake/protocol；没有它时面板应描述为“最近采样平均值”，不能暗示覆盖所有请求。

### C20 — 隐私回归、发布证据与最终资源一致性

**目标：** 对完成后的链路建立回归和发布证据入口，清楚分开 fake 测试与真机实测。

**核心文件/函数：** `test_local-inference-privacy.ts`、`test_local-inference-regressions.ts` 全部；`tools/verify-local-inference-privacy.mjs`、`tools/verify-on-device-compatibility.mjs`、`tools/verify-on-device-soak.mjs`、`tools/test-on-device-boundary.mjs`。`package.json` 对应 scripts 与 lint/fix Python tests glob；`test_index.ts` 完成剩余 import。`xliff/ja.xlf` 剩余历史文案整理，包括 French/German/Swedish/Mandarin 标签、旧 Initial phrases 移除；旧 AI 文案移除随 C17。

**问题 F34（已运行复现，默认 test 必失败）：** `npm test` 使用 `concurrently "npm:test:*"`，新增 `test:on-device-soak` 无参数必抛 BLOCKED，`test:on-device-boundary` 也因 `.gcloudignore` 缺失预期规则失败。正常 CI 不应隐式要求真实设备报告，明确列出测试命令，把 release evidence gate 留在单独入口：

```json
{
  "test": "concurrently \"npm:test:js\" \"npm:test:py\" \"npm:test:prompt-parity\" \"npm:test:on-device-boundary\"",
  "verify:on-device-soak": "node tools/verify-on-device-soak.mjs"
}
```

**问题 F35（已运行复现，遗漏文件/错误边界）：** boundary 脚本要求 `.gcloudignore` 排除 `/static/vendor/litert-lm/` 和根 Wasm，但 C12 生产 Worker 正需要它们。当前 `.gcloudignore` 完全没有这组规则；直接补全脚本要求会导致部署丢运行时。建议检查“排除 M0 harness，包含 production runtime”，例如：

```js
for (const requiredAsset of [
  'static/inference-worker.js',
  'static/vendor/litert-lm/wasm',
]) {
  await access(requiredAsset); // 构建后的产物检查；部署清单还需单独验证。
}
// 禁止 M0 路径进入 deploy；不能要求忽略生产 vendor 目录。
```

`.gcloudignore` 不是本批 staged 文件；若采纳建议，需要作为明确的新增修改纳入 C20。构建前静态边界检查与构建后资源检查分开，避免无产物的 unit CI 误失败。

`verify-on-device-compatibility.mjs` 固定读取 `docs/on-device/compatibility.json`，此文件也不在 HEAD/index。需增加真实的矩阵规范或支持显式 matrix 参数；缺矩阵应清晰报告未配置，不能伪造证据。

**问题 F36（确定，报告验证可被缺字段绕过）：** compatibility 的延迟只用 `> 2`/`> 5`，缺失字段为 undefined 时比较为 false，可能通过；soak 缺失 durationMinutes/reloadCycles 时 `<` 比较也为 false。所有数值先校验类型、finite、非负，再比较门槛：

```js
function requireFiniteNumber(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`Invalid evidence: ${name}`);
  }
  return value;
}
if (requireFiniteNumber(result.durationMinutes, 'durationMinutes') < 30) {
  throw new Error('Soak duration must be at least 30 minutes');
}
```

增加缺字段、null、字符串数值、负值和错误 runtime/model 测试；soak 的 runtime/model 不能仅检查非空，应与冻结矩阵的 tuple 比较。

**测试完善 F37：** privacy suite 只 spy 页面 `window.fetch`，未真正挂载 app，不能覆盖 connectedCallback 的 flags 请求、真实 Worker 网络、XHR/beacon 等；“reload”案例对同一个 ready manager 再调 startup，会立即 return。改用新的 manager/client 和保留的存储实例，挂载 app 并分别断言“允许的元数据请求”和“禁止的用户文本请求”：

```ts
const restarted = new ModelManager({metadataStore, storage, apiClient,
  runtimeAdapter: new FakeModelRuntimeAdapter(), tabCoordinator});
await restarted.startup(true);
expect(apiClient.getSignedDownloadUrl).not.toHaveBeenCalled();
```

这里 apiClient 必须使用 spy 方法；真实 browser/network audit 另行验证 Worker 请求，静态字符串检查仅作快速提示。合成性能测试不代表 30 分钟 soak 或 macOS/Windows/Linux 平台通过，保持当前工具对 real-device evidence 的明确要求。

## 4. 共享文件的 hunk 归属（实施时核对）

| 文件 | 分配 |
|---|---|
| `main.py` | C04 session/headers/M0；C05 Root 授权、catalog API/limiter 配置；C16 features endpoint |
| `pyproject.toml` | C04 删除 CORS 依赖；C05 加 storage 依赖 |
| `package.json` | C02 Jinja/parity/pretest；C06 GCS scripts；C12 runtime/build；C20 release/test/lint/fix scripts |
| `package-lock.json` | C12 全部 |
| `src/pv-app.ts` | C15 构造/provider/updateSuggestions/cache；C16 flags/startup；C17 settings 接线和空行整理 |
| `src/pv-setting-panel.ts` | C17 全部；C18/C19 卡片内部扩展无需重复搬父层属性 |
| `src/on-device/model-manager.ts` | C13 核心；C14 update/check/rollback/cleanup/remove；C18 importer；C19 history。公共 getter/订阅放 C13 |
| `src/pv-on-device-model-card.ts` | C17 主体和生命周期；C18 import 入口；C19 diagnostics 导入/属性/handler/模板/CSS |
| `src/tests/test_index.ts` | 各测试落地当次注册；C20 核对最终 17 项全部存在 |
| `src/tests/test_suggestion-providers.ts` | C01 Cloud/router；C02 renderer/parser/mock 案例 |
| `src/tests/test_inference-runtime.ts` | C10 protocol/fake；C12 WorkerClient；C15 LocalProvider |
| `src/tests/test_model-manager.ts` | C11 downloader 直接合同（需提取调用）；C13 编排主路径；C14 更新回滚移除 |
| `src/tests/test_model-failure-recovery.ts` | C14 下载/更新/存储；C15 Local/runtime failure |
| `tests/test_model_catalog.py` | C03 schema；C05 catalog/API/fixtures；不得提前 import main |
| `xliff/ja.xlf` | C17 生命周期/设置；C18 导入；C19 诊断；C20 其余历史翻译整理 |

共享文件的 import、字段初始化、类型和 helper 跟首次使用者走，删除未使用 import 也归同次修改。C13 manager 构造依赖 C11 downloader/C12 runtime，但 C10 的接口和 fake 不反向依赖 manager；因此依赖无环。

## 5. 本次检查证据与未来验收

首次计划编写时进行了 index/HEAD 和源码、测试、构建脚本的静态检查，并运行了不依赖项目安装的只读检查。下表的工具名已按命名整理后的路径列出；首次运行时使用旧名称，重命名未修复这些既有问题：

| 检查 | 本次结果 | 对应处理 |
|---|---|---|
| `node tools/test-on-device-boundary.mjs` | 失败：`.gcloudignore must exclude /tools/m0-harness` | C20 修正部署边界断言及缺失配置 |
| `node tools/verify-on-device-compatibility.mjs` | 失败：缺少 `docs/on-device/compatibility.json` | C20 补矩阵输入合同 |
| `node tools/verify-on-device-soak.mjs` | 按设计 BLOCKED：无真实结果路径 | C20 从默认 unit test 分离 |
| `node tools/verify-local-inference-privacy.mjs` | 通过静态字符串检查 | 不等同真实网络验证 |
| 直接执行 `_is_safe_cors_origin()` 的抽取纯函数 | 尾部换行 origin 被接受 | C06 F05 |
| 直接执行 `SlidingWindowRateLimiter` | 旧 key 到期后仍保留 | C04 F02 |

工作区没有 `node_modules` 和 `.venv`，因此没有安装依赖，也没有完成 tsc、pytest、Jasmine、完整 build 或真实 WebGPU/GCS 验证。曾尝试检查本地 tsc 可用性，因依赖缺失未能执行；F23 来自源码结构检查，不冒称编译器已报错。以上失败没有触发任何业务代码修改。

未来实际拆分时，每个前缀提交都至少通过相关编译/领域测试；依赖安装后使用仓库标准 `uv` Python 环境。C15 先修语法，否则所有导入 app 的浏览器 suite 都无法构建。最后完整验收：

1. `npm run lint:js`、`npm run test:js`、`npm run test:py`、prompt parity、GCS policy；修正 C20 聚合后再用 `npm test`。
2. clean checkout 上 `npm i && npm run dev` 可提供 index、inference/hash worker 和生产 Wasm；`npm run build` 与 App Engine 部署清单一致。
3. 同源真实 CSP 下完成安装/校验/load/smoke/输入、取消和 reload；更新失败可继续用旧模型，发现更新不会停推理。
4. 两 tab 下载竞争、暂停等待锁、IndexedDB abort/blocked、OPFS quota/删除失败、有 LKG 和无 LKG 的移除重装。
5. 挂载 app 的 Local 隐私回归；已安装 Local 在 flags disabled/error/offline 下仍不回落 Cloud；切模式后旧 Cloud debounce 不再发出。
6. 使用真实部署凭据的 GCS live 验证，以及有平台/runtime/model 身份的真实 30 分钟 soak 和 compatibility 报告。证据缺失必须保留为未验证，不能用 synthetic suite 填补。

首次交付只有计划；后续命名整理已实施第 1 节列出的文件改名及相关引用更新。以上 F01–F37 的修复、新测试和新增辅助文件仍是建议在未来拆分实施时纳入对应 commit 的工作。
