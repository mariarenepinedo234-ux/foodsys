import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from './support/store.js';
import { createApp } from '../server/index.js';
const fixed = '2026-11-13T16:00:00Z';
async function setup() {
  const s = await createStore(':memory:', {
    now: () => new Date(fixed)
  });
  await addSides(s);
  return s;
}
async function addSides(s) {
  const m = await s.menu(s.today());
  await s.saveMenu({
    date: s.today(),
    combo_price: 25,
    published: true,
    items: [...m.items.filter(i => !i.productId).map(i => ({
      ...i,
      price: i.price / 100
    })), {
      name: 'Ensalada rusa',
      kind: 'side',
      price: 5,
      stock: 10
    }, {
      name: 'Ensalada fit',
      kind: 'side',
      price: 6,
      stock: 8
    }]
  });
}
const actor = async s => (await s.users()).find(u => u.role === 'cashier');
async function choices(s) {
  const m = await s.menu(s.today()),
    items = m.items;
  return {
    soup: items.find(i => i.kind === 'soup'),
    mains: items.filter(i => i.kind === 'main'),
    sides: items.filter(i => i.kind === 'side'),
    drink: items.find(i => i.productId)
  };
}
async function combo(s, overrides = {}) {
  const c = await choices(s);
  return {
    kind: 'combo',
    soupId: c.soup.id,
    mainId: c.mains[0].id,
    sideId: c.sides[0]?.id,
    quantity: 1,
    ...overrides
  };
}
const create = async (s, lines, extra = {}) => await s.createOrder({
  date: s.today(),
  customer: 'Ana',
  phone: '70000000',
  type: 'reservation',
  lines,
  ...extra
});
const lineBody = l => ({
  ...l.choice,
  lineId: l.id,
  quantity: l.quantity
});
async function snapshot(s) {
  return Object.fromEntries(await Promise.all(['orders', 'lines', 'allocations', 'product_allocations', 'items', 'products', 'payments', 'inventory_movements', 'audit_log'].map(async t => [t, await s.all(`SELECT * FROM ${t}`)])));
}
test('guarniciones have daily production, are chosen in complete and sold separately with one shared stock', async () => {
  const s = await setup();
  try {
    const c = await choices(s);
    const order = await create(s, [await combo(s, {
      quantity: 2
    }), {
      kind: 'item',
      itemId: c.sides[0].id,
      quantity: 3
    }]);
    assert.equal(order.total, 6500);
    assert.equal((await s.get('SELECT used FROM items WHERE id=?', c.sides[0].id)).used, 5);
    assert.equal((await s.get('SELECT used FROM items WHERE id=?', c.sides[1].id)).used, 0);
    const lines = (await s.orders(s.today()))[0].lines;
    assert.match(lines[0].label, /Ensalada rusa/);
    assert.match(lines[0].label, /vaso de refresco incluido/);
    assert.equal(lines[1].price, 500);
    await s.transition(order.id, 'cancelled', 'cashier');
    for (const i of [c.soup, c.mains[0], ...c.sides]) assert.equal((await s.get('SELECT used FROM items WHERE id=?', i.id)).used, 0);
    await assert.rejects(async () => await s.transition(order.id, 'cancelled', 'cashier'));
  } finally {
    await s.db.close();
  }
});
test('complete requires a valid side when offered and insufficient sides roll back the entire order', async () => {
  const s = await setup();
  try {
    const c = await choices(s),
      before = await snapshot(s);
    for (const line of [await combo(s, {
      sideId: undefined
    }), await combo(s, {
      sideId: c.mains[0].id
    }), await combo(s, {
      quantity: 11
    })]) await assert.rejects(async () => await create(s, [line]));
    assert.deepEqual(await snapshot(s), before);
    await s.run('UPDATE items SET stock=0 WHERE kind=?', 'side');
    await assert.rejects(async () => await create(s, [await combo(s)]), /No alcanza/);
  } finally {
    await s.db.close();
  }
});
test('edit public reservation swaps main and side, adds dishes and beverages, preserves number and metadata, and releases on cancellation once', async () => {
  const s = await setup();
  try {
    const c = await choices(s),
      body = {
        date: s.today(),
        customer: 'Ana',
        phone: '70000000',
        lines: [await combo(s), {
          kind: 'product',
          productId: c.drink.productId,
          quantity: 2
        }]
      };
    const order = await s.createOrder(body, 'public');
    const original = (await s.orders(s.today()))[0],
      edit = await s.orderForEdit(order.id);
    assert.equal(edit.menu.items.find(i => i.id === c.sides[0].id).available, 10);
    assert.equal(edit.menu.items.find(i => i.productId === c.drink.productId).available, 20);
    const result = await s.editOrder(order.id, {
      version: edit.order.version,
      customer: 'Ana María',
      note: 'Para llevar',
      lines: [{
        ...lineBody(edit.order.lines[0]),
        mainId: c.mains[1].id,
        sideId: c.sides[1].id
      }, {
        kind: 'item',
        itemId: c.mains[0].id,
        quantity: 1
      }, {
        kind: 'item',
        itemId: c.sides[0].id,
        quantity: 1
      }, {
        kind: 'product',
        productId: c.drink.productId,
        quantity: 3
      }]
    }, await actor(s));
    assert.equal(result.id, order.id);
    assert.equal(result.total, 6900);
    assert.equal(result.status, 'reserved');
    assert.equal(result.version, 1);
    const saved = (await s.orders(s.today()))[0];
    assert.equal(saved.created_at, original.created_at);
    assert.equal(saved.source, 'public');
    assert.equal(saved.phone, '70000000');
    assert.equal(saved.date, original.date);
    assert.equal((await s.all('SELECT * FROM orders')).length, 1);
    assert.equal((await s.all('SELECT * FROM payments')).length, 0);
    for (const id of [c.soup.id, ...c.mains.map(i => i.id), ...c.sides.map(i => i.id)]) assert.equal((await s.get('SELECT used FROM items WHERE id=?', id)).used, 1);
    assert.equal((await s.get('SELECT stock FROM products WHERE id=?', c.drink.productId)).stock, 17);
    const audit = (await s.orderForEdit(order.id)).history[0];
    assert.equal(audit.actor_username, 'cajero');
    assert.equal(audit.details.before.total, 3900);
    assert.equal(audit.details.after.total, 6900);
    await s.transition(order.id, 'cancelled', 'cashier');
    assert.equal((await s.get('SELECT stock FROM products WHERE id=?', c.drink.productId)).stock, 20);
    for (const i of (await s.menu(s.today())).items.filter(i => !i.productId)) assert.equal(i.used, 0);
  } finally {
    await s.db.close();
  }
});
test('failed edits and stale copies preserve old order, stock, inventory ledger and audit exactly', async () => {
  const s = await setup();
  try {
    const c = await choices(s),
      order = await create(s, [await combo(s), {
        kind: 'product',
        productId: c.drink.productId,
        quantity: 2
      }]),
      e = await s.orderForEdit(order.id),
      before = await snapshot(s);
    const bodies = [{
      lines: [await combo(s, {
        sideId: c.sides[1].id,
        quantity: 9
      })]
    }, {
      lines: []
    }, {
      lines: [{
        kind: 'product',
        productId: c.drink.productId,
        quantity: 21
      }]
    }, {
      lines: e.order.lines.map(lineBody),
      date: '2026-11-14'
    }, {
      lines: e.order.lines.map(lineBody),
      expectedTotal: 1
    }, {
      lines: e.order.lines.map(lineBody),
      version: 99
    }, {
      lines: e.order.lines.map(lineBody),
      payment: 'cash'
    }];
    for (const body of bodies) {
      await assert.rejects(async () => await s.editOrder(order.id, {
        version: 0,
        ...body
      }, await actor(s)));
      assert.deepEqual(await snapshot(s), before);
    }
    await s.editOrder(order.id, {
      version: 0,
      lines: e.order.lines.map(lineBody)
    }, await actor(s));
    const after = await snapshot(s);
    await assert.rejects(async () => await s.editOrder(order.id, {
      version: 0,
      lines: e.order.lines.map(lineBody)
    }, await actor(s)), /pedido cambió/);
    assert.deepEqual(await snapshot(s), after);
  } finally {
    await s.db.close();
  }
});
test('unchanged selections keep historical unit prices, substitutions and added dishes use current prices', async () => {
  const s = await setup();
  try {
    const c = await choices(s),
      o = await create(s, [await combo(s)]),
      e = await s.orderForEdit(o.id),
      m = await s.menu(s.today());
    await s.saveMenu({
      date: s.today(),
      combo_price: 30,
      published: true,
      items: m.items.filter(i => !i.productId).map(i => ({
        ...i,
        price: i.price / 100 + 1
      }))
    });
    const unchanged = await s.editOrder(o.id, {
      version: 0,
      expectedTotal: 5000,
      lines: [{
        ...lineBody(e.order.lines[0]),
        quantity: 2
      }]
    }, await actor(s));
    assert.equal(unchanged.total, 5000);
    const changed = await s.editOrder(o.id, {
      version: 1,
      expectedTotal: 3600,
      lines: [{
        ...lineBody((await s.orderForEdit(o.id)).order.lines[0]),
        quantity: 1,
        mainId: c.mains[1].id
      }, {
        kind: 'item',
        itemId: c.sides[0].id,
        quantity: 1
      }]
    }, await actor(s));
    assert.equal(changed.total, 3600);
    await s.transaction(async () => await s.pay(o.id, 'cash'));
    const before = await snapshot(s);
    await assert.rejects(async () => await s.editOrder(o.id, {
      version: 2,
      lines: [await combo(s)]
    }, await actor(s)), /pagado/);
    assert.deepEqual(await snapshot(s), before);
    await s.transition(o.id, 'queued', 'cashier');
    await s.transition(o.id, 'preparing', 'kitchen');
    await assert.rejects(async () => await s.orderForEdit(o.id), /preparación/);
  } finally {
    await s.db.close();
  }
});
test('editing queued unpaid order preserves status; kitchen progress, paid orders and past orders block editing', async () => {
  const s = await setup();
  try {
    const o = await create(s, [await combo(s)]);
    await s.transition(o.id, 'queued', 'cashier');
    const edit = await s.orderForEdit(o.id);
    const result = await s.editOrder(o.id, {
      version: 0,
      lines: edit.order.lines.map(lineBody)
    }, await actor(s));
    assert.equal(result.status, 'queued');
    assert.equal((await s.orders(s.today()))[0].status, 'queued');
    await s.transition(o.id, 'preparing', 'kitchen');
    await assert.rejects(async () => await s.editOrder(o.id, {
      version: 1,
      lines: [await combo(s)]
    }, await actor(s)), /preparación/);
    const past = await create(s, [await combo(s)]);
    await s.run("INSERT INTO days(date) VALUES ('2026-11-12')");
    await s.run("UPDATE orders SET date='2026-11-12' WHERE id=?", past.id);
    await assert.rejects(async () => await s.orderForEdit(past.id), /pasado/);
  } finally {
    await s.db.close();
  }
});
test('legacy lines survive migration, can be reselected if ambiguous, and edits persist across restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'foodsys-edit-')),
    path = join(dir, 'legacy.sqlite');
  let s;
  try {
    s = await createStore(path, {
      now: () => new Date(fixed)
    });
    await addSides(s);
    const o = await create(s, [await combo(s)]),
      old = (await s.orders(s.today()))[0];
    const legacyLines = await s.all('SELECT id,order_id,label,quantity,price FROM lines');
    await s.db.exec('ALTER TABLE lines DROP COLUMN selection;ALTER TABLE orders DROP COLUMN version');
    await s.db.close();
    s = await createStore(path, {
      now: () => new Date(fixed)
    });
    assert.deepEqual(await s.all('SELECT id,order_id,label,quantity,price FROM lines'), legacyLines);
    assert.equal((await s.orders(s.today()))[0].total, old.total);
    let e = await s.orderForEdit(o.id);
    assert.equal(e.order.lines[0].choice.sideId, (await choices(s)).sides[0].id);
    await s.run("UPDATE lines SET label='Detalle histórico no reconocible' WHERE order_id=?", o.id);
    e = await s.orderForEdit(o.id);
    assert.equal(e.order.lines[0].choice, null);
    await s.editOrder(o.id, {
      version: 0,
      lines: [await combo(s, {
        mainId: (await choices(s)).mains[1].id
      })]
    }, await actor(s));
    await s.db.close();
    s = await createStore(path, {
      now: () => new Date(fixed)
    });
    assert.equal((await s.orderForEdit(o.id)).order.version, 1);
    assert.equal((await s.orderForEdit(o.id)).history.length, 1);
    assert.equal((await s.orders(s.today()))[0].id, o.id);
  } finally {
    s?.db.close();
    rmSync(dir, {
      force: true,
      recursive: true
    });
  }
});
async function httpFixture(fn) {
  const s = await setup(),
    app = createApp(s),
    server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const request = async (path, body, cookie) => {
    const r = await fetch(base + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(cookie ? {
          Cookie: cookie
        } : {})
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return {
      status: r.status,
      data: await r.json(),
      cookie: r.headers.get('set-cookie')?.split(';')[0]
    };
  };
  try {
    await fn({
      s,
      request
    });
  } finally {
    app.locals.stop();
    await new Promise(r => server.close(r));
    await s.db.close();
  }
}
test('HTTP public complete includes chosen side, staff edit permissions and conflicting editors are enforced', async () => await httpFixture(async ({
  s,
  request
}) => {
  const cashier = await request('/login', {
      username: 'cajero',
      password: 'cajero123'
    }),
    kitchen = await request('/login', {
      username: 'cocina',
      password: 'cocina123'
    });
  const publicMenu = await request('/public/menu');
  assert.equal(publicMenu.data.menu.items.filter(i => i.kind === 'side').length, 2);
  const booked = await request('/public/reservations', {
    date: s.today(),
    customer: 'Ana',
    phone: '70000000',
    lines: [await combo(s)]
  });
  assert.equal(booked.status, 201);
  const url = `/orders/${booked.data.id}/edit`;
  assert.equal((await request(url)).status, 401);
  assert.equal((await request(url, undefined, kitchen.cookie)).status, 403);
  assert.equal((await request(url, {
    version: 0,
    lines: [await combo(s)]
  }, kitchen.cookie)).status, 403);
  const edit = await request(url, undefined, cashier.cookie);
  const body = {
    version: edit.data.order.version,
    lines: [await combo(s, {
      mainId: (await choices(s)).mains[1].id
    })]
  };
  const results = await Promise.all([await request(url, body, cashier.cookie), await request(url, body, cashier.cookie)]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
  assert.equal((await s.all('SELECT * FROM orders')).length, 1);
  assert.equal((await request(`/orders/${booked.data.id}/status`, {
    status: 'queued'
  }, cashier.cookie)).status, 200);
  assert.equal((await request(`/orders/${booked.data.id}/status`, {
    status: 'preparing'
  }, kitchen.cookie)).status, 200);
  assert.equal((await request(url, {
    ...body,
    version: 1
  }, cashier.cookie)).status, 409);
}));
test('an edit can reuse its own last side portion; shortages and closed-cash sale edits keep stock unchanged', async () => {
  const s = await setup();
  try {
    const c = await choices(s);
    await s.run('UPDATE items SET stock=1 WHERE id=?', c.sides[0].id);
    const o = await create(s, [await combo(s)]),
      edit = await s.orderForEdit(o.id);
    assert.equal((await s.menu(s.today())).items.find(i => i.id === c.sides[0].id).available, 0);
    assert.equal(edit.menu.items.find(i => i.id === c.sides[0].id).available, 1);
    await s.editOrder(o.id, {
      version: 0,
      lines: edit.order.lines.map(lineBody)
    }, await actor(s));
    assert.equal((await s.get('SELECT used FROM items WHERE id=?', c.sides[0].id)).used, 1);
    const before = await snapshot(s);
    await assert.rejects(async () => await s.editOrder(o.id, {
      version: 1,
      lines: [await combo(s, {
        quantity: 2
      })]
    }, await actor(s)), /No alcanza/);
    assert.deepEqual(await snapshot(s), before);
    const sale = await create(s, [await combo(s, {
      sideId: c.sides[1].id
    })], {
      type: 'sale'
    });
    await s.closeCash({
      counted: 0
    }, await actor(s));
    const closed = await snapshot(s);
    await assert.rejects(async () => await s.editOrder(sale.id, {
      version: 0,
      lines: (await s.orderForEdit(sale.id)).order.lines.map(lineBody)
    }, await actor(s)), /cerrada/);
    assert.deepEqual(await snapshot(s), closed);
    await s.editOrder(o.id, {
      version: 1,
      lines: [await combo(s, {
        sideId: c.sides[1].id
      })]
    }, await actor(s));
    assert.equal((await s.orders(s.today())).find(x => x.id === o.id).status, 'reserved');
  } finally {
    await s.db.close();
  }
});
