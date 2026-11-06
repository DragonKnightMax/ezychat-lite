-- Scheduled tasks for AI agents (docs/features/scheduled-tasks/design.md). A task makes one agent send
-- one message at a set time to one existing chat or group of its inbox. Chat keys carry no foreign key
-- (user data never cascades with a chat); chats/merge.ts moves them.

CREATE TABLE ai_scheduled_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id INTEGER NOT NULL REFERENCES ai_agents(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  -- Minutes after midnight in the business time zone (ai_timezone), 5-minute steps.
  time_minutes INTEGER NOT NULL CHECK (time_minutes BETWEEN 0 AND 1435),
  day_rule TEXT NOT NULL CHECK (day_rule IN ('daily', 'weekdays', 'custom')),
  -- Bit 0 = Sunday … bit 6 = Saturday (the custom days; 0 for daily and weekdays).
  days INTEGER NOT NULL DEFAULT 0 CHECK (days BETWEEN 0 AND 127),
  chat_jid TEXT NOT NULL,
  instruction TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_ai_scheduled_tasks_agent ON ai_scheduled_tasks(agent_id);
CREATE INDEX idx_ai_scheduled_tasks_chat ON ai_scheduled_tasks(chat_jid);

-- One row per run. A scheduled run is unique per task and slot, inserted before the turn, so a task
-- runs at most once per scheduled time (two ticks, a restart). Holds ids and reasons, never text.
CREATE TABLE ai_scheduled_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES ai_scheduled_tasks(id) ON DELETE CASCADE,
  slot INTEGER NOT NULL,
  trigger TEXT NOT NULL CHECK (trigger IN ('schedule', 'run_now')),
  by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  state TEXT NOT NULL CHECK (state IN ('running', 'sent', 'skipped', 'failed')),
  reason TEXT,
  message_id TEXT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE UNIQUE INDEX idx_ai_scheduled_runs_slot ON ai_scheduled_runs(task_id, slot)
  WHERE trigger = 'schedule';
CREATE INDEX idx_ai_scheduled_runs_task ON ai_scheduled_runs(task_id, id);

-- The "Scheduled · <task>" mark. No foreign key: the mark outlives a deleted task.
ALTER TABLE messages ADD COLUMN scheduled_task_id INTEGER;
