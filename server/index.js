import express from 'express';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createStore, checkPassword, fail, money } from './store.js';
export function createApp(store) {
  const app = express(),
    clients = new Set(),
    attempts = new Map();
  app.disable('x-powered-by');
  app.use((req, res, next) => ['/api/menu', '/api/inventory/products'].includes(req.path) ? next() : express.json({
    limit: '100kb'
  })(req, res, next));
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    next();
  });
  const notify = () => {
    for (const res of clients) res.write('data: update\n\n');
  };
  const auth = (...roles) => async (req, res, next) => {
    try {
      await store.reconcile();
      const token = (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith('session='))?.slice(8);
      const user = token && (await store.get('SELECT u.id,u.name,u.username,u.role FROM sessions s JOIN users u ON u.id=s.user_id WHERE u.active=1 AND s.token=? AND s.expires>?', token, Date.now()));
      if (!user) fail('Inicia sesión para continuar.', 401);
      if (roles.length && !roles.includes(user.role)) fail('No tienes permiso para esta acción.', 403);
      req.user = user;
      next();
    } catch (e) {
      next(e);
    }
  };
  const staff = auth('admin', 'cashier'),
    admin = auth('admin');
  const limited = (key, max = 30) => {
    const now = Date.now(),
      old = attempts.get(key);
    const entry = old && old.until > now ? old : {
      count: 0,
      until: now + 600000
    };
    entry.count++;
    attempts.set(key, entry);
    if (attempts.size > 5000) for (const [k, v] of attempts) if (v.until < now) attempts.delete(k);
    if (entry.count > max) fail('Demasiados intentos. Espera unos minutos.', 429);
  };
  app.post('/api/login', async (req, res) => {
    limited(`login:${req.ip}`);
    const {user,token}=await store.transaction(async()=>{
      const user = await store.get('SELECT * FROM users WHERE username=?', String(req.body.username || ''));
      if (!user || !user.active || typeof req.body.password !== 'string' || req.body.password.length > 200 || !checkPassword(req.body.password, user.password)) fail('Usuario o contraseña incorrectos.', 401);
      const token = randomBytes(32).toString('hex');
      await store.run('INSERT INTO sessions VALUES (?,?,?)', token, user.id, Date.now() + 12 * 3600000);
      return {user,token};
    });
    res.setHeader('Set-Cookie', `session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${process.env.COOKIE_SECURE === 'true' ? '; Secure' : ''}`);
    res.json({
      id: user.id,
      name: user.name,
      role: user.role,
      username: user.username
    });
  });
  app.post('/api/logout', auth(), async (req, res) => {
    const token = (req.headers.cookie || '').match(/(?:^|;\s*)session=([^;]+)/)?.[1];
    if (token) await store.run('DELETE FROM sessions WHERE token=?', token);
    res.setHeader('Set-Cookie', 'session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
    res.json({
      ok: true
    });
  });
  app.get('/api/health',async(req,res)=>{try{await store.get('SELECT 1 AS ok');res.json({status:'ok',database:store.db.dialect});}catch{res.status(503).json({status:'unavailable'});}});
  app.get('/api/me', auth(), (req, res) => res.json(req.user));
  app.get('/api/state', auth(), async (req, res) => {
    const date = req.query.date || store.today();
    if (req.user.role === 'kitchen') return res.json({
      today: store.today(),
      date: store.today(),
      orders: await store.orders(store.today())
    });
    const data = await store.snapshot(date);
    if (req.user.role !== 'admin') delete data.report;
    res.json(data);
  });
  app.get('/api/events', auth(), (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    res.write('data: connected\n\n');
    clients.add(res);
    const timer = setInterval(() => res.write(': heartbeat\n\n'), 25000);
    req.on('close', () => {
      clearInterval(timer);
      clients.delete(res);
    });
  });
  app.post('/api/orders', staff, async (req, res) => {
    const order = await store.createOrder(req.body);
    notify();
    res.status(201).json(order);
  });
  app.get('/api/orders/:id/edit', staff, async (req, res) => res.json(await store.orderForEdit(Number(req.params.id))));
  app.post('/api/orders/:id/edit', staff, async (req, res) => {
    const order = await store.editOrder(Number(req.params.id), req.body, req.user);
    notify();
    res.json(order);
  });
  app.post('/api/orders/:id/pay', staff, async (req, res) => {
    await store.transaction(async () => await store.pay(Number(req.params.id), req.body.method));
    notify();
    res.json({
      ok: true
    });
  });
  app.post('/api/orders/:id/status', auth(), async (req, res) => {
    await store.transition(Number(req.params.id), req.body.status, req.user.role);
    notify();
    res.json({
      ok: true
    });
  });
  app.post('/api/menu', admin, express.json({
    limit: '16mb'
  }), async (req, res) => {
    await store.saveMenu(req.body);
    notify();
    res.json({
      ok: true
    });
  });
  app.get('/api/inventory', admin, async (req, res) => res.json(await store.inventory()));
  app.post('/api/inventory/products', admin, express.json({
    limit: '256kb'
  }), async (req, res) => {
    const id = await store.saveProduct(req.body);
    notify();
    res.json({
      id
    });
  });
  app.post('/api/inventory/movements', admin, async (req, res) => {
    await store.movement(req.body, req.user.username);
    notify();
    res.json({
      ok: true
    });
  });
  app.post('/api/expenses', admin, async (req, res) => {
    await store.transaction(async()=>{
    await store.openCash();
    const description = String(req.body.description || '').trim().slice(0, 200);
    if (!description) fail('Describe el gasto.');
    if (!['cash', 'qr'].includes(req.body.method)) fail('Medio de pago inválido.');
    await store.run('INSERT INTO expenses(date,description,amount,method,created_at) VALUES (?,?,?,?,?)', store.today(), description, money(req.body.amount), req.body.method, store.stamp());
    });
    notify();
    res.json({
      ok: true
    });
  });
  app.get('/api/users', admin, async (req, res) => res.json({
    users: await store.users(),
    history: await store.userAudit()
  }));
  app.post('/api/users', admin, async (req, res) => {
    const result = await store.saveUser(req.body, req.user);
    notify();
    res.json(result);
  });
  app.get('/api/cash', staff, async (req, res) => res.json(await store.transaction(async()=>({
    cash: await store.get('SELECT * FROM cash_days WHERE date=?', store.today()),
    report: await store.report(store.today(), store.today()),
    events: await store.cashEvents(store.today()),
    ...(req.user.role === 'admin' ? {
      history: await store.cashHistory()
    } : {})
  }))));
  app.post('/api/cash/opening', staff, async (req, res) => {
    await store.setOpening(req.body, req.user);
    notify();
    res.json({
      ok: true
    });
  });
  app.post('/api/cash/close', staff, async (req, res) => {
    await store.closeCash(req.body, req.user);
    notify();
    res.json({
      ok: true
    });
  });
  app.get('/api/reports', admin, async (req, res) => res.json(await store.report(req.query.from, req.query.to)));
  app.get('/api/public/menu', async (req, res) => {
    const date = req.query.date || store.today();
    if (date < store.today()) fail('Consulta un menú de hoy o de una fecha futura.');
    res.json({
      today: store.today(),
      menu: await store.menu(date, true)
    });
  });
  app.post('/api/public/reservations', async (req, res) => {
    limited(`reserve:${req.ip}`, 20);
    if (!String(req.body.phone || '').trim()) fail('Escribe un teléfono de contacto.');
    const order = await store.createOrder(req.body, 'public');
    notify();
    res.status(201).json(order);
  });
  app.use('/api', (req, res) => res.status(404).json({
    error: 'Ruta no encontrada.'
  }));
  app.use(express.static(resolve('dist')));
  app.get('/{*path}', (req, res) => res.sendFile(resolve('dist/index.html')));
  app.use((error, req, res, next) => {
    if (!error.status || error.status >= 500) console.error(error);
    res.status(error.status || 500).json({
      error: error.status && error.status < 500 ? error.message : 'Ocurrió un error en el servidor.'
    });
  });
  app.locals.notify = notify;
  app.locals.stop = () => {
    for (const client of clients) client.end();
  };
  return app;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
 try{
  const store=await createStore(),app=createApp(store);
  const server=app.listen(Number(process.env.PORT)||3001,'0.0.0.0',()=>console.log('Foodsys API lista · '+store.db.dialect));
  const timer=setInterval(()=>{store.reconcile().then(()=>app.locals.notify()).catch(error=>console.error('No se pudo reconciliar caja:',error.code||error.message));},60000);timer.unref();
  let stopping=false;const stop=async()=>{if(stopping)return;stopping=true;clearInterval(timer);app.locals.stop();await new Promise(resolve=>server.close(resolve));await store.db.close();};
  process.once('SIGTERM',()=>{stop().catch(()=>{process.exitCode=1;});});process.once('SIGINT',()=>{stop().catch(()=>{process.exitCode=1;});});
  server.on('error',async error=>{console.error('No se pudo abrir el puerto:',error.code);clearInterval(timer);await store.db.close();process.exitCode=1;});
 }catch(error){console.error('No se pudo iniciar Foodsys:',error.code||error.message);process.exitCode=1;}
}
