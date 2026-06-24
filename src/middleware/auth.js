'use strict';
const { timingSafeEqual } = require('crypto');

async function authHook(request, reply) {
  const expectedToken = process.env.API_TOKEN || '';
  // Fail closed: an unset/empty API_TOKEN must never authenticate anyone.
  // Without this, an empty token plus an empty Bearer value would compare as
  // equal (timingSafeEqual on two zero-length buffers returns true).
  if (expectedToken.length === 0) {
    return reply.status(401).send({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Server auth is not configured' }
    });
  }

  const header = request.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return reply.status(401).send({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Missing or invalid Authorization header' }
    });
  }

  const provided = Buffer.from(header.slice(7));
  const expected = Buffer.from(expectedToken);
  const valid = provided.length === expected.length && timingSafeEqual(provided, expected);

  if (!valid) {
    return reply.status(401).send({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Invalid token' }
    });
  }
}

module.exports = authHook;
