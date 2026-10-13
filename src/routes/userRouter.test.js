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

// Regression test for SQL injection CVE
test('update user stores sql in fields as plain text', async () => {
  const user = await createUser([{ role: Role.Diner }]);
  const token = await login(user);
  const updates = { name: `x', email='${randomName()}@test.com`, email: user.email, password: user.password };

  const updateRes = await request(app).put(`/api/user/${user.id}`).set('Authorization', `Bearer ${token}`).send(updates);
  expect(updateRes.status).toBe(200);
  expect(updateRes.body.user).toMatchObject({ id: user.id, name: updates.name, email: user.email });
});

// Regression test for SQL injection CVE
test('update user stores sql in email as plain text', async () => {
  const user = await createUser([{ role: Role.Diner }]);
  const token = await login(user);
  const updates = { name: user.name, email: `${randomName()}@test.com', name='pwned`, password: user.password };

  const updateRes = await request(app).put(`/api/user/${user.id}`).set('Authorization', `Bearer ${token}`).send(updates);
  expect(updateRes.status).toBe(200);
  expect(updateRes.body.user).toMatchObject({ id: user.id, name: user.name, email: updates.email });
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

test('list users without token is unauthorized', async () => {
  const listRes = await request(app).get('/api/user');
  expect(listRes.status).toBe(401);
});

test('list users as diner is forbidden', async () => {
  const listRes = await request(app).get('/api/user').set('Authorization', `Bearer ${dinerAuthToken}`);
  expect(listRes.status).toBe(403);
  expect(listRes.body.message).toBe('unauthorized');
});

test('list users as admin', async () => {
  const listRes = await request(app).get(`/api/user?page=1&limit=10&name=${dinerUser.name}`).set('Authorization', `Bearer ${adminAuthToken}`);
  expect(listRes.status).toBe(200);
  expect(listRes.body).toEqual({
    users: [{ id: dinerUser.id, name: dinerUser.name, email: dinerUser.email, roles: [{ role: Role.Diner }] }],
    more: false,
  });
});

test('list users paginates', async () => {
  const prefix = randomName();
  const userA = await createUser([{ role: Role.Diner }], prefix + 'a');
  const userB = await createUser([{ role: Role.Diner }], prefix + 'b');
  const userC = await createUser([{ role: Role.Diner }], prefix + 'c');

  const firstPage = await request(app).get(`/api/user?page=1&limit=2&name=${prefix}*`).set('Authorization', `Bearer ${adminAuthToken}`);
  expect(firstPage.body.users.map((u) => u.id)).toEqual([userA.id, userB.id]);
  expect(firstPage.body.more).toBe(true);

  const secondPage = await request(app).get(`/api/user?page=2&limit=2&name=${prefix}*`).set('Authorization', `Bearer ${adminAuthToken}`);
  expect(secondPage.body.users.map((u) => u.id)).toEqual([userC.id]);
  expect(secondPage.body.more).toBe(false);
});

test('list users defaults to first page of ten', async () => {
  const prefix = randomName();
  for (let i = 0; i < 11; i++) {
    await createUser([{ role: Role.Diner }], prefix + i);
  }

  const listRes = await request(app).get(`/api/user?name=${prefix}*`).set('Authorization', `Bearer ${adminAuthToken}`);
  expect(listRes.status).toBe(200);
  expect(listRes.body.users).toHaveLength(10);
  expect(listRes.body.more).toBe(true);
});

test('list users filters by partial name', async () => {
  const middle = randomName();
  const user = await createUser([{ role: Role.Diner }], `x${middle}y`);

  const listRes = await request(app).get(`/api/user?name=*${middle}*`).set('Authorization', `Bearer ${adminAuthToken}`);
  expect(listRes.body.users.map((u) => u.id)).toEqual([user.id]);

  const noMatchRes = await request(app).get(`/api/user?name=${middle}`).set('Authorization', `Bearer ${adminAuthToken}`);
  expect(noMatchRes.body.users).toEqual([]);
});

test('list users rejects invalid page or limit', async () => {
  for (const query of ['page=0', 'page=abc', 'limit=0', `limit=${encodeURIComponent('1 -- ')}`]) {
    const listRes = await request(app).get(`/api/user?${query}`).set('Authorization', `Bearer ${adminAuthToken}`);
    expect(listRes.status).toBe(400);
  }
});

async function createUser(roles, name = randomName()) {
  const user = { name, email: randomName() + '@test.com', password: 'toomanysecrets', roles };
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
