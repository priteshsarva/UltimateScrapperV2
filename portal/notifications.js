// Notification feed helpers. Broadcast to an audience ('all_clients' | 'admin');
// unread state is tracked client-side (a last-seen timestamp), so there's no
// per-user reads table to maintain.
import { query } from "./db.js";

// Broadcast to an audience, or address one user directly (pass user_id — then
// audience is ignored for visibility and only that user sees it).
export async function notify({ audience = "all_clients", user_id = null, type = null, title, body = null, meta = {} }) {
  if (!title) return null;
  const { rows } = await query(
    `insert into platform_notifications (audience, user_id, type, title, body, meta)
     values ($1,$2,$3,$4,$5,$6) returning id, created_at`,
    [audience, user_id, type, title, body, JSON.stringify(meta || {})]
  );
  return rows[0];
}

// Notifications visible to a user: broadcasts for their role + any addressed to
// them directly. Admins see admin + client broadcasts; clients see client ones.
export async function listNotifications(role, userId = null, limit = 50) {
  const audiences = role === "admin" ? ["all_clients", "admin"] : ["all_clients"];
  const { rows } = await query(
    `select id, audience, type, title, body, meta, created_at
       from platform_notifications
      where (user_id is null and audience = any($1)) or ($2::uuid is not null and user_id = $2)
      order by created_at desc limit $3`,
    [audiences, userId, limit]
  );
  return rows;
}
