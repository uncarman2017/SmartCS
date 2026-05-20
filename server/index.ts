import express from "express";
import { query, unstable_v2_createSession, unstable_v2_authenticate, PermissionResult, CanUseTool } from "@tencent-ai/agent-sdk";
import { v4 as uuidv4 } from "uuid";
import path from "path";
import { fileURLToPath } from "url";
import { exec } from "child_process";
import { promisify } from "util";
import * as db from "./db.js";
import { createFaqSeedData } from "./faq-seed.js";

const execAsync = promisify(exec);

// 初始化 FAQ 种子数据（需在 DB ready 后调用）
function initFaqData() {
  const existing = db.getAllFaq();
  if (existing.length === 0) {
    const seedData = createFaqSeedData();
    db.batchInsertFaq(seedData);
    console.log(`[FAQ] 已初始化 ${seedData.length} 条 FAQ 知识`);
  } else {
    console.log(`[FAQ] 已有 ${existing.length} 条 FAQ 记录`);
  }
}

// 意图关键词映射（用于辅助识别）
const INTENT_KEYWORDS: Record<string, { keywords: string[]; label: string }> = {
  refund: {
    keywords: ['退款', '退货', '退钱', '退单', '仅退款', '退运费', '退款申请', '退款被拒'],
    label: '退款/退货咨询'
  },
  order_inquiry: {
    keywords: ['订单', '物流', '快递', '发货', '查单', '取消订单', '修改地址', '我的订单', '到哪了', '运单号'],
    label: '订单查询'
  },
  tech_support: {
    keywords: ['闪退', '打不开', '登录', '密码', '验证码', '支付失败', '白屏', '卡顿', '崩溃', '加载', '网络错误', '报错'],
    label: '技术支持'
  },
};

// 简单意图识别函数（关键词匹配）
function detectIntent(message: string): { intent: string; confidence: number } {
  const text = message.toLowerCase();
  let bestIntent = 'general';
  let maxMatches = 0;

  for (const [intent, config] of Object.entries(INTENT_KEYWORDS)) {
    const matches = config.keywords.filter(kw => text.includes(kw)).length;
    if (matches > maxMatches) {
      maxMatches = matches;
      bestIntent = intent;
    }
  }

  // 检测转人工意图
  const transferKeywords = ['转人工', '人工客服', '人工', '找客服', '联系客服', '真人'];
  if (transferKeywords.some(kw => text.includes(kw))) {
    return { intent: 'transfer_to_human', confidence: 0.95 };
  }

  const confidence = maxMatches > 0 ? Math.min(maxMatches / 3, 0.95) : 0.3;
  return { intent: bestIntent, confidence };
}

// FAQ 检索函数
function searchRelevantFaq(message: string): db.DbFaqItem[] {
  const text = message.toLowerCase();

  // 提取可能的搜索词
  const searchTerms: string[] = [];
  for (const config of Object.values(INTENT_KEYWORDS)) {
    for (const kw of config.keywords) {
      if (text.includes(kw)) {
        searchTerms.push(kw);
      }
    }
  }

  let allResults: db.DbFaqItem[] = [];

  if (searchTerms.length > 0) {
    // 用每个匹配关键词搜索
    for (const term of searchTerms.slice(0, 3)) {
      const results = db.searchFaq(term);
      allResults.push(...results);
    }
  } else {
    // 全量检索整个消息
    allResults = db.searchFaq(message);
  }

  // 去重并排序（按优先级）
  const seen = new Set<string>();
  const unique = allResults
    .filter(item => {
      if (seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    })
    .sort((a, b) => b.priority - a.priority)
    .slice(0, 5);

  return unique;
}

// 构建智能客服系统提示词
function buildSystemPrompt(faqContext: db.DbFaqItem[] | null): string {
  let prompt = `# 角色定义
你是「SmartCS」智能客服助手，服务于某电商平台。你的职责是帮助用户解决退款、订单查询、技术支持等各类问题。

# 核心规则
1. **始终礼貌、专业、有同理心**，使用"您"而非"你"
2. **先识别意图再回复**：判断用户意图（退款/订单查询/技术支持/转人工/其他）
3. **需要更多信息时主动询问**：如退款需要订单号、技术支持需要设备型号
4. **不编造信息**：不确定时诚实告知，引导用户联系人工
5. **简洁高效**：回复直接给出解决方案，避免冗长引导

# 意图识别
- refund: 退款、退货相关问题
- order_inquiry: 订单状态、物流查询
- tech_support: App闪退、登录失败、支付异常等技术问题
- transfer_to_human: 用户明确要求转人工
- general: 其他一般问题

# 转人工规则
以下情况建议转人工：
- 用户明确说"转人工""人工客服""找真人"
- 连续 3 轮对话仍无法解决问题
- 涉及账户安全、资金异常等敏感操作
- 你的知识库无法覆盖的问题
`;

  // 注入 FAQ 上下文
  if (faqContext && faqContext.length > 0) {
    prompt += `\n# 相关知识库（请参考以下 FAQ 回答问题）

`;
    for (const faq of faqContext) {
      const categoryLabel = {
        'refund': '[退款]',
        'order_inquiry': '[订单]',
        'tech_support': '[技术]',
        'general': '[通用]',
      }[faq.category] || '';
      prompt += `## ${categoryLabel} ${faq.question}
${faq.answer}

`;
    }
    prompt += `---\n请基于上述知识库内容回答用户问题。如果知识库无法完全覆盖用户的问题，请告知用户并建议转人工。\n`;
  } else {
    prompt += `\n# 当前状态
未检索到匹配的知识库条目。请根据你的通用知识回答用户问题。如果无法确定答案，建议用户转人工。\n`;
  }

  return prompt;
}

// 待处理的权限请求
interface PendingPermission {
  resolve: (result: PermissionResult) => void;
  reject: (error: Error) => void;
  toolName: string;
  input: Record<string, unknown>;
  sessionId: string;
  timestamp: number;
}

const pendingPermissions = new Map<string, PendingPermission>();
const PERMISSION_TIMEOUT = 5 * 60 * 1000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());

// 缓存可用模型列表
let cachedModels: Array<{ modelId: string; name: string; description?: string }> = [];
const defaultModel = "claude-sonnet-4";

// 健康检查
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString(), name: "SmartCS Agent" });
});

// 登录方式类型
type LoginMethod = 'env' | 'cli' | 'none';

interface LoginStatusResponse {
  isLoggedIn: boolean;
  method?: LoginMethod;
  envConfigured?: boolean;
  cliConfigured?: boolean;
  error?: string;
  apiKey?: string;
  envVars?: {
    apiKey?: string;
    authToken?: string;
    internetEnv?: string;
    baseUrl?: string;
  };
}

// 检查 CodeBuddy CLI 登录状态
app.get("/api/check-login", async (req, res) => {
  const response: LoginStatusResponse = {
    isLoggedIn: false,
    envConfigured: false,
    cliConfigured: false,
    envVars: {},
  };

  const apiKey = process.env.CODEBUDDY_API_KEY;
  const authToken = process.env.CODEBUDDY_AUTH_TOKEN;
  const internetEnv = process.env.CODEBUDDY_INTERNET_ENVIRONMENT;
  const baseUrl = process.env.CODEBUDDY_BASE_URL;

  if (apiKey || authToken) {
    response.envConfigured = true;
    if (apiKey) {
      response.envVars!.apiKey = apiKey.slice(0, 8) + '****' + apiKey.slice(-4);
      response.apiKey = response.envVars!.apiKey;
    }
    if (authToken) {
      response.envVars!.authToken = authToken.slice(0, 8) + '****' + authToken.slice(-4);
    }
    if (internetEnv) {
      response.envVars!.internetEnv = internetEnv;
    }
    if (baseUrl) {
      response.envVars!.baseUrl = baseUrl;
    }
  }

  try {
    let needsLogin = false;
    const result = await unstable_v2_authenticate({
      environment: 'external',
      onAuthUrl: async (authState) => {
        needsLogin = true;
        console.log('[Check Login] 需要登录，认证 URL:', authState.authUrl);
        response.error = '未登录，请先登录 CodeBuddy CLI';
      }
    });

    if (!needsLogin && result?.userinfo) {
      response.isLoggedIn = true;
      response.cliConfigured = true;
      response.method = response.envConfigured ? 'env' : 'cli';
      console.log('[Check Login] 已登录用户:', result.userinfo.userName);
    } else if (!needsLogin) {
      response.isLoggedIn = true;
      response.cliConfigured = true;
      response.method = response.envConfigured ? 'env' : 'cli';
    }
  } catch (error: any) {
    console.error("[Check Login] SDK Error:", error);
    if (response.envConfigured) {
      response.isLoggedIn = true;
      response.method = 'env';
    } else {
      response.error = error?.message || String(error);
      response.method = 'none';
    }
  }

  res.json(response);
});

// 保存环境变量配置
app.post("/api/save-env-config", (req, res) => {
  const { apiKey, authToken, internetEnv, baseUrl } = req.body;

  if (!apiKey && !authToken) {
    return res.status(400).json({ error: '请至少配置 API Key 或 Auth Token' });
  }

  const configuredVars: string[] = [];

  if (apiKey) {
    process.env.CODEBUDDY_API_KEY = apiKey;
    configuredVars.push('CODEBUDDY_API_KEY');
  }
  if (authToken) {
    process.env.CODEBUDDY_AUTH_TOKEN = authToken;
    configuredVars.push('CODEBUDDY_AUTH_TOKEN');
  }
  if (internetEnv) {
    process.env.CODEBUDDY_INTERNET_ENVIRONMENT = internetEnv;
    configuredVars.push('CODEBUDDY_INTERNET_ENVIRONMENT');
  }
  if (baseUrl) {
    process.env.CODEBUDDY_BASE_URL = baseUrl;
    configuredVars.push('CODEBUDDY_BASE_URL');
  }

  cachedModels = [];

  res.json({
    success: true,
    message: `已设置: ${configuredVars.join(', ')}`,
    note: '环境变量仅在当前服务器进程有效，重启后需要重新设置'
  });
});

// 获取可用模型列表
app.get("/api/models", async (req, res) => {
  try {
    if (cachedModels.length === 0) {
      console.log("[Models] Creating session to fetch available models...");
      const session = await unstable_v2_createSession({ cwd: process.cwd() });
      console.log("[Models] Session created, calling getAvailableModels()...");
      const models = await session.getAvailableModels();
      console.log("[Models] Got", models.length, "models");
      if (models && Array.isArray(models)) {
        cachedModels = models;
      }
    }

    res.json({
      models: cachedModels.length > 0 ? cachedModels : [
        { modelId: "claude-sonnet-4", name: "Claude Sonnet 4" }
      ],
      defaultModel
    });
  } catch (error: any) {
    console.error("[Models] Error:", error);
    res.json({
      models: [
        { modelId: "claude-sonnet-4", name: "Claude Sonnet 4" },
        { modelId: "claude-opus-4", name: "Claude Opus 4" }
      ],
      defaultModel,
      error: error?.message || String(error)
    });
  }
});

// ============= 会话 API =============

app.get("/api/sessions", (req, res) => {
  try {
    const sessions = db.getAllSessions();
    const sessionsWithMessages = sessions.map(session => {
      const messages = db.getMessagesBySession(session.id);
      return {
        ...session,
        messageCount: messages.length
      };
    });
    res.json({ sessions: sessionsWithMessages });
  } catch (error: any) {
    console.error("[Sessions] Error:", error);
    res.status(500).json({ error: error?.message || "获取会话失败" });
  }
});

app.get("/api/sessions/:sessionId", (req, res) => {
  try {
    const { sessionId } = req.params;
    const session = db.getSession(sessionId);

    if (!session) {
      return res.status(404).json({ error: "会话不存在" });
    }

    const messages = db.getMessagesBySession(sessionId);
    const parsedMessages = messages.map(msg => ({
      ...msg,
      tool_calls: msg.tool_calls ? JSON.parse(msg.tool_calls) : null
    }));

    // 获取会话的满意度评分
    const ratings = db.getRatingsBySession(sessionId);
    // 获取意图
    const intents = db.getIntentsBySession(sessionId);

    res.json({ session, messages: parsedMessages, ratings, intents });
  } catch (error: any) {
    console.error("[Session] Error:", error);
    res.status(500).json({ error: error?.message || "获取会话失败" });
  }
});

app.post("/api/sessions", (req, res) => {
  try {
    const { model = defaultModel, title = "新对话" } = req.body;
    const now = new Date().toISOString();

    const session = db.createSession({
      id: uuidv4(),
      title,
      model,
      sdk_session_id: null,
      status: 'active',
      created_at: now,
      updated_at: now
    });

    res.json({ session });
  } catch (error: any) {
    console.error("[Create Session] Error:", error);
    res.status(500).json({ error: error?.message || "创建会话失败" });
  }
});

app.patch("/api/sessions/:sessionId", (req, res) => {
  try {
    const { sessionId } = req.params;
    const { title, model, status } = req.body;

    const success = db.updateSession(sessionId, { title, model, status });

    if (!success) {
      return res.status(404).json({ error: "会话不存在" });
    }

    res.json({ success: true });
  } catch (error: any) {
    console.error("[Update Session] Error:", error);
    res.status(500).json({ error: error?.message || "更新会话失败" });
  }
});

app.delete("/api/sessions/:sessionId", (req, res) => {
  try {
    const { sessionId } = req.params;
    const success = db.deleteSession(sessionId);

    if (!success) {
      return res.status(404).json({ error: "会话不存在" });
    }

    res.json({ success: true });
  } catch (error: any) {
    console.error("[Delete Session] Error:", error);
    res.status(500).json({ error: error?.message || "删除会话失败" });
  }
});

// ============= FAQ API =============

// 获取全部 FAQ
app.get("/api/faq", (req, res) => {
  try {
    const { category } = req.query;
    let faqs: db.DbFaqItem[];

    if (category && typeof category === 'string') {
      faqs = db.getFaqByCategory(category);
    } else {
      faqs = db.getAllFaq();
    }

    res.json({ faqs });
  } catch (error: any) {
    console.error("[FAQ] Error:", error);
    res.status(500).json({ error: error?.message || "获取FAQ失败" });
  }
});

// 搜索 FAQ
app.post("/api/faq/search", (req, res) => {
  try {
    const { keyword } = req.body;
    if (!keyword) {
      return res.status(400).json({ error: "搜索关键词不能为空" });
    }
    const results = db.searchFaq(keyword);
    res.json({ results });
  } catch (error: any) {
    console.error("[FAQ Search] Error:", error);
    res.status(500).json({ error: error?.message || "搜索FAQ失败" });
  }
});

// ============= 意图识别 API =============

app.post("/api/intent/detect", (req, res) => {
  try {
    const { message } = req.body;
    if (!message) {
      return res.status(400).json({ error: "消息不能为空" });
    }
    const intent = detectIntent(message);
    res.json(intent);
  } catch (error: any) {
    console.error("[Intent] Error:", error);
    res.status(500).json({ error: error?.message || "意图识别失败" });
  }
});

// ============= 满意度评分 API =============

app.post("/api/satisfaction", (req, res) => {
  try {
    const { messageId, sessionId, score, comment } = req.body;

    if (!messageId || !sessionId || !score) {
      return res.status(400).json({ error: "缺少必要参数" });
    }

    if (score < 1 || score > 5) {
      return res.status(400).json({ error: "评分范围为1-5" });
    }

    const rating = db.createSatisfactionRating({
      id: uuidv4(),
      message_id: messageId,
      session_id: sessionId,
      score,
      comment: comment || null,
      created_at: new Date().toISOString(),
    });

    res.json({ success: true, rating });
  } catch (error: any) {
    console.error("[Satisfaction] Error:", error);
    res.status(500).json({ error: error?.message || "保存评分失败" });
  }
});

// ============= 转人工 API =============

app.post("/api/transfer-human", (req, res) => {
  try {
    const { sessionId, reason } = req.body;

    if (!sessionId) {
      return res.status(400).json({ error: "缺少会话ID" });
    }

    db.updateSession(sessionId, { status: 'transferred' });

    // 添加系统消息记录
    db.createMessage({
      id: uuidv4(),
      session_id: sessionId,
      role: 'system',
      content: `会话已转人工处理。原因：${reason || '用户请求'}`,
      model: null,
      created_at: new Date().toISOString(),
      tool_calls: null,
    });

    res.json({
      success: true,
      message: '已转接人工客服，请等待人工客服接入...',
      session_id: sessionId
    });
  } catch (error: any) {
    console.error("[Transfer] Error:", error);
    res.status(500).json({ error: error?.message || "转人工失败" });
  }
});

// ============= 管理后台 API =============

// 管理后台概览数据
app.get("/api/admin/overview", (req, res) => {
  try {
    const overview = db.getAdminOverview();
    const intentDist = db.getIntentDistribution();
    const satisfactionStats = db.getSatisfactionStats();
    const trend = db.getDailySatisfactionTrend(30);

    res.json({
      overview,
      intent_distribution: intentDist,
      satisfaction_stats: satisfactionStats,
      satisfaction_trend: trend,
    });
  } catch (error: any) {
    console.error("[Admin Overview] Error:", error);
    res.status(500).json({ error: error?.message || "获取概览数据失败" });
  }
});

// 管理后台对话记录
app.get("/api/admin/conversations", (req, res) => {
  try {
    const limit = parseInt(req.query.limit as string) || 50;
    const offset = parseInt(req.query.offset as string) || 0;
    const status = req.query.status as string;

    let conversations = db.getRecentConversations(limit, offset);

    // 按状态筛选
    if (status) {
      conversations = conversations.filter(c => c.status === status);
    }

    // 总共的对话数
    const totalCount = db.getAllSessions().length;

    res.json({
      conversations,
      total: totalCount,
      limit,
      offset,
    });
  } catch (error: any) {
    console.error("[Admin Conversations] Error:", error);
    res.status(500).json({ error: error?.message || "获取对话记录失败" });
  }
});

// ============= 权限响应 API =============

app.post("/api/permission-response", (req, res) => {
  const { requestId, behavior, message } = req.body;

  console.log(`[Permission] Response received: requestId=${requestId}, behavior=${behavior}`);

  const pending = pendingPermissions.get(requestId);
  if (!pending) {
    console.log(`[Permission] Request not found: ${requestId}`);
    return res.status(404).json({ error: "权限请求不存在或已超时" });
  }

  pendingPermissions.delete(requestId);

  if (behavior === 'allow') {
    pending.resolve({
      behavior: 'allow',
      updatedInput: pending.input
    });
  } else {
    pending.resolve({
      behavior: 'deny',
      message: message || '用户拒绝了此操作'
    });
  }

  res.json({ success: true });
});

// ============= 聊天 API =============

app.post("/api/chat", async (req, res) => {
  const { sessionId, message, model, systemPrompt, cwd, permissionMode } = req.body;

  console.log(`\n[Chat] ========== 新请求 ==========`);
  console.log(`[Chat] SessionId: ${sessionId}`);
  console.log(`[Chat] Model: ${model}`);
  console.log(`[Chat] Message: ${message?.slice(0, 100)}${message?.length > 100 ? '...' : ''}`);

  if (!message) {
    console.log(`[Chat] 错误: 消息为空`);
    return res.status(400).json({ error: "消息不能为空" });
  }

  // === 意图识别 ===
  const intent = detectIntent(message);
  console.log(`[Chat] 意图识别: ${intent.intent} (置信度: ${intent.confidence})`);

  // === FAQ 检索 ===
  let faqResults: db.DbFaqItem[] = [];
  if (intent.intent !== 'transfer_to_human') {
    faqResults = searchRelevantFaq(message);
    console.log(`[Chat] FAQ 检索: 找到 ${faqResults.length} 条相关条目`);
  }

  // === 构建系统提示词 ===
  const dynamicSystemPrompt = systemPrompt || buildSystemPrompt(
    faqResults.length > 0 ? faqResults : null
  );

  // 获取或创建会话
  let session = sessionId ? db.getSession(sessionId) : null;
  const now = new Date().toISOString();

  if (!session) {
    console.log(`[Chat] 创建新会话`);
    session = db.createSession({
      id: sessionId || uuidv4(),
      title: message.slice(0, 30) + (message.length > 30 ? '...' : ''),
      model: model || defaultModel,
      sdk_session_id: null,
      status: 'active',
      created_at: now,
      updated_at: now
    });
  } else {
    console.log(`[Chat] 使用现有会话, SDK Session: ${session.sdk_session_id || 'none'}, Status: ${session.status}`);
  }

  // 记录意图
  db.createConversationIntent({
    id: uuidv4(),
    session_id: session.id,
    message_id: null,
    intent: intent.intent,
    confidence: intent.confidence,
    created_at: now,
  });

  const selectedModel = model || session.model;
  const sdkSessionId = session.sdk_session_id;

  const userMessageId = uuidv4();
  const assistantMessageId = uuidv4();

  // 保存用户消息
  try {
    db.createMessage({
      id: userMessageId,
      session_id: session.id,
      role: 'user',
      content: message,
      model: null,
      created_at: now,
      tool_calls: null
    });
    console.log(`[Chat] 用户消息已保存: ${userMessageId}`);
  } catch (dbError: any) {
    console.error(`[Chat] 保存用户消息失败:`, dbError);
    return res.status(500).json({ error: "保存消息失败", detail: dbError?.message });
  }

  // 更新意图表的 message_id
  db.updateLatestIntentMessageId(session.id, userMessageId);

  // 设置 SSE 头
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const workingDir = cwd || process.cwd();

  try {
    console.log(`[Chat] 调用 SDK query...`);
    console.log(`[Chat] - Model: ${selectedModel}`);
    console.log(`[Chat] - Intent: ${intent.intent}`);
    console.log(`[Chat] - FAQ: ${faqResults.length} 条`);

    const canUseTool: CanUseTool = async (toolName, input, options) => {
      console.log(`[Permission] Tool request: ${toolName}`);

      if (permissionMode === 'bypassPermissions') {
        console.log(`[Permission] Bypassing permissions for ${toolName}`);
        return { behavior: 'allow', updatedInput: input };
      }

      const requestId = uuidv4();
      const permissionRequest = {
        requestId,
        toolUseId: options.toolUseID,
        toolName,
        input,
        sessionId: session.id,
        timestamp: Date.now()
      };

      res.write(`data: ${JSON.stringify({
        type: "permission_request",
        ...permissionRequest
      })}\n\n`);

      return new Promise<PermissionResult>((resolve, reject) => {
        const pending: PendingPermission = {
          resolve, reject,
          toolName, input,
          sessionId: session.id,
          timestamp: Date.now()
        };
        pendingPermissions.set(requestId, pending);

        setTimeout(() => {
          if (pendingPermissions.has(requestId)) {
            pendingPermissions.delete(requestId);
            console.log(`[Permission] Request timeout: ${requestId}`);
            resolve({ behavior: 'deny', message: '权限请求超时' });
          }
        }, PERMISSION_TIMEOUT);
      });
    };

    const stream = query({
      prompt: message,
      options: {
        cwd: workingDir,
        model: selectedModel,
        maxTurns: 10,
        systemPrompt: dynamicSystemPrompt,
        permissionMode: permissionMode || 'default',
        canUseTool,
        ...(sdkSessionId ? { resume: sdkSessionId } : {})
      }
    });

    let fullResponse = "";
    let toolCalls: Array<{
      id: string;
      name: string;
      input?: Record<string, unknown>;
      status: string;
      result?: string;
      isError?: boolean;
    }> = [];
    let newSdkSessionId: string | null = null;

    // 发送会话初始信息（含意图识别结果和FAQ）
    res.write(`data: ${JSON.stringify({
      type: "init",
      sessionId: session.id,
      userMessageId,
      assistantMessageId,
      model: selectedModel,
      intent: { intent: intent.intent, confidence: intent.confidence },
      faqMatched: faqResults.length > 0,
      faqCount: faqResults.length,
    })}\n\n`);

    let currentToolId: string | null = null;

    for await (const msg of stream) {
      console.log("[Stream] Message type:", msg.type);

      if (msg.type === "system" && (msg as any).subtype === "init") {
        newSdkSessionId = (msg as any).session_id;
        console.log(`[Stream] Got SDK session_id: ${newSdkSessionId}`);
        if (newSdkSessionId && newSdkSessionId !== sdkSessionId) {
          db.updateSession(session.id, { sdk_session_id: newSdkSessionId });
        }
      } else if (msg.type === "assistant") {
        const content = msg.message.content;

        if (typeof content === "string") {
          fullResponse += content;
          res.write(`data: ${JSON.stringify({ type: "text", content })}\n\n`);
        } else if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === "text") {
              fullResponse += block.text;
              res.write(`data: ${JSON.stringify({ type: "text", content: block.text })}\n\n`);
            } else if (block.type === "tool_use") {
              currentToolId = block.id || uuidv4();
              const toolInput = (block as any).input || {};
              const toolCall = {
                id: currentToolId,
                name: block.name,
                input: toolInput,
                status: "running"
              };
              toolCalls.push(toolCall);
              res.write(`data: ${JSON.stringify({
                type: "tool",
                id: toolCall.id,
                name: toolCall.name,
                input: toolCall.input,
                status: toolCall.status
              })}\n\n`);
            }
          }
        }
      } else if (msg.type === "tool_result") {
        const msgAny = msg as any;
        const toolId = msgAny.tool_use_id || currentToolId;
        const isError = msgAny.is_error || false;
        const content = msgAny.content;

        const tool = toolCalls.find(t => t.id === toolId) || toolCalls[toolCalls.length - 1];
        if (tool) {
          tool.status = isError ? "error" : "completed";
          tool.isError = isError;
          tool.result = typeof content === 'string' ? content : JSON.stringify(content);
          res.write(`data: ${JSON.stringify({
            type: "tool_result",
            toolId: tool.id,
            content: tool.result,
            isError: isError
          })}\n\n`);
        }
        currentToolId = null;
      } else if (msg.type === "result") {
        toolCalls.forEach(tool => {
          if (tool.status === "running") {
            tool.status = "completed";
            res.write(`data: ${JSON.stringify({ type: "tool_result", toolId: tool.id, content: tool.result || "已完成" })}\n\n`);
          }
        });
        res.write(`data: ${JSON.stringify({ type: "done", duration: msg.duration, cost: msg.cost })}\n\n`);
      }
    }

    // 保存助手消息
    db.createMessage({
      id: assistantMessageId,
      session_id: session.id,
      role: 'assistant',
      content: fullResponse,
      model: selectedModel,
      created_at: new Date().toISOString(),
      tool_calls: toolCalls.length > 0 ? JSON.stringify(toolCalls) : null
    });

    // 更新会话标题
    const messages = db.getMessagesBySession(session.id);
    if (messages.length <= 2) {
      db.updateSession(session.id, {
        title: message.slice(0, 30) + (message.length > 30 ? '...' : ''),
        model: selectedModel
      });
    }

    console.log(`[Chat] 请求完成 ✓`);
    res.end();
  } catch (error: any) {
    console.error(`\n[Chat] ========== 错误 ==========`);
    console.error(`[Chat] Error:`, error?.message);
    console.error(`[Chat] Stack:`, error?.stack);

    const errorMessage = error?.message || "处理请求时发生错误";
    res.write(`data: ${JSON.stringify({ type: "error", message: errorMessage })}\n\n`);
    res.end();
  }
});

// 启动服务器
async function startServer() {
  // 等待数据库初始化完成
  await db.dbPromise;
  
  // 初始化 FAQ 种子数据
  initFaqData();

  app.listen(PORT, () => {
    console.log(`
╔════════════════════════════════════════════╗
║                                            ║
║  🤖 SmartCS 智能客服 Agent 已启动           ║
║                                            ║
║     地址: http://localhost:${PORT}            ║
║     数据库: SQLite (data/chat.db)          ║
║     功能: 多轮对话 / 意图识别 / FAQ检索      ║
║          转人工 / 管理后台 / 满意度统计      ║
║                                            ║
╚════════════════════════════════════════════╝
  `);
  });
}

startServer().catch(err => {
  console.error('[Server] 启动失败:', err);
  process.exit(1);
});
