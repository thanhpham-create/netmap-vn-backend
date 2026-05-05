import type { FastifyRequest, FastifyReply } from 'fastify';

// Discriminated union: every JWT carries `type` to distinguish user vs device tokens
export type UserJwtPayload = {
  type: 'user';
  userId: string;
  phone: string;
  role: 'consumer' | 'operator' | 'admin';
};

export type DeviceJwtPayload = {
  type: 'device';
  deviceId: string;   // UUID
  deviceUid: string;  // client-generated string
};

export type JwtPayload = UserJwtPayload | DeviceJwtPayload;

// Augment Fastify with our auth decorators + per-request device context
declare module 'fastify' {
  interface FastifyInstance {
    /** Requires a USER token. */
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /** Accepts either user OR device token. Populates request.deviceContext. */
    authenticateAny: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
  interface FastifyRequest {
    /** Set by authenticateAny — the deviceId responsible for this request. */
    deviceContext?: { deviceId: string; deviceUid: string };
  }
}

// Tell @fastify/jwt the actual shape of payload/user
declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: JwtPayload;
    user: JwtPayload;
  }
}
