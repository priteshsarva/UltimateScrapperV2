// Notification feed helpers. Broadcast to an audience ('all_clients' | 'admin');
// unread state is tracked client-side (a last-seen timestamp), so there's no
// per-user reads table to maintain.
import { query } from "./db.js";

export async function notify({ audience = "all_clients", type = null, title, body = null, meta = {} }) {
  if (!title) return null;
  const { rows } = await query(
    `insert into platform_notifications (audience, type, title, body, meta)
     values ($1,$2,$3,$4,$5) returning id, created_at`,
    [audience, type, title, body, JSON.stringify(meta || {})]
  );
  return rows[0];
}

// Notifications visible to a role. Admins see admin + client broadcasts; clients
// see the client broadcasts.
export async function listNotifications(role, limit = 50) {
  const audiences = role === "admin" ? ["all_clients", "admin"] : ["all_clients"];
  const { rows } = await query(
    `select id, audience, type, title, body, meta, created_at
       from platform_notifications where audience = any($1)
      order by created_at desc limit $2`,
    [audiences, limit]
  );
  return rows;
}
