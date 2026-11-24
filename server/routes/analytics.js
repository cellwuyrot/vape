/** Privacy-first analytics: only aggregate anonymous events after consent. */
import { db, nowIso } from "../db.js";
import { HttpError, get, post, rateLimit, clientIp } from "../http.js";

const adminOnly = (user) => {
  if (!user || !["superadmin", "admin", "manager"].includes(user.role)) throw new HttpError(403, "Статистика доступна руководителям");
};
const clean = (value, max) => String(value ?? "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, max);
const safePath = (value) => {
  const path = clean(value, 400).split(/[?#]/, 1)[0];
  return path.startsWith("/") && !path.startsWith("//") && !path.includes("\\") && !path.includes("..") ? path : "/";
};

post("/api/analytics/event", async ({ body, req }) => {
  rateLimit(`analytics:${clientIp(req)}`, 120, 60_000);
  const visitorId = clean(body.visitor_id, 80);
  const sessionId = clean(body.session_id, 80);
  const eventType = clean(body.event_type, 30);
  if (!/^[a-zA-Z0-9_-]{12,80}$/.test(visitorId) || !/^[a-zA-Z0-9_-]{12,80}$/.test(sessionId)) throw new HttpError(400, "Некорректный идентификатор аналитики");
  if (!["page_view", "click", "reservation_submitted"].includes(eventType)) throw new HttpError(400, "Неизвестный тип события");
  const referrerHost = (() => { try { return new URL(String(body.referrer || "")).hostname.slice(0, 160); } catch { return ""; } })();
  await db.run(
    "INSERT INTO store_analytics_events(visitor_id,session_id,event_type,path,page_title,referrer_host,target_tag,target_text,target_path,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
    [visitorId, sessionId, eventType, safePath(body.path), clean(body.page_title, 180), referrerHost, clean(body.target_tag, 20), clean(body.target_text, 120), safePath(body.target_path), nowIso()],
  );
  return { data: { accepted: true } };
});

get("/api/analytics/summary", async ({ user, query }) => {
  adminOnly(user);
  const days = Math.max(1, Math.min(90, Number(query.get("days") || 30) || 30));
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const totals = await db.get(`SELECT COUNT(DISTINCT visitor_id) AS unique_visitors,
    COUNT(DISTINCT session_id) AS sessions,
    SUM(CASE WHEN event_type='page_view' THEN 1 ELSE 0 END) AS page_views,
    SUM(CASE WHEN event_type='click' THEN 1 ELSE 0 END) AS clicks,
    SUM(CASE WHEN event_type='reservation_submitted' THEN 1 ELSE 0 END) AS reservation_events
    FROM store_analytics_events WHERE created_at>=?`, [since]);
  const pages = await db.all(`SELECT path,COUNT(*) AS views,COUNT(DISTINCT visitor_id) AS visitors FROM store_analytics_events WHERE created_at>=? AND event_type='page_view' GROUP BY path ORDER BY views DESC LIMIT 15`, [since]);
  const clicks = await db.all(`SELECT target_text,target_path,COUNT(*) AS clicks FROM store_analytics_events WHERE created_at>=? AND event_type='click' GROUP BY target_text,target_path ORDER BY clicks DESC LIMIT 15`, [since]);
  const daily = await db.all(`SELECT date(created_at) AS day,COUNT(DISTINCT visitor_id) AS visitors,
    SUM(CASE WHEN event_type='page_view' THEN 1 ELSE 0 END) AS page_views,
    SUM(CASE WHEN event_type='click' THEN 1 ELSE 0 END) AS clicks
    FROM store_analytics_events WHERE created_at>=? GROUP BY date(created_at) ORDER BY day`, [since]);
  return { data: { days, since, totals: Object.fromEntries(Object.entries(totals || {}).map(([key, value]) => [key, Number(value || 0)])), pages, clicks, daily } };
}, { auth: true });

get("/api/analytics/events", async ({ user, query }) => {
  adminOnly(user);
  const page = Math.max(1, Number(query.get("page") || 1) || 1);
  const pageSize = Math.max(10, Math.min(100, Number(query.get("page_size") || 50) || 50));
  const eventType = clean(query.get("event_type"), 30);
  const where = ["created_at>=?"];
  const params = [new Date(Date.now() - 90 * 86400_000).toISOString()];
  if (["page_view", "click", "reservation_submitted"].includes(eventType)) { where.push("event_type=?"); params.push(eventType); }
  const condition = `WHERE ${where.join(" AND ")}`;
  const total = Number((await db.get(`SELECT COUNT(*) AS total FROM store_analytics_events ${condition}`, params))?.total || 0);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePageNumber = Math.min(page, totalPages);
  const events = await db.all(`SELECT id,event_type,path,page_title,referrer_host,target_tag,target_text,target_path,created_at FROM store_analytics_events ${condition} ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?`, [...params, pageSize, (safePageNumber - 1) * pageSize]);
  return { data: { events, pagination: { page: safePageNumber, page_size: pageSize, total, total_pages: totalPages } } };
}, { auth: true });
