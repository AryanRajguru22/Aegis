import type { AgentRecord } from "../state/agents.js";

/**
 * Two distinct credential types authenticate requests to this API, and they are
 * never interchangeable:
 *  - `principalId` (set by requirePrincipalAuth): a human/organization's own API key,
 *    authorizing control-plane actions (register/attenuate/revoke agents, read the
 *    ledger).
 *  - `agent` (set by requireAgentToken): a Biscuit capability token, resolved back to
 *    its AgentRecord via the token's own revocation id (never a client-supplied
 *    agentId) — see src/api/auth.ts and src/capability/token.ts's getOwnRevocationId.
 *    Authorizes financial-transaction actions (/simulate, /transactions) as exactly
 *    the agent the token proves, nothing else.
 */
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      principalId?: string;
      agent?: AgentRecord;
      agentToken?: string;
    }
  }
}

export {};
