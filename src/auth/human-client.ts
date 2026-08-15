import type { HttpTransport } from "../api/http.js";
import { encodePublicId } from "../core/validation.js";
import {
  decodeCliAuthBootstrap,
  decodeCliSignupCapability,
  decodeCliContinuationIssued,
  decodeCliIdentityContext,
  decodeCliLoginCodeExchangeResult,
  decodeRevocation,
  type CliAuthBootstrap,
  type CliSignupCapability,
  type CliContinuationIssued,
  type CliIdentityContext,
  type CliIntentClass,
  type CliLoginCodeExchangeResult,
} from "./human-contracts.js";

export interface HumanAuthClient {
  bootstrap(signal?: AbortSignal): Promise<CliAuthBootstrap>;
  signupCapability(signal?: AbortSignal): Promise<CliSignupCapability>;
  createContinuation(input: {
    readonly state: string;
    readonly codeChallenge: string;
    readonly redirectUri: string;
    readonly clientInstanceId: string;
    readonly profile: string;
    readonly intentClass: CliIntentClass;
    readonly browserOrigin: string;
    readonly signal?: AbortSignal;
  }): Promise<CliContinuationIssued>;
  exchange(input: {
    readonly id: string;
    readonly clientInstanceId: string;
    readonly profile: string;
    readonly state: string;
    readonly codeVerifier: string;
    readonly redirectUri: string;
    readonly loginCode: string;
    /**
     * A durable-code re-exchange must preserve the server-issued code expiry.
     * It is optional for the first browser exchange because no local record
     * exists yet to bind against.
     */
    readonly expectedLoginCodeExpiresAt?: string;
    readonly signal?: AbortSignal;
  }): Promise<CliLoginCodeExchangeResult>;
  context(accessToken: string, signal?: AbortSignal): Promise<CliIdentityContext>;
  logout(accessToken: string, signal?: AbortSignal): Promise<true>;
}

export function createHumanAuthClient(input: {
  readonly anonymous: HttpTransport;
  readonly authenticated: (accessToken: string) => HttpTransport;
}): HumanAuthClient {
  const client: HumanAuthClient = {
    async bootstrap(signal) {
      return decodeCliAuthBootstrap(await input.anonymous.request({
        method: "GET", path: "/v1/cli-auth/bootstrap", ...(signal === undefined ? {} : { signal }),
      }));
    },
    async signupCapability(signal) {
      return decodeCliSignupCapability(await input.anonymous.request({
        method: "GET",
        path: "/v1/cli-auth/signup-capability",
        ...(signal === undefined ? {} : { signal }),
      }));
    },
    async createContinuation(request) {
      const response = await input.anonymous.request({
        method: "POST",
        path: "/v1/cli-auth/continuations",
        body: {
          state: request.state,
          code_challenge: request.codeChallenge,
          redirect_uri: request.redirectUri,
          client_instance_id: request.clientInstanceId,
          profile: request.profile,
          intent_class: request.intentClass,
        },
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
      return decodeCliContinuationIssued(response, { browserOrigin: request.browserOrigin, state: request.state });
    },
    async exchange(request) {
      const id = encodePublicId(request.id, "continuation ID");
      return decodeCliLoginCodeExchangeResult(await input.anonymous.request({
        method: "POST",
        path: `/v1/cli-auth/continuations/${id}/exchange`,
        body: {
          login_code: request.loginCode,
          client_instance_id: request.clientInstanceId,
          profile: request.profile,
          state: request.state,
          code_verifier: request.codeVerifier,
          redirect_uri: request.redirectUri,
        },
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      }), request.loginCode, request.expectedLoginCodeExpiresAt);
    },
    async context(accessToken, signal) {
      return decodeCliIdentityContext(await input.authenticated(accessToken).request({
        method: "GET",
        path: "/v1/cli-auth/context",
        ...(signal === undefined ? {} : { signal }),
      }));
    },
    async logout(accessToken, signal) {
      return decodeRevocation(await input.authenticated(accessToken).request({
        method: "POST",
        path: "/v1/cli-auth/logout",
        ...(signal === undefined ? {} : { signal }),
      }));
    },
  };
  return Object.freeze(client);
}
