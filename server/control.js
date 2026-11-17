// User administration and immutable operation history. Never include credentials in audit details.
export async function controlStore({
  db,
  all,
  get,
  run,
  transaction,
  today,
  stamp,
  openCash,
  reconcile,
  report,
  fail,
  hashPassword
}) {
  if (!(await db.columns('users')).some(c => c.name === 'active')) await db.exec('ALTER TABLE users ADD COLUMN active INTEGER NOT NULL DEFAULT 1');
  await db.exec(`CREATE TABLE IF NOT EXISTS audit_log(id INTEGER PRIMARY KEY,action TEXT NOT NULL,entity_id TEXT NOT NULL,actor_id INTEGER REFERENCES users(id),actor_name TEXT NOT NULL,actor_username TEXT NOT NULL,actor_role TEXT NOT NULL,details TEXT NOT NULL,created_at TEXT NOT NULL);`);
  async function audit(action, entity, actor, details = {}) {
    await run('INSERT INTO audit_log(action,entity_id,actor_id,actor_name,actor_username,actor_role,details,created_at) VALUES (?,?,?,?,?,?,?,?)', action, String(entity), actor?.id ?? null, actor?.name || 'Sistema', actor?.username || '', actor?.role || 'system', JSON.stringify(details), stamp());
  }
  const users = async () => await all('SELECT id,name,username,role,active FROM users ORDER BY id');
  async function saveUser(body, actor) {
    return await transaction(async () => {
      const name = String(body.name || '').trim(),
        username = String(body.username || '').trim().toLowerCase();
      if (body.password !== undefined && typeof body.password !== 'string') fail('La contraseña debe ser un texto.');
      if (!['admin', 'cashier', 'kitchen'].includes(body.role)) fail('Perfil inválido.');
      if (body.active !== undefined && typeof body.active !== 'boolean') fail('Estado de cuenta inválido.');
      if (!name || name.length > 100) fail('Escribe un nombre de hasta 100 caracteres.');
      if (!/^[a-z0-9_.-]{3,40}$/.test(username)) fail('El usuario debe tener de 3 a 40 letras, números, puntos, guiones o guiones bajos.');
      if (!['admin', 'cashier', 'kitchen'].includes(body.role)) fail('Perfil inválido.');
      if (body.active !== undefined && typeof body.active !== 'boolean') fail('Estado de usuario inválido.');
      const active = body.active === false ? 0 : 1,
        password = body.password;
      if (password !== undefined && password !== '' && (typeof password !== 'string' || password.length < 8 || password.length > 200)) fail('La contraseña debe tener de 8 a 200 caracteres.');
      if (await get('SELECT id FROM users WHERE lower(username)=? AND id<>?', username, Number(body.id) || 0)) fail('Ese usuario ya existe.');
      let id,
        reauthenticate = false;
      if (body.id) {
        const old = await get('SELECT * FROM users WHERE id=?', Number(body.id));
        if (!old) fail('Usuario no encontrado.', 404);
        id = old.id;
        if (id === actor.id && (!active || body.role !== 'admin')) fail('No puedes desactivar tu propia cuenta ni quitarte el perfil de administrador.');
        if (old.active && old.role === 'admin' && (!active || body.role !== 'admin') && (await get("SELECT COUNT(*) AS count FROM users WHERE active=1 AND role='admin'")).count <= 1) fail('Debe quedar al menos un administrador activo.');
        const sensitive = old.username !== username || old.role !== body.role || old.active !== active || Boolean(password);
        await run('UPDATE users SET name=?,username=?,role=?,active=? WHERE id=?', name, username, body.role, active, id);
        if (password) await run('UPDATE users SET password=? WHERE id=?', hashPassword(password), id);
        if (sensitive) await run('DELETE FROM sessions WHERE user_id=?', id);
        reauthenticate = sensitive && id === actor.id;
        await audit('user_updated', id, actor, {
          before: {
            name: old.name,
            username: old.username,
            role: old.role,
            active: old.active
          },
          after: {
            name,
            username,
            role: body.role,
            active
          },
          password_changed: Boolean(password)
        });
      } else {
        if (!password) fail('Escribe una contraseña para el nuevo usuario.');
        id = Number((await run('INSERT INTO users(name,username,password,role,active) VALUES (?,?,?,?,?)', name, username, hashPassword(password), body.role, active)).lastInsertRowid);
        await audit('user_created', id, actor, {
          name,
          username,
          role: body.role,
          active
        });
      }
      return {
        id,
        reauthenticate
      };
    });
  }
  const cashEvents = async date => (await all("SELECT * FROM audit_log WHERE entity_id=? AND action IN ('cash_opening','cash_closed','cash_counted','cash_auto_closed','cash_auto_opened') ORDER BY id", date)).map(e => ({
    ...e,
    details: JSON.parse(e.details)
  }));
  async function setOpening(body, actor) {
    return await transaction(async () => {
      await openCash();
      const date = today();
      if ((await get('SELECT id FROM payments WHERE date=?', date)) || (await get('SELECT id FROM expenses WHERE date=?', date))) fail('Registra el fondo inicial antes del primer movimiento.');
      const amount = Number(body.amount);
      if (body.amount === '' || body.amount === undefined || !Number.isFinite(amount) || amount < 0 || amount > 1000000) fail('Fondo inicial inválido.');
      const before = (await get('SELECT opening FROM cash_days WHERE date=?', date)).opening;
      await run('UPDATE cash_days SET opening=? WHERE date=?', Math.round(amount * 100), date);
      await audit('cash_opening', date, actor, {
        before,
        amount: Math.round(amount * 100)
      });
    });
  }
  async function closeCash(body, actor) {
    return await transaction(async () => {
      await reconcile();
      const date = today(),
        day = await get('SELECT * FROM cash_days WHERE date=?', date),
        counted = Number(body.counted);
      if (body.counted === '' || body.counted === undefined || !Number.isFinite(counted) || counted < 0 || counted > 1000000) fail('Conteo inválido.');
      if (day.counted !== null) fail('El arqueo ya está registrado.');
      const r = await report(date, date),
        expected = day.opening + r.cash - r.expenses.filter(e => e.method === 'cash').reduce((s, e) => s + e.amount, 0),
        amount = Math.round(counted * 100),
        note = String(body.note || '').slice(0, 500);
      await run('UPDATE cash_days SET closed_at=COALESCE(closed_at,?),counted=?,note=? WHERE date=?', stamp(), amount, note, date);
      await audit(day.closed_at ? 'cash_counted' : 'cash_closed', date, actor, {
        amount,
        expected,
        difference: amount - expected,
        note
      });
    });
  }
  async function cashHistory() {
    return await Promise.all((await all('SELECT * FROM cash_days ORDER BY date DESC LIMIT 60')).map(async day => {
      const r = await report(day.date, day.date);
      return {
        ...day,
        expected: day.opening + r.cash - r.expenses.filter(e => e.method === 'cash').reduce((s, e) => s + e.amount, 0),
        events: await cashEvents(day.date)
      };
    }));
  }
  const userAudit = async () => (await all("SELECT * FROM audit_log WHERE action IN ('user_created','user_updated') ORDER BY id DESC LIMIT 100")).map(e => ({
    ...e,
    details: JSON.parse(e.details)
  }));
  return {
    audit,
    users,
    saveUser,
    userAudit,
    cashEvents,
    setOpening,
    closeCash,
    cashHistory
  };
}
