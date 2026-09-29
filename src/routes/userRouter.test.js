const request = require('supertest');
const app = require('../service');
const { DB, Role } = require('../database/database.js');

let adminUser;
let adminAuthToken;
let dinerUser;
let dinerAuthToken;

beforeAll(async () => {
  adminUser = await createUser([{ role: Role.Admin }]);
  adminAuthToken = await login(adminUser);
  dinerUser = await createUser([{ role: Role.Diner }]);
  dinerAuthToken = await login(dinerUser);
});

test('get authenticated user', async () => {
  const meRes = await request(app).get('/api/user/me').set('Authorization', `Bearer ${dinerAuthToken}`);
  expect(meRes.status).toBe(200);
  expect(meRes.body).toMatchObject({ id: dinerUser.id, name: dinerUser.name, email: dinerUser.email, roles: [{ role: Role.Diner }] });
});

test('update own user', async () => {
  const user = await createUser([{ role: Role.Diner }]);
  const token = await login(user);
  const updates = { name: randomName(), email: randomName() + '@test.com', password: 'newsecret' };

  const updateRes = await request(app).put(`/api/user/${user.id}`).set('Authorization', `Bearer ${token}`).send(updates);
  expect(updateRes.status).toBe(200);
  expect(updateRes.body.user).toMatchObject({ id: user.id, name: updates.name, email: updates.email });
  expect(updateRes.body.token).toMatch(/^[a-zA-Z0-9\-_]*\.[a-zA-Z0-9\-_]*\.[a-zA-Z0-9\-_]*$/);

  const loginRes = await request(app).put('/api/auth').send({ email: updates.email, password: updates.password });
  expect(loginRes.status).toBe(200);
  expect(loginRes.body.user.id).toBe(user.id);
});

test('admin can update another user', async () => {
  const user = await createUser([{ role: Role.Diner }]);
  const updates = { name: randomName(), email: user.email, password: user.password };

  const updateRes = await request(app).put(`/api/user/${user.id}`).set('Authorization', `Bearer ${adminAuthToken}`).send(updates);
  expect(updateRes.status).toBe(200);
  expect(updateRes.body.user).toMatchObject({ id: user.id, name: updates.name });
});

test('diner cannot update another user', async () => {
  const updateRes = await request(app)
    .put(`/api/user/${adminUser.id}`)
    .set('Authorization', `Bearer ${dinerAuthToken}`)
    .send({ name: 'hacked', email: adminUser.email, password: 'hacked' });
  expect(updateRes.status).toBe(403);
  expect(updateRes.body.message).toBe('unauthorized');
});

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
