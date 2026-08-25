# cc-web

给 Claude Code 做的本地 web UI：服务器把 headless `claude` 子进程当引擎，
浏览器只渲染。这份词表定义两边共用的名词，只放定义，不放实现。

## 语言

**Session**：
一段与 Claude Code 的对话，以 CC 分配的 uuid 为身份，落盘为一个 jsonl 文件。
_Avoid_：conversation、chat、会话记录

**Engine**：
为一个 session 服务的 headless `claude` 子进程，一个 session 至多一个。
_Avoid_：runtime、worker、CC 进程

**Turn**：
从用户发出一句提示词到引擎给出 result 为止的一个回合，可能被中断。
_Avoid_：round、exchange

**Live turn**：
正在进行中的那个 turn——服务器只为它持有状态，结束即清空。
_Avoid_：current turn、streaming state

**Message**：
服务器归一化后给浏览器的一条消息：有稳定的 key，role 只有 user / assistant 两种，
内容是一串 block。历史和实时是同一个形状。
_Avoid_：帧 / frame（那是引擎的原始输出）、ChatMsg、record、entry

**Block**：
Message 内容的一个单元：text、thinking、image 或 tool_use。tool_use 自带执行状态和结果。
_Avoid_：segment、content part、tool_result（结果折在 tool_use 里，不是独立单元）

**Placeholder**：
引擎还在生成时，服务器提前发出的一条 partial Message，之后被最终 Message 替换。
_Avoid_：stream buffer、partial frame、draft message

**Delta**：
落在某个 placeholder 上的一段增量，是 text / thinking / tool_input 之一。
_Avoid_：stream event、chunk（只作字段名）

**Sidechain**：
subagent（Task 等工具）产生的消息链，锚定在主线的某个 tool_use 上，不进主线。
_Avoid_：subagent 消息、子对话、branch

**Approval**：
引擎反向发起的工具使用许可请求，必须在超时前得到 allow / deny 之一。
_Avoid_：permission、confirm dialog、can_use_tool（那是协议里的名字）

**Frame**：
引擎 stdin / stdout 上的一行 NDJSON，CC 的原始输入输出。只有 `src/engine` 见到它。
_Avoid_：message（那是归一化后的）、packet、raw event

**Turn event**：
引擎交给服务器的一帧：stdout 上除控制帧以外的一切（system / stream_event /
assistant / user / result …），类型从 SDK 的 SDKMessage 派生。
_Avoid_：raw frame、stdout message、engine message

**Control request**：
我们与引擎之间有应答的请求（set_model / list_models / get_usage …），
由引擎配对 request_id 并在首次请求前完成 initialize 握手。
_Avoid_：command、RPC、控制帧（那是信封）

**History**：
从 session 的 jsonl 读出并归一化成 Message 的过去消息，按 cursor 分页。
_Avoid_：transcript、log、记录
