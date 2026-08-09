import type { HttpTransport } from "../api/http.js";
import { encodePublicId } from "../core/validation.js";
import {
  decodeCliAuthBootstrap,
  decodeCliContinuationIssued,
  decodeCliContinuationStatus,
  decodeCliIdentityContext,
  decodeCliTokenSet,
  decodeRevocation,
  type CliAuthBootstrap,
  type CliContinuationIssued,
  type CliContinuationStatus,
  type CliIdentityContext,
  type CliIntentClass,
  type CliTokenSet,
} from "./human-contracts.js";

export interface HumanAuthClient {
  bootstrap(signal?: AbortSignal): Promise<CliAuthBootstrap>;
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
  continuation(input: {
    readonly id: string;
    readonly secret: string;
    readonly signal?: AbortSignal;
  }): Promise<CliContinuationStatus>;
  cancel(input: { readonly id: string; readonly secret: string; readonly signal?: AbortSignal }): Promise<CliContinuationStatus>;
  exchange(input: {
    readonly id: string;
    readonly continuationSecret: string;
    readonly state: string;
    readonly codeVerifier: string;
    readonly redirectUri: string;
    readonly signal?: AbortSignal;
  }): Promise<CliTokenSet>;
  refresh(input: {
    readonly refreshToken: string;
    readonly clientInstanceId: string;
    readonly profile: string;
    readonly idempotencyKey: string;
    readonly signal?: AbortSignal;
  }): Promise<CliTokenSet>;
  context(accessToken: string, signal?: AbortSignal): Promise<CliIdentityContext>;
  logout(accessToken: string, signal?: AbortSignal): Promise<true>;
}

export function createHumanAuthClient(input: {
  readonly anonymous: HttpTransport;
  readonly authenticated: (accessToken: string) => HttpTransport;
}): HumanAuthClient {
  return Object.freeze({
    async bootstrap(signal) {
      return decodeCliAuthBootstrap(await input.anonymous.request({ method: "GET", path: "/v1/cli-auth/bootstrap", signal }));
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
        signal: request.signal,
      });
      return decodeCliContinuationIssued(response, { browserOrigin: request.browserOrigin, state: request.state });
    },
    async continuation(request) {
      const id = encodePublicId(request.id, "continuation ID");
      return decodeCliContinuationStatus(await input.anonymous.request({
        method: "GET",
        path: `/v1/cli-auth/continuations/${id}`,
        continuationSecret: request.secret,
        signal: request.signal,
      }), request.id);
    },
    async cancel(request) {
      const id = encodePublicId(request.id, "continuation ID");
      return decodeCliContinuationStatus(await input.anonymous.request({
        method: "POST",
        path: `/v1/cli-auth/continuations/${id}/cancel`,
        continuationSecret: request.secret,
        signal: request.signal,
      }), request.id);
    },
    async exchange(request) {
      const id = encodePublicId(request.id, "continuation ID");
      return decodeCliTokenSet(await input.anonymous.request({
        method: "POST",
        path: `/v1/cli-auth/continuations/${id}/exchange`,
        body: {
          continuation_secret: request.continuationSecret,
          state: request.state,
          code_verifier: request.codeVerifier,
          redirect_uri: request.redirectUri,
        },
        signal: request.signal,
      }));
    },
    async refresh(request) {
      return decodeCliTokenSet(await input.anonymous.request({
        method: "POST",
        path: "/v1/cli-auth/refresh",
        idempotencyKey: request.idempotencyKey,
        body: {
          refresh_token: request.refreshToken,
          client_instance_id: request.clientInstanceId,
          profile: request.profile,
        },
        signal: request.signal,
      }));
    },
    async context(accessToken, signal) {
      return decodeCliIdentityContext(await input.authenticated(accessToken).request({
        method: "GET",
        path: "/v1/cli-auth/context",
        signal,
      }));
    },
    async logout(accessToken, signal) {
      return decodeRevocation(await input.authenticated(accessToken).request({
        method: "POST",
        path: "/v1/cli-auth/logout",
        signal,
      }));
    },
  });
}
