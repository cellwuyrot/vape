-- 017 — иерархия команды и мягкое удаление сотрудников.
-- invited_by (миграция 007) хранит создателя аккаунта; deleted_at скрывает удалённые записи без потери истории CRM.
ALTER TABLE users ADD COLUMN deleted_at TEXT;
CREATE INDEX IF NOT EXISTS idx_users_invited_by_active ON users(invited_by, is_active);
CREATE INDEX IF NOT EXISTS idx_users_deleted_at ON users(deleted_at);
