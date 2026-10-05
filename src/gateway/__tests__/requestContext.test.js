const express = require('express');
const request = require('supertest');
const { requestContext, currentRequestId } = require('../requestContext');
const { errorHandler } = require('../../middleware/errorMiddleware');

function app() {
  const a = express();
  a.use(requestContext);
  a.get('/ok', async (req, res) => {
    await new Promise((r) => setTimeout(r, 1));
    res.json({ fromContext: currentRequestId(), fromReq: req.id });
  });
  a.get('/boom', (req, res, next) => next(new Error('kaput')));
  a.use(errorHandler);
  return a;
}

describe('gateway requestContext', () => {
  it('issues an id, echoes it, and exposes it across awaits', async () => {
    const res = await request(app()).get('/ok');
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.headers['x-api-version']).toBe('1');
    expect(res.body.fromContext).toBe(res.headers['x-request-id']);
    expect(res.body.fromReq).toBe(res.headers['x-request-id']);
  });

  it('keeps a well-formed inbound id', async () => {
    const res = await request(app()).get('/ok').set('X-Request-Id', 'phone-abc-12345');
    expect(res.headers['x-request-id']).toBe('phone-abc-12345');
  });

  it('replaces an inbound id that could inject text into logs', async () => {
    const res = await request(app()).get('/ok').set('X-Request-Id', 'bad id {"x":1}');
    expect(res.headers['x-request-id']).not.toBe('bad id {"x":1}');
  });

  it('stamps the id on error responses', async () => {
    const res = await request(app()).get('/boom');
    expect(res.status).toBe(500);
    expect(res.body.requestId).toBe(res.headers['x-request-id']);
  });
});
