function nowIso() {
  return new Date().toISOString();
}

export function createRepositories(db) {
  const addMemoStmt = db.prepare(`
    INSERT INTO memos (title, content, tags, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  const listMemosStmt = db.prepare(`
    SELECT id, title, content, tags, created_at, updated_at
    FROM memos
    ORDER BY updated_at DESC
    LIMIT ?
  `);
  const findMemoByIdStmt = db.prepare(`
    SELECT id, title, content, tags, created_at, updated_at
    FROM memos
    WHERE id = ?
  `);
  const findMemoByContentStmt = db.prepare(`
    SELECT id, title, content, tags, created_at, updated_at
    FROM memos
    WHERE lower(content) LIKE lower(?)
    ORDER BY updated_at DESC, id DESC
    LIMIT 1
  `);
  const deleteMemoStmt = db.prepare(`
    DELETE FROM memos WHERE id = ?
  `);
  const countMemosStmt = db.prepare(`
    SELECT COUNT(*) AS count FROM memos
  `);
  const deleteAllMemosStmt = db.prepare(`
    DELETE FROM memos
  `);

  const addTodoStmt = db.prepare(`
    INSERT INTO todos (content, status, priority, due_at, created_at, completed_at)
    VALUES (?, 'open', ?, ?, ?, NULL)
  `);
  const listTodosStmt = db.prepare(`
    SELECT id, content, status, priority, due_at, created_at, completed_at
    FROM todos
    ORDER BY
      CASE status WHEN 'open' THEN 0 ELSE 1 END,
      COALESCE(due_at, '9999-12-31T00:00:00.000Z') ASC,
      created_at DESC
    LIMIT ?
  `);
  const findTodoByIdStmt = db.prepare(`
    SELECT id, content, status FROM todos WHERE id = ?
  `);
  const findTodoByContentStmt = db.prepare(`
    SELECT id, content, status
    FROM todos
    WHERE lower(content) LIKE lower(?)
    ORDER BY CASE status WHEN 'open' THEN 0 ELSE 1 END, id ASC
    LIMIT 1
  `);
  const completeTodoStmt = db.prepare(`
    UPDATE todos SET status = 'done', completed_at = ? WHERE id = ?
  `);
  const deleteTodoStmt = db.prepare(`
    DELETE FROM todos WHERE id = ?
  `);
  const countTodosStmt = db.prepare(`
    SELECT COUNT(*) AS count FROM todos
  `);
  const deleteAllTodosStmt = db.prepare(`
    DELETE FROM todos
  `);
  const countCompletedTodosStmt = db.prepare(`
    SELECT COUNT(*) AS count FROM todos WHERE status = 'done'
  `);
  const deleteCompletedTodosStmt = db.prepare(`
    DELETE FROM todos WHERE status = 'done'
  `);

  const addEventStmt = db.prepare(`
    INSERT INTO events (title, start_at, end_at, notes, all_day, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const listEventsStmt = db.prepare(`
    SELECT id, title, start_at, end_at, notes, all_day, created_at
    FROM events
    WHERE start_at >= ?
    ORDER BY start_at ASC
    LIMIT ?
  `);
  const listEventsForDayStmt = db.prepare(`
    SELECT id, title, start_at, end_at, notes, all_day, created_at
    FROM events
    WHERE start_at >= ? AND start_at < ?
    ORDER BY start_at ASC
  `);
  const findEventByIdStmt = db.prepare(`
    SELECT id, title, start_at, end_at, notes, all_day, created_at
    FROM events
    WHERE id = ?
  `);
  const findEventByTitleStmt = db.prepare(`
    SELECT id, title, start_at, end_at, notes, all_day, created_at
    FROM events
    WHERE lower(title) LIKE lower(?)
    ORDER BY start_at ASC, id ASC
    LIMIT 1
  `);
  const deleteEventStmt = db.prepare(`
    DELETE FROM events WHERE id = ?
  `);
  const countEventsStmt = db.prepare(`
    SELECT COUNT(*) AS count FROM events
  `);
  const deleteAllEventsStmt = db.prepare(`
    DELETE FROM events
  `);

  const setSettingStmt = db.prepare(`
    INSERT INTO settings (key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `);
  const getSettingStmt = db.prepare(`
    SELECT value FROM settings WHERE key = ?
  `);

  return {
    memos: {
      add({ title = null, content, tags = [] }) {
        const timestamp = nowIso();
        const result = addMemoStmt.run(
          title,
          content,
          JSON.stringify(tags),
          timestamp,
          timestamp
        );

        return {
          id: Number(result.lastInsertRowid),
          title,
          content,
          tags,
          createdAt: timestamp,
          updatedAt: timestamp
        };
      },
      listRecent(limit = 5) {
        return listMemosStmt.all(limit).map((row) => ({
          id: row.id,
          title: row.title,
          content: row.content,
          tags: safeParseJson(row.tags),
          createdAt: row.created_at,
          updatedAt: row.updated_at
        }));
      },
      delete(target) {
        const row = /^\d+$/.test(target)
          ? findMemoByIdStmt.get(Number(target))
          : findMemoByContentStmt.get(`%${target}%`);
        if (!row) {
          return null;
        }

        deleteMemoStmt.run(row.id);
        return {
          id: row.id,
          title: row.title,
          content: row.content,
          tags: safeParseJson(row.tags),
          createdAt: row.created_at,
          updatedAt: row.updated_at
        };
      },
      deleteAll() {
        const row = countMemosStmt.get();
        const deletedCount = Number(row?.count || 0);
        deleteAllMemosStmt.run();
        return { deletedCount };
      }
    },
    todos: {
      add({ content, priority = null, dueAt = null }) {
        const createdAt = nowIso();
        const result = addTodoStmt.run(content, priority, dueAt, createdAt);
        return {
          id: Number(result.lastInsertRowid),
          content,
          status: "open",
          priority,
          dueAt,
          createdAt,
          completedAt: null
        };
      },
      list(limit = 8) {
        return listTodosStmt.all(limit).map(mapTodo);
      },
      complete(target) {
        const row = /^\d+$/.test(target)
          ? findTodoByIdStmt.get(Number(target))
          : findTodoByContentStmt.get(`%${target}%`);
        if (!row) {
          return null;
        }
        const completedAt = nowIso();
        completeTodoStmt.run(completedAt, row.id);
        return { id: row.id, content: row.content, status: "done", completedAt };
      },
      delete(target) {
        const row = /^\d+$/.test(target)
          ? findTodoByIdStmt.get(Number(target))
          : findTodoByContentStmt.get(`%${target}%`);
        if (!row) {
          return null;
        }

        deleteTodoStmt.run(row.id);
        return { id: row.id, content: row.content, status: row.status };
      },
      deleteAll() {
        const row = countTodosStmt.get();
        const deletedCount = Number(row?.count || 0);
        deleteAllTodosStmt.run();
        return { deletedCount };
      },
      deleteCompleted() {
        const row = countCompletedTodosStmt.get();
        const deletedCount = Number(row?.count || 0);
        deleteCompletedTodosStmt.run();
        return { deletedCount };
      }
    },
    events: {
      add({ title, startAt, endAt = null, notes = null, allDay = false }) {
        const createdAt = nowIso();
        const result = addEventStmt.run(
          title,
          startAt,
          endAt,
          notes,
          allDay ? 1 : 0,
          createdAt
        );
        return {
          id: Number(result.lastInsertRowid),
          title,
          startAt,
          endAt,
          notes,
          allDay,
          createdAt
        };
      },
      listUpcoming(limit = 6, from = nowIso()) {
        return listEventsStmt.all(from, limit).map(mapEvent);
      },
      listForDay(dayStartIso, nextDayIso) {
        return listEventsForDayStmt.all(dayStartIso, nextDayIso).map(mapEvent);
      },
      delete(target) {
        const row = /^\d+$/.test(target)
          ? findEventByIdStmt.get(Number(target))
          : findEventByTitleStmt.get(`%${target}%`);
        if (!row) {
          return null;
        }

        deleteEventStmt.run(row.id);
        return mapEvent(row);
      },
      deleteAll() {
        const row = countEventsStmt.get();
        const deletedCount = Number(row?.count || 0);
        deleteAllEventsStmt.run();
        return { deletedCount };
      }
    },
    settings: {
      set(key, value) {
        setSettingStmt.run(key, JSON.stringify(value), nowIso());
      },
      get(key, defaultValue = null) {
        const row = getSettingStmt.get(key);
        if (!row) {
          return defaultValue;
        }
        return safeParseJson(row.value, defaultValue);
      }
    }
  };
}

function mapTodo(row) {
  return {
    id: row.id,
    content: row.content,
    status: row.status,
    priority: row.priority,
    dueAt: row.due_at,
    createdAt: row.created_at,
    completedAt: row.completed_at
  };
}

function mapEvent(row) {
  return {
    id: row.id,
    title: row.title,
    startAt: row.start_at,
    endAt: row.end_at,
    notes: row.notes,
    allDay: Boolean(row.all_day),
    createdAt: row.created_at
  };
}

function safeParseJson(value, fallback = []) {
  if (!value) {
    return fallback;
  }
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}
