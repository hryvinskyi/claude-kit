import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot, send } from './_app.js';

const labels = [
  ['booked', 'Booked'],
  ['collected', 'Collected'],
  ['delivered', 'Delivered'],
  ['returned', 'Returned to sender'],
];

for (const [status, label] of labels) {
  test(`the tracking page names the state ${status}`, async () => {
    const app = await boot();

    const answer = send(app, 'GET', `/labels/${status}`);

    assert.deepEqual(answer, { status: 200, body: { label } });
  });
}

test('a state nobody defined has no label page', async () => {
  const app = await boot();

  assert.equal(send(app, 'GET', '/labels/lost').status, 404);
});
