import initSqlJs, { Database, SqlJsStatic } from 'sql.js';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 数据库文件路径
const dbPath = path.join(__dirname, '..', 'data', 'chat.db');

// 确保 data 目录存在
const dataDir = path.dirname(dbPath);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

let SQL: SqlJsStatic;
let db: Database;

// 初始化数据库
async function initDb(): Promise<void> {
  SQL = await initSqlJs();

  // 尝试从文件加载已有数据库，否则创建新数据库
  if (fs.existsSync(dbPath)) {
    const fileBuffer = fs.readFileSync(dbPath);
    db = new SQL.Database(fileBuffer);
    console.log('[DB] 已加载现有数据库');
  } else {
    db = new SQL.Database();
    console.log('[DB] 已创建新数据库');
  }

  // 创建表结构
  db.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      model TEXT NOT NULL,
      sdk_session_id TEXT,
      status TEXT DEFAULT 'active' CHECK (status IN ('active', 'resolved', 'transferred')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
      content TEXT NOT NULL,
      model TEXT,
      created_at TEXT NOT NULL,
      tool_calls TEXT,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id);

    CREATE TABLE IF NOT EXISTS satisfaction_ratings (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      score INTEGER NOT NULL CHECK (score >= 1 AND score <= 5),
      comment TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_ratings_session_id ON satisfaction_ratings(session_id);

    CREATE TABLE IF NOT EXISTS conversation_intents (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      message_id TEXT,
      intent TEXT NOT NULL,
      confidence REAL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_intents_session_id ON conversation_intents(session_id);

    CREATE TABLE IF NOT EXISTS faq_knowledge (
      id TEXT PRIMARY KEY,
      category TEXT NOT NULL,
      question TEXT NOT NULL,
      answer TEXT NOT NULL,
      keywords TEXT,
      priority INTEGER DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_faq_category ON faq_knowledge(category);
  `);

  // 数据库迁移：为已有 session 表补充缺失列
  try {
    const tableInfo = db.exec("PRAGMA table_info(sessions)");
    if (tableInfo.length > 0) {
      const columns = tableInfo[0].values.map(row => row[1]); // column name is at index 1
      if (!columns.includes('sdk_session_id')) {
        db.run("ALTER TABLE sessions ADD COLUMN sdk_session_id TEXT");
        console.log('[DB] Migrated: added sdk_session_id column');
      }
      if (!columns.includes('status')) {
        db.run("ALTER TABLE sessions ADD COLUMN status TEXT DEFAULT 'active' CHECK (status IN ('active', 'resolved', 'transferred'))");
        console.log('[DB] Migrated: added status column');
      }
    }
  } catch (e) {
    // 忽略迁移错误
  }

  saveDb();
}

// 持久化到磁盘
function saveDb(): void {
  try {
    const data = db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(dbPath, buffer);
  } catch (e) {
    console.error('[DB] 保存失败:', e);
  }
}

// ============= 类型定义 =============

export interface DbSession {
  id: string;
  title: string;
  model: string;
  sdk_session_id: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface DbMessage {
  id: string;
  session_id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  model: string | null;
  created_at: string;
  tool_calls: string | null;
}

export interface DbSatisfactionRating {
  id: string;
  message_id: string;
  session_id: string;
  score: number;
  comment: string | null;
  created_at: string;
}

export interface DbConversationIntent {
  id: string;
  session_id: string;
  message_id: string | null;
  intent: string;
  confidence: number | null;
  created_at: string;
}

export interface DbFaqItem {
  id: string;
  category: string;
  question: string;
  answer: string;
  keywords: string | null;
  priority: number;
  created_at: string;
}

// ============= 辅助函数 =============

function rowToObj(row: any[], columns: string[]): Record<string, any> {
  const obj: Record<string, any> = {};
  columns.forEach((col, i) => {
    obj[col] = row[i];
  });
  return obj;
}

function queryAll(sql: string, params?: any[]): Record<string, any>[] {
  let stmt: any;
  try {
    if (params && params.length > 0) {
      stmt = db.prepare(sql);
      stmt.bind(params);
    } else {
      stmt = db.prepare(sql);
    }

    const results: Record<string, any>[] = [];
    while (stmt.step()) {
      results.push(stmt.getAsObject());
    }
    return results;
  } finally {
    if (stmt) stmt.free();
  }
}

function queryOne(sql: string, params?: any[]): Record<string, any> | undefined {
  const rows = queryAll(sql, params);
  return rows.length > 0 ? rows[0] : undefined;
}

function execute(sql: string, params?: any[]): number {
  if (params && params.length > 0) {
    db.run(sql, params);
  } else {
    db.run(sql);
  }
  saveDb();
  return db.getRowsModified();
}

// ============= 会话操作 =============

export function getAllSessions(): DbSession[] {
  return queryAll('SELECT * FROM sessions ORDER BY updated_at DESC') as DbSession[];
}

export function getSession(id: string): DbSession | undefined {
  return queryOne('SELECT * FROM sessions WHERE id = ?', [id]) as DbSession | undefined;
}

export function createSession(session: DbSession): DbSession {
  execute(
    `INSERT INTO sessions (id, title, model, sdk_session_id, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [session.id, session.title, session.model, session.sdk_session_id || null,
     session.status || 'active', session.created_at, session.updated_at]
  );
  return session;
}

export function updateSession(
  id: string,
  updates: Partial<Pick<DbSession, 'title' | 'model' | 'sdk_session_id' | 'status'>>
): boolean {
  const fields: string[] = [];
  const values: any[] = [];

  if (updates.title !== undefined) { fields.push('title = ?'); values.push(updates.title); }
  if (updates.model !== undefined) { fields.push('model = ?'); values.push(updates.model); }
  if (updates.sdk_session_id !== undefined) { fields.push('sdk_session_id = ?'); values.push(updates.sdk_session_id); }
  if (updates.status !== undefined) { fields.push('status = ?'); values.push(updates.status); }

  if (fields.length === 0) return false;

  fields.push('updated_at = ?');
  values.push(new Date().toISOString());
  values.push(id);

  const result = execute(`UPDATE sessions SET ${fields.join(', ')} WHERE id = ?`, values);
  return result > 0;
}

export function deleteSession(id: string): boolean {
  // 级联删除相关数据
  execute('DELETE FROM satisfaction_ratings WHERE session_id = ?', [id]);
  execute('DELETE FROM conversation_intents WHERE session_id = ?', [id]);
  execute('DELETE FROM messages WHERE session_id = ?', [id]);
  const result = execute('DELETE FROM sessions WHERE id = ?', [id]);
  return result > 0;
}

// ============= 消息操作 =============

export function getMessagesBySession(sessionId: string): DbMessage[] {
  return queryAll('SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC', [sessionId]) as DbMessage[];
}

export function createMessage(message: DbMessage): DbMessage {
  execute(
    `INSERT INTO messages (id, session_id, role, content, model, created_at, tool_calls)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [message.id, message.session_id, message.role, message.content,
     message.model, message.created_at, message.tool_calls]
  );

  // 更新会话 updated_at
  execute('UPDATE sessions SET updated_at = ? WHERE id = ?', [new Date().toISOString(), message.session_id]);
  return message;
}

export function updateMessage(
  id: string,
  updates: Partial<Pick<DbMessage, 'content' | 'tool_calls'>>
): boolean {
  const fields: string[] = [];
  const values: any[] = [];

  if (updates.content !== undefined) { fields.push('content = ?'); values.push(updates.content); }
  if (updates.tool_calls !== undefined) { fields.push('tool_calls = ?'); values.push(updates.tool_calls); }

  if (fields.length === 0) return false;

  values.push(id);
  const result = execute(`UPDATE messages SET ${fields.join(', ')} WHERE id = ?`, values);
  return result > 0;
}

export function createMessages(messages: DbMessage[]): void {
  const stmt = db.prepare(
    `INSERT INTO messages (id, session_id, role, content, model, created_at, tool_calls)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  try {
    for (const msg of messages) {
      stmt.run([msg.id, msg.session_id, msg.role, msg.content, msg.model, msg.created_at, msg.tool_calls]);
    }
  } finally {
    stmt.free();
    saveDb();
  }
}

// ============= 满意度评分操作 =============

export function createSatisfactionRating(rating: DbSatisfactionRating): DbSatisfactionRating {
  execute(
    `INSERT INTO satisfaction_ratings (id, message_id, session_id, score, comment, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [rating.id, rating.message_id, rating.session_id, rating.score, rating.comment || null, rating.created_at]
  );
  return rating;
}

export function getRatingsBySession(sessionId: string): DbSatisfactionRating[] {
  return queryAll('SELECT * FROM satisfaction_ratings WHERE session_id = ? ORDER BY created_at DESC', [sessionId]) as DbSatisfactionRating[];
}

export function getSatisfactionStats(): {
  total_ratings: number;
  average_score: number;
  distribution: Array<{ score: number; count: number }>;
} {
  const total = queryOne('SELECT COUNT(*) as count, AVG(score) as avg FROM satisfaction_ratings');
  const dist = queryAll('SELECT score, COUNT(*) as count FROM satisfaction_ratings GROUP BY score ORDER BY score');

  return {
    total_ratings: (total as any)?.count || 0,
    average_score: (total as any)?.avg ? Math.round((total as any).avg * 10) / 10 : 0,
    distribution: dist.map(d => ({ score: d.score, count: d.count })),
  };
}

// ============= 意图识别操作 =============

export function createConversationIntent(intent: DbConversationIntent): DbConversationIntent {
  execute(
    `INSERT INTO conversation_intents (id, session_id, message_id, intent, confidence, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [intent.id, intent.session_id, intent.message_id || null, intent.intent, intent.confidence, intent.created_at]
  );
  return intent;
}

export function getIntentsBySession(sessionId: string): DbConversationIntent[] {
  return queryAll('SELECT * FROM conversation_intents WHERE session_id = ? ORDER BY created_at DESC', [sessionId]) as DbConversationIntent[];
}

export function getIntentDistribution(): Array<{ intent: string; count: number; avg_confidence: number }> {
  return queryAll(
    `SELECT intent, COUNT(*) as count, AVG(confidence) as avg_confidence
     FROM conversation_intents GROUP BY intent ORDER BY count DESC`
  ) as any[];
}

export function updateLatestIntentMessageId(sessionId: string, messageId: string): void {
  execute(
    `UPDATE conversation_intents SET message_id = ?
     WHERE session_id = ? AND id = (
       SELECT id FROM conversation_intents WHERE session_id = ? ORDER BY created_at DESC LIMIT 1
     )`,
    [messageId, sessionId, sessionId]
  );
}

// ============= FAQ 知识库操作 =============

export function getAllFaq(): DbFaqItem[] {
  return queryAll('SELECT * FROM faq_knowledge ORDER BY priority DESC, category, id') as DbFaqItem[];
}

export function getFaqByCategory(category: string): DbFaqItem[] {
  return queryAll('SELECT * FROM faq_knowledge WHERE category = ? ORDER BY priority DESC', [category]) as DbFaqItem[];
}

export function searchFaq(keyword: string): DbFaqItem[] {
  const pattern = `%${keyword}%`;
  return queryAll(
    `SELECT * FROM faq_knowledge
     WHERE question LIKE ? OR answer LIKE ? OR keywords LIKE ?
     ORDER BY priority DESC LIMIT 10`,
    [pattern, pattern, pattern]
  ) as DbFaqItem[];
}

export function createFaqItem(item: DbFaqItem): DbFaqItem {
  execute(
    `INSERT INTO faq_knowledge (id, category, question, answer, keywords, priority, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [item.id, item.category, item.question, item.answer, item.keywords, item.priority, item.created_at]
  );
  return item;
}

export function batchInsertFaq(items: DbFaqItem[]): void {
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO faq_knowledge (id, category, question, answer, keywords, priority, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  try {
    for (const e of items) {
      stmt.run([e.id, e.category, e.question, e.answer, e.keywords, e.priority, e.created_at]);
    }
  } finally {
    stmt.free();
    saveDb();
  }
}

// ============= 管理后台统计 =============

export function getAdminOverview(): {
  total_sessions: number;
  active_sessions: number;
  total_messages: number;
  avg_satisfaction: number;
  today_sessions: number;
} {
  const now = new Date().toISOString();
  const today = now.slice(0, 10);

  const totalSessions = (queryOne('SELECT COUNT(*) as c FROM sessions') as any)?.c || 0;
  const activeSessions = (queryOne("SELECT COUNT(*) as c FROM sessions WHERE status = 'active'") as any)?.c || 0;
  const totalMessages = (queryOne('SELECT COUNT(*) as c FROM messages') as any)?.c || 0;
  const avgSat = (queryOne('SELECT AVG(score) as avg FROM satisfaction_ratings') as any)?.avg || 0;
  const todaySessions = (queryOne("SELECT COUNT(*) as c FROM sessions WHERE created_at >= ?", [today]) as any)?.c || 0;

  return {
    total_sessions: totalSessions,
    active_sessions: activeSessions,
    total_messages: totalMessages,
    avg_satisfaction: Math.round(avgSat * 10) / 10,
    today_sessions: todaySessions,
  };
}

export function getRecentConversations(limit: number = 50, offset: number = 0): Array<{
  session_id: string;
  title: string;
  status: string;
  message_count: number;
  last_message: string | null;
  intent: string | null;
  avg_rating: number | null;
  created_at: string;
  updated_at: string;
}> {
  return queryAll(`
    SELECT 
      s.id as session_id,
      s.title,
      s.status,
      (SELECT COUNT(*) FROM messages WHERE session_id = s.id) as message_count,
      (SELECT content FROM messages WHERE session_id = s.id ORDER BY created_at DESC LIMIT 1) as last_message,
      (SELECT intent FROM conversation_intents WHERE session_id = s.id ORDER BY created_at DESC LIMIT 1) as intent,
      (SELECT AVG(score) FROM satisfaction_ratings WHERE session_id = s.id) as avg_rating,
      s.created_at,
      s.updated_at
    FROM sessions s
    ORDER BY s.updated_at DESC
    LIMIT ? OFFSET ?
  `, [limit, offset]) as any[];
}

export function getDailySatisfactionTrend(days: number = 30): Array<{
  date: string;
  avg_score: number;
  count: number;
}> {
  return queryAll(`
    SELECT 
      date(created_at) as date,
      AVG(score) as avg_score,
      COUNT(*) as count
    FROM satisfaction_ratings
    WHERE created_at >= date('now', ? || ' days')
    GROUP BY date(created_at)
    ORDER BY date ASC
  `, [`-${days}`]) as any[];
}

export function clearAllData(): void {
  db.run('DELETE FROM satisfaction_ratings');
  db.run('DELETE FROM conversation_intents');
  db.run('DELETE FROM messages');
  db.run('DELETE FROM sessions');
  saveDb();
}

// ============= 初始化 =============

let dbReady = false;
const dbPromise = initDb().then(() => { dbReady = true; });

// 导出 db 实例和 ready 状态
export { dbReady, dbPromise, SQL };
export default { dbReady, dbPromise };
