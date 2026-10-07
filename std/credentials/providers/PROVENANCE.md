# std/credentials/providers: provenance

A provider profile is data that the checker and the vault adapter both read (PT10e). Each field comes from the provider's own documentation, read on the date the profile records. poly checks what a profile states, and no other property of the provider.

## stripe-connect.json

Read on 2026-10-06 from Stripe's Connect OAuth reference, https://docs.stripe.com/connect/oauth-reference.

| Field | Value | What the source says |
|---|---|---|
| `authorization` | `https://connect.stripe.com/oauth/authorize` | "GET https://connect.stripe.com/oauth/authorize. Sends the user to Stripe to connect to your platform." `response_type`: "The only option at the moment is code." |
| `token` | `https://connect.stripe.com/oauth/token` | "POST https://connect.stripe.com/oauth/token. Used both for turning an authorization_code into an account connection, and for getting a new access token using a refresh_token." |
| `revocation` | `https://connect.stripe.com/oauth/deauthorize` | "POST https://connect.stripe.com/oauth/deauthorize. Used for revoking access to an account." It takes `client_id` and `stripe_user_id`, with the platform's secret key. It is not the RFC 7009 revocation endpoint. |
| `grants` | `authorization_code` | The token endpoint accepts `grant_type` `authorization_code` or `refresh_token`: "The only currently supported types are authorization_code and refresh_token." A refresh is not a grant a credential declares. There is no client credentials grant. |
| `pkce` | `false` | The reference names no `code_challenge` or `code_verifier` parameter. |
| `scopes` | `read_write`, `read_only` | "read_write or read_only, depending on the level of access you need. Defaults to read_only. Note read_only can only be specified for extensions." |
| `bases` | `https://api.stripe.com/` | The API host that calls on behalf of a connected account are made to. |

## Stripe: the platform's key and the account (S208, as ruled)

| Field | Value | What the source says |
|---|---|---|
| `attach` | `stripe-account` | The token response's `access_token` is "(Deprecated)": "Use the `Stripe-Account` header with your platform's secret key (that can make requests on behalf of this Stripe account)" (https://docs.stripe.com/connect/oauth-reference). The token endpoint's documented answer holds `token_type`, `scope`, `livemode` and `stripe_user_id`, and no token (https://docs.stripe.com/connect/oauth-standard-accounts, read 2026-10-06). The vault keeps the account id for the grant; the platform's key is the client's secret, given at load. |
| `revocationStyle` | `stripe-deauthorize` | "POST your `client_id` and the connected account's ID to `connect.stripe.com/oauth/deauthorize`" (https://docs.stripe.com/connect/oauth-standard-accounts). It is not RFC 7009. A user's own disconnection arrives as the event `account.application.deauthorized` (the same page), a provider's revocation. |

## google.json

Read on 2026-10-06 from https://developers.google.com/identity/protocols/oauth2/web-server and https://developers.google.com/identity/protocols/oauth2/native-app.

| Field | Value | What the source says |
|---|---|---|
| `authorization` | `https://accounts.google.com/o/oauth2/v2/auth` | The authorization endpoint; "This endpoint is accessible only over HTTPS." |
| `token` | `https://oauth2.googleapis.com/token` | Codes are exchanged, and tokens refreshed (`grant_type` "must be set to `refresh_token`"), here. |
| `revocation` | `https://oauth2.googleapis.com/revoke` | "your application makes a request to `https://oauth2.googleapis.com/revoke` and includes the token as a parameter"; an access or a refresh token. `revocationStyle` is `rfc7009`. |
| `pkce` | `true` | "The only supported values for this parameter are `S256` or `plain`"; the vault sends `S256`. |
| `authParams` | `access_type=offline` | Set "`access_type=offline` to receive refresh tokens". |
| `scopes`, `scopeValues` | `gmail.readonly`, `gmail.compose`, `gmail.send`, sent as `https://www.googleapis.com/auth/gmail.readonly` and the like | Google's scopes are URLs; the profile names each by its last segment, as the inbox assistant (`proposals/example-inbox.md`) uses them. |
| `bases` | `https://gmail.googleapis.com/` | The Gmail API's host. |
| `attach` | `bearer` | "Include the access token ... in an `Authorization` HTTP header `Bearer` value. When possible, the HTTP header is preferable." |

An invalid or revoked refresh token is answered `invalid_grant`, which the vault reads as `{ valid: false }`.

## The test provider

`test/fixtures/std/credentials/providers/test-oauth.json` is the tests' own profile, written from RFC 6749, RFC 7636 (PKCE) and RFC 7009 (revocation): the generic provider the vault is built and tested against (S208, as ruled). It never ships in `std/`.

## Conclusion

Each profile records its provider's OAuth as documented on the date read. Stripe's deprecated per-account tokens are not used: as ruled (S208), the vault attaches the platform's key with the connected account, and revokes by Stripe's own deauthorization.
