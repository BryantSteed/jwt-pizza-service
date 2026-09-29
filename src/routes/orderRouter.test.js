const request = require('supertest');
const app = require('../service');
const { DB, Role } = require('../database/database.js');

let adminAuthToken;
let dinerAuthToken;
let menuItem;
let franchise;
let store;

beforeAll(async () => {
  const adminUser = await createUser([{ role: Role.Admin }]);
  adminAuthToken = await login(adminUser);
  const dinerUser = await createUser([{ role: Role.Diner }]);
  dinerAuthToken = await login(dinerUser);

  menuItem = await addMenuItem();

  const franchiseRes = await request(app)
    .post('/api/franchise')
    .set('Authorization', `Bearer ${adminAuthToken}`)
    .send({ name: randomName(), admins: [{ email: adminUser.email }] });
  franchise = franchiseRes.body;

  const storeRes = await request(app)
    .post(`/api/franchise/${franchise.id}/store`)
    .set('Authorization', `Bearer ${adminAuthToken}`)
    .send({ name: randomName() });
  store = storeRes.body;
});

afterEach(() => {
  jest.restoreAllMocks();
});

test('get menu', async () => {
  const menuRes = await request(app).get('/api/order/menu');
  expect(menuRes.status).toBe(200);
  expect(menuRes.body).toContainEqual(menuItem);
});

test('add menu item as diner is forbidden', async () => {
  const addRes = await request(app)
    .put('/api/order/menu')
    .set('Authorization', `Bearer ${dinerAuthToken}`)
    .send({ title: randomName(), description: 'nope', image: 'pizza1.png', price: 0.01 });
  expect(addRes.status).toBe(403);
});

test('create and get orders', async () => {
  const fetchSpy = mockFetchWith(true, { reportUrl: 'http://report', jwt: 'factory.jwt.token' });
  const orderReq = { franchiseId: franchise.id, storeId: store.id, items: [{ menuId: menuItem.id, description: menuItem.title, price: menuItem.price }] };

  const createRes = await request(app).post('/api/order').set('Authorization', `Bearer ${dinerAuthToken}`).send(orderReq);
  expect(createRes.status).toBe(200);
  expect(createRes.body).toEqual({ order: { ...orderReq, id: expect.any(Number) }, followLinkToEndChaos: 'http://report', jwt: 'factory.jwt.token' });
  expect(fetchSpy).toHaveBeenCalledTimes(1);

  const ordersRes = await request(app).get('/api/order').set('Authorization', `Bearer ${dinerAuthToken}`);
  expect(ordersRes.status).toBe(200);
  expect(ordersRes.body.orders).toEqual([
    {
      id: createRes.body.order.id,
      franchiseId: franchise.id,
      storeId: store.id,
      date: expect.any(String),
      items: [{ id: expect.any(Number), menuId: menuItem.id, description: menuItem.title, price: menuItem.price }],
    },
  ]);
});

test('create order factory failure', async () => {
  mockFetchWith(false, { reportUrl: 'http://report' });
  const orderReq = { franchiseId: franchise.id, storeId: store.id, items: [{ menuId: menuItem.id, description: menuItem.title, price: menuItem.price }] };

  const createRes = await request(app).post('/api/order').set('Authorization', `Bearer ${dinerAuthToken}`).send(orderReq);
  expect(createRes.status).toBe(500);
  expect(createRes.body).toEqual({ message: 'Failed to fulfill order at factory', followLinkToEndChaos: 'http://report' });
});

function mockFetchWith(ok, body) {
  return jest.spyOn(global, 'fetch').mockResolvedValue({ ok, json: async () => body });
}

async function addMenuItem() {
  const item = { title: randomName(), description: 'test pizza', image: 'pizza1.png', price: 0.05 };
  const addRes = await request(app).put('/api/order/menu').set('Authorization', `Bearer ${adminAuthToken}`).send(item);
  expect(addRes.status).toBe(200);
  return addRes.body.find((m) => m.title === item.title);
}

async function createUser(roles) {
  const user = { name: randomName(), email: randomName() + '@test.com', password: 'toomanysecrets', roles };
  const createdUser = await DB.addUser(user);
  return { ...createdUser, password: user.password };
}

async function login(user) {
  const loginRes = await request(app).put('/api/auth').send({ email: user.email, password: user.password });
  return loginRes.body.token;
}

function randomName() {
  return Math.random().toString(36).substring(2, 12);
}
