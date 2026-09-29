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

test('list franchises', async () => {
  const franchise = await createFranchise();
  const store = await createStore(franchise.id);

  const listRes = await request(app).get(`/api/franchise?page=0&limit=10&name=${franchise.name}`);
  expect(listRes.status).toBe(200);
  expect(listRes.body).toEqual({
    franchises: [{ id: franchise.id, name: franchise.name, stores: [{ id: store.id, name: store.name }] }],
    more: false,
  });
});

test('list franchises as admin includes admins', async () => {
  const franchise = await createFranchise();

  const listRes = await request(app).get(`/api/franchise?name=${franchise.name}`).set('Authorization', `Bearer ${adminAuthToken}`);
  expect(listRes.status).toBe(200);
  expect(listRes.body.franchises).toHaveLength(1);
  expect(listRes.body.franchises[0].admins).toEqual([expect.objectContaining({ id: adminUser.id, email: adminUser.email })]);
});

test('list franchises paginates', async () => {
  const prefix = randomName();
  await createFranchise(prefix + 'a');
  await createFranchise(prefix + 'b');

  const firstPage = await request(app).get(`/api/franchise?page=0&limit=1&name=${prefix}*`);
  expect(firstPage.body.franchises).toHaveLength(1);
  expect(firstPage.body.more).toBe(true);

  const secondPage = await request(app).get(`/api/franchise?page=1&limit=1&name=${prefix}*`);
  expect(secondPage.body.franchises).toHaveLength(1);
  expect(secondPage.body.more).toBe(false);
  expect(secondPage.body.franchises[0].id).not.toBe(firstPage.body.franchises[0].id);
});

test('create franchise as admin', async () => {
  const franchise = await createFranchise();
  expect(franchise.id).toBeDefined();
  expect(franchise.admins[0].email).toBe(adminUser.email);
});

test('create franchise as diner is forbidden', async () => {
  const createRes = await request(app)
    .post('/api/franchise')
    .set('Authorization', `Bearer ${dinerAuthToken}`)
    .send({ name: randomName(), admins: [{ email: dinerUser.email }] });
  expect(createRes.status).toBe(403);
});

test('get user franchises', async () => {
  const franchise = await createFranchise();

  const ownRes = await request(app).get(`/api/franchise/${adminUser.id}`).set('Authorization', `Bearer ${adminAuthToken}`);
  expect(ownRes.status).toBe(200);
  expect(ownRes.body.some((f) => f.id === franchise.id)).toBe(true);

  const otherRes = await request(app).get(`/api/franchise/${adminUser.id}`).set('Authorization', `Bearer ${dinerAuthToken}`);
  expect(otherRes.status).toBe(200);
  expect(otherRes.body).toEqual([]);
});

test('delete franchise', async () => {
  const franchise = await createFranchise();

  const deleteRes = await request(app).delete(`/api/franchise/${franchise.id}`).set('Authorization', `Bearer ${adminAuthToken}`);
  expect(deleteRes.status).toBe(200);
  expect(deleteRes.body.message).toBe('franchise deleted');
});

test('create and delete store', async () => {
  const franchise = await createFranchise();

  const createRes = await request(app)
    .post(`/api/franchise/${franchise.id}/store`)
    .set('Authorization', `Bearer ${adminAuthToken}`)
    .send({ name: randomName() });
  expect(createRes.status).toBe(200);
  expect(createRes.body.id).toBeDefined();

  const deleteRes = await request(app)
    .delete(`/api/franchise/${franchise.id}/store/${createRes.body.id}`)
    .set('Authorization', `Bearer ${adminAuthToken}`);
  expect(deleteRes.status).toBe(200);
  expect(deleteRes.body.message).toBe('store deleted');
});

test('store changes as diner are forbidden', async () => {
  const franchise = await createFranchise();

  const createRes = await request(app)
    .post(`/api/franchise/${franchise.id}/store`)
    .set('Authorization', `Bearer ${dinerAuthToken}`)
    .send({ name: randomName() });
  expect(createRes.status).toBe(403);

  const deleteRes = await request(app).delete(`/api/franchise/${franchise.id}/store/1`).set('Authorization', `Bearer ${dinerAuthToken}`);
  expect(deleteRes.status).toBe(403);
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

async function createFranchise(name = randomName()) {
  const createRes = await request(app)
    .post('/api/franchise')
    .set('Authorization', `Bearer ${adminAuthToken}`)
    .send({ name, admins: [{ email: adminUser.email }] });
  expect(createRes.status).toBe(200);
  return createRes.body;
}

async function createStore(franchiseId) {
  const createRes = await request(app)
    .post(`/api/franchise/${franchiseId}/store`)
    .set('Authorization', `Bearer ${adminAuthToken}`)
    .send({ name: randomName() });
  expect(createRes.status).toBe(200);
  return createRes.body;
}

function randomName() {
  return Math.random().toString(36).substring(2, 12);
}
